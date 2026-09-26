import assert from "node:assert/strict";
import test from "node:test";
import { createJourneyCoordinator, memoryBindings } from "../extension/core/journey-coordinator.js";
import { createLibrarySession } from "../extension/core/library-session.js";
import { createStorage } from "../extension/core/storage.js";
import { createVolume } from "./support/memory-fs.mjs";

const ORIGIN = "https://app.example.test";

function manualClock() {
  let time = 0;
  let next = 0;
  const timers = new Map();
  return {
    now: () => time,
    setTimer: (callback, delay) => { const id = ++next; timers.set(id, { at: time + delay, callback }); return id; },
    clearTimer: (id) => timers.delete(id),
    async advance(duration) {
      const end = time + duration;
      while (true) {
        const entry = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!entry) break;
        timers.delete(entry[0]); time = entry[1].at; entry[1].callback();
        await settle();
      }
      time = end;
      await settle();
    }
  };
}

async function settle() {
  for (let n = 0; n < 20; n++) await new Promise((done) => setImmediate(done));
}

function fakeBrowser() {
  const browser = {
    calls: [],
    visible: true,
    captureError: null,
    page: { title: "Dashboard", pathname: "/dashboard", viewport: { width: 100, height: 50, scrollX: 0, scrollY: 0, devicePixelRatio: 2 }, masks: [{ x: 1, y: 2, width: 3, height: 4 }] },
    isVisible: async () => browser.visible,
    prepare: async (tabId) => { browser.calls.push(["prepare", tabId]); return structuredClone(browser.page); },
    restore: async (tabId) => { browser.calls.push(["restore", tabId]); },
    captureVisible: async (tabId) => {
      browser.calls.push(["capture", tabId]);
      if (browser.captureError) throw browser.captureError;
      return new Blob([`pixels of ${browser.page.pathname}`]);
    },
    sanitize: async (blob, page) => { browser.calls.push(["sanitize", page.masks.length]); return { blob, width: 200, height: 100 }; },
    inject: async (tabId) => { browser.calls.push(["inject", tabId]); },
    notify: async (tabId) => { browser.calls.push(["notify", tabId]); }
  };
  return browser;
}

function setup({ bindings = memoryBindings(), volume = createVolume(), browser = fakeBrowser() } = {}) {
  let root = volume.root;
  let nextId = 0;
  const time = manualClock();
  const options = {
    loadRootHandle: async () => root,
    saveRootHandle: async (handle) => { root = handle; },
    sessionFactory: (settings) => createLibrarySession({ ...settings, autosaveOptions: { delayMs: 0 }, storageFactory: (handle, storageOptions) => createStorage(handle, { ...storageOptions, createId: () => `journey-${++nextId}` }) }),
    thumbnail: async (file) => `preview:${await file.text()}`,
    browser,
    bindings,
    createId: () => `id-${++nextId}`,
    now: time.now,
    gate: (task) => task(),
    schedulerOptions: { now: time.now, setTimer: time.setTimer, clearTimer: time.clearTimer }
  };
  const coordinator = createJourneyCoordinator(options);
  const context = { url: `${ORIGIN}/dashboard?token=secret#x`, windowId: 7 };
  return { volume, browser, time, options, coordinator, context };
}

async function recording(tabId = 1) {
  const env = setup();
  const created = await env.coordinator.request(tabId, { action: "new" });
  const view = await env.coordinator.request(tabId, { action: "record", journeyId: created.currentJourney.id }, env.context);
  return { ...env, id: created.currentJourney.id, view };
}

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
  assert.deepEqual(browser.calls.slice(0, 4), [["prepare", 1], ["capture", 1], ["restore", 1], ["sanitize", 1]]);
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
