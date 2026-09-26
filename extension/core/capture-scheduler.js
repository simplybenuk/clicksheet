// One settled automatic capture at a time. The caller qualifies page changes
// and owns sanitized pixels/persistence; no screenshot is produced here.
export function createCaptureScheduler({
  capture, onError = () => {}, delayMs = 500, minIntervalMs = 500,
  now = () => performance.now(), setTimer = setTimeout, clearTimer = clearTimeout
}) {
  if (typeof capture !== "function") throw new TypeError("A capture callback is required.");
  for (const value of [delayMs, minIntervalMs]) {
    if (!Number.isFinite(value) || value < 0 || value > 2147483647) throw new TypeError("Capture timing must be a nonnegative timer duration.");
  }
  // Chrome supports at most two captureVisibleTab calls per second.
  minIntervalMs = Math.max(500, minIntervalMs);
  let enabled = false;
  let pending = null;
  let timer = null;
  let inFlight = false;
  let lastStarted = -Infinity;
  let generation = 0;

  function cancelTimer() {
    if (timer !== null) { clearTimer(timer); timer = null; }
  }
  function arm() {
    cancelTimer();
    if (!enabled || !pending || inFlight) return;
    const wait = Math.max(0, pending.at + delayMs - now(), lastStarted + minIntervalMs - now());
    timer = setTimer(() => { timer = null; void run(); }, wait);
  }
  async function run() {
    if (!enabled || !pending || inFlight) return;
    const item = pending;
    pending = null;
    const runGeneration = generation;
    const isCurrent = () => enabled && generation === runGeneration;
    inFlight = true;
    lastStarted = now();
    try { await capture(item.candidate, { isCurrent }); }
    catch (error) { if (isCurrent()) onError(error); }
    finally { inFlight = false; arm(); }
  }
  return {
    setEnabled(value) {
      if (enabled === Boolean(value)) return;
      enabled = Boolean(value);
      generation += 1;
      if (!enabled) { pending = null; cancelTimer(); }
      else arm();
    },
    offer(candidate, { changed = false } = {}) {
      if (!enabled || !changed) return false;
      pending = { candidate: structuredClone(candidate), at: now() };
      arm();
      return true;
    },
    get busy() { return inFlight; },
    get hasPending() { return pending !== null; }
  };
}
