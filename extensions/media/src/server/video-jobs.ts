import { randomBytes } from "node:crypto";
import { refusalOf } from "./file-error";
import { portal } from "./host";
import { readListed } from "./image-gallery";
import { MAX_PICTURE_BYTES, pictureType } from "./picture-files";
import { addPageVideo, pageVideoBytes, type VideoKind, type VideoParams } from "./video-gallery";
import { VideoGenerationError, generateVideo, videoGenerationConfig, videoGenerationReady, type VideoProgress } from "./video-generation";
import { MAX_RUNNING_VIDEOS, forClip, type VideoSettings } from "./video-settings";

/**
 * Making clips for the Media page: a request becomes a job that runs on the
 * server, so that closing the page, or going to another, does not lose a clip
 * that is being paid for in minutes of somebody's GPU. The page asks which jobs
 * there are, and shows each as the clip being made until it is in the gallery.
 *
 * The same shape as the picture jobs (image-jobs.ts), and as generic: what a job
 * does is a call of generateVideo, which knows how the endpoint is spoken to, and
 * what it reports of how far the clip is (waiting in the server's queue, being
 * made) is kept on the job for the page to say. Jobs live in memory: a restart,
 * or Media being stopped, ends the ones that were running, and nothing is made of
 * them. The clip of a job that is done is in the gallery for good, and its job is
 * forgotten once it has been seen and a while has passed. Nothing in a job holds
 * a key, and what it says of a failure has none either.
 */

/** Finished jobs kept to be seen: the page asks every moment or two while one runs, and again when it is opened. */
const KEEP_FINISHED = 30;
const KEEP_FINISHED_MS = 60 * 60_000;

export interface VideoJob {
  id: string;
  /** Made from a description, or from a picture as its first frame or its last. */
  kind: "generate" | "animate";
  state: "running" | "done" | "failed";
  /** While it runs, and the server says: waiting its turn there, or being made. */
  stage?: VideoProgress["stage"];
  /** Which place in the server's queue, while it waits. */
  queuePosition?: number;
  prompt: string;
  /** The size asked for, for the frame that holds the clip's place. */
  size?: string;
  /** A clip made from a picture: the picture's id in the Images gallery, for the frame to show under the wait. */
  from?: string;
  startedAt: number;
  finishedAt?: number;
  /** When it is done: the clip, in the gallery. */
  videoId?: string;
  /** When it failed: why, in words with no secret in them. */
  error?: string;
}

interface Held extends VideoJob {
  controller: AbortController;
}

const jobs = new Map<string, Held>();

/** Why a request cannot be started now; the API turns each into a status. */
export class VideoJobRefusal extends Error {
  constructor(
    message: string,
    readonly status: 400 | 409 | 429,
  ) {
    super(message);
  }
}

const running = (): number => [...jobs.values()].filter((j) => j.state === "running").length;

/** Forgets the finished jobs that are too many or too old; the ones still running are never forgotten. */
function tidy(now = Date.now()): void {
  const finished = [...jobs.values()].filter((j) => j.state !== "running").sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0));
  finished.forEach((j, i) => {
    if (i >= KEEP_FINISHED || now - (j.finishedAt ?? now) > KEEP_FINISHED_MS) jobs.delete(j.id);
  });
}

const open = ({ controller: _c, ...job }: Held): VideoJob => job;

/** What the jobs are doing, newest first. */
export function listJobs(): VideoJob[] {
  tidy();
  return [...jobs.values()].sort((a, b) => b.startedAt - a.startedAt).map(open);
}

/**
 * Stops a job that is running, or forgets one that has finished. A job that is stopped makes no clip on the page:
 * the portal stops waiting for it, and tells the server to drop it if it is still in its queue; a clip the server
 * has begun goes on to its end there, which a hosted endpoint may still charge for. False when there is no such job.
 */
export function stopJob(id: string): boolean {
  const job = jobs.get(id);
  if (!job) return false;
  if (job.state === "running") job.controller.abort();
  jobs.delete(id);
  return true;
}

/** Stops every job that is running and forgets the rest, as Media stops: a job's clip is not saved into a store that is closed. */
export function stopJobs(): void {
  for (const id of [...jobs.keys()]) stopJob(id);
}

/** What went wrong, for the person: the endpoint's words where the portal has them, never a path or a key. */
const said = (e: unknown): string => {
  if (e instanceof VideoGenerationError) return e.message;
  portal().log(`videos: ${(e as Error)?.stack ?? e}`);
  return "The clip could not be made or saved";
};

/** Runs `make` as a job: it is started now, and what it ends with is kept on the job. */
function start(job: Pick<VideoJob, "kind" | "prompt" | "size" | "from">, make: (signal: AbortSignal, progress: (p: VideoProgress) => void) => Promise<string>): VideoJob {
  const held: Held = { ...job, id: randomBytes(6).toString("hex"), state: "running", startedAt: Date.now(), controller: new AbortController() };
  jobs.set(held.id, held);
  void make(held.controller.signal, (p) => {
    if (!jobs.has(held.id) || held.state !== "running") return;
    held.stage = p.stage;
    if (p.queuePosition !== undefined) held.queuePosition = p.queuePosition;
    else delete held.queuePosition;
  }).then(
    (videoId) => {
      // Stopped meanwhile: the job is gone, and what came back is not wanted.
      if (!jobs.has(held.id)) return;
      held.state = "done";
      held.videoId = videoId;
      held.finishedAt = Date.now();
      delete held.stage;
      delete held.queuePosition;
    },
    (e) => {
      if (!jobs.has(held.id)) return;
      held.state = "failed";
      held.error = said(e);
      held.finishedAt = Date.now();
      delete held.stage;
      delete held.queuePosition;
    },
  );
  return open(held);
}

