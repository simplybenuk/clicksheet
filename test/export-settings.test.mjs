import assert from "node:assert/strict";
import test from "node:test";

import { createExportSettings, EXPORT_SETTINGS_KEY, memoryStorageArea } from "../extension/core/export-settings.js";

test("export settings default to Downloads and remember the Clicksheet folder choice", async () => {
  const area = memoryStorageArea();
  const settings = createExportSettings(area);
  assert.deepEqual(await settings.load(), { destination: "downloads" });
  assert.deepEqual(await settings.save({ destination: "library" }), { destination: "library" });
  assert.deepEqual(await createExportSettings(area).load(), { destination: "library" });
});

test("unknown destinations are refused, and stored junk reads as the default", async () => {
  const settings = createExportSettings(memoryStorageArea({ [EXPORT_SETTINGS_KEY]: { destination: "cloud" } }));
  assert.deepEqual(await settings.load(), { destination: "downloads" });
  await assert.rejects(settings.save({ destination: "cloud" }), /Choose Downloads or the Clicksheet folder/);
});
