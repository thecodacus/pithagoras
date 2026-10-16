/**
 * Files a tool call gave the person: a picture it showed or made, a clip, a
 * report it wrote. Any tool says so the same way, the portal's own and an
 * extension's alike: its answer's `details` has `files`, a list of paths in
 * the chat's folder, each with a title if it has one, and the files it was
 * made from (`from`), when it is a changed copy of one.
 *
 *     return { content: [{ type: "text", text: "Saved chart.png" }], details: { files: [{ path: "chart.png", title: "Sales" }] } };
 *
 * Everything else in a call's answer is text. A file is not taken for what its
 * name or the tool says it is: when the call ends, the portal looks at its
 * bytes, as it does a picture it serves (see output-files.ts), and puts what it
 * found on the end of the call, under FILES_KEY. The page draws each by that
 * (a picture, a player, or a link to download it), voice mode shows the
 * pictures, and a channel sends them on. One that is not in the folder, or not
 * a file, is left out.
 *
 * In a module of its own, with nothing it imports, so that the page reads the
 * calls with the same code as the server.
 */

/** Where the portal puts what it found of a call's files, on the event that ends the call. */
export const FILES_KEY = "portalFiles";

/** What a file is by its bytes: a picture a browser draws, a clip it plays, or any other file. */
export type FileKind = "picture" | "video" | "file";

/** A file as a tool's `details.files` names it. */
export interface FileOutput {
  /** Relative to the chat's folder, or absolute inside it. */
  path: string;
  title?: string;
  /** The files it was made from, as paths in the chat's folder: an edited picture's original. */
  from?: string[];
}

/** A file a call gave, as the portal found it when the call ended: `path` and `from` relative to the chat's folder. */
export interface ShownFile {
  path: string;
  kind: FileKind;
  title?: string;
  from?: string[];
}

const KINDS: readonly string[] = ["picture", "video", "file"];
const text = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);
const paths = (v: unknown): string[] | undefined => {
  const list = Array.isArray(v) ? v.filter((p): p is string => !!text(p)) : [];
  return list.length ? list : undefined;
};

/** The files a tool's `details` names, in its order; nothing for details that name none. */
export function fileOutputs(details: unknown): FileOutput[] {
  const files = (details as { files?: unknown } | null | undefined)?.files;
  if (!Array.isArray(files)) return [];
  return files.flatMap((file): FileOutput[] => {
    const path = text(file?.path);
    if (!path) return [];
    const title = text(file.title)?.trim().replace(/\s+/g, " ").slice(0, 120);
    const from = paths(file.from);
    return [{ path, ...(title ? { title } : {}), ...(from ? { from } : {}) }];
  });
}

/** What the portal found of a call's files, from the event that ended it: nothing for a call that gave none. */
export function shownFiles(payload: any): ShownFile[] {
  const found = payload?.[FILES_KEY];
  if (!Array.isArray(found)) return [];
  return found.flatMap((file): ShownFile[] => {
    const path = text(file?.path);
    if (!path || !KINDS.includes(file.kind)) return [];
    const title = text(file.title);
    const from = paths(file.from);
    return [{ path, kind: file.kind, ...(title ? { title } : {}), ...(from ? { from } : {}) }];
  });
}
