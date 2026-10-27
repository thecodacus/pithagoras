import { randomBytes } from "node:crypto";
import type { Chat } from "@pithagoras/extension-api/server";
import { refusalOf } from "../file-error";
import { portal } from "../host";
import { GENERATED_DIR, recordChatPicture } from "../image-gallery";
import { MAX_EDIT_PICTURES, checkCount, editImage } from "../image-editing";
import { GENERATE_IMAGE_TOOL, MAX_PROMPT, generateImage, imageEditingReady, imageEditingTarget, imageGenerationConfig, imageGenerationReady, type ImageGenerationConfig } from "../image-generation";
import { nativeConflict, parseSize } from "../image-settings";
import { readChatPictures } from "./chat-pictures";
import { list, object, text } from "./schema";
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
 *
 * With references — pictures of the chat's folder that show a character, an
 * object or a style to carry into a new picture — the picture is asked of the
 * image editing endpoint instead, as `images/generations` takes no pictures and
 * `images/edits` is the one route that does. It is still a new picture: named as
 * any generated one, never after a reference, and asked to start from noise, so
 * that the references guide it rather than being reworked. stable-diffusion.cpp
 * reads that from its block (`"init_image": null`), which goes only while the
 * person has said the endpoint is one (Stable Diffusion extra settings): any other
 * server would read the block as part of the description. An OpenAI-style server
 * takes the pictures of an edit as references in any case. Without the switch a
 * stable-diffusion.cpp server starts from the first reference, which cannot be
 * told from here, so the result says so for the agent to pass on. Without
 * references the request is the one it always was.
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

/** What the model is told of the tool; references are added where the editing endpoint can take them. */
const DESCRIPTION =
  "Make a picture from a description with the person's image model, save it in the chat's folder and show it (no show_image needed). " +
  "Describe subject, style, setting, colours. Slow and costs the person: one picture unless asked for more. " +
  "Give a short title; say briefly what you made.";
const REFERENCES = ' references: for the same character, object or style in a new picture; name them by place ("the first picture"). To change a picture use edit_image.';

/** Said when a stable-diffusion.cpp server may have started from the first reference: what the person can do about it. */
const NOT_FROM_NOISE =
  "Stable Diffusion extra settings are off, so a stable-diffusion.cpp endpoint started from the first reference: " +
  "if the picture looks like a reworked copy of it, tell the person to switch them on under Media in Settings.";

/**
 * A new picture made from references by the image editing endpoint, from noise (see above), saved and listed as a
 * generated picture. The references are read and checked as edit_image's pictures are (count, place, kind, weight),
 * all of them before anything is sent; editing that is off, or one picture too many for the endpoint, is refused
 * with what to switch on.
 */
async function fromReferences(chat: Chat, config: ImageGenerationConfig, named: unknown[], prompt: string, size: string, signal?: AbortSignal) {
  if (!imageEditingReady(config)) {
    throw new Error(
      "References are sent to the person's image editing endpoint, and image editing is switched off or has no address now. " +
        "Make the picture without them, or tell the person that Image editing can be switched on under Media in Settings.",
    );
  }
  checkCount(named.length, config.editMultiple);
  const { paths, images } = readChatPictures(chat, named, "Reference", "used as a reference");
  const target = imageEditingTarget(config);
  // A block of the prompt's own would be the one the server reads, and the picture would start from the first reference after all.
  if (target.sdExtras && nativeConflict(prompt, { fromNoise: true })) {
    throw new Error("The prompt has an sd_cpp_extra_args block of its own, which would hide the one that makes a picture with references start from noise: take it out of the prompt.");
  }
  // A size always where there is one, the add-on's when the agent gives none: without it stable-diffusion.cpp makes the picture in the first reference's size.
  const { bytes, ext, notes } = await editImage(target, { prompt, image: images.length > 1 ? images : images[0], ...(size ? { size } : {}), native: { fromNoise: true }, references: true }, { signal });
  const rel = saveGenerated(chat, bytes, ext);
  recordChatPicture({
    sessionId: chat.id,
    path: rel,
    kind: "generated",
    prompt,
    references: paths,
    bytes: bytes.length,
    // From noise only where it was sent: editImage leaves the block out while the switch is off.
    params: { ...(target.model ? { model: target.model } : {}), ...(size ? { size } : {}), ...(target.sdExtras ? { fromNoise: true } : {}) },
  });
  const said = [`Generated from ${paths.join(", ")} as references (in this order), and shown to the user: ${rel}.`, ...notes, ...(target.sdExtras ? [] : [NOT_FROM_NOISE])];
  return { rel, text: said.join(" ") };
}

/**
 * Registered while the add-on is ready (see mediaTools), which a chat's pi
 * decides each time it loads, and again on a reload: while the add-on is off or
 * has no address there is no tool at all, and the voice rule says nothing of one.
 * `references` is whether it takes references, which is whether editing is ready,
 * and how many (`several`, where the editing endpoint takes several pictures);
 * without them its shape and its request are what they always were. A change of
 * either reloads the chats (see api/settings.ts).
 */
export function generateImageTool(references: false | { several: boolean }): MediaTool {
  return {
    name: GENERATE_IMAGE_TOOL,
    label: "generate image",
    description: DESCRIPTION + (references ? REFERENCES : ""),
    parameters: object(
      {
        prompt: text("What it should show"),
        title: text("A few words shown above it"),
        size: text("WIDTHxHEIGHT in pixels, e.g. 1024x1024; omit for the default"),
        ...(references
          ? {
              references: list(text(), {
                minItems: 1,
                maxItems: MAX_EDIT_PICTURES,
                description:
                  (references.several ? "Pictures in the chat's folder, in prompt order" : "One picture in the chat's folder (this endpoint takes one)") +
                  "; stable-diffusion.cpp starts from the first unless Stable Diffusion extra settings are on",
              }),
            }
          : {}),
      },
      ["title", "size", "references"],
    ),
    voiceGuidelines: [GENERATE_IMAGE_VOICE_LINE],
    run: async (chat, p: { prompt: string; title?: string; size?: string; references?: unknown }, signal) => {
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
      const asked = size || config.size;
      const title = (typeof p.title === "string" && p.title.trim() ? p.title : prompt).replace(/\s+/g, " ").trim().slice(0, 120);
      // A path where the tool was loaded with a list is as good: either is asked of the settings as they are now, which refuse it while editing is off.
      const named: unknown[] = Array.isArray(p.references) ? p.references : p.references === undefined ? [] : [p.references];
      if (named.length) {
        const made = await fromReferences(chat, config, named, prompt, asked, signal);
        return { content: [{ type: "text", text: made.text }], details: { files: [{ path: made.rel, ...(title ? { title } : {}) }] } };
      }
      const { bytes, ext } = await generateImage(config, { prompt, ...(size ? { size } : {}) }, { signal });
      const rel = saveGenerated(chat, bytes, ext);
      recordChatPicture({ sessionId: chat.id, path: rel, kind: "generated", prompt, bytes: bytes.length, params: { ...(config.model ? { model: config.model } : {}), ...(asked ? { size: asked } : {}) } });
      const details = { files: [{ path: rel, ...(title ? { title } : {}) }] };
      return { content: [{ type: "text", text: `Generated and shown to the user: ${rel}` }], details };
    },
  };
}
