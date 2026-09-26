import assert from "node:assert/strict";
import test from "node:test";
import { createStorage } from "../extension/core/storage.js";
import { setup } from "./support/coordinator.mjs";

async function withFrames(count = 3) {
  const env = setup();
  const created = await env.coordinator.request(1, { action: "new" });
  const id = created.currentJourney.id;
  let view = created;
  for (let n = 0; n < count; n++) {
    env.browser.page.pathname = `/page-${n + 1}`;
    view = await env.coordinator.request(1, { action: "capture", journeyId: id }, env.context);
  }
  return { ...env, id, view, ids: view.currentJourney.frames.map((frame) => frame.id) };
}

const paths = (view) => view.currentJourney.frames.map((frame) => frame.pathname);

test("deleting a screenshot is immediate and one-step Undo restores it in place", async () => {
  const { coordinator, id, ids, volume } = await withFrames();
  let view = await coordinator.request(1, { action: "delete-frame", journeyId: id, frameId: ids[1] });
  assert.deepEqual(paths(view), ["/page-1", "/page-3"]);
  assert.deepEqual(view.undo, { frameId: ids[1] });
  assert.deepEqual((await createStorage(volume.root).loadJourney(id)).frames.map((f) => f.id), [ids[0], ids[2]]);
  view = await coordinator.request(1, { action: "undo-delete", journeyId: id });
  assert.deepEqual(paths(view), ["/page-1", "/page-2", "/page-3"]);
  assert.equal(view.undo, null);
  await assert.rejects(coordinator.request(1, { action: "undo-delete", journeyId: id }), /nothing to undo/);
});

test("the deleted screenshot file is removed once the Undo window ends", async () => {
  const { coordinator, id, ids, volume } = await withFrames();
  const storage = createStorage(volume.root);
  const file = `${ids[0]}.png`;
  await coordinator.request(1, { action: "delete-frame", journeyId: id, frameId: ids[0] });
  assert.ok((await storage.listScreenshots(id)).includes(file), "kept while Undo is possible");
  const view = await coordinator.request(1, { action: "delete-frame", journeyId: id, frameId: ids[1] });
  assert.equal((await storage.listScreenshots(id)).includes(file), false);
  assert.deepEqual(view.undo, { frameId: ids[1] });
});

test("orphaned screenshots are pruned when a Journey is reopened", async () => {
  const { coordinator, id, volume } = await withFrames(1);
  const storage = createStorage(volume.root);
  await storage.writeScreenshot(id, "frame-orphan.png", "left behind");
  await coordinator.request(1, { action: "open", id });
  assert.equal((await storage.listScreenshots(id)).includes("frame-orphan.png"), false);
});

test("reordering moves a screenshot and sequence follows array order", async () => {
  const { coordinator, id, ids } = await withFrames();
  let view = await coordinator.request(1, { action: "move-frame", journeyId: id, frameId: ids[2], toIndex: 0 });
  assert.deepEqual(paths(view), ["/page-3", "/page-1", "/page-2"]);
  view = await coordinator.request(1, { action: "move-frame", journeyId: id, frameId: ids[2], toIndex: 99 });
  assert.deepEqual(paths(view), ["/page-1", "/page-2", "/page-3"]);
  await assert.rejects(coordinator.request(1, { action: "move-frame", journeyId: id, frameId: "missing", toIndex: 0 }), /not found/);
});

test("settings are validated, saved per Journey, and update an active recording delay", async () => {
  const { coordinator, id, context, volume } = await withFrames(0);
  let view = await coordinator.request(1, { action: "settings", journeyId: id, settings: { captureArea: "fullPage", captureDelayMs: 1200 } });
  assert.deepEqual(view.currentJourney.settings, { captureArea: "fullPage", captureDelayMs: 1200 });
  assert.deepEqual((await createStorage(volume.root).loadJourney(id)).settings, { captureArea: "fullPage", captureDelayMs: 1200 });
  await assert.rejects(coordinator.request(1, { action: "settings", journeyId: id, settings: { captureArea: "tab" } }), /viewport or full page/);
  await assert.rejects(coordinator.request(1, { action: "settings", journeyId: id, settings: { captureDelayMs: -1 } }), /0 to 10000/);
  await coordinator.request(1, { action: "record", journeyId: id }, context);
  view = await coordinator.request(1, { action: "settings", journeyId: id, settings: { captureDelayMs: 300 } });
  assert.equal(view.currentJourney.settings.captureDelayMs, 300);
});

