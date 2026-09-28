import assert from "node:assert/strict";
import test from "node:test";

import { applyMasks } from "../extension/core/redaction.js";

function fakeEnvironment({ width = 100, height = 60 } = {}) {
  const log = { closed: 0, fills: [], drawn: [], canvases: [], converted: [] };
  const bitmap = { width, height, close: () => { log.closed += 1; } };
  const decode = async (blob) => {
    log.decoded = blob;
    return bitmap;
  };
  const createCanvas = (canvasWidth, canvasHeight) => {
    const context = {
      fillStyle: "",
      drawImage: (image, x, y) => log.drawn.push({ image, x, y }),
      fillRect: (x, y, w, h) => log.fills.push({ x, y, width: w, height: h, fillStyle: context.fillStyle, globalAlpha: context.globalAlpha })
    };
    log.canvases.push({ width: canvasWidth, height: canvasHeight });
    return {
      getContext: () => context,
      convertToBlob: async (options) => {
        log.converted.push(options);
        return new Blob(["png"], { type: options.type });
      }
    };
  };
  return { log, bitmap, options: { decode, createCanvas } };
}

test("applyMasks paints opaque masks in image pixels and returns a PNG", async () => {
  const { log, bitmap, options } = fakeEnvironment();
  const source = new Blob(["source"], { type: "image/png" });
  const result = await applyMasks(source, [
    { x: 10, y: 5, width: 20, height: 10 },
    { x: 90, y: 50, width: 40, height: 40 }
  ], options);

  assert.equal(log.decoded, source);
  assert.deepEqual(log.canvases, [{ width: 100, height: 60 }]);
  assert.deepEqual(log.drawn, [{ image: bitmap, x: 0, y: 0 }]);
  assert.deepEqual(log.fills, [
    { x: 10, y: 5, width: 20, height: 10, fillStyle: "#16181d", globalAlpha: 1 },
    { x: 90, y: 50, width: 10, height: 10, fillStyle: "#16181d", globalAlpha: 1 }
  ]);
  assert.deepEqual(log.converted, [{ type: "image/png" }]);
  assert.equal(result.blob.type, "image/png");
  assert.equal(result.width, 100);
  assert.equal(result.height, 60);
  assert.equal(log.closed, 1);
});

test("applyMasks normalizes negative drags and drops invalid masks", async () => {
  const { log, options } = fakeEnvironment();
  await applyMasks(new Blob([]), [
    { x: 30, y: 30, width: -10, height: -10 },
    { x: Number.NaN, y: 0, width: 5, height: 5 },
    { x: 5, y: 5, width: 1, height: 1 }
  ], options);
  assert.deepEqual(log.fills.map(({ x, y, width, height }) => ({ x, y, width, height })), [
    { x: 20, y: 20, width: 10, height: 10 }
  ]);
});

test("applyMasks throws without valid masks and still closes the bitmap", async () => {
  const empty = fakeEnvironment();
  await assert.rejects(applyMasks(new Blob([]), [], empty.options), /Draw at least one redaction box\./);
  assert.equal(empty.log.decoded, undefined);

  const invalid = fakeEnvironment();
  await assert.rejects(
    applyMasks(new Blob([]), [{ x: 500, y: 500, width: 10, height: 10 }], invalid.options),
    /Draw at least one redaction box\./
  );
  assert.equal(invalid.log.closed, 1);
  assert.equal(invalid.log.fills.length, 0);

  const notArray = fakeEnvironment();
  await assert.rejects(applyMasks(new Blob([]), "masks", notArray.options), /Draw at least one redaction box\./);
});

test("applyMasks closes the bitmap when encoding fails", async () => {
  const { log, options } = fakeEnvironment();
  const createCanvas = (width, height) => {
    const canvas = options.createCanvas(width, height);
    return { ...canvas, convertToBlob: async () => { throw new Error("encode failed"); } };
  };
  await assert.rejects(
    applyMasks(new Blob([]), [{ x: 0, y: 0, width: 10, height: 10 }], { ...options, createCanvas }),
    /encode failed/
  );
  assert.equal(log.closed, 1);
});
