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
  if (message?.type === "clicksheet:page-event" && Number.isInteger(tabId)) {
    void journeys.event(tabId, message.event ?? {});
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

async function injectToolbar(tabId) {
  await chrome.scripting.insertCSS({
    target: { tabId },
    files: [TOOLBAR_STYLES]
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
