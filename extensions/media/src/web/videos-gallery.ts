import type { GalleryVideo, VideoJob, VideoKind, VideoOrigin, VideoRequest } from "./api";
import { appendNew, mergeHead, sameList } from "./gallery-list";
import { VIDEO_LIMITS } from "../server/video-settings";

/**
 * What the Media page (MediaPage.tsx) works out for its videos without a page:
 * which videos are drawn and in what order, how a page that was asked for again
 * joins the ones already there, and the form's settings and what it remembers.
 * The same work it does for pictures (images-gallery.ts), and the same
 * code where it is the same.
 */

export interface Filter {
  origin?: VideoOrigin;
  kind?: VideoKind;
}

const ORIGINS: readonly string[] = ["page", "chat", "folder"];
const KINDS: readonly string[] = ["generated", "animated", "unknown"];

/** The filters in the address; what is not one of them is no filter, so that a link that is out of date shows everything. */
export function readFilter(params: URLSearchParams): Filter {
  const origin = params.get("origin");
  const kind = params.get("kind");
  return {
    ...(origin && ORIGINS.includes(origin) ? { origin: origin as VideoOrigin } : {}),
    ...(kind && KINDS.includes(kind) ? { kind: kind as VideoKind } : {}),
  };
}

/** What a clip is called where it is named: its description, or the file's name for one that has none. */
export const videoName = (video: GalleryVideo): string => (video.prompt || video.fileName).replace(/\s+/g, " ").trim();

/** The clips there are, once the top of the list has been asked for again (see mergeHead). */
export const mergeTop = (loaded: GalleryVideo[], fresh: { videos: GalleryVideo[]; next: string | null }): GalleryVideo[] => mergeHead(loaded, fresh.videos, fresh.next);

export { sameList };

/** A page that was loaded further down joins the end of the list (see appendNew). */
export const appendPage = appendNew<GalleryVideo>;

/** What the grid draws in one place: a clip, a job that is making one, or both — the job whose clip it now is. */
export interface Tile {
  /** The job's, where there is one: the tile stays the same one from the wait to the clip. */
  key: string;
  video?: GalleryVideo;
  job?: VideoJob;
}

/** What a job makes, as a filter says it: a job of the page makes its clips. */
const jobMatches = (job: VideoJob, filter: Filter): boolean => {
  if (filter.origin === "chat" || filter.origin === "folder") return false;
  if (filter.kind === "unknown") return false;
  if (filter.kind) return filter.kind === (job.kind === "animate" ? "animated" : "generated");
  return true;
};

/**
 * Every tile of the grid, newest first, in the order the viewer steps through: the jobs that have no clip to show
 * yet — being made, not made, or made and not yet taken in by the list — in front, and then the gallery as the list
 * has it. A job whose clip is in the list holds that clip's place, wherever newer clips have put it, and the clip is
 * not drawn a second time. A clip that was deleted is not shown by its job either (`gone`), and what a filter
 * leaves out, jobs included, is not shown.
 */
export function tiles(videos: GalleryVideo[], jobs: VideoJob[], filter: Filter, gone: ReadonlySet<string> = new Set()): Tile[] {
  const listed = new Set(videos.map((v) => v.id));
  const holding = new Map<string, VideoJob>();
  const first: Tile[] = [];
  for (const job of [...jobs].sort((a, b) => b.startedAt - a.startedAt)) {
    if (!jobMatches(job, filter)) continue;
    if (job.state !== "done") first.push({ key: `job:${job.id}`, job });
    else if (!job.videoId || gone.has(job.videoId)) continue;
    else if (listed.has(job.videoId)) holding.set(job.videoId, job);
    else first.push({ key: `job:${job.id}`, job });
  }
  return [
    ...first,
    ...videos.map((v): Tile => {
      const job = holding.get(v.id);
      return job ? { key: `job:${job.id}`, job, video: v } : { key: v.id, video: v };
    }),
  ];
}

/**
 * The clips that jobs say they made and that the list does not have, which the portal is asked about by their ids:
 * one that it has not got any more was deleted somewhere else, and its job must not stand in for it. Only jobs the
 * filter shows, and none whose clip was deleted here.
 */
export function madeButNotListed(jobs: VideoJob[], have: ReadonlySet<string>, gone: ReadonlySet<string>, filter: Filter): string[] {
  return jobs.flatMap((job) => (job.state === "done" && job.videoId && jobMatches(job, filter) && !have.has(job.videoId) && !gone.has(job.videoId) ? [job.videoId] : []));
}

/** How long a clip plays, in seconds: what the server says it made, else what was asked for; none where neither is known. */
export function clipSeconds(params: GalleryVideo["params"]): number | undefined {
  const frames = params.madeFrames ?? params.frames;
  const fps = params.madeFps ?? params.fps;
  return frames && fps ? frames / fps : undefined;
}

