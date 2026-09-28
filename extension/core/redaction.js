import { normalizeMasks } from "./mask-editing.js";

export const MASK_COLOR = "#16181d";

// Paints manual redaction masks into a stored screenshot and re-encodes it as
// PNG, so the covered pixels are gone from the saved file (FR-009.4). Masks are
// integer image pixels, already in the image's coordinate space.
export async function applyMasks(blob, masks, {
  decode = (data) => createImageBitmap(data),
  createCanvas = (width, height) => new OffscreenCanvas(width, height)
} = {}) {
  if (!Array.isArray(masks) || masks.length === 0) {
    throw new Error("Draw at least one redaction box.");
  }

  const bitmap = await decode(blob);
  try {
    const { width, height } = bitmap;
    if (!width || !height) throw new Error("The screenshot image was empty.");

    const boxes = normalizeMasks(masks, { width, height });
    if (boxes.length === 0) throw new Error("Draw at least one redaction box.");

    const canvas = createCanvas(width, height);
    const context = canvas.getContext("2d");
    context.drawImage(bitmap, 0, 0);
    context.globalAlpha = 1;
    context.globalCompositeOperation = "source-over";
    context.fillStyle = MASK_COLOR;
    for (const box of boxes) context.fillRect(box.x, box.y, box.width, box.height);

    return { blob: await canvas.convertToBlob({ type: "image/png" }), width, height };
  } finally {
    bitmap.close?.();
  }
}
