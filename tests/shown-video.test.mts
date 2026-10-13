import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTranscript, shownVideo } from "../web/src/transcript.ts";
import { describeCall } from "../web/src/tool-activity.ts";
import { failureReason as clipFailure, isVideoCall, videoCall } from "../web/src/video-call.ts";
import { failureReason as pictureFailure } from "../web/src/picture-call.ts";
import { displayName, groupTools, sourceName } from "../web/src/tool-groups.ts";
import { GENERATED_VIDEO_MARK } from "../server/src/generated-video.ts";

// What generate_video answers with: a path in the chat's folder and a title, and the mark that it is the portal's own tool's.
const generated = { path: "generated-videos/video-20261001-101500-a1b2c3.webm", title: "A fox in the snow", [GENERATED_VIDEO_MARK]: true };
const start = (toolName: string, input: any, extra: any = {}, toolCallId = "c1") => ({ seq: 1, type: "tool_execution_start", payload: { toolName, toolCallId, input, ...extra } });
const end = (toolName: string, details: any, extra: any = {}, toolCallId = "c1") => ({ seq: 2, type: "tool_execution_end", payload: { toolName, toolCallId, result: { content: [{ type: "text", text: "Generated and shown to the user" }], details }, ...extra } });
const tool = (items: ReturnType<typeof buildTranscript>) => items.find((i) => i.kind === "tool") as any;

test("a generated clip is a shown clip, as one named with show_video is", () => {
  assert.deepEqual(shownVideo(end("generate_video", generated).payload), { path: generated.path, title: generated.title });
  assert.deepEqual(shownVideo(end("show_video", { path: "a.webm" }).payload), { path: "a.webm" });
  assert.equal(shownVideo(end("generate_video", generated, { isError: true }).payload), undefined, "a failed call shows nothing");
  assert.equal(shownVideo(end("generate_video", undefined).payload), undefined, "nor one with no path");
  assert.equal(shownVideo(end("some_other_tool", generated).payload), undefined, "another tool is not taken for one");
  // A picture tool's answer is not a clip.
  assert.equal(shownVideo(end("generate_image", { path: "a.png", portalImage: true }).payload), undefined);
});

test("the chat puts a clip with the tool line that made it, and knows which end showed it", () => {
  const items = buildTranscript([start("generate_video", { prompt: "a fox" }, { [GENERATED_VIDEO_MARK]: true }), end("generate_video", generated)]);
  const call = tool(items);
  assert.deepEqual(call.video, { path: generated.path, title: generated.title });
  assert.equal(call.videoSeq, 2, "what versions the address the player asks for");
  assert.equal(call.portalVideo, true, "the start said it is the portal's own tool");
  assert.equal(call.picture, undefined, "a clip is not a picture");
  assert.equal(isVideoCall(call), true);
  const failed = tool(buildTranscript([start("generate_video", { prompt: "a fox" }, { [GENERATED_VIDEO_MARK]: true }), end("generate_video", generated, { isError: true })]));
  assert.equal(failed.video, undefined, "no clip, no address");
  assert.equal(isVideoCall(failed), true, "but it is the portal's call, which says why it failed in its own frame");
});

test("a generate_video that an extension brings is not taken for a clip of the chat's folder, and stays a plain tool card", () => {
  // Its path is its own kind: an absolute one, which the video route would look for below the folder, or one relative to somewhere else.
  for (const details of [{ path: "/work/proj/fox.webm" }, { path: "fox.webm" }, { path: "out/fox.webm", title: "A fox" }, { ...generated, [GENERATED_VIDEO_MARK]: "yes" }]) {
    assert.equal(shownVideo(end("generate_video", details).payload), undefined, JSON.stringify(details));
    const call = tool(buildTranscript([start("generate_video", { prompt: "a fox" }), end("generate_video", details)]));
    assert.equal(call.video, undefined);
    assert.equal(isVideoCall(call), false, "no player under its tool line");
  }
  // show_video is the portal's alone to answer with a path in the folder, as show_image is.
  assert.deepEqual(shownVideo(end("show_video", { path: "fox.webm" }).payload), { path: "fox.webm" });
  // The portal's mark on the start alone makes it the portal's call, while it runs.
  const running = tool(buildTranscript([start("generate_video", { prompt: "a fox" }, { [GENERATED_VIDEO_MARK]: true })]));
  assert.equal(isVideoCall(running), true);
  assert.equal(isVideoCall(tool(buildTranscript([start("generate_video", { prompt: "a fox" })]))), false);
  // Another tool is never a video call.
  assert.equal(isVideoCall(tool(buildTranscript([start("show_video", { path: "a.webm" }, { [GENERATED_VIDEO_MARK]: true })]))), false);
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

test("a clip the portal's tool kept as a file a browser cannot play is said to be one, and an extension's tool of the name says nothing", () => {
  const kept = { toolName: "generate_video", result: { details: { path: "generated-videos/video-1.avi", title: "Old", notPlayable: "AVI", [GENERATED_VIDEO_MARK]: true } } };
  assert.deepEqual(shownVideo(kept), { path: "generated-videos/video-1.avi", title: "Old", notPlayable: "AVI" });
  assert.equal(shownVideo({ ...kept, result: { details: { ...kept.result.details, notPlayable: "x".repeat(100) } } })?.notPlayable?.length, 40, "kept short");
  // A clip that plays says nothing of the kind, and show_video's does not either.
  assert.deepEqual(shownVideo({ toolName: "generate_video", result: { details: { path: "g/a.webm", [GENERATED_VIDEO_MARK]: true } } }), { path: "g/a.webm" });
  assert.equal(shownVideo({ toolName: "show_video", result: { details: { path: "a.avi", notPlayable: "AVI" } } })?.notPlayable, undefined);
  // Without the mark it is an extension's tool, which is not taken for the portal's.
  assert.equal(shownVideo({ toolName: "generate_video", result: { details: { path: "a.avi", notPlayable: "AVI" } } }), undefined);
});
