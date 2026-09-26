// Shared launcher for the opt-in Chromium suite (npm run test:browser).
// Scenarios receive a `t` from createScenario: `t.check` records results and
// `t.launch` opens a browser session whose resources are released by
// `t.cleanup`, which the runner always calls, even after a failure.
import { cpSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const repo = resolve(fileURLToPath(new URL("../..", import.meta.url)));
// Colour the fixture's password masks and editor redactions are drawn with.
export const MASK = "22,24,29";

let playwright;

// playwright-core is not a project dependency, so it is found through
// CLICKSHEET_PLAYWRIGHT (a module directory or entry file) or a normal import.
export async function loadPlaywright() {
  if (playwright) return playwright;
  const candidates = [];
  const configured = process.env.CLICKSHEET_PLAYWRIGHT;
  if (configured) {
    let entry = resolve(configured);
    try { if (statSync(entry).isDirectory()) entry = join(entry, "index.mjs"); } catch {}
    candidates.push(pathToFileURL(entry).href);
  }
  candidates.push("playwright-core");
  const failures = [];
  for (const specifier of candidates) {
    try {
      const module = await import(specifier);
      const chromium = module.chromium ?? module.default?.chromium;
      if (chromium) return (playwright = { chromium });
      failures.push(`${specifier}: no chromium export`);
    } catch (error) {
      failures.push(`${specifier}: ${error.message.split("\n")[0]}`);
    }
  }
  console.error([
    "The browser suite needs playwright-core and a Chromium build, which are not project dependencies.",
    "Set CLICKSHEET_PLAYWRIGHT to an installed playwright-core directory (or install it where Node can import it),",
    "and CLICKSHEET_CHROMIUM to a Chromium executable if Playwright's default browser is not installed.",
    ...failures.map((line) => `  tried ${line}`)
  ].join("\n"));
  process.exit(2);
}

// The OS picks an unused port, so scenarios never clash with each other or
// with a fixture server someone left running.
function freePort() {
  return new Promise((done, fail) => {
    const probe = createServer().once("error", fail).listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => done(port));
    });
  });
}

// Resolves once the fixture server reports it is listening, rather than
// guessing with a sleep.
async function startFixture(port) {
  const server = spawn(process.execPath, [`${repo}/scripts/serve-fixture.mjs`], {
    env: { ...process.env, CLICKSHEET_FIXTURE_PORT: String(port) },
    stdio: ["ignore", "pipe", "inherit"]
  });
  await new Promise((done, fail) => {
    server.stdout.on("data", (chunk) => { if (String(chunk).includes("available")) done(); });
    server.once("exit", (code) => fail(new Error(`fixture server on port ${port} exited (${code})`)));
  });
  server.stdout.resume();
  return server;
}

// Lets the request check see the extension worker's requests too.
process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS ??= "1";

// Test-only extension copy. Automation cannot click the toolbar icon, so the
// copy gets broad host access and exposes the action handler to the worker;
// the toolbar's closed shadow root is opened so locators can reach it.
function prepareExtension({ openShadow }) {
  const ext = mkdtempSync(join(tmpdir(), "clicksheet-ext-"));
  cpSync(`${repo}/dist`, ext, { recursive: true });
  const manifest = JSON.parse(readFileSync(`${ext}/manifest.json`, "utf8"));
  manifest.host_permissions = ["<all_urls>"];
  writeFileSync(`${ext}/manifest.json`, JSON.stringify(manifest));
  const worker = readFileSync(`${ext}/service-worker.js`, "utf8");
  if (!worker.includes("function openClicksheet")) throw new Error("dist/service-worker.js no longer defines openClicksheet; update the harness");
  writeFileSync(`${ext}/service-worker.js`, `${worker}\nglobalThis.__openClicksheet = openClicksheet;\nglobalThis.__captureFromShortcut = captureFromShortcut;\n`);
  if (openShadow) {
    const toolbar = readFileSync(`${ext}/content/toolbar.js`, "utf8");
    if (!toolbar.includes('mode: "closed"')) throw new Error("dist/content/toolbar.js no longer attaches a closed shadow root; update the harness");
    writeFileSync(`${ext}/content/toolbar.js`, toolbar.replace('mode: "closed"', 'mode: "open"'));
  }
  return ext;
}

// Polls `read` until `ok` accepts its value; returns the last value either
// way so the check can report what was actually seen.
export async function until(read, ok = Boolean, timeout = 5000, interval = 100) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await read();
    if (ok(value) || Date.now() >= deadline) return value;
    await new Promise((done) => setTimeout(done, interval));
  }
}

export function createScenario(name) {
  const results = [];
  const cleanups = [];
  const outDir = process.env.CLICKSHEET_BROWSER_OUT;
  const t = {
    name,
    results,
    check(label, ok, detail = "") {
      results.push({ label, ok: Boolean(ok) });
      console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
    },
    // Debug images are only written when CLICKSHEET_BROWSER_OUT is set.
    artifact(file) {
      if (!outDir) return null;
      mkdirSync(outDir, { recursive: true });
      return join(outDir, `${name}-${file}`);
    },
    save(file, base64) {
      const path = t.artifact(file);
      if (path) writeFileSync(path, Buffer.from(base64, "base64"));
    },
    async cleanup() {
      for (const release of cleanups.splice(0).reverse()) await release().catch(() => {});
    },
    launch: (options) => launch(t, cleanups, options)
  };
  return t;
}

