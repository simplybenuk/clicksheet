import assert from "node:assert/strict";
import test from "node:test";

import { SAVE_STATUS } from "../extension/core/autosave.js";
import { createLibrarySession } from "../extension/core/library-session.js";
import { checkAccess, createStorage, migrateRoot } from "../extension/core/storage.js";
import { createVolume, readText, snapshot } from "./support/memory-fs.mjs";

// One mutex per test stands in for navigator.locks shared between contexts.
function createMutex() {
  let tail = Promise.resolve();
  return (task) => {
    const run = tail.then(task);
    tail = run.catch(() => {});
    return run;
  };
}

// Stands in for the IndexedDB handle store that extension pages share.
function createRootStore() {
  return { current: null };
}

let nextId = 0;

function setup({ migrate, access, withLock = createMutex(), rootStore = createRootStore() } = {}) {
  const views = [];
  const savedRoots = [];
  const session = createLibrarySession({
    saveRootHandle: async (root) => {
      rootStore.current = root;
      savedRoots.push(root);
    },
    loadRootHandle: async () => rootStore.current,
    withLock,
    storageFactory: (root, options) =>
      createStorage(root, { ...options, createId: () => `j${++nextId}` }),
    migrate,
    access,
    autosaveOptions: { delayMs: 0 },
    onChange: (view) => views.push(view)
  });
  return { session, views, savedRoots };
}

const journeyName = async (root, id) =>
  JSON.parse(await readText(root, `journeys/${id}/journey.json`)).name;

test("new Journeys and renames autosave to the selected folder", async () => {
  const volume = createVolume();
  const { session, savedRoots } = setup();

  assert.equal(await session.chooseRoot(volume.root), true);
  assert.deepEqual(savedRoots, [volume.root]);
  assert.equal(session.snapshot().status, SAVE_STATUS.saved);

  const first = session.createJourney();
  session.createJourney();
  assert.equal(session.snapshot().status, SAVE_STATUS.saving);
  session.rename(first.id, "Checkout");
  await session.flush();

  assert.equal(session.snapshot().status, SAVE_STATUS.saved);
  assert.equal(await journeyName(volume.root, first.id), "Checkout");
  const index = JSON.parse(await readText(volume.root, "index.json"));
  assert.equal(index.journeys.length, 2);
});

test("Saved locally is never shown while an edit is still unwritten", async () => {
  const volume = createVolume();
  const { session, views } = setup();
  await session.chooseRoot(volume.root);
  const journey = session.createJourney();
  await session.flush();

  volume.permission = "prompt";
  await session.refreshAccess();
  assert.equal(session.snapshot().status, SAVE_STATUS.unavailable);

  views.length = 0;
  session.rename(journey.id, "Pending");
  await session.flush();
  assert.equal(session.snapshot().status, SAVE_STATUS.unavailable);

  // Reconnect writes the held edit before reporting Saved locally.
  volume.requestResult = "granted";
  assert.equal(await session.reconnect(), true);
  assert.equal(await journeyName(volume.root, journey.id), "Pending");

  const firstSaved = views.findIndex((view) => view.status === SAVE_STATUS.saved);
  assert.ok(firstSaved >= 0);
  assert.ok(
    views.slice(0, firstSaved).every((view) => view.status !== SAVE_STATUS.saved),
    "no Saved locally before the write"
  );
});

test("a failed save reports Storage unavailable and writes nowhere else", async () => {
  const volume = createVolume();
  const other = createVolume("other");
  const { session } = setup();
  await session.chooseRoot(volume.root);
  const journey = session.createJourney();
  await session.flush();
  const otherBefore = snapshot(other.root);

  volume.removed = true;
  session.rename(journey.id, "Lost?");
  await session.flush();
  await new Promise((resolve) => setTimeout(resolve, 0));

  const view = session.snapshot();
  assert.equal(view.status, SAVE_STATUS.unavailable);
  assert.equal(view.editable, false);
  assert.match(view.message.text, /could not be found/);
  assert.deepEqual(snapshot(other.root), otherBefore);

  // Restoring the folder and reconnecting saves the held rename.
  volume.removed = false;
  assert.equal(await session.reconnect(), true);
  assert.equal(await journeyName(volume.root, journey.id), "Lost?");
});

