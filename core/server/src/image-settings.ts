/**
 * The settings of one picture beyond its description, as the Media page offers
 * them, and how each reaches the image endpoint.
 *
 * The endpoint speaks the OpenAI image format, in which a request has a prompt, a
 * model, a size, a number of pictures, an output format and the compression of
 * one. Those go as the fields they are. Nothing else is in that format: a seed,
 * the steps of the sampler, a negative prompt and the strength of an edit are
 * not, and an endpoint that is sent them as fields ignores them or refuses the
 * request. stable-diffusion.cpp's server takes them in its own way, as a JSON
 * block inside the prompt that it cuts out before it generates:
 *
 *   a lighthouse at dusk <sd_cpp_extra_args>{"negative_prompt":"blurry","seed":42,"sample_params":{"sample_steps":20}}</sd_cpp_extra_args>
 *
 * So these go there, and only there, and only when one is set: with none, the
 * prompt is sent as it is typed. An endpoint that is not stable-diffusion.cpp
 * has no use for them, which is said where the page offers them.
 *
 * The limits here (LIMITS, the formats, how many pictures an edit takes, the time
 * limit) are the page's as well: it imports them, so that raising one here is
 * raising it there, and the page does not refuse what the portal takes.
 */

/** The formats of the OpenAI image format; an endpoint may take fewer, and says so. */
export const OUTPUT_FORMATS = ["png", "jpeg", "webp"] as const;
export type OutputFormat = (typeof OUTPUT_FORMATS)[number];
/** The ones whose size a compression changes: the format has `output_compression` for these only. */
export const COMPRESSIBLE: readonly OutputFormat[] = ["jpeg", "webp"];

/** What each setting may be, for the page to say and the portal to check. */
export const LIMITS = {
  /** Each side of a size, in pixels. */
  side: { min: 64, max: 8192 },
  compression: { min: 0, max: 100 },
  /** stable-diffusion.cpp clamps the steps to this itself. */
  steps: { min: 1, max: 100 },
  strength: { min: 0, max: 1 },
  /** -1 asks for a random one. */
  seed: { min: -1 },
  negativePrompt: 4000,
} as const;

/**
 * How many pictures one edit takes, and how much they weigh together. Endpoints
 * take fewer or more and say so in their answer, which is passed on; these keep
 * what the portal reads and sends within reason, since all of it is held in
 * memory and goes up within the time limit of the request.
 */
export const MAX_EDIT_PICTURES = 8;
export const MAX_EDIT_TOTAL_BYTES = 50 * 1024 * 1024;

/**
 * The time a request for a picture may take, in whole seconds: a slow or local model needs minutes, so five by
 * default. Under half a minute almost no endpoint answers, so a typo could not make every request fail; an hour is
 * more than anyone should wait on one picture.
 */
export const TIMEOUT_SECONDS = { default: 300, min: 30, max: 3600 };

/** `1024x1024`, with no `auto`, which is no size to limit by, and no side of zero, which would limit nothing: what a maximum size is given as. */
export const MAX_SIZE = /^[1-9]\d{1,4}x[1-9]\d{1,4}$/;

/** The settings that are not in the OpenAI format: what stable-diffusion.cpp's server takes in the prompt. */
export interface NativeSettings {
  /**
   * For an edit: start from noise instead of from the first picture, which is then a reference like the others
   * (`"init_image": null` in the block; the pictures themselves are still sent). A strength and a mask belong to
   * the picture that is built on, so neither goes with this.
   */
  fromNoise?: boolean;
  negativePrompt?: string;
  seed?: number;
  sampleSteps?: number;
  /** For an edit: how far the result may go from the picture, from 0 (not at all) to 1. */
  strength?: number;
}

/** What one picture is asked for with, beyond its description. Whatever is not here is not sent. */
export interface PictureSettings extends NativeSettings {
  model?: string;
  /** `1024x1024`, or `auto`. */
  size?: string;
  outputFormat?: OutputFormat;
  /** Only with a format that has a compression to set; see COMPRESSIBLE. */
  outputCompression?: number;
}

/** The tag stable-diffusion.cpp looks for in a prompt. */
const TAG = "sd_cpp_extra_args";

/** What the block says, with the names stable-diffusion.cpp reads: the sampler's steps are in `sample_params`, the rest are at the top. */
export function nativeArgs(settings: NativeSettings): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  if (settings.fromNoise) args.init_image = null;
  if (settings.negativePrompt) args.negative_prompt = settings.negativePrompt;
  if (settings.seed !== undefined) args.seed = settings.seed;
  if (settings.strength !== undefined) args.strength = settings.strength;
  if (settings.sampleSteps !== undefined) args.sample_params = { sample_steps: settings.sampleSteps };
  return args;
}

/**
 * The block for `settings`, or nothing when none of them is set. The server cuts
 * it out of the prompt with a pattern that ends at the first closing tag and
 * does not span lines, so the JSON is written without either: `<` as <, so
 * that text in a negative prompt cannot close the block early, and the two
 * characters JSON leaves as they are but some patterns take for a line end.
 */