async function launch(t, cleanups, { openShadow = true, windowSize = "1280,1000" } = {}) {
  const { chromium } = await loadPlaywright();
  const ext = prepareExtension({ openShadow });
  cleanups.push(async () => rmSync(ext, { recursive: true, force: true }));
  const serve = async () => {
    const port = await freePort();
    const server = await startFixture(port);
    cleanups.push(async () => { server.kill(); });
    return port;
  };
  const port = await serve();
  const profile = mkdtempSync(join(tmpdir(), "clicksheet-profile-"));
  cleanups.push(async () => rmSync(profile, { recursive: true, force: true }));
  const context = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.CLICKSHEET_CHROMIUM || undefined,
    headless: true,
    viewport: null,
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, `--window-size=${windowSize}`, "--no-sandbox"]
  });
  cleanups.push(() => context.close());
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
  const extId = new URL(worker.url()).host;

  // The extension's private file system stands in for the folder a person
  // would pick, so journeys can be inspected from an extension page.
  const storagePage = await context.newPage();
  await storagePage.goto(`chrome-extension://${extId}/pages/storage.html`);
  await storagePage.evaluate(async () => {
    const { saveRootHandle } = await import("/core/handle-store.js");
    await saveRootHandle(await navigator.storage.getDirectory());
  });

  const base = `http://127.0.0.1:${port}`;
  const errors = [];
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  const toolbar = page.locator("#clicksheet-toolbar-root");
  const frames = toolbar.locator(".clicksheet-toolbar__frame");
  const text = (role) => toolbar.locator(`[data-role="${role}"]`).textContent();

  const s = {
    context, worker, storagePage, page, base, errors, toolbar, frames, extId,
    serve,
    state: () => text("state"),
    message: () => text("message"),
    // Stands in for clicking the toolbar icon on the tab showing `url`.
    invoke: (url = base) => worker.evaluate(async (url) => {
      const [tab] = await chrome.tabs.query({ url: `${url}/*` });
      await globalThis.__openClicksheet(tab);
    }, url),
    async open(path = "/") {
      await page.goto(`${base}${path}`);
      await page.bringToFront();
      await s.invoke();
      await toolbar.waitFor();
    },
    // True once the filmstrip shows exactly `n` frames within `timeout`.
    async count(n, timeout = 6000) {
      try {
        await page.waitForFunction((n) => document.querySelector("clicksheet-toolbar")?.shadowRoot
          .querySelectorAll("#clicksheet-toolbar-root .clicksheet-toolbar__frame").length === n, n, { timeout });
        return true;
      } catch { return false; }
    },
    // Waits for the toolbar message to match; returns whether it did.
    async messageMatches(pattern, timeout = 15000) {
      try {
        await page.waitForFunction((source) => new RegExp(source).test(document.querySelector("clicksheet-toolbar")?.shadowRoot
          .querySelector('#clicksheet-toolbar-root [data-role="message"]').textContent), pattern.source, { timeout });
        return true;
      } catch { return false; }
    },
    async newJourney() {
      await toolbar.locator('[data-action="library"]').click();
      await toolbar.locator('[data-action="new"]').click();
      await page.waitForFunction(() => !document.querySelector("clicksheet-toolbar")?.shadowRoot
        .querySelector('#clicksheet-toolbar-root [data-action="capture"]').disabled);
    },
    // Latest-updated journey, plus the files in its folders.
    readJourney: () => storagePage.evaluate(async () => {
      const journeys = await (await navigator.storage.getDirectory()).getDirectoryHandle("journeys");
      let latest = null;
      for await (const [, dir] of journeys.entries()) {
        const journey = JSON.parse(await (await (await dir.getFileHandle("journey.json")).getFile()).text());
        if (latest && journey.updatedAt <= latest.journey.updatedAt) continue;
        const list = async (kind) => {
          const names = [];
          try { for await (const name of (await dir.getDirectoryHandle(kind)).keys()) names.push(name); } catch {}
          return names;
        };
        latest = { journey, shots: await list("screenshots"), exports: await list("exports") };
      }
      if (!latest) return null;
      return Object.assign(latest.journey, { shots: latest.shots, exports: latest.exports });
    }),
    // Reads a stored PNG: size, data URL and the RGB of each requested point.
    readImage: (journeyId, kind, file, points = []) => storagePage.evaluate(async ({ journeyId, kind, file, points }) => {
      const dir = await (await (await navigator.storage.getDirectory()).getDirectoryHandle("journeys")).getDirectoryHandle(journeyId);
      const blob = await (await (await dir.getDirectoryHandle(kind)).getFileHandle(file)).getFile();
      const bitmap = await createImageBitmap(blob);
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext("2d");
      ctx.drawImage(bitmap, 0, 0);
      const dataUrl = await new Promise((done) => { const reader = new FileReader(); reader.onload = () => done(reader.result); reader.readAsDataURL(blob); });
      return {
        width: bitmap.width, height: bitmap.height, bytes: blob.size, dataUrl,
        pixels: points.map(([x, y]) => [...ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data.slice(0, 3)].join())
      };
    }, { journeyId, kind, file, points }),
    async pixel(journeyId, file, x, y) {
      return (await s.readImage(journeyId, "screenshots", file, [[x, y]])).pixels[0];
    },
    async screenshot(file, options = {}) {
      const path = t.artifact(file);
      if (path) await page.screenshot({ ...options, path });
    }
  };
  return s;
}
