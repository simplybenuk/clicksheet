(() => {
  if (window.__clicksheetToolbar) {
    window.__clicksheetToolbar.open();
    return;
  }
  const ROOT_ID = "clicksheet-toolbar-root";
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
  let renameTimer = null;
  let renameRevision = 0;
  let savedRevision = 0;
  let saveFailed = false;
  let requestTail = Promise.resolve();
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

  function render() {
    const journey = view?.currentJourney;
    if (document.activeElement !== role("name") && savedRevision === renameRevision) role("name").value = journey?.name ?? "";
    role("name").disabled = busy || !journey || !view?.renamable;
    role("state").textContent = journey?.state ?? "Ready";
    role("save-status").textContent = saveFailed || view?.status === "Storage unavailable" ? "Storage unavailable" : savedRevision < renameRevision ? "Saving" : view?.status ?? "";
    const unavailable = view?.status === "Storage unavailable";
    role("message").textContent = view?.message?.text || (unavailable ? "Reconnect the folder on the Storage page." : journey ? "Recording is unavailable in this build. Your Journey is saved locally." : "Choose a folder in Storage, then create or open a Journey.");
    action("new").disabled = busy || !view?.editable || (journey && !view.controls?.newJourney);
    role("journeys").replaceChildren(...(view?.journeys ?? []).map((item) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = item.name;
      button.setAttribute("aria-current", String(item.id === journey?.id));
      button.disabled = busy || (journey && !view.controls?.openJourney);
      button.addEventListener("click", () => run({ action: "open", id: item.id }));
      return button;
    }));
    for (const name of ["record", "pause", "resume", "stop"]) {
      action(name).hidden = name === "pause" ? journey?.state !== "Recording" : name === "resume" ? journey?.state !== "Paused" : name === "stop" ? !["Recording", "Paused"].includes(journey?.state) : ["Recording", "Paused"].includes(journey?.state);
    }
    observer.disconnect();
    role("strip").replaceChildren(...(journey?.frames ?? []).map((frame, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "clicksheet-toolbar__frame";
      button.setAttribute("aria-pressed", String(frame.id === selectedFrame));
      const label = document.createElement("span");
      label.textContent = `${index + 1}. ${frame.label || frame.title || "Screenshot"}`;
      button.append(label);
      button.dataset.previewKey = `${journey.id}:${journey.updatedAt}:${frame.id}`;
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
    add.disabled = true;
    add.title = "Available when capture is implemented";
    role("strip").append(add);
  }

  function request(command) {
    command = { journeyId: view?.currentJourney?.id, ...command };
    const pending = requestTail.then(async () => {
      const result = await chrome.runtime.sendMessage({ type: "clicksheet:journey", command });
      if (!result?.ok) throw new Error(result?.error || "Reload the extension and reopen Clicksheet.");
      view = result.view;
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
      render();
    } catch (error) { failure = error; }
    finally {
      busy = false;
      render();
      if (failure) { role("message").textContent = failure.message; role("save-status").textContent = "Storage unavailable"; }
    }
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
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "clicksheet:open") controller.open();
    if (message?.type === "clicksheet:state") controller.render(message);
  });
  render();
  void run({ action: "snapshot" });
})();
