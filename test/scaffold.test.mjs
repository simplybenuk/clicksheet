import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import { classifyPage } from "../extension/core/supported-pages.js";

const projectRoot = resolve(import.meta.dirname, "..");
const read = (path) => readFileSync(resolve(projectRoot, path), "utf8");

test("the extension manifest uses temporary active-tab access", () => {
  const manifest = JSON.parse(read("extension/manifest.json"));

  assert.equal(manifest.manifest_version, 3);
  // `storage` holds per-session tab bindings; it adds no install warning.
  // `downloads` and `downloads.open` save exports to Downloads and open them
  // (spec journey-context-export FR-C5); nothing else is added.
  assert.deepEqual(manifest.permissions, ["activeTab", "scripting", "storage", "downloads", "downloads.open"]);
  assert.equal("host_permissions" in manifest, false);
  assert.equal(manifest.background.service_worker, "service-worker.js");
  assert.equal(manifest.background.type, "module");
  assert.equal(manifest.action.default_title, "Open Clicksheet");
  assert.deepEqual(manifest.options_ui, { page: "pages/storage.html", open_in_tab: true });
  // Only the Open / Show bar is exposed to pages, behind a per-session URL.
  assert.deepEqual(manifest.web_accessible_resources, [{
    resources: ["pages/export-bar.html", "pages/export-bar.js", "pages/export-bar.css"],
    matches: ["http://*/*", "https://*/*"],
    use_dynamic_url: true
  }]);
});

test("every icon the manifest names exists at its declared size", () => {
  const manifest = JSON.parse(read("extension/manifest.json"));
  const icons = [...Object.entries(manifest.icons), ...Object.entries(manifest.action.default_icon)];

  // The Chrome Web Store requires a 128px icon in the package.
  assert.equal(manifest.icons["128"], "icons/icon-128.png");

  for (const [size, path] of icons) {
    const png = readFileSync(resolve(projectRoot, "extension", path));
    assert.equal(png.readUInt32BE(16), Number(size), `${path} width`);
    assert.equal(png.readUInt32BE(20), Number(size), `${path} height`);
  }
});

test("supported-page classification accepts standard web pages only", () => {
  assert.deepEqual(classifyPage("https://example.test/dashboard"), {
    supported: true,
    reason: ""
  });
  assert.deepEqual(classifyPage("http://127.0.0.1:4173/"), {
    supported: true,
    reason: ""
  });
  assert.equal(classifyPage("chrome://settings").supported, false);
  assert.equal(classifyPage("file:///tmp/page.html").supported, false);
  assert.equal(classifyPage(undefined).supported, false);
});

test("the service worker injects the scaffold from an action click", () => {
  const serviceWorker = read("extension/service-worker.js");

  assert.match(serviceWorker, /chrome\.action\.onClicked/);
  assert.match(serviceWorker, /chrome\.scripting\.executeScript/);
  assert.match(serviceWorker, /content\/toolbar\.js/);
  assert.match(serviceWorker, /content\/toolbar\.css/);
});

test("the fixture is self-contained and exposes future capture states", () => {
  const fixture = read("fixtures/index.html");

  assert.match(fixture, /data-fixture-page="supported"/);
  assert.match(fixture, /type="password"/);
  assert.match(fixture, /data-action="load-details"/);
  assert.match(fixture, /aria-live="polite"/);
  assert.match(read("fixtures/fixture.js"), /setTimeout/);
});

test("the build output contains a loadable extension package", () => {
  assert.equal(existsSync(resolve(projectRoot, "dist/manifest.json")), true);
  assert.equal(existsSync(resolve(projectRoot, "dist/service-worker.js")), true);
  assert.equal(existsSync(resolve(projectRoot, "dist/content/toolbar.js")), true);
  assert.equal(existsSync(resolve(projectRoot, "dist/content/toolbar.css")), true);
  assert.equal(existsSync(resolve(projectRoot, "dist/pages/storage.html")), true);
  assert.equal(existsSync(resolve(projectRoot, "dist/core/storage.js")), true);
  assert.equal(existsSync(resolve(projectRoot, "dist/icons/icon-128.png")), true);
});
