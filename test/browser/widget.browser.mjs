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

  // Reorder by pointer: an insertion line appears while dragging, the new
  // order is saved, and the release does not count as a click.
  const frames = toolbar.locator(".clicksheet-toolbar__frame");
  const before = (await s.readJourney()).frames.map((frame) => frame.id);
  const last = await frames.last().boundingBox();
  const target = await frames.nth(-3).boundingBox();
  await page.mouse.move(last.x + last.width / 2, last.y + last.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x + 10, target.y + target.height / 2, { steps: 10 });
  const line = await inner(".cs-drop");
  check("dragging a thumbnail shows an insertion line", Boolean(line?.visible), JSON.stringify(line));
  await page.mouse.up();
  check("the insertion line goes away after the drop", !(await inner(".cs-drop")));
  const expected = [...before.slice(0, -3), before.at(-1), ...before.slice(-3, -1)];
  const reordered = await until(async () => (await s.readJourney()).frames.map((frame) => frame.id), (ids) => ids.join() === expected.join(), 4000);
  check("the drop saves the order shown by the line", reordered.join() === expected.join());
  const pressed = await toolbar.locator('.clicksheet-toolbar__frame[aria-pressed="true"]').getAttribute("data-frame-id");
  check("the moved screenshot is selected and the release is not a second click", pressed === before.at(-1), pressed);

  // Undo and Move keep the selected screenshot in view.
  const stripState = () => page.evaluate(() => {
    const shadow = document.querySelector("clicksheet-toolbar").shadowRoot;
    const strip = shadow.querySelector('[data-role="strip"]');
    const selected = shadow.querySelector('.clicksheet-toolbar__frame[aria-pressed="true"]');
    const box = strip.getBoundingClientRect();
    const item = selected?.getBoundingClientRect();
    return { id: selected?.dataset.frameId ?? null, inView: Boolean(item) && item.left >= box.left - 1 && item.right <= box.right + 1 };
  });
  await frames.nth(1).click();
  const second = (await stripState()).id;
  await toolbar.locator('[data-action="delete"]').click();
  await s.count(10);
  await toolbar.locator('[data-action="undo"]').click();
  await s.count(11);
  const undone = await until(stripState, (state) => state.id === second && state.inView, 3000);
  check("Undo delete selects the restored screenshot and keeps it in view", undone.id === second && undone.inView, JSON.stringify(undone));
  await frames.first().click();
  for (let n = 0; n < 7; n++) {
    await toolbar.locator('[data-action="move-right"]').click();
    await page.waitForTimeout(150);
  }
  const moving = await until(stripState, (state) => state.inView, 3000);
  check("Move right keeps the selected screenshot in view", moving.inView, JSON.stringify(moving));

  // A notice stays visible while collapsed.
  await toolbar.locator('[data-action="export"]').click();
  await toolbar.locator('[data-action="download-image"]').click();
  await until(() => toolbar.locator('[data-role="message"]').textContent(), (text) => /Saved .*\.png/.test(text), 15000);
  await toolbar.locator('[data-action="expand"]').click();
  check("a notice stays visible while collapsed", !(await inner(".cs-panel"))?.visible && (await inner('[data-role="message"]'))?.visible === true);

  // The grip moves the widget with the arrow keys.
  const start = await inner(".cs-pill");
  await toolbar.locator('[data-action="drag"]').focus();
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowUp");
  const nudged = await inner(".cs-pill");
  check("arrow keys on the grip move the widget", Math.round(start.x - nudged.x) === 16 && Math.round(start.y - nudged.y) === 16, `${JSON.stringify(start)} -> ${JSON.stringify(nudged)}`);

  // Collapsed stays collapsed after a reload.
  await page.reload();
  await s.invoke();
  await toolbar.waitFor();
  await page.waitForTimeout(500);
  check("the collapsed state is remembered across pages", !(await inner(".cs-panel"))?.visible);
  await toolbar.locator('[data-action="expand"]').click();

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
