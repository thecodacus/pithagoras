import { randomBytes } from "node:crypto";
import { refusalOf } from "./file-error";
import { portal } from "./host";
import { addPagePicture, readListed, type PictureParams } from "./image-gallery";
import { checkCount, editImage } from "./image-editing";
import {
  ImageGenerationError,
  generateImage,
  imageEditingReady,
  imageEditingTarget,
  imageGenerationConfig,
  imageGenerationReady,
  type ImageEditingTarget,
  type ImageGenerationConfig,
} from "./image-generation";
import { forPicture, hasNative, nativeConflict, type PictureSettings } from "./image-settings";
import { MAX_PICTURE_BYTES } from "./picture-files";

/**
 * Making pictures for the Media page: a request becomes a job that runs on
 * the server, so that closing the page, or going to another, does not lose a
 * picture that is being paid for. The page asks which jobs there are, and shows
 * each as the picture being made until it is in the gallery.
 *
 * Several run at once, up to a few: an endpoint may queue them or answer them
 * together, and the portal does not know which. The limit is a guard against a
 * click that costs more than meant, not a measure of what an endpoint can do.
 * Jobs live in memory: a restart, or Media being stopped, ends the ones that
 * were running, and nothing is made of them. The picture of a job that is done
 * is in the gallery for good, and its job is forgotten once it has been seen
 * and a while has passed.
 *
 * What a job does is what the agent's tools do — the same request, the same
 * checks of what comes back, the same limits and time — with the settings read
 * when it starts, so a change of the address needs no restart. Nothing in a job
 * holds a key, and what it says of a failure has none either. A new picture with
 * references goes to the editing endpoint, from noise, as generate_image sends
 * one (see pi/generate-image-tool.ts).
 */

/** How many pictures are being made at once. */
export const MAX_RUNNING = 4;
/** Finished jobs kept to be seen: the page asks every moment or two while one runs, and again when it is opened. */
const KEEP_FINISHED = 30;
const KEEP_FINISHED_MS = 60 * 60_000;

export interface PictureJob {
  id: string;
  kind: "generate" | "edit";
  state: "running" | "done" | "failed";
  prompt: string;
  /** The size asked for, for the frame that holds the picture's place. */
  size?: string;
  /** An edit's first picture, in the gallery, for the frame to show under the wait. */
  from?: string;
  startedAt: number;
  finishedAt?: number;
  /** When it is done: the picture, in the gallery. */
  pictureId?: string;
  /** When an edit's pictures, or a new picture's references, were scaled down or compressed to fit what an edit takes: what was done to which, in words for the person. Left out when nothing was. */
  notes?: string[];
  /** When it failed: why, in words with no secret in them. */
  error?: string;
}

interface Held extends PictureJob {
  controller: AbortController;
}

const jobs = new Map<string, Held>();

