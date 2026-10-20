import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import type { Portal, ToolCallView } from "@pithagoras/extension-api";
import { failureReason, pictureCall, sizeRatio } from "../src/web/picture-call.ts";
import { failureReason as clipFailure, videoCall } from "../src/web/video-call.ts";

/**
 * The cards of Media's tools in a chat: what the preview of a picture being made, and the frame of a clip, know of the
 * call before there is a file, and what each card says of its call in voice mode. A call is as the portal hands it to
 * an extension (ToolCallView): the tool that was called, through the `tools` tool or not, and its parameters, an object.
 */

// The browser half's own stylesheet is the build's to make: here it is nothing.
registerHooks({ load: (url, context, next) => (url.endsWith(".css") ? { format: "module", source: "", shortCircuit: true } : next(url, context)) });
const { default: media } = await import("../src/client.tsx");
/** What the browser half registers, as the portal is given it. */
const entries: { slot: string; entry: any }[] = [];
media({
  extension: "pithagoras-media",
  locale: { add: () => {} },
  t: (text: string) => text,
  ui: { lazy: () => () => null },
  slots: { register: (slot: string, entry: unknown) => void entries.push({ slot, entry }) },
} as unknown as Portal);
/** What the card of a call says in voice mode. */
const describe = (name: string, input: Record<string, unknown>) => {
  const { entry } = entries.find(({ slot, entry }) => slot === "chat.tool" && entry.tool === name)!;
  const call: ToolCallView = { name, status: "running", input };
  return entry.describe(call, { id: "c", title: "", workspace: "/work", status: "busy" });
};

test("the shape of a coming picture is the size asked for, kept to a frame that is no sliver", () => {
  assert.equal(sizeRatio("1536x1024"), 1.5);
  assert.equal(sizeRatio(" 1024X1536 "), 2 / 3);
  // Nothing to go by: the preview takes a square until the picture says otherwise.
  for (const none of [undefined, "", "auto", "big", "1024", "0x10", 5, null]) assert.equal(sizeRatio(none), undefined, String(none));
  assert.equal(sizeRatio("4000x400"), 3);
  assert.equal(sizeRatio("400x4000"), 0.4);
});

test("a call says what the preview needs of it: the shape, the original of an edit, and what it is of", () => {
  assert.deepEqual(pictureCall("generate_image", { prompt: "A lighthouse\n at dusk", size: "1024x1536" }, "/work"), { edit: false, title: "A lighthouse at dusk", ratio: 2 / 3 });
  assert.equal(pictureCall("generate_image", { prompt: "x", title: "Lighthouse" }, "/work").title, "Lighthouse", "the title the agent gave comes first");
  assert.equal(pictureCall("generate_image", { prompt: "x", size: "auto" }, "/work").ratio, undefined);
  assert.equal(pictureCall("generate_image", { prompt: "x".repeat(500) }, "/work").title.length, 120);
  // An edit is of the picture it changes, as the path in the chat's folder, however the agent wrote it; its size is the original's, not a request.
  assert.deepEqual(pictureCall("edit_image", { path: "photos/dog.png", prompt: "Make it snow", size: "1024x1536" }, "/work"), { edit: true, title: "Make it snow", original: "photos/dog.png" });
  assert.equal(pictureCall("edit_image", { path: "/work/photos/dog.png", prompt: "x" }, "/work").original, "photos/dog.png");
  assert.equal(pictureCall("edit_image", { path: "/elsewhere/dog.png", prompt: "x" }, "/work").original, undefined, "one outside the folder is not fetched");
  // Several pictures: the first is the one shown, as the result is named after it.
  assert.equal(pictureCall("edit_image", { paths: ["photos/dog.png", "styles/snow.png"], prompt: "x" }, "/work").original, "photos/dog.png");
  assert.equal(pictureCall("edit_image", { paths: [], prompt: "x" }, "/work").original, undefined);
  assert.equal(pictureCall("edit_image", { paths: [3, "a.png"], prompt: "x" }, "/work").original, undefined);
  // Whatever the agent sent, it does not break the page: what is no object of parameters reaches the card as none.
  for (const input of [[], {}]) assert.doesNotThrow(() => pictureCall("edit_image", input as Record<string, unknown>, "/work"), JSON.stringify(input));
});

test("what went wrong is the first of it, on one line", () => {
  assert.equal(failureReason("The image endpoint answered 401:\n  the key was refused"), "The image endpoint answered 401: the key was refused");
  assert.equal(failureReason(undefined), "");
  assert.equal(failureReason("x".repeat(1000)).length, 240);
});

test("the frame that holds a clip's place has the shape it was asked for, and a title", () => {
  assert.deepEqual(videoCall({ prompt: "a fox\nin the snow", size: "832x480" }), { title: "a fox in the snow", ratio: 832 / 480 });
  assert.deepEqual(videoCall({ prompt: "x", title: "Fox", size: "auto" }), { title: "Fox" });
  assert.deepEqual(videoCall({}), { title: "" });
  assert.equal(videoCall({ prompt: "x".repeat(300) }).title.length, 120);
});

test("what went wrong with a clip is given whole, where a picture's is kept to a few lines", () => {
  const message = `What the video endpoint sent is not a WebM or MP4 video, which is what a browser plays.\n  It says output_format avi, mime_type video/x-msvideo; ${"the file starts with 52 49 46 46; ".repeat(20)}`;
  const whole = clipFailure(message);
  assert.equal(whole, message.replace(/\s+/g, " ").trim(), "all of it, on one line's worth of white space");
  assert.ok(whole.length > 400);
  assert.equal(clipFailure(undefined), "");
  assert.equal(failureReason(message).length, 240, "the picture's card keeps a few lines");
});

test("the card says a picture is being made, or edited, or shown, with what was asked or the title", () => {
  assert.deepEqual(describe("generate_image", { prompt: "a lighthouse\nat dusk" }), { label: "Making a picture", detail: "a lighthouse at dusk" });
  assert.equal(describe("generate_image", { prompt: "x", title: "Lighthouse" }).detail, "Lighthouse");
  assert.deepEqual(describe("edit_image", { path: "photo.png", prompt: "make the\nsky purple" }), { label: "Editing a picture", detail: "make the sky purple" });
  assert.equal(describe("edit_image", { path: "photo.png", prompt: "x", title: "Purple sky" }).detail, "Purple sky");
  assert.deepEqual(describe("show_image", { path: "a.png", title: "Sales" }), { label: "Showing a picture", detail: "Sales" });
});

test("the card says a clip is being made, or shown, with what was asked or the title", () => {
  assert.deepEqual(describe("generate_video", { prompt: "a fox\nin snow" }), { label: "Making a video", detail: "a fox in snow" });
  assert.equal(describe("generate_video", { prompt: "x", title: "Fox" }).detail, "Fox");
  assert.deepEqual(describe("show_video", { path: "a.webm", title: "A" }), { label: "Showing a video", detail: "A" });
});
