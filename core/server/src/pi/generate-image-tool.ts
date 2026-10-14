import { randomBytes } from "node:crypto";
import { Type } from "typebox";
import { GENERATED_PICTURE_MARK } from "../generated-picture.js";
import { GENERATED_DIR, recordChatPicture } from "../image-gallery.js";
import { GENERATE_IMAGE_SOURCE, GENERATE_IMAGE_TOOL, MAX_PROMPT, generateImage, imageGenerationConfig, imageGenerationReady } from "../image-generation.js";
import { parseSize } from "../image-settings.js";
import { FileError, baseDir, makeFolder, saveNewFile } from "../workspace-files.js";
import { pictureIn } from "./show-image-tool.js";

/**
 * Making a picture from a description, with the image model the person set up
 * in Settings → Agent → Media, and putting it in front of them.
 *
 * What it returns is what show_image returns — the picture's path in the chat's
 * folder, and a title, with a mark that it is this tool's (see generated-picture.ts)
 * — so the page draws it as it draws one the agent showed:
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
export function saveGenerated(folder: string, bytes: Buffer, ext: string, name = fileName(ext)): string {
  const base = baseDir(folder);
  try {
    makeFolder(base, "", GENERATED_DIR);
  } catch (e) {
    if (!(e instanceof FileError && e.code === "exists")) throw e;
  }
  const rel = saveNewFile(base, GENERATED_DIR, name, bytes);
  // Checked as the page will fetch it, so a call that succeeds is one that shows.
  return pictureIn(folder, rel);
}

/**
 * Whether another extension has a tool of this name. pi keeps the first
 * registration of a name, and inline extensions load after the others, so
 * such a tool is the one the model has, and the portal's is left unused.
 * By default the generation tool; `source` is the label of the portal's own.
 */
export function takenByAnother(extensions: readonly any[], name = GENERATE_IMAGE_TOOL, source = GENERATE_IMAGE_SOURCE): boolean {
  return extensions.some(
    (extension) =>
      extension?.path !== `<inline:${source}>` && [...(extension?.tools?.values?.() ?? [])].some((tool: any) => tool?.definition?.name === name),
  );
}

/**
 * An ExtensionFactory — see pi's InlineExtension.
 *
 * Decided each time pi loads it, and again on a reload: while the add-on is
 * off or has no address there is no tool at all, and the voice rule says
 * nothing of one. `registered` is whether the model has the portal's tool as
 * it was last loaded: not where an extension's tool of the same name is the
 * one pi uses, which `extensions` — what pi has loaded — tells.
 */
export class GenerateImageTool {
  private on = false;
  constructor(
    private readonly folder: string,
    private readonly extensions: () => readonly any[] = () => [],
    /** The chat, for the gallery to say whose a picture is; without it a picture is made and not listed. */
    private readonly sessionId?: string,
  ) {}

  registered = (): boolean => this.on && !takenByAnother(this.extensions());

  extension = (pi: any) => {
    this.on = false;
    if (!imageGenerationReady()) return;
    const { folder, sessionId } = this;
    pi.registerTool({
      name: GENERATE_IMAGE_TOOL,
      label: "generate image",
      description:
        "Make a picture from a description with the person's image model, save it in the chat's folder and show it (no show_image needed). " +
        "Describe subject, style, setting, colours. Slow and costs the person: one picture unless asked for more. " +
        "Give a short title; say briefly what you made.",
      parameters: Type.Object({
        prompt: Type.String({ description: "What it should show" }),
        title: Type.Optional(Type.String({ description: "A few words shown above it" })),
        size: Type.Optional(Type.String({ description: "WIDTHxHEIGHT in pixels, e.g. 1024x1024; omit for the default" })),
      }),
      execute: async (_id: string, p: { prompt: string; title?: string; size?: string }, signal?: AbortSignal) => {
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
        const rel = saveGenerated(folder, bytes, ext);
        if (sessionId) {
          const asked = size || config.size;
          recordChatPicture({ sessionId, path: rel, kind: "generated", prompt, bytes: bytes.length, params: { ...(config.model ? { model: config.model } : {}), ...(asked ? { size: asked } : {}) } });
        }
        const title = (typeof p.title === "string" && p.title.trim() ? p.title : prompt).replace(/\s+/g, " ").trim().slice(0, 120);
        const details = { path: rel, ...(title ? { title } : {}), [GENERATED_PICTURE_MARK]: true };
        return { content: [{ type: "text", text: `Generated and shown to the user: ${rel}` }], details };
      },
    });
    this.on = true;
  };
}
