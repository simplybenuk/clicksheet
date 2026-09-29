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

  // Viewer: View opens the selected screenshot; arrows move through the
  // Journey; Esc, the backdrop, and double-click behave as expected.
  const viewer = () => page.evaluate(() => {
    const shadow = document.querySelector("clicksheet-toolbar").shadowRoot;
    const dialog = shadow.querySelector('[data-role="viewer"]');
    const image = shadow.querySelector('[data-role="viewer-image"]');
    return { open: !dialog.hidden, title: shadow.querySelector('[data-role="viewer-title"]').textContent, width: image.naturalWidth, focused: shadow.activeElement?.dataset.action ?? null };
  });
  await frames.nth(2).click();
  await toolbar.locator('[data-action="view"]').click();
  const opened = await until(viewer, (state) => state.open && state.width > 0, 5000);
  check("View opens the selected screenshot at full size", opened.open && opened.width >= 1000 && opened.title.startsWith("3 of 11"), JSON.stringify(opened));
  check("the viewer takes keyboard focus", opened.focused === "viewer-close", opened.focused);
  await page.keyboard.press("ArrowRight");
  const stepped = await until(viewer, (state) => state.title.startsWith("4 of 11") && state.width > 0, 5000);
  check("the right arrow shows the next screenshot", stepped.title.startsWith("4 of 11"), stepped.title);
  await page.keyboard.press("Escape");
  check("Esc closes the viewer", !(await viewer()).open);
  const selectedAfter = await toolbar.locator('.clicksheet-toolbar__frame[aria-pressed="true"]').getAttribute("data-frame-id");
  check("the strip selection follows the viewer", selectedAfter === (await frames.nth(3).getAttribute("data-frame-id")));
  await frames.nth(0).dblclick();
  const doubled = await until(viewer, (state) => state.open && state.width > 0, 5000);
  check("double-clicking a thumbnail opens the viewer", doubled.open && doubled.title.startsWith("1 of 11"), doubled.title);
  await page.mouse.click(5, 300);
  check("clicking the backdrop closes the viewer", !(await viewer()).open);

  // A notice stays visible while collapsed.
  await toolbar.locator('[data-action="export"]').click();
  await toolbar.locator('[data-action="save-export"]').click();
  await until(() => toolbar.locator('[data-role="message"]').textContent(), (text) => /Saved \S+ and \S+ in/.test(text), 15000);
  await toolbar.locator('[data-action="expand"]').click();
  check("a notice stays visible while collapsed", !(await inner(".cs-panel"))?.visible && (await inner('[data-role="message"]'))?.visible === true);
  check("the saved-export bar stays visible while collapsed", (await inner('[data-role="export-bar"]'))?.visible === true);

  // The grip moves the widget with the arrow keys.
  // Click the grip with the mouse, as a person would, then use the keys.
  await toolbar.locator('[data-action="drag"]').click();
  const start = await inner(".cs-pill");
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
  // A name and description edited while storage is unavailable are held,
  // then saved once access returns; the widget is not left stuck. Access loss
  // is simulated in the worker by withdrawing the folder permission.
  await toolbar.locator('[data-action="settings"]').click();
  const saveStatus = () => toolbar.locator('[data-role="save-status"]').textContent();
  const setAccess = (granted) => worker.evaluate((granted) => {
    const proto = FileSystemHandle.prototype;
    globalThis.__queryPermission ??= proto.queryPermission;
    proto.queryPermission = granted ? globalThis.__queryPermission : async () => "prompt";
  }, granted);
  await setAccess(false);
  await toolbar.locator('[data-role="name"]').fill("Held name");
  await toolbar.locator('[data-role="description"]').fill("Held while the folder was unavailable.");
  const held = await until(saveStatus, (text) => text === "Storage unavailable", 5000);
  check("an edit while storage is unavailable is held", held === "Storage unavailable" && await s.messageMatches(/held here/, 5000), held);
  check("the held edit is not written yet", (await s.readJourney()).description !== "Held while the folder was unavailable.");
  await setAccess(true);
  // Returning to the page refreshes the widget, as after Reconnect.
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  const resumed = await until(saveStatus, (text) => text === "Saved locally", 8000);
  check("after reconnecting the status returns to Saved locally", resumed === "Saved locally", resumed);
  const savedHeld = await until(s.readJourney, (j) => j?.description === "Held while the folder was unavailable." && j?.name === "Held name");
  check("the held name and description are saved to journey.json", savedHeld?.description === "Held while the folder was unavailable." && savedHeld?.name === "Held name", JSON.stringify({ name: savedHeld?.name, description: savedHeld?.description }));
  const first = (await s.readJourney()).frames[0].id;
  await frames.first().click();
  await toolbar.locator('[data-action="move-right"]').click();
  const afterHeld = await until(async () => (await s.readJourney()).frames[1]?.id, (id) => id === first, 4000);
  check("commands work again after reconnecting", afterHeld === first && !/held here/.test(await s.message()), await s.message());

  // Overlapping saves: a refresh that starts while a rename is in flight
  // must not mark the edit saved when that rename then fails. The stub holds
  // the rename until the test releases it, so no step depends on timing.
  await worker.evaluate(() => {
    const journeys = globalThis.__journeys;
    const original = journeys.request;
    globalThis.__renameHeld = false;
    journeys.request = async (...args) => {
      if (args[1]?.action !== "rename") return original(...args);
      journeys.request = original;
      globalThis.__renameHeld = true;
      await new Promise((done) => { globalThis.__releaseRename = done; });
      throw new Error("Simulated failed rename.");
    };
  });
  await toolbar.locator('[data-role="name"]').fill("Raced name");
  await toolbar.locator('[data-role="name"]').blur();
  const heldRename = await until(() => worker.evaluate(() => globalThis.__renameHeld), Boolean, 5000);
  check("the debounced rename reaches the worker and is held", heldRename);
  // The focus listener starts its flush synchronously, so it overlaps the held rename.
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  check("an overlapping refresh does not report the held rename as saved", await saveStatus() !== "Saved locally", await saveStatus());
  await worker.evaluate(() => globalThis.__releaseRename());
  const raced = await until(s.readJourney, (j) => j?.name === "Raced name", 5000);
  check("a rename that fails during another save is kept and sent again", raced?.name === "Raced name" && await toolbar.locator('[data-role="name"]').inputValue() === "Raced name", raced?.name);
  const racedStatus = await until(saveStatus, (text) => text === "Saved locally", 5000);
  check("the status returns to Saved locally once the rename is written", racedStatus === "Saved locally", racedStatus);
  check("no page errors", s.errors.length === 0, s.errors.join("; "));
}
