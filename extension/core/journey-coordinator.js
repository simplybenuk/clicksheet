import { createStorage } from "./storage.js";
import { createThumbnail, THUMBNAIL_SIZE, VIEWER_SIZE } from "./thumbnail.js";
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
import { headerText, renderContactSheet } from "./export-renderer.js";
import { layoutContactSheet } from "./export-layout.js";
import { buildContext } from "./export-context.js";
import { visibleInteractionName } from "./interaction-name.js";
import { exportTimestamp, slugifyJourneyName } from "./export-names.js";
import { createExportSettings, memoryStorageArea } from "./export-settings.js";
import { fullPageViewport, planFullPage, stitchSegments } from "./full-page.js";
import { applyMasks } from "./redaction.js";

// A navigation or visible change this long after a click is still attributed to it.
export const CLICK_WINDOW_MS = 2500;
const REENTRY_REASONS = new Set(["permission", "navigation"]);
// Any of these ends the one-step Undo window for a deleted screenshot.
// Commands that do not act on the shown Journey: a stale widget command of
// this kind still runs, on the tab's current Journey (dismiss-export checks
// its own download id).
// Commands that write text to the Journey they name; see execute().
const ADDRESSED = new Set(["rename", "describe"]);
const SHOWN_EXEMPT = new Set(["snapshot", "export-settings", "dismiss-export"]);
const ENDS_UNDO = new Set(["delete-frame", "move-frame", "redact", "record", "resume", "capture", "stop", "new", "open", "settings"]);
const CAPTURE_AREAS = new Set(["viewport", "fullPage"]);
const COPY_LIMIT_BYTES = 45 * 1024 * 1024;
const EXPORT_FALLBACK_WIDTHS = [1280, 960, 640];
const QUOTA_ERROR = /MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND/i;

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
  // Chrome allows two captures per second, but calls spaced exactly 500ms
  // apart still trip its quota in practice, so leave some headroom.
  gate = createRateGate({ minIntervalMs: 600 }),
  sleep = (ms) => new Promise((done) => setTimeout(done, ms)),
  schedulerOptions = {},
  loadBrandIcon = null,
  // Where Save image and context writes (FR-C3), and the Downloads adapter:
  // save({ name, image, context }) -> { downloadId, fileName, contextFileName }.
  exportSettings = createExportSettings(memoryStorageArea()),
  downloads = null,
  version = "",
  renderSheet = (journey, loadImage, layoutOptions) => renderContactSheet(journey, { loadImage, loadBrandIcon, layoutOptions }),
  decodeImage = (blob) => createImageBitmap(blob),
  stitch = stitchSegments,
  redactImage = applyMasks
}) {
  const session = sessionFactory({ loadRootHandle, saveRootHandle });
  const clicks = new Map();
  const navigating = new Set();
  const notices = new Map();
  // The layout Copy image last used per Journey, so Copy context describes
  // the image that was actually copied (a large sheet may use a fallback width).
  const copyLayouts = new Map();
  let exportDestination = "downloads";
  // One deleted screenshot can be restored (memory.undo); its file is removed
  // once the Undo window ends so deleted pixels do not linger in the folder.
  // It is persisted because the worker idles out long before users click Undo.
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
      memory = { selections: { ...(stored?.selections ?? {}) }, recording: stored?.recording ?? null, undo: stored?.undo ?? null, released: stored?.released ?? null, lastCaptured: stored?.lastCaptured ?? null, exports: { ...(stored?.exports ?? {}) } };
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

  // Elapsed recording time for the bound segment, excluding pauses.
  function trackElapsed(journey) {
    const bound = memory?.recording;
    if (!bound || bound.journeyId !== journey.id) return;
    const running = journey.state === JOURNEY_STATE.recording;
    if (running && bound.activeSince == null) bound.activeSince = now();
    if (!running && bound.activeSince != null) {
      bound.elapsedMs = (bound.elapsedMs ?? 0) + Math.max(0, now() - bound.activeSince);
      bound.activeSince = null;
    }
    void persist();
  }

  function writeState(journey, frames = journey.frames) {
    trackElapsed(journey);
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

  async function bind(journey, tabId, context, { newSegment = false } = {}) {
    navigating.delete(tabId);
    // A binding released by closing the tab keeps its time for a later Resume.
    const previous = memory.recording?.journeyId === journey.id ? memory.recording
      : memory.released?.journeyId === journey.id ? memory.released : null;
    if (memory.released?.journeyId === journey.id) memory.released = null;
    memory.recording = {
      elapsedMs: newSegment ? 0 : previous?.elapsedMs ?? 0,
      activeSince: now(),
      journeyId: journey.id,
      tabId,
      windowId: context.windowId ?? null,
      origin: originOf(context.url),
      delayMs: journey.settings?.captureDelayMs ?? 500
    };
    await persist();
  }

  async function unbind({ keepTime = false } = {}) {
    clicks.clear();
    stopScheduler();
    if (memory.recording) {
      const bound = memory.recording;
      memory.released = keepTime ? {
        journeyId: bound.journeyId,
        elapsedMs: (bound.elapsedMs ?? 0) + (bound.activeSince != null ? Math.max(0, now() - bound.activeSince) : 0)
      } : null;
      memory.recording = null;
      await persist();
    }
  }

  // Captures the visible tab with the toolbar hidden and password fields
  // masked. Pixels are sanitized before anything reaches storage. The viewport
  // is always captured first, so a failed full-page attempt falls back to it.
  async function capturePage(tabId, kind, journey) {
    if (!browser) throw new CaptureError("Capture is unavailable in this context.");
    let page;
    let image;
    let warning = "";
    try {
      await assertVisible(tabId);
      try {
        // The toolbar is hidden and password fields are measured inside the
        // rate gate, directly before the pixels are taken, so a wait for the
        // quota cannot leave stale mask positions.
        const raw = await captureVisible(tabId, async () => { page = await browser.prepare(tabId); });
        image = await browser.sanitize(raw, page);
        if (journey.settings?.captureArea === "fullPage") {
          try {
            const full = await captureFullPage(tabId, page);
            if (full.warning) warning = full.warning;
            else {
              image = full.image;
              page = { ...page, viewport: full.viewport };
            }
          } catch (error) {
            if (error instanceof CaptureError && error.pauseReason === "tab") throw error;
            console.warn("Clicksheet kept a viewport capture because the full-page capture failed.", error?.name, error?.cause?.message ?? error?.message);
            warning = "The full page could not be captured.";
          }
        }
      } finally {
        await browser.restore(tabId).catch(() => {});
      }
    } catch (error) {
      throw asCaptureError(error);
    }
    const frame = buildFrame({
      id: `frame-${createId()}`,
      kind,
      page,
      image,
      capturedAt: clock(),
      segment: journey.recordingSegment ?? 0
    });
    frame.captureArea = warning || journey.settings?.captureArea !== "fullPage" ? "viewport" : "fullPage";
    if (warning) notices.set(tabId, `${warning} The visible part of the page was kept instead.`);
    return { frame, blob: image.blob };
  }

  async function assertVisible(tabId) {
    if (!(await browser.isVisible(tabId))) {
      throw new CaptureError("Return to the recorded tab to capture it.", { pauseReason: "tab" });
    }
  }

  // The visibility check sits inside the gate, directly before the capture,
  // because captureVisibleTab captures whichever tab is showing.
  function captureVisible(tabId, before = async () => {}) {
    return gate(async () => {
      await before();
      // Checked after preparing, which can take a few frames, and directly
      // before the capture.
      await assertVisible(tabId);
      try {
        return await browser.captureVisible(tabId);
      } catch (error) {
        if (!QUOTA_ERROR.test(String(error?.message))) throw error;
        // Another extension or a burst can exhaust the shared quota; one
        // retry after the window passes is enough to recover (FR-006.12).
        await sleep(1000);
        await before();
        await assertVisible(tabId);
        return browser.captureVisible(tabId);
      }
    });
  }

  async function captureFullPage(tabId, page) {
    const plan = planFullPage({
      scrollWidth: page.scrollWidth,
      scrollHeight: page.scrollHeight,
      viewportWidth: page.viewport.width,
      viewportHeight: page.viewport.height,
      devicePixelRatio: page.viewport.devicePixelRatio
    });
    if (!plan.ok) return { warning: plan.reason };
    const segments = [];
    for (const [index, y] of plan.positions.entries()) {
      // Fixed and sticky elements would repeat in every segment after the first.
      let position;
      const blob = await captureVisible(tabId, async () => { position = await browser.scrollTo(tabId, { y, hideFixed: index > 0 }); });
      segments.push({ blob, scrollY: position.scrollY, masks: position.masks });
    }
    const image = await stitch(segments, { width: plan.width, height: plan.height, viewportWidth: page.viewport.width });
    return { image, viewport: fullPageViewport({ width: plan.width, height: plan.height, devicePixelRatio: page.viewport.devicePixelRatio }) };
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
    // The click happened on the most recently captured page state, which is
    // not the last strip position after a reorder. If that frame was deleted,
    // no other frame can honestly carry the marker.
    const preceding = memory.lastCaptured?.journeyId === journey.id
      ? frames.findIndex((frame) => frame.id === memory.lastCaptured.frameId)
      : frames.length - 1;
    if (click && preceding !== -1) frames[preceding] = attachInteraction(frames[preceding], click);
    frames.push(captured.frame);
    writeState(next, frames);
    const saved = await session.flush();
    memory.lastCaptured = { journeyId: journey.id, frameId: captured.frame.id };
    await persist();
    if (!saved) {
      throw new CaptureError("The Journey could not be saved. It is held here until storage is reconnected.", { pauseReason: "storage" });
    }
  }

  async function automaticCapture(candidate, { isCurrent }) {
    const state = await remember();
    const { root, view } = await sync();
    const journey = find(view, candidate.journeyId);
    const bound = state.recording;
    if (!isCurrent() || !root || !journey || !bound || bound.journeyId !== journey.id ||
        bound.tabId !== candidate.tabId || journey.state !== JOURNEY_STATE.recording) return;
    if (!view.editable) {
      // Capture pauses visibly rather than dropping clicks (FR-004.5).
      notices.set(candidate.tabId, "Recording paused because the storage folder is unavailable. Reconnect it on the Storage page.");
      await pauseForError(journey.id, { pauseReason: "storage" });
      notify(candidate.tabId);
      return;
    }
    try {
      const captured = await capturePage(candidate.tabId, FRAME_KIND.click, journey);
      if (!isCurrent()) return;
      await addFrame(root, find(session.snapshot(), journey.id), captured, { click: candidate.click });
      notify(candidate.tabId);
    } catch (error) {
      // The page went away mid-capture; the navigation's completion offers
      // the click again, so this is not lost access.
      if (!isCurrent() || navigating.has(candidate.tabId) || await isLoading(candidate.tabId)) return;
      // Report here: pausing invalidates the scheduler token, which would
      // otherwise suppress its error callback.
      notices.set(candidate.tabId, describeCaptureError(error));
      await pauseForError(journey.id, error);
      notify(candidate.tabId);
    }
  }

  async function isLoading(tabId) {
    try {
      return Boolean(await browser.isLoading?.(tabId));
    } catch {
      return false;
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

  async function endUndo(root) {
    if (!memory.undo) return;
    const ended = memory.undo;
    memory.undo = null;
    await persist();
    await createStorage(root).deleteScreenshot(ended.journeyId, ended.frame.screenshotFile).catch(() => {});
  }

  // Files left behind by an Undo window that ended with a worker restart.
  async function pruneScreenshots(root, journey) {
    const storage = createStorage(root);
    const keep = new Set(journey.frames.map((frame) => frame.screenshotFile));
    if (memory.undo?.journeyId === journey.id) keep.add(memory.undo.frame.screenshotFile);
    for (const name of await storage.listScreenshots(journey.id).catch(() => [])) {
      if (!keep.has(name)) await storage.deleteScreenshot(journey.id, name).catch(() => {});
    }
  }

  async function execute(tabId, command, context) {
    const state = await remember();
    exportDestination = (await exportSettings.load()).destination;
    let { root, view } = await sync();
    // A binding to a Journey that is not in the connected library (after
    // "Start a new library" or Locate) would block every tab from recording.
    if (view.available && state.recording && !find(view, state.recording.journeyId)) {
      await unbind();
      state.released = null;
      await persist();
    }
    // A Save replaces the bar from any earlier one as soon as it is asked for,
    // before anything can refuse it or fail, so a failed save never sits next
    // to an older success (FR-C4.4) and the bar cannot return later.
    if (command.action === "export" && command.destination === "save" && state.exports[tabId]) {
      delete state.exports[tabId];
      await persist();
    }
    // A name or description is only ever written to a Journey that the
    // command names. A missing id is refused: it is never read as "the
    // current Journey", which may not be the one the text was typed for.
    if (ADDRESSED.has(command.action) && (typeof command.journeyId !== "string" || !command.journeyId)) {
      throw new Error("This change did not say which Journey it was for, so nothing was changed. Reopen the Journey and try again.");
    }
    // An explicit id that no longer exists (folder removed by hand) must not
    // silently redirect a capture or edit into another Journey.
    if (command.journeyId && !find(view, command.journeyId) && !["snapshot", "open", "new"].includes(command.action)) {
      throw new Error(view.available ? "Journey not found. Reopen it from Journeys." : "Reconnect the storage folder on the Storage page, then try again.");
    }
    // A widget command carries the Journey the user saw when they clicked
    // (`asShown`). If another command changed the tab's Journey while it
    // waited, it is refused rather than switching the tab back. (A shown
    // Journey that was since removed is handled above, or by open and new.)
    const shownId = find(view, state.selections[tabId]) ? state.selections[tabId] : view.journeys[0]?.id ?? null;
    // ...and it must be the Journey this tab has selected, whoever sent it.
    // Only a tab with no selection left (a worker that lost its session
    // state) takes the named Journey as its own, as a held edit retried by id
    // relies on; it never falls back to the first Journey for these.
    const selectedId = find(view, state.selections[tabId]) ? state.selections[tabId] : null;
    if (ADDRESSED.has(command.action) && selectedId !== null && command.journeyId !== selectedId) {
      throw new Error("Another Journey is shown in this tab now, so the change was not made. Reopen the Journey and try again.");
    }
    const sawExisting = command.journeyId == null || Boolean(find(view, command.journeyId));
    if (command.asShown && sawExisting && (command.journeyId ?? null) !== shownId) {
      if (!SHOWN_EXEMPT.has(command.action)) throw new Error("Another Journey was opened before this could run, so nothing was done. Try again.");
      // Not about a Journey: it runs, but must not switch the tab back.
      command = { ...command, journeyId: undefined };
    }
    if (root && ENDS_UNDO.has(command.action)) await endUndo(root);
    let id = command.journeyId ?? state.selections[tabId];
    if (!find(view, id)) id = view.journeys[0]?.id ?? null;
    if (state.selections[tabId] !== id) {
      state.selections[tabId] = id;
      await persist();
    }
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
      case "thumbnail":
      case "view-frame": {
        if (!view.available || !current || current.id !== command.journeyId) throw new Error("Reconnect storage to load this screenshot.");
        const frame = current.frames.find((item) => item.id === command.frameId);
        if (!frame) throw new Error("Screenshot not found.");
        const file = await createStorage(root).readScreenshot(current.id, frame.screenshotFile);
        if (command.action === "thumbnail") return { thumbnail: await thumbnail(file, frame, THUMBNAIL_SIZE) };
        // The viewer shows the stored (already redacted) pixels with the
        // click marker, larger than a thumbnail.
        return { image: await thumbnail(file, frame, VIEWER_SIZE), frameId: frame.id };
      }
      case "new": {
        if (!view.editable || (current && !controls.newJourney)) throw new Error("Finish the recording and reconnect storage before creating a Journey.");
        const created = session.createJourney();
        if (!created) throw new Error("Choose a storage folder first.");
        const model = prepareJourney(created);
        session.updateJourney(created.id, { state: model.state, pauseReason: model.pauseReason, recordingSegment: model.recordingSegment });
        state.selections[tabId] = created.id;
        delete state.exports[tabId];
        await persist();
        break;
      }
      case "open":
        if (current && command.id !== current.id && !controls.openJourney) throw new Error("Stop recording before opening another Journey.");
        if (!find(view, command.id)) throw new Error("Journey not found.");
        if (command.id !== state.selections[tabId]) delete state.exports[tabId];
        state.selections[tabId] = command.id;
        await persist();
        break;
      case "rename":
        if (!current || !view.renamable || typeof command.name !== "string") throw new Error("This Journey cannot be renamed now.");
        session.rename(current.id, command.name);
        break;
      // Held like a rename while the folder is unavailable.
      case "describe":
        if (!current || !view.renamable || typeof command.description !== "string") throw new Error("This Journey's description cannot be changed now.");
        session.describe(current.id, command.description);
        break;
      case "record": {
        requireJourney(current, controls.record, state, tabId);
        const next = transitionJourney(current, "record", details);
        const captured = await capturePage(tabId, FRAME_KIND.initial, next);
        await addFrame(root, current, captured, { next });
        await bind(next, tabId, context, { newSegment: true });
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
      case "delete-frame": {
        const index = requireFrame(current, command.frameId, view);
        const frames = current.frames.filter((_, position) => position !== index);
        session.updateJourney(current.id, { frames });
        state.undo = { journeyId: current.id, frame: current.frames[index], index };
        await persist();
        break;
      }
      case "undo-delete": {
        const undo = state.undo;
        if (!current || !view.editable || undo?.journeyId !== current.id) throw new Error("There is nothing to undo.");
        const frames = [...current.frames];
        frames.splice(Math.min(undo.index, frames.length), 0, undo.frame);
        session.updateJourney(current.id, { frames });
        state.undo = null;
        await persist();
        break;
      }
      case "move-frame": {
        const index = requireFrame(current, command.frameId, view);
        const target = Math.max(0, Math.min(current.frames.length - 1, Math.trunc(Number(command.toIndex))));
        if (!Number.isFinite(Number(command.toIndex))) throw new Error("Choose where to move the screenshot.");
        const frames = [...current.frames];
        frames.splice(target, 0, ...frames.splice(index, 1));
        session.updateJourney(current.id, { frames });
        break;
      }
      case "settings": {
        if (!current || !view.editable) throw new Error("Reconnect storage before changing settings.");
        const settings = { ...(current.settings ?? {}) };
        if (command.settings?.captureArea !== undefined) {
          if (!CAPTURE_AREAS.has(command.settings.captureArea)) throw new Error("Choose viewport or full page.");
          settings.captureArea = command.settings.captureArea;
        }
        if (command.settings?.captureDelayMs !== undefined) {
          const delay = Number(command.settings.captureDelayMs);
          if (!Number.isInteger(delay) || delay < 0 || delay > 10000) throw new Error("The capture delay must be a whole number from 0 to 10000 ms.");
          settings.captureDelayMs = delay;
        }
        session.updateJourney(current.id, { settings });
        if (state.recording?.journeyId === current.id) {
          state.recording.delayMs = settings.captureDelayMs ?? 500;
          await persist();
          if (current.state === JOURNEY_STATE.recording) startScheduler(state.recording.delayMs);
        }
        break;
      }
      case "redact": {
        const index = requireFrame(current, command.frameId, view);
        const frame = current.frames[index];
        const storage = createStorage(root);
        const redacted = await redactImage(await storage.readScreenshot(current.id, frame.screenshotFile), command.masks);
        // A new file name keeps preview caches honest; the original file is
        // removed after the Journey points at the redacted copy (FR-009.4).
        const fileName = `${frame.id}-${createId().replace(/[^A-Za-z0-9]/g, "").slice(0, 8)}.png`;
        await storage.writeScreenshot(current.id, fileName, redacted.blob);
        const frames = [...current.frames];
        // The boxes are kept so the context file can drop labels they hide. A
        // frame redacted before boxes were stored stays without them: its
        // earlier boxes are unknown, so every label on it is treated as hidden.
        const masks = frame.redacted && !Array.isArray(frame.masks) ? undefined : [...(frame.masks ?? []), ...(redacted.boxes ?? [])];
        frames[index] = { ...frame, screenshotFile: fileName, image: { width: redacted.width, height: redacted.height }, redacted: true, ...(masks ? { masks } : {}) };
        session.updateJourney(current.id, { frames });
        if (!(await session.flush())) {
          throw new Error("The redaction is held until storage is reconnected. The original screenshot is removed after it saves.");
        }
        await storage.deleteScreenshot(current.id, frame.screenshotFile);
        break;
      }
      case "screenshot": {
        const index = requireFrame(current, command.frameId, view, { editable: false });
        const frame = current.frames[index];
        const file = await createStorage(root).readScreenshot(current.id, frame.screenshotFile);
        return { screenshot: await toDataUrl(file), frame, journeyName: current.name };
      }
      case "export": {
        if (!current || !view.available) throw new Error("Reconnect storage before exporting.");
        if (!current.frames.length) throw new Error("Export is unavailable because this Journey has no screenshots.");
        if (!["copy", "context", "save"].includes(command.destination)) throw new Error("Choose Copy image, Copy context, or Save image and context.");
        const storage = createStorage(root);
        const journey = prepareJourney(current);
        const contextFor = (layoutOptions) => JSON.stringify(buildContext(
          journey,
          layoutContactSheet(journey.frames, { ...layoutOptions, header: headerText(journey) }),
          { exportedAt: clock(), version }
        ), null, 2);
        const copyKey = JSON.stringify([journey.name, journey.description, journey.frames.map((frame) => frame.screenshotFile)]);
        if (command.destination === "context") {
          const copied = copyLayouts.get(current.id);
          return { ...present(tabId), context: contextFor(copied?.key === copyKey ? copied.layoutOptions : undefined) };
        }
        const load = async (frame) => decodeImage(await storage.readScreenshot(current.id, frame.screenshotFile));
        // Full-width screenshots can exceed what Chrome will allocate, or what
        // a runtime message can carry for Copy (64 MiB, plus a third for
        // base64). Retry at smaller widths before giving up; nothing is dropped.
        const limit = command.destination === "copy" ? COPY_LIMIT_BYTES : Infinity;
        let blob = null;
        let layoutOptions;
        let failure = null;
        for (const imageWidth of [undefined, ...EXPORT_FALLBACK_WIDTHS]) {
          try {
            layoutOptions = imageWidth ? { imageWidth } : undefined;
            blob = await renderSheet(journey, load, layoutOptions);
            failure = null;
            if (blob.size <= limit) break;
          } catch (error) {
            if (error?.name !== "ExportTooLargeError") throw error;
            failure = error;
          }
        }
        if (failure) throw failure;
        if (command.destination === "copy") {
          if (blob.size > limit) throw new Error("This contact sheet is too large to copy. Use Save image and context instead.");
          copyLayouts.set(current.id, { key: copyKey, layoutOptions });
          return { ...present(tabId), image: await toDataUrl(blob) };
        }
        const contextFile = new Blob([contextFor(layoutOptions)], { type: "application/json" });
        const slug = slugifyJourneyName(current.name);
        if (exportDestination === "library") {
          const { fileName, contextFileName } = await storage.writeExportPair(slug, blob, contextFile);
          notices.set(tabId, `Saved ${fileName} and ${contextFileName} in ${view.folderName ? `${view.folderName}/exports` : "the exports folder of your Clicksheet folder"}.`);
          return { ...present(tabId), exported: { destination: "library", fileName, contextFileName } };
        }
        if (!downloads) throw new Error("Saving to Downloads is unavailable here. Choose the Clicksheet folder in Settings.");
        const saved = await downloads.save({ name: `${slug}-${exportTimestamp(new Date(now()))}`, image: blob, context: contextFile });
        state.exports[tabId] = { downloadId: saved.downloadId, fileName: saved.fileName, contextFileName: saved.contextFileName };
        await persist();
        notices.set(tabId, `Saved ${saved.fileName} and ${saved.contextFileName} in Downloads/Clicksheet.`);
        return { ...present(tabId), exported: { destination: "downloads", ...saved } };
      }
      case "export-settings":
        exportDestination = (await exportSettings.save({ destination: command.destination })).destination;
        break;
      case "dismiss-export":
        // Only the bar the user closed: a ✕ that waited behind a new save
        // must not remove the new bar.
        if (state.exports[tabId] && state.exports[tabId].downloadId === command.downloadId) {
          delete state.exports[tabId];
          await persist();
        }
        break;
      case "snapshot":
        break;
      default:
        throw new Error("Unknown Journey action.");
    }
    if (root && current && (command.action === "open" || command.action === "stop")) {
      const selected = find(session.snapshot(), state.selections[tabId]);
      if (selected) await pruneScreenshots(root, selected);
    }
    if (!["snapshot", "open"].includes(command.action)) {
      const saved = await session.flush();
      if (command.action === "new" && !saved) throw new Error("The new Journey could not be saved. Reconnect storage before trying again.");
    }
    return present(tabId);
  }

  function requireFrame(current, frameId, view, { editable = true } = {}) {
    if (!current) throw new Error("Create or open a Journey first.");
    if (editable ? !view.editable : !view.available) throw new Error("Reconnect storage before editing screenshots.");
    const index = current.frames.findIndex((frame) => frame.id === frameId);
    if (index === -1) throw new Error("Screenshot not found. It may have been deleted.");
    return index;
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

  // The strip and viewer label a step the way the export does, so a name a
  // redaction box hides is not printed next to the redacted screenshot.
  function widgetJourney(journey) {
    const prepared = prepareJourney(journey);
    for (const frame of prepared.frames) {
      if (frame.interaction) frame.interaction = { ...frame.interaction, label: visibleInteractionName(frame) };
    }
    return prepared;
  }

  // `keepNotice` leaves a waiting notice for the next successful response:
  // the view sent with a failure is shown next to the error, not a notice.
  function present(tabId, { keepNotice = false } = {}) {
    const view = session.snapshot();
    const state = memory;
    const selected = find(view, state.selections[tabId]);
    const captureReady = Boolean(browser) && (!state.recording || state.recording.tabId === tabId);
    const notice = keepNotice ? "" : notices.get(tabId) ?? "";
    if (!keepNotice) notices.delete(tabId);
    return {
      ...view,
      currentJourney: selected ? widgetJourney(selected) : null,
      controls: selected ? libraryControls(journeyControls(prepareJourney(selected), { available: view.editable, captureReady }), selected, tabId, view) : {},
      recordingHere: state.recording?.tabId === tabId && state.recording.journeyId === selected?.id,
      recordingElsewhere: Boolean(state.recording && state.recording.tabId !== tabId),
      elapsedMs: selected && state.recording?.journeyId === selected.id
        ? (state.recording.elapsedMs ?? 0) + (state.recording.activeSince != null ? Math.max(0, now() - state.recording.activeSince) : 0)
        : selected && state.released?.journeyId === selected.id ? state.released.elapsedMs : null,
      canExport: Boolean(selected?.frames.length && view.available),
      undo: state.undo && state.undo.journeyId === selected?.id ? { frameId: state.undo.frame.id } : null,
      notice,
      exportDestination,
      lastExport: state.exports?.[tabId] ?? null,
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
        if (!pending || pending.offered || bound?.tabId !== tabId) return;
        // Kept for the attribution window: a click that changes the page and
        // then navigates (a submit button showing "Saving…") must still
        // capture the page it leads to.
        pending.offered = true;
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
          navigating.add(tabId);
          const pending = recentClick(tabId);
          if (pending) {
            pending.navigating = true;
            // Any settled candidate belongs to the page being left.
            stopScheduler();
          }
          return;
        }
        if (event.status !== "complete") return;
        navigating.delete(tabId);
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
        await unbind({ keepTime: true });
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
    // A failed command rejects with the error, and the error carries the
    // tab's view as it is after the failure (`error.view`). A command can
    // change state before it fails (a Save clears the earlier bar; a refused
    // command means the tab shows another Journey), so whoever shows the
    // error must show that state with it, not the one from before the command.
    request(tabId, command, context = {}) {
      return enqueue(async () => {
        try {
          return await execute(tabId, command ?? {}, context);
        } catch (error) {
          if (error && typeof error === "object") {
            try { error.view = present(tabId, { keepNotice: true }); } catch { /* no state to show yet */ }
          }
          throw error;
        }
      });
    },
    event(tabId, event) {
      // Navigation state is recorded at once: a capture already queued or in
      // flight must see it, not wait behind it.
      // Only the recorded tab is marked, and binding clears it, so a page that
      // loaded before Record can never hide later capture failures. Completion
      // is handled in the queue, after any capture it interrupted.
      if (event?.type === "updated" && event.status === "loading" && memory?.recording?.tabId === tabId) navigating.add(tabId);
      if (event?.type === "removed") navigating.delete(tabId);
      return enqueue(() => handleEvent(tabId, event ?? {}));
    },
    forgetTab(tabId) {
      navigating.delete(tabId);
      return enqueue(async () => {
        await handleEvent(tabId, { type: "removed" });
        const state = await remember();
        delete state.selections[tabId];
        delete state.exports[tabId];
        await persist();
      });
    },
    // The latest Downloads export in this tab, for its Open / Show bar.
    async lastExport(tabId) {
      return (await remember()).exports[tabId] ?? null;
    }
  };
}

export async function toDataUrl(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let start = 0; start < bytes.length; start += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
  }
  return `data:${blob.type || "image/png"};base64,${btoa(binary)}`;
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
  if (QUOTA_ERROR.test(text)) {
    return "Chrome limited how often Clicksheet can capture. Wait a moment, then use Capture to add this state.";
  }
  if (/activeTab|all_urls|permission|Cannot access|Receiving end does not exist/i.test(text)) {
    return "Clicksheet lost access to this page. Click the Clicksheet icon to continue.";
  }
  return "Clicksheet could not capture this page. Use Capture to try again.";
}
