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
  assert.deepEqual(manifest.permissions, ["activeTab", "scripting"]);
  assert.equal("host_permissions" in manifest, false);
  assert.equal(manifest.background.service_worker, "service-worker.js");
  assert.equal(manifest.background.type, "module");
  assert.equal(manifest.action.default_title, "Open Clicksheet");
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
});
