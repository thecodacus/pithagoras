import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTranscript } from "../core/web/src/transcript.ts";
import { describeCall } from "../core/web/src/tool-activity.ts";
import { failureReason as clipFailure, isVideoCall, videoCall } from "../core/web/src/video-call.ts";
import { failureReason as pictureFailure } from "../core/web/src/picture-call.ts";
import { displayName, groupTools, sourceName } from "../core/web/src/tool-groups.ts";
import { GENERATED_VIDEO_MARK } from "../core/server/src/generated-video.ts";
import { FILES_KEY } from "../core/server/src/file-outputs.ts";

// What generate_video answers with, and what the portal found of it when the call ended (see file-outputs.ts).
const made = { path: "generated-videos/video-20261001-101500-a1b2c3.webm", title: "A fox in the snow" };
const found = { [FILES_KEY]: [{ ...made, kind: "video" }] };
const own = { [GENERATED_VIDEO_MARK]: true };
const start = (toolName: string, input: any, extra: any = {}, toolCallId = "c1") => ({ seq: 1, type: "tool_execution_start", payload: { toolName, toolCallId, input, ...extra } });
const end = (toolName: string, details: any, extra: any = {}, toolCallId = "c1") => ({ seq: 2, type: "tool_execution_end", payload: { toolName, toolCallId, result: { content: [{ type: "text", text: "Generated and shown to the user" }], details }, ...extra } });
const tool = (items: ReturnType<typeof buildTranscript>) => items.find((i) => i.kind === "tool") as any;

test("the chat puts a clip with the tool line that made it, and knows which end gave it", () => {
  const call = tool(buildTranscript([start("generate_video", { prompt: "a fox" }, own), end("generate_video", { files: [made] }, found)]));
  assert.deepEqual(call.files, [{ ...made, kind: "video" }]);
  assert.equal(call.filesSeq, 2, "what versions the address the player asks for");
  assert.equal(call.portalVideo, true, "the start said it is the portal's own tool");
  assert.equal(isVideoCall(call), true);
  const failed = tool(buildTranscript([start("generate_video", { prompt: "a fox" }, own), end("generate_video", undefined, { isError: true })]));
  assert.equal(failed.files, undefined, "no clip, no address");
  assert.equal(isVideoCall(failed), true, "but it is the portal's call, which says why it failed in its own frame");
});

test("a generate_video is the portal's frame by the mark on its start, and one that an extension brings is its plain card while it runs", () => {
  const running = tool(buildTranscript([start("generate_video", { prompt: "a fox" }, own)]));
  assert.equal(isVideoCall(running), true);
  assert.equal(isVideoCall(tool(buildTranscript([start("generate_video", { prompt: "a fox" })]))), false);
  assert.equal(isVideoCall(tool(buildTranscript([start("generate_video", { prompt: "a fox" }, { [GENERATED_VIDEO_MARK]: "yes" })]))), false, "the mark is true, not just there");
  // Another tool is never a video call.
  assert.equal(isVideoCall(tool(buildTranscript([start("show_video", { path: "a.webm" }, own)]))), false);
});

test("the frame that holds a clip's place has the shape it was asked for, and a title", () => {
  assert.deepEqual(videoCall({ prompt: "a fox\nin the snow", size: "832x480" }), { title: "a fox in the snow", ratio: 832 / 480 });
  assert.deepEqual(videoCall({ prompt: "x", title: "Fox", size: "auto" }), { title: "Fox" });
  assert.deepEqual(videoCall(undefined), { title: "" });
  assert.equal(videoCall({ prompt: "x".repeat(300) }).title.length, 120);
});

test("the tool line says a clip is being made, and the clip is not a picture for voice mode's window", () => {
  assert.deepEqual(describeCall(start("generate_video", { prompt: "a fox\nin snow" }).payload, "/work"), { label: "Making a video", detail: "a fox in snow" });
  assert.equal(describeCall(start("generate_video", { prompt: "x", title: "Fox" }).payload, "/work").detail, "Fox");
  assert.equal(describeCall(start("generate_video", { prompt: "x" }).payload, "/work").target, undefined);
  assert.deepEqual(describeCall(start("show_video", { path: "a.webm", title: "A" }).payload, "/work"), { label: "Showing a video", detail: "A" });
  assert.equal(describeCall(start("show_video", { path: "a.webm" }).payload, "/work").target, undefined, "voice mode has no window for clips");
});

test("the picture and video tools are one group, Media, and an extension's tool of the name is not in it", () => {
  const mine = (name: string, inline = true) => ({ name, source: inline ? "video-generation" : "my-videos", enabled: true, description: undefined, inline });
  const groups = groupTools([mine("generate_video"), { ...mine("show_video"), source: "videos" }, { name: "generate_image", source: "image-generation", enabled: true, description: undefined, inline: true } as any, { name: "edit_image", source: "image-editing", enabled: true, description: undefined, inline: true } as any, mine("generate_video", false) as any, { name: "bash", source: "built in", enabled: true, description: undefined } as any]);
  const by = Object.fromEntries(groups.map((g) => [g.source, g.tools.map((x) => x.name)]));
  assert.deepEqual(by["<portal:media>"], ["edit_image", "generate_image", "generate_video", "show_video"]);
  assert.equal(by["<portal:videos>"], undefined, "there is no group of videos apart");
  assert.equal(by["<portal:images>"], undefined, "and none of pictures");
  // An extension's generate_video keeps the package it came from.
  assert.deepEqual(by["my-videos"], ["generate_video"]);
  assert.equal(sourceName("<portal:media>"), "Media");
  assert.equal(displayName("<portal:media>"), "Media");
  // What the portal brings is after what is installed and before what is built in.
  assert.deepEqual(groups.map((g) => g.source).slice(-1), ["built in"]);
  assert.ok(groups.findIndex((g) => g.source === "my-videos") < groups.findIndex((g) => g.source === "<portal:media>"));
});

test("what went wrong with a clip is given whole, where a picture's is kept to a few lines", () => {
  const message = `What the video endpoint sent is not a WebM or MP4 video, which is what a browser plays.\n  It says output_format avi, mime_type video/x-msvideo; ${"the file starts with 52 49 46 46; ".repeat(20)}`;
  const whole = clipFailure(message);
  assert.equal(whole, message.replace(/\s+/g, " ").trim(), "all of it, on one line's worth of white space");
  assert.ok(whole.length > 400);
  assert.equal(clipFailure(undefined), "");
  assert.equal(pictureFailure(message).length, 240, "the picture's card keeps a few lines");
});
