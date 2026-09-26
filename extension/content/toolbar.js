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
  const root = document.createElement("aside");
  root.id = ROOT_ID;
  root.setAttribute("role", "region");
  root.setAttribute("aria-label", "Clicksheet");
  root.innerHTML = `
    <div class="clicksheet-toolbar__surface">
      <div class="clicksheet-toolbar__journey">
        <div class="clicksheet-toolbar__heading">
          <span class="clicksheet-toolbar__mark" aria-hidden="true">C</span>
          <strong>Clicksheet</strong>
          <input data-role="name" aria-label="Journey name" placeholder="Choose or create a Journey">
          <button type="button" data-action="library" aria-expanded="false">Journeys</button>
        </div>
        <div data-role="library" class="clicksheet-toolbar__library" hidden>
          <button type="button" data-action="new">New Journey</button>
          <div data-role="journeys"></div>
        </div>
        <div class="clicksheet-toolbar__strip" data-role="strip" aria-label="Journey screenshots"></div>
      </div>
      <div class="clicksheet-toolbar__controls">
        <div><span data-role="state">Ready</span><span data-role="save-status" aria-live="polite"></span></div>
        <div class="clicksheet-toolbar__actions">
          <button type="button" data-action="record" disabled>Record</button>
          <button type="button" data-action="pause" hidden disabled>Pause</button>
          <button type="button" data-action="resume" hidden disabled>Resume</button>
          <button type="button" data-action="stop" hidden disabled>Stop</button>
          <button type="button" data-action="capture" disabled>Capture</button>
          <button type="button" data-action="export" disabled>Export</button>
          <button type="button" data-action="storage">Storage</button>
          <button type="button" data-action="dismiss">Hide</button>
        </div>
        <p data-role="message" aria-live="polite">Connecting to your local library…</p>
      </div>
    </div>`;
  document.documentElement.append(root);
  const role = (name) => root.querySelector(`[data-role="${name}"]`);
  const action = (name) => root.querySelector(`[data-action="${name}"]`);
  let view = null;
  let selectedFrame = null;
  let busy = false;
  let refreshQueued = false;
  let renameTimer = null;
  let renameRevision = 0;
  let savedRevision = 0;
  let saveFailed = false;
  let notice = "";
  let requestTail = Promise.resolve();
  let stopWatching = null;
  let hiddenForCapture = null;
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
    if (document.activeElement !== role("name") && savedRevision === renameRevision) role("name").value = journey?.name ?? "";
    role("name").disabled = busy || !journey || !view?.renamable;
    role("state").textContent = journey?.state ?? "Ready";
    role("save-status").textContent = saveFailed || view?.status === "Storage unavailable" ? "Storage unavailable" : savedRevision < renameRevision ? "Saving" : view?.status ?? "";
    role("message").textContent = notice || view?.message?.text || statusMessage(journey);
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
    observer.disconnect();
    role("strip").replaceChildren(...(journey?.frames ?? []).map((frame, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "clicksheet-toolbar__frame";
      button.setAttribute("aria-pressed", String(frame.id === selectedFrame));
      button.title = [frame.title, frame.pathname].filter(Boolean).join(" · ");
      const label = document.createElement("span");
      label.textContent = `${index + 1}. ${frameLabel(frame)}`;
      button.append(label);
      // Screenshot files are never rewritten in place, so the file name is a
      // stable cache key across Journey saves.
      button.dataset.previewKey = `${journey.id}:${frame.screenshotFile}`;
      button.dataset.frameId = frame.id;
      button.dataset.journeyId = journey.id;
      observer.observe(button);
      button.addEventListener("click", () => { selectedFrame = frame.id; render(); });
      return button;
    }));
    const add = document.createElement("button");
    add.type = "button";
    add.className = "clicksheet-toolbar__add";
    add.textContent = "+ Add screenshot";
    add.disabled = busy || !controls.capture;
    add.title = "Capture the current page";
    add.addEventListener("click", () => run({ action: "capture" }));
    role("strip").append(add);
    if (!observing()) stopWatch();
  }

  function request(command) {
    command = { journeyId: view?.currentJourney?.id, ...command };
    const pending = requestTail.then(async () => {
      const result = await chrome.runtime.sendMessage({ type: "clicksheet:journey", command });
      if (!result?.ok) throw new Error(result?.error || "Reload the extension and reopen Clicksheet.");
      view = result.view;
      if (view.notice) notice = view.notice;
      return view;
    });
    requestTail = pending.catch(() => {});
    return pending;
  }
  async function flushRename() {
    if (renameTimer !== null) { clearTimeout(renameTimer); renameTimer = null; }
    if (savedRevision === renameRevision) return;
    const revision = renameRevision;
    const name = role("name").value;
    try { await request({ action: "rename", name }); }
    catch (error) { saveFailed = true; throw error; }
    if (view.status !== "Saved locally" || view.hasUnsavedChanges) { saveFailed = true; throw new Error("The rename is held here. Reconnect the folder on the Storage page, then return to save it."); }
    saveFailed = false;
    savedRevision = revision;
  }
  async function run(command) {
    if (busy) return;
    busy = true;
    if (command.action !== "snapshot") notice = "";
    let failure = null;
    render();
    try {
      await flushRename();
      await request(command);
      if (command.action === "open" || command.action === "new") {
        selectedFrame = null;
        role("library").hidden = true;
        action("library").setAttribute("aria-expanded", "false");
        role("name").value = view.currentJourney?.name ?? "";
      }
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
  function watchForChange() {
    stopWatch();
    const href = location.href;
    const changed = () => { stopWatch(); sendEvent({ type: "changed" }); };
    const mutations = new MutationObserver((records) => {
      if (records.some((record) => !root.contains(record.target) && rendered(record.target))) changed();
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
  function describeTarget(element) {
    const clean = (text) => String(text ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
    const labelled = element.getAttribute("aria-labelledby")?.split(/\s+/).map((id) => document.getElementById(id)?.textContent).join(" ");
    if (element.matches(PASSWORD_SELECTOR)) return clean(element.getAttribute("aria-label") || element.labels?.[0]?.textContent || "Password");
    // Field values are never used as labels; button inputs expose theirs as text.
    const buttonValue = element.matches("input[type='submit'], input[type='button'], input[type='reset']") ? element.value : "";
    return clean(element.getAttribute("aria-label") || labelled || element.labels?.[0]?.textContent ||
      buttonValue || element.getAttribute("alt") || element.getAttribute("title") ||
      (element.matches("input, select, textarea") ? element.getAttribute("placeholder") || element.getAttribute("name") : element.innerText));
  }
  document.addEventListener("click", (event) => {
    if (!event.isTrusted || !observing() || !(event.target instanceof Element) || root.contains(event.target)) return;
    const element = event.target.closest(INTERACTIVE) ?? event.target;
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
  function passwordFields() {
    const found = [];
    const visit = (scope) => {
      for (const element of scope.querySelectorAll(PASSWORD_SELECTOR)) { seenPasswords.add(element); found.push(element); }
      for (const host of scope.querySelectorAll("*")) if (host.shadowRoot) visit(host.shadowRoot);
    };
    visit(document);
    // A "show password" toggle turns the field into plain text; keep masking it.
    for (const element of document.querySelectorAll("input")) if (seenPasswords.has(element) && !found.includes(element)) found.push(element);
    return found;
  }
  function passwordMasks() {
    return passwordFields().flatMap((element) => [...element.getClientRects()].map((rect) => ({
      x: rect.left, y: rect.top, width: rect.width, height: rect.height
    }))).filter((box) => box.width > 0 && box.height > 0 && box.x < innerWidth && box.y < innerHeight && box.x + box.width > 0 && box.y + box.height > 0);
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
    await afterPaint();
    return {
      title: document.title,
      pathname: location.pathname,
      viewport: { width: innerWidth, height: innerHeight, scrollX, scrollY, devicePixelRatio },
      masks: passwordMasks()
    };
  }
  function restoreCapture() {
    if (hiddenForCapture !== null) root.hidden = hiddenForCapture;
    hiddenForCapture = null;
  }

  role("name").addEventListener("input", () => {
    renameRevision += 1;
    role("save-status").textContent = saveFailed || view?.status === "Storage unavailable" ? "Storage unavailable" : "Saving";
    clearTimeout(renameTimer);
    renameTimer = setTimeout(async () => {
      try { await flushRename(); render(); }
      catch (error) { role("save-status").textContent = "Storage unavailable"; role("message").textContent = error.message; }
    }, 400);
  });
  action("library").addEventListener("click", () => {
    role("library").hidden = !role("library").hidden;
    action("library").setAttribute("aria-expanded", String(!role("library").hidden));
  });
  action("new").addEventListener("click", () => run({ action: "new" }));
  for (const name of ["record", "pause", "resume", "stop", "capture"]) action(name).addEventListener("click", () => run({ action: name }));
  action("storage").addEventListener("click", () => { void flushRename().catch(() => {}); void chrome.runtime.sendMessage({ type: "clicksheet:open-storage" }); });
  action("dismiss").addEventListener("click", () => { root.hidden = true; void flushRename().catch(() => {}); });
  window.addEventListener("beforeunload", (event) => {
    if (savedRevision !== renameRevision || view?.hasUnsavedChanges) { event.preventDefault(); event.returnValue = ""; }
  });
  window.addEventListener("focus", () => { if (!root.hidden && !busy) void run({ action: "snapshot" }); });
  const controller = {
    open() { root.hidden = false; void run({ action: "snapshot" }); },
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
    if (message?.type === "clicksheet:restore-capture") {
      restoreCapture();
      respond(true);
    }
  });
  render();
  void run({ action: "snapshot" });
})();
