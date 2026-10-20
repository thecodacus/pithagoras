import { originOf, parseBase } from "./image-generation";
import { getSetting, putSetting } from "./store";
import { sdcppBackend } from "./video-sdcpp";
import { VideoGenerationError, type MadeVideo, type VideoBackend, type VideoBackendId, type VideoGenerationConfig, type VideoRequest, type VideoRun } from "./video-types";
import { VIDEO_LIMITS, VIDEO_TIMEOUT_SECONDS, parseVideoSize } from "./video-settings";

export { VideoGenerationError } from "./video-types";
export type { MadeVideo, VideoBackendId, VideoGenerationConfig, VideoProgress, VideoRequest, VideoRun } from "./video-types";

/**
 * Video generation as an add-on: the agent's `generate_video` tool, and the
 * Media page, ask a video model the person has set up for a clip, and get one back.
 *
 * It is built on the same pattern as picture generation (image-generation.ts):
 * the settings are Media's own, in its store, read each time a clip is asked for,
 * so a change to the address or the model needs no restart; the key is kept here and
 * goes to the endpoint it was given for, and nowhere else.
 *
 * There is no single standard for video generation yet, so how a clip is asked for
 * is a backend's (see VideoBackend): the jobs, the gallery, the tool and the page
 * know nothing of it. The one there is, for now, speaks stable-diffusion.cpp's
 * server (video-sdcpp.ts). Another is a new entry in BACKENDS and a value of
 * `backend` in the settings, which the page would offer as a choice.
 */

const KEY = "video_generation";

/** The agent's tool: it exists only while the add-on is ready (see videoGenerationReady). */
export const GENERATE_VIDEO_TOOL = "generate_video";
/** The tool that shows a clip that is in the chat's folder, as show_image does a picture. */
export const SHOW_VIDEO_TOOL = "show_video";

const text = (v: unknown): string => (typeof v === "string" ? v : "");

const validTimeout = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= VIDEO_TIMEOUT_SECONDS.min && (v as number) <= VIDEO_TIMEOUT_SECONDS.max;
const validFrames = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= VIDEO_LIMITS.frames.min && (v as number) <= VIDEO_LIMITS.frames.max;
const validFps = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= VIDEO_LIMITS.fps.min && (v as number) <= VIDEO_LIMITS.fps.max;
/** From a megabyte to a hundred terabytes: what a disk is. */
export const STORAGE_LIMIT_MB = { min: 1, max: 100_000_000 };
const validStorage = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= STORAGE_LIMIT_MB.min && (v as number) <= STORAGE_LIMIT_MB.max;

/** The backends there are, by the id the settings name one with. */
const BACKENDS: Record<VideoBackendId, VideoBackend> = { sdcpp: sdcppBackend };
export const VIDEO_BACKENDS = Object.values(BACKENDS).map(({ id, label }) => ({ id, label }));
const DEFAULT_BACKEND: VideoBackendId = "sdcpp";

/** What is saved, as it is: without the defaults the config fills in. */
function savedSettings(): Record<string, unknown> {
  try {
    const parsed = JSON.parse(getSetting(KEY) || "{}");
    if (parsed && typeof parsed === "object") return parsed;
  } catch {
    // Unreadable is as good as nothing saved.
  }
  return {};
}

export function videoGenerationConfig(): VideoGenerationConfig {
  const raw = savedSettings();
  return {
    enabled: raw.enabled === true,
    backend: typeof raw.backend === "string" && Object.hasOwn(BACKENDS, raw.backend) ? (raw.backend as VideoBackendId) : DEFAULT_BACKEND,
    baseUrl: text(raw.baseUrl),
    model: text(raw.model),
    // One saved outside the sizes is as good as none.
    size: typeof raw.size === "string" && typeof parseVideoSize(raw.size) === "string" ? raw.size.trim() : "",
    frames: validFrames(raw.frames) ? raw.frames : null,
    fps: validFps(raw.fps) ? raw.fps : null,
    apiKey: text(raw.apiKey),
    timeoutSeconds: validTimeout(raw.timeoutSeconds) ? raw.timeoutSeconds : VIDEO_TIMEOUT_SECONDS.default,
    storageLimitMb: validStorage(raw.storageLimitMb) ? raw.storageLimitMb : 0,
  };
}

/** On, and told where to ask: only then is there a tool, so there is no tool that always fails. */
export const videoGenerationReady = (config: VideoGenerationConfig = videoGenerationConfig()): boolean => config.enabled && config.baseUrl !== "";

/** What the page is told of the settings: never a key itself. */
export function videoGenerationState() {
  const config = videoGenerationConfig();
  const { apiKey, ...rest } = config;
  return { ...rest, keySet: apiKey !== "", ready: videoGenerationReady(config), backends: VIDEO_BACKENDS };
}

export interface VideoGenerationPatch {
  enabled?: boolean;
  backend?: VideoBackendId;
  baseUrl?: string;
  model?: string;
  size?: string;
  /** null takes the saved one away. */
  frames?: number | null;
  fps?: number | null;
  /** "" takes the saved one away. */
  apiKey?: string;
  /** Whole seconds, from VIDEO_TIMEOUT_SECONDS.min to its max; null takes the saved one away, which is the default again. */
  timeoutSeconds?: number | null;
  /** Whole megabytes; null takes the limit away. */
  storageLimitMb?: number | null;
}

