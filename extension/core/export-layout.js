// Contact-sheet layout for PNG export. Pure geometry and text so it can be
// tested without a canvas; export-renderer.js draws the result.
//
// Every cell has the same size: a fixed-width image area whose height follows
// the tallest screenshot (capped), then a text block below it. Screenshots are
// contained and centred in the image area, so their aspect ratio is kept.

export const MAX_COLUMNS = 6;
export const DEFAULT_IMAGE_WIDTH = 640;
// Screenshots are drawn at up to their captured width, so zooming into the
// sheet shows as much detail as the capture holds. Wider captures (high
// density screens) are capped to keep the file a sensible size.
export const MAX_IMAGE_WIDTH = 1920;
export const MIN_IMAGE_WIDTH = 240;
export const IMAGE_WIDTH_STEP = 40;
// Full-page captures can be many times taller than wide; beyond this ratio
// they letterbox rather than making every cell in the sheet enormous.
export const MAX_ASPECT = 2;
const FALLBACK_ASPECT = 10 / 16;

// Chrome's canvas limits: longest side and total pixel area.
export const MAX_CANVAS_SIDE = 32767;
export const MAX_CANVAS_AREA = 268435456;

export const COLORS = Object.freeze({
  background: "#f1f3f5",
  card: "#ffffff",
  border: "#d0d5dc",
  imageArea: "#f7f8fa",
  text: "#111827",
  muted: "#4b5563",
  badge: "#1f2937",
  badgeText: "#ffffff",
  marker: "#ff2d78",
  markerOutline: "#ffffff"
});

const LINE_COUNT = 3;

export class ExportTooLargeError extends Error {
  constructor(message = tooLargeMessage(), options) {
    super(message, options);
    this.name = "ExportTooLargeError";
  }
}

function tooLargeMessage(count) {
  const subject = count ? `This Journey's ${count} screenshots are` : "This Journey is";
  return `${subject} too large for the browser to export as one image. Delete some screenshots, then export again.`;
}

// Throws for empty Journeys and for Journeys that cannot fit within the canvas
// limits even at the minimum cell width; nothing is ever silently dropped.
export function layoutContactSheet(frames, options = {}) {
  if (!Array.isArray(frames) || frames.length === 0) {
    throw new Error("Export is unavailable because this Journey has no screenshots.");
  }

  const {
    imageWidth: startWidth = nativeWidth(frames),
    minImageWidth = MIN_IMAGE_WIDTH,
    step = IMAGE_WIDTH_STEP,
    maxSide = MAX_CANVAS_SIDE,
    maxArea = MAX_CANVAS_AREA
  } = options;

  for (let imageWidth = startWidth; imageWidth >= minImageWidth; imageWidth -= step) {
    const layout = layoutAt(frames, imageWidth);

    if (layout.width <= maxSide && layout.height <= maxSide && layout.width * layout.height <= maxArea) {
      return layout;
    }
  }

  throw new ExportTooLargeError(tooLargeMessage(frames.length));
}

function nativeWidth(frames) {
  const widths = frames.map((frame) => frame?.image?.width).filter((width) => Number.isFinite(width) && width > 0);
  const widest = widths.length ? Math.max(...widths) : DEFAULT_IMAGE_WIDTH;
  return Math.max(MIN_IMAGE_WIDTH, Math.min(MAX_IMAGE_WIDTH, Math.round(widest)));
}

