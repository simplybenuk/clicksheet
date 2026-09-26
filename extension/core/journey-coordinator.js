import { createStorage } from "./storage.js";
import { createThumbnail } from "./thumbnail.js";
import { createLibrarySession } from "./library-session.js";
import {
  attachInteraction,
  buildFrame,
  FRAME_KIND,
  JOURNEY_STATE,
  journeyControls,
  prepareJourney,
  transitionJourney
} from "./journey.js";
import { createCaptureScheduler, createRateGate } from "./capture-scheduler.js";

// A navigation or visible change this long after a click is still attributed to it.
export const CLICK_WINDOW_MS = 2500;
const REENTRY_REASONS = new Set(["permission", "navigation"]);

export class CaptureError extends Error {
  constructor(message, { pauseReason = null, cause } = {}) {
    super(message, { cause });
    this.name = "CaptureError";
    this.pauseReason = pauseReason;
  }
}

// Worker memory is lost when Chrome suspends the service worker, so tab
// bindings live in a store (chrome.storage.session in the extension).
export function memoryBindings(initial = {}) {
  let value = structuredClone(initial);
  return {
    load: async () => structuredClone(value),
    save: async (next) => { value = structuredClone(next); }
  };
}

// Extension-context coordinator. Writes finish before a message is answered,
// so the worker's normal idle suspension cannot interrupt a pending autosave.
// At most one Journey is bound to a recording tab at a time; that tab is the
// only one allowed to record, resume, or capture into it.
export function createJourneyCoordinator({
  loadRootHandle,
  saveRootHandle,
  sessionFactory = createLibrarySession,
  thumbnail = createThumbnail,
  browser = null,
  bindings = memoryBindings(),
  createId = () => crypto.randomUUID(),
  now = () => Date.now(),
  clock = () => new Date().toISOString(),
  gate = createRateGate(),
  schedulerOptions = {}
}) {
  const session = sessionFactory({ loadRootHandle, saveRootHandle });
  const clicks = new Map();
  const notices = new Map();
  let memory = null;
  let scheduler = null;
  let tail = Promise.resolve();

  function enqueue(task) {
    const run = tail.then(task);
    tail = run.catch(() => {});
    return run;
  }

  async function remember() {
    if (!memory) {
      const stored = await bindings.load().catch(() => null);
      memory = { selections: { ...(stored?.selections ?? {}) }, recording: stored?.recording ?? null };
    }
    return memory;
  }

  async function persist() {
    await bindings.save(memory).catch(() => {});
  }

  async function sync() {
    const root = await loadRootHandle();
    if (root) await session.connect(root);
    return { root, view: session.snapshot() };
  }

  function find(view, id) {
    return view.journeys.find((journey) => journey.id === id) ?? null;
  }

  function writeState(journey, frames = journey.frames) {
    session.updateJourney(journey.id, {
      frames,
      state: journey.state,
      pauseReason: journey.pauseReason,
      recordingSegment: journey.recordingSegment
    });
  }

  function stopScheduler() {
    scheduler?.setEnabled(false);
    scheduler = null;
  }

  function startScheduler(delayMs) {
    stopScheduler();
    scheduler = createCaptureScheduler({
      ...schedulerOptions,
      delayMs: Number.isFinite(delayMs) ? delayMs : 500,
      capture: (candidate, token) => enqueue(() => automaticCapture(candidate, token)),
      onError: (error) => notify(memory?.recording?.tabId ?? null, describeCaptureError(error))
    });
    scheduler.setEnabled(true);
  }

  function notify(tabId, text = "") {
    if (!Number.isInteger(tabId)) return;
    if (text) notices.set(tabId, text);
    void browser?.notify?.(tabId)?.catch?.(() => {});
  }

  async function bind(journey, tabId, context) {
    memory.recording = {
      journeyId: journey.id,
      tabId,
      windowId: context.windowId ?? null,
      origin: originOf(context.url),
      delayMs: journey.settings?.captureDelayMs ?? 500
    };
    await persist();
  }

  async function unbind() {
    clicks.clear();
    stopScheduler();
    if (memory.recording) {
      memory.recording = null;
      await persist();
    }
  }

  // Captures the visible tab with the toolbar hidden and password fields
  // masked. Pixels are sanitized before anything reaches storage.
  async function capturePage(tabId, kind, journey) {
    if (!browser) throw new CaptureError("Capture is unavailable in this context.");
    const raw = await gate(async () => {
      if (!(await browser.isVisible(tabId))) {
        throw new CaptureError("Return to the recorded tab to capture it.", { pauseReason: "tab" });
      }
      try {
        const page = await browser.prepare(tabId);
        try {
          return { page, blob: await browser.captureVisible(tabId) };
        } finally {
          await browser.restore(tabId).catch(() => {});
        }
      } catch (error) {
        throw asCaptureError(error);
      }
    });
    const image = await browser.sanitize(raw.blob, raw.page);
    const frame = buildFrame({
      id: `frame-${createId()}`,
      kind,
      page: raw.page,
      image,
      capturedAt: clock(),
      segment: journey.recordingSegment ?? 0
    });
    return { frame, blob: image.blob };
  }

  // The screenshot is written first; a failed write adds no frame.
  async function addFrame(root, journey, captured, { click = null, next = journey } = {}) {
    try {
      await createStorage(root).writeScreenshot(journey.id, captured.frame.screenshotFile, captured.blob);
    } catch (error) {
      await session.refreshAccess();
      throw new CaptureError("The screenshot could not be saved. Reconnect storage to keep capturing.", { pauseReason: "storage", cause: error });
    }
    const frames = [...journey.frames];
    if (click && frames.length) frames[frames.length - 1] = attachInteraction(frames.at(-1), click);
    frames.push(captured.frame);
    writeState(next, frames);
    if (!(await session.flush())) {
      throw new CaptureError("The Journey could not be saved. It is held here until storage is reconnected.", { pauseReason: "storage" });
    }
  }

  async function automaticCapture(candidate, { isCurrent }) {
    const state = await remember();
    const { root, view } = await sync();
    const journey = find(view, candidate.journeyId);
    const bound = state.recording;
    if (!isCurrent() || !root || !journey || !bound || bound.journeyId !== journey.id ||
        bound.tabId !== candidate.tabId || journey.state !== JOURNEY_STATE.recording || !view.editable) return;
    try {
      const captured = await capturePage(candidate.tabId, FRAME_KIND.click, journey);
      if (!isCurrent()) return;
      await addFrame(root, find(session.snapshot(), journey.id), captured, { click: candidate.click });
      notify(candidate.tabId);
    } catch (error) {
      // Report here: pausing invalidates the scheduler token, which would
      // otherwise suppress its error callback.
      notices.set(candidate.tabId, describeCaptureError(error));
      await pauseForError(journey.id, error);
      notify(candidate.tabId);
    }
  }

  async function pauseForError(journeyId, error) {
    const reason = error?.pauseReason;
    if (!reason) return;
    const action = { tab: "tab-away", storage: "storage-unavailable", permission: "permission-lost" }[reason];
    const journey = find(session.snapshot(), journeyId);
    if (!journey || !action) return;
    const next = transitionJourney(journey, action);
    if (next.state !== journey.state || next.pauseReason !== journey.pauseReason) {
      writeState(next);
      await session.flush();
      stopScheduler();
    }
  }

  // A Journey left Recording without a live binding (browser restart, worker
  // data lost) must not pretend to capture. It becomes resumable instead.
  async function reconcile(view, journey) {
    const bound = memory.recording;
    let next = journey;
    if (journey.state === JOURNEY_STATE.recording && bound?.journeyId !== journey.id) {
      next = transitionJourney(journey, "permission-lost");
    } else if (bound?.journeyId === journey.id && view.status === "Storage unavailable") {
      next = transitionJourney(journey, "storage-unavailable");
    }
    if (next !== journey && (next.state !== journey.state || next.pauseReason !== journey.pauseReason)) {
      writeState(next);
      stopScheduler();
    }
  }

  async function execute(tabId, command, context) {
    const state = await remember();
    let { root, view } = await sync();
    let id = command.journeyId ?? state.selections[tabId];
    if (!find(view, id)) id = view.journeys[0]?.id ?? null;
    if (state.selections[tabId] !== id) {
      state.selections[tabId] = id;
      await persist();
    }
    if (command.action === "rename" && command.journeyId !== id) throw new Error("Journey not found. Reopen it before renaming.");
    let current = find(view, id);
    if (current && ["snapshot", "open", "new"].includes(command.action)) {
      await reconcile(view, current);
      view = session.snapshot();
      current = find(view, id);
    }
    const captureReady = Boolean(browser) && (!state.recording || state.recording.tabId === tabId);
    const details = { available: view.editable, captureReady };
    const controls = current ? libraryControls(journeyControls(prepareJourney(current), details), current, tabId, view) : {};

    switch (command.action) {
      case "thumbnail": {
        if (!view.available || !current || current.id !== command.journeyId) throw new Error("Reconnect storage to load this screenshot.");
        const frame = current.frames.find((item) => item.id === command.frameId);
        if (!frame) throw new Error("Screenshot not found.");
        const file = await createStorage(root).readScreenshot(current.id, frame.screenshotFile);
        return { thumbnail: await thumbnail(file, frame) };
      }
      case "new": {
        if (!view.editable || (current && !controls.newJourney)) throw new Error("Finish the recording and reconnect storage before creating a Journey.");
        const created = session.createJourney();
        if (!created) throw new Error("Choose a storage folder first.");
        const model = prepareJourney(created);
        session.updateJourney(created.id, { state: model.state, pauseReason: model.pauseReason, recordingSegment: model.recordingSegment });
        state.selections[tabId] = created.id;
        await persist();
        break;
      }
      case "open":
        if (current && command.id !== current.id && !controls.openJourney) throw new Error("Stop recording before opening another Journey.");
        if (!find(view, command.id)) throw new Error("Journey not found.");
        state.selections[tabId] = command.id;
        await persist();
        break;
      case "rename":
        if (!current || !view.renamable || typeof command.name !== "string") throw new Error("This Journey cannot be renamed now.");
        session.rename(current.id, command.name);
        break;
      case "record": {
        requireJourney(current, controls.record, state, tabId);
        const next = transitionJourney(current, "record", details);
        const captured = await capturePage(tabId, FRAME_KIND.initial, next);
        await addFrame(root, current, captured, { next });
        await bind(next, tabId, context);
        startScheduler(state.recording.delayMs);
        break;
      }
      case "resume": {
        requireJourney(current, controls.resume, state, tabId);
        const next = transitionJourney(current, "resume", details);
        if (REENTRY_REASONS.has(current.pauseReason) || state.recording?.journeyId !== current.id) {
          const captured = await capturePage(tabId, FRAME_KIND.reentry, next);
          await addFrame(root, current, captured, { next });
        } else {
          writeState(next);
        }
        await bind(next, tabId, context);
        startScheduler(state.recording.delayMs);
        break;
      }
      case "pause":
        if (!current || !controls.pause) throw new Error("Pause is unavailable now.");
        writeState(transitionJourney(current, "pause", details));
        clicks.clear();
        stopScheduler();
        break;
      case "stop":
        if (!current || !controls.stop) throw new Error("Stop is unavailable now.");
        writeState(transitionJourney(current, "stop", details));
        if (state.recording?.journeyId === current.id) await unbind();
        break;
      case "capture": {
        requireJourney(current, controls.capture, state, tabId);
        transitionJourney(current, "capture", details);
        const captured = await capturePage(tabId, FRAME_KIND.manual, current);
        await addFrame(root, current, captured);
        break;
      }
      case "snapshot":
        break;
      default:
        throw new Error("Unknown Journey action.");
    }
    if (!["snapshot", "open"].includes(command.action)) {
      const saved = await session.flush();
      if (command.action === "new" && !saved) throw new Error("The new Journey could not be saved. Reconnect storage before trying again.");
    }
    return present(tabId);
  }

  function requireJourney(current, allowed, state, tabId) {
    if (!current) throw new Error("Create or open a Journey first.");
    if (state.recording && state.recording.tabId !== tabId) {
      throw new Error("Clicksheet is recording in another tab. Stop that recording first.");
    }
    if (!allowed) throw new Error("That action is unavailable in the current Journey state. Reconnect storage if it is unavailable.");
  }

  // Another tab may leave a Journey that is recording elsewhere: switching
  // this tab's selection cannot interrupt that recording.
  function libraryControls(controls, journey, tabId, view) {
    const bound = memory.recording;
    if (bound && bound.journeyId === journey.id && bound.tabId !== tabId) {
      return { ...controls, newJourney: view.editable, openJourney: view.editable };
    }
    return controls;
  }

  function present(tabId) {
    const view = session.snapshot();
    const state = memory;
    const selected = find(view, state.selections[tabId]);
    const captureReady = Boolean(browser) && (!state.recording || state.recording.tabId === tabId);
    const notice = notices.get(tabId) ?? "";
    notices.delete(tabId);
    return {
      ...view,
      currentJourney: selected ? prepareJourney(selected) : null,
      controls: selected ? libraryControls(journeyControls(prepareJourney(selected), { available: view.editable, captureReady }), selected, tabId, view) : {},
      recordingHere: state.recording?.tabId === tabId && state.recording.journeyId === selected?.id,
      recordingElsewhere: Boolean(state.recording && state.recording.tabId !== tabId),
      notice,
      // Only summaries go into the popover; frames belong to the selected strip.
      journeys: view.journeys.map(({ id, name }) => ({ id, name }))
    };
  }

  // Page and tab signals. None of them captures directly: automatic frames
  // always go through the scheduler's delay, coalescing, and rate gate.
  async function handleEvent(tabId, event) {
    const state = await remember();
    const bound = state.recording;
    switch (event.type) {
      case "click":
        if (bound?.tabId === tabId && event.click) clicks.set(tabId, { click: event.click, at: now(), navigating: false });
        return;
      case "changed": {
        const pending = recentClick(tabId);
        if (!pending || bound?.tabId !== tabId) return;
        clicks.delete(tabId);
        offer(tabId, pending.click);
        return;
      }
      case "activated":
        if (!bound || (bound.windowId !== null && event.windowId !== bound.windowId)) return;
        await applyToBound(tabId === bound.tabId ? "tab-returned" : "tab-away");
        return;
      case "updated":
        if (bound?.tabId !== tabId) return;
        if (event.status === "loading") {
          const pending = recentClick(tabId);
          if (pending) pending.navigating = true;
          return;
        }
        if (event.status !== "complete") return;
        if (originOf(event.url) !== bound.origin) {
          // Temporary access ends with a cross-origin navigation (FR-005.4).
          clicks.delete(tabId);
          await applyToBound("navigation");
          return;
        }
        await browser?.inject?.(tabId).catch(() => {});
        {
          const pending = clicks.get(tabId);
          clicks.delete(tabId);
          if (pending?.navigating) offer(tabId, pending.click);
        }
        return;
      case "removed":
        if (bound?.tabId !== tabId) return;
        await applyToBound("permission-lost");
        await unbind();
        return;
      case "invoked": {
        if (bound?.tabId !== tabId) return;
        const { view } = await sync();
        const journey = find(view, bound.journeyId);
        if (journey?.state === JOURNEY_STATE.paused && REENTRY_REASONS.has(journey.pauseReason)) {
          // Re-entry captures the current page before continuing (AC-005).
          try {
            await execute(tabId, { action: "resume", journeyId: journey.id }, { url: event.url, windowId: event.windowId ?? bound.windowId });
          } catch (error) {
            notices.set(tabId, error.message);
          }
          notify(tabId);
        }
        return;
      }
      default:
    }
  }

  function recentClick(tabId) {
    const pending = clicks.get(tabId);
    if (pending && now() - pending.at > CLICK_WINDOW_MS) {
      clicks.delete(tabId);
      return null;
    }
    return pending ?? null;
  }

  function offer(tabId, click) {
    const bound = memory.recording;
    if (!bound || bound.tabId !== tabId) return;
    if (!scheduler) startScheduler(bound.delayMs);
    scheduler.offer({ tabId, journeyId: bound.journeyId, click }, { changed: true });
  }

  async function applyToBound(action) {
    const bound = memory.recording;
    const { view } = await sync();
    const journey = find(view, bound.journeyId);
    if (!journey) return;
    const next = transitionJourney(journey, action, { available: view.editable, captureReady: true });
    if (next.state === journey.state && next.pauseReason === journey.pauseReason) return;
    writeState(next);
    await session.flush();
    if (next.state === JOURNEY_STATE.recording) startScheduler(bound.delayMs);
    else {
      clicks.clear();
      stopScheduler();
    }
    notify(bound.tabId);
  }

  return {
    request(tabId, command, context = {}) {
      return enqueue(() => execute(tabId, command ?? {}, context));
    },
    event(tabId, event) {
      return enqueue(() => handleEvent(tabId, event ?? {}));
    },
    forgetTab(tabId) {
      return enqueue(async () => {
        await handleEvent(tabId, { type: "removed" });
        delete (await remember()).selections[tabId];
        await persist();
      });
    }
  };
}

export function originOf(url) {
  try {
    const parsed = new URL(url);
    return ["http:", "https:"].includes(parsed.protocol) ? parsed.origin : null;
  } catch {
    return null;
  }
}

// Browser API failures become messages written for people; losing page
// access pauses the Journey until the user invokes Clicksheet again.
function asCaptureError(error) {
  if (error instanceof CaptureError) return error;
  const lostAccess = /activeTab|all_urls|permission|Cannot access|Receiving end does not exist/i.test(String(error?.message ?? ""));
  return new CaptureError(describeCaptureError(error), { pauseReason: lostAccess ? "permission" : null, cause: error });
}

export function describeCaptureError(error) {
  const text = String(error?.message ?? "");
  if (error instanceof CaptureError) return text;
  if (/MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND/i.test(text)) {
    return "Chrome limited how often Clicksheet can capture. Wait a moment, then use Capture to add this state.";
  }
  if (/activeTab|all_urls|permission|Cannot access|Receiving end does not exist/i.test(text)) {
    return "Clicksheet lost access to this page. Click the Clicksheet icon to continue.";
  }
  return "Clicksheet could not capture this page. Use Capture to try again.";
}
