// Pure planning and stitching for scroll-and-stitch full-page capture (§6.4).
// Every failure is reported so the caller can fall back to a viewport capture
// with a visible warning instead of blocking the Journey.

const MASK_FILL = "#16181d";

export class FullPageError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "FullPageError";
  }
}

const positive = (value) => Number.isFinite(value) && value > 0;

// Scroll offsets (CSS px) that cover the page top to bottom. The last offset is
// clamped to the maximum scroll so no segment asks the browser for a position it
// cannot reach. Only vertical scrolling is stitched: captureVisibleTab returns
// the viewport width, so the stitched width is the viewport width.
export function planFullPage({
  scrollWidth, scrollHeight, viewportWidth, viewportHeight, devicePixelRatio,
  maxSegments = 24, maxCanvasSide = 32767, maxCanvasArea = 268435456
} = {}) {
  if (!positive(viewportWidth) || !positive(viewportHeight) || !positive(devicePixelRatio)
    || !Number.isFinite(scrollWidth) || scrollWidth < 0 || !Number.isFinite(scrollHeight) || scrollHeight < 0) {
    return { ok: false, reason: "The page could not be measured for a full-page capture." };
  }
  const height = Math.max(scrollHeight, viewportHeight);
  const last = Math.max(0, Math.floor(scrollHeight - viewportHeight));
  const count = last === 0 ? 1 : Math.ceil(last / viewportHeight) + 1;
  if (count > maxSegments) return { ok: false, reason: "The page is too long for a full-page capture." };
  // Chrome refuses canvases beyond these limits; check in image pixels.
  const pixelWidth = Math.ceil(viewportWidth * devicePixelRatio);
  const pixelHeight = Math.ceil(height * devicePixelRatio);
  if (pixelHeight > maxCanvasSide || pixelWidth > maxCanvasSide || pixelWidth * pixelHeight > maxCanvasArea) {
    return { ok: false, reason: "The page is too large for a full-page capture." };
  }
  const positions = [];
  for (let y = 0; y < last; y += viewportHeight) positions.push(y);
  positions.push(last);
  return { ok: true, positions, width: viewportWidth, height };
}

// Frame viewport metadata for a stitched image. Target rects on full-page frames
// are recorded in page coordinates, so the scroll offset is zero by definition.
export function fullPageViewport({ width, height, devicePixelRatio }) {
  return { width, height, scrollX: 0, scrollY: 0, devicePixelRatio };
}

// Draws segments in order (later ones overwrite overlap, which is correct since
// the clamped last segment is the only overlapping one), then masks passwords
// from every segment. Throws FullPageError on any failure.
export async function stitchSegments(segments, { width, height, viewportWidth } = {}, {
  decode = (data) => createImageBitmap(data),
  createCanvas = (w, h) => new OffscreenCanvas(w, h)
} = {}) {
  try {
    if (!Array.isArray(segments) || segments.length === 0) throw new Error("No segments were captured.");
    if (!positive(width) || !positive(height) || !positive(viewportWidth)) throw new Error("The page size is invalid.");
    let canvas = null;
    let context = null;
    let scale = 1;
    for (const segment of segments) {
      if (!Number.isFinite(segment?.scrollY)) throw new Error("A segment has no scroll offset.");
      // Decode one at a time so only a single segment bitmap is held in memory.
      const bitmap = await decode(segment.blob);
      try {
        if (!bitmap?.width || !bitmap?.height) throw new Error("A captured segment was empty.");
        if (!canvas) {
          scale = bitmap.width / viewportWidth;
          canvas = createCanvas(Math.round(width * scale), Math.round(height * scale));
          context = canvas.getContext("2d");
        }
        context.drawImage(bitmap, 0, Math.round(segment.scrollY * scale));
      } finally {
        bitmap?.close?.();
      }
    }
    const canvasWidth = canvas.width ?? Math.round(width * scale);
    const canvasHeight = canvas.height ?? Math.round(height * scale);
    context.fillStyle = MASK_FILL;
    for (const segment of segments) {
      for (const mask of segment.masks ?? []) {
        const box = scaleBox(mask, segment.scrollY, scale, canvasWidth, canvasHeight);
        // Pad by a device pixel so anti-aliased field edges cannot leak glyphs.
        if (box) context.fillRect(box.x - 1, box.y - 1, box.width + 2, box.height + 2);
      }
    }
    return { blob: await canvas.convertToBlob({ type: "image/png" }), width: canvasWidth, height: canvasHeight };
  } catch (error) {
    if (error instanceof FullPageError) throw error;
    throw new FullPageError(`Full-page stitching failed: ${error?.message ?? error}`, { cause: error });
  }
}

function scaleBox(mask, offsetY, scale, maxWidth, maxHeight) {
  const values = [mask?.x, mask?.y, mask?.width, mask?.height];
  if (!values.every(Number.isFinite)) return null;
  const x = Math.max(0, Math.floor(mask.x * scale));
  const y = Math.max(0, Math.floor((mask.y + offsetY) * scale));
  const right = Math.min(maxWidth, Math.ceil((mask.x + mask.width) * scale));
  const bottom = Math.min(maxHeight, Math.ceil((mask.y + offsetY + mask.height) * scale));
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null;
}