function layoutAt(frames, imageWidth) {
  const metrics = metricsFor(imageWidth);
  const { padding, gap, margin, lineHeight, textGap } = metrics;
  // Fewer than six frames use fewer columns, so short Journeys are not padded
  // with empty space; the column count is still six whenever there are six.
  const columns = Math.min(MAX_COLUMNS, frames.length);
  const rows = Math.ceil(frames.length / columns);
  const aspect = Math.min(MAX_ASPECT, Math.max(...frames.map(frameAspect)));
  const imageHeight = Math.round(imageWidth * aspect);
  const cellWidth = imageWidth + padding * 2;
  const cellHeight = padding + imageHeight + textGap + LINE_COUNT * lineHeight + padding;
  const digits = Math.max(2, String(frames.length).length);

  const cells = frames.map((frame, index) => {
    const x = margin + (index % columns) * (cellWidth + gap);
    const y = margin + Math.floor(index / columns) * (cellHeight + gap);
    const imageArea = { x: x + padding, y: y + padding, width: imageWidth, height: imageHeight };
    const size = frameSize(frame);
    return {
      index,
      frame,
      x,
      y,
      width: cellWidth,
      height: cellHeight,
      imageArea,
      // Without stored dimensions the renderer fits the loaded bitmap instead.
      imageBox: size ? containBox(imageArea, size.width, size.height) : { ...imageArea },
      textBox: { x: x + padding, y: imageArea.y + imageHeight + textGap, width: imageWidth, height: LINE_COUNT * lineHeight },
      number: String(index + 1).padStart(digits, "0"),
      lines: frameLines(frame, metrics.maxChars)
    };
  });

  return {
    width: margin * 2 + columns * cellWidth + (columns - 1) * gap,
    height: margin * 2 + rows * cellHeight + (rows - 1) * gap,
    columns,
    rows,
    cellWidth,
    cellHeight,
    imageWidth,
    imageHeight,
    metrics,
    cells
  };
}

// Text scales with the cell so it stays legible relative to the screenshots.
function metricsFor(imageWidth) {
  const fontSize = Math.max(13, Math.round(imageWidth * 0.03));
  return {
    padding: 16,
    gap: 24,
    margin: 32,
    textGap: 12,
    fontSize,
    lineHeight: Math.round(fontSize * 1.45),
    // Conservative average glyph width; the renderer also measures and trims.
    maxChars: Math.max(16, Math.floor(imageWidth / (fontSize * 0.55)))
  };
}

function frameSize(frame) {
  const size = frame?.image ?? frame?.viewport;
  return size?.width > 0 && size?.height > 0 ? size : null;
}

function frameAspect(frame) {
  const size = frameSize(frame);
  return size ? size.height / size.width : FALLBACK_ASPECT;
}

// Largest box with the given aspect ratio that fits `area`, centred in it.
export function containBox(area, width, height) {
  if (!(width > 0 && height > 0)) {
    return { ...area };
  }

  const scale = Math.min(area.width / width, area.height / height);
  const boxWidth = width * scale;
  const boxHeight = height * scale;
  return {
    x: area.x + (area.width - boxWidth) / 2,
    y: area.y + (area.height - boxHeight) / 2,
    width: boxWidth,
    height: boxHeight
  };
}

// Title, pathname, interaction. The number is drawn as a separate badge.
export function frameLines(frame, maxChars = 60) {
  return [
    { role: "title", text: truncate(clean(frame?.title), maxChars) },
    { role: "path", text: truncate(sanitizePathname(frame?.pathname), maxChars) },
    { role: "interaction", text: interactionText(frame, maxChars) }
  ];
}

export function interactionText(frame, maxChars = 60) {
  if (frame?.interaction) {
    const label = clean(frame.interaction.label);
    // Truncate inside the quotes so the closing quote survives.
    return label ? `Click "${truncate(label, Math.max(1, maxChars - 8))}"` : "Click";
  }

  return truncate(clean(frame?.label), maxChars);
}

// Query strings and fragments can carry tokens or personal data (FR-009.7),
// so they are stripped again here even though capture already removes them.
export function sanitizePathname(pathname) {
  if (typeof pathname !== "string") {
    return "";
  }

  let path = pathname.trim();

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) {
    try {
      path = new URL(path).pathname;
    } catch {
      path = path.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, "");
    }
  }

  return clean(path.split(/[?#]/, 1)[0]);
}

export function truncate(text, maxChars) {
  const chars = Array.from(String(text ?? ""));
  return chars.length <= maxChars ? chars.join("") : `${chars.slice(0, Math.max(0, maxChars - 1)).join("").trimEnd()}…`;
}

function clean(value) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}