/** Why a request cannot be started now; the API turns each into a status. */
export class JobRefusal extends Error {
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

const open = ({ controller: _c, ...job }: Held): PictureJob => job;

/** What the jobs are doing, newest first. */
export function listJobs(): PictureJob[] {
  tidy();
  return [...jobs.values()].sort((a, b) => b.startedAt - a.startedAt).map(open);
}

/**
 * Stops a job that is running, or forgets one that has finished. A job that is
 * stopped makes nothing: the request to the endpoint is dropped, which a hosted
 * endpoint may still charge for, and no picture comes of it. False when there is
 * no such job.
 */
export function stopJob(id: string): boolean {
  const job = jobs.get(id);
  if (!job) return false;
  if (job.state === "running") job.controller.abort();
  jobs.delete(id);
  return true;
}

/** Stops every job that is running and forgets the rest, as Media stops: a job's picture is not saved into a store that is closed. */
export function stopJobs(): void {
  for (const id of [...jobs.keys()]) stopJob(id);
}

/** What went wrong, for the person: the endpoint's words where the portal has them, never a path or a key. */
const said = (e: unknown): string => {
  if (e instanceof ImageGenerationError) return e.message;
  portal().log(`images: ${(e as Error)?.stack ?? e}`);
  return "The picture could not be made or saved";
};

/** Runs `make` as a job: it is started now, and what it ends with is kept on the job. */
function start(job: Omit<PictureJob, "id" | "state" | "startedAt">, make: (signal: AbortSignal) => Promise<{ pictureId: string; notes?: string[] }>): PictureJob {
  const held: Held = { ...job, id: randomBytes(6).toString("hex"), state: "running", startedAt: Date.now(), controller: new AbortController() };
  jobs.set(held.id, held);
  void make(held.controller.signal).then(
    ({ pictureId, notes }) => {
      // Stopped meanwhile: the job is gone, and what came back is not wanted.
      if (!jobs.has(held.id)) return;
      held.state = "done";
      held.pictureId = pictureId;
      if (notes?.length) held.notes = notes;
      held.finishedAt = Date.now();
    },
    (e) => {
      if (!jobs.has(held.id)) return;
      held.state = "failed";
      held.error = said(e);
      held.finishedAt = Date.now();
    },
  );
  return open(held);
}

/** What a request with a setting that only stable-diffusion.cpp reads is told while the switch for them is off: they are not sent, and not dropped without a word either. */
const SD_OFF = "Stable Diffusion extra settings are switched off, so seed, steps, negative prompt, strength and starting from noise are not sent. Switch them on under Media in Settings, or leave them out";

/** Whether there is room for `count` more, or the refusal that says there is not. */
function room(count: number): void {
  const free = MAX_RUNNING - running();
  if (count > free) {
    throw new JobRefusal(
      free <= 0 ? `${MAX_RUNNING} pictures are being made already: wait for one to finish, or stop one` : `Only ${free} more can be made now, as ${MAX_RUNNING} are made at a time`,
      429,
    );
  }
}

export interface GenerateJob extends PictureSettings {
  prompt: string;
  /** One picture each: an endpoint that makes one at a time is asked for several as several, not for a number it may refuse. */
  count: number;
  /** Pictures of the gallery, by their ids, that the new picture takes a character, an object or a style from, in the order the prompt refers to them. */
  references?: string[];
}

/** What goes in the gallery of how a picture was asked for: the settings that were sent, and none that were not. */
function paramsOf(settings: PictureSettings): PictureParams {
  const { model, size, outputFormat, outputCompression, fromNoise, negativePrompt, seed, sampleSteps, strength } = settings;
  return {
    ...(model ? { model } : {}),
    ...(size ? { size } : {}),
    ...(outputFormat ? { outputFormat } : {}),
    ...(outputCompression !== undefined ? { outputCompression } : {}),
    ...(negativePrompt ? { negativePrompt } : {}),
    ...(seed !== undefined ? { seed } : {}),
    ...(sampleSteps !== undefined ? { sampleSteps } : {}),
    ...(strength !== undefined ? { strength } : {}),
    ...(fromNoise ? { fromNoise } : {}),
  };
}

/** One picture's settings as a request for it takes them: the ones of the OpenAI format as fields, and the rest apart, for the prompt (see image-settings.ts). */
const requestOf = ({ model, size, outputFormat, outputCompression, fromNoise, negativePrompt, seed, sampleSteps, strength }: PictureSettings) => ({
  model,
  size,
  outputFormat,
  outputCompression,
  native: { fromNoise, negativePrompt, seed, sampleSteps, strength },
});

/**
 * The pictures of the gallery a request names, read now, and checked as the agent's tools check theirs before anything
 * is sent: one that cannot be read refuses the request, saying which where there are several (`label` and its place).
 */
function readPictures(ids: string[], label: string): Buffer[] {
  return ids.map((id, i) => {
    try {
      return readListed(id).bytes;
    } catch (e) {
      const which = ids.length > 1 ? `${label} ${i + 1}: ` : "";
      // The Files panel's words for a picture that is too large ("download it instead") are no way forward for an edit.
      const why =
        refusalOf(e) === "too_large"
          ? `The picture is over ${MAX_PICTURE_BYTES / 1024 / 1024} MB, which is more than can be read to be scaled down for an edit. Use a smaller picture.`
          : (e as Error).message;
      throw new JobRefusal(`${which}${why}`, 400);
    }
  });
}

/**
 * The references of a new picture, and where they go: the editing endpoint, the one route that takes pictures. It must
 * be on, and take as many as there are, as for an edit.
 */
function referencesOf(config: ImageGenerationConfig, ids: string[]): { target: ImageEditingTarget; images: Buffer[] } {
  if (!imageEditingReady(config)) {
    throw new JobRefusal("Reference pictures are sent to the image editing endpoint, and image editing is switched off or has no address: set it up under Media in Settings, or leave the references out", 409);
  }
  const target = imageEditingTarget(config);
  try {
    checkCount(ids.length, target.multiple);
  } catch (e) {
    throw new JobRefusal((e as Error).message, 400);
  }
  return { target, images: readPictures(ids, "Reference") };
}

/**
 * Starts one request for each picture asked for. The request is checked by
 * the caller (the API); what is checked here is whether the endpoint is
 * there to ask and whether there is room. Each picture has the next seed after
 * the one before it, so that a seed does not make the same picture several times.
 *
 * With references the pictures are read now, and each picture is asked of the
 * editing endpoint with them, from noise (see pi/generate-image-tool.ts), always
 * with the editing model, whatever model the request names, and with a size where
 * there is one: the add-on's where the request has none, as without one
 * stable-diffusion.cpp makes the picture in the first reference's size.
 */
export function startGenerations(request: GenerateJob): PictureJob[] {
  const config = imageGenerationConfig();
  if (!imageGenerationReady(config)) throw new JobRefusal("Image generation is switched off, or has no address: set it up under Media in Settings", 409);
  if (!config.sdExtras && hasNative(request)) throw new JobRefusal(SD_OFF, 409);
  room(request.count);
  const refs = request.references ? referencesOf(config, request.references) : undefined;
  // A block of the description's own would be the one the server reads, and the picture would start from the first reference after all.
  if (refs?.target.sdExtras && nativeConflict(request.prompt, { fromNoise: true })) {
    throw new JobRefusal("The description has an sd_cpp_extra_args block of its own, which would hide the one that makes a picture with references start from noise: take it out of the description", 400);
  }
  return Array.from({ length: request.count }, (_, i) => {
    const settings = forPicture(request, i);
    if (refs) {
      const size = settings.size || config.size;
      // Always the editing model: a model typed for making pictures need not be one the editing endpoint has. From noise is recorded only where it was sent: the block goes only while the switch is on.
      const withRefs = { ...settings, model: refs.target.model, size };
      const params: PictureParams = { ...paramsOf({ ...withRefs, ...(refs.target.sdExtras ? { fromNoise: true } : {}) }), references: request.references };
      const { images } = refs;
      return start({ kind: "generate", prompt: request.prompt, ...(size ? { size } : {}) }, async (signal) => {
        const asked = requestOf({ ...withRefs, fromNoise: true });
        const { bytes, ext, notes } = await editImage(refs.target, { prompt: request.prompt, image: images.length > 1 ? images : images[0], ...asked, references: true }, { signal });
        return { pictureId: addPagePicture({ bytes, ext, kind: "generated", prompt: request.prompt, params }).id, notes };
      });
    }
    // What is recorded is what was sent: the add-on's model and size are the defaults of a request that has none.
    const params = paramsOf({ ...settings, model: settings.model || config.model, size: settings.size || config.size });
    return start({ kind: "generate", prompt: request.prompt, ...(params.size ? { size: params.size } : {}) }, async (signal) => {
      const { bytes, ext } = await generateImage(config, { prompt: request.prompt, ...requestOf(settings) }, { signal });
      return { pictureId: addPagePicture({ bytes, ext, kind: "generated", prompt: request.prompt, params }).id };
    });
  });
}

export interface EditJob extends PictureSettings {
  prompt: string;
  /** The pictures to change, or to take as references, by their ids in the gallery, in the order the prompt refers to them. */
  sources: string[];
  /** Marks the area to change; checked as a picture when it is sent. */
  mask?: Buffer;
  /** One change each, as for generation: the same pictures, the same words, and the next seed for each. */
  count: number;
}

/**
 * Starts an edit, or several of the same. The pictures are read now, from the
 * gallery, and checked as the agent's tool checks them (count, what they are, and
 * that they can be made to fit, which scales one that is over the limits down) before anything is sent: a request that is refused is refused
 * here, with the reason.
 */
export function startEdit(request: EditJob): PictureJob[] {
  const config = imageGenerationConfig();
  if (!imageEditingReady(config)) throw new JobRefusal("Image editing is switched off, or has no address: set it up under Media in Settings", 409);
  const target = imageEditingTarget(config);
  if (!target.sdExtras && hasNative(request)) throw new JobRefusal(SD_OFF, 409);
  room(request.count);
  try {
    checkCount(request.sources.length, target.multiple);
  } catch (e) {
    throw new JobRefusal((e as Error).message, 400);
  }
  const images = readPictures(request.sources, "Picture");
  return Array.from({ length: request.count }, (_, i) => {
    const settings = forPicture(request, i);
    // The size is the request's own: an edit has none of the add-on's, which is the size of a new picture.
    const params: PictureParams = { ...paramsOf({ ...settings, model: settings.model || target.model }), sources: request.sources, ...(request.mask ? { masked: true } : {}) };
    return start({ kind: "edit", prompt: request.prompt, from: request.sources[0] }, async (signal) => {
      const { bytes, ext, notes } = await editImage(target, { prompt: request.prompt, image: images.length > 1 ? images : images[0], mask: request.mask, ...requestOf(settings) }, { signal });
      return { pictureId: addPagePicture({ bytes, ext, kind: "edited", prompt: request.prompt, params, sourceId: request.sources[0] }).id, notes };
    });
  });
}
