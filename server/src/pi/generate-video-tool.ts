import { randomBytes } from "node:crypto";
import { Type } from "typebox";
import { GENERATED_VIDEO_MARK } from "../generated-video.js";
import { pictureIn } from "./show-image-tool.js";
import { takenByAnother } from "./generate-image-tool.js";
import { videoIn } from "./show-video-tool.js";
import { GENERATED_VIDEOS_DIR, recordChatVideo } from "../video-gallery.js";
import { GENERATE_VIDEO_SOURCE, GENERATE_VIDEO_TOOL, generateVideo, videoGenerationConfig, videoGenerationReady } from "../video-generation.js";
import { MAX_VIDEO_PROMPT, parseVideoSize } from "../video-settings.js";
import { FileError, MAX_PICTURE_BYTES, baseDir, makeFolder, readPicture, saveNewFile } from "../workspace-files.js";

/**
 * Making a clip from a description, or from a picture as its first frame, with
 * the video model the person set up in Settings → Agent → Media, and putting
 * it in front of them.
 *
 * It answers as generate_image does — the clip's path in the chat's folder and a
 * title, with a mark that it is this tool's (see generated-video.ts) — so the
 * page plays it under the tool line in the chat. The clip is written into a folder
 * of its own inside the chat's, under a name made here, never one the agent or
 * the endpoint chose, and nothing is written until the endpoint has answered with
 * a real clip: a failed call leaves no file and no folder behind. It is also listed
 * in the Media page's gallery, with what it was asked for (see video-gallery.ts).
 *
 * A clip takes minutes, in the endpoint's queue and on its model; the call waits for
 * it, within the time limit of the settings, and the chat shows how long it has taken.
 */

/**
 * Said to the model in a spoken conversation, where a clip is not shown: voice mode has no window for one, and the
 * wait is minutes. Said only while the model has the tool (see the SDK client).
 */
export const GENERATE_VIDEO_VOICE_LINE =
  "A video made with generate_video is not shown in a spoken conversation, only in the chat, and takes minutes: make one only when the person asks for it, and say that it will be in the chat.";

/** A name made here: the time, and something that tells two in one second apart. */
const fileName = (ext: string): string =>
  `video-${new Date().toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-")}-${randomBytes(3).toString("hex")}.${ext}`;

/** Writes the clip into the chat's folder, under a name made here, and returns where, from it. */
export function saveGeneratedVideo(folder: string, bytes: Buffer, ext: string, name = fileName(ext)): string {
  const base = baseDir(folder);
  try {
    makeFolder(base, "", GENERATED_VIDEOS_DIR);
  } catch (e) {
    if (!(e instanceof FileError && e.code === "exists")) throw e;
  }
  const rel = saveNewFile(base, GENERATED_VIDEOS_DIR, name, bytes);
  // Checked as the page will fetch it, so a call that succeeds is one that plays.
  return videoIn(folder, rel);
}

/** The longest clip the tool asks for, in seconds: far more than any model makes, so that a typo is refused and a long clip is not. */
const MAX_SECONDS = 600;

/**
 * An ExtensionFactory — see pi's InlineExtension.
 *
 * Decided each time pi loads it, and again on a reload, as GenerateImageTool is: while the add-on is off or has
 * no address there is no tool at all. `registered` is whether the model has the portal's tool as it was last
 * loaded: not where an extension's tool of the same name is the one pi uses, which `extensions` — what pi has
 * loaded — tells.
 */
export class GenerateVideoTool {
  private on = false;
  constructor(
    private readonly folder: string,
    private readonly extensions: () => readonly any[] = () => [],
    /** The chat, for the gallery to say whose a clip is; without it a clip is made and not listed. */
    private readonly sessionId?: string,
  ) {}

  registered = (): boolean => this.on && !takenByAnother(this.extensions(), GENERATE_VIDEO_TOOL, GENERATE_VIDEO_SOURCE);

