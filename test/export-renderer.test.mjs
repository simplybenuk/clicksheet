import assert from "node:assert/strict";
import test from "node:test";

import { layoutContactSheet } from "../extension/core/export-layout.js";
import { BRAND_LINE, BRAND_NAME } from "../extension/core/export-layout.js";
import { drawTargetMarker, ExportTooLargeError, headerText, renderContactSheet } from "../extension/core/export-renderer.js";

// Records every canvas call so tests can check what was drawn and in which order.
function fakeContext() {
  const ops = [];
  const target = { ops, measureText: (text) => ({ width: text.length * 8 }) };
  return new Proxy(target, {
    get(object, key) {
      if (key in object) return object[key];
      return (...args) => ops.push({ op: key, args, strokeStyle: object.strokeStyle });
    },
    set(object, key, value) {
      object[key] = value;
      return true;
    }
  });
}

function fakeCanvas({ failConvert = false } = {}) {
  const canvases = [];
  const createCanvas = (width, height) => {
    const ctx = fakeContext();
    const canvas = {
      width,
      height,
      ctx,
      getContext: (type) => (type === "2d" ? ctx : null),
      convertToBlob: async (options) => {
        if (failConvert) throw new DOMException("Encoding failed", "EncodingError");
        return new Blob(["png"], { type: options.type });
      }
    };
    canvases.push(canvas);
    return canvas;
  };
  return { canvases, createCanvas };
}

function frame(index, extra = {}) {
  return {
    id: `frame-${index}`,
    screenshotFile: `frame-${index}.png`,
    kind: "click",
    label: "Page change",
    title: `Page ${index}`,
    pathname: `/p/${index}`,
    image: { width: 2560, height: 1440 },
    viewport: { width: 1280, height: 720, scrollX: 0, scrollY: 0, devicePixelRatio: 2 },
    interaction: null,
    ...extra
  };
}

const click = { type: "click", label: "Save", rect: { x: 100, y: 50, width: 200, height: 40 }, point: { x: 200, y: 70 } };

function bitmapLoader() {
  const loaded = [];
  let open = 0;
  let maxOpen = 0;
  const loadImage = async (frame) => {
    open += 1;
    maxOpen = Math.max(maxOpen, open);
    const bitmap = {
      id: frame.id,
      width: frame.image?.width ?? 800,
      height: frame.image?.height ?? 600,
      closed: false,
      close() { this.closed = true; open -= 1; }
    };
    loaded.push(bitmap);
    return bitmap;
  };
  return { loaded, loadImage, maxOpen: () => maxOpen };
}

// Splits recorded calls into the stretch that follows each drawImage.
function segments(ops) {
  const result = [];
  for (const entry of ops) {
    if (entry.op === "drawImage") result.push([entry]);
    else result.at(-1)?.push(entry);
  }
  return result;
}

test("every frame is drawn in order, one bitmap at a time, and closed", async () => {
  const journey = { name: "Flow", frames: Array.from({ length: 8 }, (_, i) => frame(i + 1)) };
  const { canvases, createCanvas } = fakeCanvas();
  const images = bitmapLoader();

  const blob = await renderContactSheet(journey, { loadImage: images.loadImage, createCanvas });

  assert.equal(blob.type, "image/png");
  const [canvas] = canvases;
  const layout = layoutContactSheet(journey.frames, { header: headerText(journey) });
  assert.equal(canvas.width, layout.width);
  assert.equal(canvas.height, layout.height);

  const draws = canvas.ctx.ops.filter((entry) => entry.op === "drawImage");
  assert.deepEqual(draws.map((entry) => entry.args[0].id), journey.frames.map((f) => f.id));
  draws.forEach((entry, index) => {
    const box = layout.cells[index].imageBox;
    assert.deepEqual(entry.args.slice(1), [box.x, box.y, box.width, box.height]);
  });
  assert.ok(images.loaded.every((bitmap) => bitmap.closed));
  assert.equal(images.maxOpen(), 1);

  const text = canvas.ctx.ops.filter((entry) => entry.op === "fillText").map((entry) => entry.args[0]);
  assert.ok(text.includes("01") && text.includes("08"));
  assert.ok(text.includes("Page 3") && text.includes("/p/3"));
});

test("the target marker is drawn only on frames with an interaction", async () => {
  const journey = { name: "Flow", frames: [frame(1, { interaction: click }), frame(2), frame(3, { interaction: click })] };
  const { canvases, createCanvas } = fakeCanvas();
  await renderContactSheet(journey, { loadImage: bitmapLoader().loadImage, createCanvas });

  const marked = segments(canvases[0].ctx.ops).map((ops) => ops.some((entry) => entry.op === "clip"));
  assert.deepEqual(marked, [true, false, true]);
});

test("frames without stored sizes use the bitmap dimensions", async () => {
  const journey = { name: "Old", frames: [frame(1, { image: undefined, viewport: undefined, interaction: click })] };
  const { canvases, createCanvas } = fakeCanvas();
  await renderContactSheet(journey, { loadImage: bitmapLoader().loadImage, createCanvas });

  const [draw] = canvases[0].ctx.ops.filter((entry) => entry.op === "drawImage");
  const [, , , width, height] = draw.args;
  assert.ok(Math.abs(width / height - 800 / 600) < 1e-9);
  // No viewport means the click cannot be mapped, so no marker.
  assert.equal(canvases[0].ctx.ops.some((entry) => entry.op === "clip"), false);
});

