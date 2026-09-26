import { loadRootHandle, saveRootHandle } from "./core/handle-store.js";
import { createJourneyCoordinator, CaptureError } from "./core/journey-coordinator.js";
import { sanitizeCapture } from "./core/capture-image.js";
import { classifyPage } from "./core/supported-pages.js";

const TOOLBAR_SCRIPT = "content/toolbar.js";
const TOOLBAR_STYLES = "content/toolbar.css";
const BINDINGS_KEY = "clicksheet-bindings";

// Tab ids only mean something for this browser session, so bindings use
// session storage and disappear when Chrome restarts.
const bindings = {
  async load() { return (await chrome.storage.session.get(BINDINGS_KEY))[BINDINGS_KEY] ?? {}; },
  async save(value) { await chrome.storage.session.set({ [BINDINGS_KEY]: value }); }
};

const browser = {
  async isVisible(tabId) {
    const tab = await chrome.tabs.get(tabId);
    return tab.active;
  },
  prepare(tabId) {
    return chrome.tabs.sendMessage(tabId, { type: "clicksheet:prepare-capture" }).then((page) => {
      if (!page?.viewport) throw new CaptureError("Reopen Clicksheet on this page, then capture again.");
      return page;
    });
  },
  scrollTo(tabId, options) {
    return chrome.tabs.sendMessage(tabId, { type: "clicksheet:scroll-capture", ...options }).then((position) => {
      if (!Number.isFinite(position?.scrollY)) throw new CaptureError("The page could not be scrolled for a full-page capture.");
      return position;
    });
  },
  async isLoading(tabId) {
    return (await chrome.tabs.get(tabId)).status === "loading";
  },
  restore(tabId) {
    return chrome.tabs.sendMessage(tabId, { type: "clicksheet:restore-capture" });
  },
  async captureVisible(tabId) {
    const { windowId } = await chrome.tabs.get(tabId);
    const url = await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
    return (await fetch(url)).blob();
  },
  sanitize: (blob, page) => sanitizeCapture(blob, page),
  inject: injectToolbar,
  notify(tabId) {
    return chrome.tabs.sendMessage(tabId, { type: "clicksheet:refresh" });
  }
};

const journeys = createJourneyCoordinator({ loadRootHandle, saveRootHandle, browser, bindings });

chrome.action.onClicked.addListener(openClicksheet);

async function openClicksheet(tab) {
  if (typeof tab.id !== "number") {
    return;
  }

  const page = classifyPage(tab.url);

  if (!page.supported) {
    await explainUnavailable(tab.id, page.reason);
    return;
  }
  await clearUnavailable(tab.id, { force: true });

  try {
    await injectToolbar(tab.id);
    await chrome.tabs.sendMessage(tab.id, {
      type: "clicksheet:open",
      page
    });
    await journeys.event(tab.id, { type: "invoked", url: tab.url, windowId: tab.windowId });
  } catch (error) {
    console.warn("Clicksheet could not open on the active page.", error);
    await explainUnavailable(tab.id, "Clicksheet could not access this page. Try a standard web page.");
  }
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id) return;
  if (message?.type === "clicksheet:open-storage") {
    void chrome.runtime.openOptionsPage();
    return;
  }
  // The editor is an extension page, so the page being recorded can never
  // read the unredacted screenshot it shows.
  if (message?.type === "clicksheet:open-editor") {
    const query = new URLSearchParams({ journey: String(message.journeyId ?? ""), frame: String(message.frameId ?? "") });
    void chrome.tabs.create({ url: chrome.runtime.getURL(`pages/editor.html?${query}`), index: (sender.tab?.index ?? -1) + 1 });
    return;
  }
  const tabId = sender.tab?.id;
  // Pages may only report their own clicks and changes; tab lifecycle events
  // come from Chrome alone.
  if (message?.type === "clicksheet:page-event" && Number.isInteger(tabId) && ["click", "changed"].includes(message.event?.type)) {
    void journeys.event(tabId, message.event);
    return;
  }
  if (message?.type === "clicksheet:journey" && Number.isInteger(tabId)) {
    journeys.request(tabId, message.command ?? {}, { url: sender.tab.url, windowId: sender.tab.windowId }).then(
      (view) => respond({ ok: true, view }),
      (error) => respond({ ok: false, error: userMessage(error) })
    );
    return true;
  }
});

