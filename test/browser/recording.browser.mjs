// Automatic recording: which clicks become frames, navigation, and tab pauses.
import { until } from "./harness.mjs";

export async function run(t) {
  const s = await t.launch({ windowSize: "1280,1600" });
  const { page, toolbar, frames, worker } = s;
  const { check } = t;
  // Captured data must stay local (FR-001.5): record every request the pages
  // and the extension worker make while recording.
  const external = [];
  let seen = 0;
  const watchRequest = (request) => {
    seen += 1;
    const url = new URL(request.url());
    const local = ["127.0.0.1", "localhost"].includes(url.hostname) || ["chrome-extension:", "data:", "blob:", "chrome:", "about:"].includes(url.protocol);
    if (!local) external.push(request.url());
  };
  s.context.on("request", watchRequest);
  s.worker.on?.("request", watchRequest);
  await s.open();
  await s.newJourney();
  // Where the widget sits when Record takes the first screenshot: its pill
  // and expanded panel must not appear in the stored pixels (FR-002.8).
  const widgetBoxes = await page.evaluate(() => {
    const shadow = document.querySelector("clicksheet-toolbar").shadowRoot;
    return [".cs-pill", ".cs-panel"].map((selector) => {
      const box = shadow.querySelector(selector).getBoundingClientRect();
      return [box.x + box.width / 2, box.y + box.height / 2];
    });
  });
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
  const clicked = (await until(s.readJourney, (j) => j?.frames[0]?.interaction)).frames[0];
  check("frames keep the page origin, and clicks keep the target's role and tag",
    clicked.origin === s.base && clicked.interaction?.role === "button" && clicked.interaction?.tag === "button",
    `${clicked.origin} ${clicked.interaction?.role} ${clicked.interaction?.tag}`);
  check("the stored page has no query string", !JSON.stringify(clicked).includes("?"));
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
  const paused = await until(async () => { const j = await s.readJourney(); return `${j?.state}/${j?.pauseReason}`; }, (v) => v === "Paused/tab");
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
  const image = await s.readImage(journey.id, "screenshots", first.screenshotFile, widgetBoxes.map(([x, y]) => [x * scale, y * scale]));
  t.save("frame1.png", image.dataUrl.split(",")[1]);
  check("screenshots are stored as PNG files", image.bytes > 1000 && image.dataUrl.startsWith("data:image/png"), `${image.width}x${image.height}`);
  check("the widget is hidden in captured pixels", image.pixels.every((pixel) => pixel !== "27,30,38"), `pixels=${image.pixels.join(" | ")}`);
  check("frame metadata has no query or hash", journey.frames.every((f) => !/[?#]/.test(f.pathname)), journey.frames.map((f) => f.pathname).join(" "));
  // The context for these real clicks (FR-C2): what an agent would receive.
  const contextText = await worker.evaluate(async (base) => {
    const [tab] = await chrome.tabs.query({ url: `${base}/*` });
    return (await globalThis.__journeys.request(tab.id, { action: "export", destination: "context" })).context;
  }, s.base);
  const context = JSON.parse(contextText);
  const clickedStep = context.steps.find((step) => step.interaction?.name === "Load details");
  check("the context describes each real click by name, role and tag, with the page's site and path",
    context.steps.length === journey.frames.length && clickedStep?.interaction.role === "button" && clickedStep.interaction.tag === "button" &&
    clickedStep.page.origin === s.base && clickedStep.page.pathname.startsWith("/") && context.steps.every((step) => Number.isFinite(step.sinceStartMs)),
    JSON.stringify(clickedStep));
  check("the context carries no query string or fragment", !/[?#]/.test(context.steps.map((step) => step.page.pathname).join("")) && !contextText.includes("token="));

  // Redaction over a real click (AC-C1): draw a box in the editor over the
  // button that was clicked, then read the context and the widget label.
  await toolbar.locator('[data-action="stop"]').click();
  await until(async () => (await s.readJourney())?.state, (state) => state === "Stopped");
  await frames.nth(0).click();
  const [editor] = await Promise.all([s.context.waitForEvent("page"), toolbar.locator('[data-action="edit"]').click()]);
  editor.on("pageerror", (error) => s.errors.push(`editor: ${error.message}`));
  await editor.waitForLoadState();
  const canvas = editor.locator("canvas");
  await canvas.waitFor();
  await editor.waitForFunction(() => document.querySelector("canvas")?.getBoundingClientRect().height > 200);
  const shown = await canvas.boundingBox();
  const toCanvas = shown.width / first.image.width;
  const rect = clicked.interaction.rect;
  const [left, top] = [(rect.x * scale) * toCanvas, (rect.y * scale) * toCanvas];
  const [right, bottom] = [((rect.x + rect.width) * scale) * toCanvas, ((rect.y + rect.height) * scale) * toCanvas];
  await editor.mouse.move(shown.x + left - 4, shown.y + top - 4);
  await editor.mouse.down();
  await editor.mouse.move(shown.x + right + 4, shown.y + bottom + 4, { steps: 5 });
  await editor.mouse.up();
  const closed = editor.waitForEvent("close", { timeout: 8000 }).then(() => true, () => false);
  await editor.getByRole("button", { name: /apply/i }).click();
  check("the editor applies a box over the clicked button", await closed);
  const redactedJourney = await until(s.readJourney, (j) => j?.frames[0]?.redacted === true);
  check("the box is stored on the frame", redactedJourney.frames[0].masks?.length === 1, JSON.stringify(redactedJourney.frames[0].masks));
  const redactedContext = JSON.parse(await worker.evaluate(async (base) => {
    const [tab] = await chrome.tabs.query({ url: `${base}/*` });
    return (await globalThis.__journeys.request(tab.id, { action: "export", destination: "context" })).context;
  }, s.base));
  const covered = redactedContext.steps[0].interaction;
  check("a box over the clicked button removes only its name from the context",
    redactedContext.steps[0].redacted === true && covered?.name === null && covered.role === "button" && covered.tag === "button" && covered.box?.width > 0 &&
    redactedContext.steps.some((step, index) => index > 0 && step.interaction?.name === "Load details"),
    JSON.stringify(covered));
  await page.bringToFront();
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  const coveredLabel = await until(() => frames.nth(0).textContent(), (text) => !text.includes("Load details"));
  check("the widget labels the redacted step as a plain Click", /^1\. Click$/.test(coveredLabel.trim()), coveredLabel);
  check("no request left the machine while recording", seen > 0 && external.length === 0, `${seen} requests seen; external: ${external.slice(0, 3).join(" ") || "none"}`);
  check("no page errors", s.errors.length === 0, s.errors.join("; "));
}
