import assert from "node:assert/strict";
import test from "node:test";

import { exportTimestamp, nextExportBase, nextExportName, slugifyJourneyName } from "../extension/core/export-names.js";

test("slugs are lowercase ASCII with single hyphens", () => {
  assert.equal(slugifyJourneyName("Create a new user"), "create-a-new-user");
  assert.equal(slugifyJourneyName("  Café -- Déjà vu!  "), "cafe-deja-vu");
  assert.equal(slugifyJourneyName("Settings / Users & Roles (v2)"), "settings-users-roles-v2");
  assert.equal(slugifyJourneyName("ﬁle Ⅻ"), "file-xii");
});

test("slugs fall back when nothing usable remains", () => {
  for (const name of ["", "   ", "!!!", "日本語", null, undefined]) {
    assert.equal(slugifyJourneyName(name), "untitled-journey");
  }
});

test("long slugs are capped without a trailing hyphen", () => {
  const slug = slugifyJourneyName(`${"a".repeat(59)} bcdef`);
  assert.equal(slug, "a".repeat(59));
  assert.ok(slugifyJourneyName("word ".repeat(40)).length <= 60);
  assert.doesNotMatch(slugifyJourneyName("word ".repeat(40)), /-$/);
});

test("export names get numeric suffixes on collision, case-insensitively", () => {
  assert.equal(nextExportName("flow", []), "flow.png");
  assert.equal(nextExportName("flow", ["other.png"]), "flow.png");
  assert.equal(nextExportName("flow", ["flow.png"]), "flow-2.png");
  assert.equal(nextExportName("flow", ["FLOW.PNG", "flow-2.png"]), "flow-3.png");
  assert.equal(nextExportName("flow", ["flow.png", "flow-3.png"]), "flow-2.png");
});

test("pair bases are free for both files", () => {
  assert.equal(nextExportBase("flow", []), "flow");
  assert.equal(nextExportBase("flow", ["flow.png"]), "flow-2");
  assert.equal(nextExportBase("flow", ["FLOW.json", "flow-2.PNG"]), "flow-3");
});

test("Downloads timestamps use the local date and time", () => {
  assert.equal(exportTimestamp(new Date(2026, 8, 9, 7, 5)), "2026-09-09-0705");
});
