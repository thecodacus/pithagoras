import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { inProcessHome } from "../../../tests/helpers.mts";
import { startMedia } from "./portal.mts";
import { portal } from "../src/server/host.ts";
import { readPicture } from "../src/server/picture-files.ts";
import { pictureIn } from "../src/server/pi/show-image-tool.ts";
import { videoIn } from "../src/server/pi/show-video-tool.ts";

// show_image and show_video take a picture or a clip of the chat's folder, as the page fetches it back from there.
// Where the folder really is: a path through a link to it is the link the tests make, not one of the system's temp folder.
const home = realpathSync(inProcessHome("pithagoras-pictures-"));
const media = await startMedia();
const { setAgentAccess } = await import("../../../core/server/dist/workspace-files.js");

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 1)]);
const MP4 = Buffer.concat([Buffer.alloc(4), Buffer.from("ftypisom"), Buffer.alloc(20)]);
const work = path.join(home, "work");
const outside = path.join(home, "outside");
mkdirSync(path.join(work, "plots"), { recursive: true });
mkdirSync(outside);
writeFileSync(path.join(work, "plots", "chart.png"), PNG);
// Named like a picture, and is a page: served as one it would run in the portal's origin.
writeFileSync(path.join(work, "evil.png"), "<html><script>alert(1)</script></html>");
writeFileSync(path.join(outside, "secret.png"), PNG);
symlinkSync(path.join(outside, "secret.png"), path.join(work, "link.png"));
media.chat("pic", work, "pic");
/** The chat, as the portal gives it to Media. */
const pic = portal().chats.get("pic")!;

test("show_image takes a picture by a path relative to the folder or absolute inside it", () => {
  assert.equal(pictureIn(pic, "plots/chart.png", {}), "plots/chart.png");
  assert.equal(pictureIn(pic, path.join(work, "plots", "chart.png"), {}), "plots/chart.png");
  assert.throws(() => pictureIn(pic, path.join(outside, "secret.png"), {}), /chat's folder/);
  assert.throws(() => pictureIn(pic, "evil.png", {}), /not a PNG/);
  assert.throws(() => pictureIn(pic, "link.png", {}));
  // A name that only starts with two dots is in the folder.
  writeFileSync(path.join(work, "..preview.png"), PNG);
  assert.equal(pictureIn(pic, "..preview.png", {}), "..preview.png");
  assert.equal(pictureIn(pic, path.join(work, "..preview.png"), {}), "..preview.png");
  assert.throws(() => pictureIn(pic, "../outside/secret.png", {}), /chat's folder/);
});

test("show_image takes an absolute path through a link to the folder, as the agent sees it", () => {
  const linked = path.join(home, "linked-work");
  symlinkSync(work, linked);
  // A chat that names its folder by the link.
  media.chat("linked", linked, "linked");
  const chat = portal().chats.get("linked")!;
  assert.equal(pictureIn(chat, path.join(linked, "plots", "chart.png"), {}), "plots/chart.png");
  assert.equal(pictureIn(chat, path.join(work, "plots", "chart.png"), {}), "plots/chart.png");
  assert.equal(pictureIn(chat, "plots/chart.png", {}), "plots/chart.png");
  assert.throws(() => pictureIn(chat, path.join(linked, "..", "outside", "secret.png"), {}), /chat's folder/);
  assert.throws(() => pictureIn(chat, path.join(linked, "link.png"), {}));
});

test("the tool answers with the path the page fetches the picture by", async () => {
  const tool = media.tools("pic").show_image;
  assert.equal(tool.name, "show_image");
  const result = await tool.execute("call", { path: "./plots/../plots/chart.png", title: "  Sales  " });
  assert.deepEqual(result.details, { files: [{ path: "plots/chart.png", title: "Sales" }] });
  await assert.rejects(tool.execute("call", { path: "missing.png" }));
});

test("what the agent names is opened for it: a picture or a clip the sandbox closed to the agent is not shown or read for it, and the person sees it as ever", async () => {
  // The folders above the chat's are open to everyone, as a sandbox has them; what is closed to the agent is a folder, and a file, of its own.
  chmodSync(home, 0o755);
  mkdirSync(path.join(work, "closed"));
  writeFileSync(path.join(work, "closed", "secret.png"), PNG);
  writeFileSync(path.join(work, "closed", "clip.mp4"), MP4);
  chmodSync(path.join(work, "closed"), 0o700);
  writeFileSync(path.join(work, "plots", "private.png"), PNG);
  chmodSync(path.join(work, "plots", "private.png"), 0o600);
  // The agent is another user than the one the files are the portal's for: everyone, to them.
  setAgentAccess(() => [{ uid: 61234, groups: [61234] }]);
  try {
    const tool = media.tools("pic").show_image;
    assert.deepEqual((await tool.execute("call", { path: "plots/chart.png" })).details, { files: [{ path: "plots/chart.png" }] });
    await assert.rejects(tool.execute("call", { path: "closed/secret.png" }), /closed to the agent/);
    await assert.rejects(tool.execute("call", { path: "plots/private.png" }), /closed to the agent/);
    const as = { likeParent: true, chats: ["pic"] };
    assert.throws(() => pictureIn(pic, "closed/secret.png", as), /closed to the agent/);
    assert.throws(() => readPicture(portal().chats.folder("pic"), "closed/secret.png", as), /closed to the agent/);
    assert.throws(() => videoIn(pic, "closed/clip.mp4", as), /closed to the agent/);
    // For the person: a read for no agent.
    assert.equal(readPicture(portal().chats.folder("pic"), "closed/secret.png").mimeType, "image/png");
  } finally {
    setAgentAccess(() => undefined);
  }
});
