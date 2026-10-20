import type { ViewerPicture } from "@pithagoras/extension-api";
import type { GalleryPicture, PictureJob, PictureKind, PictureOrigin, PictureSettingsBody } from "./api";
import { appendNew, mergeHead, sameList } from "./gallery-list";
import { COMPRESSIBLE as COMPRESSIBLE_FORMATS, LIMITS, OUTPUT_FORMATS, type OutputFormat } from "../server/image-settings";

/**
 * What the Media page (MediaPage.tsx) works out for its pictures without a page:
 * which pictures are drawn and in what order, how a page that was asked for
 * again joins the ones already there, what the viewer is given, and the form's
 * settings and what it remembers.
 */

export interface Filter {
  origin?: PictureOrigin;
  kind?: PictureKind;
}

const ORIGINS: readonly string[] = ["page", "chat", "folder"];
const KINDS: readonly string[] = ["generated", "edited", "uploaded", "unknown"];

/** The filters in the address; what is not one of them is no filter, so that a link that is out of date shows everything. */
export function readFilter(params: URLSearchParams): Filter {
  const origin = params.get("origin");
  const kind = params.get("kind");
  return {
    ...(origin && ORIGINS.includes(origin) ? { origin: origin as PictureOrigin } : {}),
    ...(kind && KINDS.includes(kind) ? { kind: kind as PictureKind } : {}),
  };
}

/** The pictures there are, once the top of the list has been asked for again (see mergeHead). */
export const mergeTop = (loaded: GalleryPicture[], fresh: { pictures: GalleryPicture[]; next: string | null }): GalleryPicture[] => mergeHead(loaded, fresh.pictures, fresh.next);

export { sameList };

/** A page that was loaded further down joins the end of the list (see appendNew). */
export const appendPage = appendNew<GalleryPicture>;

/** What the viewer gets for a picture, from where the page fetches its file. */
export function viewerPicture(picture: GalleryPicture, fileUrl: (id: string) => string): ViewerPicture {
  return {
    id: picture.id,
    src: fileUrl(picture.id),
    alt: picture.prompt || picture.fileName,
    ...(picture.prompt ? { caption: picture.prompt } : {}),
    fileName: picture.fileName,
    ...(picture.from ? { from: picture.from } : {}),
  };
}

/**
 * What the viewer steps through: the gallery as loaded, and each original that
 * an edit was made from and that is further down than the page has reached,
 * right after the first edit that names it, so that the link between the two
 * has something to go to. When the gallery gets to it, it is the gallery's own.
 */
export function viewerList(loaded: GalleryPicture[], originals: ReadonlyMap<string, GalleryPicture>): GalleryPicture[] {
  const have = new Set(loaded.map((p) => p.id));
  const list: GalleryPicture[] = [];
  for (const picture of loaded) {
    list.push(picture);
    const original = picture.from && !have.has(picture.from) ? originals.get(picture.from) : undefined;
    if (original) {
      list.push(original);
      have.add(original.id);
    }
  }
  return list;
}

/** What the grid draws in one place: a picture, a job that is making one, or both — the job whose picture it now is. */
export interface Tile {
  /** The job's, where there is one: the tile stays the same one from the wait to the picture. */
  key: string;
  picture?: GalleryPicture;
  job?: PictureJob;
}

/** What a job makes, as a filter says it: a job of the page makes its pictures, and an upload is not made by one. */
const jobMatches = (job: PictureJob, filter: Filter): boolean => {
  if (filter.origin === "chat" || filter.origin === "folder") return false;
  if (filter.kind === "uploaded" || filter.kind === "unknown") return false;
  if (filter.kind) return filter.kind === (job.kind === "edit" ? "edited" : "generated");
  return true;
};

/**
 * Every tile of the grid, newest first, in the order the viewer steps through:
 * the jobs that have no picture to show yet — being made, not made, or made and
 * not yet taken in by the list — in front, and then the gallery as the list has
 * it. A job whose picture is in the list holds that picture's place, wherever
 * newer pictures have put it, and the picture is not drawn a second time. A
 * picture that was deleted is not shown by its job either (`gone`), and what a
 * filter leaves out, jobs included, is not shown.
 */
