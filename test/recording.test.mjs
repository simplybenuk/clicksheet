import assert from "node:assert/strict";
import test from "node:test";
import { memoryBindings } from "../extension/core/journey-coordinator.js";
import { createStorage } from "../extension/core/storage.js";
import { createVolume } from "./support/memory-fs.mjs";
import { ORIGIN, recording, setup } from "./support/coordinator.mjs";

const click = (label, x = 10) => ({ type: "click", click: { rect: { x, y: 5, width: 20, height: 10 }, point: { x: x + 5, y: 10 }, scrollX: 0, scrollY: 0, label, pathname: "/dashboard" } });

test("Record captures a sanitized initial frame with the toolbar hidden, then records", async () => {
  const { view, browser, volume, id } = await recording();
  assert.equal(view.currentJourney.state, "Recording");
  assert.equal(view.currentJourney.recordingSegment, 1);
  assert.equal(view.recordingHere, true);
  assert.deepEqual(view.controls, { record: false, pause: true, resume: false, stop: true, capture: true, newJourney: false, openJourney: false, rename: true });
  const [frame] = view.currentJourney.frames;
  assert.equal(frame.kind, "initial");
  assert.equal(frame.label, "Start");
  assert.equal(frame.pathname, "/dashboard");
  assert.deepEqual(frame.image, { width: 200, height: 100 });
  assert.equal(frame.interaction, null);
  assert.deepEqual(browser.calls.slice(0, 4), [["prepare", 1], ["capture", 1], ["sanitize", 1], ["restore", 1]]);
  const stored = await createStorage(volume.root).readScreenshot(id, frame.screenshotFile);
  assert.equal(await stored.text(), "pixels of /dashboard");
  assert.equal((await createStorage(volume.root).loadJourney(id)).state, "Recording");
});

test("a page-changing click captures once after the delay and marks the preceding frame", async () => {
  const { coordinator, time, browser, id } = await recording();
  browser.page.pathname = "/settings";
  await coordinator.event(1, click("Settings"));
  await coordinator.event(1, { type: "changed" });
  await time.advance(499);
  let view = await coordinator.request(1, { action: "snapshot", journeyId: id });
  assert.equal(view.currentJourney.frames.length, 1);
  await time.advance(1);
  view = await coordinator.request(1, { action: "snapshot", journeyId: id });
  const [before, after] = view.currentJourney.frames;
  assert.equal(view.currentJourney.frames.length, 2);
  assert.deepEqual(before.interaction, { type: "click", label: "Settings", rect: { x: 10, y: 5, width: 20, height: 10 }, point: { x: 15, y: 10 } });
  assert.equal(after.kind, "click");
  assert.equal(after.pathname, "/settings");
  assert.equal(after.interaction, null);
  assert.ok(browser.calls.some(([name]) => name === "notify"));
});

test("no-op clicks create no frame and rapid clicks coalesce into the latest", async () => {
  const { coordinator, time, id } = await recording();
  await coordinator.event(1, click("Nothing"));
  await time.advance(3000);
  await coordinator.event(1, click("First", 10));
  await coordinator.event(1, { type: "changed" });
  await time.advance(200);
  await coordinator.event(1, click("Latest", 40));
  await coordinator.event(1, { type: "changed" });
  await time.advance(2000);
  const view = await coordinator.request(1, { action: "snapshot", journeyId: id });
  assert.equal(view.currentJourney.frames.length, 2);
  assert.equal(view.currentJourney.frames[0].interaction.label, "Latest");
});

test("a change long after a click is not attributed to it", async () => {
  const { coordinator, time, id } = await recording();
  await coordinator.event(1, click("Late"));
  await time.advance(3000);
  await coordinator.event(1, { type: "changed" });
  await time.advance(2000);
  const view = await coordinator.request(1, { action: "snapshot", journeyId: id });
  assert.equal(view.currentJourney.frames.length, 1);
});

