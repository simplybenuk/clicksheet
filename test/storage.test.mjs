import assert from "node:assert/strict";
import test from "node:test";

import {
  checkAccess,
  containsLibrary,
  createStorage,
  DEFAULT_JOURNEY_NAME,
  DEFAULT_SETTINGS,
  JourneyConflictError,
  migrateRoot,
  MigrationError
} from "../extension/core/storage.js";
import { createVolume, readText, snapshot } from "./support/memory-fs.mjs";

function setup() {
  const volume = createVolume();
  let clock = 0;
  let nextId = 0;
  const storage = createStorage(volume.root, {
    now: () => new Date(Date.UTC(2026, 8, 24, 12, 0, clock++)).toISOString(),
    createId: () => `journey-${++nextId}`
  });
  return { volume, storage };
}

const readJson = async (root, path) => JSON.parse(await readText(root, path));

test("initialize creates a readable index and journeys folder", async () => {
  const { volume, storage } = setup();

  assert.deepEqual(await storage.initialize(), []);
  assert.deepEqual(await readJson(volume.root, "index.json"), {
    format: "clicksheet-index",
    version: 1,
    journeys: []
  });
  assert.equal("journeys/" in snapshot(volume.root), true);
  assert.equal(await containsLibrary(volume.root), true);
});

test("new Journeys get the readable folder layout and keep existing Journeys", async () => {
  const { volume, storage } = setup();
  await storage.initialize();

  const first = await storage.createJourney();
  const second = await storage.createJourney({ name: "Create a new user" });

  assert.equal(first.name, DEFAULT_JOURNEY_NAME);
  assert.deepEqual(first.settings, DEFAULT_SETTINGS);
  assert.deepEqual(first.frames, []);

  const files = snapshot(volume.root);
  for (const id of [first.id, second.id]) {
    assert.equal(`journeys/${id}/screenshots/` in files, true);
    assert.equal(`journeys/${id}/exports/` in files, true);
  }

  assert.deepEqual(await readJson(volume.root, `journeys/${first.id}/journey.json`), first);
  assert.deepEqual(
    (await storage.listJourneys()).map((entry) => [entry.id, entry.name]),
    [
      [first.id, DEFAULT_JOURNEY_NAME],
      [second.id, "Create a new user"]
    ]
  );
});

test("saving a renamed Journey updates its file and the index", async () => {
  const { volume, storage } = setup();
  await storage.initialize();
  const journey = await storage.createJourney();

  const saved = await storage.saveJourney({ ...journey, name: "  Checkout flow  " });

  assert.equal(saved.name, "Checkout flow");
  assert.notEqual(saved.updatedAt, journey.updatedAt);
  assert.deepEqual(await storage.loadJourney(journey.id), saved);

  const [entry] = (await readJson(volume.root, "index.json")).journeys;
  assert.deepEqual(entry, {
    id: journey.id,
    name: "Checkout flow",
    createdAt: journey.createdAt,
    updatedAt: saved.updatedAt
  });

  const renamedToBlank = await storage.saveJourney({ ...saved, name: "   " });
  assert.equal(renamedToBlank.name, DEFAULT_JOURNEY_NAME);
});

test("a failed write leaves the previous Journey file intact", async () => {
  const { volume, storage } = setup();
  await storage.initialize();
  const journey = await storage.createJourney({ name: "Before" });
  const before = snapshot(volume.root);

  volume.failWritesMatching = /^journey\.json$/;
  await assert.rejects(storage.saveJourney({ ...journey, name: "After" }), {
    name: "InvalidStateError"
  });

  assert.deepEqual(snapshot(volume.root), before);
  volume.failWritesMatching = null;
  assert.equal((await storage.loadJourney(journey.id)).name, "Before");
});