export function tiles(pictures: GalleryPicture[], jobs: PictureJob[], filter: Filter, gone: ReadonlySet<string> = new Set()): Tile[] {
  const listed = new Set(pictures.map((p) => p.id));
  const holding = new Map<string, PictureJob>();
  const first: Tile[] = [];
  for (const job of [...jobs].sort((a, b) => b.startedAt - a.startedAt)) {
    if (!jobMatches(job, filter)) continue;
    if (job.state !== "done") first.push({ key: `job:${job.id}`, job });
    else if (!job.pictureId || gone.has(job.pictureId)) continue;
    else if (listed.has(job.pictureId)) holding.set(job.pictureId, job);
    else first.push({ key: `job:${job.id}`, job });
  }
  return [
    ...first,
    ...pictures.map((p): Tile => {
      const job = holding.get(p.id);
      return job ? { key: `job:${job.id}`, job, picture: p } : { key: p.id, picture: p };
    }),
  ];
}

/**
 * The pictures that jobs say they made and that the list does not have, which
 * the portal is asked about by their ids: one that it has not got any more was
 * deleted somewhere else, and its job must not stand in for it. Only jobs the
 * filter shows, and none whose picture was deleted here.
 */
export function madeButNotListed(jobs: PictureJob[], have: ReadonlySet<string>, gone: ReadonlySet<string>, filter: Filter): string[] {
  return jobs.flatMap((job) => (job.state === "done" && job.pictureId && jobMatches(job, filter) && !have.has(job.pictureId) && !gone.has(job.pictureId) ? [job.pictureId] : []));
}

/**
 * What a picture was made with by an older version of the page, which let the
 * person type fields of their own: `name=value`, one to a line, as the details
 * show them. They are not sent any more (see the server half's image settings),
 * and a picture that has them still says so. A value that is text but looks like
 * a number or a switch is in quotes, so that it reads as it was.
 */
export const fieldsText = (extra: Record<string, string | number | boolean> | undefined): string =>
  Object.entries(extra ?? {})
    .map(([name, value]) => `${name}=${typeof value === "string" && (value === "true" || value === "false" || /^-?\d+(\.\d+)?$/.test(value)) ? `"${value}"` : value}`)
    .join("\n");

/** What a picture may be asked for, as the server half checks it (see limits.ts). */
export { LIMITS, OUTPUT_FORMATS };
/** The formats that have a compression to set, for a format as it is typed. */
export const COMPRESSIBLE: readonly string[] = COMPRESSIBLE_FORMATS;

/** What the form asks for one picture with, as typed: nothing typed is nothing sent. */
export interface Fields {
  model: string;
  width: string;
  height: string;
  negativePrompt: string;
  /** Empty is the endpoint's own. */
  outputFormat: "" | OutputFormat;
  outputCompression: string;
  seed: string;
  sampleSteps: string;
  /** For a change only. */
  strength: string;
  /** For a change only: start from noise, with the pictures as references, instead of from the first picture. Not kept: the next visit starts from the picture. */
  fromNoise: boolean;
}

export type FieldName = keyof Fields;

/** What is wrong with a setting, as a code that the form says in words. */
export type Problem = "size-pair" | "size-range" | "compression-range" | "seed" | "steps" | "strength" | "negative-long";

const WHOLE = /^[+-]?\d+$/;

/** A whole number as typed, or undefined when it is not one in the range. */
function whole(text: string, min: number, max?: number): number | undefined {
  if (!WHOLE.test(text)) return undefined;
  const n = Number(text);
  return Number.isSafeInteger(n) && n >= min && (max === undefined || n <= max) ? n : undefined;
}

/**
 * The settings the form has, ready to send, or the first one that is wrong.
 * What is empty is left out; a size is both sides or none; a compression goes
 * only with a format that has one (the field is off for the others). The ones
 * that only stable-diffusion.cpp reads (`sd`) are looked at only while the
 * switch for them is on: off, whatever is in the fields is neither checked nor
 * sent, and stays where it is. A strength is for a change only, and not one
 * that starts from noise.
 */
