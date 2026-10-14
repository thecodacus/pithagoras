import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { inProcessHome } from "./server-harness.mjs";

const home = inProcessHome("pithagoras-settings-");

const db = await import("../dist/db.js");
const row = (key) => db.getDb().prepare("SELECT value FROM settings WHERE key = ?").get(key);

test("the stored model defaults are the three keys of them, and nothing else the table holds", () => {
  db.putSetting("browser_password", "hunter2");
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

test("the browser cursor's switch is its own key, which the three model defaults do not carry", () => {
  assert.equal(db.browserCursorOn(), true, "on where nobody said otherwise");
  db.setBrowserCursor(false);
  assert.equal(row("browser_cursor")?.value, "0");
  assert.equal(db.browserCursorOn(), false);
  assert.equal("browser_cursor" in db.getStoredSettings(), false, "and not in the model defaults");
  db.setBrowserCursor(true);
  assert.equal(db.browserCursorOn(), true);
});

test("the browser's address settings are read one by one, with the environment behind them", async () => {
  const service = await import("../dist/extensions/browser-service.js");
  delete process.env.BROWSER_USER;
  delete process.env.BROWSER_PORT;
  assert.deepEqual([service.config().user, service.config().port], ["agent", "3010"]);
  process.env.BROWSER_PORT = "4010";
  assert.equal(service.config().port, "4010");
  assert.equal(service.saveConfig({ port: "4020", user: "alice" }).user, "alice");
  // Not saved, and not the way to forget what was: putSetting would clear it.
  assert.equal(service.saveConfig({ user: "" }).user, "alice");
  delete process.env.BROWSER_PORT;
  assert.equal(service.config().port, "4020");
});
