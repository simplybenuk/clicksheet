// Paints opaque boxes over password fields before a capture is persisted
// (FR-009.1). Rectangles arrive in CSS px relative to the captured viewport and
// are scaled to the image, which may use a device pixel ratio above 1.
export async function sanitizeCapture(blob, { masks = [], viewport = {} } = {}, {
  decode = (data) => createImageBitmap(data),
  createCanvas = (width, height) => new OffscreenCanvas(width, height)
} = {}) {
  const bitmap = await decode(blob);
  try {
    const { width, height } = bitmap;
    if (!width || !height) throw new Error("The captured image was empty.");
    const scale = Number.isFinite(viewport.width) && viewport.width > 0 ? width / viewport.width : 1;
    const canvas = createCanvas(width, height);
    const context = canvas.getContext("2d");
    context.drawImage(bitmap, 0, 0);
    context.fillStyle = "#16181d";
    for (const mask of masks) {
      const box = scaleBox(mask, scale, width, height);
      // Pad by a device pixel so anti-aliased field edges cannot leak glyphs.
      if (box) context.fillRect(box.x - 1, box.y - 1, box.width + 2, box.height + 2);
    }
    return { blob: await canvas.convertToBlob({ type: "image/png" }), width, height };
  } finally {
    bitmap.close?.();
  }
}

function scaleBox(mask, scale, maxWidth, maxHeight) {
  const values = [mask?.x, mask?.y, mask?.width, mask?.height];
  if (!values.every(Number.isFinite)) return null;
  const x = Math.max(0, Math.floor(mask.x * scale));
  const y = Math.max(0, Math.floor(mask.y * scale));
  const right = Math.min(maxWidth, Math.ceil((mask.x + mask.width) * scale));
  const bottom = Math.min(maxHeight, Math.ceil((mask.y + mask.height) * scale));
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null;
}
