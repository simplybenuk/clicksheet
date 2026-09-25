(() => {
  const existingToolbar = window.__clicksheetToolbar;

  if (existingToolbar) {
    existingToolbar.open();
    return;
  }

  const ROOT_ID = "clicksheet-toolbar-root";
  let currentState = {
    status: "ready",
    message: "The extension scaffold is ready on this page."
  };

  function ensureRoot() {
    const currentRoot = document.getElementById(ROOT_ID);

    if (currentRoot) {
      return currentRoot;
    }

    const root = document.createElement("aside");
    root.id = ROOT_ID;
    root.className = "clicksheet-toolbar";
    root.setAttribute("role", "region");
    root.setAttribute("aria-label", "Clicksheet");
    document.documentElement.append(root);
    return root;
  }

  function render(state = currentState) {
    currentState = { ...currentState, ...state };
    const root = ensureRoot();
    const statusLabel = currentState.status === "ready" ? "Ready" : "Unavailable";

    root.dataset.status = currentState.status;
    root.innerHTML = `
      <div class="clicksheet-toolbar__surface">
        <div class="clicksheet-toolbar__brand">
          <span class="clicksheet-toolbar__mark" aria-hidden="true">C</span>
          <div>
            <strong>Clicksheet</strong>
            <span>Visual context for coding agents</span>
          </div>
        </div>
        <div class="clicksheet-toolbar__journey" aria-label="Journey scaffold">
          <span class="clicksheet-toolbar__eyebrow">Current journey</span>
          <span class="clicksheet-toolbar__journey-name">Untitled Journey</span>
          <span class="clicksheet-toolbar__message" data-role="message"></span>
        </div>
        <div class="clicksheet-toolbar__controls">
          <span class="clicksheet-toolbar__status" data-role="status"></span>
          <button type="button" class="clicksheet-toolbar__button" data-action="storage">Storage</button>
          <button type="button" class="clicksheet-toolbar__button" data-action="dismiss">Dismiss</button>
        </div>
      </div>
    `;

    root.querySelector('[data-role="status"]').textContent = statusLabel;
    root.querySelector('[data-role="message"]').textContent = currentState.message;
    root.querySelector('[data-action="storage"]').addEventListener("click", () => {
      chrome.runtime.sendMessage({ type: "clicksheet:open-storage" });
    });
    root.querySelector('[data-action="dismiss"]').addEventListener("click", () => {
      root.remove();
    });
  }

  const controller = {
    open() {
      render();
    },
    close() {
      document.getElementById(ROOT_ID)?.remove();
    },
    render
  };

  window.__clicksheetToolbar = controller;

  if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((message) => {
      if (message?.type === "clicksheet:open") {
        render({
          status: "ready",
          message: "The extension scaffold is ready on this page."
        });
      }

      if (message?.type === "clicksheet:state") {
        render({
          status: message.status,
          message: message.message
        });
      }
    });
  }

  render();
})();
