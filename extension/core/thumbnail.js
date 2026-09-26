// Produce a small preview in the extension worker without exposing a path or
// the directory handle to the page. The canonical PNG is never modified.
export async function createThumbnail(file) {
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, 240 / bitmap.width, 140 / bitmap.height);
    const canvas = new OffscreenCanvas(Math.max(1, Math.round(bitmap.width * scale)), Math.max(1, Math.round(bitmap.height * scale)));
    canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await canvas.convertToBlob({ type: "image/png" });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return `data:image/png;base64,${btoa(binary)}`;
  } finally { bitmap.close(); }
}