test("switching tabs pauses and cancels pending capture; returning resumes", async () => {
  const { coordinator, time, id } = await recording();
  await coordinator.event(1, click("Settings"));
  await coordinator.event(1, { type: "changed" });
  await coordinator.event(2, { type: "activated", windowId: 7 });
  let view = await coordinator.request(1, { action: "snapshot", journeyId: id });
  assert.equal(view.currentJourney.state, "Paused");
  assert.equal(view.currentJourney.pauseReason, "tab");
  await time.advance(2000);
  view = await coordinator.request(1, { action: "snapshot", journeyId: id });
  assert.equal(view.currentJourney.frames.length, 1);
  await coordinator.event(3, { type: "activated", windowId: 99 });
  await coordinator.event(1, { type: "activated", windowId: 7 });
  view = await coordinator.request(1, { action: "snapshot", journeyId: id });
  assert.equal(view.currentJourney.state, "Recording");
});

test("a user pause is not resumed by returning to the tab", async () => {
  const { coordinator, id } = await recording();
  await coordinator.request(1, { action: "pause", journeyId: id });
  await coordinator.event(2, { type: "activated", windowId: 7 });
  await coordinator.event(1, { type: "activated", windowId: 7 });
  const view = await coordinator.request(1, { action: "snapshot", journeyId: id });
  assert.equal(view.currentJourney.pauseReason, "user");
  assert.equal(view.controls.capture, true);
});

test("same-origin navigation after a click re-injects and captures; unclicked navigation does not", async () => {
  const { coordinator, time, browser, id } = await recording();
  await coordinator.event(1, { type: "updated", status: "loading" });
  await coordinator.event(1, { type: "updated", status: "complete", url: `${ORIGIN}/typed` });
  await time.advance(2000);
  let view = await coordinator.request(1, { action: "snapshot", journeyId: id });
  assert.equal(view.currentJourney.frames.length, 1, "Back, Forward and typed URLs need Manual Capture");
  assert.deepEqual(browser.calls.filter(([name]) => name === "inject"), [["inject", 1]]);
  browser.page.pathname = "/users";
  await coordinator.event(1, click("Users"));
  await coordinator.event(1, { type: "updated", status: "loading" });
  await coordinator.event(1, { type: "updated", status: "complete", url: `${ORIGIN}/users` });
  await time.advance(500);
  view = await coordinator.request(1, { action: "snapshot", journeyId: id });
  assert.equal(view.currentJourney.frames.length, 2);
  assert.equal(view.currentJourney.frames[0].interaction.label, "Users");
});

test("cross-origin navigation pauses until re-invocation captures the page and resumes", async () => {
  const { coordinator, browser, id } = await recording();
  await coordinator.event(1, { type: "updated", status: "loading" });
  await coordinator.event(1, { type: "updated", status: "complete", url: undefined });
  let view = await coordinator.request(1, { action: "snapshot", journeyId: id });
  assert.equal(view.currentJourney.pauseReason, "navigation");
  browser.page.pathname = "/elsewhere";
  await coordinator.event(1, { type: "invoked", url: "https://other.example.test/elsewhere", windowId: 7 });
  view = await coordinator.request(1, { action: "snapshot", journeyId: id });
  assert.equal(view.currentJourney.state, "Recording");
  assert.equal(view.currentJourney.frames.at(-1).kind, "reentry");
  assert.equal(view.currentJourney.frames.at(-1).pathname, "/elsewhere");
});

test("Manual Capture works in Ready and Stopped without a target or state change", async () => {
  const { coordinator, context } = setup();
  const created = await coordinator.request(1, { action: "new" });
  const id = created.currentJourney.id;
  let view = await coordinator.request(1, { action: "capture", journeyId: id }, context);
  assert.equal(view.currentJourney.state, "Ready");
  assert.equal(view.currentJourney.frames[0].label, "Manual capture");
  assert.equal(view.currentJourney.frames[0].interaction, null);
  await coordinator.request(1, { action: "record", journeyId: id }, context);
  view = await coordinator.request(1, { action: "stop", journeyId: id });
  assert.equal(view.recordingHere, false);
  view = await coordinator.request(1, { action: "capture", journeyId: id }, context);
  assert.equal(view.currentJourney.state, "Stopped");
  view = await coordinator.request(1, { action: "record", journeyId: id }, context);
  assert.equal(view.currentJourney.recordingSegment, 2);
  assert.deepEqual(view.currentJourney.frames.map((frame) => frame.kind), ["manual", "initial", "manual", "initial"]);
});

