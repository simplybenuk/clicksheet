import assert from "node:assert/strict";
import test from "node:test";
import { createJourneyCoordinator } from "../extension/core/journey-coordinator.js";
import { createLibrarySession } from "../extension/core/library-session.js";
import { createStorage } from "../extension/core/storage.js";
import { createVolume } from "./support/memory-fs.mjs";

function setup(volume = createVolume()) {
  let root = volume.root;
  let nextId = 0;
  const options = {
    loadRootHandle: async () => root,
    saveRootHandle: async (handle) => { root = handle; },
    sessionFactory: (settings) => createLibrarySession({ ...settings, autosaveOptions: { delayMs: 0 }, storageFactory: (handle, options) => createStorage(handle, { ...options, createId: () => `journey-${++nextId}` }) }),
    thumbnail: async (file) => `preview:${await file.text()}`
  };
  return { volume, options, coordinator: createJourneyCoordinator(options) };
}

test("new Journeys are saved and previous Journeys stay in the compact library", async () => {
  const { coordinator, volume } = setup();
  const first = await coordinator.request(1, { action: "new" });
  const second = await coordinator.request(1, { action: "new", journeyId: first.currentJourney.id });
  assert.equal(second.journeys.length, 2);
  assert.notEqual(second.currentJourney.id, first.currentJourney.id);
  assert.equal(second.currentJourney.frames.length, 0);
  assert.equal(second.status, "Saved locally");
  assert.equal(second.controls.record, false);
  assert.equal((await createStorage(volume.root).loadLibrary()).journeys.length, 2);
});

test("explicit Journey ids prevent a suspended worker from renaming the wrong Journey", async () => {
  const { options, coordinator, volume } = setup();
  const first = await coordinator.request(1, { action: "new" });
  const second = await coordinator.request(1, { action: "new", journeyId: first.currentJourney.id });
  const restarted = createJourneyCoordinator(options);
  const renamed = await restarted.request(1, { action: "rename", journeyId: second.currentJourney.id, name: "Second after restart" });
  assert.equal(renamed.currentJourney.name, "Second after restart");
  assert.equal((await createStorage(volume.root).loadJourney(first.currentJourney.id)).name, "Untitled Journey");
  await assert.rejects(restarted.request(1, { action: "rename", journeyId: "missing", name: "Wrong target" }), /not found/);
});

test("failed New is not acknowledged as a saved Journey", async () => {
  const { coordinator, volume } = setup();
  await coordinator.request(1, { action: "snapshot" });
  volume.failWritesMatching = /journey\.json/;
  await assert.rejects(coordinator.request(1, { action: "new" }), /could not be saved/);
});

test("a failed rename reports held state and retries by id after worker restart", async () => {
  const { coordinator, options, volume } = setup();
  const created = await coordinator.request(1, { action: "new" });
  const id = created.currentJourney.id;
  volume.failWritesMatching = /journey\.json/;
  const held = await coordinator.request(1, { action: "rename", journeyId: id, name: "Held" });
  assert.equal(held.status, "Storage unavailable");
  assert.equal(held.hasUnsavedChanges, true);
  assert.equal((await createStorage(volume.root).loadJourney(id)).name, "Untitled Journey");
  volume.failWritesMatching = null;
  const restarted = createJourneyCoordinator(options);
  const saved = await restarted.request(1, { action: "rename", journeyId: id, name: "Held" });
  assert.equal(saved.status, "Saved locally");
  assert.equal((await createStorage(volume.root).loadJourney(id)).name, "Held");
});

test("previews are read only from a frame in the selected Journey", async () => {
  const { coordinator, volume } = setup();
  const created = await coordinator.request(1, { action: "new" });
  const storage = createStorage(volume.root);
  const journey = await storage.loadJourney(created.currentJourney.id);
  await storage.writeScreenshot(journey.id, "frame.png", "PNG fixture");
  await storage.saveJourney({ ...journey, frames: [{ id: "frame", screenshotFile: "frame.png" }] });
  const preview = await coordinator.request(1, { action: "thumbnail", journeyId: journey.id, frameId: "frame" });
  assert.equal(preview.thumbnail, "preview:PNG fixture");
  await assert.rejects(coordinator.request(1, { action: "thumbnail", journeyId: journey.id, frameId: "missing" }), /not found/);
});

test("describe saves the description of the addressed Journey only", async () => {
  const { coordinator, volume } = setup();
  const created = await coordinator.request(1, { action: "new" });
  const id = created.currentJourney.id;
  const described = await coordinator.request(1, { action: "describe", journeyId: id, description: "Sign up, then invite a teammate." });
  assert.equal(described.currentJourney.description, "Sign up, then invite a teammate.");
  assert.equal((await createStorage(volume.root).loadJourney(id)).description, "Sign up, then invite a teammate.");
  await assert.rejects(coordinator.request(1, { action: "describe", journeyId: "missing", description: "x" }), /not found/);
  await assert.rejects(coordinator.request(1, { action: "describe", journeyId: id, description: 5 }), /cannot be changed/);
});

test("a rename or describe without a Journey id, or for a Journey the tab does not show, changes nothing", async () => {
  const { coordinator, volume } = setup();
  const first = (await coordinator.request(1, { action: "new" })).currentJourney.id;
  const second = (await coordinator.request(1, { action: "new", journeyId: first })).currentJourney.id;
  const storage = createStorage(volume.root);
  const texts = async () => Promise.all([first, second].map(async (id) => {
    const { name, description } = await storage.loadJourney(id);
    return `${name}|${description ?? ""}`;
  }));
  const before = await texts();
  // No id is never read as "the Journey shown now".
  for (const journeyId of [undefined, null, ""]) {
    await assert.rejects(coordinator.request(1, { action: "rename", journeyId, name: "Stale text" }), /did not say which Journey/);
    await assert.rejects(coordinator.request(1, { action: "describe", journeyId, description: "Stale text" }), /did not say which Journey/);
  }
  // The tab shows the second Journey; text addressed to the first is refused
  // and the tab is not switched to it.
  const refused = await coordinator.request(1, { action: "rename", journeyId: first, name: "Stale text" }).catch((error) => error);
  assert.match(refused.message, /Another Journey is shown in this tab/);
  assert.equal(refused.view.currentJourney.id, second);
  await assert.rejects(coordinator.request(1, { action: "describe", journeyId: first, description: "Stale text" }), /Another Journey is shown/);
  // A Journey whose folder was removed by hand: refused, never redirected.
  await volume.root.getDirectoryHandle("journeys").then((dir) => dir.removeEntry(second, { recursive: true }));
  await assert.rejects(coordinator.request(1, { action: "rename", journeyId: second, name: "Stale text" }), /not found/);
  await assert.rejects(coordinator.request(1, { action: "rename", name: "Stale text" }), /did not say which Journey/);
  const { name, description } = await storage.loadJourney(first);
  assert.equal(`${name}|${description ?? ""}`, before[0], "the other Journey is untouched");
});
