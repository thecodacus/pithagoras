import type { PromptImage } from "./api";

import { t } from "./i18n";
/**
 * Pictures and files that go with a message from the box.
 *
 * A picture goes to the model with the message. Anything else is put in the
 * chat's folder and named in the message, which is how the agent reads a file
 * anyway — it has the tools for a PDF or a spreadsheet, the model does not.
 */

/** What the server takes, and so what is offered: see server/src/prompt-images.ts. */
export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
export const MAX_IMAGES = 8;
/** The server's limit per picture, with room for rounding. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024 - 64 * 1024;
/**
 * The longest side a picture is sent at. Models scale larger ones down on
 * their side anyway, so the pixels above this are paid for in upload time and
 * context without being seen.
 */
export const MAX_EDGE = 2048;

export interface Attachment extends PromptImage {
  /** For the list in the box, and taking one back out of it. */
  id: string;
  name: string;
}

/** Whether a file is a picture that can go to the model as one. */
export const isImage = (type: string): boolean => IMAGE_TYPES.includes(type);

/** `width` × `height` made to fit within `max` on its longer side, keeping its shape. */
export function fitWithin(width: number, height: number, max = MAX_EDGE): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= max) return { width, height };
  const scale = max / longest;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/**
 * Whether a picture has to be redrawn before it goes: too many pixels, too many
 * bytes. A GIF is sent as it is or not at all, since redrawing it would stop it
 * moving.
 */
export function needsShrinking(type: string, bytes: number, width: number, height: number): boolean {
  if (type === "image/gif") return false;
  return bytes > MAX_IMAGE_BYTES || Math.max(width, height) > MAX_EDGE;
}

/** The files among `list` that are pictures, and the rest. */
export function sortFiles(list: Iterable<File>): { images: File[]; others: File[] } {
  const images: File[] = [];
  const others: File[] = [];
  for (const file of list) (isImage(file.type) ? images : others).push(file);
  return { images, others };
}

/**
 * The line a message gets for files that were put in the folder, so the agent
 * knows they are there and what they are called.
 */
export function uploadedNote(paths: string[]): string {
  if (!paths.length) return "";
  const names = paths.map((p) => `\`${p}\``);
  return paths.length === 1 ? `(I put ${names[0]} in the folder.)` : `(I put these in the folder: ${names.join(", ")}.)`;
}

const readAsDataUrl = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error(t("Could not read the picture")));
    reader.readAsDataURL(blob);
  });

/** A blob's bytes as base64, the part of its data URL after the comma; a failed read is the browser's own error. */
export const blobBase64 = async (blob: Blob): Promise<string> => (await readAsDataUrl(blob)).split(",")[1] ?? "";

let counter = 0;

/**
 * A picture made ready to send: as it is when it already fits, redrawn smaller
 * when it does not. A redrawn one is a JPEG on white — a screenshot's
 * transparency means nothing to a model, and a PNG of a photo is five times the
 * size.
 */
export async function prepareImage(file: Blob, name = "image"): Promise<Attachment> {
  if (!isImage(file.type)) throw new Error(t("{name} is not a PNG, JPEG, GIF or WebP picture", { name }));
  const id = `att${++counter}`;
  const bitmap = await createImageBitmap(file).catch(() => {
    throw new Error(t("{name} could not be read as a picture", { name }));
  });
  try {
    if (!needsShrinking(file.type, file.size, bitmap.width, bitmap.height)) {
      if (file.size > MAX_IMAGE_BYTES) throw new Error(t("{name} is over 5 MB", { name }));
      return { id, name, mimeType: file.type, data: await readAsDataUrl(file) };
    }
    const size = fitWithin(bitmap.width, bitmap.height);
    const canvas = document.createElement("canvas");
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error(t("{name} could not be made smaller", { name }));
    context.fillStyle = "#fff";
    context.fillRect(0, 0, size.width, size.height);
    context.drawImage(bitmap, 0, 0, size.width, size.height);
    for (const quality of [0.88, 0.75, 0.6]) {
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
      if (blob && blob.size <= MAX_IMAGE_BYTES) return { id, name, mimeType: "image/jpeg", data: await readAsDataUrl(blob) };
    }
    throw new Error(t("{name} is too large, even made smaller", { name }));
  } finally {
    bitmap.close();
  }
}

/** A picture already sent, fetched back to go with a message again. */
export async function refetchImage(url: string, name: string): Promise<Attachment> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(t("{name} is no longer there", { name }));
  return prepareImage(await res.blob(), name);
}

/**
 * Pictures waiting in each chat's box. Like the words, they belong to the chat
 * they were added in, and are there again on coming back. Only in memory: a
 * handful of pictures is more than session storage holds.
 *
 * The box and voice mode share them: a picture pasted in either goes with the
 * next message, typed or said, and shows in both. `subscribe` is how each
 * hears of the other's changes.
 */
export function createPending() {
  const byChat = new Map<string, Attachment[]>();
  // Pictures being made ready, by chat, which count against its room already.
  const preparing = new Map<string, number>();
  const listeners = new Set<(id: string) => void>();
  const get = (id: string): Attachment[] => byChat.get(id) ?? [];
  const set = (id: string, list: Attachment[]): void => {
    if (list.length) byChat.set(id, list);
    else byChat.delete(id);
    for (const listener of listeners) listener(id);
  };
  return {
    get,
    set,
    subscribe(listener: (id: string) => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    /**
     * Pictures made ready and put in chat `id`'s box, as many as there is room
     * for. Room is taken as it is counted, so two quick pastes cannot both
     * take the last places. What went wrong is returned, to be shown.
     */
    async add(id: string, files: File[], prepare: (file: File) => Promise<Attachment> = (file) => prepareImage(file, file.name || t("Pasted picture"))): Promise<string[]> {
      const problems: string[] = [];
      const room = Math.max(0, MAX_IMAGES - get(id).length - (preparing.get(id) ?? 0));
      const taking = Math.min(files.length, room);
      if (files.length > room) problems.push(t("At most {n} pictures can go with one message.", { n: MAX_IMAGES }));
      preparing.set(id, (preparing.get(id) ?? 0) + taking);
      try {
        const ready: Attachment[] = [];
        for (const file of files.slice(0, taking)) {
          try {
            ready.push(await prepare(file));
          } catch (e) {
            problems.push((e as Error).message);
          }
        }
        // Into the chat they were added in, even if another has been opened since.
        if (ready.length) set(id, [...get(id), ...ready]);
      } finally {
        preparing.set(id, (preparing.get(id) ?? 0) - taking);
      }
      return problems;
    },
  };
}

export const pending = createPending();
