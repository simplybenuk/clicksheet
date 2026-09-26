// Coordinates one selected library folder: access, the loaded Journeys,
// pending edits, autosave, and moving the library to another folder.
//
// UI code subscribes through `onChange` and renders `snapshot()`.

import { createAutosave, SAVE_STATUS } from "./autosave.js";
import {
  checkAccess,
  containsLibrary,
  createStorage,
  describeStorageError,
  JourneyConflictError,
  migrateRoot,
  RootChangedError,
  withStorageLock
} from "./storage.js";

const UNAVAILABLE_HINT =
  "Saving is paused until you reconnect the folder. Clicksheet will not save anywhere else.";

export function createLibrarySession({
  saveRootHandle,
  loadRootHandle = async () => null,
  withLock = withStorageLock,
  storageFactory = createStorage,
  access = checkAccess,
  migrate = migrateRoot,
  autosaveOptions = {},
  onChange = () => {}
}) {
  const state = {
    root: null,
    storage: null,
    available: false,
    moving: false,
    journeys: new Map(),
    dirty: new Set(),
    patches: new Map(),
    // Journeys created in this session that have never been written.
    unsaved: new Set(),
    connectGeneration: 0,
    connecting: 0,
    message: { text: "", tone: "info" }
  };

  const autosave = createAutosave({
    ...autosaveOptions,
    save: saveDirtyJourneys,
    onStatus(status) {
      notify();

      if (status === SAVE_STATUS.unavailable) {
        void refreshAccess({ failedSave: true });
      }
    }
  });

  function notify() {
    onChange(snapshot());
  }

  function setMessage(text, tone = "info") {
    state.message = { text, tone };
    notify();
  }

  function status() {
    if (!state.root || (state.connecting && !state.available)) {
      return "";
    }

    if (!state.available || autosave.status === SAVE_STATUS.unavailable) {
      return SAVE_STATUS.unavailable;
    }

    if (autosave.hasPendingChanges || autosave.status === SAVE_STATUS.saving) {
      return SAVE_STATUS.saving;
    }

    return SAVE_STATUS.saved;
  }

  function snapshot() {
    return {
      folderName: state.root?.name ?? "",
      hasRoot: Boolean(state.root),
      available: state.available,
      editable: state.available && !state.moving && !state.connecting,
      // Renames stay possible while the folder is unavailable: they are held in
      // memory and written after Reconnect or Locate, never anywhere else.
      renamable: Boolean(state.root) && !state.moving && !state.connecting,
      moving: state.moving,
      status: status(),
      // True while any edit or new Journey is not yet on disk, including while
      // its write is in flight.
      hasUnsavedChanges:
        autosave.hasPendingChanges ||
        state.dirty.size > 0 ||
        autosave.status === SAVE_STATUS.saving,
      connecting: state.connecting > 0,
      message: state.message,
      journeys: [...state.journeys.values()].sort((a, b) =>
        a.createdAt.localeCompare(b.createdAt)
      )
    };
  }

  async function saveOne(storage, id, journey, patch) {
    try {
      return await storage.saveJourney(journey);
    } catch (error) {
      if (!(error instanceof JourneyConflictError)) throw error;
      // Merge only the fields changed here. Never replace another context's
      // frames or settings with an untouched stale copy.
      const latest = await storage.loadJourney(id);
      return storage.saveJourney({ ...latest, ...patch });
    }
  }

  async function saveDirtyJourneys() {
    const storage = state.storage;
    if (!storage || !state.available) throw new Error("No storage folder is connected.");

    for (const id of [...state.dirty]) {
      const journey = state.journeys.get(id);
      const patch = state.patches.get(id) ?? {};
      state.dirty.delete(id);
      state.patches.delete(id);
      try {
        const saved = await saveOne(storage, id, journey, patch);
        state.unsaved.delete(id);
        // Preserve every field edited while this write was in flight.
        state.journeys.set(id, { ...saved, ...(state.patches.get(id) ?? {}) });
      } catch (error) {
        state.dirty.add(id);
        state.patches.set(id, { ...patch, ...(state.patches.get(id) ?? {}) });
        throw error;
      }
    }
  }

  function setUnavailable(reason) {
    state.available = false;
    state.message = { text: `${reason} ${UNAVAILABLE_HINT}`, tone: "warn" };
    notify();
  }

  // Writers confirm, inside the storage lock, that `root` is still the folder
  // the user selected. Another page may have moved the library meanwhile.
  async function assertCurrentRoot(root) {
    const current = await loadRootHandle();

    if (current && !(await current.isSameEntry(root))) {
      throw new RootChangedError();
    }
  }

  // Loads `root` as the library. Journeys created here but never saved are
  // always kept. With `carryPending`, edits to Journeys missing from `root` are
  // kept too and written to it (used after a move).
  async function connect(root, options = {}) {
    // Hold autosave while the storage is being swapped; `resume` then writes
    // pending edits to whichever folder ended up connected.
    state.connecting += 1;
    notify();

    try {
      await autosave.suspend();
      return await connectRoot(root, options);
    } finally {
      state.connecting -= 1;
      await autosave.resume();
      notify();
    }
  }

  async function connectRoot(root, { request = false, carryPending = false } = {}) {
    // Only the most recent connect may install its result.
    const generation = ++state.connectGeneration;
    const isCurrent = () => generation === state.connectGeneration;

    // Never let pending edits reach the previous folder once another is chosen.
    state.root = root;
    state.storage = null;
    state.available = false;
    const result = await access(root, { request });

    if (!isCurrent()) {
      return false;
    }

    if (!result.available) {
      setUnavailable(result.reason);
      return false;
    }

    let library;
    const storage = storageFactory(root, {
      withLock,
      beforeTask: () => assertCurrentRoot(root)
    });

    try {
      await storage.initialize();
      library = await storage.loadLibrary();
    } catch (error) {
      if (isCurrent()) {
        setUnavailable(describeStorageError(error));
      }

      return false;
    }

    if (!isCurrent()) {
      return false;
    }

    const journeys = new Map(library.journeys.map((journey) => [journey.id, journey]));
    let dropped = 0;

    for (const id of [...state.dirty]) {
      if (journeys.has(id) || carryPending || state.unsaved.has(id)) {
        journeys.set(id, { ...(journeys.get(id) ?? state.journeys.get(id)), ...(state.patches.get(id) ?? {}) });
      } else {
        // An edit to a Journey that is not in this folder cannot be applied
        // here, and writing it would add data to a library the user did not pick.
        state.dirty.delete(id);
        state.patches.delete(id);
        dropped += 1;
      }
    }

    state.storage = storage;
    state.journeys = journeys;
    state.available = true;

    const warnings = [];

    if (library.skipped.length) {
      warnings.push(
        `${library.skipped.length} Journey folder(s) could not be read and were left on disk: ${library.skipped.join(", ")}.`
      );
    }

    if (dropped) {
      warnings.push(
        `${dropped} unsaved change(s) belonged to Journeys that are not in ${root.name} and were not saved.`
      );
    }

    state.message = { text: warnings.join(" "), tone: warnings.length ? "warn" : "info" };
    notify();

    if (autosave.hasPendingChanges || autosave.status === SAVE_STATUS.unavailable) {
      await autosave.retry();
    }

    return true;
  }

  async function refreshAccess({ failedSave = false } = {}) {
    const { root, connectGeneration } = state;

    if (!root) {
      return;
    }

    const result = await access(root);

    // A connect or move since this check started makes the result stale.
    if (state.root !== root || state.connectGeneration !== connectGeneration) {
      return;
    }

    if (!result.available) {
      setUnavailable(result.reason);
    } else if (failedSave) {
      const reason = autosave.lastError
        ? describeStorageError(autosave.lastError)
        : "Clicksheet could not save to the selected folder.";
      setUnavailable(reason);
    }
  }

  function edit(id, change) {
    state.journeys.set(id, { ...state.journeys.get(id), ...change });
    state.dirty.add(id);
    state.patches.set(id, { ...(state.patches.get(id) ?? {}), ...change });
    autosave.schedule();
    notify();
  }

  return {
    snapshot,
    connect,
    refreshAccess,
    flush: () => autosave.flush(),

    async chooseRoot(root) {
      await saveRootHandle(root);
      return connect(root);
    },

    // Reconnects to the selected folder, which may have been changed by a move
    // in another Clicksheet page.
    async reconnect() {
      const root = (await loadRootHandle().catch(() => null)) ?? state.root;
      const generation = state.connectGeneration + 1;
      const connected = await connect(root, { request: true });
      const superseded = state.connectGeneration !== generation;

      if (!connected && !superseded) {
        setMessage(
          `${state.message.text} If the folder was moved or renamed, use Locate folder to select it again.`,
          "warn"
        );
      }

      return connected;
    },

    // Re-selects the existing library after it was moved or renamed. A folder
    // without Clicksheet data is refused so the library never switches silently.
    async locate(root) {
      if (!(await containsLibrary(root))) {
        setMessage(
          `${root.name} does not contain Clicksheet Journeys. Select the folder that holds index.json and journeys/.`,
          "warn"
        );
        return false;
      }

      await saveRootHandle(root);
      return connect(root);
    },

    // Copies the library to `destination` and switches to it. Edits made while
    // the copy runs are held in memory and written to the new folder.
    async move(destination) {
      if (!state.available || state.moving) {
        return false;
      }

      const source = state.root;
      let suspendedHere = false;
      state.moving = true;
      notify();

      try {
        if (!(await autosave.flush())) {
          setMessage("Save the current changes before moving the folder.", "warn");
          return false;
        }

        await autosave.suspend();
        suspendedHere = true;
        setMessage(`Copying Journeys to ${destination.name}…`);

        let fileCount;

        // Other pages cannot write while the copy runs, and their next write
        // sees that the selected folder changed.
        try {
          await withLock(async () => {
            ({ fileCount } = await migrate(source, destination));
            await saveRootHandle(destination);
          });
        } catch (error) {
          setMessage(error.message ?? describeStorageError(error), "warn");
          return false;
        }

        // Held edits stay suspended until the new folder is the active storage.
        if (!(await connect(destination, { carryPending: true }))) {
          return false;
        }

        if (!state.message.text) {
          setMessage(
            `Copied and verified ${fileCount} files in ${destination.name}. ${source.name} was left unchanged; remove it yourself when you no longer need it.`
          );
        }

        return true;
      } finally {
        state.moving = false;

        if (suspendedHere) {
          await autosave.resume();
        }

        notify();
      }
    },

    createJourney() {
      if (!state.available) {
        return null;
      }

      const journey = state.storage.buildJourney();
      state.journeys.set(journey.id, journey);
      state.unsaved.add(journey.id);
      edit(journey.id, {});
      return journey;
    },

    // Apply a bounded set of editable fields; identity and storage revisions
    // are always owned by the storage adapter.
    updateJourney(id, change) {
      if (!state.journeys.has(id)) throw new Error("Journey not found.");
      const allowed = new Set(["name", "frames", "settings", "state", "pauseReason", "recordingSegment"]);
      if (Object.keys(change).some((key) => !allowed.has(key))) {
        throw new TypeError("This Journey field cannot be edited.");
      }
      edit(id, structuredClone(change));
    },

    rename(id, name) {
      if (state.journeys.has(id)) {
        edit(id, { name });
      }
    }
  };
}