// Manual Capture from the keyboard keeps hover and focus states that moving
// to the toolbar would end (FR-007.4). The shortcut also grants activeTab.
chrome.commands.onCommand.addListener(captureFromShortcut);

const shortcutCaptures = new Set();

async function captureFromShortcut(command, tab) {
  if (command !== "capture" || typeof tab?.id !== "number") return;
  // A held or repeated key press should not queue a burst of captures.
  if (shortcutCaptures.has(tab.id)) return;
  shortcutCaptures.add(tab.id);
  try {
    await runShortcutCapture(tab);
  } finally {
    shortcutCaptures.delete(tab.id);
  }
}

async function runShortcutCapture(tab) {
  const page = classifyPage(tab.url);
  if (!page.supported) {
    await explainUnavailable(tab.id, page.reason);
    return;
  }
  const present = await chrome.tabs.sendMessage(tab.id, { type: "clicksheet:ping" }).catch(() => false);
  if (!present) {
    try {
      await injectToolbar(tab.id);
    } catch {
      await explainUnavailable(tab.id, "Clicksheet could not access this page. Try a standard web page.");
      return;
    }
  }
  try {
    await journeys.request(tab.id, { action: "capture" }, { url: tab.url, windowId: tab.windowId });
    await chrome.tabs.sendMessage(tab.id, { type: "clicksheet:refresh" }).catch(() => {});
    // Visible confirmation even while the toolbar is hidden.
    await chrome.action.setBadgeText({ tabId: tab.id, text: "✓" }).catch(() => {});
    setTimeout(() => {
      if (!explained.has(tab.id)) void chrome.action.setBadgeText({ tabId: tab.id, text: "" }).catch(() => {});
    }, 1500);
  } catch (error) {
    await chrome.tabs.sendMessage(tab.id, { type: "clicksheet:notice", text: userMessage(error) }).catch(() => {});
  }
}

chrome.tabs.onRemoved.addListener((tabId) => { void journeys.forgetTab(tabId); });
chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  void journeys.event(tabId, { type: "activated", windowId });
});
chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (change.status === "loading") void clearUnavailable(tabId);
  if (change.status) void journeys.event(tabId, { type: "updated", status: change.status, url: tab.url });
});

// Messages written for people are passed on; anything else stays generic so
// internal browser errors never reach the page.
const USER_FACING_ERRORS = new Set(["CaptureError", "ExportTooLargeError"]);
function userMessage(error) {
  if (USER_FACING_ERRORS.has(error?.name) || error?.constructor === Error) return error.message;
  return "Clicksheet could not complete this action. Reconnect storage and try again.";
}

// Browser pages, the Web Store, and file URLs cannot show the toolbar, so the
// reason is shown on the action itself (FR-001.3–4).
const explained = new Set();
async function explainUnavailable(tabId, reason) {
  explained.add(tabId);
  await Promise.allSettled([
    chrome.action.setBadgeText({ tabId, text: "!" }),
    chrome.action.setBadgeBackgroundColor({ tabId, color: "#b3261e" }),
    chrome.action.setTitle({ tabId, title: `Clicksheet is unavailable here. ${reason}` })
  ]);
  await notifyTab(tabId, { status: "unsupported", message: reason });
}
// Worker memory may be gone, so an explicit invocation always clears the badge.
async function clearUnavailable(tabId, { force = false } = {}) {
  if (!explained.delete(tabId) && !force) return;
  await Promise.allSettled([
    chrome.action.setBadgeText({ tabId, text: "" }),
    chrome.action.setTitle({ tabId, title: "Open Clicksheet" })
  ]);
}

// The toolbar renders in a closed shadow root, which page-level CSS cannot
// style, so its stylesheet is handed to the content script's isolated world.
let toolbarCss = null;
async function injectToolbar(tabId) {
  toolbarCss ??= await (await fetch(chrome.runtime.getURL(TOOLBAR_STYLES))).text();
  await chrome.scripting.executeScript({
    target: { tabId },
    func: (css) => { window.__clicksheetToolbarCss = css; },
    args: [toolbarCss]
  });
  await chrome.scripting.executeScript({
    target: { tabId },
    files: [TOOLBAR_SCRIPT]
  });
}

async function notifyTab(tabId, state) {
  try {
    await injectToolbar(tabId);
    await chrome.tabs.sendMessage(tabId, {
      type: "clicksheet:state",
      ...state
    });
  } catch {
    // Restricted pages cannot be scripted; the action badge explains instead.
  }
}