/** A length in seconds as a label: "2.1 s", and "1:05" past a minute. */
export function secondsLabel(seconds: number): string {
  if (seconds >= 60) {
    const whole = Math.round(seconds);
    return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
  }
  return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)} s`;
}

/** What a clip may be asked for with, as the server half checks it (see limits.ts). */
export { VIDEO_LIMITS };

/** What the form asks for one clip with, as typed: nothing typed is nothing sent. */
export interface Fields {
  model: string;
  width: string;
  height: string;
  frames: string;
  fps: string;
  negativePrompt: string;
  seed: string;
  sampleSteps: string;
  strength: string;
}

export type FieldName = keyof Fields;

/** What is wrong with a setting, as a code that the form says in words. */
export type Problem = "size-pair" | "size-range" | "frames" | "fps" | "seed" | "steps" | "strength" | "negative-long";

const WHOLE = /^[+-]?\d+$/;

/** A whole number as typed, or undefined when it is not one in the range. */
function whole(text: string, min: number, max?: number): number | undefined {
  if (!WHOLE.test(text)) return undefined;
  const n = Number(text);
  return Number.isSafeInteger(n) && n >= min && (max === undefined || n <= max) ? n : undefined;
}

/** The settings the form has, ready to send, or the first one that is wrong. What is empty is left out; a size is both sides or none. */
export function settingsBody(fields: Fields): { body: Omit<VideoRequest, "prompt" | "count" | "firstFrame" | "lastFrame"> } | { field: FieldName; problem: Problem } {
  const body: Omit<VideoRequest, "prompt" | "count" | "firstFrame" | "lastFrame"> = {};
  const model = fields.model.trim();
  if (model) body.model = model;

  const width = fields.width.trim();
  const height = fields.height.trim();
  if (width || height) {
    if (!width || !height) return { field: width ? "height" : "width", problem: "size-pair" };
    const w = whole(width, VIDEO_LIMITS.side.min, VIDEO_LIMITS.side.max);
    if (w === undefined) return { field: "width", problem: "size-range" };
    const h = whole(height, VIDEO_LIMITS.side.min, VIDEO_LIMITS.side.max);
    if (h === undefined) return { field: "height", problem: "size-range" };
    body.size = `${w}x${h}`;
  }

  const frames = fields.frames.trim();
  if (frames) {
    const n = whole(frames, VIDEO_LIMITS.frames.min, VIDEO_LIMITS.frames.max);
    if (n === undefined) return { field: "frames", problem: "frames" };
    body.frames = n;
  }
  const fps = fields.fps.trim();
  if (fps) {
    const n = whole(fps, VIDEO_LIMITS.fps.min, VIDEO_LIMITS.fps.max);
    if (n === undefined) return { field: "fps", problem: "fps" };
    body.fps = n;
  }

  const negative = fields.negativePrompt.trim();
  if (negative.length > VIDEO_LIMITS.negativePrompt) return { field: "negativePrompt", problem: "negative-long" };
  if (negative) body.negativePrompt = negative;

  const seed = fields.seed.trim();
  if (seed) {
    const n = whole(seed, VIDEO_LIMITS.seed.min);
    if (n === undefined) return { field: "seed", problem: "seed" };
    body.seed = n;
  }
  const steps = fields.sampleSteps.trim();
  if (steps) {
    const n = whole(steps, VIDEO_LIMITS.steps.min, VIDEO_LIMITS.steps.max);
    if (n === undefined) return { field: "sampleSteps", problem: "steps" };
    body.sampleSteps = n;
  }
  const strength = fields.strength.trim();
  if (strength) {
    // A comma is a decimal point where the person writes one.
    const text = strength.replace(",", ".");
    const n = /^(\d+(\.\d+)?|\.\d+)$/.test(text) ? Number(text) : NaN;
    if (!(n >= VIDEO_LIMITS.strength.min && n <= VIDEO_LIMITS.strength.max)) return { field: "strength", problem: "strength" };
    body.strength = n;
  }
  return { body };
}

/** What the form keeps between visits: the settings of a request, not its words. */
export interface FormMemory {
  fields: Fields;
  count: number;
  /** The less usual settings are shown. */
  open: boolean;
}

export const FORM_KEY = "videosForm";

const text = (v: unknown, max: number): string => (typeof v === "string" ? v.slice(0, max) : "");

/** What was kept, as far as it still makes sense: storage is the person's to change and the page's to survive. A seed is not kept: it would make every clip the same one, the next day too. */
export function readForm(stored: string | null, most: number): FormMemory {
  let raw: Record<string, unknown> = {};
  try {
    const parsed = stored ? JSON.parse(stored) : null;
    if (parsed && typeof parsed === "object") raw = parsed;
  } catch {
    // Unreadable is as good as nothing kept.
  }
  const f = (raw.fields && typeof raw.fields === "object" ? raw.fields : {}) as Record<string, unknown>;
  const count = Number(raw.count);
  return {
    fields: {
      model: text(f.model, 200),
      width: text(f.width, 5),
      height: text(f.height, 5),
      frames: text(f.frames, 4),
      fps: text(f.fps, 3),
      negativePrompt: text(f.negativePrompt, VIDEO_LIMITS.negativePrompt),
      seed: "",
      sampleSteps: text(f.sampleSteps, 3),
      strength: text(f.strength, 6),
    },
    count: Number.isInteger(count) && count >= 1 ? Math.min(count, Math.max(1, most)) : 1,
    open: raw.open === true,
  };
}

/** The sides of a size as the add-on has it, `832x480`, for the fields to show as what is used when they are empty. */
export function sizeParts(size: string): { width: string; height: string } {
  const both = /^(\d+)x(\d+)$/.exec(size);
  return both ? { width: both[1], height: both[2] } : { width: "", height: "" };
}
