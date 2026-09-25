import { loadRootHandle, saveRootHandle } from "../core/handle-store.js";
import { createLibrarySession } from "../core/library-session.js";
import { DEFAULT_JOURNEY_NAME, describeStorageError } from "../core/storage.js";

const PICKER_OPTIONS = { id: "clicksheet-root", mode: "readwrite" };

const elements = {
  folderName: document.querySelector('[data-role="folder-name"]'),
  status: document.querySelector('[data-role="save-status"]'),
  message: document.querySelector('[data-role="message"]'),
  journeys: document.querySelector('[data-role="journeys"]'),
  choose: document.querySelector('[data-action="choose"]'),
  reconnect: document.querySelector('[data-action="reconnect"]'),
  locate: document.querySelector('[data-action="locate"]'),
  move: document.querySelector('[data-action="move"]'),
  newJourney: document.querySelector('[data-action="new-journey"]')
};

const rows = new Map();
const actions = [elements.choose, elements.reconnect, elements.locate, elements.move];
// Actions stay disabled until the stored folder has been checked, so a click
// cannot race the startup connect.
let ready = false;
const session = createLibrarySession({ saveRootHandle, loadRootHandle, onChange: render });

function render(view) {
  elements.folderName.textContent = view.hasRoot ? view.folderName : "No folder selected";
  elements.status.textContent = view.status;
  elements.status.dataset.status = view.status;
  elements.message.textContent = view.message.text;
  elements.message.dataset.tone = view.message.tone;

  elements.choose.hidden = view.hasRoot;
  elements.reconnect.hidden = !view.hasRoot || view.available;
  elements.locate.hidden = !view.hasRoot || view.available;
  elements.move.hidden = !view.hasRoot || !view.available;
  actions.forEach((button) => {
    button.disabled = !ready || view.moving || view.connecting;
  });
  elements.move.disabled = !ready || !view.editable;
  elements.newJourney.disabled = !ready || !view.editable;

  renderJourneys(view);
}

// Rows are updated in place so an input being typed in keeps its focus.
function renderJourneys(view) {
  const ids = new Set(view.journeys.map((journey) => journey.id));

  for (const [id, row] of rows) {
    if (!ids.has(id)) {
      row.item.remove();
      rows.delete(id);
    }
  }

  const items = view.journeys.map((journey) => {
    const row = rows.get(journey.id) ?? createRow(journey.id);

    if (document.activeElement !== row.input) {
      row.input.value = journey.name;
    }

    row.input.disabled = !view.renamable;
    row.updated.dateTime = journey.updatedAt;
    row.updated.textContent = `Updated ${new Date(journey.updatedAt).toLocaleString()}`;
    return row.item;
  });

  // Only move rows that are out of place: moving the focused input's row out
  // of the document (as replaceChildren does) blurs it on every keystroke.
  items.forEach((item, index) => {
    const current = elements.journeys.children[index] ?? null;

    if (current !== item) {
      elements.journeys.insertBefore(item, current);
    }
  });
}

function createRow(id) {
  const item = document.createElement("li");
  const input = document.createElement("input");
  const updated = document.createElement("time");

  item.className = "journey";
  input.setAttribute("aria-label", "Journey name");
  input.addEventListener("input", () => session.rename(id, input.value));
  input.addEventListener("change", () => {
    if (!input.value.trim()) {
      input.value = DEFAULT_JOURNEY_NAME;
    }
  });
  item.append(input, updated);

  const row = { item, input, updated };
  rows.set(id, row);
  return row;
}

async function pickDirectory() {
  try {
    return await window.showDirectoryPicker(PICKER_OPTIONS);
  } catch (error) {
    if (error?.name === "AbortError") {
      return null;
    }

    throw error;
  }
}

function withPickedDirectory(action) {
  return async () => {
    const directory = await pickDirectory();

    if (directory) {
      await action(directory);
    }
  };
}

function runAction(action) {
  return async () => {
    try {
      await action();
    } catch (error) {
      elements.message.textContent = describeStorageError(error);
      elements.message.dataset.tone = "warn";
    }
  };
}

elements.choose.addEventListener("click", runAction(withPickedDirectory(session.chooseRoot)));
elements.reconnect.addEventListener("click", runAction(session.reconnect));
elements.locate.addEventListener("click", runAction(withPickedDirectory(session.locate)));
elements.move.addEventListener(
  "click",
  runAction(async () => {
    // Save pending edits before the picker opens so the copy includes them.
    if (await session.flush()) {
      await withPickedDirectory(session.move)();
    }
  })
);
elements.newJourney.addEventListener("click", runAction(session.createJourney));

// Folder access can change while the page is in the background.
window.addEventListener("focus", () => {
  if (session.snapshot().available) {
    void session.refreshAccess();
  }
});

// Unsaved edits live only in this page, including while the folder is
// unavailable, and writes started during unload may not finish. Ask before
// leaving and try to write them anyway.
window.addEventListener("beforeunload", (event) => {
  if (session.snapshot().hasUnsavedChanges) {
    event.preventDefault();
    // Older Chrome versions show the prompt only when returnValue is set.
    event.returnValue = "";
    void session.flush();
  }
});

render(session.snapshot());
const storedRoot = await loadRootHandle().catch(() => null);

if (storedRoot) {
  await session.connect(storedRoot);
}

ready = true;
render(session.snapshot());
