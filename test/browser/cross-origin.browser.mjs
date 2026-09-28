// Leaving the recorded origin pauses; invoking Clicksheet there resumes.
// A second fixture server reached as `localhost` is a different origin.
import { until } from "./harness.mjs";

export async function run(t) {
  const s = await t.launch({ windowSize: "1280,1600" });
  const { page, toolbar } = s;
  const { check } = t;
  const other = `http://localhost:${await s.serve()}`;
  const summary = async () => {
    const journey = await s.readJourney();
    return { state: `${journey.state}/${journey.pauseReason}`, kinds: journey.frames.map((f) => f.kind), paths: journey.frames.map((f) => f.pathname) };
  };
  await s.open();
  await s.newJourney();
  await toolbar.locator('[data-action="record"]').click();
  const recorded = await s.count(1, 5000);
  check("Record creates the initial frame", recorded, recorded ? "" : `message=${await s.message()} state=${await s.state()}`);
  if (!recorded) return;
  check("state shows Recording", (await s.state()) === "Recording");

  await page.goto(`${other}/second.html`);
  let seen = await until(summary, (v) => v.state === "Paused/navigation");
  check("cross-origin navigation pauses the Journey", seen.state === "Paused/navigation", JSON.stringify(seen));
  check("no toolbar is injected on the other origin", await page.locator("#clicksheet-toolbar-root").count() === 0);

  await s.invoke(other);
  await toolbar.waitFor();
  seen = await until(summary, (v) => v.state === "Recording/null" && v.kinds.at(-1) === "reentry");
  check("re-invoking captures the page and resumes", seen.state === "Recording/null" && seen.kinds.at(-1) === "reentry" && seen.paths.at(-1) === "/second.html", JSON.stringify(seen));
  await page.waitForFunction(() => document.querySelector("clicksheet-toolbar")?.shadowRoot
    .querySelector('#clicksheet-toolbar-root [data-role="state"]').textContent === "Recording", null, { timeout: 5000 }).catch(() => {});
  check("toolbar shows Recording after re-entry", (await s.state()) === "Recording", await s.state());

  await page.click('[data-action="home"]');
  seen = await until(summary, (v) => v.kinds.length === 3 && v.paths.at(-1) === "/");
  check("recording continues on the new origin", seen.kinds.length === 3 && seen.paths.at(-1) === "/", JSON.stringify(seen));
}