test("the marker is scaled from CSS pixels into the image box", () => {
  const ctx = fakeContext();
  const box = { x: 10, y: 20, width: 640, height: 360 };

  assert.equal(drawTargetMarker(ctx, frame(1, { interaction: click }), box), true);

  const outlines = ctx.ops.filter((entry) => entry.op === "strokeRect");
  assert.equal(outlines.length, 2);
  for (const outline of outlines) {
    assert.deepEqual(outline.args, [10 + 50, 20 + 25, 100, 20]);
  }
  const point = ctx.ops.find((entry) => entry.op === "arc");
  assert.deepEqual(point.args.slice(0, 2), [10 + 100, 20 + 35]);
  assert.equal(ctx.ops.some((entry) => entry.op === "fillRect"), false);
  assert.equal(drawTargetMarker(fakeContext(), frame(2), box), false);
});

test("platform canvas failures become actionable export errors", async () => {
  const journey = { name: "Flow", frames: [frame(1)] };
  const loadImage = bitmapLoader().loadImage;
  const isTooLarge = (error) => error instanceof ExportTooLargeError && /Delete some screenshots/.test(error.message);

  await assert.rejects(
    renderContactSheet(journey, { loadImage, createCanvas: () => { throw new RangeError("too big"); } }),
    isTooLarge
  );
  await assert.rejects(
    renderContactSheet(journey, { loadImage, createCanvas: () => ({ getContext: () => null }) }),
    isTooLarge
  );
  await assert.rejects(
    renderContactSheet(journey, { loadImage, createCanvas: fakeCanvas({ failConvert: true }).createCanvas }),
    isTooLarge
  );
});

test("bitmaps are closed even when drawing fails", async () => {
  const images = bitmapLoader();
  const createCanvas = (width, height) => {
    const canvas = fakeCanvas().createCanvas(width, height);
    canvas.ctx.drawImage = () => { throw new Error("decode failed"); };
    return canvas;
  };
  await assert.rejects(renderContactSheet({ frames: [frame(1)] }, { loadImage: images.loadImage, createCanvas }), /decode failed/);
  assert.equal(images.loaded[0].closed, true);
});

const drawnText = (canvas) => canvas.ctx.ops.filter((entry) => entry.op === "fillText").map((entry) => entry.args[0]);

test("the header title, description and brand mark are drawn before the first screenshot", async () => {
  const journey = { name: "Create a new user", description: "Add a teammate from Settings.", frames: [frame(1), frame(2)] };
  const { canvases, createCanvas } = fakeCanvas();
  const icon = { width: 128, height: 128, closed: false, close() { this.closed = true; } };
  await renderContactSheet(journey, { loadImage: bitmapLoader().loadImage, loadBrandIcon: async () => icon, createCanvas });

  const ops = canvases[0].ctx.ops;
  const firstFrame = ops.findIndex((entry) => entry.op === "drawImage" && entry.args[0].id === "frame-1");
  const beforeFrames = ops.slice(0, firstFrame);
  const text = beforeFrames.filter((entry) => entry.op === "fillText").map((entry) => entry.args[0]);
  assert.deepEqual(text, ["Create a new user", "Add a teammate from Settings.", BRAND_NAME, BRAND_LINE]);
  const iconDraw = beforeFrames.find((entry) => entry.op === "drawImage");
  assert.equal(iconDraw.args[0], icon);
  assert.equal(icon.closed, true);

  // The icon sits left of the brand text, inside the brand box.
  const { brand } = layoutContactSheet(journey.frames, { header: headerText(journey) }).header;
  const brandText = beforeFrames.find((entry) => entry.op === "fillText" && entry.args[0] === BRAND_NAME);
  assert.ok(iconDraw.args[1] >= brand.x);
  assert.ok(iconDraw.args[1] + iconDraw.args[3] <= brandText.args[1]);
});

test("a failed icon load still exports, with the text brand mark", async () => {
  const journey = { name: "Flow", frames: [frame(1)] };
  const { canvases, createCanvas } = fakeCanvas();
  const warn = console.warn;
  console.warn = () => {};
  try {
    const blob = await renderContactSheet(journey, {
      loadImage: bitmapLoader().loadImage,
      loadBrandIcon: async () => { throw new Error("missing icon"); },
      createCanvas
    });
    assert.equal(blob.type, "image/png");
  } finally {
    console.warn = warn;
  }
  const text = drawnText(canvases[0]);
  assert.ok(text.includes(BRAND_NAME) && text.includes(BRAND_LINE));
  assert.equal(canvases[0].ctx.ops.filter((entry) => entry.op === "drawImage").length, 1);
});

test("empty Journeys are rejected before any image is loaded", async () => {
  const images = bitmapLoader();
  await assert.rejects(
    renderContactSheet({ name: "Empty", frames: [] }, { loadImage: images.loadImage, createCanvas: fakeCanvas().createCanvas }),
    /no screenshots/
  );
  assert.equal(images.loaded.length, 0);
});
