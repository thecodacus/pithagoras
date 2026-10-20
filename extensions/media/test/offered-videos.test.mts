import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { inProcessHome } from "../../../tests/helpers.mts";
import { startMedia } from "./portal.mts";
import * as video from "../src/server/video-generation.ts";

/**
 * The tool lists learn what a chat registered. A chat that is open while video generation is switched on
 * registers its tools after the reload without the lists hearing of it, so the lists know Media's tools from what it
 * says it offers now (`portal.tools.offer`), as they do the picture tools: the person who has just switched video on sees them.
 */
const home = inProcessHome("pithagoras-tools-offer-videos-");

const { db } = await startMedia();
const { sessions } = await import("../../../core/server/dist/session-manager.js");

const shown = () => Object.fromEntries(db.shownTools().filter((t) => /video/.test(t.name)).map((t) => [t.name, t.inline === true]));

test("the video tools are listed before any chat has reported them, and only while video generation is on", async () => {
  assert.deepEqual(shown(), {});
  video.saveVideoGeneration({ baseUrl: "https://video.example.com", enabled: true });
  assert.deepEqual(shown(), { generate_video: true, show_video: true });
  // The lists of a chat that has not started are what is shown, filed under Media's package, as a server half's tools are.
  db.createSession({ id: "idle", title: "idle", workspace: home, executor: "host" });
  const idle = (await sessions.getTools("idle")).tools;
  assert.deepEqual(idle.filter((t) => /video/.test(t.name)).map((t) => [t.name, t.source, t.inline]).sort(), [["generate_video", "pithagoras-media", true], ["show_video", "pithagoras-media", true]]);
  assert.equal(db.knownTools().some((t) => /video/.test(t.name)), false, "nothing is written down that no chat has registered");

  video.saveVideoGeneration({ enabled: false });
  assert.deepEqual(shown(), {});
  // What a chat reported while it was on is not listed either once it is off.
  db.rememberTools([{ name: "generate_video", source: "pithagoras-media", package: null, inline: true }, { name: "show_video", source: "pithagoras-media", package: null, inline: true }]);
  assert.deepEqual(shown(), {});
  video.saveVideoGeneration({ enabled: true });
  assert.deepEqual(shown(), { generate_video: true, show_video: true });
});

test("an extension's tool of the same name that a chat reported is left as it is, and not listed twice", () => {
  video.saveVideoGeneration({ enabled: true });
  db.rememberTools([{ name: "generate_video", source: "my-videos", package: "npm:my-videos", inline: false }]);
  const theirs = db.shownTools().filter((t) => t.name === "generate_video");
  assert.equal(theirs.length, 1);
  assert.equal(theirs[0].source, "my-videos");
  assert.equal(theirs[0].inline, undefined);
  // Not Media's, whichever way the add-on is set.
  video.saveVideoGeneration({ enabled: false });
  assert.deepEqual(db.shownTools().filter((t) => t.name === "generate_video").map((t) => t.source), ["my-videos"]);
});

test("an extension's tool in a package that is switched off does not hide Media's: every chat has Media's", () => {
  video.saveVideoGeneration({ enabled: true });
  const settings = path.join(process.env.PI_CODING_AGENT_DIR, "settings.json");
  writeFileSync(settings, JSON.stringify({ packages: [{ source: "npm:my-videos", extensions: [] }] }));
  assert.deepEqual(db.shownTools().filter((t) => t.name === "generate_video").map((t) => [t.source, t.inline]), [["pithagoras-media", true]]);
  writeFileSync(settings, JSON.stringify({ packages: ["npm:my-videos"] }));
  assert.deepEqual(db.shownTools().filter((t) => t.name === "generate_video").map((t) => t.source), ["my-videos"]);
  writeFileSync(settings, JSON.stringify({ packages: [] }));
});

test("a chat that has not started can switch off a video tool, and one that is off by default can be switched on", async () => {
  video.saveVideoGeneration({ enabled: true });
  db.forgetPackageTools("npm:my-videos");
  db.setToolDefaultsOff(["generate_video"]);
  db.createSession({ id: "later", title: "later", workspace: home, executor: "host" });
  const state = async () => (await sessions.getTools("later")).tools.find((t) => t.name === "generate_video")?.enabled;
  assert.equal(await state(), false);
  await sessions.setTools("later", []);
  assert.equal(await state(), true, "the exception is written, not only answered");
});
