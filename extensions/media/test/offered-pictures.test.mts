import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { inProcessHome } from "../../../tests/helpers.mts";
import { startMedia } from "./portal.mts";
import * as gen from "../src/server/image-generation.ts";

/**
 * The tool lists learn what a chat registered. A chat that is open while image
 * generation or editing is switched on registers the tool after its reload
 * without the lists hearing of it, so the lists know Media's tools from what it
 * says it offers now (`portal.tools.offer`), which follows the settings: the
 * person who has just switched editing on sees it.
 */
const home = inProcessHome("pithagoras-tools-offer-pictures-");

const { db } = await startMedia();
const { sessions } = await import("../../../core/server/dist/session-manager.js");

const shown = () => Object.fromEntries(db.shownTools().filter((t) => /image/.test(t.name)).map((t) => [t.name, t.inline === true]));

test("a tool the settings just made is listed before any chat has reported it, and only while it is on", async () => {
  // As a chat reports them from before editing was switched on.
  db.rememberTools([{ name: "show_image", source: "pithagoras-media", package: null, inline: true }]);
  assert.deepEqual(shown(), { show_image: true });

  gen.saveImageGeneration({ baseUrl: "https://images.example.com/v1", enabled: true });
  assert.deepEqual(shown(), { generate_image: true, show_image: true });
  gen.saveImageGeneration({ editEnabled: true });
  assert.deepEqual(shown(), { edit_image: true, generate_image: true, show_image: true });
  // The lists of a chat that has not started, and of one in a project, are what is shown.
  db.createSession({ id: "idle", title: "idle", workspace: home, executor: "host" });
  const idle = (await sessions.getTools("idle")).tools;
  assert.deepEqual(idle.filter((t) => t.name === "edit_image").map((t) => [t.source, t.inline]), [["pithagoras-media", true]]);
  assert.equal(db.knownTools().some((t) => t.name === "edit_image"), false, "nothing is written down that no chat has registered");

  gen.saveImageGeneration({ editEnabled: false });
  assert.deepEqual(shown(), { generate_image: true, show_image: true });
});

test("an extension's tool of the same name that a chat reported is left as it is, and not listed twice", () => {
  gen.saveImageGeneration({ editEnabled: true });
  db.rememberTools([{ name: "edit_image", source: "my-images", package: "npm:my-images", inline: false }]);
  const theirs = db.shownTools().filter((t) => t.name === "edit_image");
  assert.equal(theirs.length, 1);
  assert.equal(theirs[0].source, "my-images");
  assert.equal(theirs[0].inline, undefined);
});

test("an extension's tool in a package that is switched off does not hide Media's: every chat has Media's", () => {
  const settings = path.join(process.env.PI_CODING_AGENT_DIR, "settings.json");
  writeFileSync(settings, JSON.stringify({ packages: [{ source: "npm:my-images", extensions: [] }] }));
  const listed = db.shownTools().filter((t) => t.name === "edit_image");
  assert.deepEqual(listed.map((t) => [t.source, t.inline]), [["pithagoras-media", true]]);
  writeFileSync(settings, JSON.stringify({ packages: ["npm:my-images"] }));
  assert.deepEqual(db.shownTools().filter((t) => t.name === "edit_image").map((t) => t.source), ["my-images"]);
  writeFileSync(settings, JSON.stringify({ packages: [] }));
});

test("a chat that has not started can switch on a tool that is off by default and that no chat has reported", async () => {
  // Fresh: no extension of that name any more, and nothing remembered of Media's.
  const { forgetPackageTools } = db;
  forgetPackageTools("npm:my-images");
  assert.equal(db.knownTools().some((t) => t.name === "edit_image"), false);
  db.setToolDefaultsOff(["edit_image"]);
  db.createSession({ id: "later", title: "later", workspace: home, executor: "host" });
  const state = async () => (await sessions.getTools("later")).tools.find((t) => t.name === "edit_image")?.enabled;
  assert.equal(await state(), false);
  await sessions.setTools("later", []);
  assert.equal(await state(), true, "the exception is written, not only answered");
});
