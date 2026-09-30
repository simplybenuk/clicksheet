// The machine-readable companion to a contact sheet (spec journey-context-
// export FR-C2). Pure: it describes the layout the sheet was drawn with, so
// step numbers and boxes match the PNG exactly.

import { sanitizePathname } from "./export-layout.js";
import { interactionBox, interactionScale, visibleInteractionName } from "./interaction-name.js";

export { hiddenByRedaction } from "./interaction-name.js";

export const CONTEXT_FORMAT = "clicksheet-context";
export const CONTEXT_VERSION = 1;

export function buildContext(journey, layout, { exportedAt, version }) {
  const frames = layout.cells.map((cell) => cell.frame);
  const times = frames.map((frame) => Date.parse(frame?.capturedAt));
  const known = times.filter(Number.isFinite);
  const start = known.length ? Math.min(...known) : NaN;

  return {
    format: CONTEXT_FORMAT,
    version: CONTEXT_VERSION,
    generator: { name: "Clicksheet", version: String(version ?? "") },
    journey: {
      title: String(journey?.name ?? ""),
      description: String(journey?.description ?? ""),
      exportedAt,
      stepCount: frames.length
    },
    sheet: { width: layout.width, height: layout.height },
    steps: layout.cells.map((cell, index) => {
      const frame = cell.frame ?? {};
      const at = times[index];
      const previous = times[index - 1];
      return {
        number: index + 1,
        kind: frame.kind ?? null,
        label: frame.label ?? null,
        page: {
          title: String(frame.title ?? ""),
          origin: typeof frame.origin === "string" ? frame.origin : null,
          pathname: sanitizePathname(frame.pathname) || "/"
        },
        capturedAt: frame.capturedAt ?? null,
        // In sheet order, so a reordered step can have a negative gap.
        sincePreviousMs: index === 0 ? (Number.isFinite(at) ? 0 : null) : Number.isFinite(at) && Number.isFinite(previous) ? at - previous : null,
        sinceStartMs: Number.isFinite(at) && Number.isFinite(start) ? at - start : null,
        recordingSegment: Number.isInteger(frame.segment) ? frame.segment : null,
        captureArea: frame.captureArea ?? null,
        viewport: frame.viewport ? { ...frame.viewport } : null,
        redacted: Boolean(frame.redacted),
        sheetBox: roundBox(cell.imageBox),
        interaction: describeInteraction(frame)
      };
    })
  };
}

// Box and point are converted from CSS px (as captured) to screenshot px, the
// space redaction boxes are stored in. The accessible name is dropped when a
// redaction box may cover the target (FR-C2.3); the sheet caption follows the
// same rule.
function describeInteraction(frame) {
  const interaction = frame.interaction;
  if (!interaction) return null;
  const scale = interactionScale(frame);
  const box = interactionBox(frame);
  const point = interaction.point && Number.isFinite(interaction.point.x) && Number.isFinite(interaction.point.y)
    ? { x: Math.round(interaction.point.x * scale), y: Math.round(interaction.point.y * scale) }
    : null;
  return {
    type: interaction.type ?? "click",
    name: visibleInteractionName(frame) || null,
    // Checked again here so a frame stored with free text as its role never
    // exports it.
    role: typeof interaction.role === "string" && /^[a-z][a-z-]{0,39}$/.test(interaction.role) ? interaction.role : null,
    tag: interaction.tag ?? null,
    box: box ? roundBox(box) : null,
    point
  };
}

function roundBox(box) {
  return { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) };
}
