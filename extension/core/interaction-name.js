// One redaction rule for every place a clicked element's accessible name is
// shown: the sheet caption, the context file and the widget (spec
// journey-context-export FR-C2.3). Pure, with no imports, so both export
// modules can use it without depending on each other.

// The interaction's box in screenshot pixels, the space redaction boxes are
// stored in. Capture records it in CSS pixels.
export function interactionBox(frame) {
  const rect = frame?.interaction?.rect;
  if (!rect || ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)) return null;
  const scale = interactionScale(frame);
  return { x: rect.x * scale, y: rect.y * scale, width: rect.width * scale, height: rect.height * scale };
}

export function interactionScale(frame) {
  const viewportWidth = frame?.viewport?.width;
  const imageWidth = frame?.image?.width;
  return viewportWidth > 0 && imageWidth > 0 ? imageWidth / viewportWidth : 1;
}

// Fails closed: on a redacted frame the name counts as hidden unless every
// stored box is known and none of them touches a known target box. A frame
// redacted before boxes were stored, or with an empty or damaged list, hides it.
export function hiddenByRedaction(frame, box) {
  if (!frame?.redacted) return false;
  const masks = frame.masks;
  if (!Array.isArray(masks) || masks.length === 0 || !masks.every(knownBox)) return true;
  if (!box || !knownBox(box)) return true;
  // A zero-size target still sits somewhere, so it is tested as one pixel.
  const target = { ...box, width: Math.max(1, box.width), height: Math.max(1, box.height) };
  return masks.some((mask) => overlaps(mask, target));
}

// The clicked element's name as it may be shown, or "" when there is none or
// a redaction box may hide it.
export function visibleInteractionName(frame) {
  const label = frame?.interaction?.label;
  const name = typeof label === "string" ? label.replace(/\s+/g, " ").trim() : "";
  return name && !hiddenByRedaction(frame, interactionBox(frame)) ? name : "";
}

function knownBox(box) {
  return Boolean(box) && [box.x, box.y, box.width, box.height].every(Number.isFinite) && box.width >= 0 && box.height >= 0;
}

function overlaps(a, b) {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}
