import path from "node:path";
import { recordChatPicture } from "../image-gallery";
import { MAX_EDIT_PICTURES, MAX_EDIT_TOTAL_BYTES, checkCount, editImage } from "../image-editing";
import { EDIT_IMAGE_TOOL, MAX_PROMPT, imageEditingReady, imageEditingTarget, imageGenerationConfig } from "../image-generation";
import { readChatPictures } from "./chat-pictures";
import { saveGenerated } from "./generate-image-tool";
import { list, object, text } from "./schema";
import type { MediaTool } from "./tools";

/**
 * Changing a picture that is in the chat's folder, with the image endpoint the
 * person set up under Media in Settings, and putting the result in front
 * of them. The same call makes a new picture from one or several pictures used
 * as references, starting from the first. Where generate_image takes references
 * (generation and editing are both ready) the agent is sent there for a new
 * picture of the same character, object or style instead: it starts from noise,
 * so the first picture is not reworked into the result (see generate-image-tool.ts).
 *
 * It answers as generate_image does — the path of the new picture in the chat's
 * folder and a title — so the page draws it the same way: a thumbnail in the chat,
 * the picture window in voice mode. The original is never touched. The result is a
 * new file in the same folder generated pictures go in, named after the original (see
 * editedName), and nothing is written until the endpoint has answered with a
 * real picture: a failed edit leaves no file and no folder behind.
 *
 * Several pictures are offered only while the person has said the endpoint
 * takes them: then the tool has `paths`, a list, instead of `path`, and every
 * picture in it is read, checked and limited as the one is (see image-editing.ts
 * for the count and the weight). They go in the order of the list, which is how
 * the prompt tells which is which; the result is named after the first. One
 * that is refused refuses the call, before anything is sent.
 */

/** Said to the model in a spoken conversation, where it is the only way the person sees a picture. */
export const EDIT_IMAGE_VOICE_LINE =
  "To change a picture in the chat folder, call edit_image: it saves the result as a new picture and shows it, so do not call show_image on it afterwards.";

/**
 * Said in both shapes: a picture attached to a message reaches the model as what it sees, not as a file of the
 * folder, so there is no path for it, and an agent that is not told guesses one or edits another picture.
 */
const ATTACHED =
  "A picture only attached to a message is not in the folder and cannot be used: ask the person to put it in the chat's folder or edit it on the Media page; " +
  "never guess a path or edit another picture. ";

/** Said where generate_image takes references: a new picture of what a picture shows is made there, from noise. */
const USE_REFERENCES = "For the same subject or style in a new picture, use generate_image with references. ";

/** What the model is told about the pictures of an edit when the endpoint takes one, and when it takes several; `references` is whether generate_image takes them. */
const ONE_PICTURE = (references: boolean) =>
  (references
    ? "Change a picture in the chat's folder with the person's image editing model and show the result. " + USE_REFERENCES
    : "Change a picture in the chat's folder with the person's image editing model, or make a new one from it as reference, and show the result. ") +
  "The picture: PNG, JPEG, GIF or WebP. It stays as is; the result is a new file named after it, shown as by show_image (no show_image needed). " +
  "Say what should change; the rest stays. " +
  // Said, not left out: with no word of it an agent given several pictures would use one and go on as if it had used them all.
  "This endpoint takes ONE picture per edit: if the person wants several combined, do not edit with one of them; say so, " +
  "and that Media in Settings (Several pictures per edit) allows several if the endpoint takes them. " +
  ATTACHED;
const SEVERAL_PICTURES = (references: boolean) =>
  (references
    ? "Change or combine pictures in the chat's folder with the person's image editing model and show the result. " + USE_REFERENCES
    : "Change pictures in the chat's folder, or make a new one from them as references, with the person's image editing model, and show the result. ") +
  `1 to ${MAX_EDIT_PICTURES} pictures, PNG, JPEG, GIF or WebP, together at most ${MAX_EDIT_TOTAL_BYTES / 1024 / 1024} MB. ` +
  "One that cannot be scaled to fit is refused by name, and then none is sent. " +
  'The model knows them only by their place in the list: in the prompt say "the first picture", "the second picture" and what each is for ' +
  "(to change, a style, a person or object to take over); give only those that matter. " +
  "They stay as they are; the result is one new file named after the first, shown as by show_image (no show_image needed). " +
  "What the prompt does not mention stays. " +
  ATTACHED;
const BEFORE_YOU_CALL =
  "Slow and costs the person: one edit unless asked for more. Give a short title; say briefly what changed. " +
  "A picture over the limits is scaled down first and the result says so: tell the person, as the result is smaller.";

