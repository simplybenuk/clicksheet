import assert from "node:assert/strict";
import test from "node:test";

import { MAX_MASKS, hitTest, moveMask, normalizeMask, normalizeMasks, resizeMask } from "../extension/core/mask-editing.js";

const bounds = { width: 100, height: 80 };

test("normalizeMask rounds outward to integer image pixels", () => {
  assert.deepEqual(normalizeMask({ x: 10.6, y: 5.2, width: 20.1, height: 9.5 }, bounds), { x: 10, y: 5, width: 21, height: 10 });
});

test("normalizeMask flips negative sizes from dragging up or left", () => {
  assert.deepEqual(normalizeMask({ x: 50, y: 40, width: -20, height: -10 }, bounds), { x: 30, y: 30, width: 20, height: 10 });
  assert.deepEqual(normalizeMask({ x: 50, y: 40, width: 10, height: -15 }, bounds), { x: 50, y: 25, width: 10, height: 15 });
});

test("normalizeMask clamps inside the bounds", () => {
  assert.deepEqual(normalizeMask({ x: -10, y: -5, width: 30, height: 20 }, bounds), { x: 0, y: 0, width: 20, height: 15 });
  assert.deepEqual(normalizeMask({ x: 90, y: 70, width: 50, height: 50 }, bounds), { x: 90, y: 70, width: 10, height: 10 });
  assert.deepEqual(normalizeMask({ x: 10, y: 10, width: -40, height: 5 }, bounds), { x: 0, y: 10, width: 10, height: 5 });
});

test("normalizeMask drops masks smaller than 2x2 after clamping", () => {
  assert.equal(normalizeMask({ x: 10, y: 10, width: 1, height: 20 }, bounds), null);
  assert.equal(normalizeMask({ x: 10, y: 10, width: 20, height: 0 }, bounds), null);
  assert.equal(normalizeMask({ x: 99, y: 10, width: 20, height: 20 }, bounds), null);
  assert.equal(normalizeMask({ x: 200, y: 200, width: 20, height: 20 }, bounds), null);
  assert.deepEqual(normalizeMask({ x: 98, y: 78, width: 20, height: 20 }, bounds), { x: 98, y: 78, width: 2, height: 2 });
});

test("normalizeMask rejects non-finite values and invalid bounds", () => {
  assert.equal(normalizeMask({ x: Number.NaN, y: 0, width: 10, height: 10 }, bounds), null);
  assert.equal(normalizeMask({ x: 0, y: 0, width: Infinity, height: 10 }, bounds), null);
  assert.equal(normalizeMask({ x: "5", y: 0, width: 10, height: 10 }, bounds), null);
  assert.equal(normalizeMask(null, bounds), null);
  assert.equal(normalizeMask({ x: 0, y: 0, width: 10, height: 10 }, { width: Number.NaN, height: 10 }), null);
  assert.equal(normalizeMask({ x: 0, y: 0, width: 10, height: 10 }), null);
});

test("normalizeMasks drops invalid entries and rejects non-arrays", () => {
  assert.deepEqual(normalizeMasks("nope", bounds), []);
  assert.deepEqual(normalizeMasks(null, bounds), []);
  assert.deepEqual(normalizeMasks({ length: 1, 0: { x: 0, y: 0, width: 5, height: 5 } }, bounds), []);
  assert.deepEqual(normalizeMasks([
    { x: 0, y: 0, width: 5, height: 5 },
    null,
    { x: Number.NaN, y: 0, width: 5, height: 5 },
    { x: 3, y: 3, width: 1, height: 1 },
    { x: 20, y: 20, width: -10, height: -10 }
  ], bounds), [
    { x: 0, y: 0, width: 5, height: 5 },
    { x: 10, y: 10, width: 10, height: 10 }
  ]);
});

test("normalizeMasks caps the number of masks", () => {
  const many = Array.from({ length: MAX_MASKS + 50 }, (_, index) => ({ x: index % 90, y: 0, width: 5, height: 5 }));
  assert.equal(MAX_MASKS, 200);
  assert.equal(normalizeMasks(many, bounds).length, 200);
  // Invalid entries do not count toward the cap.
  const mixed = [...Array.from({ length: 10 }, () => null), ...many];
  assert.equal(normalizeMasks(mixed, bounds).length, 200);
});