test("export is unavailable for an empty Journey and renders every frame in order", async () => {
  const empty = await withFrames(0);
  let view = await empty.coordinator.request(1, { action: "snapshot" });
  assert.equal(view.canExport, false);
  await assert.rejects(empty.coordinator.request(1, { action: "export", journeyId: empty.id, destination: "download" }), /no screenshots/);

  const { coordinator, id, volume } = await withFrames(2);
  view = await coordinator.request(1, { action: "snapshot" });
  assert.equal(view.canExport, true);
  const copied = await coordinator.request(1, { action: "export", journeyId: id, destination: "copy" });
  assert.equal(Buffer.from(copied.image.split(",")[1], "base64").toString(), "sheet:pixels of /page-1|pixels of /page-2");
  await coordinator.request(1, { action: "rename", journeyId: id, name: "Create a New User!" });
  const first = await coordinator.request(1, { action: "export", journeyId: id, destination: "download" });
  const second = await coordinator.request(1, { action: "export", journeyId: id, destination: "download" });
  assert.equal(first.exported.fileName, "create-a-new-user.png");
  assert.equal(second.exported.fileName, "create-a-new-user-2.png");
  assert.match(second.notice, /create-a-new-user-2\.png/);
  assert.deepEqual(await createStorage(volume.root).listExports(id), ["create-a-new-user-2.png", "create-a-new-user.png"]);
});

test("the editor reads one stored screenshot without exposing other Journeys", async () => {
  const { coordinator, id, ids } = await withFrames(1);
  const view = await coordinator.request(9, { action: "screenshot", journeyId: id, frameId: ids[0] });
  assert.equal(Buffer.from(view.screenshot.split(",")[1], "base64").toString(), "pixels of /page-1");
  assert.equal(view.frame.id, ids[0]);
  await assert.rejects(coordinator.request(9, { action: "screenshot", journeyId: id, frameId: "nope" }), /not found/);
});

test("redaction replaces the stored screenshot and removes the original pixels", async () => {
  const masksSeen = [];
  const env = setup({ redactImage: async (file, masks) => { masksSeen.push(masks); return { blob: new Blob([`redacted ${await file.text()}`]), width: 200, height: 100 }; } });
  const created = await env.coordinator.request(1, { action: "new" });
  const id = created.currentJourney.id;
  const captured = await env.coordinator.request(1, { action: "capture", journeyId: id }, env.context);
  const original = captured.currentJourney.frames[0];
  const view = await env.coordinator.request(9, { action: "redact", journeyId: id, frameId: original.id, masks: [{ x: 1, y: 2, width: 30, height: 40 }] });
  const frame = view.currentJourney.frames[0];
  assert.notEqual(frame.screenshotFile, original.screenshotFile);
  assert.equal(frame.redacted, true);
  assert.deepEqual(masksSeen, [[{ x: 1, y: 2, width: 30, height: 40 }]]);
  const storage = createStorage(env.volume.root);
  assert.deepEqual(await storage.listScreenshots(id), [frame.screenshotFile]);
  assert.equal(await (await storage.readScreenshot(id, frame.screenshotFile)).text(), "redacted pixels of /dashboard");
  const reloaded = await storage.loadJourney(id);
  assert.equal(reloaded.frames[0].screenshotFile, frame.screenshotFile);
});

test("a redaction that cannot be saved keeps the original file", async () => {
  const env = setup({ redactImage: async () => ({ blob: new Blob(["redacted"]), width: 1, height: 1 }) });
  const created = await env.coordinator.request(1, { action: "new" });
  const id = created.currentJourney.id;
  const captured = await env.coordinator.request(1, { action: "capture", journeyId: id }, env.context);
  const original = captured.currentJourney.frames[0];
  env.volume.failWritesMatching = /journey\.json/;
  await assert.rejects(env.coordinator.request(1, { action: "redact", journeyId: id, frameId: original.id, masks: [{ x: 0, y: 0, width: 5, height: 5 }] }), /held until storage is reconnected/);
  env.volume.failWritesMatching = null;
  assert.ok((await createStorage(env.volume.root).listScreenshots(id)).includes(original.screenshotFile));
});

test("Undo survives the worker idling out", async () => {
  const { memoryBindings } = await import("../extension/core/journey-coordinator.js");
  const bindings = memoryBindings();
  const first = setup({ bindings });
  const created = await first.coordinator.request(1, { action: "new" });
  const id = created.currentJourney.id;
  const captured = await first.coordinator.request(1, { action: "capture", journeyId: id }, first.context);
  const frameId = captured.currentJourney.frames[0].id;
  await first.coordinator.request(1, { action: "delete-frame", journeyId: id, frameId });
  const restarted = setup({ bindings, volume: first.volume });
  let view = await restarted.coordinator.request(1, { action: "snapshot", journeyId: id });
  assert.deepEqual(view.undo, { frameId });
  view = await restarted.coordinator.request(1, { action: "undo-delete", journeyId: id });
  assert.deepEqual(view.currentJourney.frames.map((frame) => frame.id), [frameId]);
  assert.equal(await (await createStorage(first.volume.root).readScreenshot(id, `${frameId}.png`)).text(), "pixels of /dashboard");
});
