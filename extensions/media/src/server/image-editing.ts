import { ImageGenerationError, requestPicture, type GenerateOptions, type ImageEditingTarget } from "./image-generation";
import { MAX_EDIT_PICTURES, MAX_EDIT_TOTAL_BYTES, promptWith, type NativeSettings, type OutputFormat } from "./image-settings";
import { pictureSize } from "./picture-size";
import { CannotFit, fitBytes, fitsBox, scaleTo, scaleToBox, type Scaled } from "./picture-scale";
import { MAX_PICTURE_BYTES, pictureExt, pictureType } from "./picture-files";

/**
 * Changing a picture with the image endpoint the person set up: the same add-on
 * as generation (see image-generation.ts), asked for `images/edits` instead.
 *
 * The request is the OpenAI-style one — a multipart form with the picture, a
 * prompt and optionally a mask, and the model, size and output format when
 * there are some — and the answer is read as a generation's is, as `b64_json`
 * or `url`, with the same rules for where an address may lead, the same check
 * of the bytes and the same limits. Other request shapes are not translated.
 *
 * Several pictures are sent as `image[]`, once each in the order given, only to
 * an endpoint the person said takes them (see ImageEditingTarget.multiple); one
 * picture is always sent as `image`. The same request makes a new picture from
 * pictures used as references: the route does not tell the two apart, the
 * prompt does.
 *
 * What the agent's tool and the Media page share is here: the checked request
 * and the picture that comes back. Nothing is written by it; where the result
 * goes is the caller's business, and a request that failed has left nothing
 * anywhere.
 */

/** Where the request goes: the base, with the route the OpenAI-style APIs have unless it is already there. */
export function editEndpointUrl(baseUrl: string): URL {
  const url = new URL(baseUrl);
  // The address of generation is taken as it stands, so its route is swapped for this one.
  const base = url.pathname.replace(/\/+$/, "").replace(/\/images\/(generations|edits)$/, "");
  url.pathname = `${base}/images/edits`;
  return url;
}

/** How many pictures one edit takes, and how much they weigh together: set in image-settings.ts, which the page reads too. A heavier set is scaled down to fit. */
export { MAX_EDIT_PICTURES, MAX_EDIT_TOTAL_BYTES };

export interface EditRequest {
  /** What should change, or what a new picture should be made of the pictures. */
  prompt: string;
  /**
   * The picture to change. Its type is read from its bytes. A list is several
   * pictures, in the order the prompt refers to them; the endpoint must be one
   * that takes them, and the mask, where there is one, goes with the first.
   */
  image: Buffer | Buffer[];
  /** Marks the area to change, where the endpoint takes one. Checked as a picture; its size must match the picture's, which the endpoint tells. */
  mask?: Buffer;
  /** Instead of the model set for editing, for the Media page: the agent's tool has the saved one only. */
  model?: string;
  /** What the result comes out as, `1024x1024`; not sent without it, since the endpoint's own is usually the picture's. */
  size?: string;
  /** Sent as `output_format`, and `output_compression` with it. */
  outputFormat?: OutputFormat;
  outputCompression?: number;
  /** Not in the OpenAI format: put in the prompt as stable-diffusion.cpp's server reads them, and only where one is set. */
  native?: NativeSettings;
  /**
   * The pictures are a new picture's references, not pictures to change: what is said of them names them so
   * ("Reference 2", "The reference"), and a note of one that was scaled down says nothing of a result scaled back.
   */
  references?: boolean;
}

export interface EditOptions extends GenerateOptions {
  /** The most each picture and the mask may be; the same limit the Files panel shows a picture up to by default. */
  maxInputBytes?: number;
  /** The most the pictures may be together. */
  maxTotalBytes?: number;
}