export function settingsBody(fields: Fields, edit: boolean, sd: boolean): { body: PictureSettingsBody } | { field: FieldName; problem: Problem } {
  const body: PictureSettingsBody = {};
  const model = fields.model.trim();
  if (model) body.model = model;

  const width = fields.width.trim();
  const height = fields.height.trim();
  if (width || height) {
    if (!width || !height) return { field: width ? "height" : "width", problem: "size-pair" };
    const w = whole(width, LIMITS.side.min, LIMITS.side.max);
    if (w === undefined) return { field: "width", problem: "size-range" };
    const h = whole(height, LIMITS.side.min, LIMITS.side.max);
    if (h === undefined) return { field: "height", problem: "size-range" };
    body.size = `${w}x${h}`;
  }

  if (fields.outputFormat) {
    body.outputFormat = fields.outputFormat;
    const compression = fields.outputCompression.trim();
    if (compression && COMPRESSIBLE.includes(fields.outputFormat)) {
      const n = whole(compression, LIMITS.compression.min, LIMITS.compression.max);
      if (n === undefined) return { field: "outputCompression", problem: "compression-range" };
      body.outputCompression = n;
    }
  }

  if (!sd) return { body };

  const negative = fields.negativePrompt.trim();
  if (negative.length > LIMITS.negativePrompt) return { field: "negativePrompt", problem: "negative-long" };
  if (negative) body.negativePrompt = negative;

  const seed = fields.seed.trim();
  if (seed) {
    const n = whole(seed, LIMITS.seed.min);
    if (n === undefined) return { field: "seed", problem: "seed" };
    body.seed = n;
  }
  const steps = fields.sampleSteps.trim();
  if (steps) {
    const n = whole(steps, LIMITS.steps.min, LIMITS.steps.max);
    if (n === undefined) return { field: "sampleSteps", problem: "steps" };
    body.sampleSteps = n;
  }
  if (edit && fields.fromNoise) body.fromNoise = true;
  const strength = fields.strength.trim();
  // A strength is how far the result may go from the first picture, and from noise there is none.
  if (edit && !fields.fromNoise && strength) {
    // A comma is a decimal point where the person writes one.
    const text = strength.replace(",", ".");
    const n = /^(\d+(\.\d+)?|\.\d+)$/.test(text) ? Number(text) : NaN;
    if (!(n >= LIMITS.strength.min && n <= LIMITS.strength.max)) return { field: "strength", problem: "strength" };
    body.strength = n;
  }
  return { body };
}

/** What the form keeps between visits: the settings of a request, not its words. Making and changing each have their own, since the defaults of one are not the other's. */
export interface FormMemory {
  make: Fields;
  edit: Fields;
  count: number;
  /** The less usual settings are shown. */
  open: boolean;
}

export const FORM_KEY = "imagesForm";

const text = (v: unknown, max: number): string => (typeof v === "string" ? v.slice(0, max) : "");

/** The fields as they were kept. A seed is not: it would make every picture the same one, the next day too. */
function readFields(raw: unknown): Fields {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    model: text(r.model, 200),
    width: text(r.width, 5),
    height: text(r.height, 5),
    negativePrompt: text(r.negativePrompt, LIMITS.negativePrompt),
    outputFormat: OUTPUT_FORMATS.includes(r.outputFormat as OutputFormat) ? (r.outputFormat as OutputFormat) : "",
    outputCompression: text(r.outputCompression, 3),
    seed: "",
    sampleSteps: text(r.sampleSteps, 3),
    strength: text(r.strength, 6),
    fromNoise: false,
  };
}

/** What was kept, as far as it still makes sense: storage is the person's to change and the page's to survive. */
export function readForm(stored: string | null, most: number): FormMemory {
  let raw: Record<string, unknown> = {};
  try {
    const parsed = stored ? JSON.parse(stored) : null;
    if (parsed && typeof parsed === "object") raw = parsed;
  } catch {
    // Unreadable is as good as nothing kept.
  }
  const make = readFields(raw.make);
  // What an older page kept, one model and one size for making: still the ones for making. Its free extra fields are gone.
  if (!raw.make) {
    make.model = text(raw.model, 200);
    const old = /^(\d{1,5})x(\d{1,5})$/.exec(text(raw.size, 20));
    if (old) [, make.width, make.height] = old;
  }
  const count = Number(raw.count);
  return {
    make,
    edit: readFields(raw.edit),
    count: Number.isInteger(count) && count >= 1 ? Math.min(count, Math.max(1, most)) : 1,
    open: raw.open === true,
  };
}

/** The sides of a size as the add-on has it, `1024x1024`, for the fields to show as what is used when they are empty. `auto` is both. */
export function sizeParts(size: string): { width: string; height: string } {
  const both = /^(\d+)x(\d+)$/.exec(size);
  if (both) return { width: both[1], height: both[2] };
  return size === "auto" ? { width: "auto", height: "auto" } : { width: "", height: "" };
}
