// Captures that race with the page: a click while a capture is being
// prepared, a slow "Saving…" button that navigates, and the elapsed clock.
import { until } from "./harness.mjs";

export async function run(t) {
  await duringCaptureThenNavigate(t);
  await repeatedClicks(t);
  await ambienceExpires(t);
  await hoverShortcut(t);
  await fixedAfterFullPage(t);
  await elapsedTime(t);
}

// Pagination clicked about once a second must not be mistaken for ambient
// change, and no-op clicks beside a ticking clock must still be ignored after
// that activity.
async function repeatedClicks(t) {
  const s = await t.launch();
  const { page, toolbar } = s;
  const { check } = t;
  await s.open();
  await s.newJourney();
  await toolbar.locator('[data-action="record"]').click();
  await s.count(1);
  await page.waitForTimeout(1500);
  for (let n = 0; n < 5; n++) {
    await page.click('[data-action="next-page"]');
    // Under a second apart, so the list's own changes fill the ambient
    // window; the pre-fix rule lost frames at this pace.
    await page.waitForTimeout(900);
  }
  const frames = toolbar.locator(".clicksheet-toolbar__frame");
  check("five repeated async clicks give five frames", await s.count(6, 5000), `frames=${await frames.count()}`);
  await page.waitForTimeout(1500);
  await page.click('[data-action="noop"]');
  await page.waitForTimeout(2500);
  await page.click('[data-action="noop"]');
  await page.waitForTimeout(2500);
  check("no-op clicks beside a ticking clock still give no frames", await frames.count() === 6, `frames=${await frames.count()}`);
  // Keyboard activity marks every change as prompted; the clock must still
  // be recognised as ambient afterwards.
  for (let n = 0; n < 18; n++) {
    await page.keyboard.press("Shift");
    await page.waitForTimeout(200);
  }
  await page.click('[data-action="noop"]');
  await page.waitForTimeout(2500);
  check("typing, then a no-op click beside the clock, gives no frame", await frames.count() === 6, `frames=${await frames.count()}`);
}

// A status line that updated itself three times and then went quiet must not
// stay ambient: a later click whose only effect is on it still gives a frame.
async function ambienceExpires(t) {
  const s = await t.launch();
  const { page, toolbar } = s;
  const { check } = t;
  await s.open("/?sync");
  await s.newJourney();
  await toolbar.locator('[data-action="record"]').click();
  await s.count(1);
  await page.waitForFunction(() => document.querySelector('[data-role="sync-status"]')?.textContent === "Syncing 3/3…");
  await page.waitForTimeout(4000);
  await page.click('[data-action="refresh-status"]');
  await s.count(2);
  await page.waitForTimeout(1200);
  await page.click('[data-action="refresh-status"]');
  check("a click on an element that stopped changing on its own gives a frame", await s.count(3, 5000), `frames=${await toolbar.locator(".clicksheet-toolbar__frame").count()}`);
}

// Manual Capture from the keyboard shortcut keeps a hover-only state, which
// moving the pointer to the toolbar would end (FR-007.4).
async function hoverShortcut(t) {
  const s = await t.launch();
  const { page, worker } = s;
  const { check } = t;
  await s.open();
  await s.newJourney();
  const card = page.locator('[data-role="hover-card"]');
  await card.hover();
  const box = await card.boundingBox();
  await worker.evaluate(async (url) => {
    const [tab] = await chrome.tabs.query({ url: `${url}/*` });
    await globalThis.__captureFromShortcut("capture", tab);
  }, s.base);
  check("the capture shortcut adds a Manual capture frame", await s.count(1));
  const journey = await s.readJourney();
  const frame = journey.frames[0];
  const colour = await s.pixel(journey.id, frame.screenshotFile, box.x + 4, box.y + box.height / 2);
  check("the shortcut keeps the hover state in the stored pixels", colour === "220,20,60" && frame.label === "Manual capture", `${colour} ${frame.label}`);
  const badge = await worker.evaluate(async (url) => {
    const [tab] = await chrome.tabs.query({ url: `${url}/*` });
    return chrome.action.getBadgeText({ tabId: tab.id });
  }, s.base);
  check("a shortcut capture confirms itself on the action badge", badge === "✓", JSON.stringify(badge));
  // Hidden toolbar plus a failing shortcut: the reason must still be shown.
  await s.toolbar.locator('[data-action="dismiss"]').click();
  await page.waitForTimeout(700);
  await s.storagePage.evaluate(async () => {
    const { saveRootHandle } = await import("/core/handle-store.js");
    const root = await navigator.storage.getDirectory();
    await saveRootHandle(await root.getDirectoryHandle("empty-library", { create: true }));
  });
  await worker.evaluate(async (url) => {
    const [tab] = await chrome.tabs.query({ url: `${url}/*` });
    await globalThis.__captureFromShortcut("capture", tab);
  }, s.base);
  const shown = await until(() => s.toolbar.isVisible(), Boolean, 3000);
  check("a failed shortcut capture reopens the hidden toolbar with the reason", shown && /Journey/.test(await s.message()), await s.message());
}