test("a corrupt index is backed up and rebuilt from Journey files", async () => {
  const { volume, storage } = setup();
  await storage.initialize();
  const journey = await storage.createJourney({ name: "Recoverable" });
  const indexHandle = await volume.root.getFileHandle("index.json");
  const writable = await indexHandle.createWritable();
  await writable.write("{ not json");
  await writable.close();

  const journeys = await storage.listJourneys();

  assert.deepEqual(journeys.map((entry) => entry.name), ["Recoverable"]);
  assert.equal(journeys[0].id, journey.id);

  const backups = Object.keys(snapshot(volume.root)).filter((path) =>
    path.startsWith("index.corrupt-")
  );
  assert.equal(backups.length, 1);
  assert.equal(snapshot(volume.root)[backups[0]], "{ not json");
});

test("a missing index is rebuilt and unreadable Journey folders are left alone", async () => {
  const { volume, storage } = setup();
  await storage.initialize();
  const journey = await storage.createJourney({ name: "Kept" });
  const broken = await (await volume.root.getDirectoryHandle("journeys"))
    .getDirectoryHandle("broken", { create: true });
  const writable = await (await broken.getFileHandle("journey.json", { create: true }))
    .createWritable();
  await writable.write("nope");
  await writable.close();
  await volume.root.removeEntry("index.json");

  assert.deepEqual((await storage.listJourneys()).map((entry) => entry.id), [journey.id]);
  assert.equal(snapshot(volume.root)["journeys/broken/journey.json"], "nope");
});

test("screenshots are stored as PNG files inside the Journey folder", async () => {
  const { volume, storage } = setup();
  await storage.initialize();
  const journey = await storage.createJourney();
  const pixels = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);

  await storage.writeScreenshot(journey.id, "frame-1.png", new Blob([pixels]));

  const file = await storage.readScreenshot(journey.id, "frame-1.png");
  assert.deepEqual(new Uint8Array(await file.arrayBuffer()), pixels);
  assert.equal(`journeys/${journey.id}/screenshots/frame-1.png` in snapshot(volume.root), true);
  await assert.rejects(storage.writeScreenshot(journey.id, "../escape.png", pixels), TypeError);
  await assert.rejects(storage.writeScreenshot(journey.id, "frame.jpg", pixels), TypeError);
});

test("Journey ids cannot address paths outside the journeys folder", async () => {
  const { storage } = setup();
  await storage.initialize();

  await assert.rejects(storage.loadJourney("../index"), TypeError);
  await assert.rejects(storage.saveJourney({ id: "a/b", name: "x", frames: [] }), TypeError);
});

test("checkAccess reports revoked permission and removed folders", async () => {
  const { volume } = setup();

  assert.deepEqual(await checkAccess(volume.root), { available: true, reason: "" });
  assert.equal((await checkAccess(null)).available, false);

  volume.permission = "prompt";
  assert.equal((await checkAccess(volume.root)).available, false);
  assert.deepEqual(await checkAccess(volume.root, { request: true }), {
    available: true,
    reason: ""
  });

  volume.permission = "prompt";
  volume.requestResult = "denied";
  assert.match((await checkAccess(volume.root, { request: true })).reason, /permission/);

  volume.permission = "granted";
  volume.removed = true;
  assert.match((await checkAccess(volume.root)).reason, /could not be found/);
});

test("storage operations fail visibly when access is lost", async () => {
  const { volume, storage } = setup();
  await storage.initialize();
  const journey = await storage.createJourney();

  volume.permission = "denied";
  await assert.rejects(storage.saveJourney({ ...journey, name: "Lost" }), {
    name: "NotAllowedError"
  });

  volume.permission = "granted";
  assert.equal((await storage.loadJourney(journey.id)).name, DEFAULT_JOURNEY_NAME);
});

test("migration copies and verifies the library without touching the original", async () => {
  const { volume, storage } = setup();
  await storage.initialize();
  const journey = await storage.createJourney({ name: "Move me" });
  await storage.writeScreenshot(journey.id, "frame-1.png", new Uint8Array([1, 2, 3]));
  const unrelated = await volume.root.getFileHandle("notes.txt", { create: true });
  const writable = await unrelated.createWritable();
  await writable.write("not Clicksheet data");
  await writable.close();
  const before = snapshot(volume.root);
  const destination = createVolume("new-root");

  const result = await migrateRoot(volume.root, destination.root);

  assert.equal(result.fileCount, 3);
  assert.deepEqual(snapshot(volume.root), before);

  const { "notes.txt": _notes, ...library } = before;
  assert.deepEqual(snapshot(destination.root), library);

  const moved = createStorage(destination.root);
  assert.equal((await moved.loadJourney(journey.id)).name, "Move me");
});

