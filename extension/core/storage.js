// Storage adapter for the user-selected Clicksheet root folder.
//
// The adapter works against the File System Access directory-handle interface
// so it can run in any extension context that holds a granted handle.
//
// <root>/
//   index.json
//   journeys/<journey-id>/journey.json
//   journeys/<journey-id>/screenshots/<frame>.png
//   journeys/<journey-id>/exports/

export const INDEX_FILE = "index.json";
export const JOURNEYS_DIRECTORY = "journeys";
export const JOURNEY_FILE = "journey.json";
export const SCREENSHOTS_DIRECTORY = "screenshots";
export const EXPORTS_DIRECTORY = "exports";

export const INDEX_FORMAT = "clicksheet-index";
export const JOURNEY_FORMAT = "clicksheet-journey";
export const FORMAT_VERSION = 1;

export const DEFAULT_JOURNEY_NAME = "Untitled Journey";
export const DEFAULT_SETTINGS = Object.freeze({
  captureArea: "viewport",
  captureDelayMs: 500
});

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const SCREENSHOT_PATTERN = /^[A-Za-z0-9_-]{1,64}\.png$/;
const READ_WRITE = { mode: "readwrite" };

export class JourneyFormatError extends Error {
  constructor(message) {
    super(message);
    this.name = "JourneyFormatError";
  }
}

export class JourneyConflictError extends Error {
  constructor(id) {
    super(`Journey ${id} changed on disk since it was loaded.`);
    this.name = "JourneyConflictError";
    this.journeyId = id;
  }
}

export class RootChangedError extends Error {
  constructor() {
    super("The library folder was changed from another Clicksheet page.");
    this.name = "RootChangedError";
  }
}

export class MigrationError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "MigrationError";
  }
}

export function describeStorageError(error) {
  switch (error?.name) {
    case "NotFoundError":
      return "The selected folder could not be found. It may have been moved, renamed, or deleted.";
    case "NotAllowedError":
    case "SecurityError":
      return "Clicksheet no longer has permission to use the selected folder.";
    case "RootChangedError":
      return "The library was moved to another folder from another Clicksheet page. Reconnect to continue in the new folder.";
    case "QuotaExceededError":
      return "The selected folder has run out of space.";
    default:
      return "Clicksheet could not read or write the selected folder.";
  }
}

// Revalidates access to a stored root handle. `request` prompts the user and
// therefore needs a user gesture in a window context.
export async function checkAccess(root, { request = false } = {}) {
  if (!root) {
    return { available: false, reason: "No storage folder has been selected." };
  }

  try {
    let permission = await root.queryPermission(READ_WRITE);

    if (permission !== "granted" && request) {
      permission = await root.requestPermission(READ_WRITE);
    }

    if (permission !== "granted") {
      return {
        available: false,
        reason: "Clicksheet needs permission to use the selected folder."
      };
    }

    // Permission can outlive the folder itself, so probe the directory.
    await root.values().next();
    return { available: true, reason: "" };
  } catch (error) {
    return { available: false, reason: describeStorageError(error) };
  }
}

export async function containsLibrary(directory) {
  return (
    (await hasEntry(directory, INDEX_FILE)) ||
    (await hasEntry(directory, JOURNEYS_DIRECTORY))
  );
}

