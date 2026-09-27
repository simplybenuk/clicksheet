import assert from "node:assert/strict";
import test from "node:test";

import {
  containBox,
  ExportTooLargeError,
  layoutContactSheet,
  MAX_CANVAS_SIDE,
  sanitizePathname
} from "../extension/core/export-layout.js";

function frame(index, { width = 1280, height = 720, ...rest } = {}) {
  return {
    id: `frame-${index}`,
    screenshotFile: `frame-${index}.png`,
    kind: "click",
    label: "Page change",
    title: `Page ${index}`,
    pathname: `/page/${index}`,
    image: { width, height },
    viewport: { width, height, scrollX: 0, scrollY: 0, devicePixelRatio: 1 },
    interaction: null,
    ...rest
  };
}

const frames = (count, options) => Array.from({ length: count }, (_, index) => frame(index + 1, options));

test("thirteen frames are laid out six per row, row-major", () => {
  const layout = layoutContactSheet(frames(13));

  assert.equal(layout.columns, 6);
  assert.equal(layout.rows, 3);
  assert.deepEqual(layout.cells.map((cell) => cell.number), [
    "01", "02", "03", "04", "05", "06", "07", "08", "09", "10", "11", "12", "13"
  ]);

  const positions = layout.cells.map((cell) => [cell.x, cell.y]);
  const xs = [...new Set(positions.map(([x]) => x))];
  const ys = [...new Set(positions.map(([, y]) => y))];
  assert.equal(xs.length, 6);
  assert.equal(ys.length, 3);
  layout.cells.forEach((cell, index) => {
    assert.equal(cell.frame.id, `frame-${index + 1}`);
    assert.equal(cell.x, xs[index % 6]);
    assert.equal(cell.y, ys[Math.floor(index / 6)]);
  });
  assert.ok(xs.every((x, i) => i === 0 || x > xs[i - 1]));
  assert.ok(layout.cells.at(-1).x + layout.cellWidth < layout.width);
  assert.ok(layout.cells.at(-1).y + layout.cellHeight < layout.height);
});

test("short Journeys use one column per frame", () => {
  assert.equal(layoutContactSheet(frames(2)).columns, 2);
  assert.equal(layoutContactSheet(frames(6)).columns, 6);
});

test("numbers grow past two digits when needed", () => {
  const layout = layoutContactSheet(frames(120));
  assert.equal(layout.cells[0].number, "001");
  assert.equal(layout.cells.at(-1).number, "120");
});

test("cells share one size and screenshots keep their aspect ratio", () => {
  const layout = layoutContactSheet([
    frame(1, { width: 1280, height: 720 }),
    frame(2, { width: 800, height: 1200 }),
    frame(3, { width: 1000, height: 9000 })
  ]);

  assert.ok(layout.cells.every((cell) => cell.width === layout.cellWidth && cell.height === layout.cellHeight));
  // The very tall frame is capped at 2:1, so it letterboxes instead of
  // stretching every cell.
  assert.equal(layout.imageHeight, layout.imageWidth * 2);

  for (const cell of layout.cells) {
    const { image } = cell.frame;
    const box = cell.imageBox;
    assert.ok(Math.abs(box.width / box.height - image.width / image.height) < 1e-9);
    assert.ok(box.width <= cell.imageArea.width && box.height <= cell.imageArea.height);
    assert.ok(box.width === cell.imageArea.width || box.height === cell.imageArea.height);
    // Centred in the image area.
    assert.equal(box.x - cell.imageArea.x, cell.imageArea.x + cell.imageArea.width - (box.x + box.width));
    assert.equal(box.y - cell.imageArea.y, cell.imageArea.y + cell.imageArea.height - (box.y + box.height));
  }

  const [landscape, , tall] = layout.cells;
  assert.equal(landscape.imageBox.width, layout.imageWidth);
  assert.equal(tall.imageBox.height, layout.imageHeight);
});

test("image area height follows the tallest frame when it is under the cap", () => {
  const layout = layoutContactSheet(frames(3, { width: 1600, height: 1000 }));
  assert.equal(layout.imageHeight, Math.round(layout.imageWidth * 1000 / 1600));
});

test("frames without stored sizes still lay out", () => {
  const layout = layoutContactSheet([frame(1, { image: undefined, viewport: undefined })]);
  assert.deepEqual(layout.cells[0].imageBox, layout.cells[0].imageArea);
});

