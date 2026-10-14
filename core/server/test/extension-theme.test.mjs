import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { inProcessHome, scratch } from "./server-harness.mjs";

const home = inProcessHome("pithagoras-theme-");

const { SdkPiClient, loadTheme } = await import("../dist/pi/sdk-client.js");

test("an extension can style text with ctx.ui.theme, as it can under pi's own CLI", async () => {
  // What SdkPiClient.create does with the SDK before it binds the extensions.
  loadTheme(await import("@earendil-works/pi-coding-agent"));
  const ui = SdkPiClient.prototype.buildUiContext.call({ pendingUi: new Map(), emit() {} });
  // pi's theme object threw "Theme not initialized" on every read until pi's CLI had loaded one.
  assert.equal(typeof ui.theme.fg("dim", "quiet"), "string");
  assert.match(ui.theme.fg("dim", "quiet"), /quiet/);
});

test("an extension reads what is in the chat box, and what it put there", () => {
  // The portal's one copy of the box, as the session manager hands it over.
  let kept;
  const store = { get: () => kept, set: (text, caret) => (kept = text ? { text, caret } : undefined) };
  const client = { pendingUi: new Map(), emit() {} };
  SdkPiClient.prototype.useDrafts.call(client, store);
  const ui = SdkPiClient.prototype.buildUiContext.call(client);
  store.set("fix the build");
  // Read, added to and written back, the draft is kept: it was replaced by the addition alone.
  ui.setEditorText(ui.getEditorText() + " @file");
  assert.equal(ui.getEditorText(), "fix the build @file");
  ui.pasteToEditor("!");
  assert.equal(ui.getEditorText(), "fix the build @file!");
  // Where the cursor is in the box, as the page pastes it.
  store.set("fix build", { start: 4, end: 4 });
  ui.pasteToEditor("the ");
  assert.equal(ui.getEditorText(), "fix the build");
  ui.pasteToEditor("whole ");
  assert.equal(ui.getEditorText(), "fix the whole build", "and after what it pasted, as the cursor is");
});

test("the theme set in pi's settings is the one extensions get", async () => {
  const cwd = scratch("pithagoras-theme-cwd-");
  writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, "settings.json"), JSON.stringify({ theme: "light" }));
  const pi = await import("@earendil-works/pi-coding-agent");
  const colour = () => SdkPiClient.prototype.buildUiContext.call({ pendingUi: new Map(), emit() {} }).theme.fg("text", "x");
  loadTheme({ ...pi, SettingsManager: { create: () => ({ getTheme: () => undefined }) } }, cwd);
  const dark = colour();
  loadTheme(pi, cwd);
  assert.notEqual(colour(), dark, "light, as set, not the dark default");
});