export function createStorage(
  root,
  {
    now = () => new Date().toISOString(),
    createId = () => crypto.randomUUID(),
    withLock = withStorageLock,
    beforeTask = async () => {}
  } = {}
) {
  let queue = Promise.resolve();

  // Index updates are read-modify-write, so mutations run one at a time: the
  // local queue orders calls from this instance, and the lock orders them
  // against other extension contexts using the same folder. `beforeTask` runs
  // inside the lock, for example to confirm this is still the selected root.
  function serialize(task) {
    const run = queue.then(() =>
      withLock(async () => {
        await beforeTask();
        return task();
      })
    );
    queue = run.catch(() => {});
    return run;
  }

  async function journeysDirectory() {
    return root.getDirectoryHandle(JOURNEYS_DIRECTORY, { create: true });
  }

  async function journeyDirectory(id, { create = false } = {}) {
    assertId(id);
    const journeys = await journeysDirectory();
    return journeys.getDirectoryHandle(id, { create });
  }

  async function writeIndex(journeys) {
    await writeJson(root, INDEX_FILE, {
      format: INDEX_FORMAT,
      version: FORMAT_VERSION,
      journeys
    });
  }

  async function readJourney(directory, id) {
    const journey = await readJson(directory, JOURNEY_FILE);

    if (!isJourney(journey) || journey.id !== id) {
      throw new JourneyFormatError(`Journey ${id} is not a readable Clicksheet Journey.`);
    }

    if (journey.version > FORMAT_VERSION) {
      throw new JourneyFormatError(`Journey ${id} was saved by a newer version of Clicksheet.`);
    }

    return journey;
  }

  // Reads every Journey folder. Folders that cannot be read are reported and
  // left on disk for manual recovery.
  async function scanJourneys() {
    const journeys = [];
    const skipped = [];

    for await (const [name, handle] of (await journeysDirectory()).entries()) {
      if (handle.kind !== "directory") {
        continue;
      }

      try {
        assertId(name);
        journeys.push(await readJourney(handle, name));
      } catch (error) {
        if (!isUnreadableData(error)) {
          throw error;
        }

        skipped.push(name);
      }
    }

    journeys.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return { journeys, skipped: skipped.sort() };
  }

  async function rebuildIndex() {
    const scan = await scanJourneys();
    await writeIndex(scan.journeys.map(summarize));
    return scan;
  }

  async function listJourneys() {
    let index;

    try {
      index = await readJson(root, INDEX_FILE);
    } catch (error) {
      if (error?.name === "NotFoundError") {
        return (await rebuildIndex()).journeys.map(summarize);
      }

      if (!(error instanceof SyntaxError)) {
        throw error;
      }
    }

    if (isIndex(index)) {
      return index.journeys;
    }

    // Keep the unreadable index beside the rebuilt one instead of discarding it.
    const backupName = `index.corrupt-${now().replace(/[:.]/g, "-")}.json`;
    await writeFile(root, backupName, await readBytes(await root.getFileHandle(INDEX_FILE)));
    return (await rebuildIndex()).journeys.map(summarize);
  }

  async function loadLibrary() {
    const summaries = await listJourneys();
    const indexed = new Set(summaries.map((summary) => summary.id));
    const journeys = [];
    let stale = false;

    for (const summary of summaries) {
      try {
        journeys.push(await readJourney(await journeyDirectory(summary.id), summary.id));
      } catch (error) {
        if (!isUnreadableData(error)) {
          throw error;
        }

        stale = true;
      }
    }

    for await (const [name, handle] of (await journeysDirectory()).entries()) {
      if (handle.kind === "directory" && !indexed.has(name)) {
        stale = true;
      }
    }

    // The index is a cache of the Journey files; rebuild it when they disagree.
    return stale ? rebuildIndex() : { journeys, skipped: [] };
  }

  async function upsertIndexEntry(summary) {
    const journeys = [...(await listJourneys())];
    const position = journeys.findIndex((entry) => entry.id === summary.id);

    if (position === -1) {
      journeys.push(summary);
    } else {
      journeys[position] = summary;
    }

    await writeIndex(journeys);
  }

  function buildJourney({ name = DEFAULT_JOURNEY_NAME } = {}) {
    const timestamp = now();
    return {
      format: JOURNEY_FORMAT,
      version: FORMAT_VERSION,
      id: createId(),
      name: normalizeName(name),
      createdAt: timestamp,
      updatedAt: timestamp,
      settings: { ...DEFAULT_SETTINGS },
      frames: []
    };
  }

  async function saveJourney(journey) {
    const directory = await journeyDirectory(journey.id, { create: true });
    let current = null;

    try {
      current = await readJourney(directory, journey.id);
    } catch (error) {
      if (error?.name !== "NotFoundError") {
        throw error;
      }
    }

    // A Journey file written by someone else since this copy was loaded must
    // not be overwritten with stale contents.
    if (current && current.updatedAt !== journey.updatedAt) {
      throw new JourneyConflictError(journey.id);
    }

    const next = {
      ...journey,
      format: JOURNEY_FORMAT,
      version: FORMAT_VERSION,
      name: normalizeName(journey.name),
      updatedAt: now()
    };

    await directory.getDirectoryHandle(SCREENSHOTS_DIRECTORY, { create: true });
    await directory.getDirectoryHandle(EXPORTS_DIRECTORY, { create: true });
    // Journey metadata first: the index can always be rebuilt from it.
    await writeJson(directory, JOURNEY_FILE, next);
    await upsertIndexEntry(summarize(next));
    return next;
  }

  return {
    root,

    initialize() {
      return serialize(async () => {
        await journeysDirectory();
        return listJourneys();
      });
    },

    listJourneys() {
      return serialize(listJourneys);
    },

    loadLibrary() {
      return serialize(loadLibrary);
    },

    rebuildIndex() {
      return serialize(rebuildIndex);
    },

    buildJourney,

    createJourney(options) {
      return serialize(() => saveJourney(buildJourney(options)));
    },

    async loadJourney(id) {
      return readJourney(await journeyDirectory(id), id);
    },

    saveJourney(journey) {
      return serialize(() => saveJourney(journey));
    },

    async writeScreenshot(journeyId, fileName, data) {
      assertScreenshotName(fileName);
      const directory = await journeyDirectory(journeyId);
      const screenshots = await directory.getDirectoryHandle(SCREENSHOTS_DIRECTORY, {
        create: true
      });
      await writeFile(screenshots, fileName, data);
    },

    async readScreenshot(journeyId, fileName) {
      assertScreenshotName(fileName);
      const directory = await journeyDirectory(journeyId);
      const screenshots = await directory.getDirectoryHandle(SCREENSHOTS_DIRECTORY);
      return (await screenshots.getFileHandle(fileName)).getFile();
    }
  };
}

