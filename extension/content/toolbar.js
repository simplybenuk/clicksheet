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
        <div class="clicksheet-toolbar__frame-actions" data-role="frame-actions">
          <button type="button" data-action="move-left" disabled>Move left</button>
          <button type="button" data-action="move-right" disabled>Move right</button>
          <button type="button" data-action="edit" disabled>Redact…</button>
          <button type="button" data-action="delete" disabled>Delete</button>
          <button type="button" data-action="undo" hidden>Undo delete</button>
        </div>
      </div>
      <div class="clicksheet-toolbar__controls">
        <div><span data-role="state">Ready</span><span data-role="save-status" aria-live="polite"></span></div>
        <div class="clicksheet-toolbar__actions">
          <button type="button" data-action="record" disabled>Record</button>
          <button type="button" data-action="pause" hidden disabled>Pause</button>
          <button type="button" data-action="resume" hidden disabled>Resume</button>
          <button type="button" data-action="stop" hidden disabled>Stop</button>
          <button type="button" data-action="capture" disabled>Capture</button>
          <button type="button" data-action="export" aria-expanded="false" disabled>Export</button>
          <button type="button" data-action="settings" aria-expanded="false">Settings</button>
          <button type="button" data-action="storage">Storage</button>
          <button type="button" data-action="dismiss">Hide</button>
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
          <p>Screenshots stay in the folder you chose on this device. They can still show sensitive details you did not redact.</p>
        </form>
        <p data-role="message" aria-live="polite">Connecting to your local library…</p>
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
  let renameTimer = null;
  let renameRevision = 0;
  let savedRevision = 0;
  let saveFailed = false;
  let notice = "";
  let requestTail = Promise.resolve();
  let stopWatching = null;
  let hiddenForCapture = null;
  let scrollBeforeCapture = null;
  let hiddenFixed = null;
  let draggedFrame = null;
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
    if (shadow.activeElement !== role("name") && savedRevision === renameRevision) role("name").value = journey?.name ?? "";
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
    action("export").disabled = busy || !view?.canExport;
    if (action("export").disabled) toggleMenu("export-menu", false);
    const frames = journey?.frames ?? [];
    const selectedIndex = frames.findIndex((frame) => frame.id === selectedFrame);
    if (selectedIndex === -1) selectedFrame = null;
    const editable = Boolean(view?.editable) && !busy && selectedIndex !== -1;
    action("move-left").disabled = !editable || selectedIndex === 0;
    action("move-right").disabled = !editable || selectedIndex === frames.length - 1;
    action("edit").disabled = !editable;
    action("delete").disabled = !editable;
    action("undo").hidden = !view?.undo;
    action("undo").disabled = busy || !view?.editable;
    if (shadow.activeElement !== role("capture-delay") && journey) {
      role("capture-area").value = journey.settings?.captureArea ?? "viewport";
      role("capture-delay").value = String(journey.settings?.captureDelayMs ?? 500);
    }
    action("save-settings").disabled = busy || !journey || !view?.editable;
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
      button.addEventListener("keydown", (event) => {
        if ((event.key === "Delete" || event.key === "Backspace") && !action("delete").disabled) { selectedFrame = frame.id; void run({ action: "delete-frame", frameId: frame.id }); }
      });
      // Drag and drop reorders; Move left/right offers the same without a pointer.
      button.draggable = Boolean(view?.editable);
      button.addEventListener("dragstart", (event) => { draggedFrame = frame.id; event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", ""); });
      button.addEventListener("dragend", () => { draggedFrame = null; });
      button.addEventListener("dragover", (event) => { if (draggedFrame && draggedFrame !== frame.id) event.preventDefault(); });
      button.addEventListener("drop", (event) => {
        event.preventDefault();
        const moving = draggedFrame;
        draggedFrame = null;
        if (moving && moving !== frame.id) { selectedFrame = moving; void run({ action: "move-frame", frameId: moving, toIndex: index }); }
      });
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
      if (command.action === "delete-frame") notice = "Screenshot deleted. Use Undo delete to restore it.";
      if (command.action === "undo-delete") selectedFrame = command.frameId ?? selectedFrame;
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
      if (records.some((record) => record.target !== host && rendered(record.target))) changed();
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
    if (element instanceof HTMLInputElement && element.matches(PASSWORD_SELECTOR)) seenPasswords.add(element);
  }
  function scanPasswords(scope) {
    for (const element of scope.querySelectorAll?.(PASSWORD_SELECTOR) ?? []) seenPasswords.add(element);
    for (const child of scope.querySelectorAll?.("*") ?? []) if (child.shadowRoot) scanPasswords(child.shadowRoot);
  }
  scanPasswords(document);
  new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === "attributes" && record.oldValue === "password") seenPasswords.add(record.target);
      else if (record.type === "attributes") trackPassword(record.target);
      for (const node of record.addedNodes) if (node.nodeType === Node.ELEMENT_NODE) { trackPassword(node); scanPasswords(node); }
    }
  }).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ["type", "autocomplete"], attributeOldValue: true });
  document.addEventListener("focusin", (event) => trackPassword(event.target), true);
  document.addEventListener("input", (event) => trackPassword(event.target), true);

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
    const fields = [];
    for (const { doc, x, y } of frameDocuments()) {
      if (doc !== document) scanPasswords(doc);
      for (const element of doc.querySelectorAll("input")) if (seenPasswords.has(element)) fields.push({ element, x, y });
    }
    // Open shadow roots in the top document.
    const visit = (scope) => {
      for (const child of scope.querySelectorAll("*")) {
        if (!child.shadowRoot || child === host) continue;
        for (const element of child.shadowRoot.querySelectorAll("input")) if (seenPasswords.has(element)) fields.push({ element, x: 0, y: 0 });
        visit(child.shadowRoot);
      }
    };
    visit(document);
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
        element.style.setProperty("visibility", "hidden", "important");
      }
    }
    window.scrollTo({ left: scrollBeforeCapture.x, top: y, behavior: "instant" });
    await afterPaint();
    return { scrollY: window.scrollY, masks: passwordMasks() };
  }
  function restoreCapture() {
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
  action("export").addEventListener("click", () => { toggleMenu("settings-menu", false); toggleMenu("export-menu"); });
  action("settings").addEventListener("click", () => { toggleMenu("export-menu", false); toggleMenu("settings-menu"); });
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
  action("undo").addEventListener("click", () => run({ action: "undo-delete" }));
  action("edit").addEventListener("click", () => {
    if (!selectedFrame || !view?.currentJourney) return;
    void chrome.runtime.sendMessage({ type: "clicksheet:open-editor", journeyId: view.currentJourney.id, frameId: selectedFrame });
  });
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