test("edits made while a move is copying are written to the new folder", async () => {
  const source = createVolume("old");
  const destination = createVolume("new");
  let session;
  let existing;
  let created;
  const { session: s } = setup({
    migrate: async (from, to) => {
      const result = await migrateRoot(from, to);
      // Simulate the user editing after the files were verified.
      session.rename(existing.id, "Renamed during move");
      created = session.createJourney();
      // Give autosave's timer a chance to fire, as a slow real copy would.
      await new Promise((resolve) => setTimeout(resolve, 5));
      return result;
    }
  });
  session = s;

  await session.chooseRoot(source.root);
  existing = session.createJourney();
  session.rename(existing.id, "Before move");
  await session.flush();
  const sourceBefore = snapshot(source.root);

  assert.equal(await session.move(destination.root), true);
  await session.flush();

  assert.equal(session.snapshot().folderName, "new");
  assert.equal(await journeyName(destination.root, existing.id), "Renamed during move");
  assert.equal(await journeyName(destination.root, created?.id ?? "missing"), "Untitled Journey");
  assert.deepEqual(snapshot(source.root), sourceBefore, "the original folder is untouched");
});

test("a failed move keeps the original folder active and saves held edits there", async () => {
  const source = createVolume("old");
  const destination = createVolume("new");
  destination.failWritesMatching = /journey\.json/;
  let session;
  let journey;
  ({ session } = setup({
    migrate: async (from, to) => {
      session.rename(journey.id, "Held during failed move");
      await new Promise((resolve) => setTimeout(resolve, 5));
      return migrateRoot(from, to);
    }
  }));
  await session.chooseRoot(source.root);
  journey = session.createJourney();
  await session.flush();

  assert.equal(await session.move(destination.root), false);
  await session.flush();

  assert.match(session.snapshot().message.text, /could not copy/);
  assert.equal(session.snapshot().folderName, "old");
  assert.equal(await journeyName(source.root, journey.id), "Held during failed move");
  assert.deepEqual(snapshot(destination.root), {});
});

test("a missing or corrupt Journey folder is skipped with a warning", async () => {
  const volume = createVolume();
  const { session } = setup();
  await session.chooseRoot(volume.root);
  const kept = session.createJourney();
  const removed = session.createJourney();
  const corrupt = session.createJourney();
  await session.flush();

  const journeys = await volume.root.getDirectoryHandle("journeys");
  await journeys.removeEntry(removed.id, { recursive: true });
  const file = await (await journeys.getDirectoryHandle(corrupt.id)).getFileHandle("journey.json");
  const writable = await file.createWritable();
  await writable.write("{ broken");
  await writable.close();

  const { session: reloaded } = setup();
  assert.equal(await reloaded.connect(volume.root), true);

  const view = reloaded.snapshot();
  assert.equal(view.status, SAVE_STATUS.saved);
  assert.deepEqual(view.journeys.map((journey) => journey.id), [kept.id]);
  assert.match(view.message.text, new RegExp(corrupt.id));

  const index = JSON.parse(await readText(volume.root, "index.json"));
  assert.deepEqual(index.journeys.map((entry) => entry.id), [kept.id]);
  assert.equal(snapshot(volume.root)[`journeys/${corrupt.id}/journey.json`], "{ broken");
});

test("Locate refuses a folder without Clicksheet data", async () => {
  const volume = createVolume("library");
  const empty = createVolume("empty");
  const { session, savedRoots } = setup();
  await session.chooseRoot(volume.root);

  assert.equal(await session.locate(empty.root), false);
  assert.match(session.snapshot().message.text, /does not contain Clicksheet Journeys/);
  assert.deepEqual(savedRoots, [volume.root]);
  assert.deepEqual(snapshot(empty.root), {});
});

