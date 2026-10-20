import { insideFolder } from "./helpers";

/**
 * What the page knows of a picture that is being made, before it exists: from
 * the call the agent made, for the preview that holds its place (see
 * PictureCall.tsx).
 */

/**
 * Narrowest and widest a preview is drawn: past that a picture is shown whole in a
 * frame of this shape, not cropped, so that no frame is a sliver.
 */
const NARROWEST = 0.4;
const WIDEST = 3;

/** Width over height for a frame, from the sizes in pixels of a request. */
function shapeOf(width: number, height: number): number | undefined {
  if (!(width > 0) || !(height > 0)) return undefined;
  return Math.min(WIDEST, Math.max(NARROWEST, width / height));
}

/** The shape of a size as the agent asks for it ("1024x768"); nothing for "auto", for none, and for what is no size. */
export function sizeRatio(size: unknown): number | undefined {
  const m = typeof size === "string" ? /^\s*(\d{2,5})x(\d{2,5})\s*$/i.exec(size) : null;
  return m ? shapeOf(Number(m[1]), Number(m[2])) : undefined;
}

export interface PictureCall {
  /** An edit of a picture, not a new picture. */
  edit: boolean;
  /** What it is of, on one line: the title the agent gave, or else the prompt. */
  title: string;
  /** Width over height, when the call says what shape the picture will have: the size asked for. */
  ratio?: number;
  /** An edit's original — the first of several — as a path in the chat's folder, for the page to show while the edit is made. */
  original?: string;
}

const text = (v: unknown): string => (typeof v === "string" ? v : "");
const oneLine = (s: string, n: number): string => {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
};

/** The call as the agent made it: `name` is its tool, `input` its parameters, `folder` the chat's. */
export function pictureCall(name: string, input: Record<string, unknown>, folder: string): PictureCall {
  const edit = name === "edit_image";
  // With the endpoint taking several, `paths` is a list, in the order the prompt refers to them; the result is named after the first, which is the one shown.
  const first = Array.isArray(input.paths) ? input.paths[0] : input.path;
  const original = edit && text(first) ? insideFolder(folder, text(first)) : undefined;
  const ratio = edit ? undefined : sizeRatio(input.size);
  return { edit, title: oneLine(text(input.title) || text(input.prompt), 120), ...(ratio ? { ratio } : {}), ...(original ? { original } : {}) };
}

/** What went wrong, from the text a failed call gave back, kept to a few lines' worth: the whole of it is in the call's details. */
export function failureReason(output: string | undefined): string {
  return oneLine(output ?? "", 240);
}
