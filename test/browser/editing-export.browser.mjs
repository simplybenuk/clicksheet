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
  await action("export").click();
  await action("download-image").click();
  await s.messageMatches(/Saved .*\.png/);
  check("Download image saves into the Journey's exports", /Saved untitled-journey\.png/.test(await s.message()), await s.message());
  await action("export").click();
  await action("download-image").click();
  await s.messageMatches(/untitled-journey-2\.png/);
  journey = await until(s.readJourney, (j) => j.exports.length >= 2);
  check("a second export does not overwrite the first", journey.exports.sort().join() === "untitled-journey-2.png,untitled-journey.png", journey.exports.join());
  const sheet = await s.readImage(journey.id, "exports", "untitled-journey.png");
  t.save("sheet.png", sheet.dataUrl.split(",")[1]);
  check("the export is one PNG sized for four cells in one row", sheet.width > 4 * 240, `${sheet.width}x${sheet.height}`);
  const expected = layoutContactSheet(journey.frames, { header: headerText(journey) });
  check("the export is headed by the Journey title and description",
    journey.description === DESCRIPTION && expected.header.description && sheet.width === expected.width && sheet.height === expected.height,
    `${sheet.width}x${sheet.height}, expected ${expected.width}x${expected.height}`);
  await action("export").click();
  await action("copy-image").click();
  await s.messageMatches(/Copied|could not be copied/);
  const copyMessage = await s.message();
  check("Copy image reports its result and leaves Download available", /Copied|could not be copied/.test(copyMessage) && !(await action("export").isDisabled()), copyMessage);

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