test("two sessions on one folder do not lose each other's changes", async () => {
  const volume = createVolume();
  const withLock = createMutex();
  const rootStore = createRootStore();
  const { session: a } = setup({ withLock, rootStore });
  const { session: b } = setup({ withLock, rootStore });
  await a.chooseRoot(volume.root);
  const shared = a.createJourney();
  await a.flush();
  await b.connect(volume.root);

  const fromA = a.createJourney();
  const fromB = b.createJourney();
  b.rename(shared.id, "Renamed in B");
  await Promise.all([a.flush(), b.flush()]);

  // Another writer adds a frame A has never seen. A's rename of its older copy
  // must keep that frame rather than overwrite the file.
  const writer = createStorage(volume.root, { withLock });
  const onDisk = await writer.loadJourney(shared.id);
  await writer.saveJourney({ ...onDisk, frames: [{ id: "frame-from-elsewhere" }] });

  a.rename(shared.id, "Renamed in A");
  await a.flush();
  const merged = JSON.parse(await readText(volume.root, `journeys/${shared.id}/journey.json`));
  assert.deepEqual(merged.frames, [{ id: "frame-from-elsewhere" }]);

  const index = JSON.parse(await readText(volume.root, "index.json"));
  assert.deepEqual(
    new Set(index.journeys.map((entry) => entry.id)),
    new Set([shared.id, fromA.id, fromB.id])
  );
  assert.equal(await journeyName(volume.root, shared.id), "Renamed in A");
  assert.equal(a.snapshot().status, SAVE_STATUS.saved);
});

test("Reconnect keeps a new Journey that was never saved", async () => {
  const volume = createVolume();
  const { session } = setup();
  await session.chooseRoot(volume.root);

  volume.removed = true;
  const journey = session.createJourney();
  session.rename(journey.id, "Important");
  await session.flush();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(session.snapshot().status, SAVE_STATUS.unavailable);

  volume.removed = false;
  assert.equal(await session.reconnect(), true);

  assert.deepEqual(session.snapshot().journeys.map((entry) => entry.name), ["Important"]);
  assert.equal(await journeyName(volume.root, journey.id), "Important");
  assert.equal(session.snapshot().status, SAVE_STATUS.saved);
});

test("a slow earlier connect cannot replace the folder chosen after it", async () => {
  const stored = createVolume("stored");
  const picked = createVolume("picked");
  let releaseStored;
  const { session } = setup({
    access: async (root, options) => {
      if (root === stored.root) {
        await new Promise((resolve) => {
          releaseStored = resolve;
        });
      }
      return checkAccess(root, options);
    }
  });

  const startup = session.connect(stored.root);
  await new Promise((resolve) => setTimeout(resolve, 0));
  await session.chooseRoot(picked.root);
  releaseStored();
  await startup;

  assert.equal(session.snapshot().folderName, "picked");
  const journey = session.createJourney();
  await session.flush();

  assert.equal(await journeyName(picked.root, journey.id), "Untitled Journey");
  assert.deepEqual(snapshot(stored.root), {});
});

test("after another page moves the library, this page stops writing to the old folder", async () => {
  const oldRoot = createVolume("old");
  const newRoot = createVolume("new");
  const withLock = createMutex();
  const rootStore = createRootStore();
  const { session: a } = setup({ withLock, rootStore });
  const { session: b } = setup({ withLock, rootStore });
  await a.chooseRoot(oldRoot.root);
  const journey = a.createJourney();
  await a.flush();
  await b.connect(oldRoot.root);

  assert.equal(await a.move(newRoot.root), true);
  const oldBefore = snapshot(oldRoot.root);

  b.rename(journey.id, "Renamed in B after the move");
  await b.flush();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(b.snapshot().status, SAVE_STATUS.unavailable);
  assert.match(b.snapshot().message.text, /moved to another folder/);
  assert.deepEqual(snapshot(oldRoot.root), oldBefore);

  // Reconnect follows the move and writes the held rename to the new folder.
  assert.equal(await b.reconnect(), true);
  assert.equal(b.snapshot().folderName, "new");
  assert.equal(await journeyName(newRoot.root, journey.id), "Renamed in B after the move");
  assert.deepEqual(snapshot(oldRoot.root), oldBefore);
});

test("unsaved changes are reported while the folder is unavailable", async () => {
  const volume = createVolume();
  const { session } = setup();
  await session.chooseRoot(volume.root);
  assert.equal(session.snapshot().hasUnsavedChanges, false);

  volume.removed = true;
  const journey = session.createJourney();
  session.rename(journey.id, "Important");
  await session.flush();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(session.snapshot().status, SAVE_STATUS.unavailable);
  assert.equal(session.snapshot().hasUnsavedChanges, true);

  volume.removed = false;
  await session.reconnect();
  assert.equal(session.snapshot().hasUnsavedChanges, false);
});

