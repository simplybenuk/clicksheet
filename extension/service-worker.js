import { classifyPage } from "./core/supported-pages.js";

const TOOLBAR_SCRIPT = "content/toolbar.js";
const TOOLBAR_STYLES = "content/toolbar.css";

chrome.action.onClicked.addListener(async (tab) => {
  if (typeof tab.id !== "number") {
    return;
  }

  const page = classifyPage(tab.url);

  if (!page.supported) {
    await notifyTab(tab.id, {
      status: "unsupported",
      message: page.reason
    });
    return;
  }

  try {
    await chrome.scripting.insertCSS({
      target: { tabId: tab.id },
      files: [TOOLBAR_STYLES]
    });
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: [TOOLBAR_SCRIPT]
    });
    await chrome.tabs.sendMessage(tab.id, {
      type: "clicksheet:open",
      page
    });
  } catch (error) {
    console.warn("Clicksheet could not open on the active page.", error);
    await notifyTab(tab.id, {
      status: "unavailable",
      message: "Clicksheet could not access this page. Try a standard web page."
    });
  }
});

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type === "clicksheet:open-storage" && sender.id === chrome.runtime.id) {
    void chrome.runtime.openOptionsPage();
  }
});

async function notifyTab(tabId, state) {
  try {
    await chrome.scripting.insertCSS({
      target: { tabId },
      files: [TOOLBAR_STYLES]
    });
    await chrome.scripting.executeScript({
      target: { tabId },
      files: [TOOLBAR_SCRIPT]
    });
    await chrome.tabs.sendMessage(tabId, {
      type: "clicksheet:state",
      ...state
    });
  } catch (error) {
    console.warn("Clicksheet could not display its page state.", error);
  }
}