// Full-page capture hides fixed elements; afterwards the page's own inline
// style change on one of them (opening a notice) must still count.
async function fixedAfterFullPage(t) {
  const s = await t.launch();
  const { page, toolbar } = s;
  const { check } = t;
  await s.open("/long.html");
  await s.newJourney();
  await toolbar.locator('[data-action="settings"]').click();
  await toolbar.locator('[data-role="capture-area"]').selectOption("fullPage");
  await toolbar.locator('[data-action="save-settings"]').click();
  await until(async () => (await s.readJourney()).settings, (v) => v?.captureArea === "fullPage");
  await toolbar.locator('[data-action="record"]').click();
  await s.count(1, 10000);
  const first = await s.readJourney();
  check("the first frame is a full-page capture", first.frames[0]?.captureArea === "fullPage", first.frames[0]?.captureArea);
  await page.waitForTimeout(1500);
  await page.click('[data-action="open-notice"]');
  check("a fixed notice opened by inline style after a full-page capture gives a frame", await s.count(2, 12000));
}

async function duringCaptureThenNavigate(t) {
  const s = await t.launch();
  const { page, toolbar, worker } = s;
  const { check } = t;
  await s.open();
  await s.newJourney();
  await toolbar.locator('[data-action="record"]').click();
  await s.count(1);
  // Let the ambient clock be learned before the first real click.
  await page.waitForTimeout(1500);
  const send = (type) => worker.evaluate(async ({ url, type }) => {
    const [tab] = await chrome.tabs.query({ url: `${url}/*` });
    return chrome.tabs.sendMessage(tab.id, { type });
  }, { url: s.base, type });
  // A capture is being prepared (passwords covered, toolbar hidden) when the
  // user clicks something that really changes the page.
  const prepared = await send("clicksheet:prepare-capture");
  await page.click('[data-action="load-details"]');
  await page.waitForTimeout(400);
  await send("clicksheet:restore-capture");
  check("capture preparation covered the password field", prepared?.masks?.length === 1, JSON.stringify(prepared?.masks));
  check("a real click during capture preparation still creates a frame", await s.count(2, 5000));
  const style = await page.locator('[data-role="password"]').evaluate((el) => el.getAttribute("style"));
  check("password field styling is restored afterwards", !style, String(style));

  // The button shows "Saving…" and navigates 700 ms later; the destination
  // must still be captured and recording must carry on.
  await page.waitForTimeout(700);
  await page.click('[data-action="save-and-go"]');
  await page.waitForURL(`${s.base}/second.html`);
  const journey = await until(s.readJourney, (j) => j.frames.at(-1)?.pathname === "/second.html" && j.state === "Recording", 8000);
  check("Saving… then navigation still captures the destination", journey.frames.at(-1).pathname === "/second.html" && journey.state === "Recording", `${journey.frames.map((f) => f.pathname).join(" ")} ${journey.state}/${journey.pauseReason}`);
  check("no page errors", s.errors.length === 0, s.errors.join("; "));
}

async function elapsedTime(t) {
  const s = await t.launch();
  const { page, toolbar } = s;
  const { check } = t;
  const elapsed = () => toolbar.locator('[data-role="elapsed"]').textContent();
  await s.open();
  await s.newJourney();
  await toolbar.locator('[data-action="record"]').click();
  await s.count(1);
  // Real time is the thing under test here, so these waits are deliberate.
  await page.waitForTimeout(3200);
  const shown = await elapsed();
  check("the toolbar shows elapsed recording time", /^00:0[2-4]$/.test(shown), shown);
  await toolbar.locator('[data-action="pause"]').click();
  await page.waitForTimeout(2200);
  const paused = await elapsed();
  check("elapsed time holds while paused", /^00:0[3-4]$/.test(paused), paused);
  await s.screenshot("elapsed.png", { clip: { x: 0, y: 0, width: 1280, height: 230 } });
  check("no page errors", s.errors.length === 0, s.errors.join("; "));
}
