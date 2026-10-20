import { randomBytes } from "node:crypto";
import type { Chat } from "@pithagoras/extension-api/server";
import { refusalOf } from "../file-error";
import { portal } from "../host";
import { GENERATED_DIR, recordChatPicture } from "../image-gallery";
import { GENERATE_IMAGE_TOOL, MAX_PROMPT, generateImage, imageGenerationConfig, imageGenerationReady } from "../image-generation";
import { parseSize } from "../image-settings";
import { object, text } from "./schema";
import { pictureIn } from "./show-image-tool";
import type { MediaTool } from "./tools";

/**
 * Making a picture from a description, with the image model the person set up
 * under Media in Settings, and putting it in front of them.
 *
 * What it returns is what show_image returns — the picture's path in the chat's
 * folder, and a title — so the page draws it as it draws one the agent showed:
 * a thumbnail under the tool line in the chat, the picture window in voice
 * mode. The picture is written into a folder of its own inside the chat's, which
 * is where /sessions/:id/picture serves from, under a name made here, never
 * one the agent or the endpoint chose. It is also listed in the Media page's
 * gallery, with what it was asked for (see image-gallery.ts).
 */

/** Said to the model in a spoken conversation, where it is the only way the person sees a picture. */
export const GENERATE_IMAGE_VOICE_LINE =
  "To make a new picture from a description, call generate_image: it saves the picture in the chat folder and shows it, so do not call show_image on it afterwards.";

/** A name made here: the time, and something that tells two in one second apart. */
const fileName = (ext: string): string =>
  `image-${new Date().toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-")}-${randomBytes(3).toString("hex")}.${ext}`;

/** Writes the picture into the chat's folder, under a name made here unless one is given, and returns where, from it. */
export function saveGenerated(chat: Chat, bytes: Buffer, ext: string, name = fileName(ext)): string {
  const base = portal().chats.folder(chat.id);
  try {
    portal().files.makeFolder(base, "", GENERATED_DIR);
  } catch (e) {
    if (refusalOf(e) !== "exists") throw e;
  }
  const rel = portal().files.create(base, GENERATED_DIR, name, bytes);
  // Checked as the page will fetch it, so a call that succeeds is one that shows. Media's own file, made just now: not one the agent named.
  return pictureIn(chat, rel, {});
}

/**
 * Registered while the add-on is ready (see mediaTools), which a chat's pi
 * decides each time it loads, and again on a reload: while the add-on is off or
 * has no address there is no tool at all, and the voice rule says nothing of one.
 */
export const generateImageTool: MediaTool = {
  name: GENERATE_IMAGE_TOOL,
  label: "generate image",
  description:
    "Make a picture from a description with the person's image model, save it in the chat's folder and show it (no show_image needed). " +
    "Describe subject, style, setting, colours. Slow and costs the person: one picture unless asked for more. " +
    "Give a short title; say briefly what you made.",
  parameters: object(
    {
      prompt: text("What it should show"),
      title: text("A few words shown above it"),
      size: text("WIDTHxHEIGHT in pixels, e.g. 1024x1024; omit for the default"),
    },
    ["title", "size"],
  ),
  voiceGuidelines: [GENERATE_IMAGE_VOICE_LINE],
  run: async (chat, p: { prompt: string; title?: string; size?: string }, signal) => {
    // Read now, not when the tool was loaded: an address, a model or a key changed since is in force.
    const config = imageGenerationConfig();
    if (!imageGenerationReady(config)) {
      throw new Error("Image generation is switched off, or has no address now. Tell the person; there is no other way to make a picture.");
    }
    const prompt = typeof p.prompt === "string" ? p.prompt.trim() : "";
    if (!prompt) throw new Error("A prompt is required: say what the picture should show.");
    if (prompt.length > MAX_PROMPT) throw new Error(`The prompt is over ${MAX_PROMPT} characters; say it shorter.`);
    const size = typeof p.size === "string" ? p.size.trim() : "";
    const checked = size ? parseSize(size) : size;
    if (typeof checked !== "string") throw new Error(`${checked.error}.`);
    const { bytes, ext } = await generateImage(config, { prompt, ...(size ? { size } : {}) }, { signal });
    const rel = saveGenerated(chat, bytes, ext);
    const asked = size || config.size;
    recordChatPicture({ sessionId: chat.id, path: rel, kind: "generated", prompt, bytes: bytes.length, params: { ...(config.model ? { model: config.model } : {}), ...(asked ? { size: asked } : {}) } });
    const title = (typeof p.title === "string" && p.title.trim() ? p.title : prompt).replace(/\s+/g, " ").trim().slice(0, 120);
    const details = { files: [{ path: rel, ...(title ? { title } : {}) }] };
    return { content: [{ type: "text", text: `Generated and shown to the user: ${rel}` }], details };
  },
};
