// The floating widget (spec 1.2): placement clear of top navigation,
// collapsing while recording, moving, hiding, the strip after navigation,
// the reorder insertion line, and the shortcut list.
import { until } from "./harness.mjs";

export async function run(t) {
  const s = await t.launch();
  const { page, toolbar, worker } = s;
  const { check } = t;
  const inner = (selector) => page.evaluate((selector) => {
    const box = document.querySelector("clicksheet-toolbar").shadowRoot.querySelector(selector)?.getBoundingClientRect();
    return box ? { x: box.x, y: box.y, width: box.width, height: box.height, visible: box.width > 0 && box.height > 0 } : null;
  }, selector);
  await s.open();
  const pill = await inner(".cs-pill");
  const height = await page.evaluate(() => innerHeight);
  check("the widget starts in the lower half, clear of top navigation", pill.y > height / 2, JSON.stringify(pill));

  await s.newJourney();
  await toolbar.locator('[data-action="record"]').click();
  await s.count(1);
  check("Record collapses the widget to its controls", !(await inner(".cs-panel"))?.visible && await toolbar.locator('[data-role="count"]').textContent() === "1 shot");

  // Enough frames to overflow the strip.
  await page.waitForTimeout(1500);
  for (let n = 0; n < 9; n++) {
    await page.click('[data-action="next-page"]');
    await page.waitForTimeout(900);
  }
  await s.count(10, 6000);

  // Move the widget with the grip; the position survives a navigation.
  const grip = await inner('[data-action="drag"]');
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(120, 700, { steps: 8 });
  await page.mouse.up();
  const moved = await inner(".cs-pill");
  check("dragging the grip moves the widget", Math.abs(moved.x - (120 - grip.width / 2 - 8)) < 40 && Math.abs(moved.y - 700) < 40, JSON.stringify(moved));
  await Promise.all([page.waitForURL(`${s.base}/second.html`), page.click('[data-action="navigate"]')]);
  await toolbar.waitFor();
  await s.count(11, 8000);
  const after = await until(() => inner(".cs-pill"), (box) => box && Math.abs(box.x - moved.x) < 4, 3000);
  check("the widget keeps its position after navigation", Math.abs(after.x - moved.x) < 4 && Math.abs(after.y - moved.y) < 4, `${JSON.stringify(after)} vs ${JSON.stringify(moved)}`);

  await toolbar.locator('[data-action="stop"]').click();
  await until(() => inner(".cs-panel"), (box) => box?.visible, 3000);
  check("Stop expands the panel for editing", (await inner(".cs-panel"))?.visible === true);
  const scroll = await until(() => page.evaluate(() => {
    const strip = document.querySelector("clicksheet-toolbar").shadowRoot.querySelector('[data-role="strip"]');
    return { left: strip.scrollLeft, max: strip.scrollWidth - strip.clientWidth };
  }), (value) => value.max > 0 && value.left >= value.max - 180, 3000);
  check("after navigation the strip shows the newest screenshots, not the first", scroll.max > 0 && scroll.left >= scroll.max - 180, JSON.stringify(scroll));

  // Reorder by pointer: an insertion line appears while dragging.
  const frames = toolbar.locator(".clicksheet-toolbar__frame");
  const last = await frames.last().boundingBox();
  const target = await frames.nth(-3).boundingBox();
  await page.mouse.move(last.x + last.width / 2, last.y + last.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x + 10, target.y + target.height / 2, { steps: 10 });
  const line = await inner(".cs-drop");
  check("dragging a thumbnail shows an insertion line", Boolean(line?.visible), JSON.stringify(line));
  await page.mouse.up();
  check("the insertion line goes away after the drop", !(await inner(".cs-drop")));

  // Hide, then show again with the toggle shortcut's message.
  await toolbar.locator('[data-action="dismiss"]').click();
  check("the close button hides the widget", !(await toolbar.isVisible()));
  await worker.evaluate(async (url) => {
    const [tab] = await chrome.tabs.query({ url: `${url}/*` });
    await globalThis.__captureFromShortcut("toggle", tab);
  }, s.base);
  check("the show/hide shortcut brings it back", await until(() => toolbar.isVisible(), Boolean, 3000));

  await toolbar.locator('[data-action="settings"]').click();
  const shortcuts = await until(() => toolbar.locator('[data-role="shortcut-list"]').textContent(), (text) => text.startsWith("Capture:"), 3000);
  check("Settings lists the capture and show/hide shortcuts", /^Capture: .+ · Show\/hide: .+$/.test(shortcuts), shortcuts);
  check("Delete is styled as destructive", await toolbar.locator('[data-action="delete"]').evaluate((el) => el.classList.contains("cs-danger")));
  check("no page errors", s.errors.length === 0, s.errors.join("; "));
}
