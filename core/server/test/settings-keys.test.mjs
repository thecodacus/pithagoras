import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { inProcessHome } from "./server-harness.mjs";

const home = inProcessHome("pithagoras-settings-");

const db = await import("../dist/db.js");
const row = (key) => db.getDb().prepare("SELECT value FROM settings WHERE key = ?").get(key);

test("the stored model defaults are the three keys of them, and nothing else the table holds", () => {
  db.putSetting("tools_seen", "[]");
  db.putSetting("voice", "{}");
  db.setSettings({ provider: " local ", model: "a-model", thinkingLevel: "" });
  assert.deepEqual(db.getStoredSettings(), { provider: "local", model: "a-model" });
  assert.deepEqual(db.shownStoredSettings(), { provider: "local", model: "a-model" });
  // An empty value hands a field back to pi's own default: the row is gone.
  assert.equal(row("thinkingLevel"), undefined);
  db.setSettings({ model: "  " });
  assert.equal(row("model"), undefined);
  assert.deepEqual(db.getStoredSettings(), { provider: "local" });
});

test("a setting that is emptied leaves no row, whichever way it is written", () => {
  db.setBrowserAllowlist("example.com, *.example.org\n");
  assert.deepEqual(db.browserAllowlist(), ["example.com", "*.example.org"]);
  db.setBrowserAllowlist("");
  assert.equal(row("browser_allowlist"), undefined, "an empty list is no row, as putSetting leaves it");
  assert.deepEqual(db.browserAllowlist(), []);

  db.setDefaultReportTo({ channel: "chat-a", target: "someone" });
  assert.deepEqual(db.getDefaultReportTo(), { channel: "chat-a", target: "someone" });
  db.setDefaultReportTo(null);
  assert.equal(db.getDefaultReportTo(), null);
  assert.equal(row("report_channel"), undefined);
  assert.equal(row("report_target"), undefined);

  db.setDefaultContextLimit(32_768);
  db.setContextLimit("p", "m", 65_536);
  assert.equal(db.contextWindowFor("p", "m"), 65_536);
  assert.equal(db.contextWindowFor("p", "other"), 32_768);
  db.setContextLimit("p", "m", null);
  db.setDefaultContextLimit(null);
  assert.equal(row("context_limit:p/m"), undefined);
  assert.equal(row("context_limit_default"), undefined);
  assert.equal(db.contextWindowFor("p", "m", 8_192), 8_192);
  // A stored number the portal would not take is not one.
  db.putSetting("context_limit_default", "12");
  assert.equal(db.getDefaultContextLimit(), undefined);
});
