// Recording intent only. Capture and storage must succeed in their own adapters;
// these functions never manufacture a frame or claim that a screenshot was saved.
export const JOURNEY_STATE = Object.freeze({
  ready: "Ready",
  recording: "Recording",
  paused: "Paused",
  stopped: "Stopped"
});

const STATES = new Set(Object.values(JOURNEY_STATE));
const PAUSE_REASONS = new Set(["user", "tab", "permission", "storage", "navigation"]);

export function prepareJourney(journey) {
  if (!journey || typeof journey !== "object" || Array.isArray(journey) || !Array.isArray(journey.frames)) {
    throw new TypeError("A Journey must have a frames array.");
  }
  const result = structuredClone(journey);
  result.state ??= JOURNEY_STATE.ready;
  result.recordingSegment ??= 0;
  result.pauseReason ??= null;
  if (!STATES.has(result.state)) throw new TypeError("Invalid Journey state.");
  if (!Number.isSafeInteger(result.recordingSegment) || result.recordingSegment < 0) {
    throw new TypeError("Invalid recording segment.");
  }
  if (result.state === JOURNEY_STATE.paused) {
    if (!PAUSE_REASONS.has(result.pauseReason)) throw new TypeError("A paused Journey needs a pause reason.");
  } else if (result.pauseReason !== null) {
    throw new TypeError("Only a paused Journey can have a pause reason.");
  }
  return result;
}

export function journeyControls(journey, { available = true, captureReady = false } = {}) {
  const current = journey ? prepareJourney(journey) : null;
  const state = current?.state ?? JOURNEY_STATE.ready;
  const idle = state === JOURNEY_STATE.ready || state === JOURNEY_STATE.stopped;
  const canCapture = Boolean(current && available && captureReady);
  return {
    record: canCapture && idle,
    pause: Boolean(current && state === JOURNEY_STATE.recording),
    resume: canCapture && state === JOURNEY_STATE.paused,
    stop: Boolean(current && (state === JOURNEY_STATE.recording || state === JOURNEY_STATE.paused)),
    capture: canCapture,
    newJourney: Boolean(available && idle),
    openJourney: Boolean(available && idle),
    rename: Boolean(current)
  };
}

export function transitionJourney(journey, action, details = {}) {
  const next = prepareJourney(journey);
  const controls = journeyControls(next, details);
  const requireControl = (name) => {
    if (!controls[name]) throw new Error(`${action} is unavailable in the current Journey state.`);
  };
  const pause = (reason) => {
    // A tab switch must never turn a user/security/storage pause into an
    // automatically resumable tab pause.
    if (next.state === JOURNEY_STATE.recording ||
        (next.state === JOURNEY_STATE.paused && next.pauseReason === "tab" && reason !== "tab")) {
      next.state = JOURNEY_STATE.paused;
      next.pauseReason = reason;
    }
  };
  switch (action) {
    case "record":
      requireControl("record");
      if (next.recordingSegment === Number.MAX_SAFE_INTEGER) throw new RangeError("Recording segment limit reached.");
      next.state = JOURNEY_STATE.recording;
      next.recordingSegment += 1;
      break;
    case "pause":
      requireControl("pause");
      pause("user");
      break;
    case "resume":
      requireControl("resume");
      next.state = JOURNEY_STATE.recording;
      next.pauseReason = null;
      break;
    case "stop":
      requireControl("stop");
      next.state = JOURNEY_STATE.stopped;
      next.pauseReason = null;
      break;
    case "tab-away": pause("tab"); break;
    case "permission-lost": pause("permission"); break;
    case "storage-unavailable": pause("storage"); break;
    case "navigation": pause("navigation"); break;
    case "tab-returned":
      if (next.state === JOURNEY_STATE.paused && next.pauseReason === "tab" && controls.resume) {
        next.state = JOURNEY_STATE.recording;
        next.pauseReason = null;
      }
      break;
    case "capture":
      requireControl("capture");
      break;
    default: throw new TypeError(`Unknown Journey action: ${String(action)}`);
  }
  return next;
}

export const FRAME_KIND = Object.freeze({
  initial: "initial",
  click: "click",
  manual: "manual",
  reentry: "reentry"
});

const FRAME_LABELS = Object.freeze({
  initial: "Start",
  click: "Page change",
  manual: "Manual capture",
  reentry: "Resumed"
});

// Export metadata must never carry query strings or fragments (FR-009.7).
export function sanitizePathname(value) {
  if (typeof value !== "string" || !value) return "/";
  try {
    return new URL(value, "http://clicksheet.invalid").pathname || "/";
  } catch {
    return value.split(/[?#]/)[0] || "/";
  }
}

// Only a real scheme://host[:port] origin is kept; opaque origins ("null")
// and anything that is not an origin become null.
export function sanitizeOrigin(value) {
  if (typeof value !== "string" || !value || value === "null") return null;
  try {
    const { origin } = new URL(value);
    return origin && origin !== "null" ? origin : null;
  } catch {
    return null;
  }
}

// A capture is metadata about already sanitized pixels; it never claims an
// interaction target (manual frames must not, FR-007.3).
export function buildFrame({ id, kind, page, image, capturedAt, segment = 0 }) {
  if (!FRAME_LABELS[kind]) throw new TypeError(`Unknown frame kind: ${String(kind)}`);
  const viewport = page?.viewport ?? {};
  return {
    id,
    screenshotFile: `${id}.png`,
    kind,
    label: FRAME_LABELS[kind],
    title: String(page?.title ?? "").slice(0, 300),
    origin: sanitizeOrigin(page?.origin),
    pathname: sanitizePathname(page?.pathname),
    capturedAt,
    segment,
    image: { width: image.width, height: image.height },
    viewport: {
      width: finite(viewport.width, image.width),
      height: finite(viewport.height, image.height),
      scrollX: finite(viewport.scrollX, 0),
      scrollY: finite(viewport.scrollY, 0),
      devicePixelRatio: finite(viewport.devicePixelRatio, 1)
    },
    interaction: null
  };
}

// Places a qualifying click on the frame that shows the page before it. The
// click was measured against the live page, so it is shifted by any scroll
// since that frame was captured. A frame of another page gets no marker.
export function attachInteraction(frame, click) {
  if (!frame || !click?.rect) return frame;
  if (sanitizePathname(click.pathname) !== frame.pathname) return frame;
  const dx = finite(click.scrollX, 0) - finite(frame.viewport?.scrollX, 0);
  const dy = finite(click.scrollY, 0) - finite(frame.viewport?.scrollY, 0);
  const rect = click.rect;
  return {
    ...frame,
    interaction: {
      type: "click",
      label: String(click.label ?? "").trim().slice(0, 80),
      // A role is an ARIA token, never free page text, since it survives redaction.
      role: typeof click.role === "string" && /^[a-z][a-z-]{0,39}$/.test(click.role) ? click.role : null,
      tag: typeof click.tag === "string" && /^[a-z][a-z0-9-]{0,39}$/.test(click.tag) ? click.tag : null,
      rect: { x: finite(rect.x, 0) + dx, y: finite(rect.y, 0) + dy, width: Math.max(0, finite(rect.width, 0)), height: Math.max(0, finite(rect.height, 0)) },
      point: click.point ? { x: finite(click.point.x, 0) + dx, y: finite(click.point.y, 0) + dy } : null
    }
  };
}

function finite(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}
