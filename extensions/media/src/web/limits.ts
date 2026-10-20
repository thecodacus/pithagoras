/**
 * What a picture or a clip may be asked for with, as the server half checks it
 * (its image and video settings): the page's forms say what is wrong before
 * they ask, and never of something the server half takes. Raising one there is
 * raising it here.
 */

/** The formats of the OpenAI image format; an endpoint may take fewer, and says so. */
export const OUTPUT_FORMATS = ["png", "jpeg", "webp"] as const;
export type OutputFormat = (typeof OUTPUT_FORMATS)[number];
/** The ones whose size a compression changes: the format has `output_compression` for these only. */
export const COMPRESSIBLE: readonly OutputFormat[] = ["jpeg", "webp"];

/** What each setting of a picture may be. */
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

/** How many pictures one edit takes. */
export const MAX_EDIT_PICTURES = 8;

/** The time a request for a picture may take, in whole seconds. */
export const TIMEOUT_SECONDS = { default: 300, min: 30, max: 3600 };

/** `1024x1024`, with no `auto` and no side of zero: what a maximum size is given as. */
export const MAX_SIZE = /^[1-9]\d{1,4}x[1-9]\d{1,4}$/;

/** What each setting of a clip may be. */
export const VIDEO_LIMITS = {
  /** Each side of a size, in pixels: what a server such as stable-diffusion.cpp's takes. */
  side: { min: 64, max: 4096 },
  /** How many frames a clip has. The server rounds to what its model takes, and says how many it made. */
  frames: { min: 1, max: 1000 },
  fps: { min: 1, max: 120 },
  /** The same as for a picture: the sampler's steps, a seed (-1 asks for a random one) and a negative prompt. */
  steps: LIMITS.steps,
  seed: LIMITS.seed,
  negativePrompt: LIMITS.negativePrompt,
  /** How strongly the pictures a clip starts or ends on hold it. The same range as for a picture's change. */
  strength: LIMITS.strength,
} as const;

/** The time a clip may take, in whole seconds, from the request to the file. */
export const VIDEO_TIMEOUT_SECONDS = { default: 1800, min: 30, max: 14400 };
