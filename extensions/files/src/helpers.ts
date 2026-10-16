/**
 * Small helpers the portal has for itself and Files needs as well: an
 * extension draws on the portal's interface, not on its code.
 */

/** `where` as a path under `dir`, "" for `dir` itself, or undefined when it is somewhere else: by the text of the paths. */
export function below(dir: string, where: string): string | undefined {
  const base = dir.replace(/\/+$/, "");
  if (where === base) return "";
  return where.startsWith(base + "/") ? where.slice(base.length + 1) : undefined;
}

/** `where` is the folder `dir` or inside it, by the text of the path. */
export const within = (dir: string, where: string): boolean => below(dir, where) !== undefined;

/**
 * `given`, as the agent wrote it (relative to where it works, or absolute), as
 * a path inside `folder`, or undefined when it is somewhere else.
 */
export function insideFolder(folder: string, given: string): string | undefined {
  let text = given;
  if (text.startsWith("/")) {
    const under = below(folder, text);
    if (under === undefined) return undefined;
    text = under;
  }
  const parts: string[] = [];
  for (const part of text.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (!parts.pop()) return undefined;
    } else parts.push(part);
  }
  return parts.length ? parts.join("/") : undefined;
}

export function bytesLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

/** A React event carries it on `nativeEvent`, a DOM one on itself. */
type KeyEvent = { key: string; keyCode?: number; nativeEvent?: { isComposing?: boolean }; isComposing?: boolean };

/** An input method has the key: composing, or Safari's keydown just after it ended (keyCode 229). */
const isComposing = (e: KeyEvent): boolean => Boolean(e.nativeEvent?.isComposing ?? e.isComposing) || e.keyCode === 229;

/** Enter that means "done", not Enter that picks a word in an input method. */
export const isEnter = (e: KeyEvent): boolean => e.key === "Enter" && !isComposing(e);

/** Escape that means "never mind", not Escape that dismisses an input method's candidates. */
export const isEscape = (e: KeyEvent): boolean => e.key === "Escape" && !isComposing(e);
