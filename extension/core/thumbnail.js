import { drawTargetMarker } from "./export-renderer.js";

export const THUMBNAIL_SIZE = Object.freeze({ maxWidth: 240, maxHeight: 140, marker: 0.5 });
// The viewer shows a screenshot at up to this width. Full-page captures stay
// tall and scroll in the viewer.
export const VIEWER_SIZE = Object.freeze({ maxWidth: 2000, maxHeight: 16000, marker: 1 });

// Produce a preview in the extension worker without exposing a path or the
// directory handle to the page. The canonical PNG is never modified; the
// target marker is an overlay drawn only on the preview.
export async function createThumbnail(file, frame = null, { maxWidth, maxHeight, marker } = THUMBNAIL_SIZE) {
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, maxWidth / bitmap.width, maxHeight / bitmap.height);
    const canvas = new OffscreenCanvas(Math.max(1, Math.round(bitmap.width * scale)), Math.max(1, Math.round(bitmap.height * scale)));
    const context = canvas.getContext("2d");
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    if (frame) drawTargetMarker(context, frame, { x: 0, y: 0, width: canvas.width, height: canvas.height }, { size: marker });
    const blob = await canvas.convertToBlob({ type: "image/png" });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = "";
    for (let start = 0; start < bytes.length; start += 0x8000) binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
    return `data:image/png;base64,${btoa(binary)}`;
  } finally { bitmap.close(); }
}
