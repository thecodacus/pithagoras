/**
 * Unit tests for src/settings.ts: defaults when missing, field-by-field merge of a partial file, corrupt JSON
 * -> defaults, and save round-trips that keep untouched fields. All roots are mkdtemp tmp dirs -- portal() is
 * never reached (every call passes an explicit root).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadSettings, saveSettings, DEFAULT_SETTINGS } from "../src/settings";

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "office-settings-"));
}

test("loadSettings: missing file -> defaults", () => {
  const root = tmpRoot();
  assert.deepEqual(loadSettings(root), DEFAULT_SETTINGS);
});

test("loadSettings: partial file merges field by field, unknown fields ignored", () => {
  const root = tmpRoot();
  fs.writeFileSync(path.join(root, "settings.json"), JSON.stringify({ enabled: true, imageTag: "some/other:9.9", nonsense: 42 }));
  assert.deepEqual(loadSettings(root), { enabled: true, imageTag: "some/other:9.9", coEdit: true });
});

test("loadSettings: corrupt JSON -> defaults; non-object JSON -> defaults", () => {
  const root = tmpRoot();
  fs.writeFileSync(path.join(root, "settings.json"), "{ not json !");
  assert.deepEqual(loadSettings(root), DEFAULT_SETTINGS);
  fs.writeFileSync(path.join(root, "settings.json"), JSON.stringify([1, 2, 3]));
  assert.deepEqual(loadSettings(root), DEFAULT_SETTINGS);
});

test("loadSettings: wrong-type values fall back to the default for that field", () => {
  const root = tmpRoot();
  fs.writeFileSync(path.join(root, "settings.json"), JSON.stringify({ enabled: "yes" }));
  const s = loadSettings(root);
  assert.equal(s.enabled, DEFAULT_SETTINGS.enabled);
  assert.equal(s.imageTag, DEFAULT_SETTINGS.imageTag);
});

test("saveSettings: round-trip keeps other fields and ignores unknown patch keys", () => {
  const root = tmpRoot();
  const first = saveSettings({ enabled: true }, root);
  assert.deepEqual(first, { ...DEFAULT_SETTINGS, enabled: true });
  // a later patch must not clobber the earlier one; keys outside OfficeSettings are dropped at runtime
  const second = saveSettings({ coEdit: false, bogusKey: "x" } as Partial<{ enabled: boolean; imageTag: string; coEdit: boolean }>, root);
  assert.deepEqual(second, { enabled: true, imageTag: DEFAULT_SETTINGS.imageTag, coEdit: false });
  assert.deepEqual(loadSettings(root), second);
});

test("saveSettings: overwrites a corrupt file with clean defaults", () => {
  const root = tmpRoot();
  fs.writeFileSync(path.join(root, "settings.json"), "{{{");
  const s = saveSettings({ imageTag: "x/y:1.2" }, root);
  assert.equal(s.imageTag, "x/y:1.2");
  assert.equal(s.enabled, DEFAULT_SETTINGS.enabled);
});