// Copies the Clicksheet library from `source` into an empty `destination`,
// verifies every byte, and never modifies `source`. A failed copy removes only
// what it created in `destination`.
export async function migrateRoot(source, destination) {
  if (await source.isSameEntry(destination)) {
    throw new MigrationError("Choose a different folder from the current storage folder.");
  }

  if (await source.resolve(destination)) {
    throw new MigrationError("Choose a folder outside the current storage folder.");
  }

  if (await containsLibrary(destination)) {
    throw new MigrationError(
      "The chosen folder already contains Clicksheet data. Choose an empty folder."
    );
  }

  const entries = await listLibraryEntries(source);

  try {
    for (const entry of entries) {
      const parent = await directoryAt(destination, entry.path.slice(0, -1));
      const name = entry.path.at(-1);

      if (entry.handle.kind === "directory") {
        await parent.getDirectoryHandle(name, { create: true });
      } else {
        await writeFile(parent, name, await readBytes(entry.handle));
      }
    }

    for (const entry of entries) {
      const parent = await directoryAt(destination, entry.path.slice(0, -1), { create: false });
      const name = entry.path.at(-1);

      if (entry.handle.kind === "directory") {
        await parent.getDirectoryHandle(name);
        continue;
      }

      const copied = await readBytes(await parent.getFileHandle(name));

      if (!sameBytes(await readBytes(entry.handle), copied)) {
        throw new Error(`${entry.path.join("/")} did not match after copying.`);
      }
    }
  } catch (error) {
    await removeLibrary(destination);
    throw new MigrationError(
      "Clicksheet could not copy the library to the chosen folder. The current folder was not changed.",
      { cause: error }
    );
  }

  return { fileCount: entries.filter((entry) => entry.handle.kind === "file").length };
}