/** What a request may change, checked; the reason when it may not. */
export function parseVideoGenerationPatch(body: unknown): VideoGenerationPatch | string {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const patch: VideoGenerationPatch = {};
  if (b.enabled !== undefined) {
    if (typeof b.enabled !== "boolean") return "enabled must be true or false";
    patch.enabled = b.enabled;
  }
  if (b.backend !== undefined) {
    if (typeof b.backend !== "string" || !Object.hasOwn(BACKENDS, b.backend)) return `The backend is one of ${Object.keys(BACKENDS).join(", ")}`;
    patch.backend = b.backend as VideoBackendId;
  }
  if (b.baseUrl !== undefined) {
    const parsed = parseBase(b.baseUrl);
    if ("error" in parsed) return parsed.error;
    patch.baseUrl = parsed.base;
  }
  if (b.model !== undefined) {
    if (typeof b.model !== "string" || b.model.length > 200) return "The model must be text of at most 200 characters";
    patch.model = b.model.trim();
  }
  if (b.size !== undefined) {
    if (typeof b.size !== "string") return 'The size looks like "832x480"';
    const size = b.size.trim() ? parseVideoSize(b.size) : "";
    if (typeof size !== "string") return size.error;
    patch.size = size;
  }
  if (b.frames !== undefined) {
    if (b.frames !== null && !validFrames(b.frames)) return `The frames are a whole number from ${VIDEO_LIMITS.frames.min} to ${VIDEO_LIMITS.frames.max}`;
    patch.frames = b.frames as number | null;
  }
  if (b.fps !== undefined) {
    if (b.fps !== null && !validFps(b.fps)) return `The frame rate is a whole number from ${VIDEO_LIMITS.fps.min} to ${VIDEO_LIMITS.fps.max} frames per second`;
    patch.fps = b.fps as number | null;
  }
  if (b.timeoutSeconds !== undefined) {
    if (b.timeoutSeconds !== null && !validTimeout(b.timeoutSeconds)) {
      return `The time limit must be a whole number of seconds from ${VIDEO_TIMEOUT_SECONDS.min} to ${VIDEO_TIMEOUT_SECONDS.max}`;
    }
    patch.timeoutSeconds = b.timeoutSeconds as number | null;
  }
  if (b.storageLimitMb !== undefined) {
    if (b.storageLimitMb !== null && !validStorage(b.storageLimitMb)) return `The disk limit must be a whole number of megabytes from ${STORAGE_LIMIT_MB.min} to ${STORAGE_LIMIT_MB.max}`;
    patch.storageLimitMb = b.storageLimitMb as number | null;
  }
  if (b.apiKey !== undefined) {
    if (typeof b.apiKey !== "string" || b.apiKey.length > 4000) return "The key must be text of at most 4000 characters";
    patch.apiKey = b.apiKey.trim();
  }
  return patch;
}

/**
 * Saves a change, or refuses it: switched on, there must be an address to ask.
 * A key belongs to the server it was given for, so a new address of another
 * origin that does not come with one has none. A key saved before any address
 * was given for no server yet, and stays for the first.
 */
export function saveVideoGeneration(patch: VideoGenerationPatch): VideoGenerationConfig {
  const had = videoGenerationConfig();
  const { timeoutSeconds: asked, frames, fps, storageLimitMb, ...others } = patch;
  const next: VideoGenerationConfig = {
    ...had,
    ...others,
    ...(typeof asked === "number" ? { timeoutSeconds: asked } : asked === null ? { timeoutSeconds: VIDEO_TIMEOUT_SECONDS.default } : {}),
    ...(frames !== undefined ? { frames } : {}),
    ...(fps !== undefined ? { fps } : {}),
    ...(storageLimitMb !== undefined ? { storageLimitMb: storageLimitMb ?? 0 } : {}),
  };
  // Only from one server to another: a key saved before there was an address was given for none, and goes with the first.
  const moved = had.baseUrl !== "" && originOf(next.baseUrl) !== originOf(had.baseUrl);
  if (patch.apiKey === undefined && moved) next.apiKey = "";
  if (next.enabled && !next.baseUrl) throw new VideoGenerationError("Set the address of the video endpoint before switching it on");
  // The default stays unsaved until a limit is chosen, so that it is the default of the day for every setup that never chose one.
  const { timeoutSeconds: _timeout, ...rest } = next;
  putSetting(KEY, JSON.stringify(typeof asked === "number" || (asked === undefined && "timeoutSeconds" in savedSettings()) ? next : rest));
  return next;
}

/**
 * Asks for a clip and returns it, checked: what comes back is a WebM or an MP4 by its first bytes, whatever the
 * server calls it, and not larger than the limit. How it is asked is the backend's, as the settings name it.
 */
export function generateVideo(config: VideoGenerationConfig, request: VideoRequest, run: VideoRun = {}): Promise<MadeVideo> {
  return BACKENDS[config.backend].generate(config, request, run);
}
