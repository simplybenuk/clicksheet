import { createStorage } from "./storage.js";
import { createThumbnail } from "./thumbnail.js";
import { createLibrarySession } from "./library-session.js";
import { prepareJourney, journeyControls } from "./journey.js";

// Extension-context coordinator. Writes finish before a message is answered,
// so the worker's normal idle suspension cannot interrupt a pending autosave.
export function createJourneyCoordinator({ loadRootHandle, saveRootHandle, sessionFactory = createLibrarySession, thumbnail = createThumbnail }) {
  const session = sessionFactory({ loadRootHandle, saveRootHandle });
  const selections = new Map();
  let tail = Promise.resolve();

  async function execute(tabId, command) {
    const root = await loadRootHandle();
    if (root) await session.connect(root);
    let view = session.snapshot();
    let id = command.journeyId ?? selections.get(tabId);
    if (!view.journeys.some((journey) => journey.id === id)) {
      id = view.journeys[0]?.id ?? null;
      selections.set(tabId, id);
    }
    selections.set(tabId, id);
    if (command.action === "rename" && command.journeyId !== id) throw new Error("Journey not found. Reopen it before renaming.");
    const current = view.journeys.find((journey) => journey.id === id);
    const controls = current ? journeyControls(prepareJourney(current), { available: view.editable }) : {};

    if (command.action === "thumbnail") {
      if (!view.available || !current || current.id !== command.journeyId) throw new Error("Reconnect storage to load this screenshot.");
      const frame = current.frames.find((item) => item.id === command.frameId);
      if (!frame) throw new Error("Screenshot not found.");
      const file = await createStorage(root).readScreenshot(current.id, frame.screenshotFile);
      return { thumbnail: await thumbnail(file) };
    } else if (command.action === "new") {
      if (!view.editable || (current && !controls.newJourney)) throw new Error("Finish the recording and reconnect storage before creating a Journey.");
      const created = session.createJourney();
      if (!created) throw new Error("Choose a storage folder first.");
      const model = prepareJourney(created);
      session.updateJourney(created.id, { state: model.state, pauseReason: model.pauseReason, recordingSegment: model.recordingSegment });
      selections.set(tabId, created.id);
    } else if (command.action === "open") {
      if (current && !controls.openJourney) throw new Error("Stop recording before opening another Journey.");
      if (!view.journeys.some((journey) => journey.id === command.id)) throw new Error("Journey not found.");
      selections.set(tabId, command.id);
    } else if (command.action === "rename") {
      if (!current || !view.renamable || typeof command.name !== "string") throw new Error("This Journey cannot be renamed now.");
      session.rename(current.id, command.name);
    } else if (command.action !== "snapshot") {
      throw new Error("Unknown Journey action.");
    }
    if (command.action !== "snapshot" && command.action !== "open") {
      const saved = await session.flush();
      if (command.action === "new" && !saved) throw new Error("The new Journey could not be saved. Reconnect storage before trying again.");
    }
    view = session.snapshot();
    const selected = view.journeys.find((journey) => journey.id === selections.get(tabId));
    return {
      ...view,
      currentJourney: selected ? prepareJourney(selected) : null,
      controls: selected ? journeyControls(prepareJourney(selected), { available: view.editable, captureReady: false }) : {},
      // Only summaries go into the popover; frames belong to the selected strip.
      journeys: view.journeys.map(({ id, name }) => ({ id, name }))
    };
  }

  return {
    request(tabId, command) {
      const run = tail.then(() => execute(tabId, command));
      tail = run.catch(() => {});
      return run;
    },
    forgetTab(tabId) { selections.delete(tabId); }
  };
}
