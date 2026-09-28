// Passwords stay masked in stored pixels, wherever they live, and page
// scripts cannot see into the shipped toolbar.
import { MASK } from "./harness.mjs";

export async function run(t) {
  await revealedPassword(t);
  await framesAndComponents(t);
  await closedShadowRoot(t);
}

async function revealedPassword(t) {
  const s = await t.launch({ windowSize: "1280,1600" });
  const { page, toolbar } = s;
  const { check } = t;
  await s.open();
  await s.newJourney();
  await toolbar.locator('[data-action="record"]').click();
  const recorded = await s.count(1, 5000);
  check("Record creates the initial frame", recorded, recorded ? "" : `message=${await s.message()} state=${await s.state()}`);
  if (!recorded) return;
  check("state shows Recording", (await s.state()) === "Recording");
  const field = await page.locator('[data-role="password"]').boundingBox();
  await page.click('[data-action="reveal-password"]');
  check("revealing the password creates a frame", await s.count(2, 5000));
  const journey = await s.readJourney();
  const inField = await s.pixel(journey.id, journey.frames[1].screenshotFile, Math.round(field.x + field.width / 2), Math.round(field.y + field.height / 2));
  check("a revealed password stays masked in stored pixels", inField === MASK, `${inField} type=${await page.locator('[data-role="password"]').getAttribute("type")}`);
  check("the revealed field's label is its accessible name only", journey.frames[0].interaction?.label === "Show password", journey.frames[0].interaction?.label);
  check("no page errors", s.errors.length === 0, s.errors.join("; "));
}

async function framesAndComponents(t) {
  const s = await t.launch();
  const { page, toolbar } = s;
  const { check } = t;
  await s.open("/login.html");
  await s.newJourney();
  // A component added after the toolbar, rendering its field asynchronously.
  await page.evaluate(() => { const extra = document.createElement("fixture-login"); extra.id = "late"; document.querySelector("main").append(extra); });
  await page.locator("#late").locator('[data-role="password"]').waitFor({ state: "attached" });
  await page.waitForTimeout(200);
  const frame = page.frameLocator('[data-role="login-frame"]');
  const component = page.locator("fixture-login:not(#late)");
  const late = page.locator("#late");
  await frame.locator('[data-action="reveal"]').click();
  await component.locator('[data-action="reveal"]').click();
  await late.locator('[data-action="reveal"]').click();
  const types = await page.evaluate(() => [document.querySelector("iframe").contentDocument.querySelector("input").type, ...[...document.querySelectorAll("fixture-login")].map((el) => el.shadowRoot.querySelector("input").type)]);
  const boxes = [];
  for (const scope of [frame, component, late]) boxes.push(await scope.locator('[data-role="password"]').boundingBox());
  await toolbar.locator('[data-action="capture"]').click();
  check("manual capture after revealing", await s.count(1));
  const journey = await s.readJourney();
  const values = [];
  for (const box of boxes) values.push(await s.pixel(journey.id, journey.frames[0].screenshotFile, Math.round(box.x + box.width / 2), Math.round(box.y + box.height / 2)));
  check("revealed passwords stay masked in a frame and in web components", values.every((v) => v === MASK), `${values.join(" | ")} types=${types.join(",")}`);
  check("no page errors", s.errors.length === 0, s.errors.join("; "));
}

// Uses the shipped closed shadow root, so nothing here reaches inside it.
async function closedShadowRoot(t) {
  const s = await t.launch({ openShadow: false, windowSize: "1280,1600" });
  const { page } = s;
  const { check } = t;
  await page.goto(s.base);
  await page.bringToFront();
  await s.invoke();
  await page.waitForSelector("clicksheet-toolbar", { state: "attached" });
  // The toolbar renders inside the closed root, which the page cannot
  // observe; give it time so an empty host is a meaningful result.
  await page.waitForTimeout(1500);
  const hidden = await page.evaluate(() => { const host = document.querySelector("clicksheet-toolbar"); return { present: Boolean(host), shadow: host?.shadowRoot ?? null, text: host?.textContent ?? "" }; });
  check("page scripts see only an empty host element", hidden.present && hidden.shadow === null && hidden.text === "", JSON.stringify(hidden));
  await s.screenshot("closed.png");
  check("no page errors", s.errors.length === 0, s.errors.join("; "));
}
