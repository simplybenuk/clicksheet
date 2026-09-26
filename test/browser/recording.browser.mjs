// Automatic recording: which clicks become frames, navigation, and tab pauses.
import { until } from "./harness.mjs";

export async function run(t) {
  const s = await t.launch({ windowSize: "1280,1300" });
  const { page, toolbar, frames } = s;
  const { check } = t;
  await s.open();
  await s.newJourney();
  await toolbar.locator('[data-action="record"]').click();
  const recorded = await s.count(1);
  check("Record creates the initial frame", recorded, recorded ? "" : `message=${await s.message()} state=${await s.state()}`);
  if (!recorded) return;
  check("state shows Recording", (await s.state()) === "Recording");
  // A person does not click within a second of pressing Record; the ambient
  // clock needs a few ticks to be recognised.
  await page.waitForTimeout(1500);
  await page.click('[data-action="noop"]');
  check("no-op click creates no frame", !(await s.count(2, 3000)) && await frames.count() === 1, `frames=${await frames.count()}`);
  await page.click('[data-action="load-details"]');
  check("async page change creates a frame", await s.count(2));
  const firstLabel = await frames.nth(0).textContent();
  check("preceding frame labelled with the target", firstLabel.includes('Click "Load details"'), firstLabel);
  await page.click('[data-action="load-details"]');
  await page.waitForTimeout(150);
  await page.click('[data-action="load-details"]');
  check("rapid clicks coalesce into one frame", await s.count(3) && !(await s.count(4, 2500)), `frames=${await frames.count()}`);
  await page.click('[data-action="route"]');
  check("pushState route change creates a frame", await s.count(4));
  await Promise.all([page.waitForURL(`${s.base}/second.html`), page.click('[data-action="navigate"]')]);
  await toolbar.waitFor({ timeout: 5000 }).catch(() => {});
  check("same-origin navigation re-injects the toolbar and captures", await s.count(5, 6000), `frames=${await frames.count()}`);
  await page.waitForTimeout(600);
  await toolbar.locator('[data-action="capture"]').click();
  check("Manual Capture adds a labelled frame", await s.count(6) && (await frames.nth(5).textContent()).includes("Manual capture"));

  const other = await s.context.newPage();
  await other.goto(`${s.base}/?other`);
  await other.bringToFront();
  const paused = await until(async () => { const j = await s.readJourney(); return `${j.state}/${j.pauseReason}`; }, (v) => v === "Paused/tab");
  check("switching tabs pauses the Journey", paused === "Paused/tab", paused);
  await page.bringToFront();
  await page.waitForFunction(() => document.querySelector("clicksheet-toolbar")?.shadowRoot
    .querySelector('#clicksheet-toolbar-root [data-role="state"]').textContent === "Recording", null, { timeout: 5000 }).catch(() => {});
  check("returning to the recorded tab resumes", (await s.state()) === "Recording");
  await s.screenshot("toolbar.png");

  // Inspect what was persisted through the extension origin's private storage.
  const journey = await s.readJourney();
  const first = journey.frames[0];
  const scale = first.image.width / first.viewport.width;
  const image = await s.readImage(journey.id, "screenshots", first.screenshotFile, [[first.viewport.width / 2 * scale, 60 * scale]]);
  t.save("frame1.png", image.dataUrl.split(",")[1]);
  check("screenshots are stored as PNG files", image.bytes > 1000 && image.dataUrl.startsWith("data:image/png"), `${image.width}x${image.height}`);
  check("toolbar is hidden in captured pixels", image.pixels[0] !== "27,30,38", `pixel=${image.pixels[0]}`);
  check("frame metadata has no query or hash", journey.frames.every((f) => !/[?#]/.test(f.pathname)), journey.frames.map((f) => f.pathname).join(" "));
  check("no page errors", s.errors.length === 0, s.errors.join("; "));
}
