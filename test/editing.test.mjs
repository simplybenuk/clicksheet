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
  await assert.rejects(empty.coordinator.request(1, { action: "export", journeyId: empty.id, destination: "save" }), /no screenshots/);

  const { coordinator, id } = await withFrames(2);
  view = await coordinator.request(1, { action: "snapshot" });
  assert.equal(view.canExport, true);
  const copied = await coordinator.request(1, { action: "export", journeyId: id, destination: "copy" });
  assert.equal(Buffer.from(copied.image.split(",")[1], "base64").toString(), "sheet:pixels of /page-1|pixels of /page-2");
  await assert.rejects(coordinator.request(1, { action: "export", journeyId: id, destination: "download" }), /Choose Copy image, Copy context, or Save/);
});

test("Save writes the image and its context to Downloads by default and offers them in the bar", async () => {
  const { coordinator, id, options } = await withFrames(2);
  await coordinator.request(1, { action: "rename", journeyId: id, name: "Create a New User!" });
  const view = await coordinator.request(1, { action: "export", journeyId: id, destination: "save" });
  const [saved] = options.downloads.saved;
  assert.equal(view.exportDestination, "downloads");
  assert.match(saved.fileName, /^create-a-new-user-\d{4}-\d{2}-\d{2}-\d{4}\.png$/);
  assert.equal(saved.contextFileName, saved.fileName.replace(/\.png$/, ".json"));
  assert.equal(saved.image, "sheet:pixels of /page-1|pixels of /page-2");
  assert.equal(saved.context.format, "clicksheet-context");
  assert.equal(saved.context.journey.title, "Create a New User!");
  assert.deepEqual(saved.context.steps.map((step) => step.page.pathname), ["/page-1", "/page-2"]);
  assert.deepEqual(view.exported, { destination: "downloads", downloadId: 1, fileName: saved.fileName, contextFileName: saved.contextFileName });
  assert.deepEqual(view.lastExport, { downloadId: 1, fileName: saved.fileName, contextFileName: saved.contextFileName });
  assert.match(view.notice, /Downloads\/Clicksheet/);
  assert.deepEqual(await coordinator.lastExport(1), view.lastExport);
  assert.equal(await coordinator.lastExport(2), null, "another tab has no bar");

  // Saving again in the same minute still pairs each image with its context.
  await coordinator.request(1, { action: "export", journeyId: id, destination: "save" });
  const second = options.downloads.saved[1];
  assert.notEqual(second.fileName, saved.fileName);
  assert.equal(second.contextFileName, second.fileName.replace(/\.png$/, ".json"));

  const dismissed = await coordinator.request(1, { action: "dismiss-export", journeyId: id });
  assert.equal(dismissed.lastExport, null);
});

test("a failed Downloads save reports the error and shows no bar", async () => {
  const { coordinator, id, options } = await withFrames(1);
  options.downloads.fail = "Saved flow.png in Downloads/Clicksheet, but its context file could not be saved.";
  await assert.rejects(coordinator.request(1, { action: "export", journeyId: id, destination: "save" }), /context file could not be saved/);
  assert.equal((await coordinator.request(1, { action: "snapshot" })).lastExport, null);
});

test("the Clicksheet folder destination saves the pair in exports/ and is remembered", async () => {
  const { coordinator, id, volume, options } = await withFrames(2);
  let view = await coordinator.request(1, { action: "export-settings", journeyId: id, destination: "library" });
  assert.equal(view.exportDestination, "library");
  await assert.rejects(coordinator.request(1, { action: "export-settings", journeyId: id, destination: "cloud" }), /Choose Downloads or the Clicksheet folder/);
  await coordinator.request(1, { action: "rename", journeyId: id, name: "Create a New User!" });
  const first = await coordinator.request(1, { action: "export", journeyId: id, destination: "save" });
  const second = await coordinator.request(1, { action: "export", journeyId: id, destination: "save" });
  assert.deepEqual(first.exported, { destination: "library", fileName: "create-a-new-user.png", contextFileName: "create-a-new-user.json" });
  assert.equal(second.exported.fileName, "create-a-new-user-2.png");
  assert.match(second.notice, /Saved create-a-new-user-2\.png and create-a-new-user-2\.json in .*\/exports\./);
  assert.equal(second.lastExport, null, "no Open or Show for the Clicksheet folder");
  assert.equal(options.downloads.saved.length, 0);
  const storage = createStorage(volume.root);
  assert.deepEqual(await storage.listExports(), ["create-a-new-user-2.json", "create-a-new-user-2.png", "create-a-new-user.json", "create-a-new-user.png"]);

  // A new coordinator (worker restart) sharing the settings store keeps the choice.
  const restarted = setup({ volume, exportSettings: options.exportSettings });
  assert.equal((await restarted.coordinator.request(1, { action: "snapshot" })).exportDestination, "library");
});