export function nativeBlock(settings: NativeSettings): string {
  const args = nativeArgs(settings);
  if (!Object.keys(args).length) return "";
  const json = JSON.stringify(args)
    .replace(/</g, "\\u003c")
    .replace(/[\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16)}`);
  return `<${TAG}>${json}</${TAG}>`;
}

/** Whether any setting that only stable-diffusion.cpp reads is set. */
export const hasNative = (settings: NativeSettings): boolean => nativeBlock(settings) !== "";

/** The prompt as it is sent: the description, and the block after it where there is one. */
export function promptWith(prompt: string, settings: NativeSettings): string {
  const block = nativeBlock(settings);
  return block ? `${prompt} ${block}` : prompt;
}

/**
 * Why the settings cannot be added to this prompt, or undefined: a description
 * that has a block of its own would have the first one read and the other lost,
 * which is a setting that silently does nothing.
 */
export function nativeConflict(prompt: string, settings: NativeSettings): string | undefined {
  if (!nativeBlock(settings) || !prompt.includes(TAG)) return undefined;
  return `The description has an ${TAG} block of its own. Take it out of the description, or clear the stable-diffusion.cpp only settings: both cannot be sent`;
}

const empty = (v: unknown): boolean => v === undefined || v === null || v === "";

/** A whole number from `min` (to `max`), or the message that says it is not one. */
function whole(value: unknown, min: number, max: number | undefined, message: string): number | { error: string } {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || (max !== undefined && value > max)) return { error: message };
  return value;
}

/** A size as a request has it, `auto` or `1024x1024`, or why it is not one. */
export function parseSize(value: unknown): string | { error: string } {
  const given = typeof value === "string" ? value.trim() : "";
  const sides = /^(\d{1,5})x(\d{1,5})$/.exec(given);
  const fits = (n: string) => Number(n) >= LIMITS.side.min && Number(n) <= LIMITS.side.max;
  if (given === "auto" || (sides && fits(sides[1]) && fits(sides[2]))) return given;
  return { error: `The size looks like "1024x1024", with each side from ${LIMITS.side.min} to ${LIMITS.side.max} pixels` };
}

/**
 * The settings of a request, checked, or the reason one is not fine. A setting
 * that is left out, null or empty is not sent. `edit` is whether it is for a
 * change, which has a strength and may start from noise; `count` is how many pictures are made from it,
 * which each take the next seed, so that the last must still be one.
 */
export function parsePictureSettings(body: Record<string, unknown>, edit: boolean, count = 1): PictureSettings | string {
  const settings: PictureSettings = {};

  if (!empty(body.model)) {
    if (typeof body.model !== "string" || body.model.length > 200) return "The model must be text of at most 200 characters";
    if (body.model.trim()) settings.model = body.model.trim();
  }
  if (!empty(body.size)) {
    const size = parseSize(body.size);
    if (typeof size !== "string") return size.error;
    settings.size = size;
  }

  if (!empty(body.outputFormat)) {
    if (typeof body.outputFormat !== "string" || !(OUTPUT_FORMATS as readonly string[]).includes(body.outputFormat)) return `The file format is ${OUTPUT_FORMATS.join(", ")}`;
    settings.outputFormat = body.outputFormat as OutputFormat;
  }
  if (!empty(body.outputCompression)) {
    const compression = whole(body.outputCompression, LIMITS.compression.min, LIMITS.compression.max, `The compression is a whole number from ${LIMITS.compression.min} to ${LIMITS.compression.max}`);
    if (typeof compression !== "number") return compression.error;
    if (!settings.outputFormat || !COMPRESSIBLE.includes(settings.outputFormat)) return "A compression can be set for JPEG and WebP: choose one of them as the file format";
    settings.outputCompression = compression;
  }

  if (!empty(body.negativePrompt)) {
    if (typeof body.negativePrompt !== "string") return "The negative prompt must be text";
    if (body.negativePrompt.length > LIMITS.negativePrompt) return `The negative prompt is over ${LIMITS.negativePrompt} characters`;
    if (body.negativePrompt.trim()) settings.negativePrompt = body.negativePrompt.trim();
  }
  if (!empty(body.seed)) {
    const seed = whole(body.seed, LIMITS.seed.min, undefined, "The seed is a whole number, 0 or more, or -1 for a random one");
    if (typeof seed !== "number") return seed.error;
    if (!Number.isSafeInteger(seed + count)) return "The seed is too large";
    settings.seed = seed;
  }
  if (!empty(body.sampleSteps)) {
    const steps = whole(body.sampleSteps, LIMITS.steps.min, LIMITS.steps.max, `The steps are a whole number from ${LIMITS.steps.min} to ${LIMITS.steps.max}`);
    if (typeof steps !== "number") return steps.error;
    settings.sampleSteps = steps;
  }
  if (edit && body.fromNoise !== undefined && body.fromNoise !== null) {
    if (typeof body.fromNoise !== "boolean") return "Starting from noise is true or false";
    if (body.fromNoise) settings.fromNoise = true;
  }
  if (edit && !empty(body.strength)) {
    if (settings.fromNoise) return "A strength says how far the result may go from the first picture, and there is none to start from";
    const { min, max } = LIMITS.strength;
    if (typeof body.strength !== "number" || !Number.isFinite(body.strength) || body.strength < min || body.strength > max) return `The strength is a number from ${min} to ${max}`;
    settings.strength = body.strength;
  }
  return settings;
}

/** The settings of the `index`th picture of a request for several: each takes the next seed, so that they are not the same picture. A random seed stays random. */
export function forPicture(settings: PictureSettings, index: number): PictureSettings {
  return settings.seed !== undefined && settings.seed >= 0 && index > 0 ? { ...settings, seed: settings.seed + index } : settings;
}
