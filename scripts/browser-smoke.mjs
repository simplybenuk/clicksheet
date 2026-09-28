// Opt-in Chromium suite: builds dist/, then runs test/browser/*.browser.mjs
// one at a time (or only the scenarios named on the command line).
// Usage: node scripts/browser-smoke.mjs [recording editing-export ...]
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createScenario, loadPlaywright, repo } from "../test/browser/harness.mjs";

// A hung browser must not hang the suite; this bounds each scenario.
const SCENARIO_TIMEOUT_MS = 180_000;
const suffix = ".browser.mjs";
const directory = resolve(repo, "test/browser");
const available = readdirSync(directory).filter((file) => file.endsWith(suffix)).map((file) => file.slice(0, -suffix.length)).sort();
const requested = process.argv.slice(2);
const unknown = requested.filter((name) => !available.includes(name));
if (unknown.length) {
  console.error(`Unknown scenario: ${unknown.join(", ")}. Available: ${available.join(", ")}`);
  process.exit(2);
}

const build = spawnSync("npm", ["run", "build"], { cwd: repo, stdio: "inherit", shell: process.platform === "win32" });
if (build.status !== 0) process.exit(build.status ?? 1);
await loadPlaywright();

const summary = [];
for (const name of requested.length ? requested : available) {
  console.log(`\n== ${name} ==`);
  const t = createScenario(name);
  let timer;
  try {
    const { run } = await import(pathToFileURL(resolve(directory, `${name}${suffix}`)).href);
    await Promise.race([
      run(t),
      new Promise((_, fail) => { timer = setTimeout(() => fail(new Error(`timed out after ${SCENARIO_TIMEOUT_MS} ms`)), SCENARIO_TIMEOUT_MS); })
    ]);
  } catch (error) {
    t.check("scenario completed", false, error.stack ?? String(error));
  } finally {
    clearTimeout(timer);
    await t.cleanup();
  }
  const passed = t.results.filter((r) => r.ok).length;
  summary.push({ name, passed, total: t.results.length });
}

console.log("\nSummary");
for (const { name, passed, total } of summary) console.log(`${passed === total ? "PASS" : "FAIL"} ${name}: ${passed}/${total}`);
const passed = summary.reduce((sum, s) => sum + s.passed, 0);
const total = summary.reduce((sum, s) => sum + s.total, 0);
console.log(`${passed}/${total} checks passed`);
process.exitCode = passed === total && total > 0 ? 0 : 1;
