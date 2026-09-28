import assert from "node:assert/strict";
import test from "node:test";
import { FullPageError, fullPageViewport, planFullPage, stitchSegments } from "../extension/core/full-page.js";

const page = (overrides = {}) => ({
  scrollWidth: 1000, scrollHeight: 800, viewportWidth: 1000, viewportHeight: 800, devicePixelRatio: 1, ...overrides
});

test("a page no taller than the viewport needs one segment", () => {
  assert.deepEqual(planFullPage(page()), { ok: true, positions: [0], width: 1000, height: 800 });
  assert.deepEqual(planFullPage(page({ scrollHeight: 300 })).positions, [0]);
  assert.equal(planFullPage(page({ scrollHeight: 300 })).height, 800);
});

test("exact multiples step by the viewport height", () => {
  assert.deepEqual(planFullPage(page({ scrollHeight: 2400 })).positions, [0, 800, 1600]);
});

test("the last position is clamped to the maximum scroll", () => {
  const plan = planFullPage(page({ scrollHeight: 2000 }));
  assert.deepEqual(plan.positions, [0, 800, 1200]);
  assert.equal(plan.height, 2000);
});

test("segment limits and canvas limits fail with a reason", () => {
  const long = planFullPage(page({ scrollHeight: 800 * 25 }));
  assert.equal(long.ok, false);
  assert.match(long.reason, /too long/);
  assert.equal(planFullPage(page({ scrollHeight: 800 * 24 })).ok, true);
  const side = planFullPage(page({ scrollHeight: 20000, maxSegments: 100 }));
  assert.equal(side.ok, true);
  const scaled = planFullPage(page({ scrollHeight: 20000, devicePixelRatio: 2, maxSegments: 100 }));
  assert.equal(scaled.ok, false);
  assert.match(scaled.reason, /too large/);
  const area = planFullPage(page({ scrollHeight: 1600, devicePixelRatio: 2, maxCanvasArea: 2000 * 3200 - 1 }));
  assert.equal(area.ok, false);
  assert.equal(planFullPage(page({ scrollHeight: 1600, devicePixelRatio: 2, maxCanvasArea: 2000 * 3200 })).ok, true);
});

test("invalid measurements are rejected", () => {
  for (const bad of [{ viewportHeight: 0 }, { viewportWidth: -1 }, { devicePixelRatio: NaN }, { scrollHeight: Infinity }, { scrollWidth: undefined }]) {
    const plan = planFullPage(page(bad));
    assert.equal(plan.ok, false);
    assert.equal(typeof plan.reason, "string");
  }
  assert.equal(planFullPage().ok, false);
});

test("full-page viewport metadata uses page coordinates", () => {
  assert.deepEqual(fullPageViewport({ width: 1000, height: 3000, devicePixelRatio: 2 }),
    { width: 1000, height: 3000, scrollX: 0, scrollY: 0, devicePixelRatio: 2 });
});

function fakes({ failOn } = {}) {
  const log = [];
  const closed = [];
  let decoded = 0;
  return {
    log, closed,
    decode: async (blob) => {
      decoded += 1;
      if (blob === failOn) throw new Error("decode failed");
      return { id: blob, width: 2000, height: 1600, close: () => closed.push(blob) };
    },
    createCanvas: (width, height) => {
      log.push(["canvas", width, height]);
      const context = {
        drawImage: (bitmap, x, y) => log.push(["draw", bitmap.id, x, y]),
        fillRect: (...args) => log.push(["fill", context.fillStyle, ...args])
      };
      return {
        width, height, getContext: () => context,
        convertToBlob: async (options) => ({ type: options.type })
      };
    },
    get decoded() { return decoded; }
  };
}

test("stitching draws segments in order at scaled offsets and masks translated passwords", async () => {
  const fake = fakes();
  const result = await stitchSegments([
    { blob: "a", scrollY: 0, masks: [{ x: 10, y: 20, width: 30, height: 5 }] },
    { blob: "b", scrollY: 800, masks: [] },
    { blob: "c", scrollY: 1200, masks: [{ x: 0, y: 790, width: 50, height: 100 }, { x: NaN, y: 0, width: 1, height: 1 }] }
  ], { width: 1000, height: 2000, viewportWidth: 1000 }, fake);
  assert.deepEqual(result, { blob: { type: "image/png" }, width: 2000, height: 4000 });
  assert.deepEqual(fake.log, [
    ["canvas", 2000, 4000],
    ["draw", "a", 0, 0],
    ["draw", "b", 0, 1600],
    ["draw", "c", 0, 2400],
    ["fill", "#16181d", 19, 39, 62, 12],
    // (1200 + 790) * 2 = 3980, clipped at the canvas bottom (4000).
    ["fill", "#16181d", -1, 3979, 102, 22]
  ]);
  assert.deepEqual(fake.closed, ["a", "b", "c"]);
});

test("a failing decode closes decoded bitmaps and throws FullPageError", async () => {
  const fake = fakes({ failOn: "b" });
  await assert.rejects(
    stitchSegments([{ blob: "a", scrollY: 0 }, { blob: "b", scrollY: 800 }, { blob: "c", scrollY: 1600 }],
      { width: 1000, height: 2400, viewportWidth: 1000 }, fake),
    (error) => error instanceof FullPageError && error.name === "FullPageError" && error.cause?.message === "decode failed"
  );
  assert.deepEqual(fake.closed, ["a"]);
  assert.equal(fake.decoded, 2);
});

test("draw and encode failures, empty input, and bad sizes throw FullPageError", async () => {
  const size = { width: 1000, height: 800, viewportWidth: 1000 };
  const closed = [];
  const decode = async () => ({ width: 1000, height: 800, close: () => closed.push(true) });
  const broken = (draw, encode) => () => ({
    width: 1000, height: 800,
    getContext: () => ({ drawImage: draw, fillRect() {} }),
    convertToBlob: encode
  });
  await assert.rejects(stitchSegments([{ blob: 1, scrollY: 0 }], size,
    { decode, createCanvas: broken(() => { throw new Error("draw"); }, async () => ({})) }), FullPageError);
  assert.equal(closed.length, 1);
  await assert.rejects(stitchSegments([{ blob: 1, scrollY: 0 }], size,
    { decode, createCanvas: broken(() => {}, async () => { throw new Error("encode"); }) }), FullPageError);
  await assert.rejects(stitchSegments([], size, { decode }), FullPageError);
  await assert.rejects(stitchSegments([{ blob: 1, scrollY: 0 }], { ...size, viewportWidth: 0 }, { decode }), FullPageError);
});
