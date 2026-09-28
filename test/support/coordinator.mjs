import { createJourneyCoordinator, memoryBindings } from "../../extension/core/journey-coordinator.js";
import { createLibrarySession } from "../../extension/core/library-session.js";
import { createStorage } from "../../extension/core/storage.js";
import { createVolume } from "./memory-fs.mjs";

export const ORIGIN = "https://app.example.test";

export function manualClock() {
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

export async function settle() {
  for (let n = 0; n < 20; n++) await new Promise((done) => setImmediate(done));
}

export function fakeBrowser() {
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
    scrollTo: async (tabId, { y, hideFixed }) => {
      browser.calls.push(["scroll", y, hideFixed]);
      return { scrollY: y, masks: [] };
    },
    inject: async (tabId) => { browser.calls.push(["inject", tabId]); },
    notify: async (tabId) => { browser.calls.push(["notify", tabId]); }
  };
  return browser;
}

export function setup({ bindings = memoryBindings(), volume = createVolume(), browser = fakeBrowser(), ...overrides } = {}) {
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
    schedulerOptions: { now: time.now, setTimer: time.setTimer, clearTimer: time.clearTimer },
    renderSheet: async (journey, loadImage) => {
      const images = [];
      for (const frame of journey.frames) images.push(await loadImage(frame));
      return new Blob([`sheet:${images.join("|")}`], { type: "image/png" });
    },
    decodeImage: async (blob) => blob.text(),
    ...overrides
  };
  const coordinator = createJourneyCoordinator(options);
  const context = { url: `${ORIGIN}/dashboard?token=secret#x`, windowId: 7 };
  return { volume, browser, time, options, coordinator, context };
}

export async function recording(tabId = 1) {
  const env = setup();
  const created = await env.coordinator.request(tabId, { action: "new" });
  const view = await env.coordinator.request(tabId, { action: "record", journeyId: created.currentJourney.id }, env.context);
  return { ...env, id: created.currentJourney.id, view };
}