  extension = (pi: any) => {
    this.on = false;
    if (!videoGenerationReady()) return;
    const { folder, sessionId } = this;
    pi.registerTool({
      name: GENERATE_VIDEO_TOOL,
      label: "generate video",
      description:
        "Make a short video clip from a description with the video model the person has set up, and show it to them. " +
        "The clip is a WebM or MP4 saved in the chat's folder and plays on their screen as show_video's does, so do not call show_video on it. " +
        "Describe what it should show: the subject, what moves and how, the camera, the style, the setting. " +
        "To start from a picture — the picture is the first frame, and the description says what happens next — give its path in the chat's folder. " +
        "A picture the person only attached to a message is not a file in the folder: ask them to put it there. " +
        "It can take many minutes and costs the person something, so make one clip, and another only when asked. " +
        "Give a short title. Say in words what you made; do not describe it in detail unless asked.",
      parameters: Type.Object({
        prompt: Type.String({ description: "What the clip should show, and what moves." }),
        title: Type.Optional(Type.String({ description: "A few words shown above the clip." })),
        size: Type.Optional(Type.String({ description: 'Width and height in pixels, such as "832x480". Leave it out for the usual size.' })),
        seconds: Type.Optional(Type.Number({ description: "How long the clip should be, in seconds. Leave it out for the usual length; a longer clip takes much longer." })),
        path: Type.Optional(Type.String({ description: "A picture in the chat's folder to use as the first frame: relative to it or absolute inside it. Leave it out to make the clip from the description alone." })),
      }),
      execute: async (_id: string, p: { prompt: string; title?: string; size?: string; seconds?: number; path?: string }, signal?: AbortSignal) => {
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
        let firstFrame: { bytes: Buffer; mimeType: string } | undefined;
        let from: string | undefined;
        if (p.path !== undefined && p.path !== null && String(p.path).trim()) {
          try {
            from = pictureIn(folder, String(p.path), "used as the first frame");
            const read = readPicture(baseDir(folder), from);
            firstFrame = { bytes: read.bytes, mimeType: read.mimeType };
          } catch (e) {
            // The Files panel's words for it ("download it instead") are no way forward here.
            if (e instanceof FileError && e.code === "too_large") {
              throw new Error(`The picture is over ${MAX_PICTURE_BYTES / 1024 / 1024} MB, which is too large for a first frame; say so to the person, or make a smaller copy of it first.`);
            }
            throw e;
          }
        }
        const made = await generateVideo(config, { prompt, ...(size ? { size } : {}), ...(seconds !== undefined ? { seconds } : {}), ...(firstFrame ? { firstFrame } : {}) }, { signal, timeoutMs: config.timeoutSeconds * 1000 });
        const rel = saveGeneratedVideo(folder, made.bytes, made.ext);
        if (sessionId) {
          const asked = size || config.size;
          recordChatVideo({
            sessionId,
            path: rel,
            kind: from ? "animated" : "generated",
            prompt,
            bytes: made.bytes.length,
            params: {
              ...(config.model ? { model: config.model } : {}),
              ...(asked ? { size: asked } : {}),
              ...(config.frames !== null && seconds === undefined ? { frames: config.frames } : {}),
              ...(config.fps !== null ? { fps: config.fps } : {}),
              ...(made.frames !== undefined ? { madeFrames: made.frames } : {}),
              ...(made.fps !== undefined ? { madeFps: made.fps } : {}),
              ...(from ? { firstFrame: { path: from } } : {}),
            },
          });
        }
        const title = (typeof p.title === "string" && p.title.trim() ? p.title : prompt).replace(/\s+/g, " ").trim().slice(0, 120);
        const details = { path: rel, ...(title ? { title } : {}), [GENERATED_VIDEO_MARK]: true };
        return { content: [{ type: "text", text: `Generated and shown to the user: ${rel}` }], details };
      },
    });
    this.on = true;
  };
}