const MB = 1024 * 1024;
/** A weight as a person reads it: whole megabytes, or kilobytes where it is under one. */
const weight = (bytes: number): string => (bytes >= MB ? `${Math.round(bytes / MB)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

/** A picture to send, with what it was and what was done to make it fit. */
interface Item {
  /** Starts the sentence that says what is wrong with it or what was done to it. */
  who: string;
  name: string;
  bytes: Buffer;
  /** What it was when it was given: the size is undefined where its header has none to read. */
  was: { size?: { width: number; height: number }; bytes: number };
  /** Its size once it was scaled, as the scaling made it; its own header's where it was not. */
  size?: { width: number; height: number };
}

const advice = "Nothing was sent. Use another picture, or tell the person.";

/** `2048x1024` as the pair of numbers, or none where no maximum is set. */
function boxOf(maxSize: string): { width: number; height: number } | undefined {
  const [width, height] = (maxSize || "x").split("x").map(Number);
  return width && height ? { width, height } : undefined;
}

/** The sentence that says a picture was made smaller: one of an edit's, or a new picture's reference (`reference`), whose result was never its size. */
function scaledNote(item: Item, reference: boolean): string {
  const now = { size: item.size, bytes: item.bytes.length };
  const px = (size?: { width: number; height: number }) => (size ? `${size.width}x${size.height} pixels` : "unknown size");
  const resized = item.was.size && now.size && (item.was.size.width !== now.size.width || item.was.size.height !== now.size.height);
  const how = resized ? `scaled down from ${px(item.was.size)} (${weight(item.was.bytes)}) to ${px(now.size)} (${weight(now.bytes)})` : `compressed from ${weight(item.was.bytes)} to ${weight(now.bytes)}`;
  return reference ? `${item.who} was ${how} to fit what the editing endpoint takes.` : `${item.who} was ${how} to fit what an edit takes. The result is not scaled back up.`;
}

/** What each of the pictures may weigh: all of `total` shared out evenly, where a light one leaves its room to the heavier ones, and none more than `max`. */
function budgets(weights: number[], max: number, total: number): number[] {
  const out: number[] = [];
  let left = total;
  [...weights.keys()]
    .sort((a, b) => weights[a] - weights[b])
    .forEach((i, k, order) => {
      out[i] = Math.min(max, Math.floor(left / (order.length - k)));
      left -= Math.min(weights[i], out[i]);
    });
  return out;
}

/** Runs one scaling step on a picture and keeps what it made; when it cannot be done, says which picture it was for. */
async function apply(item: Item, step: () => Promise<Scaled>, changed: Set<Item>): Promise<void> {
  try {
    const out = await step();
    item.bytes = out.bytes;
    item.size = out.size;
    changed.add(item);
  } catch (e) {
    if (e instanceof CannotFit) throw new ImageGenerationError(`${item.who} cannot be made to fit an edit: ${e.message}. ${advice}`);
    throw e;
  }
}

/**
 * Makes the pictures (and the mask) fit what an edit takes, and says what was done. One with more pixels than the
 * maximum for an edit (`maxSize`, such as `2048x1024`; empty is none) is scaled down to fit it, either way up, with
 * its ratio kept and nothing cut; the pictures that weigh more than `max` each, or `total` together, are then made
 * lighter, the heaviest first (see picture-scale.ts). The mask is scaled with the first picture to the same size,
 * taking the nearest pixel, so that it stays a mask. Nothing is ever scaled up, and what fits is not touched.
 *
 * A picture whose size cannot be read cannot be shown to be within the maximum, and is refused. So is one that cannot
 * be made to fit at all; the person is told, and nothing is sent.
 */
async function fit(pictures: Item[], mask: Item | undefined, maxSize: string, max: number, total: number, references: boolean): Promise<string[]> {
  const box = boxOf(maxSize);
  const changed = new Set<Item>();
  if (box) {
    for (const item of [...pictures, ...(mask ? [mask] : [])]) {
      const size = item.was.size;
      if (!size) {
        throw new ImageGenerationError(
          `${item.who} has a size that cannot be read, so it cannot be shown to be within the maximum of ${box.width}x${box.height} pixels for an edit. ${advice} The limit is set under Media in Settings.`,
        );
      }
      // The mask is scaled with the first picture, below: its size is the picture's, whatever that comes to.
      if (item === mask || fitsBox(size, box.width, box.height)) continue;
      await apply(item, () => scaleToBox(item.bytes, box.width, box.height), changed);
    }
  }
  // Heavy ones next: the pictures share what an edit takes together, the mask has its own limit.
  const room = budgets(pictures.map((p) => p.bytes.length), max, total);
  for (const [i, item] of pictures.entries()) {
    if (item.bytes.length <= room[i]) continue;
    await apply(item, () => fitBytes(item.bytes, room[i]), changed);
  }
  if (mask) {
    const first = pictures[0];
    const sizeNow = first.size ?? first.was.size;
    // Scaled with the picture only where it was the picture's size: another size is the endpoint's to refuse, as it always was.
    const same = (a?: { width: number; height: number }, b?: { width: number; height: number }) => Boolean(a && b && a.width === b.width && a.height === b.height);
    if (same(mask.was.size, first.was.size) && sizeNow && !same(sizeNow, first.was.size)) {
      await apply(mask, () => scaleTo(mask.bytes, sizeNow, true), changed);
    } else if (box && !fitsBox(mask.was.size!, box.width, box.height)) {
      await apply(mask, () => scaleToBox(mask.bytes, box.width, box.height, true), changed);
    }
    if (mask.bytes.length > max) {
      await apply(mask, () => fitBytes(mask.bytes, max, true), changed);
    }
  }
  return [...changed].map((item) => scaledNote(item, references));
}

/** A picture as it is given: what its first bytes say it is, and nothing more asked of it yet. `who` starts the sentence that says what is wrong with it. */
function given(bytes: Buffer, who: string, name: string): Item {
  const type = pictureType(bytes.subarray(0, 12));
  if (!type) throw new ImageGenerationError(`${who} is not a PNG, JPEG, GIF or WebP picture`);
  return { who, name, bytes, was: { size: pictureSize(bytes), bytes: bytes.length } };
}

/** A picture to send: never the file's own name, which says where it came from, but a neutral one with the extension its bytes say. */
function toSend(item: Item): { blob: Blob; name: string } {
  const head = item.bytes.subarray(0, 12);
  return { blob: new Blob([item.bytes as Uint8Array<ArrayBuffer>], { type: pictureType(head) }), name: `${item.name}.${pictureExt(head)}` };
}

/** Refuses a count of pictures the endpoint is not said to take, or one longer than an edit takes. */
export function checkCount(count: number, multiple: boolean): void {
  if (count < 1) throw new ImageGenerationError("There is no picture to change");
  if (count > 1 && !multiple) {
    throw new ImageGenerationError(
      `The editing endpoint is not set up to take several pictures, so none was sent (${count} were given). Use one, or tell the person that "Several pictures per edit" can be switched on under Media in Settings if the endpoint takes them.`,
    );
  }
  if (count > MAX_EDIT_PICTURES) throw new ImageGenerationError(`An edit takes at most ${MAX_EDIT_PICTURES} pictures, and ${count} were given`);
}

/**
 * Asks for a picture changed and returns the result, checked as a generated
 * one is: a PNG, JPEG, GIF or WebP by its first bytes, and not too large.
 *
 * A picture that is no picture is refused before anything is sent, so that
 * nothing leaves the portal that should not. One beyond the maximum size of the
 * editing settings, or too heavy for an edit, is scaled down to fit and sent
 * so (see `fit`), and `notes` says what was done to which, for the person or
 * the agent to be told; one that cannot be made to fit is refused. With
 * several, one that is refused refuses them all: the prompt refers to them by
 * their place in the list, which a result made of the others would not match.
 * A size is sent only when the request has one: what an edit comes out as is
 * the endpoint's to say, usually the picture's own, and the size set for
 * generation need not be one an edit takes.
 */
export async function editImage(
  target: ImageEditingTarget,
  request: EditRequest,
  options: EditOptions = {},
): Promise<{ bytes: Buffer; ext: string; notes: string[] }> {
  const max = options.maxInputBytes ?? MAX_PICTURE_BYTES;
  const list = Array.isArray(request.image) ? request.image : [request.image];
  checkCount(list.length, target.multiple);
  // What they are first, all of them, so that a picture that is no picture is refused before any is scaled.
  const [one, each] = request.references ? ["The reference", "Reference"] : ["The image", "Picture"];
  const pictures = list.map((bytes, i) => (list.length > 1 ? given(bytes, `${each} ${i + 1}`, `image-${i + 1}`) : given(bytes, one, "image")));
  const maskItem = request.mask ? given(request.mask, "The mask", "mask") : undefined;
  const notes = await fit(pictures, maskItem, target.maxSize, max, options.maxTotalBytes ?? MAX_EDIT_TOTAL_BYTES, request.references === true);
  const images = pictures.map(toSend);
  const mask = maskItem ? toSend(maskItem) : undefined;
  const form = new FormData();
  // One picture as the first OpenAI-style endpoints took it; several as the list form, once each, in order.
  for (const image of images) form.append(images.length > 1 ? "image[]" : "image", image.blob, image.name);
  if (mask) form.append("mask", mask.blob, mask.name);
  // As for generation: nothing that only stable-diffusion.cpp reads goes while the switch for it is off.
  form.append("prompt", promptWith(request.prompt, target.sdExtras ? (request.native ?? {}) : {}));
  const model = request.model || target.model;
  if (model) form.append("model", model);
  form.append("n", "1");
  if (request.size) form.append("size", request.size);
  if (request.outputFormat) form.append("output_format", request.outputFormat);
  if (request.outputCompression !== undefined) form.append("output_compression", String(request.outputCompression));
  // The time limit is the one of generation: the picture goes up first, and then the endpoint makes the new one.
  const result = await requestPicture(editEndpointUrl(target.baseUrl), target.apiKey, form, { timeoutMs: target.timeoutSeconds * 1000, ...options });
  return { ...result, notes };
}