/** Whether there is room for `count` more, or the refusal that says there is not. */
function room(count: number): void {
  const free = MAX_RUNNING_VIDEOS - running();
  if (count > free) {
    throw new VideoJobRefusal(
      free <= 0 ? `${MAX_RUNNING_VIDEOS} clips are being made already: wait for one to finish, or stop one` : `Only ${free} more can be made now, as ${MAX_RUNNING_VIDEOS} are made at a time`,
      429,
    );
  }
}

export interface GenerateVideoJob extends VideoSettings {
  prompt: string;
  /** One clip each: a server that makes one at a time queues the others. */
  count: number;
  /** The first frame, by its id in the Images gallery: the clips are made from this picture. */
  firstFrame?: string;
  /** The last frame, by its id in the Images gallery: the clips are asked to end on this picture, on a server that says it takes one. */
  lastFrame?: string;
}

/** What goes in the gallery of how a clip was asked for: the settings that were sent, and none that were not. */
function paramsOf(settings: VideoSettings): VideoParams {
  const { model, size, frames, fps, seed, sampleSteps, negativePrompt, strength } = settings;
  return {
    ...(model ? { model } : {}),
    ...(size ? { size } : {}),
    ...(frames !== undefined ? { frames } : {}),
    ...(fps !== undefined ? { fps } : {}),
    ...(negativePrompt ? { negativePrompt } : {}),
    ...(seed !== undefined ? { seed } : {}),
    ...(sampleSteps !== undefined ? { sampleSteps } : {}),
    ...(strength !== undefined ? { strength } : {}),
  };
}

/** A picture of the gallery as the first or last frame of a clip, or the refusal that says why it cannot be one. */
function frameOf(id: string, which: "first" | "last"): { bytes: Buffer; mimeType: string } {
  try {
    const { bytes } = readListed(id);
    const mimeType = pictureType(bytes.subarray(0, 12));
    if (!mimeType) throw new VideoJobRefusal(`The ${which} frame is not a PNG, JPEG, GIF or WebP picture`, 400);
    return { bytes, mimeType };
  } catch (e) {
    if (e instanceof VideoJobRefusal) throw e;
    // The Files panel's words for a picture that is too large ("download it instead") are no way forward here.
    const why = refusalOf(e) === "too_large" ? `The picture is over ${MAX_PICTURE_BYTES / 1024 / 1024} MB: use a smaller one as the ${which} frame` : (e as Error).message;
    throw new VideoJobRefusal(`The ${which} frame: ${why}`, 400);
  }
}

/**
 * Starts one request for each clip asked for. The request is checked by the caller (the API); what is checked
 * here is whether the endpoint is there to ask, whether the page's own clips have room on the disk, whether the
 * picture to start from can be read, and whether there is room for another job. Each clip has the next seed
 * after the one before it, so that a seed does not make the same clip several times.
 */
export function startVideos(request: GenerateVideoJob): VideoJob[] {
  const config = videoGenerationConfig();
  if (!videoGenerationReady(config)) throw new VideoJobRefusal("Video generation is switched off, or has no address: set it up under Media in Settings", 409);
  if (config.storageLimitMb > 0 && pageVideoBytes() >= config.storageLimitMb * 1024 * 1024) {
    throw new VideoJobRefusal(`The clips made on the Media page take ${Math.round(pageVideoBytes() / 1024 / 1024)} MB, which is the limit set under Media in Settings. Delete some clips, or raise the limit`, 409);
  }
  room(request.count);
  const firstFrame = request.firstFrame ? frameOf(request.firstFrame, "first") : undefined;
  const lastFrame = request.lastFrame ? frameOf(request.lastFrame, "last") : undefined;
  const kind: VideoKind = firstFrame || lastFrame ? "animated" : "generated";
  return Array.from({ length: request.count }, (_, i) => {
    const { prompt, count: _count, firstFrame: _from, lastFrame: _to, ...asked } = request;
    const settings = forClip(asked, i);
    // What is recorded is what was sent: the add-on's model, size, frames and frame rate are the defaults of a request that has none.
    const params: VideoParams = {
      ...paramsOf({ ...settings, model: settings.model || config.model, size: settings.size || config.size, frames: settings.frames ?? config.frames ?? undefined, fps: settings.fps ?? config.fps ?? undefined }),
      ...(request.firstFrame ? { firstFrame: { picture: request.firstFrame } } : {}),
      ...(request.lastFrame ? { lastFrame: { picture: request.lastFrame } } : {}),
    };
    return start({ kind: firstFrame || lastFrame ? "animate" : "generate", prompt, ...(params.size ? { size: params.size } : {}), ...(request.firstFrame ? { from: request.firstFrame } : {}) }, async (signal, progress) => {
      const made = await generateVideo(config, { prompt, ...settings, ...(firstFrame ? { firstFrame } : {}), ...(lastFrame ? { lastFrame } : {}) }, { signal, timeoutMs: config.timeoutSeconds * 1000, onProgress: progress });
      const video = addPageVideo({
        bytes: made.bytes,
        ext: made.ext,
        kind,
        prompt,
        params: { ...params, ...(made.frames !== undefined ? { madeFrames: made.frames } : {}), ...(made.fps !== undefined ? { madeFps: made.fps } : {}) },
      });
      return video.id;
    });
  });
}