test("migration refuses the same folder, a nested folder, or existing Clicksheet data", async () => {
  const { volume, storage } = setup();
  await storage.initialize();
  const nested = await volume.root.getDirectoryHandle("nested", { create: true });
  const occupied = createVolume("occupied");
  await createStorage(occupied.root).initialize();
  const occupiedBefore = snapshot(occupied.root);

  await assert.rejects(migrateRoot(volume.root, volume.root), MigrationError);
  await assert.rejects(migrateRoot(volume.root, nested), MigrationError);
  await assert.rejects(migrateRoot(volume.root, occupied.root), /already contains Clicksheet data/);
  assert.deepEqual(snapshot(occupied.root), occupiedBefore);
});

test("a failed migration leaves the original intact and removes the partial copy", async () => {
  const { volume, storage } = setup();
  await storage.initialize();
  await storage.createJourney({ name: "Stay put" });
  const before = snapshot(volume.root);
  const destination = createVolume("failing-root");
  const keep = await destination.root.getFileHandle("keep.txt", { create: true });
  const writable = await keep.createWritable();
  await writable.write("already here");
  await writable.close();
  destination.failWritesMatching = /^journey\.json$/;

  const failure = await migrateRoot(volume.root, destination.root).catch((error) => error);

  assert.ok(failure instanceof MigrationError);
  assert.equal(failure.cause.name, "InvalidStateError");
  assert.deepEqual(snapshot(volume.root), before);
  assert.deepEqual(snapshot(destination.root), { "keep.txt": "already here" });
});

test("saving a stale copy of a Journey is refused instead of overwriting newer data", async () => {
  const { storage } = setup();
  await storage.initialize();
  const journey = await storage.createJourney();
  const newer = await storage.saveJourney({ ...journey, frames: [{ id: "frame-1" }] });

  await assert.rejects(storage.saveJourney({ ...journey, name: "Stale" }), JourneyConflictError);
  assert.deepEqual(await storage.loadJourney(journey.id), newer);
});

test("Journeys from a newer format are skipped rather than downgraded", async () => {
  const { volume, storage } = setup();
  await storage.initialize();
  const journey = await storage.createJourney();
  const file = await (await (await volume.root.getDirectoryHandle("journeys"))
    .getDirectoryHandle(journey.id)).getFileHandle("journey.json");
  const future = JSON.stringify({ ...journey, version: 99 });
  const writable = await file.createWritable();
  await writable.write(future);
  await writable.close();

  await assert.rejects(storage.loadJourney(journey.id), /newer version/);
  const library = await storage.loadLibrary();
  assert.deepEqual(library.journeys, []);
  assert.deepEqual(library.skipped, [journey.id]);
  assert.equal(snapshot(volume.root)[`journeys/${journey.id}/journey.json`], future);
});

test("an index with malformed entries is rebuilt", async () => {
  const { volume, storage } = setup();
  await storage.initialize();
  const journey = await storage.createJourney();
  const writable = await (await volume.root.getFileHandle("index.json")).createWritable();
  await writable.write(JSON.stringify({ format: "clicksheet-index", version: 1, journeys: [{ id: "../x" }] }));
  await writable.close();

  assert.deepEqual((await storage.listJourneys()).map((entry) => entry.id), [journey.id]);
});

test("constant-clock saves still detect stale copies of a Journey", async () => {
  const volume = createVolume();
  const storage = createStorage(volume.root, { now: () => "2026-09-26T00:00:00.000Z", createId: () => "constant-clock" });
  await storage.initialize();
  const initial = await storage.createJourney();
  const next = await storage.saveJourney({ ...initial, frames: [{ id: "frame-1" }] });
  assert.notEqual(next.updatedAt, initial.updatedAt);
  await assert.rejects(storage.saveJourney({ ...initial, name: "Stale rename" }), /changed on disk/);
  assert.equal((await storage.loadJourney(initial.id)).frames.length, 1);
});
