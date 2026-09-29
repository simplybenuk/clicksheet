(() => {
  if (window.__clicksheetToolbar) {
    window.__clicksheetToolbar.open();
    return;
  }
  const ROOT_ID = "clicksheet-toolbar-root";
  // Shorter than the worker's attribution window so a late change is never
  // reported for a click the worker has already forgotten.
  const WATCH_MS = 2000;
  const INTERACTIVE = "a[href], button, input, select, textarea, label, summary, [role='button'], [role='link'], [role='tab'], [role='menuitem'], [role='checkbox'], [role='option'], [onclick], [tabindex]";
  const PASSWORD_SELECTOR = "input[type='password'], input[autocomplete~='current-password'], input[autocomplete~='new-password']";
  const PAUSE_MESSAGES = {
    user: "Paused. Resume to capture page changes again. Capture still works.",
    tab: "Paused while another tab is active. Return to this tab to continue.",
    navigation: "Paused because this page is on another site. Click the Clicksheet icon to continue here.",
    permission: "Paused. Resume to continue recording from this page.",
    storage: "Paused until storage is reconnected on the Storage page."
  };
  // The toolbar lives in a closed shadow root so page scripts cannot read
  // screenshot previews or Journey names, which may come from other sites.
  const host = document.createElement("clicksheet-toolbar");
  host.setAttribute("style", "all: initial");
  const shadow = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent = window.__clicksheetToolbarCss ?? "";
  shadow.append(style);
  const root = document.createElement("aside");
  root.id = ROOT_ID;
  root.setAttribute("role", "region");
  root.setAttribute("aria-label", "Clicksheet");
  // A floating widget (spec 1.2): the pill is always shown; the panel with
  // the strip and editing controls expands from it.
  root.innerHTML = `
    <div class="cs-widget" data-role="widget">
      <div class="cs-pill">
        <button type="button" class="cs-grip" data-action="drag" aria-label="Move Clicksheet. Drag, or use the arrow keys." title="Drag to move">⠿</button>
        <span class="clicksheet-toolbar__mark" aria-hidden="true">C</span>
        <span class="cs-status">
          <span data-role="state">Ready</span>
          <span data-role="elapsed" aria-label="Recording time"></span>
          <span data-role="count"></span>
        </span>
        <span class="cs-primary">
          <button type="button" data-action="record" disabled>Record</button>
          <button type="button" data-action="pause" hidden disabled>Pause</button>
          <button type="button" data-action="resume" hidden disabled>Resume</button>
          <button type="button" data-action="stop" hidden disabled>Stop</button>
          <button type="button" data-action="capture" disabled>Capture</button>
        </span>
        <button type="button" class="cs-icon" data-action="expand" aria-expanded="false" aria-label="Show screenshots and editing" title="Show screenshots and editing">▴</button>
        <button type="button" class="cs-icon" data-action="dismiss" aria-label="Hide Clicksheet" title="Hide (click the Clicksheet icon to bring it back)">✕</button>
      </div>
      <p data-role="message" class="cs-message" aria-live="polite">Connecting to your local library…</p>
      <div class="cs-panel" data-role="panel" hidden>
        <div class="clicksheet-toolbar__heading">
          <input data-role="name" aria-label="Journey name" placeholder="Choose or create a Journey">
          <button type="button" data-action="library" aria-expanded="false">Journeys</button>
          <span data-role="save-status" aria-live="polite"></span>
        </div>
        <div class="cs-description">
          <label for="cs-description">Description (optional)</label>
          <textarea id="cs-description" data-role="description" rows="2" maxlength="280" placeholder="What is this journey for?"></textarea>
          <span data-role="description-count" aria-live="polite"></span>
        </div>
        <div data-role="library" class="clicksheet-toolbar__library" hidden>
          <button type="button" data-action="new">New Journey</button>
          <div data-role="journeys"></div>
        </div>
        <div class="cs-strip-row">
          <button type="button" class="cs-icon" data-action="strip-prev" aria-label="Scroll screenshots left">‹</button>
          <div class="clicksheet-toolbar__strip" data-role="strip" aria-label="Journey screenshots"></div>
          <button type="button" class="cs-icon" data-action="strip-next" aria-label="Scroll screenshots right">›</button>
        </div>
        <div class="clicksheet-toolbar__frame-actions" data-role="frame-actions">
          <button type="button" data-action="move-left" disabled>Move left</button>
          <button type="button" data-action="move-right" disabled>Move right</button>
          <button type="button" data-action="view" disabled title="View the selected screenshot (or double-click a thumbnail)">View</button>
          <button type="button" data-action="edit" disabled>Redact…</button>
          <button type="button" class="cs-danger" data-action="delete" disabled>Delete</button>
          <button type="button" data-action="undo" hidden>Undo delete</button>
        </div>
        <div class="clicksheet-toolbar__actions">
          <button type="button" data-action="export" aria-expanded="false" disabled>Export</button>
          <button type="button" data-action="settings" aria-expanded="false">Settings</button>
          <button type="button" data-action="storage">Storage</button>
        </div>
        <div class="clicksheet-toolbar__menu" data-role="export-menu" hidden>
          <button type="button" data-action="copy-image">Copy image</button>
          <button type="button" data-action="download-image">Download image</button>
        </div>
        <form class="clicksheet-toolbar__menu" data-role="settings-menu" hidden>
          <label>Capture area
            <select data-role="capture-area">
              <option value="viewport">Visible viewport</option>
              <option value="fullPage">Full page</option>
            </select>
          </label>
          <label>Capture delay (ms)
            <input data-role="capture-delay" type="number" min="0" max="10000" step="50" inputmode="numeric">
          </label>
          <button type="submit" data-action="save-settings">Save settings</button>
          <div class="cs-shortcuts">
            <span>Keyboard shortcuts</span>
            <span data-role="shortcut-list">Checking…</span>
            <button type="button" data-action="open-shortcuts">Set shortcuts…</button>
          </div>
          <p>Screenshots stay in the folder you chose on this device. They can still show sensitive details you did not redact.</p>
        </form>
      </div>
    </div>
    <div class="cs-viewer" data-role="viewer" role="dialog" aria-modal="true" aria-label="Screenshot viewer" hidden>
      <div class="cs-viewer__bar">
        <span class="cs-viewer__title" data-role="viewer-title"></span>
        <span class="cs-viewer__nav">
          <button type="button" data-action="viewer-prev" aria-label="Previous screenshot">‹ Previous</button>
          <button type="button" data-action="viewer-next" aria-label="Next screenshot">Next ›</button>
          <button type="button" data-action="viewer-redact">Redact…</button>
          <button type="button" class="cs-icon" data-action="viewer-close" aria-label="Close viewer" title="Close (Esc)">✕</button>
        </span>
      </div>
      <div class="cs-viewer__stage" data-role="viewer-stage">
        <img data-role="viewer-image" alt="">
        <p data-role="viewer-status" aria-live="polite"></p>
      </div>
    </div>`;
  shadow.append(root);
  document.documentElement.append(host);
  const role = (name) => root.querySelector(`[data-role="${name}"]`);
  const action = (name) => root.querySelector(`[data-action="${name}"]`);
  let view = null;
  let selectedFrame = null;
  let busy = false;
  let refreshQueued = false;
  // The name and description share one pending-edit revision and debounce.
  let editTimer = null;
  let editRevision = 0;
  let savedRevision = 0;
  const editedFields = new Set();
  let saveFailed = false;
  let notice = "";
  let requestTail = Promise.resolve();
  let flushTail = Promise.resolve();
  let stopWatching = null;
  let hiddenForCapture = null;
  // Elements whose inline style Clicksheet changes during a capture (covered
  // password fields, hidden fixed elements). Only those style changes are
  // ignored, so a real click during a capture still counts.
  const styledForCapture = new WeakSet();
  const ownChange = (record) => record.target === host ||
    (record.type === "attributes" && record.attributeName === "style" && styledForCapture.has(record.target));
  let scrollBeforeCapture = null;
  let hiddenFixed = null;
  const seenPasswords = new WeakSet();
  const previews = new Map();
  const previewRequests = new Map();
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      observer.unobserve(entry.target);
      loadPreview(entry.target);
    }
  }, { root: role("strip") });

  async function loadPreview(button) {
    const { previewKey, frameId, journeyId } = button.dataset;
    if (!previews.has(previewKey)) {
      if (!previewRequests.has(previewKey)) {
        previewRequests.set(previewKey, chrome.runtime.sendMessage({
          type: "clicksheet:journey", command: { action: "thumbnail", journeyId, frameId }
        }).then((result) => {
          if (result?.ok && result.view?.thumbnail?.startsWith("data:image/png;base64,")) {
            previews.set(previewKey, result.view.thumbnail);
            if (previews.size > 128) previews.delete(previews.keys().next().value);
          }
        }).catch(() => {}).finally(() => previewRequests.delete(previewKey)));
      }
      await previewRequests.get(previewKey);
    }
    if (previews.has(previewKey) && button.isConnected) {
      const image = document.createElement("img");
      image.src = previews.get(previewKey); image.alt = "";
      button.prepend(image);
    } else if (button.isConnected) button.title = "Preview unavailable. Reconnect storage and reopen the Journey.";
  }

  function frameLabel(frame) {
    if (frame.interaction) return frame.interaction.label ? `Click "${frame.interaction.label}"` : "Click";
    return frame.label || frame.title || "Screenshot";
  }

  function statusMessage(journey) {
    if (view?.status === "Storage unavailable") return "Reconnect the folder on the Storage page.";
    if (!journey) return "Choose a folder in Storage, then create or open a Journey.";
    if (view.recordingElsewhere) return "Clicksheet is recording in another tab. Stop it there to record here.";
    if (journey.state === "Recording") return "Recording. Page-changing clicks are captured automatically.";
    if (journey.state === "Paused") return PAUSE_MESSAGES[journey.pauseReason] ?? PAUSE_MESSAGES.user;
    if (journey.state === "Stopped") return "Stopped. Record appends a new segment to this Journey.";
    return journey.frames.length ? "Saved locally. Record to continue this Journey." : "Press Record to capture this page and start the Journey.";
  }

  function render() {
    const journey = view?.currentJourney;
    const controls = view?.controls ?? {};
    if (shadow.activeElement !== role("name") && savedRevision === editRevision) role("name").value = journey?.name ?? "";
    if (shadow.activeElement !== role("description") && savedRevision === editRevision) role("description").value = journey?.description ?? "";
    role("name").disabled = busy || !journey || !view?.renamable;
    role("description").disabled = role("name").disabled;
    renderDescriptionCount();
    role("state").textContent = journey?.state ?? "Ready";
    renderElapsed();
    role("save-status").textContent = saveFailed || view?.status === "Storage unavailable" ? "Storage unavailable" : savedRevision < editRevision ? "Saving" : view?.status ?? "";
    role("message").textContent = notice || view?.message?.text || statusMessage(journey);
    // Notices and warnings must be seen even when the widget is collapsed.
    role("message").dataset.notice = String(Boolean(notice || view?.message?.tone === "warn" || view?.status === "Storage unavailable" || view?.recordingElsewhere));
    action("new").disabled = busy || !view?.editable || (journey && !controls.newJourney);
    role("journeys").replaceChildren(...(view?.journeys ?? []).map((item) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = item.name;
      button.setAttribute("aria-current", String(item.id === journey?.id));
      button.disabled = busy || (journey && !controls.openJourney);
      button.addEventListener("click", () => run({ action: "open", id: item.id }));
      return button;
    }));
    const active = ["Recording", "Paused"].includes(journey?.state);
    action("record").hidden = active;
    action("pause").hidden = journey?.state !== "Recording";
    action("resume").hidden = journey?.state !== "Paused";
    action("stop").hidden = !active;
    for (const name of ["record", "pause", "resume", "stop", "capture"]) action(name).disabled = busy || !controls[name];
    action("export").disabled = busy || !view?.canExport;
    if (action("export").disabled) toggleMenu("export-menu", false);
    const frames = journey?.frames ?? [];
    const selectedIndex = frames.findIndex((frame) => frame.id === selectedFrame);
    if (selectedIndex === -1) selectedFrame = null;
    const editable = Boolean(view?.editable) && !busy && selectedIndex !== -1;
    action("move-left").disabled = !editable || selectedIndex === 0;
    action("move-right").disabled = !editable || selectedIndex === frames.length - 1;
    action("edit").disabled = !editable;
    action("view").disabled = busy || selectedIndex === -1 || !view?.available;
    action("delete").disabled = !editable;
    action("undo").hidden = !view?.undo;
    action("undo").disabled = busy || !view?.editable;
    if (shadow.activeElement !== role("capture-delay") && journey) {
      role("capture-area").value = journey.settings?.captureArea ?? "viewport";
      role("capture-delay").value = String(journey.settings?.captureDelayMs ?? 500);
    }
    action("save-settings").disabled = busy || !journey || !view?.editable;
    renderStrip(journey, controls);
    root.dataset.recording = String(journey?.state === "Recording");
    role("count").textContent = journey?.frames.length ? `${journey.frames.length} shot${journey.frames.length === 1 ? "" : "s"}` : "";
    if (!observing()) stopWatch();
  }

  // Thumbnails are kept per frame and only moved or relabelled, so the strip
  // keeps its scroll position and loaded previews across updates.
  const thumbs = new Map();
  let stripJourney = null;
  let stripCount = -1;
  let lastRevealKey = "";
  function renderStrip(journey, controls) {
    const strip = role("strip");
    const frames = journey?.frames ?? [];
    if (stripJourney !== journey?.id) {
      for (const button of thumbs.values()) button.remove();
      thumbs.clear();
      observer.disconnect();
    }
    const live = new Set(frames.map((frame) => frame.id));
    for (const [id, button] of thumbs) if (!live.has(id)) { observer.unobserve(button); button.remove(); thumbs.delete(id); }
    frames.forEach((frame, index) => {
      let button = thumbs.get(frame.id);
      const previewKey = `${journey.id}:${frame.screenshotFile}`;
      if (!button || button.dataset.previewKey !== previewKey) {
        button?.remove();
        button = createThumb(journey, frame, previewKey);
        thumbs.set(frame.id, button);
      }
      button.querySelector("span").textContent = `${index + 1}. ${frameLabel(frame)}`;
      button.title = [frame.title, frame.pathname].filter(Boolean).join(" · ");
      button.setAttribute("aria-pressed", String(frame.id === selectedFrame));
      button.dataset.index = String(index);
      if (strip.children[index] !== button) strip.insertBefore(button, strip.children[index] ?? null);
    });
    let add = strip.querySelector(".clicksheet-toolbar__add");
    if (!add) {
      add = document.createElement("button");
      add.type = "button";
      add.className = "clicksheet-toolbar__add";
      add.textContent = "+ Add screenshot";
      add.title = "Capture the current page";
      add.addEventListener("click", () => run({ action: "capture" }));
    }
    strip.append(add);
    add.disabled = busy || !controls.capture;
    // Show the newest screenshot when a Journey opens (including after a
    // navigation re-creates the widget) and whenever one is added.
    const opened = stripJourney !== journey?.id;
    const grew = frames.length > stripCount && stripCount !== -1;
    // While recording, the newest screenshot is the one of interest.
    if (grew && journey?.state === "Recording") selectedFrame = frames.at(-1).id;
    stripJourney = journey?.id ?? null;
    stripCount = frames.length;
    // Scroll only when something the user cares about moved: a Journey opened,
    // or the selected screenshot changed or changed place (capture, Undo,
    // Move, drag). Plain refreshes leave the user's own scrolling alone.
    const selectedIndex = frames.findIndex((frame) => frame.id === selectedFrame);
    const revealKey = `${journey?.id}:${selectedFrame}:${selectedIndex}`;
    const reveal = opened || revealKey !== lastRevealKey;
    lastRevealKey = revealKey;
    requestAnimationFrame(() => {
      if (reveal) {
        if (selectedIndex !== -1) revealSelected();
        else if (opened || grew) strip.scrollLeft = strip.scrollWidth;
      }
      updateStripButtons();
    });
  }
  function createThumb(journey, frame, previewKey) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "clicksheet-toolbar__frame";
    button.append(document.createElement("span"));
    button.dataset.previewKey = previewKey;
    button.dataset.frameId = frame.id;
    button.dataset.journeyId = journey.id;
    observer.observe(button);
    button.addEventListener("click", (event) => {
      if (suppressClick) { suppressClick = false; event.preventDefault(); return; }
      selectedFrame = frame.id;
      render();
    });
    button.addEventListener("keydown", (event) => {
      if ((event.key === "Delete" || event.key === "Backspace") && !action("delete").disabled) { selectedFrame = frame.id; void run({ action: "delete-frame", frameId: frame.id }); }
    });
    button.addEventListener("pointerdown", (event) => startReorder(event, button));
    button.addEventListener("dblclick", () => openViewer(frame.id));
    return button;
  }
  function revealSelected() {
    const button = selectedFrame && thumbs.get(selectedFrame);
    const strip = role("strip");
    if (!button) return;
    // The newest screenshot sits beside the Add card; show both.
    if (button.nextElementSibling?.classList.contains("clicksheet-toolbar__add")) { strip.scrollLeft = strip.scrollWidth; return; }
    // The strip is the thumbnails' offset parent (position: relative).
    const left = button.offsetLeft;
    if (left < strip.scrollLeft) strip.scrollLeft = left - 8;
    else if (left + button.offsetWidth > strip.scrollLeft + strip.clientWidth) strip.scrollLeft = left + button.offsetWidth - strip.clientWidth + 8;
  }
  function updateStripButtons() {
    const strip = role("strip");
    const overflow = strip.scrollWidth > strip.clientWidth + 1;
    action("strip-prev").hidden = !overflow;
    action("strip-next").hidden = !overflow;
    action("strip-prev").disabled = strip.scrollLeft <= 0;
    action("strip-next").disabled = strip.scrollLeft + strip.clientWidth >= strip.scrollWidth - 1;
  }

  // Reordering with the pointer: a line shows where the screenshot will land,
  // and the strip scrolls when the pointer nears either edge.
  let reorder = null;
  let suppressClick = false;
  function startReorder(event, button) {
    if (event.button !== 0 || !view?.editable || busy) return;
    reorder = { button, pointerId: event.pointerId, startX: event.clientX, x: event.clientX, active: false, gap: null, frame: null };
    button.setPointerCapture(event.pointerId);
  }
  function thumbList() {
    return [...role("strip").querySelectorAll(".clicksheet-toolbar__frame")];
  }
  function gapAt(x) {
    const list = thumbList();
    let gap = list.length;
    for (const [index, item] of list.entries()) {
      const box = item.getBoundingClientRect();
      if (x < box.left + box.width / 2) { gap = index; break; }
    }
    return gap;
  }
  function placeIndicator(gap) {
    const strip = role("strip");
    const list = thumbList();
    let indicator = strip.querySelector(".cs-drop");
    if (!indicator) { indicator = document.createElement("span"); indicator.className = "cs-drop"; indicator.setAttribute("aria-hidden", "true"); strip.append(indicator); }
    const stripBox = strip.getBoundingClientRect();
    const edge = gap < list.length ? list[gap].getBoundingClientRect().left - 5 : list.at(-1).getBoundingClientRect().right + 5;
    indicator.style.left = `${edge - stripBox.left + strip.scrollLeft - 2}px`;
  }
  function autoScroll() {
    if (!reorder?.active) return;
    const strip = role("strip");
    const box = strip.getBoundingClientRect();
    const speed = reorder.x < box.left + 48 ? -14 : reorder.x > box.right - 48 ? 14 : 0;
    if (speed) {
      strip.scrollLeft += speed;
      reorder.gap = gapAt(reorder.x);
      placeIndicator(reorder.gap);
    }
    reorder.frame = requestAnimationFrame(autoScroll);
  }
  function endReorder(commit) {
    if (!reorder) return;
    const { button, active, gap, frame } = reorder;
    cancelAnimationFrame(frame);
    button.classList.remove("cs-dragging");
    role("strip").querySelector(".cs-drop")?.remove();
    reorder = null;
    if (!active) return;
    suppressClick = true;
    setTimeout(() => { suppressClick = false; }, 0);
    const from = Number(button.dataset.index);
    const to = gap > from ? gap - 1 : gap;
    if (commit && Number.isInteger(to) && to !== from) {
      selectedFrame = button.dataset.frameId;
      void run({ action: "move-frame", frameId: button.dataset.frameId, toIndex: to });
    }
  }
  root.addEventListener("pointermove", (event) => {
    if (!reorder || event.pointerId !== reorder.pointerId) return;
    reorder.x = event.clientX;
    if (!reorder.active && Math.abs(event.clientX - reorder.startX) > 6) {
      reorder.active = true;
      reorder.button.classList.add("cs-dragging");
      reorder.frame = requestAnimationFrame(autoScroll);
    }
    if (reorder.active) { reorder.gap = gapAt(event.clientX); placeIndicator(reorder.gap); }
  });
  root.addEventListener("pointerup", (event) => { if (reorder && event.pointerId === reorder.pointerId) endReorder(true); });
  root.addEventListener("pointercancel", () => endReorder(false));
  root.addEventListener("keydown", (event) => { if (event.key === "Escape" && reorder) endReorder(false); });

  // The worker reports elapsed time with each view; the toolbar ticks locally
  // between views while Recording.
  let elapsedBase = null;
  let elapsedAt = 0;
  function renderElapsed() {
    const state = view?.currentJourney?.state;
    if (elapsedBase === null || !["Recording", "Paused"].includes(state)) { role("elapsed").textContent = ""; return; }
    const total = Math.floor((elapsedBase + (state === "Recording" ? performance.now() - elapsedAt : 0)) / 1000);
    const pad = (value) => String(value).padStart(2, "0");
    role("elapsed").textContent = `${total >= 3600 ? `${Math.floor(total / 3600)}:` : ""}${pad(Math.floor(total / 60) % 60)}:${pad(total % 60)}`;
  }
  setInterval(() => { if (!root.hidden && view?.currentJourney?.state === "Recording") renderElapsed(); }, 1000);
  function request(command) {
    command = { journeyId: view?.currentJourney?.id, ...command };
    const pending = requestTail.then(async () => {
      const result = await chrome.runtime.sendMessage({ type: "clicksheet:journey", command });
      if (!result?.ok) throw new Error(result?.error || "Reload the extension and reopen Clicksheet.");
      view = result.view;
      elapsedBase = Number.isFinite(view.elapsedMs) ? view.elapsedMs : null;
      elapsedAt = performance.now();
      if (view.notice) notice = view.notice;
      return view;
    });
    requestTail = pending.catch(() => {});
    return pending;
  }
  // One flush at a time: a call made while another is in flight waits for it
  // and then runs its own pass, so fields, revision and status are only ever
  // judged in order. Errors still reach each caller.
  function flushEdits() {
    if (editTimer !== null) { clearTimeout(editTimer); editTimer = null; }
    const pending = flushTail.then(flushOnce);
    flushTail = pending.catch(() => {});
    return pending;
  }
  async function flushOnce() {
    if (savedRevision === editRevision) return;
    const revision = editRevision;
    const fields = [...editedFields];
    editedFields.clear();
    try {
      // With no fields to send, refresh the view so a stale status is not judged.
      if (!fields.length) await request({ action: "snapshot" });
      if (fields.includes("name")) await request({ action: "rename", name: role("name").value });
      if (fields.includes("description")) await request({ action: "describe", description: role("description").value });
      // Held fields are kept and sent again on the next flush, which also
      // brings a fresh view once storage is reconnected.
      if (view.status !== "Saved locally" || view.hasUnsavedChanges) throw new Error("The change is held here. Reconnect the folder on the Storage page, then return to save it.");
    } catch (error) {
      for (const field of fields) editedFields.add(field);
      saveFailed = true;
      throw error;
    }
    saveFailed = false;
    savedRevision = Math.max(savedRevision, revision);
  }
  async function run(command) {
    if (busy) return;
    busy = true;
    if (command.action !== "snapshot") notice = "";
    let failure = null;
    render();
    try {
      await flushEdits();
      await request(command);
      if (command.action === "open" || command.action === "new") {
        selectedFrame = null;
        role("library").hidden = true;
        action("library").setAttribute("aria-expanded", "false");
        role("name").value = view.currentJourney?.name ?? "";
        role("description").value = view.currentJourney?.description ?? "";
      }
      if (command.action === "delete-frame") notice = "Screenshot deleted. Use Undo delete to restore it.";
      if (command.action === "undo-delete") selectedFrame = command.frameId ?? selectedFrame;
      // Recording is about the page, so the widget shrinks to its controls;
      // stopping brings back the strip for editing and export.
      if (command.action === "record" || command.action === "resume") setExpanded(false);
      if (command.action === "stop") setExpanded(true);
      if (["record", "resume", "capture"].includes(command.action)) {
        selectedFrame = view.currentJourney?.frames.at(-1)?.id ?? selectedFrame;
        const strip = role("strip");
        requestAnimationFrame(() => { strip.scrollLeft = strip.scrollWidth; });
      }
    } catch (error) { failure = error; }
    finally {
      busy = false;
      if (failure) notice = failure.message;
      render();
      if (refreshQueued) { refreshQueued = false; void run({ action: "snapshot" }); }
    }
  }

  // Automatic capture: report a click on the page, then report the first
  // visible DOM or URL change it causes. The worker decides whether to capture.
  function observing() {
    return Boolean(view?.recordingHere && view.currentJourney?.state === "Recording");
  }
  function sendEvent(event) {
    void chrome.runtime.sendMessage({ type: "clicksheet:page-event", event }).catch(() => {});
  }
  function stopWatch() {
    if (stopWatching) { stopWatching(); stopWatching = null; }
  }
  function rendered(node) {
    const element = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
    return Boolean(element?.isConnected && element.getClientRects().length);
  }
  // Clocks, tickers, and animations change constantly. An element that
  // changed at least three times in the three seconds before a click is
  // ambient, and its later changes do not qualify that click.
  const AMBIENT_WINDOW_MS = 3000;
  const AMBIENT_CHANGES = 3;
  let ambientObserver = null;
  let ambientHistory = new WeakMap();
  let ambientSince = new WeakMap();
  const changedElement = (record) => record.target?.nodeType === Node.ELEMENT_NODE ? record.target : record.target?.parentElement;
  // Clicks and keys can start slow async work, so their window is long.
  // Hover and focus styling applies at once, so theirs is short: the mouse
  // moves constantly, and a long window would hide every clock tick.
  let quietUntil = -Infinity;
  const INPUT_QUIET_MS = { pointerdown: WATCH_MS, click: WATCH_MS, keydown: WATCH_MS, pointerover: 150, pointerout: 150, focusin: 150 };
  for (const [type, quietMs] of Object.entries(INPUT_QUIET_MS)) {
    document.addEventListener(type, (event) => {
      if (event.isTrusted && event.target !== host) quietUntil = Math.max(quietUntil, performance.now() + quietMs);
    }, true);
  }
  function startAmbient() {
    if (ambientObserver) return;
    ambientHistory = new WeakMap();
    ambientSince = new WeakMap();
    ambientObserver = new MutationObserver((records) => {
      // Changes shortly after the user clicks, hovers, focuses, or types may
      // be their doing (async results, hover styles), so they are marked as
      // prompted. Ambience needs at least one change with no input nearby.
      const at = performance.now();
      const prompted = at < quietUntil;
      for (const record of records) {
        const element = changedElement(record);
        if (!element || ownChange(record)) continue;
        const history = ambientHistory.get(element) ?? [];
        // A quiet gap longer than the window ends ambience: the element has
        // stopped changing on its own.
        if (history.length && at - history.at(-1).at > AMBIENT_WINDOW_MS) ambientSince.delete(element);
        if (history.at(-1)?.at !== at) history.push({ at, prompted });
        // Keep what a click's watch can still ask about: the ambient window
        // before it plus the watch after it. Changes after a click must not
        // push out the ones before it.
        ambientHistory.set(element, history.filter((entry) => entry.at >= at - AMBIENT_WINDOW_MS - WATCH_MS).slice(-32));
        // Once an element shows it changes on its own, it stays ambient while
        // it keeps changing, even through typing or tabbing that marks every
        // later change as prompted.
        const recent = history.filter((entry) => entry.at >= at - AMBIENT_WINDOW_MS);
        if (recent.length >= AMBIENT_CHANGES && recent.some((entry) => !entry.prompted)) ambientSince.set(element, at);
      }
    });
    ambientObserver.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
  }
  // Watched from injection, so ambient changes are known before the first
  // click of a recording.
  startAmbient();
  function isAmbient(element, clickedAt) {
    const recent = (ambientHistory.get(element) ?? []).filter(({ at }) => at < clickedAt && at >= clickedAt - AMBIENT_WINDOW_MS);
    if (ambientSince.has(element) && ambientSince.get(element) < clickedAt && recent.length >= AMBIENT_CHANGES) return true;
    return recent.length >= AMBIENT_CHANGES && recent.some(({ prompted }) => !prompted);
  }
  function watchForChange() {
    stopWatch();
    const clickedAt = performance.now();
    const href = location.href;
    const changed = () => { stopWatch(); sendEvent({ type: "changed" }); };
    const mutations = new MutationObserver((records) => {
      if (records.some((record) => !ownChange(record) && rendered(record.target) && !isAmbient(changedElement(record), clickedAt))) changed();
    });
    mutations.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
    // pushState fires no event, so the URL is also polled briefly.
    const checkUrl = () => { if (location.href !== href) changed(); };
    const poll = setInterval(checkUrl, 100);
    const expire = setTimeout(stopWatch, WATCH_MS);
    window.addEventListener("popstate", checkUrl);
    window.addEventListener("hashchange", checkUrl);
    stopWatching = () => {
      mutations.disconnect();
      clearInterval(poll);
      clearTimeout(expire);
      window.removeEventListener("popstate", checkUrl);
      window.removeEventListener("hashchange", checkUrl);
    };
  }
  // Labels come only from the accessible name of interactive targets. Text in
  // paragraphs or editors is page content that a later redaction could not
  // remove from the export, so those targets are labelled just "Click".
  const TEXT_NAMED = "a[href], button, summary, label, [role='button'], [role='link'], [role='tab'], [role='menuitem'], [role='option'], [role='checkbox']";
  function describeTarget(element) {
    if (!element.matches(INTERACTIVE) || element.isContentEditable) return "";
    const clean = (text) => String(text ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
    const labelled = element.getAttribute("aria-labelledby")?.split(/\s+/).map((id) => document.getElementById(id)?.textContent).join(" ");
    if (element.matches(PASSWORD_SELECTOR)) return clean(element.getAttribute("aria-label") || element.labels?.[0]?.textContent || "Password");
    // Field values are never used as labels; button inputs expose theirs as text.
    const buttonValue = element.matches("input[type='submit'], input[type='button'], input[type='reset']") ? element.value : "";
    return clean(element.getAttribute("aria-label") || labelled || element.labels?.[0]?.textContent ||
      buttonValue || element.getAttribute("alt") || element.getAttribute("title") ||
      (element.matches("input, select, textarea") ? element.getAttribute("placeholder") || element.getAttribute("name") : element.matches(TEXT_NAMED) ? element.innerText : ""));
  }
  document.addEventListener("click", (event) => {
    if (!event.isTrusted || !observing() || !(event.target instanceof Element) || event.target === host) return;
    const element = event.target.closest(INTERACTIVE) ?? event.target;
    trackPassword(element);
    const rect = element.getBoundingClientRect();
    sendEvent({
      type: "click",
      click: {
        rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
        point: { x: event.clientX, y: event.clientY },
        scrollX: window.scrollX,
        scrollY: window.scrollY,
        label: describeTarget(element),
        pathname: location.pathname
      }
    });
    watchForChange();
  }, true);

  // Capture preparation: hide the toolbar and report password fields so their
  // pixels are covered before the screenshot is stored.
  // Password fields are tracked for as long as the toolbar is present, so a
  // field revealed by a "show password" toggle before any capture is still
  // treated as a password.
  function trackPassword(element) {
    // Frames have their own HTMLInputElement, so test by name, not instanceof.
    if (element?.localName === "input" && element.matches(PASSWORD_SELECTOR)) seenPasswords.add(element);
  }
  // Each reachable scope (the document, same-origin frame documents, and open
  // shadow roots) gets its own watcher: mutations and composed events do not
  // reveal what happens inside them from the outside.
  const watchedScopes = new WeakSet();
  const fromEvent = (event) => trackPassword(event.composedPath?.()[0] ?? event.target);
  function watchScope(scope) {
    if (!scope || watchedScopes.has(scope) || scope === shadow) return;
    watchedScopes.add(scope);
    const target = scope.documentElement ?? scope;
    new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === "attributes" && record.oldValue === "password") seenPasswords.add(record.target);
        else if (record.type === "attributes") trackPassword(record.target);
        for (const node of record.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          trackPassword(node);
          // A component attaches its shadow root on insertion and often fills
          // it later; watching the root catches the field when it appears.
          if (node.shadowRoot && node !== host) { watchScope(node.shadowRoot); scanPasswords(node.shadowRoot); }
          if (node.localName === "iframe" || node.localName === "frame") scanFrame(node);
          scanPasswords(node);
        }
      }
    }).observe(target, { subtree: true, childList: true, attributes: true, attributeFilter: ["type", "autocomplete"], attributeOldValue: true });
    for (const type of ["focusin", "input", "click"]) scope.addEventListener(type, fromEvent, true);
    // Frames that load later are watched as soon as they load.
    scope.addEventListener("load", (event) => { if (event.target?.localName === "iframe" || event.target?.localName === "frame") scanFrame(event.target); }, true);
  }
  function scanFrame(frame) {
    let doc = null;
    try { doc = frame.contentDocument; } catch { doc = null; }
    if (doc?.documentElement) { watchScope(doc); scanPasswords(doc); }
  }
  function scanPasswords(scope) {
    for (const element of scope.querySelectorAll?.(PASSWORD_SELECTOR) ?? []) seenPasswords.add(element);
    for (const child of scope.querySelectorAll?.("*") ?? []) {
      if (child.shadowRoot && child !== host) { watchScope(child.shadowRoot); scanPasswords(child.shadowRoot); }
      if (child.localName === "iframe" || child.localName === "frame") scanFrame(child);
    }
  }
  watchScope(document);
  scanPasswords(document);

  // Same-origin frames are searched too; their fields are offset by the
  // frame's position. Cross-origin frames cannot be inspected.
  function frameDocuments() {
    const found = [{ doc: document, x: 0, y: 0 }];
    for (let index = 0; index < found.length; index++) {
      for (const frame of found[index].doc.querySelectorAll("iframe, frame")) {
        let doc = null;
        try { doc = frame.contentDocument; } catch { doc = null; }
        if (!doc?.documentElement) continue;
        const box = frame.getBoundingClientRect();
        found.push({ doc, x: found[index].x + box.left + frame.clientLeft, y: found[index].y + box.top + frame.clientTop });
      }
    }
    return found;
  }
  function passwordFields() {
    scanPasswords(document);
    const fields = [];
    for (const { doc, x, y } of frameDocuments()) {
      for (const element of doc.querySelectorAll("input")) if (seenPasswords.has(element)) fields.push({ element, x, y });
    }
    // Open shadow roots, in the top document and in same-origin frames.
    const visit = (scope, x, y) => {
      for (const child of scope.querySelectorAll("*")) {
        if (!child.shadowRoot || child === host) continue;
        for (const element of child.shadowRoot.querySelectorAll("input")) if (seenPasswords.has(element)) fields.push({ element, x, y });
        visit(child.shadowRoot, x, y);
      }
    };
    for (const { doc, x, y } of frameDocuments()) visit(doc, x, y);
    return fields;
  }
  function passwordMasks() {
    return passwordFields().flatMap(({ element, x, y }) => [...element.getClientRects()].map((rect) => ({
      x: rect.left + x, y: rect.top + y, width: rect.width, height: rect.height
    }))).filter((box) => box.width > 0 && box.height > 0 && box.x < innerWidth && box.y < innerHeight && box.x + box.width > 0 && box.y + box.height > 0);
  }
  // While the pixels are taken, field text is made transparent as well, so a
  // layout shift between measuring and capturing cannot reveal characters.
  let coveredFields = null;
  const COVER = [["color", "transparent"], ["-webkit-text-fill-color", "transparent"], ["text-shadow", "none"], ["caret-color", "transparent"]];
  function coverPasswords() {
    if (coveredFields) return;
    coveredFields = passwordFields().map(({ element }) => {
      const saved = COVER.map(([name]) => [name, element.style.getPropertyValue(name), element.style.getPropertyPriority(name)]);
      styledForCapture.add(element);
      for (const [name, value] of COVER) element.style.setProperty(name, value, "important");
      return [element, saved];
    });
  }
  function uncoverPasswords() {
    for (const [element, saved] of coveredFields ?? []) {
      for (const [name, value, priority] of saved) {
        if (value) element.style.setProperty(name, value, priority);
        else element.style.removeProperty(name);
      }
    }
    coveredFields = null;
  }
  function afterPaint() {
    return new Promise((done) => {
      const fallback = setTimeout(done, 150);
      requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(fallback); done(); }));
    });
  }
  async function prepareCapture() {
    if (hiddenForCapture === null) hiddenForCapture = root.hidden;
    root.hidden = true;
    coverPasswords();
    await afterPaint();
    const page = document.scrollingElement ?? document.documentElement;
    return {
      title: document.title,
      pathname: location.pathname,
      viewport: { width: innerWidth, height: innerHeight, scrollX, scrollY, devicePixelRatio },
      scrollWidth: page.scrollWidth,
      scrollHeight: page.scrollHeight,
      masks: passwordMasks()
    };
  }
  // Full-page capture: scroll in steps and report where the page really is.
  async function scrollForCapture({ y, hideFixed }) {
    if (scrollBeforeCapture === null) scrollBeforeCapture = { x: scrollX, y: scrollY };
    if (hideFixed && hiddenFixed === null) {
      hiddenFixed = [];
      for (const element of document.body?.querySelectorAll("*") ?? []) {
        if (element === host) continue;
        const position = getComputedStyle(element).position;
        if (position !== "fixed" && position !== "sticky") continue;
        hiddenFixed.push([element, element.style.getPropertyValue("visibility"), element.style.getPropertyPriority("visibility")]);
        styledForCapture.add(element);
        element.style.setProperty("visibility", "hidden", "important");
      }
    }
    window.scrollTo({ left: scrollBeforeCapture.x, top: y, behavior: "instant" });
    await afterPaint();
    return { scrollY: window.scrollY, masks: passwordMasks() };
  }
  function restoreCapture() {
    const styled = [...(coveredFields ?? []).map(([element]) => element), ...(hiddenFixed ?? []).map(([element]) => element)];
    // Forget these once the restore's own mutations have been delivered, so
    // the page's later style changes on them count again.
    setTimeout(() => { for (const element of styled) styledForCapture.delete(element); }, 0);
    uncoverPasswords();
    for (const [element, value, priority] of hiddenFixed ?? []) {
      if (value) element.style.setProperty("visibility", value, priority);
      else element.style.removeProperty("visibility");
    }
    hiddenFixed = null;
    if (scrollBeforeCapture !== null) window.scrollTo({ left: scrollBeforeCapture.x, top: scrollBeforeCapture.y, behavior: "instant" });
    scrollBeforeCapture = null;
    if (hiddenForCapture !== null) root.hidden = hiddenForCapture;
    hiddenForCapture = null;
  }

  // Copy must call the clipboard inside the click, so the rendered PNG is
  // passed to it as a promise. Download stays available if copying fails.
  function pngFromDataUrl(dataUrl) {
    const binary = atob(dataUrl.slice(dataUrl.indexOf(",") + 1));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    return new Blob([bytes], { type: "image/png" });
  }
  function copyImage() {
    if (busy) return;
    toggleMenu("export-menu", false);
    busy = true;
    notice = "Preparing the image…";
    render();
    const rendered = request({ action: "export", destination: "copy" }).then((result) => pngFromDataUrl(result.image));
    let copied;
    try {
      if (!navigator.clipboard?.write || typeof ClipboardItem !== "function") throw new Error("unsupported");
      copied = navigator.clipboard.write([new ClipboardItem({ "image/png": rendered })]);
    } catch (error) {
      copied = Promise.reject(error);
    }
    Promise.allSettled([rendered, copied]).then(([image, clipboard]) => {
      if (image.status === "rejected") notice = image.reason.message;
      else if (clipboard.status === "rejected") notice = "The image could not be copied on this page. Use Download image instead.";
      else notice = "Copied the contact sheet. Paste it into your agent or issue.";
    }).finally(() => { busy = false; render(); });
  }
  function toggleMenu(name, open) {
    const menu = role(name);
    const button = action(name === "export-menu" ? "export" : "settings");
    menu.hidden = open === undefined ? !menu.hidden : !open;
    button.setAttribute("aria-expanded", String(!menu.hidden));
  }

  // Widget placement. The pill's position is remembered across pages; the
  // default is the bottom-right corner, clear of top navigation. The panel
  // opens upwards when the pill sits in the lower half of the viewport.
  const WIDGET_KEY = "clicksheet-widget";
  const EDGE = 8;
  const widget = { x: null, y: null, expanded: true };
  function placeWidget() {
    if (root.hidden) return;
    const pill = root.querySelector(".cs-pill");
    const pillBox = { width: pill.offsetWidth, height: pill.offsetHeight };
    const px = Math.min(Math.max(EDGE, widget.x ?? innerWidth - pillBox.width - 24), Math.max(EDGE, innerWidth - pillBox.width - EDGE));
    const py = Math.min(Math.max(EDGE, widget.y ?? innerHeight - pillBox.height - 24), Math.max(EDGE, innerHeight - pillBox.height - EDGE));
    const up = py + pillBox.height / 2 > innerHeight / 2;
    root.dataset.up = String(up);
    const height = root.offsetHeight;
    const width = root.offsetWidth;
    const top = up ? py - (height - pillBox.height) : py;
    root.style.left = `${Math.min(Math.max(EDGE, px), Math.max(EDGE, innerWidth - width - EDGE))}px`;
    root.style.top = `${Math.min(Math.max(EDGE, top), Math.max(EDGE, innerHeight - height - EDGE))}px`;
  }
  function saveWidget() {
    void chrome.storage.local.set({ [WIDGET_KEY]: { x: widget.x, y: widget.y, expanded: widget.expanded } }).catch(() => {});
  }
  function setExpanded(open, { save = true } = {}) {
    widget.expanded = open;
    role("panel").hidden = !open;
    root.dataset.expanded = String(open);
    action("expand").setAttribute("aria-expanded", String(open));
    action("expand").textContent = open ? "▾" : "▴";
    action("expand").setAttribute("aria-label", open ? "Collapse to the recording controls" : "Show screenshots and editing");
    action("expand").title = action("expand").getAttribute("aria-label");
    if (!open) { toggleMenu("export-menu", false); toggleMenu("settings-menu", false); role("library").hidden = true; }
    placeWidget();
    if (open) requestAnimationFrame(() => {
      const strip = role("strip");
      if (selectedFrame) revealSelected(); else strip.scrollLeft = strip.scrollWidth;
      updateStripButtons();
    });
    if (save) saveWidget();
  }
  chrome.storage.local.get(WIDGET_KEY).then((stored) => {
    Object.assign(widget, stored?.[WIDGET_KEY] ?? {});
    setExpanded(widget.expanded !== false, { save: false });
  }, () => setExpanded(true, { save: false }));
  new ResizeObserver(() => placeWidget()).observe(root);
  window.addEventListener("resize", () => placeWidget());
  action("expand").addEventListener("click", () => setExpanded(!widget.expanded));

  // Moving: drag the grip, or focus it and use the arrow keys.
  let move = null;
  const grip = action("drag");
  const pillPosition = () => {
    const box = root.querySelector(".cs-pill").getBoundingClientRect();
    return { x: box.left, y: box.top };
  };
  grip.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    // preventDefault stops text selection while dragging, but also the
    // default focus; focus explicitly so the arrow keys work after a click.
    event.preventDefault();
    grip.focus();
    const start = pillPosition();
    move = { pointerId: event.pointerId, dx: event.clientX - start.x, dy: event.clientY - start.y };
    grip.setPointerCapture(event.pointerId);
    root.dataset.moving = "true";
  });
  grip.addEventListener("pointermove", (event) => {
    if (!move || event.pointerId !== move.pointerId) return;
    widget.x = event.clientX - move.dx;
    widget.y = event.clientY - move.dy;
    placeWidget();
  });
  const endMove = () => {
    if (!move) return;
    move = null;
    delete root.dataset.moving;
    Object.assign(widget, pillPosition());
    saveWidget();
  };
  grip.addEventListener("pointerup", endMove);
  grip.addEventListener("pointercancel", endMove);
  grip.addEventListener("keydown", (event) => {
    const step = event.shiftKey ? 64 : 16;
    const delta = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[event.key];
    if (!delta) return;
    event.preventDefault();
    const current = pillPosition();
    widget.x = current.x + delta[0];
    widget.y = current.y + delta[1];
    placeWidget();
    Object.assign(widget, pillPosition());
    saveWidget();
  });

  // Strip navigation: arrow buttons and the mouse wheel scroll sideways.
  const strip = role("strip");
  action("strip-prev").addEventListener("click", () => strip.scrollBy({ left: -strip.clientWidth * 0.8, behavior: "smooth" }));
  action("strip-next").addEventListener("click", () => strip.scrollBy({ left: strip.clientWidth * 0.8, behavior: "smooth" }));
  strip.addEventListener("scroll", () => updateStripButtons(), { passive: true });
  strip.addEventListener("wheel", (event) => {
    if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
    event.preventDefault();
    strip.scrollLeft += event.deltaY;
  }, { passive: false });

  // Chrome assigns suggested shortcuts only on first install, so show which
  // are really set and offer the page that sets them.
  async function refreshShortcuts() {
    const shortcuts = await chrome.runtime.sendMessage({ type: "clicksheet:shortcuts" }).catch(() => ({}));
    const describe = (key) => key || "not set";
    role("shortcut-list").textContent = `Capture: ${describe(shortcuts?.capture)} · Show/hide: ${describe(shortcuts?.toggle)}`;
    action("capture").title = shortcuts?.capture
      ? `Capture the current page (${shortcuts.capture} keeps hover and focus states)`
      : "Capture the current page. Set a keyboard shortcut in Settings to keep hover and focus states.";
  }
  void refreshShortcuts();
  action("open-shortcuts").addEventListener("click", () => { void chrome.runtime.sendMessage({ type: "clicksheet:open-shortcuts" }); });

  // Viewer: a modal for looking at one screenshot at a time, with the click
  // marker, moving through the Journey with the buttons or arrow keys.
  const viewerImages = new Map();
  let viewerFrame = null;
  let viewerReturn = null;
  function viewerFrames() {
    return view?.currentJourney?.frames ?? [];
  }
  function openViewer(frameId) {
    if (!frameId || !view?.available) return;
    viewerReturn = shadow.activeElement;
    role("viewer").hidden = false;
    showViewerFrame(frameId);
    action("viewer-close").focus();
  }
  function closeViewer() {
    if (role("viewer").hidden) return;
    role("viewer").hidden = true;
    viewerFrame = null;
    role("viewer-image").removeAttribute("src");
    (thumbs.get(selectedFrame) ?? viewerReturn)?.focus?.();
  }
  async function showViewerFrame(frameId) {
    const frames = viewerFrames();
    const index = frames.findIndex((frame) => frame.id === frameId);
    if (index === -1) { closeViewer(); return; }
    const frame = frames[index];
    viewerFrame = frame.id;
    selectedFrame = frame.id;
    render();
    role("viewer-title").textContent = [`${index + 1} of ${frames.length}`, frameLabel(frame), frame.title, frame.pathname].filter(Boolean).join(" · ");
    action("viewer-prev").disabled = index === 0;
    action("viewer-next").disabled = index === frames.length - 1;
    action("viewer-redact").disabled = !view?.editable;
    const key = `${view.currentJourney.id}:${frame.screenshotFile}`;
    const image = role("viewer-image");
    if (!viewerImages.has(key)) {
      image.removeAttribute("src");
      role("viewer-status").textContent = "Loading…";
      const result = await chrome.runtime.sendMessage({ type: "clicksheet:journey", command: { action: "view-frame", journeyId: view.currentJourney.id, frameId: frame.id } }).catch(() => null);
      if (result?.ok && result.view?.image?.startsWith("data:image/png;base64,")) {
        viewerImages.set(key, result.view.image);
        // Large previews: keep only a few.
        while (viewerImages.size > 6) viewerImages.delete(viewerImages.keys().next().value);
      }
    }
    if (viewerFrame !== frame.id) return;
    if (viewerImages.has(key)) {
      image.src = viewerImages.get(key);
      image.alt = `Screenshot ${index + 1}: ${frameLabel(frame)}`;
      role("viewer-status").textContent = "";
      role("viewer-stage").scrollTo(0, 0);
    } else {
      role("viewer-status").textContent = "This screenshot could not be loaded. Reconnect storage and try again.";
    }
  }
  function stepViewer(offset) {
    const frames = viewerFrames();
    const index = frames.findIndex((frame) => frame.id === viewerFrame);
    const next = frames[index + offset];
    if (next) void showViewerFrame(next.id);
  }
  action("view").addEventListener("click", () => openViewer(selectedFrame));
  action("viewer-prev").addEventListener("click", () => stepViewer(-1));
  action("viewer-next").addEventListener("click", () => stepViewer(1));
  action("viewer-close").addEventListener("click", closeViewer);
  action("viewer-redact").addEventListener("click", () => {
    if (!viewerFrame || !view?.currentJourney) return;
    void chrome.runtime.sendMessage({ type: "clicksheet:open-editor", journeyId: view.currentJourney.id, frameId: viewerFrame });
    closeViewer();
  });
  // A click on the dark backdrop (not the image or controls) closes it.
  role("viewer").addEventListener("click", (event) => {
    if (event.target === role("viewer") || event.target === role("viewer-stage")) closeViewer();
  });
  role("viewer").addEventListener("keydown", (event) => {
    if (event.key === "Escape") { event.preventDefault(); closeViewer(); }
    else if (event.key === "ArrowLeft") { event.preventDefault(); stepViewer(-1); }
    else if (event.key === "ArrowRight") { event.preventDefault(); stepViewer(1); }
    else if (event.key === "Tab") {
      // Keep keyboard focus inside the dialog.
      const controls = [...role("viewer").querySelectorAll("button:not(:disabled)")];
      const at = controls.indexOf(shadow.activeElement);
      if (event.shiftKey && at <= 0) { event.preventDefault(); controls.at(-1).focus(); }
      else if (!event.shiftKey && at === controls.length - 1) { event.preventDefault(); controls[0].focus(); }
    }
  });

  // The remaining count appears only near the limit.
  function renderDescriptionCount() {
    const field = role("description");
    const left = field.maxLength - field.value.length;
    role("description-count").textContent = left <= 40 ? `${left} left` : "";
  }
  function scheduleEdit(field) {
    editedFields.add(field);
    editRevision += 1;
    role("save-status").textContent = saveFailed || view?.status === "Storage unavailable" ? "Storage unavailable" : "Saving";
    clearTimeout(editTimer);
    editTimer = setTimeout(async () => {
      try { await flushEdits(); render(); }
      catch (error) { role("save-status").textContent = "Storage unavailable"; role("message").textContent = error.message; }
    }, 400);
  }
  role("name").addEventListener("input", () => scheduleEdit("name"));
  role("description").addEventListener("input", () => { renderDescriptionCount(); scheduleEdit("description"); });
  action("library").addEventListener("click", () => {
    role("library").hidden = !role("library").hidden;
    action("library").setAttribute("aria-expanded", String(!role("library").hidden));
  });
  action("new").addEventListener("click", () => run({ action: "new" }));
  for (const name of ["record", "pause", "resume", "stop", "capture"]) action(name).addEventListener("click", () => run({ action: name }));
  action("export").addEventListener("click", () => { toggleMenu("settings-menu", false); toggleMenu("export-menu"); });
  action("settings").addEventListener("click", () => { toggleMenu("export-menu", false); toggleMenu("settings-menu"); void refreshShortcuts(); });
  action("copy-image").addEventListener("click", copyImage);
  action("download-image").addEventListener("click", () => { toggleMenu("export-menu", false); void run({ action: "export", destination: "download" }); });
  role("settings-menu").addEventListener("submit", (event) => {
    event.preventDefault();
    toggleMenu("settings-menu", false);
    void run({ action: "settings", settings: { captureArea: role("capture-area").value, captureDelayMs: Number(role("capture-delay").value) } });
  });
  const moveSelected = (offset) => {
    const frames = view?.currentJourney?.frames ?? [];
    const index = frames.findIndex((frame) => frame.id === selectedFrame);
    if (index !== -1) void run({ action: "move-frame", frameId: selectedFrame, toIndex: index + offset });
  };
  action("move-left").addEventListener("click", () => moveSelected(-1));
  action("move-right").addEventListener("click", () => moveSelected(1));
  action("delete").addEventListener("click", () => { if (selectedFrame) void run({ action: "delete-frame", frameId: selectedFrame }); });
  // The restored screenshot is selected so the strip brings it into view.
  action("undo").addEventListener("click", () => run({ action: "undo-delete", frameId: view?.undo?.frameId }));
  action("edit").addEventListener("click", () => {
    if (!selectedFrame || !view?.currentJourney) return;
    void chrome.runtime.sendMessage({ type: "clicksheet:open-editor", journeyId: view.currentJourney.id, frameId: selectedFrame });
  });
  action("storage").addEventListener("click", () => { void flushEdits().catch(() => {}); void chrome.runtime.sendMessage({ type: "clicksheet:open-storage" }); });
  action("dismiss").addEventListener("click", () => { root.hidden = true; void flushEdits().catch(() => {}); });
  window.addEventListener("beforeunload", (event) => {
    if (savedRevision !== editRevision || view?.hasUnsavedChanges) { event.preventDefault(); event.returnValue = ""; }
  });
  window.addEventListener("focus", () => { if (!root.hidden && !busy) void run({ action: "snapshot" }); });
  // A hidden tab keeps ticking locally; refresh the real elapsed time on return.
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && !root.hidden && !busy) void run({ action: "snapshot" }); });
  const controller = {
    open() { root.hidden = false; placeWidget(); void run({ action: "snapshot" }); },
    close() { root.hidden = true; },
    render(state) { role("message").textContent = state.message; role("state").textContent = "Unavailable"; }
  };
  window.__clicksheetToolbar = controller;
  chrome.runtime.onMessage.addListener((message, _sender, respond) => {
    if (message?.type === "clicksheet:open") controller.open();
    if (message?.type === "clicksheet:state") controller.render(message);
    if (message?.type === "clicksheet:refresh") {
      if (busy) refreshQueued = true;
      else void run({ action: "snapshot" });
    }
    if (message?.type === "clicksheet:prepare-capture") {
      prepareCapture().then(respond, () => respond(null));
      return true;
    }
    if (message?.type === "clicksheet:toggle") {
      // During a capture the widget is hidden only for the screenshot; toggle
      // the state it will return to.
      if (hiddenForCapture !== null) hiddenForCapture = !hiddenForCapture;
      else if (root.hidden) controller.open();
      else root.hidden = true;
      respond(true);
      return;
    }
    if (message?.type === "clicksheet:ping") {
      respond(true);
      return;
    }
    if (message?.type === "clicksheet:notice") {
      // A failed shortcut capture must be visible even if the toolbar was hidden.
      notice = String(message.text ?? "");
      root.hidden = false;
      render();
    }
    if (message?.type === "clicksheet:scroll-capture") {
      scrollForCapture(message).then(respond, () => respond(null));
      return true;
    }
    if (message?.type === "clicksheet:restore-capture") {
      restoreCapture();
      respond(true);
    }
  });
  render();
  void run({ action: "snapshot" });
})();