test("another tab cannot record or capture while a recording is bound elsewhere", async () => {
  const { coordinator, context, id } = await recording(1);
  const other = await coordinator.request(2, { action: "new" });
  assert.equal(other.recordingElsewhere, true);
  assert.equal(other.controls.record, false);
  await assert.rejects(coordinator.request(2, { action: "record", journeyId: other.currentJourney.id }, context), /another tab/);
  await assert.rejects(coordinator.request(2, { action: "capture", journeyId: id }, context), /another tab/);
});

test("a failed screenshot write adds no frame and pauses for storage", async () => {
  const { coordinator, volume, time, id } = await recording();
  volume.failWritesMatching = /\.png$/;
  await coordinator.event(1, click("Settings"));
  await coordinator.event(1, { type: "changed" });
  await time.advance(500);
  volume.failWritesMatching = null;
  const view = await coordinator.request(1, { action: "snapshot", journeyId: id });
  assert.equal(view.currentJourney.frames.length, 1);
  assert.equal(view.currentJourney.pauseReason, "storage");
  assert.match(view.notice, /could not be saved/);
});

test("a capture failure outside the recorded tab reports and does not create a frame", async () => {
  const { coordinator, browser, context } = setup();
  const created = await coordinator.request(1, { action: "new" });
  browser.captureError = new Error("Either the '<all_urls>' or 'activeTab' permission is required.");
  await assert.rejects(coordinator.request(1, { action: "record", journeyId: created.currentJourney.id }, context), /lost access to this page/);
  const view = await coordinator.request(1, { action: "snapshot" });
  assert.equal(view.currentJourney.state, "Ready");
  assert.equal(view.currentJourney.frames.length, 0);
  assert.deepEqual(browser.calls.filter(([name]) => name === "restore"), [["restore", 1]], "the toolbar is restored after a failed capture");
});

test("bindings survive a worker restart and stale Recording states become resumable", async () => {
  const bindings = memoryBindings();
  const volume = createVolume();
  const first = setup({ bindings, volume });
  const created = await first.coordinator.request(1, { action: "new" });
  const id = created.currentJourney.id;
  await first.coordinator.request(1, { action: "record", journeyId: id }, first.context);
  const restarted = setup({ bindings, volume });
  let view = await restarted.coordinator.request(1, { action: "snapshot" });
  assert.equal(view.currentJourney.id, id);
  assert.equal(view.recordingHere, true);
  await restarted.coordinator.event(1, click("After restart"));
  await restarted.coordinator.event(1, { type: "changed" });
  await restarted.time.advance(500);
  view = await restarted.coordinator.request(1, { action: "snapshot" });
  assert.equal(view.currentJourney.frames.length, 2);

  const browserRestart = setup({ volume });
  view = await browserRestart.coordinator.request(5, { action: "open", id });
  assert.equal(view.currentJourney.state, "Paused");
  assert.equal(view.currentJourney.pauseReason, "permission");
  view = await browserRestart.coordinator.request(5, { action: "resume", journeyId: id }, browserRestart.context);
  assert.equal(view.currentJourney.state, "Recording");
  assert.equal(view.currentJourney.frames.at(-1).kind, "reentry");
});

test("closing the recorded tab pauses the Journey and releases the binding", async () => {
  const { coordinator, id } = await recording();
  await coordinator.forgetTab(1);
  const view = await coordinator.request(2, { action: "open", id });
  assert.equal(view.currentJourney.pauseReason, "permission");
  assert.equal(view.recordingElsewhere, false);
  assert.equal(view.controls.resume, true);
});

