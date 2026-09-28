// DOM-free geometry for manual redaction masks (FR-009.2, FR-009.3). All
// rectangles are integer image pixels: { x, y, width, height }. Shared by the
// editor page and the service worker, which re-normalizes before painting.

export const MIN_MASK_SIZE = 2;
export const MAX_MASKS = 200;
export const HANDLES = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];

// Returns an integer rectangle inside bounds, or null when the input is not
// finite or is smaller than MIN_MASK_SIZE after clamping. Negative sizes (from
// dragging up or left) are flipped. Edges round outward so a mask never covers
// fewer pixels than the user drew.
export function normalizeMask(rect, bounds) {
  const limits = readBounds(bounds);
  const values = [rect?.x, rect?.y, rect?.width, rect?.height];
  if (!limits || !values.every(Number.isFinite)) return null;

  const [x, y, width, height] = values;
  const left = clamp(Math.floor(Math.min(x, x + width)), 0, limits.width);
  const right = clamp(Math.ceil(Math.max(x, x + width)), 0, limits.width);
  const top = clamp(Math.floor(Math.min(y, y + height)), 0, limits.height);
  const bottom = clamp(Math.ceil(Math.max(y, y + height)), 0, limits.height);

  if (right - left < MIN_MASK_SIZE || bottom - top < MIN_MASK_SIZE) return null;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export function normalizeMasks(masks, bounds) {
  if (!Array.isArray(masks)) return [];
  const result = [];
  for (const mask of masks) {
    const normalized = normalizeMask(mask, bounds);
    if (normalized) result.push(normalized);
    if (result.length >= MAX_MASKS) break;
  }
  return result;
}

// Moves a mask by whole pixels, keeping its size and stopping at the edges.
export function moveMask(mask, dx, dy, bounds) {
  const box = normalizeMask(mask, bounds);
  if (!box) return null;
  const limits = readBounds(bounds);
  return {
    ...box,
    x: clamp(box.x + toStep(dx), 0, limits.width - box.width),
    y: clamp(box.y + toStep(dy), 0, limits.height - box.height)
  };
}

// Drags one edge or corner. The opposite edge stays fixed and the mask cannot
// shrink below MIN_MASK_SIZE or cross the image edge.
export function resizeMask(mask, handle, dx, dy, bounds) {
  const box = normalizeMask(mask, bounds);
  if (!box) return null;
  if (!HANDLES.includes(handle)) return box;

  const limits = readBounds(bounds);
  let left = box.x;
  let top = box.y;
  let right = box.x + box.width;
  let bottom = box.y + box.height;
  const stepX = toStep(dx);
  const stepY = toStep(dy);

  if (handle.includes("w")) left = clamp(left + stepX, 0, right - MIN_MASK_SIZE);
  if (handle.includes("e")) right = clamp(right + stepX, left + MIN_MASK_SIZE, limits.width);
  if (handle.includes("n")) top = clamp(top + stepY, 0, bottom - MIN_MASK_SIZE);
  if (handle.includes("s")) bottom = clamp(bottom + stepY, top + MIN_MASK_SIZE, limits.height);

  return { x: left, y: top, width: right - left, height: bottom - top };
}

// Finds the topmost (last drawn) mask under a point. Handles extend
// handleSize / 2 around each corner and edge, including slightly outside the
// mask, and take priority over moving that mask.
export function hitTest(masks, point, handleSize = 8) {
  if (!Array.isArray(masks) || !Number.isFinite(point?.x) || !Number.isFinite(point?.y)) return null;
  const reach = Number.isFinite(handleSize) && handleSize > 0 ? handleSize / 2 : 0;

  for (let index = masks.length - 1; index >= 0; index -= 1) {
    const mask = masks[index];
    if (![mask?.x, mask?.y, mask?.width, mask?.height].every(Number.isFinite)) continue;

    const left = mask.x;
    const top = mask.y;
    const right = mask.x + mask.width;
    const bottom = mask.y + mask.height;
    const { x, y } = point;
    const withinX = x >= left - reach && x <= right + reach;
    const withinY = y >= top - reach && y <= bottom + reach;
    if (!withinX || !withinY) continue;

    const nearLeft = Math.abs(x - left) <= reach;
    const nearRight = Math.abs(x - right) <= reach;
    const nearTop = Math.abs(y - top) <= reach;
    const nearBottom = Math.abs(y - bottom) <= reach;
    const vertical = nearTop ? "n" : nearBottom ? "s" : "";
    const horizontal = nearLeft ? "w" : nearRight ? "e" : "";
    const handle = vertical + horizontal;

    if (handle) return { index, handle };
    if (x >= left && x <= right && y >= top && y <= bottom) return { index, handle: "move" };
  }
  return null;
}

function readBounds(bounds) {
  const width = Math.floor(bounds?.width);
  const height = Math.floor(bounds?.height);
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  if (width < MIN_MASK_SIZE || height < MIN_MASK_SIZE) return null;
  return { width, height };
}

function toStep(value) {
  return Number.isFinite(value) ? Math.round(value) : 0;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}
