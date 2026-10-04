// Editing a stopped Journey: delete/undo, reorder, settings, full-page
// capture, redaction, export, copy, and the unsupported-page badge.
import { layoutContactSheet } from "../../extension/core/export-layout.js";
import { headerText } from "../../extension/core/export-renderer.js";
import { MASK, until } from "./harness.mjs";

const DESCRIPTION = "Tidy the screenshots, redact one, then export the sheet with its header.";

export async function run(t) {
  const s = await t.launch();
  const { page, toolbar, frames, context, worker } = s;
  const { check } = t;
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: s.base });
  const action = (name) => toolbar.locator(`[data-action="${name}"]`);
  const order = async () => (await s.readJourney()).frames.map((f) => f.id);
  // Holds the next worker request named `match` (for example "export:save")
  // until release(), so a test can make the widget busy without depending on
  // timing, and logs the commands the worker receives. Callers release and
  // restore() in finally blocks, so a failed step cannot leave the worker
  // held or the wrapper installed.
  async function holdNext(match) {
    await worker.evaluate((match) => {
      const journeys = globalThis.__journeys;
      globalThis.__unheldRequest ??= journeys.request;
      const original = globalThis.__unheldRequest;
      let release;
      const gate = new Promise((done) => { release = done; });
      globalThis.__releaseHeld = release;
      globalThis.__held = false;
      globalThis.__commandLog = [];
      journeys.request = async (tabId, command, ...rest) => {
        const name = [command?.action, command?.destination].filter(Boolean).join(":");
        if (!["thumbnail", "view-frame"].includes(command?.action)) globalThis.__commandLog.push(name);
        if (!globalThis.__held && name === match) { globalThis.__held = true; await gate; }
        return original.call(journeys, tabId, command, ...rest);
      };
    }, match);
    return {
      held: () => until(() => worker.evaluate(() => globalThis.__held), Boolean, 5000),
      log: () => worker.evaluate(() => globalThis.__commandLog),
      release: () => worker.evaluate(() => globalThis.__releaseHeld?.()),
      restore: () => worker.evaluate(() => {
        globalThis.__releaseHeld?.();
        if (globalThis.__unheldRequest) globalThis.__journeys.request = globalThis.__unheldRequest;
      })
    };
  }
  const idle = () => until(() => action("export").isDisabled(), (disabled) => !disabled, 8000);
  await s.open();
  await s.newJourney();
  check("Export is disabled for an empty Journey", await action("export").isDisabled());

  // Description: autosaves, and counts down near the 280-character limit.
  const description = toolbar.locator('[data-role="description"]');
  const count = toolbar.locator('[data-role="description-count"]');
  const label = toolbar.locator('label[for="cs-description"]');
  check("the description has a visible label and the spec's placeholder",
    await label.isVisible() && await label.textContent() === "Description (optional)" && await description.getAttribute("placeholder") === "What is this journey for?");
  await description.fill("a".repeat(250));
  check("the remaining count shows near the limit", await count.textContent() === "30 left", await count.textContent());
  await description.fill(DESCRIPTION);
  check("the remaining count hides away from the limit", await count.textContent() === "", await count.textContent());
  const described = await until(s.readJourney, (j) => j?.description === DESCRIPTION);
  check("the description autosaves to journey.json", described?.description === DESCRIPTION, described?.description);
  for (let n = 0; n < 3; n++) { await action("capture").click(); await s.count(n + 1); await page.waitForTimeout(550); }
  check("three manual captures", await frames.count() === 3);
  const labels = async () => (await frames.allTextContents()).map((text) => text.trim());
  const idsBefore = await order();
  await frames.nth(1).click();
  await action("delete").click();
  check("Delete removes the screenshot immediately", await s.count(2));
  check("sequence numbers update after delete", (await labels()).map((l) => l.split(".")[0]).join() === "1,2", (await labels()).join(" | "));
  await action("undo").click();
  check("Undo delete restores it", await s.count(3) && (await until(order, (ids) => ids.join() === idsBefore.join())).join() === idsBefore.join());
  await frames.nth(2).click();
  await action("move-left").click();
  const movedLeft = [idsBefore[0], idsBefore[2], idsBefore[1]].join();
  check("Move left reorders", (await until(order, (ids) => ids.join() === movedLeft)).join() === movedLeft);
  await frames.nth(0).dragTo(frames.nth(2));
  const dragged = await until(order, (ids) => ids[2] === idsBefore[0]);
  check("drag and drop reorders", dragged[2] === idsBefore[0], dragged.map((id) => idsBefore.indexOf(id)).join());

  // Settings: full page, then capture a long page.
  await action("settings").click();
  await toolbar.locator('[data-role="capture-area"]').selectOption("fullPage");
  await toolbar.locator('[data-role="capture-delay"]').fill("400");
  await action("save-settings").click();
  const settings = await until(async () => (await s.readJourney()).settings, (v) => v?.captureArea === "fullPage" && v?.captureDelayMs === 400);
  check("settings save to the Journey", settings.captureArea === "fullPage" && settings.captureDelayMs === 400, JSON.stringify(settings));
  await page.goto(`${s.base}/long.html`);
  await s.invoke();
  await toolbar.waitFor();
  await s.count(3);
  await action("capture").click();
  check("full-page capture adds a frame", await s.count(4, 10000));
  let journey = await s.readJourney();
  const full = journey.frames.at(-1);
  check("full-page frame is taller than the viewport", full.captureArea === "fullPage" && full.image.height > (await page.evaluate(() => innerHeight)) * 1.5, `${full.captureArea} ${full.image.width}x${full.image.height} viewport ${JSON.stringify(full.viewport)}`);
  t.save("fullpage.png", (await s.readImage(journey.id, "screenshots", full.screenshotFile)).dataUrl.split(",")[1]);
  check("page scroll restored after full-page capture", await page.evaluate(() => scrollY) === 0);

  // Redaction editor: two boxes, then Apply.
  await frames.nth(3).click();
  const [editor] = await Promise.all([context.waitForEvent("page"), action("edit").click()]);
  editor.on("pageerror", (error) => s.errors.push(`editor: ${error.message}`));
  await editor.waitForLoadState();
  const canvas = editor.locator("canvas");
  await canvas.waitFor();
  await editor.waitForFunction(() => document.querySelector("canvas")?.getBoundingClientRect().height > 400);
  const box = await canvas.boundingBox();
  for (const [x1, y1, x2, y2] of [[20, 20, 120, 80], [200, 120, 260, 170]]) {
    await editor.mouse.move(box.x + x1, box.y + y1);
    await editor.mouse.down();
    await editor.mouse.move(box.x + x2, box.y + y2, { steps: 5 });
    await editor.mouse.up();
  }
  const editorShot = t.artifact("editor.png");
  if (editorShot) await editor.screenshot({ path: editorShot });
  const closed = editor.waitForEvent("close", { timeout: 8000 }).then(() => true, () => false);
  await editor.getByRole("button", { name: /apply/i }).click();
  check("editor applies and closes", await closed);
  journey = await until(s.readJourney, (j) => j?.frames[3]?.redacted === true);
  const redacted = journey.frames[3];
  check("redacted frame points at a new file and the original is gone", redacted.redacted === true && redacted.screenshotFile !== full.screenshotFile && !journey.shots.includes(full.screenshotFile), `${redacted.screenshotFile} shots=${journey.shots.length}`);
  const scale = redacted.image.width / box.width;
  const { pixels: [inside, second] } = await s.readImage(journey.id, "screenshots", redacted.screenshotFile, [[Math.round(60 * scale), Math.round(50 * scale)], [Math.round(230 * scale), Math.round(145 * scale)]]);
  check("both redaction boxes are opaque in the stored screenshot", inside === MASK && second === MASK, `${inside} / ${second}`);

  // Export. Focus makes the toolbar refresh from storage; wait until it is
  // idle again so Export reflects the redacted Journey.
  await page.bringToFront();
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.waitForTimeout(400);
  await page.waitForFunction(() => !document.querySelector("clicksheet-toolbar")?.shadowRoot
    .querySelector('#clicksheet-toolbar-root [data-action="export"]').disabled, null, { timeout: 5000 }).catch(() => {});
  // Save image and context: Downloads by default (FR-C3.2), with the bar.
  await action("export").click();
  await action("save-export").click();
  check("Save image and context saves both files to Downloads",
    await s.messageMatches(/Saved \S+ and \S+ in Downloads\/Clicksheet/), await s.message());
  const downloaded = await until(s.downloads, (items) => items.filter((item) => item.state === "complete").length >= 2);
  const image = downloaded.find((item) => item.mime === "image/png");
  const downloadedContext = JSON.parse(downloaded.find((item) => item.json)?.json ?? "null");
  journey = await s.readJourney();
  const expected = layoutContactSheet(journey.frames, { header: headerText(journey) });
  check("the downloaded context describes the Journey and the sheet",
    downloadedContext?.format === "clicksheet-context" && downloadedContext.steps.length === journey.frames.length &&
    downloadedContext.journey.description === DESCRIPTION && downloadedContext.sheet.width === expected.width &&
    downloadedContext.sheet.height === expected.height && image?.fileSize > 0,
    JSON.stringify({ sheet: downloadedContext?.sheet, expected: [expected.width, expected.height], steps: downloadedContext?.steps.length }));
  // The size in the PNG header of the image Chrome was given, against the
  // `sheet` its context states. (Chrome's record keeps only the start of a
  // long data URL, which is enough for the header but not to decode it.)
  const imageSize = await worker.evaluate(async (id) => {
    const [item] = await chrome.downloads.search({ id });
    const head = atob(item.url.slice(item.url.indexOf(",") + 1, item.url.indexOf(",") + 1 + 32));
    const number = (at) => [0, 1, 2, 3].reduce((value, n) => value * 256 + head.charCodeAt(at + n), 0);
    return { png: head.slice(1, 4) === "PNG" && head.slice(12, 16) === "IHDR", width: number(16), height: number(20), urlLength: item.url.length };
  }, image?.id).catch((error) => ({ error: error.message }));
  check("the downloaded image has the pixel size its context states",
    imageSize.png && imageSize.width === downloadedContext?.sheet.width && imageSize.height === downloadedContext?.sheet.height,
    `${JSON.stringify(imageSize)} against ${JSON.stringify(downloadedContext?.sheet)}`);
  check("the redacted step is marked as redacted in the context", downloadedContext?.steps[3]?.redacted === true && downloadedContext?.steps[0]?.redacted === false);

  const bar = toolbar.locator('[data-role="export-bar"]');
  const barFrame = page.frameLocator('#clicksheet-toolbar-root [data-role="export-bar-frame"]');
  const barText = () => barFrame.locator('[data-role="file"]').textContent();
  await barFrame.locator('[data-action="show"]').waitFor({ timeout: 5000 }).catch(() => {});
  const savedName = (await s.message()).match(/^Saved (\S+) and/)?.[1];
  check("the saved-export bar names the saved image", await bar.isVisible() && savedName && await barText() === savedName, await barText().catch((error) => error.message));
  await s.screenshot("export-bar.png");
  await barFrame.locator('[data-action="show"]').click();
  await page.waitForTimeout(300);
  check("Show in folder runs from the bar", await barText() === savedName, await barText());
  await barFrame.locator('[data-action="open"]').click();
  await page.waitForTimeout(300);
  check("Open runs from the bar (Chrome needs the click in an extension page)", await barText() === savedName, await barText());
  await worker.evaluate((id) => chrome.downloads.removeFile(id), image.id);
  await barFrame.locator('[data-action="show"]').click();
  check("a moved or deleted file is reported", /moved or deleted/.test(await until(barText, (text) => /moved or deleted/.test(text))), await barText());
  // A Save and then the old bar's ✕, both clicked while a refresh runs, wait
  // their turn. The bar is still on screen for that ✕ (the Save has not
  // started), and the ✕ must not close the new bar or hide the Save's result:
  // it names the bar that was shown when it was clicked.
  // Bring focus back from the bar's frame first; the focus refresh that
  // causes must finish before Export can be opened.
  await toolbar.locator('[data-role="message"]').click();
  await idle();
  await action("export").click();
  const saving = await holdNext("snapshot");
  let busyAtDismiss = false;
  let barAtDismiss = false;
  let heldSave = false;
  let newName;
  let saveThenDismiss = [];
  try {
    try {
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      heldSave = await saving.held();
      busyAtDismiss = await action("export").isDisabled();
      await action("save-export").click();
      barAtDismiss = await bar.isVisible();
      await action("dismiss-export").click();
    } finally {
      await saving.release();
    }
    newName = await until(async () => (await s.message()).match(/^Saved (\S+) and \S+ in Downloads\/Clicksheet/)?.[1], (name) => name && name !== savedName, 15000);
    saveThenDismiss = await until(saving.log, (log) => log.includes("dismiss-export"));
    await idle();
  } finally {
    await saving.restore();
  }
  check("a Save and the visible bar's ✕ clicked during a refresh are queued in click order",
    heldSave && busyAtDismiss && barAtDismiss && saveThenDismiss[0] === "snapshot" && saveThenDismiss.filter((name) => name !== "snapshot").join() === "export:save,dismiss-export",
    `held: ${heldSave}; busy: ${busyAtDismiss}; bar visible at the ✕: ${barAtDismiss}; ${saveThenDismiss.join()}`);
  check("the queued ✕ for the old bar leaves the new save's bar",
    await bar.isVisible() && await until(barText, (text) => text === newName) === newName, `${newName}: ${await barText().catch((error) => error.message)}`);
  check("the Save result is still shown after the queued ✕ ran", (await s.message()).startsWith(`Saved ${newName} and`), await s.message());
  // A Save that fails after one that worked (AC-C8): Chrome refuses the
  // download. The earlier bar goes when the Save starts, and the error is
  // then shown with no bar, with no other command to refresh the widget.
  await idle();
  await worker.evaluate(() => {
    globalThis.__realDownload ??= chrome.downloads.download;
    chrome.downloads.download = () => Promise.reject(new Error("The disk is full."));
  });
  let heldFailing = false;
  let barWhileSaving = true;
  let afterFailure = "";
  let barAfterFailure = true;
  let afterQueuedCopy = "";
  try {
    const failing = await holdNext("export:save");
    try {
      try {
        await action("export").click();
        await action("save-export").click();
        heldFailing = await failing.held();
        barWhileSaving = await bar.isVisible();
      } finally {
        await failing.release();
      }
      await s.messageMatches(/could not save/);
      await idle();
      afterFailure = await s.message();
      barAfterFailure = await bar.isVisible();
    } finally {
      await failing.restore();
    }
    await s.screenshot("failed-save.png");
    // A Copy context clicked during another failing Save runs after it, and
    // its success must leave the error readable.
    await page.evaluate(() => navigator.clipboard.writeText(""));
    const failingAgain = await holdNext("export:save");
    try {
      try {
        await action("export").click();
        await action("save-export").click();
        await failingAgain.held();
        await action("copy-context").dispatchEvent("click");
      } finally {
        await failingAgain.release();
      }
      await s.messageMatches(/Copied the step context|could not be copied/);
      await idle();
      afterQueuedCopy = await s.message();
    } finally {
      await failingAgain.restore();
    }
  } finally {
    await worker.evaluate(() => { chrome.downloads.download = globalThis.__realDownload; });
  }
  check("the earlier bar is hidden as soon as a new Save starts", heldFailing && !barWhileSaving, `held: ${heldFailing}; bar visible: ${barWhileSaving}`);
  const workerExport = await worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return globalThis.__journeys.lastExport(tab.id);
  });
  check("a Save that fails after one that worked shows the error and no bar",
    /^Chrome could not save \S+\.png\. The disk is full\.$/.test(afterFailure) && !barAfterFailure && workerExport === null,
    `bar visible: ${barAfterFailure}; worker: ${JSON.stringify(workerExport)}; ${afterFailure}`);
  const copiedAfterFailure = await page.evaluate(() => navigator.clipboard.readText()).then(JSON.parse, () => null);
  check("a Copy context queued behind a failed Save copies and leaves the error readable",
    copiedAfterFailure?.format === "clicksheet-context" && /^Chrome could not save \S+\.png\. The disk is full\. Copied the step context/.test(afterQueuedCopy), afterQueuedCopy);
  // The next Save works again and shows its own bar.
  await action("export").click();
  await action("save-export").click();
  const recoveredName = await until(async () => (await s.message()).match(/^Saved (\S+) and \S+ in Downloads\/Clicksheet/)?.[1], (name) => name && name !== newName, 15000);
  check("a Save after the failed one shows its own bar",
    await until(() => bar.isVisible()) && await until(barText, (text) => text === recoveredName) === recoveredName, `${recoveredName}: ${await barText().catch((error) => error.message)}`);
  await idle();
  // Straight after a Save, the ✕ closes the bar that is shown.
  await action("dismiss-export").click();
  check("the bar closes", await until(async () => !(await bar.isVisible())), `still visible: ${await s.message()}`);

  // The Clicksheet folder destination (FR-C3.3): pairs in exports/, no bar.
  await action("settings").click();
  await toolbar.locator('[data-role="export-destination"]').selectOption("library");
  await s.screenshot("settings.png");
  const stored = await until(() => worker.evaluate(async () => (await chrome.storage.local.get("clicksheet-export-settings"))["clicksheet-export-settings"]), (value) => value?.destination === "library");
  check("the Export to choice is saved", stored?.destination === "library", JSON.stringify(stored));
  await action("settings").click();
  await action("export").click();
  await action("save-export").click();
  await s.messageMatches(/Saved untitled-journey\.png and untitled-journey\.json in (\S+\/exports|the exports folder of your Clicksheet folder)\./);
  check("the Clicksheet folder destination names both files and where they are", /Saved untitled-journey\.png and untitled-journey\.json in (\S+\/exports|the exports folder of your Clicksheet folder)\./.test(await s.message()), await s.message());
  await action("export").click();
  await action("save-export").click();
  await s.messageMatches(/untitled-journey-2\.png/);
  const exported = await until(s.listExports, (names) => names.length >= 4);
  check("a second save does not overwrite the first pair", exported.join() === "untitled-journey-2.json,untitled-journey-2.png,untitled-journey.json,untitled-journey.png", exported.join());
  check("no Open or Show bar for the Clicksheet folder", !(await bar.isVisible()));
  const sheet = await s.readExport("untitled-journey.png");
  t.save("sheet.png", sheet.dataUrl.split(",")[1]);
  check("the export is one PNG sized for four cells in one row", sheet.width > 4 * 240, `${sheet.width}x${sheet.height}`);
  check("the export is headed by the Journey title and description",
    journey.description === DESCRIPTION && expected.header.description && sheet.width === expected.width && sheet.height === expected.height,
    `${sheet.width}x${sheet.height}, expected ${expected.width}x${expected.height}`);
  const savedContext = JSON.parse((await s.readExport("untitled-journey.json")).text);
  check("the saved context matches the saved image", savedContext.sheet.width === sheet.width && savedContext.sheet.height === sheet.height && savedContext.steps.length === 4);

  // Copy image and Copy context.
  await action("export").click();
  await action("copy-image").click();
  await s.messageMatches(/Copied|could not be copied/);
  const copyMessage = await s.message();
  check("Copy image reports its result and leaves Save available", /Copied|could not be copied/.test(copyMessage) && !(await action("export").isDisabled()), copyMessage);
  await action("export").click();
  await action("copy-context").click();
  await s.messageMatches(/Copied the step context|could not be copied/);
  const copiedContext = await page.evaluate(() => navigator.clipboard.readText()).then(JSON.parse, () => null);
  check("Copy context puts the Journey's context JSON on the clipboard",
    copiedContext?.format === "clicksheet-context" && copiedContext.steps.length === 4 && copiedContext.journey.title === journey.name,
    `${await s.message()} ${JSON.stringify(copiedContext)?.slice(0, 120)}`);
  // A copy clicked while a focus refresh runs waits its turn instead of being
  // lost. The clipboard is cleared first so only this copy can fill it.
  // The refresh is held in the worker, so the widget is certainly busy at
  // the click. A second command (the hidden bar's ✕, which closes nothing)
  // is queued behind the copy to check the order.
  await page.evaluate(() => navigator.clipboard.writeText(""));
  await idle();
  await action("export").click();
  const refresh = await holdNext("snapshot");
  let heldRefresh = false;
  let busyAtClick = false;
  let queuedOrder = [];
  try {
    try {
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      heldRefresh = await refresh.held();
      busyAtClick = await action("export").isDisabled();
      await action("copy-context").click();
      await action("dismiss-export").dispatchEvent("click");
    } finally {
      await refresh.release();
    }
    await s.messageMatches(/Copied the step context|could not be copied/);
    queuedOrder = await until(refresh.log, (log) => log.includes("dismiss-export"));
    await idle();
  } finally {
    await refresh.restore();
  }
  check("the widget is busy with a refresh when Copy context is clicked", heldRefresh && busyAtClick, `held: ${heldRefresh}; busy: ${busyAtClick}`);
  const queuedCopy = await page.evaluate(() => navigator.clipboard.readText()).then(JSON.parse, () => null);
  check("Copy context clicked during a refresh still copies", queuedCopy?.format === "clicksheet-context", await s.message());
  check("queued commands run in click order after the refresh",
    queuedOrder[0] === "snapshot" && queuedOrder.filter((name) => name !== "snapshot").join() === "export:context,dismiss-export", queuedOrder.join());
  check("the copy's result stays after the queued command that followed it", /^Copied the step context/.test(await s.message()), await s.message());

  // Unsupported page: the action explains itself instead of injecting.
  const internal = await context.newPage();
  await internal.goto("chrome://version").catch(() => {});
  await internal.bringToFront();
  const badge = await worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    await globalThis.__openClicksheet(tab);
    return { text: await chrome.action.getBadgeText({ tabId: tab.id }), title: await chrome.action.getTitle({ tabId: tab.id }) };
  });
  check("an unsupported page explains itself on the action", badge.text === "!" && /unavailable here/.test(badge.title), JSON.stringify(badge));
  await s.screenshot("toolbar.png");
  check("no page errors", s.errors.length === 0, s.errors.join("; "));
}