test("full-page capture stitches scrolled segments and records page-sized metadata", async () => {
  const stitched = [];
  const env = setup({ stitch: async (segments, size) => { stitched.push({ segments, size }); return { blob: new Blob(["stitched"]), width: 200, height: 500 }; } });
  env.browser.page.scrollHeight = 250;
  env.browser.page.scrollWidth = 100;
  const created = await env.coordinator.request(1, { action: "new" });
  const id = created.currentJourney.id;
  await env.coordinator.request(1, { action: "settings", journeyId: id, settings: { captureArea: "fullPage" } });
  const view = await env.coordinator.request(1, { action: "capture", journeyId: id }, env.context);
  const frame = view.currentJourney.frames[0];
  assert.equal(frame.captureArea, "fullPage");
  assert.deepEqual(frame.image, { width: 200, height: 500 });
  assert.deepEqual(frame.viewport, { width: 100, height: 250, scrollX: 0, scrollY: 0, devicePixelRatio: 2 });
  assert.deepEqual(env.browser.calls.filter(([name]) => name === "scroll"), [["scroll", 0, false], ["scroll", 50, true], ["scroll", 100, true], ["scroll", 150, true], ["scroll", 200, true]]);
  assert.deepEqual(stitched[0].segments.map((segment) => segment.scrollY), [0, 50, 100, 150, 200]);
  assert.equal(env.browser.calls.filter(([name]) => name === "capture").length, 1 + stitched[0].segments.length, "viewport first, then each segment");
  assert.equal(env.browser.calls.at(-1)[0], "restore");
});

test("a failed full-page capture keeps the viewport capture and warns", async () => {
  const env = setup({ stitch: async () => { throw Object.assign(new Error("decode failed"), { name: "FullPageError" }); } });
  env.browser.page.scrollHeight = 150;
  env.browser.page.scrollWidth = 100;
  const created = await env.coordinator.request(1, { action: "new" });
  const id = created.currentJourney.id;
  await env.coordinator.request(1, { action: "settings", journeyId: id, settings: { captureArea: "fullPage" } });
  let view = await env.coordinator.request(1, { action: "capture", journeyId: id }, env.context);
  const frame = view.currentJourney.frames[0];
  assert.equal(frame.captureArea, "viewport");
  assert.deepEqual(frame.image, { width: 200, height: 100 });
  assert.deepEqual(frame.viewport.height, 50);
  assert.match(view.notice, /full page could not be captured.*visible part/i);
  env.browser.page.scrollHeight = 5000;
  view = await env.coordinator.request(1, { action: "capture", journeyId: id }, env.context);
  assert.match(view.notice, /too long.*visible part/i);
  assert.equal(view.currentJourney.frames.length, 2);
});

test("switching tabs during a full-page capture never captures the other tab", async () => {
  const env = setup({ stitch: async () => ({ blob: new Blob(["x"]), width: 1, height: 1 }) });
  env.browser.page.scrollHeight = 200;
  env.browser.page.scrollWidth = 100;
  const created = await env.coordinator.request(1, { action: "new" });
  const id = created.currentJourney.id;
  await env.coordinator.request(1, { action: "settings", journeyId: id, settings: { captureArea: "fullPage" } });
  const scrollTo = env.browser.scrollTo;
  env.browser.scrollTo = async (tabId, options) => { if (options.y > 0) env.browser.visible = false; return scrollTo(tabId, options); };
  await assert.rejects(env.coordinator.request(1, { action: "capture", journeyId: id }, env.context), /Return to the recorded tab/);
  assert.equal(env.browser.calls.filter(([name]) => name === "capture").length, 2);
  const view = await env.coordinator.request(1, { action: "snapshot" });
  assert.equal(view.currentJourney.frames.length, 0);
});

test("a capture that hits Chrome's quota waits and retries once", async () => {
  const waits = [];
  const env = setup({ sleep: async (ms) => { waits.push(ms); } });
  const created = await env.coordinator.request(1, { action: "new" });
  let failures = 1;
  const capture = env.browser.captureVisible;
  env.browser.captureVisible = async (tabId) => {
    if (failures-- > 0) throw new Error("This request exceeds the MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND quota.");
    return capture(tabId);
  };
  const view = await env.coordinator.request(1, { action: "capture", journeyId: created.currentJourney.id }, env.context);
  assert.equal(view.currentJourney.frames.length, 1);
  assert.deepEqual(waits, [1000]);
  failures = 2;
  await assert.rejects(env.coordinator.request(1, { action: "capture", journeyId: created.currentJourney.id }, env.context), /limited how often/);
});
