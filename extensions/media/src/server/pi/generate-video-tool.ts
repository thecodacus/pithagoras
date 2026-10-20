import { randomBytes } from "node:crypto";
import type { Chat } from "@pithagoras/extension-api/server";
import { refusalOf } from "../file-error";
import { portal } from "../host";
import { MAX_PICTURE_BYTES, readPicture } from "../picture-files";
import { GENERATED_VIDEOS_DIR, recordChatVideo } from "../video-gallery";
import { sniffVideo } from "../video-files";
import { GENERATE_VIDEO_TOOL, generateVideo, videoGenerationConfig, videoGenerationReady } from "../video-generation";
import { MAX_VIDEO_PROMPT, parseVideoSize } from "../video-settings";
import { number, object, text } from "./schema";
import { pictureIn } from "./show-image-tool";
import { videoIn } from "./show-video-tool";
import type { MediaTool } from "./tools";

/**
 * Making a clip from a description, or from a picture as its first frame, with
 * the video model the person set up under Media in Settings, and putting
 * it in front of them.
 *
 * It answers as generate_image does — the clip's path in the chat's folder and a
 * title — so the page plays it under the tool line in the chat. The clip is written
 * into a folder of its own inside the chat's, under a name made here, never one the
 * agent or the endpoint chose, and nothing is written until the endpoint has answered
 * with a clip: a failed call leaves no file and no folder behind. A clip is kept whatever
 * its format: a WebM or an MP4 plays in the chat, and any other file is saved as it is,
 * said to be one a browser cannot play, to be downloaded from the gallery. It is also listed
 * in the Media page's gallery, with what it was asked for (see video-gallery.ts).
 *
 * A clip takes minutes, in the endpoint's queue and on its model; the call waits for
 * it, within the time limit of the settings, and the chat shows how long it has taken.
 */

/**
 * Said to the model in a spoken conversation, where a clip is not shown: voice mode has no window for one, and the
 * wait is minutes. Said only while the model has the tool.
 */
export const GENERATE_VIDEO_VOICE_LINE =
  "A video made with generate_video is not shown in a spoken conversation, only in the chat, and takes minutes: make one only when the person asks for it, and say that it will be in the chat.";

/** A name made here: the time, and something that tells two in one second apart. */
const fileName = (ext: string): string =>
  `video-${new Date().toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-")}-${randomBytes(3).toString("hex")}.${ext}`;

/** Writes the clip into the chat's folder, under a name made here, and returns where, from it. A clip a browser plays is checked as the page will fetch it; any other is only kept. */
export function saveGeneratedVideo(chat: Chat, bytes: Buffer, ext: string, name = fileName(ext)): string {
  const base = portal().chats.folder(chat.id);
  try {
    portal().files.makeFolder(base, "", GENERATED_VIDEOS_DIR);
  } catch (e) {
    if (refusalOf(e) !== "exists") throw e;
  }
  const rel = portal().files.create(base, GENERATED_VIDEOS_DIR, name, bytes);
  // Checked as the page will fetch it, so that a clip that is said to play does.
  // Media's own file, made just now: not one the agent named.
  return sniffVideo(bytes.subarray(0, 64)).playable ? videoIn(chat, rel, {}) : rel;
}

/** The longest clip the tool asks for, in seconds: far more than any model makes, so that a typo is refused and a long clip is not. */
const MAX_SECONDS = 600;