test("containBox fits and centres", () => {
  assert.deepEqual(containBox({ x: 10, y: 20, width: 100, height: 100 }, 200, 100), {
    x: 10, y: 45, width: 100, height: 50
  });
  assert.deepEqual(containBox({ x: 0, y: 0, width: 100, height: 100 }, 50, 200), {
    x: 37.5, y: 0, width: 25, height: 100
  });
});

test("card lines show title, sanitized pathname and interaction", () => {
  const [clicked, unlabelled, plain, leaky] = layoutContactSheet([
    frame(1, { interaction: { type: "click", label: "Settings", rect: { x: 0, y: 0, width: 1, height: 1 }, point: { x: 0, y: 0 } } }),
    frame(2, { interaction: { type: "click", label: "  ", rect: null, point: null } }),
    frame(3, { label: "Start" }),
    frame(4, { pathname: "/users/42?token=secret#row-7", title: "  Users\n list " })
  ]).cells;

  assert.deepEqual(clicked.lines.map((line) => line.text), ["Page 1", "/page/1", 'Click "Settings"']);
  assert.equal(unlabelled.lines[2].text, "Click");
  assert.equal(plain.lines[2].text, "Start");
  assert.deepEqual(leaky.lines.slice(0, 2).map((line) => line.text), ["Users list", "/users/42"]);
});

test("pathname sanitizing strips queries, fragments and origins", () => {
  assert.equal(sanitizePathname("/a/b?x=1"), "/a/b");
  assert.equal(sanitizePathname("/a#frag?x"), "/a");
  assert.equal(sanitizePathname("https://example.com/a/b?q=1#h"), "/a/b");
  assert.equal(sanitizePathname(undefined), "");
});

test("long text is truncated with an ellipsis", () => {
  const long = "x".repeat(500);
  const [cell] = layoutContactSheet([
    frame(1, { title: long, pathname: `/${long}`, interaction: { type: "click", label: long } })
  ]).cells;

  for (const line of cell.lines) {
    assert.ok(line.text.length < 200);
  }
  assert.match(cell.lines[0].text, /…$/);
  assert.match(cell.lines[1].text, /…$/);
  assert.match(cell.lines[2].text, /^Click "x+…"$/);
});

test("long Journeys shrink the cells to stay within canvas limits", () => {
  const layout = layoutContactSheet(frames(400));
  assert.ok(layout.imageWidth < 1280);
  assert.ok(layout.imageWidth >= 240);
  assert.ok(layout.height <= MAX_CANVAS_SIDE && layout.width <= MAX_CANVAS_SIDE);
  assert.equal(layout.cells.length, 400);
  assert.equal(layoutContactSheet(frames(13), { imageWidth: 640 }).imageWidth, 640, "an explicit width is honoured");
});

test("the area limit is respected too", () => {
  const layout = layoutContactSheet(frames(60), { maxArea: 15_000_000 });
  assert.ok(layout.width * layout.height <= 15_000_000);
  assert.ok(layout.imageWidth < 1280);
});

test("Journeys too large even at the smallest cell size fail with guidance", () => {
  assert.throws(() => layoutContactSheet(frames(3000)), (error) => {
    assert.ok(error instanceof ExportTooLargeError);
    assert.equal(error.name, "ExportTooLargeError");
    assert.match(error.message, /3000 screenshots/);
    assert.match(error.message, /Delete some screenshots/);
    return true;
  });
});

test("empty Journeys cannot be exported", () => {
  assert.throws(() => layoutContactSheet([]), /no screenshots/);
  assert.throws(() => layoutContactSheet(undefined), /no screenshots/);
});

test("screenshots keep their captured width so zooming shows full detail", () => {
  assert.equal(layoutContactSheet(frames(20)).imageWidth, 1280, "twenty 1280px captures are not downscaled");
  assert.equal(layoutContactSheet(frames(6, { width: 2560, height: 1440 })).imageWidth, 1920, "high-density captures are capped");
  assert.equal(layoutContactSheet(frames(2, { width: 300, height: 200 })).imageWidth, 300);
  assert.equal(layoutContactSheet([{ id: "old", screenshotFile: "old.png" }]).imageWidth, 640, "frames without size fall back to the default");
});
