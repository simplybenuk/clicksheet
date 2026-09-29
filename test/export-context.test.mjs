import assert from "node:assert/strict";
import test from "node:test";

import { buildContext, CONTEXT_FORMAT, hiddenByRedaction } from "../extension/core/export-context.js";
import { layoutContactSheet } from "../extension/core/export-layout.js";
import { headerText } from "../extension/core/export-renderer.js";

function frame(index, extra = {}) {
  return {
    id: `frame-${index}`,
    screenshotFile: `frame-${index}.png`,
    kind: "click",
    label: "Page change",
    title: `Page ${index}`,
    origin: "https://app.example.com",
    pathname: `/p/${index}`,
    capturedAt: new Date(Date.UTC(2026, 8, 29, 12, 0, index * 2)).toISOString(),
    segment: 1,
    captureArea: "viewport",
    image: { width: 2560, height: 1440 },
    viewport: { width: 1280, height: 720, scrollX: 0, scrollY: 0, devicePixelRatio: 2 },
    interaction: null,
    ...extra
  };
}

const click = (label = "Add user") => ({ type: "click", label, role: "button", tag: "button", rect: { x: 100, y: 50, width: 200, height: 40 }, point: { x: 200, y: 70 } });
const build = (journey) => {
  const layout = layoutContactSheet(journey.frames, { header: headerText(journey) });
  return { layout, context: buildContext(journey, layout, { exportedAt: "2026-09-29T13:00:00.000Z", version: "0.2.0" }) };
};

test("the context numbers steps like the sheet and describes each page, click and timing", () => {
  const journey = {
    name: "Create a new user",
    description: "Add a teammate.",
    frames: [frame(1, { interaction: click() }), frame(2, { pathname: "/p/2?token=secret#x" }), frame(3)]
  };
  const { layout, context } = build(journey);

  assert.equal(context.format, CONTEXT_FORMAT);
  assert.equal(context.version, 1);
  assert.deepEqual(context.generator, { name: "Clicksheet", version: "0.2.0" });
  assert.deepEqual(context.journey, { title: "Create a new user", description: "Add a teammate.", exportedAt: "2026-09-29T13:00:00.000Z", stepCount: 3 });
  assert.deepEqual(context.sheet, { width: layout.width, height: layout.height });
  assert.deepEqual(context.steps.map((step) => step.number), [1, 2, 3]);

  const [first, second] = context.steps;
  assert.deepEqual(first.page, { title: "Page 1", origin: "https://app.example.com", pathname: "/p/1" });
  assert.equal(second.page.pathname, "/p/2");
  assert.deepEqual(first.interaction, {
    type: "click", name: "Add user", role: "button", tag: "button",
    box: { x: 200, y: 100, width: 400, height: 80 }, point: { x: 400, y: 140 }
  });
  assert.equal(second.interaction, null);
  assert.deepEqual(first.sheetBox, {
    x: Math.round(layout.cells[0].imageBox.x), y: Math.round(layout.cells[0].imageBox.y),
    width: Math.round(layout.cells[0].imageBox.width), height: Math.round(layout.cells[0].imageBox.height)
  });

  assert.deepEqual(context.steps.map((step) => step.sincePreviousMs), [0, 2000, 2000]);
  assert.deepEqual(context.steps.map((step) => step.sinceStartMs), [0, 2000, 4000]);
  assert.equal(first.recordingSegment, 1);
  assert.equal(first.captureArea, "viewport");
  assert.equal(first.redacted, false);

  const text = JSON.stringify(context);
  assert.equal(/token|secret|#x|\?/.test(text), false, "no query string or fragment");
  assert.equal(/screenshotFile|frame-1\.png/.test(text), false, "no file names");
});

test("a redaction box over the clicked target removes only its name", () => {
  const covered = frame(1, { interaction: click(), redacted: true, masks: [{ x: 250, y: 90, width: 20, height: 20 }] });
  const elsewhere = frame(2, { interaction: click("Save"), redacted: true, masks: [{ x: 0, y: 1000, width: 50, height: 50 }] });
  const { context } = build({ name: "Flow", frames: [covered, elsewhere] });
  assert.equal(context.steps[0].interaction.name, null);
  assert.equal(context.steps[0].interaction.role, "button");
  assert.equal(context.steps[0].interaction.tag, "button");
  assert.deepEqual(context.steps[0].interaction.box, { x: 200, y: 100, width: 400, height: 80 });
  assert.equal(context.steps[1].interaction.name, "Save");
  assert.equal(context.steps[0].redacted, true);
});

test("frames from before this change export with unknown fields as null", () => {
  const old = frame(1, { interaction: { type: "click", label: "Next", rect: { x: 1, y: 1, width: 5, height: 5 }, point: null } });
  delete old.origin;
  const oldRedacted = frame(2, { interaction: { type: "click", label: "Pay", rect: { x: 1, y: 1, width: 5, height: 5 } }, redacted: true });
  const { context } = build({ name: "Old", frames: [old, oldRedacted] });
  assert.equal(context.steps[0].page.origin, null);
  assert.equal(context.steps[0].interaction.role, null);
  assert.equal(context.steps[0].interaction.tag, null);
  assert.equal(context.steps[0].interaction.name, "Next");
  assert.equal(context.steps[1].interaction.name, null, "redacted before boxes were stored");
});

test("missing timestamps give null timings rather than guesses", () => {
  const { context } = build({ name: "Flow", frames: [frame(1, { capturedAt: undefined }), frame(2)] });
  assert.equal(context.steps[0].sincePreviousMs, null);
  assert.equal(context.steps[0].sinceStartMs, null);
  assert.equal(context.steps[1].sincePreviousMs, null);
  assert.equal(context.steps[1].sinceStartMs, 0);
});

test("zero-size targets under a box are still treated as hidden", () => {
  const base = { redacted: true, masks: [{ x: 10, y: 10, width: 10, height: 10 }] };
  assert.equal(hiddenByRedaction(base, { x: 15, y: 15, width: 0, height: 0 }), true);
  assert.equal(hiddenByRedaction(base, { x: 40, y: 40, width: 0, height: 0 }), false);
  assert.equal(hiddenByRedaction({ redacted: false }, { x: 15, y: 15, width: 1, height: 1 }), false);
});
