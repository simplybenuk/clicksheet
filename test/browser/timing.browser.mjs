// Captures that race with the page: a click while a capture is being
// prepared, a slow "Saving…" button that navigates, and the elapsed clock.
import { until } from "./harness.mjs";

export async function run(t) {
  await duringCaptureThenNavigate(t);
  await repeatedClicks(t);
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
    await page.waitForTimeout(1200);
  }
  const frames = toolbar.locator(".clicksheet-toolbar__frame");
  check("five repeated async clicks give five frames", await s.count(6, 5000), `frames=${await frames.count()}`);
  await page.waitForTimeout(1500);
  await page.click('[data-action="noop"]');
  await page.waitForTimeout(2500);
  await page.click('[data-action="noop"]');
  await page.waitForTimeout(2500);
  check("no-op clicks beside a ticking clock still give no frames", await frames.count() === 6, `frames=${await frames.count()}`);
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
