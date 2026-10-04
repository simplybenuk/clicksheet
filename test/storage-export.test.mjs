import assert from "node:assert/strict";
import test from "node:test";

import { createStorage } from "../extension/core/storage.js";
import { createVolume, readText, snapshot } from "./support/memory-fs.mjs";

async function setup() {
  const volume = createVolume();
  let nextId = 0;
  const storage = createStorage(volume.root, { createId: () => `journey-${++nextId}` });
  await storage.initialize();
  const journey = await storage.createJourney({ name: "Create a new user" });
  return { volume, storage, journey };
}

async function writeRaw(root, path, text) {
  const parts = path.split("/");
  let directory = root;
  for (const part of parts.slice(0, -1)) directory = await directory.getDirectoryHandle(part, { create: true });
  const writable = await (await directory.getFileHandle(parts.at(-1), { create: true })).createWritable();
  await writable.write(text);
  await writable.close();
}

test("an image and its context are saved as a pair in the top-level exports folder", async () => {
  const { volume, storage, journey } = await setup();

  const first = await storage.writeExportPair("create-a-new-user", "png-1", "json-1");
  const second = await storage.writeExportPair("create-a-new-user", "png-2", "json-2");

  assert.deepEqual(first, { fileName: "create-a-new-user.png", contextFileName: "create-a-new-user.json" });
  assert.deepEqual(second, { fileName: "create-a-new-user-2.png", contextFileName: "create-a-new-user-2.json" });
  assert.equal(await readText(volume.root, "exports/create-a-new-user.png"), "png-1");
  assert.equal(await readText(volume.root, "exports/create-a-new-user.json"), "json-1");
  assert.equal(await readText(volume.root, "exports/create-a-new-user-2.json"), "json-2");
  assert.deepEqual(await storage.listExports(), [
    "create-a-new-user-2.json", "create-a-new-user-2.png", "create-a-new-user.json", "create-a-new-user.png"
  ]);
  // Exports are files beside the library, not part of Journey metadata.
  assert.doesNotMatch(await readText(volume.root, `journeys/${journey.id}/journey.json`), /create-a-new-user\.png/);
});

test("new Journeys no longer get their own exports folder, and old export folders are left alone", async () => {
  const { volume, storage, journey } = await setup();
  assert.equal(`journeys/${journey.id}/exports/` in snapshot(volume.root), false);

  await writeRaw(volume.root, `journeys/${journey.id}/exports/old.png`, "old export");
  await storage.saveJourney({ ...(await storage.loadJourney(journey.id)), name: "Renamed" });
  await storage.writeExportPair("renamed", "png", "json");
  assert.equal(await readText(volume.root, `journeys/${journey.id}/exports/old.png`), "old export");
});

test("a name taken by either file of the pair is skipped, whatever its case", async () => {
  const { volume, storage } = await setup();
  await writeRaw(volume.root, "exports/FLOW.json", "keep me");

  assert.deepEqual(await storage.writeExportPair("flow", "png", "json"), { fileName: "flow-2.png", contextFileName: "flow-2.json" });
  assert.equal(await readText(volume.root, "exports/FLOW.json"), "keep me");
});

test("concurrent exports get distinct pairs", async () => {
  const { storage } = await setup();
  const results = await Promise.all([1, 2, 3].map((n) => storage.writeExportPair("flow", `png-${n}`, `json-${n}`)));
  assert.deepEqual(results.map((result) => result.fileName).sort(), ["flow-2.png", "flow-3.png", "flow.png"]);
  for (const { fileName, contextFileName } of results) assert.equal(fileName.replace(/\.png$/, ""), contextFileName.replace(/\.json$/, ""));
});

test("a failed write removes both files of the pair and surfaces the error", async () => {
  const { volume, storage } = await setup();
  volume.failWritesMatching = /\.json$/;
  await assert.rejects(storage.writeExportPair("flow", "png", "json"), /Simulated write failure/);
  assert.deepEqual(await storage.listExports(), []);

  volume.failWritesMatching = null;
  assert.deepEqual(await storage.writeExportPair("flow", "png", "json"), { fileName: "flow.png", contextFileName: "flow.json" });
});
