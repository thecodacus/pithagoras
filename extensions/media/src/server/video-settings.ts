import { LIMITS as PICTURE_LIMITS } from "./image-settings";

/**
 * The settings of one clip beyond its description, as the Media page offers
 * them, and what each may be.
 *
 * What a video model takes is its own: a size, how many frames and how fast they
 * play, a seed, the steps of the sampler, a negative prompt, a strength. They are fields of
 * the request, sent to the endpoint the way its backend reads them (see
 * video-generation.ts); a field that is left out is not sent, and the server's
 * own default applies. The limits here are the page's as well — it imports them,
 * so that raising one here is raising it there — and are only what the portal
 * checks: what a model can do is its server's to say, in its own words.
 */

/** What each setting may be, for the page to say and the portal to check. */
export const VIDEO_LIMITS = {
  /** Each side of a size, in pixels: what a server such as stable-diffusion.cpp's takes. */
  side: { min: 64, max: 4096 },
  /** How many frames a clip has. The server rounds to what its model takes, and says how many it made. */
  frames: { min: 1, max: 1000 },
  fps: { min: 1, max: 120 },
  /** The same as for a picture: the sampler's steps, a seed (-1 asks for a random one) and a negative prompt. */
  steps: PICTURE_LIMITS.steps,
  seed: PICTURE_LIMITS.seed,
  negativePrompt: PICTURE_LIMITS.negativePrompt,
  /** How strongly the pictures a clip starts or ends on hold it; what a model makes of it is its own. The same range as for a picture's change. */
  strength: PICTURE_LIMITS.strength,
} as const;

/**
 * The time a clip may take, in whole seconds, from the request to the file: a clip takes minutes, so half an hour by
 * default (and a queue on the server counts). Under half a minute almost no server answers, so a typo could not make every
 * request fail; four hours is more than anyone should wait on one clip.
 */
export const VIDEO_TIMEOUT_SECONDS = { default: 1800, min: 30, max: 14400 };

/** What the endpoints take of a prompt: the same limit a picture has. */
export const MAX_VIDEO_PROMPT = 4000;

/** How many clips are being made at once: a guard against a click that costs more than meant, not a measure of what a server can do. */
export const MAX_RUNNING_VIDEOS = 4;

/** What one clip is asked for with, beyond its description. Whatever is not here is not sent. */
export interface VideoSettings {
  model?: string;
  /** `832x480`. */
  size?: string;
  frames?: number;
  fps?: number;
  seed?: number;
  sampleSteps?: number;
  negativePrompt?: string;
  /** Sent as `strength` when set, whether or not a picture goes with it. */
  strength?: number;
}

const empty = (v: unknown): boolean => v === undefined || v === null || v === "";

/** A whole number from `min` (to `max`), or the message that says it is not one. */
function whole(value: unknown, min: number, max: number | undefined, message: string): number | { error: string } {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || (max !== undefined && value > max)) return { error: message };
  return value;
}

/** A size as a request has it, `832x480`, or why it is not one. Unlike a picture's there is no `auto`: a clip's shape is not the endpoint's to pick. */
export function parseVideoSize(value: unknown): string | { error: string } {
  const given = typeof value === "string" ? value.trim() : "";
  const sides = /^(\d{1,5})x(\d{1,5})$/.exec(given);
  const fits = (n: string) => Number(n) >= VIDEO_LIMITS.side.min && Number(n) <= VIDEO_LIMITS.side.max;
  if (sides && fits(sides[1]) && fits(sides[2])) return given;
  return { error: `The size looks like "832x480", with each side from ${VIDEO_LIMITS.side.min} to ${VIDEO_LIMITS.side.max} pixels` };
}

/**
 * The settings of a request, checked, or the reason one is not fine. A setting
 * that is left out, null or empty is not sent. `count` is how many clips are made
 * from it, which each take the next seed, so that the last must still be one.
 */
export function parseVideoSettings(body: Record<string, unknown>, count = 1): VideoSettings | string {
  const settings: VideoSettings = {};

  if (!empty(body.model)) {
    if (typeof body.model !== "string" || body.model.length > 200) return "The model must be text of at most 200 characters";
    if (body.model.trim()) settings.model = body.model.trim();
  }
  if (!empty(body.size)) {
    const size = parseVideoSize(body.size);
    if (typeof size !== "string") return size.error;
    settings.size = size;
  }
  if (!empty(body.frames)) {
    const frames = whole(body.frames, VIDEO_LIMITS.frames.min, VIDEO_LIMITS.frames.max, `The frames are a whole number from ${VIDEO_LIMITS.frames.min} to ${VIDEO_LIMITS.frames.max}`);
    if (typeof frames !== "number") return frames.error;
    settings.frames = frames;
  }
  if (!empty(body.fps)) {
    const fps = whole(body.fps, VIDEO_LIMITS.fps.min, VIDEO_LIMITS.fps.max, `The frame rate is a whole number from ${VIDEO_LIMITS.fps.min} to ${VIDEO_LIMITS.fps.max} frames per second`);
    if (typeof fps !== "number") return fps.error;
    settings.fps = fps;
  }
  if (!empty(body.negativePrompt)) {
    if (typeof body.negativePrompt !== "string") return "The negative prompt must be text";
    if (body.negativePrompt.length > VIDEO_LIMITS.negativePrompt) return `The negative prompt is over ${VIDEO_LIMITS.negativePrompt} characters`;
    if (body.negativePrompt.trim()) settings.negativePrompt = body.negativePrompt.trim();
  }
  if (!empty(body.seed)) {
    const seed = whole(body.seed, VIDEO_LIMITS.seed.min, undefined, "The seed is a whole number, 0 or more, or -1 for a random one");
    if (typeof seed !== "number") return seed.error;
    if (!Number.isSafeInteger(seed + count)) return "The seed is too large";
    settings.seed = seed;
  }
  if (!empty(body.sampleSteps)) {
    const steps = whole(body.sampleSteps, VIDEO_LIMITS.steps.min, VIDEO_LIMITS.steps.max, `The steps are a whole number from ${VIDEO_LIMITS.steps.min} to ${VIDEO_LIMITS.steps.max}`);
    if (typeof steps !== "number") return steps.error;
    settings.sampleSteps = steps;
  }
  if (!empty(body.strength)) {
    const { min, max } = VIDEO_LIMITS.strength;
    if (typeof body.strength !== "number" || !Number.isFinite(body.strength) || body.strength < min || body.strength > max) return `The strength is a number from ${min} to ${max}`;
    settings.strength = body.strength;
  }
  return settings;
}

/** The settings of the `index`th clip of a request for several: each takes the next seed, so that they are not the same clip. A random seed stays random. */
export function forClip(settings: VideoSettings, index: number): VideoSettings {
  return settings.seed !== undefined && settings.seed >= 0 && index > 0 ? { ...settings, seed: settings.seed + index } : settings;
}

/** How many frames a length in seconds is at a frame rate, within what a clip may have; the portal does not round them to what a model takes, its server does and says. */
export function framesFor(seconds: number, fps: number): number {
  return Math.min(VIDEO_LIMITS.frames.max, Math.max(VIDEO_LIMITS.frames.min, Math.round(seconds * fps)));
}