test("Copy context describes the image Copy image produced", async () => {
  const widths = [];
  const env = setup({ renderSheet: async (journey, load, options) => {
    widths.push(options?.imageWidth ?? "native");
    return new Blob([new Uint8Array(options?.imageWidth === 960 ? 10 : 46 * 1024 * 1024)], { type: "image/png" });
  } });
  const created = await env.coordinator.request(1, { action: "new" });
  const id = created.currentJourney.id;
  await env.coordinator.request(1, { action: "capture", journeyId: id }, env.context);
  const before = JSON.parse((await env.coordinator.request(1, { action: "export", journeyId: id, destination: "context" })).context);
  await env.coordinator.request(1, { action: "export", journeyId: id, destination: "copy" });
  const after = JSON.parse((await env.coordinator.request(1, { action: "export", journeyId: id, destination: "context" })).context);
  assert.equal(widths.at(-1), 960);
  assert.equal(before.format, "clicksheet-context");
  assert.equal(after.steps.length, 1);
  assert.notEqual(after.sheet.width, before.sheet.width, "the context follows the fallback width Copy used");
  assert.equal(after.steps[0].page.origin, "https://app.example.test");
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

test("redaction boxes are stored on the frame, and a frame redacted before boxes were kept stays unknown", async () => {
  let next = [{ x: 1, y: 2, width: 30, height: 40 }];
  const env = setup({ redactImage: async () => ({ blob: new Blob(["redacted"]), width: 200, height: 100, boxes: next }) });
  const created = await env.coordinator.request(1, { action: "new" });
  const id = created.currentJourney.id;
  let view = await env.coordinator.request(1, { action: "capture", journeyId: id }, env.context);
  const frameId = view.currentJourney.frames[0].id;
  view = await env.coordinator.request(1, { action: "redact", journeyId: id, frameId, masks: next });
  assert.deepEqual(view.currentJourney.frames[0].masks, [{ x: 1, y: 2, width: 30, height: 40 }]);
  next = [{ x: 50, y: 50, width: 5, height: 5 }];
  view = await env.coordinator.request(1, { action: "redact", journeyId: id, frameId, masks: next });
  assert.deepEqual(view.currentJourney.frames[0].masks, [{ x: 1, y: 2, width: 30, height: 40 }, { x: 50, y: 50, width: 5, height: 5 }]);
  assert.deepEqual((await createStorage(env.volume.root).loadJourney(id)).frames[0].masks, view.currentJourney.frames[0].masks);

  // Simulate a frame redacted by an older version: redacted, but no boxes.
  const storage = createStorage(env.volume.root);
  const journey = await storage.loadJourney(id);
  const { masks, ...older } = journey.frames[0];
  await storage.saveJourney({ ...journey, frames: [older] });
  const fresh = setup({ volume: env.volume, redactImage: async () => ({ blob: new Blob(["again"]), width: 200, height: 100, boxes: next }) });
  view = await fresh.coordinator.request(1, { action: "redact", journeyId: id, frameId, masks: next });
  assert.equal(view.currentJourney.frames[0].redacted, true);
  assert.equal("masks" in view.currentJourney.frames[0], false);
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

test("an export the browser cannot allocate is retried at smaller widths", async () => {
  const widths = [];
  const env = setup({ renderSheet: async (journey, load, options) => {
    widths.push(options?.imageWidth ?? "native");
    if (!options || options.imageWidth > 960) throw Object.assign(new Error("canvas refused"), { name: "ExportTooLargeError" });
    return new Blob(["sheet"], { type: "image/png" });
  } });
  const created = await env.coordinator.request(1, { action: "new" });
  await env.coordinator.request(1, { action: "capture", journeyId: created.currentJourney.id }, env.context);
  const view = await env.coordinator.request(1, { action: "export", journeyId: created.currentJourney.id, destination: "save" });
  assert.deepEqual(widths, ["native", 1280, 960]);
  assert.match(view.exported.fileName, /^untitled-journey-.*\.png$/);
});

test("Copy shrinks a sheet that is too large for a message instead of refusing", async () => {
  const widths = [];
  const env = setup({ renderSheet: async (journey, load, options) => {
    widths.push(options?.imageWidth ?? "native");
    return new Blob([new Uint8Array(options?.imageWidth === 640 ? 10 : 46 * 1024 * 1024)], { type: "image/png" });
  } });
  const created = await env.coordinator.request(1, { action: "new" });
  await env.coordinator.request(1, { action: "capture", journeyId: created.currentJourney.id }, env.context);
  const view = await env.coordinator.request(1, { action: "export", journeyId: created.currentJourney.id, destination: "copy" });
  assert.deepEqual(widths, ["native", 1280, 960, 640]);
  assert.match(view.image, /^data:image\/png;base64,/);
});

test("a sheet too large at every width still fails with guidance", async () => {
  const env = setup({ renderSheet: async () => { throw Object.assign(new Error("Delete some screenshots, then export again."), { name: "ExportTooLargeError" }); } });
  const created = await env.coordinator.request(1, { action: "new" });
  await env.coordinator.request(1, { action: "capture", journeyId: created.currentJourney.id }, env.context);
  await assert.rejects(env.coordinator.request(1, { action: "export", journeyId: created.currentJourney.id, destination: "save" }), /Delete some screenshots/);
});

test("the viewer loads a large preview of one screenshot in the selected Journey", async () => {
  const sizes = [];
  const env = setup({ thumbnail: async (file, frame, size) => { sizes.push(size.maxWidth); return `preview:${await file.text()}`; } });
  const created = await env.coordinator.request(1, { action: "new" });
  const id = created.currentJourney.id;
  const captured = await env.coordinator.request(1, { action: "capture", journeyId: id }, env.context);
  const frameId = captured.currentJourney.frames[0].id;
  const viewed = await env.coordinator.request(1, { action: "view-frame", journeyId: id, frameId });
  assert.equal(viewed.image, "preview:pixels of /dashboard");
  assert.equal(viewed.frameId, frameId);
  await env.coordinator.request(1, { action: "thumbnail", journeyId: id, frameId });
  assert.deepEqual(sizes, [2000, 240]);
  await assert.rejects(env.coordinator.request(1, { action: "view-frame", journeyId: id, frameId: "missing" }), /not found/);
});
