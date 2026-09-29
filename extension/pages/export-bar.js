// Open / Show in folder for the latest Downloads export in this tab (spec
// journey-context-export FR-C4.4). It is an extension page inside the widget
// because chrome.downloads.open only works from a click in an extension page;
// the tab's content script cannot call it, and a relayed message is refused.

const file = document.querySelector('[data-role="file"]');
const open = document.querySelector('[data-action="open"]');
const show = document.querySelector('[data-action="show"]');
let current = null;

async function load() {
  current = await chrome.runtime.sendMessage({ type: "clicksheet:export-bar" }).catch(() => null);
  if (!Number.isInteger(current?.downloadId)) {
    file.textContent = "The export is no longer available here.";
    open.hidden = show.hidden = true;
    return;
  }
  // The widget's message line already says what was saved and where.
  file.textContent = current.fileName;
  file.title = `Downloads/Clicksheet/${current.fileName} and ${current.contextFileName}`;
  open.hidden = show.hidden = false;
}

// Chrome keeps a record of a download after its file is moved or deleted,
// so the file is checked before each action.
async function withFile(action) {
  const [item] = await chrome.downloads.search({ id: current?.downloadId }).catch(() => []);
  if (!item || item.exists === false || item.state !== "complete") {
    file.textContent = `${current?.fileName ?? "The file"} was moved or deleted.`;
    return;
  }
  try {
    await action(item.id);
  } catch {
    file.textContent = `Chrome could not open ${current.fileName}. It may have been moved or deleted.`;
  }
}

open.addEventListener("click", () => withFile((id) => chrome.downloads.open(id)));
show.addEventListener("click", () => withFile((id) => chrome.downloads.show(id)));
void load();
