import assert from "node:assert/strict";
import test from "node:test";

import { createStorage } from "../extension/core/storage.js";
import { createVolume, readText } from "./support/memory-fs.mjs";

async function setup() {
  const volume = createVolume();
  let nextId = 0;
  const storage = createStorage(volume.root, { createId: () => `journey-${++nextId}` });
  await storage.initialize();
  const journey = await storage.createJourney({ name: "Create a new user" });
  return { volume, storage, journey };
}

test("exports are named from the Journey and never overwrite", async () => {
  const { volume, storage, journey } = await setup();

  const first = await storage.writeExport(journey.id, journey.name, "one");
  const second = await storage.writeExport(journey.id, journey.name, "two");
  const third = await storage.writeExport(journey.id, "Create a NEW user!", "three");

  assert.deepEqual([first, second, third].map((result) => result.fileName), [
    "create-a-new-user.png",
    "create-a-new-user-2.png",
    "create-a-new-user-3.png"
  ]);
  const base = `journeys/${journey.id}/exports`;
  assert.equal(await readText(volume.root, `${base}/create-a-new-user.png`), "one");
  assert.equal(await readText(volume.root, `${base}/create-a-new-user-2.png`), "two");
  assert.equal(await readText(volume.root, `${base}/create-a-new-user-3.png`), "three");
  assert.deepEqual(await storage.listExports(journey.id), [
    "create-a-new-user-2.png",
    "create-a-new-user-3.png",
    "create-a-new-user.png"
  ]);
  // Exports are files beside the Journey, not part of its metadata.
  assert.doesNotMatch(await readText(volume.root, `journeys/${journey.id}/journey.json`), /create-a-new-user\.png/);
});

test("concurrent exports get distinct names", async () => {
  const { storage, journey } = await setup();
  const results = await Promise.all([1, 2, 3].map((n) => storage.writeExport(journey.id, "Flow", `data-${n}`)));
  assert.deepEqual(results.map((result) => result.fileName).sort(), ["flow-2.png", "flow-3.png", "flow.png"]);
});

test("existing files, whatever their case, are skipped", async () => {
  const { volume, storage, journey } = await setup();
  const exportsDir = await (await (await volume.root.getDirectoryHandle("journeys")).getDirectoryHandle(journey.id)).getDirectoryHandle("exports");
  const existing = await exportsDir.getFileHandle("FLOW.png", { create: true });
  const writable = await existing.createWritable();
  await writable.write("keep me");
  await writable.close();

  assert.deepEqual(await storage.writeExport(journey.id, "Flow", "new"), { fileName: "flow-2.png" });
  assert.equal(await readText(volume.root, `journeys/${journey.id}/exports/FLOW.png`), "keep me");
});

test("an empty Journey name falls back to a generic slug", async () => {
  const { storage, journey } = await setup();
  assert.deepEqual(await storage.writeExport(journey.id, "   ", "x"), { fileName: "untitled-journey.png" });
});

test("failed export writes leave no file behind and surface the error", async () => {
  const { volume, storage, journey } = await setup();
  volume.failWritesMatching = /\.png$/;

  await assert.rejects(storage.writeExport(journey.id, "Flow", "data"), /Simulated write failure/);
  assert.deepEqual(await storage.listExports(journey.id), []);

  volume.failWritesMatching = null;
  assert.deepEqual(await storage.writeExport(journey.id, "Flow", "data"), { fileName: "flow.png" });
});

test("exports for unknown Journeys are rejected", async () => {
  const { storage } = await setup();
  await assert.rejects(storage.writeExport("missing", "Flow", "x"), { name: "NotFoundError" });
  await assert.rejects(storage.writeExport("../escape", "Flow", "x"), TypeError);
});