test("moveMask keeps the size and clamps inside the bounds", () => {
  const mask = { x: 10, y: 10, width: 20, height: 10 };
  assert.deepEqual(moveMask(mask, 5, -3, bounds), { x: 15, y: 7, width: 20, height: 10 });
  assert.deepEqual(moveMask(mask, -50, -50, bounds), { x: 0, y: 0, width: 20, height: 10 });
  assert.deepEqual(moveMask(mask, 500, 500, bounds), { x: 80, y: 70, width: 20, height: 10 });
  assert.deepEqual(moveMask(mask, 2.6, Number.NaN, bounds), { x: 13, y: 10, width: 20, height: 10 });
  assert.equal(moveMask({ x: 0, y: 0, width: 1, height: 1 }, 1, 1, bounds), null);
});

test("resizeMask moves only the dragged edges", () => {
  const mask = { x: 20, y: 20, width: 30, height: 20 };
  assert.deepEqual(resizeMask(mask, "e", 10, 99, bounds), { x: 20, y: 20, width: 40, height: 20 });
  assert.deepEqual(resizeMask(mask, "w", -5, 99, bounds), { x: 15, y: 20, width: 35, height: 20 });
  assert.deepEqual(resizeMask(mask, "n", 99, -10, bounds), { x: 20, y: 10, width: 30, height: 30 });
  assert.deepEqual(resizeMask(mask, "s", 99, 5, bounds), { x: 20, y: 20, width: 30, height: 25 });
  assert.deepEqual(resizeMask(mask, "se", 5, 5, bounds), { x: 20, y: 20, width: 35, height: 25 });
  assert.deepEqual(resizeMask(mask, "nw", -5, -5, bounds), { x: 15, y: 15, width: 35, height: 25 });
  assert.deepEqual(resizeMask(mask, "ne", 5, -5, bounds), { x: 20, y: 15, width: 35, height: 25 });
  assert.deepEqual(resizeMask(mask, "sw", -5, 5, bounds), { x: 15, y: 20, width: 35, height: 25 });
});

test("resizeMask clamps to the bounds and a 2px minimum", () => {
  const mask = { x: 20, y: 20, width: 30, height: 20 };
  assert.deepEqual(resizeMask(mask, "se", 500, 500, bounds), { x: 20, y: 20, width: 80, height: 60 });
  assert.deepEqual(resizeMask(mask, "nw", -500, -500, bounds), { x: 0, y: 0, width: 50, height: 40 });
  assert.deepEqual(resizeMask(mask, "e", -100, 0, bounds), { x: 20, y: 20, width: 2, height: 20 });
  assert.deepEqual(resizeMask(mask, "w", 100, 0, bounds), { x: 48, y: 20, width: 2, height: 20 });
  assert.deepEqual(resizeMask(mask, "n", 0, 100, bounds), { x: 20, y: 38, width: 30, height: 2 });
  assert.deepEqual(resizeMask(mask, "bogus", 10, 10, bounds), mask);
});

test("hitTest prefers the topmost (last) mask", () => {
  const masks = [
    { x: 0, y: 0, width: 50, height: 50 },
    { x: 20, y: 20, width: 50, height: 50 }
  ];
  assert.deepEqual(hitTest(masks, { x: 30, y: 30 }, 4), { index: 1, handle: "move" });
  assert.deepEqual(hitTest(masks, { x: 10, y: 10 }, 4), { index: 0, handle: "move" });
  assert.equal(hitTest(masks, { x: 90, y: 5 }, 4), null);
  assert.equal(hitTest([], { x: 1, y: 1 }), null);
  assert.equal(hitTest(masks, { x: Number.NaN, y: 1 }), null);
});

test("hitTest finds corner and edge handles, including just outside the mask", () => {
  const masks = [{ x: 20, y: 20, width: 40, height: 30 }];
  const cases = [
    [{ x: 20, y: 20 }, "nw"],
    [{ x: 61, y: 19 }, "ne"],
    [{ x: 18, y: 51 }, "sw"],
    [{ x: 60, y: 50 }, "se"],
    [{ x: 40, y: 18 }, "n"],
    [{ x: 40, y: 51 }, "s"],
    [{ x: 21, y: 35 }, "w"],
    [{ x: 62, y: 35 }, "e"],
    [{ x: 40, y: 35 }, "move"]
  ];
  for (const [point, handle] of cases) {
    assert.deepEqual(hitTest(masks, point, 6), { index: 0, handle }, `point ${point.x},${point.y}`);
  }
  assert.equal(hitTest(masks, { x: 40, y: 15 }, 6), null);
});
