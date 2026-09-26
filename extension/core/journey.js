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