/** Registered while video generation is ready (see mediaTools), as generate_image is while image generation is. */
export const generateVideoTool: MediaTool = {
  name: GENERATE_VIDEO_TOOL,
  label: "generate video",
  description:
    "Make a short clip from a description with the person's video model and show it. " +
    "Saved in the chat's folder: WebM or MP4 plays in the chat (no show_video needed); other formats can only be downloaded from the gallery. " +
    "Describe subject, motion, camera, style, setting. A picture only attached to a message is not in the folder: ask the person to put it there. " +
    "Takes minutes and costs the person: one clip unless asked for more. Give a short title; say briefly what you made.",
  parameters: object(
    {
      prompt: text("What it shows and what moves"),
      title: text("A few words shown above it"),
      size: text("WIDTHxHEIGHT, e.g. 832x480; omit for the default"),
      seconds: number("Length; omit for the default. Longer takes much longer"),
      path: text("Picture for the first frame, relative to the chat's folder or absolute inside it; the prompt says what happens next"),
      lastFrame: text(
        "Picture for the last frame, as path. Sent only to a server that takes one (else the call fails, saying why); " +
          "a model may ignore it silently, so tell the person you asked for it, not that the clip ends on it",
      ),
    },
    ["title", "size", "seconds", "path", "lastFrame"],
  ),
  voiceGuidelines: [GENERATE_VIDEO_VOICE_LINE],
  run: async (chat, p: { prompt: string; title?: string; size?: string; seconds?: number; path?: string; lastFrame?: string }, signal) => {
    // Read now, not when the tool was loaded: an address, a model or a key changed since is in force.
    const config = videoGenerationConfig();
    if (!videoGenerationReady(config)) {
      throw new Error("Video generation is switched off, or has no address now. Tell the person; there is no other way to make a clip.");
    }
    const prompt = typeof p.prompt === "string" ? p.prompt.trim() : "";
    if (!prompt) throw new Error("A prompt is required: say what the clip should show.");
    if (prompt.length > MAX_VIDEO_PROMPT) throw new Error(`The prompt is over ${MAX_VIDEO_PROMPT} characters; say it shorter.`);
    const size = typeof p.size === "string" ? p.size.trim() : "";
    const checked = size ? parseVideoSize(size) : size;
    if (typeof checked !== "string") throw new Error(`${checked.error}.`);
    let seconds: number | undefined;
    if (p.seconds !== undefined && p.seconds !== null) {
      if (typeof p.seconds !== "number" || !Number.isFinite(p.seconds) || p.seconds <= 0 || p.seconds > MAX_SECONDS) {
        throw new Error(`The length is a number of seconds, more than 0 and at most ${MAX_SECONDS}.`);
      }
      seconds = p.seconds;
    }
    // A picture of the chat's folder as a frame of the clip: its path in the folder, and its bytes.
    const frame = (given: unknown, which: "first" | "last"): { from: string; picture: { bytes: Buffer; mimeType: string } } | undefined => {
      if (given === undefined || given === null || !String(given).trim()) return undefined;
      try {
        // Read for the chat's agent, which named it: not a picture the sandbox closed to it.
        const as = { likeParent: true, chats: [chat.id] };
        const from = pictureIn(chat, String(given), as, `used as the ${which} frame`);
        const read = readPicture(portal().chats.folder(chat.id), from, as);
        return { from, picture: { bytes: read.bytes, mimeType: read.mimeType } };
      } catch (e) {
        // The Files panel's words for it ("download it instead") are no way forward here.
        if (refusalOf(e) === "too_large") {
          throw new Error(`The picture is over ${MAX_PICTURE_BYTES / 1024 / 1024} MB, which is too large for a ${which} frame; say so to the person, or make a smaller copy of it first.`);
        }
        throw e;
      }
    };
    const first = frame(p.path, "first");
    const last = frame(p.lastFrame, "last");
    const made = await generateVideo(config, { prompt, ...(size ? { size } : {}), ...(seconds !== undefined ? { seconds } : {}), ...(first ? { firstFrame: first.picture } : {}), ...(last ? { lastFrame: last.picture } : {}) }, { signal, timeoutMs: config.timeoutSeconds * 1000 });
    const rel = saveGeneratedVideo(chat, made.bytes, made.ext);
    const asked = size || config.size;
    recordChatVideo({
      sessionId: chat.id,
      path: rel,
      kind: first || last ? "animated" : "generated",
      prompt,
      bytes: made.bytes.length,
      params: {
        ...(config.model ? { model: config.model } : {}),
        ...(asked ? { size: asked } : {}),
        ...(config.frames !== null && seconds === undefined ? { frames: config.frames } : {}),
        ...(config.fps !== null ? { fps: config.fps } : {}),
        ...(made.frames !== undefined ? { madeFrames: made.frames } : {}),
        ...(made.fps !== undefined ? { madeFps: made.fps } : {}),
        ...(first ? { firstFrame: { path: first.from } } : {}),
        ...(last ? { lastFrame: { path: last.from } } : {}),
      },
    });
    const title = (typeof p.title === "string" && p.title.trim() ? p.title : prompt).replace(/\s+/g, " ").trim().slice(0, 120);
    const format = sniffVideo(made.bytes.subarray(0, 64));
    const details = { files: [{ path: rel, ...(title ? { title } : {}) }], ...(format.playable ? {} : { notPlayable: format.label }) };
    if (!format.playable) {
      const said = `Generated and saved: ${rel}. Its format is ${format.id === "bin" ? "one the portal does not know" : format.label}, which a browser cannot play in the chat. It is kept as it is and listed in the Media gallery, where the person can download it. Tell them so.`;
      return { content: [{ type: "text", text: said }], details };
    }
    return { content: [{ type: "text", text: `Generated and shown to the user: ${rel}` }], details };
  },
};
