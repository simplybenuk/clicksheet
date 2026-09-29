// Draws a contact-sheet layout onto a canvas and encodes it as PNG. Image
// loading and canvas creation are injected so tests can run without a DOM.

import { COLORS, containBox, ExportTooLargeError, layoutContactSheet } from "./export-layout.js";

export { ExportTooLargeError };

const FONT_FAMILY = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
const PLATFORM_LIMIT_MESSAGE =
  "The browser could not create an export image this large. Delete some screenshots, then export again.";

// `loadBrandIcon` resolves to the Clicksheet icon bitmap. Without it, or if it
// fails, the brand mark is drawn as text only and the export still succeeds.
export async function renderContactSheet(
  journey,
  { loadImage, loadBrandIcon = null, createCanvas = (width, height) => new OffscreenCanvas(width, height), layoutOptions } = {}
) {
  if (typeof loadImage !== "function") {
    throw new TypeError("renderContactSheet needs a loadImage(frame) function.");
  }

  const layout = layoutContactSheet(journey?.frames, { ...layoutOptions, header: headerText(journey) });
  let canvas;
  let ctx;

  // Chrome can refuse large canvases below the documented limits when memory
  // is short; it throws or hands back no context rather than a clear error.
  try {
    canvas = createCanvas(layout.width, layout.height);
    ctx = canvas.getContext("2d");
  } catch (error) {
    throw new ExportTooLargeError(PLATFORM_LIMIT_MESSAGE, { cause: error });
  }

  if (!ctx) {
    throw new ExportTooLargeError(PLATFORM_LIMIT_MESSAGE);
  }

  ctx.fillStyle = COLORS.background;
  ctx.fillRect(0, 0, layout.width, layout.height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";

  await drawHeader(ctx, layout.header, loadBrandIcon);

  // Sequential loading keeps at most one decoded screenshot in memory.
  for (const cell of layout.cells) {
    drawCard(ctx, cell);
    const bitmap = await loadImage(cell.frame);

    try {
      const box = containBox(cell.imageArea, bitmap.width, bitmap.height);
      ctx.drawImage(bitmap, box.x, box.y, box.width, box.height);
      drawTargetMarker(ctx, cell.frame, box);
    } finally {
      bitmap.close?.();
    }

    drawText(ctx, cell, layout.metrics);
  }

  let blob;

  try {
    blob = await canvas.convertToBlob({ type: "image/png" });
  } catch (error) {
    throw new ExportTooLargeError(PLATFORM_LIMIT_MESSAGE, { cause: error });
  }

  if (!blob) {
    throw new ExportTooLargeError(PLATFORM_LIMIT_MESSAGE);
  }

  return blob;
}

export function headerText(journey) {
  return { title: String(journey?.name ?? ""), description: String(journey?.description ?? "") };
}

const baselineIn = (top, lineHeight) => top + Math.round(lineHeight * 0.72);

// Header lines were wrapped by the layout; fillText's maxWidth condenses a
// line with unusually wide glyphs rather than cutting any of it off.
async function drawHeader(ctx, header, loadBrandIcon) {
  if (!header) return;
  const { title, description, brand } = header;

  ctx.fillStyle = COLORS.text;
  ctx.font = `700 ${title.fontSize}px ${FONT_FAMILY}`;
  title.lines.forEach((line, row) => {
    ctx.fillText(line, title.x, baselineIn(title.y + row * title.lineHeight, title.lineHeight), title.width);
  });

  if (description) {
    ctx.fillStyle = COLORS.muted;
    ctx.font = `400 ${description.fontSize}px ${FONT_FAMILY}`;
    description.lines.forEach((line, row) => {
      ctx.fillText(line, description.x, baselineIn(description.y + row * description.lineHeight, description.lineHeight), description.width);
    });
  }

  await drawBrand(ctx, brand, loadBrandIcon);
}

// Right-aligned to the grid: the text is measured, and the icon sits just
// left of it.
async function drawBrand(ctx, brand, loadBrandIcon) {
  const { name, line, iconSize, iconGap } = brand;
  const right = brand.x + brand.width;
  ctx.font = `700 ${name.fontSize}px ${FONT_FAMILY}`;
  const nameWidth = measure(ctx, name.text);
  ctx.font = `400 ${line.fontSize}px ${FONT_FAMILY}`;
  const lineWidth = measure(ctx, line.text);
  const textWidth = Math.min(Math.max(nameWidth, lineWidth), brand.width - iconSize - iconGap);
  const textX = right - textWidth;

  ctx.fillStyle = COLORS.text;
  ctx.font = `700 ${name.fontSize}px ${FONT_FAMILY}`;
  ctx.fillText(name.text, textX, baselineIn(brand.y, name.lineHeight), textWidth);
  ctx.fillStyle = COLORS.muted;
  ctx.font = `400 ${line.fontSize}px ${FONT_FAMILY}`;
  ctx.fillText(line.text, textX, baselineIn(brand.y + name.lineHeight, line.lineHeight), textWidth);

  let icon = null;
  try {
    icon = await loadBrandIcon?.();
  } catch (error) {
    console.warn("Clicksheet exported without its icon because the icon could not be loaded.", error?.message);
  }
  if (!icon) return;
  try {
    ctx.drawImage(icon, textX - iconGap - iconSize, brand.y, iconSize, iconSize);
  } finally {
    icon.close?.();
  }
}

function drawCard(ctx, cell) {
  ctx.fillStyle = COLORS.card;
  ctx.fillRect(cell.x, cell.y, cell.width, cell.height);
  ctx.strokeStyle = COLORS.border;
  ctx.lineWidth = 1;
  ctx.strokeRect(cell.x + 0.5, cell.y + 0.5, cell.width - 1, cell.height - 1);
  ctx.fillStyle = COLORS.imageArea;
  const area = cell.imageArea;
  ctx.fillRect(area.x, area.y, area.width, area.height);
}

function drawText(ctx, cell, { fontSize, lineHeight }) {
  const { x, y, width } = cell.textBox;
  const baseline = (row) => y + row * lineHeight + Math.round(lineHeight * 0.72);

  ctx.font = `700 ${fontSize}px ${FONT_FAMILY}`;
  const badgePadding = Math.round(fontSize * 0.4);
  const badgeWidth = measure(ctx, cell.number) + badgePadding * 2;
  ctx.fillStyle = COLORS.badge;
  ctx.fillRect(x, y + 1, badgeWidth, lineHeight - 2);
  ctx.fillStyle = COLORS.badgeText;
  ctx.fillText(cell.number, x + badgePadding, baseline(0));

  const [title, path, interaction] = cell.lines;
  const titleX = x + badgeWidth + badgePadding;
  ctx.fillStyle = COLORS.text;
  ctx.font = `600 ${fontSize}px ${FONT_FAMILY}`;
  ctx.fillText(fitText(ctx, title.text, x + width - titleX), titleX, baseline(0));
  ctx.fillStyle = COLORS.muted;
  ctx.font = `400 ${fontSize}px ${FONT_FAMILY}`;
  ctx.fillText(fitText(ctx, path.text, width), x, baseline(1));
  ctx.fillStyle = COLORS.text;
  ctx.fillText(fitText(ctx, interaction.text, width), x, baseline(2));
}

function measure(ctx, text) {
  return ctx.measureText ? ctx.measureText(text).width : text.length * 8;
}

// The layout truncates by character count; measured trimming catches wide
// glyphs so text never runs past the card.
function fitText(ctx, text, maxWidth) {
  if (!text || measure(ctx, text) <= maxWidth) {
    return text;
  }

  const chars = Array.from(text.replace(/…$/, ""));

  while (chars.length && measure(ctx, `${chars.join("").trimEnd()}…`) > maxWidth) {
    chars.pop();
  }

  return `${chars.join("").trimEnd()}…`;
}

// Outlines the clicked target and marks the click point on the frame that
// owns the interaction. Stroke only, so the target itself stays readable.
// `imageBox` is where the screenshot was drawn; coordinates are CSS px.
// `size` scales stroke widths and the click ring: 1 for export cells, smaller
// for toolbar previews where full-size strokes would hide the target.
export function drawTargetMarker(ctx, frame, imageBox, { size = 1 } = {}) {
  const interaction = frame?.interaction;
  const viewportWidth = frame?.viewport?.width;

  if (!interaction || !(viewportWidth > 0)) {
    return false;
  }

  // Image px per CSS px is image.width / viewport.width, and the image is
  // drawn at imageBox.width, so CSS px map straight to the box width.
  const scale = imageBox.width / viewportWidth;
  const { rect, point } = interaction;

  ctx.save();
  ctx.beginPath();
  ctx.rect(imageBox.x, imageBox.y, imageBox.width, imageBox.height);
  ctx.clip();

  if (rect && rect.width > 0 && rect.height > 0) {
    const x = imageBox.x + rect.x * scale;
    const y = imageBox.y + rect.y * scale;
    const width = rect.width * scale;
    const height = rect.height * scale;
    ctx.strokeStyle = COLORS.markerOutline;
    ctx.lineWidth = 5 * size;
    ctx.strokeRect(x, y, width, height);
    ctx.strokeStyle = COLORS.marker;
    ctx.lineWidth = 3 * size;
    ctx.strokeRect(x, y, width, height);
  }

  if (point && Number.isFinite(point.x) && Number.isFinite(point.y)) {
    const x = imageBox.x + point.x * scale;
    const y = imageBox.y + point.y * scale;
    ctx.beginPath();
    ctx.arc(x, y, 7 * size, 0, Math.PI * 2);
    ctx.strokeStyle = COLORS.markerOutline;
    ctx.lineWidth = 5 * size;
    ctx.stroke();
    ctx.strokeStyle = COLORS.marker;
    ctx.lineWidth = 3 * size;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, y, 2 * size, 0, Math.PI * 2);
    ctx.fillStyle = COLORS.marker;
    ctx.fill();
  }

  ctx.restore();
  return true;
}
