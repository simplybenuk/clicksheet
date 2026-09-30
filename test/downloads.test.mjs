import assert from "node:assert/strict";
import test from "node:test";
import { createDownloadsExporter } from "../extension/core/downloads.js";

// A stand-in for chrome.downloads with Chrome's uniquify naming. Files that
// exist on disk from earlier are listed in `existing`.
function fakeChromeDownloads({ existing = [], stall = () => false, removable = () => true, rename = (name) => name } = {}) {
  const files = new Set(existing);
  const items = new Map();
  const listeners = new Set();
  let nextId = 0;
  const api = {
    items,
    files,
    cancelled: [],
    erased: [],
    onChanged: { addListener: (fn) => listeners.add(fn), removeListener: (fn) => listeners.delete(fn) },
    listenerCount: () => listeners.size,
    async download({ filename, conflictAction }) {
      assert.equal(conflictAction, "uniquify");
      const dot = filename.lastIndexOf(".");
      let candidate = filename;
      for (let n = 1; files.has(candidate); n++) candidate = `${filename.slice(0, dot)} (${n})${filename.slice(dot)}`;
      candidate = rename(candidate);
      const id = ++nextId;
      const item = { id, filename: `/home/me/Downloads/${candidate}`, state: "in_progress" };
      items.set(id, item);
      if (!stall(candidate)) {
        files.add(candidate);
        setTimeout(() => {
          item.state = "complete";
          for (const fn of [...listeners]) fn({ id, state: { current: "complete" } });
        }, 0);
      }
      return id;
    },
    async search({ id }) { return items.has(id) ? [{ ...items.get(id) }] : []; },
    async cancel(id) { api.cancelled.push(id); },
    async removeFile(id) {
      const item = items.get(id);
      if (!removable(item)) throw new Error("Download file not found");
      files.delete(item.filename.replace("/home/me/Downloads/", ""));
    },
    async erase({ id }) { api.erased.push(id); items.delete(id); }
  };
  return api;
}

const toDataUrl = async (blob) => `data:,${encodeURIComponent(await blob.text())}`;
const pair = { name: "flow-2026-09-30-1200", image: new Blob(["png"]), context: new Blob(["{}"]) };

test("the context file takes the base name Chrome gave the image", async () => {
  const api = fakeChromeDownloads({ existing: ["Clicksheet/flow-2026-09-30-1200.png"] });
  const saved = await createDownloadsExporter({ api, toDataUrl }).save(pair);
  assert.deepEqual(saved, { downloadId: 1, fileName: "flow-2026-09-30-1200 (1).png", contextFileName: "flow-2026-09-30-1200 (1).json" });
  assert.equal(api.listenerCount(), 0);
});

test("a stray context file with the image's name moves the pair to a name free for both", async () => {
  const api = fakeChromeDownloads({ existing: ["Clicksheet/flow-2026-09-30-1200.json"] });
  const saved = await createDownloadsExporter({ api, toDataUrl }).save(pair);
  assert.equal(saved.fileName, "flow-2026-09-30-1200-2.png");
  assert.equal(saved.contextFileName, "flow-2026-09-30-1200-2.json");
  assert.deepEqual([...api.files].sort(), [
    "Clicksheet/flow-2026-09-30-1200-2.json",
    "Clicksheet/flow-2026-09-30-1200-2.png",
    "Clicksheet/flow-2026-09-30-1200.json"
  ], "the mismatched pair was removed and the older file left alone");
  assert.deepEqual(api.erased.sort(), [1, 2]);
});

test("a mismatched pair that cannot be removed is reported, never presented as a normal save", async () => {
  const api = fakeChromeDownloads({ existing: ["Clicksheet/flow-2026-09-30-1200.json"], removable: () => false });
  await assert.rejects(createDownloadsExporter({ api, toDataUrl }).save(pair),
    /Saved flow-2026-09-30-1200\.png and its context as flow-2026-09-30-1200 \(1\)\.json .* names do not match/);
});

test("with no name free for both after several tries, the save fails with guidance", async () => {
  const existing = ["", "-2", "-3", "-4", "-5"].map((suffix) => `Clicksheet/flow-2026-09-30-1200${suffix}.json`);
  const api = fakeChromeDownloads({ existing });
  await assert.rejects(createDownloadsExporter({ api, toDataUrl }).save(pair), /could not find a name free for both files/);
  assert.deepEqual([...api.files].sort(), existing.sort(), "nothing new is left behind");
});

test("a download that never finishes times out, is cancelled and stops listening", async () => {
  const api = fakeChromeDownloads({ stall: (name) => name.endsWith(".json") });
  const timers = [];
  const exporter = createDownloadsExporter({ api, toDataUrl, timeoutMs: 30000, setTimer: (callback) => timers.push(callback), clearTimer: () => {} });
  const saving = exporter.save(pair);
  while (api.items.size < 2) await new Promise((resolve) => setTimeout(resolve, 1));
  await new Promise((resolve) => setTimeout(resolve, 5));
  timers.at(-1)();
  await assert.rejects(saving, /Saved flow-2026-09-30-1200\.png in Downloads\/Clicksheet, but its context file could not be saved/);
  assert.deepEqual(api.cancelled, [2]);
  assert.equal(api.listenerCount(), 0);
});

test("a timed-out image download names itself in the error", async () => {
  const api = fakeChromeDownloads({ stall: () => true });
  const exporter = createDownloadsExporter({ api, toDataUrl, timeoutMs: 5, setTimer: (callback, ms) => setTimeout(callback, ms) });
  await assert.rejects(exporter.save(pair), /Chrome did not finish saving flow-2026-09-30-1200\.png within 1 second\./);
  assert.deepEqual(api.cancelled, [1]);
  assert.equal(api.listenerCount(), 0);
});

test("names chosen by something other than uniquify are reported as Chrome gave them", async () => {
  let n = 0;
  const api = fakeChromeDownloads({ rename: () => `Clicksheet/guid-${++n}` });
  const saved = await createDownloadsExporter({ api, toDataUrl }).save(pair);
  assert.deepEqual(saved, { downloadId: 1, fileName: "guid-1", contextFileName: "guid-2" });
  assert.equal(api.erased.length, 0, "nothing is removed or retried");
});