function normalizeName(name) {
  const trimmed = typeof name === "string" ? name.trim() : "";
  return trimmed || DEFAULT_JOURNEY_NAME;
}

function summarize(journey) {
  return {
    id: journey.id,
    name: journey.name,
    createdAt: journey.createdAt,
    updatedAt: journey.updatedAt
  };
}

function isIndex(value) {
  return (
    value?.format === INDEX_FORMAT &&
    Array.isArray(value.journeys) &&
    value.journeys.every(
      (entry) =>
        typeof entry?.id === "string" &&
        ID_PATTERN.test(entry.id) &&
        typeof entry.name === "string" &&
        typeof entry.createdAt === "string" &&
        typeof entry.updatedAt === "string"
    )
  );
}

function isJourney(value) {
  return (
    value?.format === JOURNEY_FORMAT &&
    Number.isInteger(value.version) &&
    typeof value.id === "string" &&
    ID_PATTERN.test(value.id) &&
    typeof value.name === "string" &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string" &&
    Array.isArray(value.frames)
  );
}

// Problems with one Journey's files, as opposed to losing the whole folder.
function isUnreadableData(error) {
  return (
    error instanceof SyntaxError ||
    error instanceof TypeError ||
    error instanceof JourneyFormatError ||
    error?.name === "NotFoundError" ||
    error?.name === "TypeMismatchError"
  );
}

// Web Locks coordinate writers across extension pages, workers, and tabs.
export function withStorageLock(task) {
  const locks = globalThis.navigator?.locks;
  return locks ? locks.request("clicksheet-storage", task) : task();
}

function assertId(id) {
  if (typeof id !== "string" || !ID_PATTERN.test(id)) {
    throw new TypeError(`Invalid Journey id: ${String(id)}`);
  }
}

function assertScreenshotName(fileName) {
  if (typeof fileName !== "string" || !SCREENSHOT_PATTERN.test(fileName)) {
    throw new TypeError(`Invalid screenshot file name: ${String(fileName)}`);
  }
}

async function hasEntry(directory, name) {
  for await (const entryName of directory.keys()) {
    if (entryName === name) {
      return true;
    }
  }

  return false;
}

async function readJson(directory, name) {
  const file = await (await directory.getFileHandle(name)).getFile();
  return JSON.parse(await file.text());
}

async function writeJson(directory, name, value) {
  await writeFile(directory, name, `${JSON.stringify(value, null, 2)}\n`);
}

// Writable streams commit on close(), so an interrupted write leaves the
// previous file contents in place.
async function writeFile(directory, name, data) {
  const handle = await directory.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();

  try {
    await writable.write(data);
    await writable.close();
  } catch (error) {
    await writable.abort().catch(() => {});
    throw error;
  }
}

async function readBytes(fileHandle) {
  return new Uint8Array(await (await fileHandle.getFile()).arrayBuffer());
}

function sameBytes(a, b) {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

async function directoryAt(root, path, { create = true } = {}) {
  let directory = root;

  for (const name of path) {
    directory = await directory.getDirectoryHandle(name, { create });
  }

  return directory;
}

async function listLibraryEntries(root) {
  const entries = [];

  async function walk(directory, path) {
    for await (const [name, handle] of directory.entries()) {
      entries.push({ path: [...path, name], handle });

      if (handle.kind === "directory") {
        await walk(handle, [...path, name]);
      }
    }
  }

  for await (const [name, handle] of root.entries()) {
    if (name === INDEX_FILE && handle.kind === "file") {
      entries.push({ path: [name], handle });
    }

    if (name === JOURNEYS_DIRECTORY && handle.kind === "directory") {
      entries.push({ path: [name], handle });
      await walk(handle, [name]);
    }
  }

  return entries;
}

async function removeLibrary(directory) {
  for (const name of [INDEX_FILE, JOURNEYS_DIRECTORY]) {
    await directory.removeEntry(name, { recursive: true }).catch(() => {});
  }
}