/** How much of the original's name a result keeps. */
const MAX_STEM_BYTES = 200;

/** The start of a name that is at most `max` bytes long, cut between letters, never inside one. */
function fitBytes(name: string, max: number): string {
  let start = "";
  for (const ch of name) {
    if (Buffer.byteLength(start + ch) > max) break;
    start += ch;
  }
  return start;
}

/**
 * What a result is called: the original's name with "-edited" before the
 * extension, so that the two sort together. An edit of an edit is not
 * "-edited-edited": the mark is taken off first, and a name that is taken gets
 * the number any new file gets ("photo-edited (2).png").
 */
export function editedName(original: string, ext: string): string {
  const stem = path.basename(original, path.extname(original)).replace(/-edited(?: \(\d+\))?$/, "");
  // Cut by bytes, not by letters (one can be four): what is left of the 255 a name may have is room for "-edited", the extension and a number.
  return `${fitBytes(stem || "image", MAX_STEM_BYTES)}-edited.${ext}`;
}

/**
 * The tool while editing is ready (see mediaTools), as a chat's pi loads it. Its shape is settled then, as its being
 * there is: `several` is whether the endpoint takes a list of pictures, and `references` whether generate_image takes
 * references, which the description sends the agent to; a change of either reloads the chats (see api/settings.ts).
 */
export function editImageTool(several: boolean, references: boolean): MediaTool {
  const common = {
    prompt: text(several ? "What should change or what the new picture shows, naming the pictures by place" : "What should change"),
    title: text("A few words shown above it"),
  };
  return {
    name: EDIT_IMAGE_TOOL,
    label: "edit image",
    description: (several ? SEVERAL_PICTURES : ONE_PICTURE)(references) + BEFORE_YOU_CALL,
    // What a person approves is the pictures, each of them: the prompt is no part of it. Both names, for the tool takes either.
    approvalFiles: ["path", "paths"],
    parameters: several
      ? object(
          {
            paths: list(text(), {
              minItems: 1,
              maxItems: MAX_EDIT_PICTURES,
              description: "In the order the prompt refers to them, relative to the chat's folder or absolute inside it",
            }),
            ...common,
          },
          ["title"],
        )
      : object({ path: text("The picture, relative to the chat's folder or absolute inside it"), ...common }, ["title"]),
    voiceGuidelines: [EDIT_IMAGE_VOICE_LINE],
    run: async (chat, p: { path?: string; paths?: string[]; prompt: string; title?: string }, signal) => {
      // Read now, not when the tool was loaded: an address, a model or a key changed since is in force.
      const config = imageGenerationConfig();
      if (!imageEditingReady(config)) {
        throw new Error("Image editing is switched off, or has no address now. Tell the person; there is no other way to change a picture.");
      }
      const prompt = typeof p.prompt === "string" ? p.prompt.trim() : "";
      if (!prompt) throw new Error("A prompt is required: say what should change in the picture.");
      if (prompt.length > MAX_PROMPT) throw new Error(`The prompt is over ${MAX_PROMPT} characters; say it shorter.`);
      // A list where the tool was loaded with one path is as good, and one path where it was loaded with a list: both are asked of the setting as it is now.
      const named: unknown[] = Array.isArray(p.paths) ? p.paths : [p.path];
      checkCount(named.length, config.editMultiple);
      // Each where it is in the chat's folder, and read from there: no other place is read. All before anything is sent.
      const { paths: originals, images } = readChatPictures(chat, named, "Picture", "edited");
      const target = imageEditingTarget(config);
      const { bytes, ext, notes } = await editImage(target, { prompt, image: images.length > 1 ? images : images[0] }, { signal });
      const rel = saveGenerated(chat, bytes, ext, editedName(originals[0], ext));
      // Listed in the Media page's gallery, tied to the pictures it was made from that are listed there.
      recordChatPicture({ sessionId: chat.id, path: rel, kind: "edited", prompt, from: originals, bytes: bytes.length, params: target.model ? { model: target.model } : {} });
      const title = (typeof p.title === "string" && p.title.trim() ? p.title : prompt).replace(/\s+/g, " ").trim().slice(0, 120);
      const details = { files: [{ path: rel, ...(title ? { title } : {}), from: originals }] };
      const made = originals.length > 1 ? `Made from ${originals.join(", ")} (in this order)` : `Edited ${originals[0]}`;
      // What was scaled to make the picture fit is said, so that the agent can tell the person the result may be smaller than the original.
      const scaled = notes.length ? `. ${notes.join(" ")}` : "";
      return { content: [{ type: "text", text: `${made}, and shown to the user: ${rel}${scaled}` }], details };
    },
  };
}
