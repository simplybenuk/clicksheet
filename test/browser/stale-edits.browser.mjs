// Name and description text belongs to the Journey it was typed in. When
// that Journey goes away (its folder is removed by hand, or another library
// is located while the edit is held), the text is dropped with a message. It
// is never written to another Journey, and the widget is not left stuck.
import { until } from "./harness.mjs";

const STALE_NAME = "Text typed for the removed Journey";
const STALE_DESCRIPTION = "A description typed for the removed Journey.";

export async function run(t) {
  const s = await t.launch();
  const { page, toolbar, storagePage, worker } = s;
  const { check } = t;
  const name = toolbar.locator('[data-role="name"]');
  const description = toolbar.locator('[data-role="description"]');
  const saveStatus = () => toolbar.locator('[data-role="save-status"]').textContent();
  // Every journey.json under `library` ("" is the folder the suite starts
  // with), as raw text by Journey id.
  const files = (library = "") => storagePage.evaluate(async (library) => {
    let root = await navigator.storage.getDirectory();
    if (library) root = await root.getDirectoryHandle(library);
    const out = {};
    const journeys = await root.getDirectoryHandle("journeys");
    for await (const [id, dir] of journeys.entries()) {
      try { out[id] = await (await (await dir.getFileHandle("journey.json")).getFile()).text(); } catch { out[id] = null; }
    }
    return out;
  }, library);
  const named = (all, wanted) => Object.keys(all).find((id) => all[id] && JSON.parse(all[id]).name === wanted);
  const holdsStaleText = (all) => Object.values(all).some((text) => text?.includes(STALE_NAME) || text?.includes(STALE_DESCRIPTION));
  // Any later widget activity flushes pending edits; a focus refresh is the
  // one that needs no click. Each round also lets the 400 ms debounce fire.
  const flushes = async (rounds, seen = []) => {
    for (let n = 0; n < rounds; n++) {
      await page.waitForTimeout(700);
      seen.push(await s.message());
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    }
    await page.waitForTimeout(700);
    seen.push(await s.message());
    return seen;
  };
  const unloadPrompts = () => page.evaluate(() => {
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  });

  await s.open();
  await s.newJourney();
  await name.fill("First journey KEEP");
  await until(async () => named(await files(), "First journey KEEP"));
  await s.newJourney();
  await name.fill("Second journey");
  const before = await until(files, (all) => named(all, "First journey KEEP") && named(all, "Second journey"));
  const firstId = named(before, "First journey KEEP");
  const secondId = named(before, "Second journey");
  check("two Journeys exist and the second is shown", Boolean(firstId && secondId) && await name.inputValue() === "Second journey", JSON.stringify(Object.keys(before)));
  await until(saveStatus, (text) => text === "Saved locally");

  // The shown Journey's folder is removed by hand, then the user types.
  await storagePage.evaluate(async (id) => {
    const journeys = await (await navigator.storage.getDirectory()).getDirectoryHandle("journeys");
    await journeys.removeEntry(id, { recursive: true });
  }, secondId);
  await name.fill(STALE_NAME);
  await description.fill(STALE_DESCRIPTION);
  const messages = await flushes(4);
  const after = await files();
  check("text typed for a removed Journey is never written to another Journey",
    after[firstId] === before[firstId] && !holdsStaleText(after),
    `first journey.json unchanged: ${after[firstId] === before[firstId]}; names: ${Object.values(after).map((text) => text && JSON.parse(text).name).join(" | ")}`);
  check("the user is told the text was not saved", messages.some((text) => /no longer shown here, so the name or description you typed was not saved/.test(text)), messages.join(" || "));
  const status = await until(saveStatus, (text) => text === "Saved locally", 5000);
  check("the widget is not left Saving or prompting on unload", status === "Saved locally" && !(await unloadPrompts()), `status: ${status}; prompts: ${await unloadPrompts()}`);
  check("the fields show the Journey now shown, not the dropped text",
    await until(() => name.inputValue(), (value) => value === "First journey KEEP") === "First journey KEEP" && await description.inputValue() === "",
    `${await name.inputValue()} / ${await description.inputValue()}`);
  // The widget still works: an edit to the Journey now shown is saved to it.
  await name.fill("First journey renamed on purpose");
  const renamed = await until(files, (all) => all[firstId] && JSON.parse(all[firstId]).name === "First journey renamed on purpose");
  check("a later edit is saved to the Journey it was typed in", JSON.parse(renamed[firstId]).name === "First journey renamed on purpose" && await until(saveStatus, (text) => text === "Saved locally") === "Saved locally", await saveStatus());

  // A Save clicked with such text pending fails before it reaches the worker
  // (the flush that precedes it drops the text). The earlier save's bar must
  // still go for good, not only in this widget instance.
  const action = (id) => toolbar.locator(`[data-action="${id}"]`);
  const bar = toolbar.locator('[data-role="export-bar"]');
  const workerExport = () => worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return globalThis.__journeys.lastExport(tab.id);
  });
  await s.newJourney();
  await name.fill("Third journey");
  const withThird = await until(files, (all) => named(all, "Third journey"));
  const thirdId = named(withThird, "Third journey");
  await action("capture").click();
  await s.count(1);
  await action("export").click();
  await action("save-export").click();
  await s.messageMatches(/^Saved \S+ and \S+ in Downloads\/Clicksheet/);
  const barBefore = await until(() => bar.isVisible()) && Boolean(await workerExport());
  await until(() => action("export").isDisabled(), (disabled) => !disabled, 8000);
  const keep = (await files())[firstId];
  await storagePage.evaluate(async (id) => {
    const journeys = await (await navigator.storage.getDirectory()).getDirectoryHandle("journeys");
    await journeys.removeEntry(id, { recursive: true });
  }, thirdId);
  // Typing and the Save click land in one task, before the debounced flush.
  await page.evaluate(([text]) => {
    const root = document.querySelector("clicksheet-toolbar").shadowRoot;
    const field = root.querySelector('[data-role="name"]');
    field.value = text;
    field.dispatchEvent(new Event("input", { bubbles: true }));
    root.querySelector('[data-action="save-export"]').click();
  }, [STALE_NAME]);
  const saveMessages = await flushes(2, [await until(() => s.message(), (text) => /was not saved/.test(text))]);
  const afterSave = await files();
  check("a Save whose pending text is dropped does not run, and tells the user",
    barBefore && /was not saved/.test(saveMessages[0]) && afterSave[firstId] === keep && !holdsStaleText(afterSave), `bar before: ${barBefore}; ${saveMessages.join(" || ")}`);
  check("the earlier bar is removed in the worker too, so it cannot return after a navigation",
    !(await bar.isVisible()) && await until(workerExport, (value) => value === null) === null, `visible: ${await bar.isVisible()}; worker: ${JSON.stringify(await workerExport())}`);
  await until(() => name.inputValue(), (value) => value === "First journey renamed on purpose");

  // The second trigger: an edit is held while storage is unavailable, and a
  // different library is then located. The held text must not reach it.
  const otherId = await storagePage.evaluate(async () => {
    const { createStorage } = await import("/core/storage.js");
    const other = await (await navigator.storage.getDirectory()).getDirectoryHandle("other-library", { create: true });
    const storage = createStorage(other);
    await storage.initialize();
    return (await storage.createJourney({ name: "Other library KEEP" })).id;
  });
  const setAccess = (granted) => worker.evaluate((granted) => {
    const proto = FileSystemHandle.prototype;
    globalThis.__queryPermission ??= proto.queryPermission;
    proto.queryPermission = granted ? globalThis.__queryPermission : async () => "prompt";
  }, granted);
  let heldStatus = "";
  let located = [];
  const otherBefore = await files("other-library");
  try {
    await setAccess(false);
    await name.fill(STALE_NAME);
    await description.fill(STALE_DESCRIPTION);
    heldStatus = await until(saveStatus, (text) => text === "Storage unavailable", 5000);
    await s.messageMatches(/held here/, 5000);
    // Locate: the Storage page stores the other folder as the library.
    await storagePage.evaluate(async () => {
      const { saveRootHandle } = await import("/core/handle-store.js");
      await saveRootHandle(await (await navigator.storage.getDirectory()).getDirectoryHandle("other-library"));
    });
  } finally {
    await setAccess(true);
  }
  located = await flushes(4);
  const otherAfter = await files("other-library");
  check("the edit was held while storage was unavailable", heldStatus === "Storage unavailable", heldStatus);
  check("held text is not written to a Journey in a library located afterwards",
    Boolean(otherId) && otherAfter[otherId] === otherBefore[otherId] && !holdsStaleText(otherAfter),
    `unchanged: ${otherAfter[otherId] === otherBefore[otherId]}; names: ${Object.values(otherAfter).map((text) => text && JSON.parse(text).name).join(" | ")}`);
  const locatedStatus = await until(saveStatus, (text) => text === "Saved locally", 5000);
  check("after locating another library the widget says the text was dropped and is not stuck",
    located.some((text) => /was not saved/.test(text)) && locatedStatus === "Saved locally" && !(await unloadPrompts()) &&
      await until(() => name.inputValue(), (value) => value === "Other library KEEP") === "Other library KEEP",
    `status: ${locatedStatus}; name: ${await name.inputValue()}; ${located.join(" || ")}`);
  check("no page errors", s.errors.length === 0, s.errors.join("; "));
}
