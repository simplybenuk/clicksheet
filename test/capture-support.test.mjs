import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeCapture } from "../extension/core/capture-image.js";
import { createRateGate } from "../extension/core/capture-scheduler.js";
import { attachInteraction, buildFrame, sanitizeOrigin, sanitizePathname } from "../extension/core/journey.js";

test("password masks are painted opaquely at device-pixel scale before encoding", async () => {
  const fills = [];
  let closed = false;
  const result = await sanitizeCapture("raw", { masks: [{ x: 10, y: 5, width: 20, height: 8 }, { x: 90, y: 40, width: 50, height: 50 }, { x: NaN }], viewport: { width: 100, height: 50 } }, {
    decode: async () => ({ width: 200, height: 100, close: () => { closed = true; } }),
    createCanvas: (width, height) => ({
      width, height,
      getContext: () => ({ drawImage() {}, set fillStyle(value) { fills.push(["style", value]); }, fillRect: (...box) => fills.push(box) }),
      convertToBlob: async ({ type }) => new Blob(["png"], { type })
    })
  });
  assert.deepEqual(fills, [["style", "#16181d"], [19, 9, 42, 18], [179, 79, 22, 22]]);
  assert.equal(result.width, 200);
  assert.equal(result.blob.type, "image/png");
  assert.equal(closed, true);
});

test("the rate gate spaces every capture path at least 500ms apart", async () => {
  let time = 0;
  const starts = [];
  const gate = createRateGate({ now: () => time, sleep: async (ms) => { time += ms; } });
  await Promise.all([1, 2, 3].map((n) => gate(async () => starts.push([n, time]))));
  assert.deepEqual(starts, [[1, 0], [2, 500], [3, 1000]]);
  await assert.rejects(gate(async () => { throw new Error("capture failed"); }));
  await gate(async () => starts.push([4, time]));
  assert.equal(starts.at(-1)[1] - 1500 >= 500, true);
});

test("frame metadata drops query strings and fragments", () => {
  assert.equal(sanitizePathname("/users?id=7#secret"), "/users");
  assert.equal(sanitizePathname("https://x.test/a/b?c"), "/a/b");
  assert.equal(sanitizePathname(""), "/");
  const frame = buildFrame({ id: "frame-1", kind: "manual", page: { title: "T", pathname: "/p?q=1", viewport: { width: 10, height: 5 } }, image: { width: 20, height: 10 }, capturedAt: "2026-09-26T00:00:00.000Z" });
  assert.equal(frame.pathname, "/p");
  assert.equal(frame.label, "Manual capture");
  assert.equal(frame.screenshotFile, "frame-1.png");
  assert.throws(() => buildFrame({ id: "x", kind: "bogus", image: {} }), /Unknown frame kind/);
});

test("a click is shifted by scroll since the preceding frame and skipped for another page", () => {
  const frame = buildFrame({ id: "frame-1", kind: "initial", page: { pathname: "/a", viewport: { width: 100, height: 50, scrollX: 0, scrollY: 100 } }, image: { width: 100, height: 50 }, capturedAt: "t" });
  const marked = attachInteraction(frame, { rect: { x: 5, y: 10, width: 4, height: 3 }, point: { x: 6, y: 11 }, scrollX: 0, scrollY: 150, label: "  Save  ", pathname: "/a?x" });
  assert.deepEqual(marked.interaction, { type: "click", label: "Save", role: null, tag: null, rect: { x: 5, y: 60, width: 4, height: 3 }, point: { x: 6, y: 61 } });
  assert.equal(attachInteraction(frame, { rect: { x: 1, y: 1, width: 1, height: 1 }, pathname: "/b" }).interaction, null);
});

test("frames keep the page origin, and clicks keep the target's role and tag", () => {
  assert.equal(sanitizeOrigin("https://app.example.com"), "https://app.example.com");
  assert.equal(sanitizeOrigin("https://app.example.com:8443/path?q=1#x"), "https://app.example.com:8443");
  assert.equal(sanitizeOrigin("null"), null);
  assert.equal(sanitizeOrigin("not a url"), null);
  assert.equal(sanitizeOrigin(undefined), null);

  const frame = buildFrame({ id: "frame-1", kind: "initial", page: { origin: "http://127.0.0.1:8080", pathname: "/a", viewport: { width: 100, height: 50 } }, image: { width: 100, height: 50 }, capturedAt: "t" });
  assert.equal(frame.origin, "http://127.0.0.1:8080");
  assert.equal(buildFrame({ id: "f", kind: "manual", page: { pathname: "/" }, image: { width: 1, height: 1 }, capturedAt: "t" }).origin, null);

  const marked = attachInteraction(frame, { rect: { x: 1, y: 1, width: 1, height: 1 }, label: "Add user", role: "button", tag: "button", pathname: "/a" });
  assert.equal(marked.interaction.role, "button");
  assert.equal(marked.interaction.tag, "button");
  const odd = attachInteraction(frame, { rect: { x: 1, y: 1, width: 1, height: 1 }, role: "", tag: "<script>", pathname: "/a" });
  assert.equal(odd.interaction.role, null);
  assert.equal(odd.interaction.tag, null);
  for (const role of ["Pay £40 to Jane", "button ", "a".repeat(41), "menu item"]) {
    assert.equal(attachInteraction(frame, { rect: { x: 1, y: 1, width: 1, height: 1 }, role, pathname: "/a" }).interaction.role, null, role);
  }
  assert.equal(attachInteraction(frame, { rect: { x: 1, y: 1, width: 1, height: 1 }, role: "menuitemcheckbox", pathname: "/a" }).interaction.role, "menuitemcheckbox");
});