test("autosave is held while a connect swaps folders", async () => {
  const oldRoot = createVolume("old");
  const copy = createVolume("copy");
  const { session, views } = setup({
    access: async (root, options) => {
      if (root === copy.root) {
        // Long enough for a pending autosave timer to fire mid-connect.
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return checkAccess(root, options);
    }
  });
  await session.chooseRoot(oldRoot.root);
  const journey = session.createJourney();
  await session.flush();
  await migrateRoot(oldRoot.root, copy.root);
  const oldBefore = snapshot(oldRoot.root);

  views.length = 0;
  session.rename(journey.id, "Renamed before locate");
  assert.equal(await session.locate(copy.root), true);
  await session.flush();

  assert.ok(views.every((view) => view.status !== SAVE_STATUS.unavailable));
  assert.deepEqual(snapshot(oldRoot.root), oldBefore);
  assert.equal(await journeyName(copy.root, journey.id), "Renamed before locate");
});

test("a reconnect superseded by Locate does not leave a false warning", async () => {
  const volume = createVolume("library");
  let releaseRequest;
  const { session } = setup({
    access: async (root, options) => {
      if (options?.request) {
        await new Promise((resolve) => {
          releaseRequest = resolve;
        });
        return { available: false, reason: "Permission was not granted." };
      }
      return checkAccess(root, options);
    }
  });
  await session.chooseRoot(volume.root);

  const reconnecting = session.reconnect();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(await session.locate(volume.root), true);
  releaseRequest();
  assert.equal(await reconnecting, false);

  assert.equal(session.snapshot().status, SAVE_STATUS.saved);
  assert.equal(session.snapshot().message.text, "");
});

test("an access check that started before a move cannot mark the new folder unavailable", async () => {
  const source = createVolume("source");
  const destination = createVolume("destination");
  let releaseCheck;
  let delayNextCheck = false;
  const { session } = setup({
    access: async (root, options) => {
      if (delayNextCheck && root === source.root) {
        delayNextCheck = false;
        await new Promise((resolve) => {
          releaseCheck = resolve;
        });
      }
      return checkAccess(root, options);
    }
  });
  await session.chooseRoot(source.root);
  session.createJourney();
  await session.flush();

  delayNextCheck = true;
  const refreshing = session.refreshAccess();
  assert.equal(await session.move(destination.root), true);
  source.removed = true;
  releaseCheck();
  await refreshing;

  assert.equal(session.snapshot().folderName, "destination");
  assert.equal(session.snapshot().status, SAVE_STATUS.saved);
});

test("unsaved changes are reported while a write waits for the storage lock", async () => {
  const volume = createVolume();
  const mutex = createMutex();
  let holdLock = false;
  let releaseLock;
  const withLock = async (task) => {
    if (holdLock) {
      holdLock = false;
      await new Promise((resolve) => {
        releaseLock = resolve;
      });
    }
    return mutex(task);
  };
  const { session } = setup({ withLock });
  await session.chooseRoot(volume.root);
  const journey = session.createJourney();
  await session.flush();

  holdLock = true;
  session.rename(journey.id, "In flight");
  await new Promise((resolve) => setTimeout(resolve, 5));

  assert.equal(session.snapshot().status, SAVE_STATUS.saving);
  assert.equal(session.snapshot().hasUnsavedChanges, true);

  releaseLock();
  await session.flush();
  assert.equal(session.snapshot().hasUnsavedChanges, false);
  assert.equal(await journeyName(volume.root, journey.id), "In flight");
});

test("a rename made after access is lost is held and saved on Reconnect", async () => {
  const volume = createVolume();
  const other = createVolume("other");
  const { session } = setup();
  await session.chooseRoot(volume.root);
  const journey = session.createJourney();
  await session.flush();
  const otherBefore = snapshot(other.root);

  // The page notices the missing folder before the user types.
  volume.removed = true;
  await session.refreshAccess();
  assert.equal(session.snapshot().status, SAVE_STATUS.unavailable);
  assert.equal(session.snapshot().renamable, true);

  session.rename(journey.id, "Held");
  await session.flush();
  await new Promise((resolve) => setTimeout(resolve, 0));

  const view = session.snapshot();
  assert.equal(view.status, SAVE_STATUS.unavailable);
  assert.equal(view.hasUnsavedChanges, true);
  assert.match(view.message.text, /could not be found/);
  assert.deepEqual(snapshot(other.root), otherBefore);

  volume.removed = false;
  assert.equal(await session.reconnect(), true);
  assert.equal(await journeyName(volume.root, journey.id), "Held");
  assert.equal(session.snapshot().hasUnsavedChanges, false);
});
