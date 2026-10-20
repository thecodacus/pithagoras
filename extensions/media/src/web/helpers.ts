import { formatDate, t } from "../portal";

/**
 * Small helpers the portal has for itself and Media needs as well: an
 * extension draws on the portal's interface, not on its code.
 */

export function bytesLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

/**
 * "5m ago": how long since `then`, in the language shown. Past `dateAfterDays`
 * it is the date instead (`dateFormat`), where a count of days says less.
 */
export function sinceThen(
  then: Date | number,
  { dateAfterDays = Infinity, dateFormat }: { dateAfterDays?: number; dateFormat?: Intl.DateTimeFormatOptions } = {},
): string {
  const at = +then;
  const mins = Math.round((Date.now() - at) / 60000);
  if (!Number.isFinite(mins)) return "";
  if (mins < 1) return t("just now");
  if (mins < 60) return t("{n}m ago", { n: mins });
  if (mins < 1440) return t("{n}h ago", { n: Math.round(mins / 60) });
  if (mins >= 1440 * dateAfterDays) return formatDate(at, dateFormat);
  return t("{n}d ago", { n: Math.round(mins / 1440) });
}

/** A React event carries it on `nativeEvent`, a DOM one on itself. */
type KeyEvent = { key: string; keyCode?: number; nativeEvent?: { isComposing?: boolean }; isComposing?: boolean };

/** An input method has the key: composing, or Safari's keydown just after it ended (keyCode 229). */
const isComposing = (e: KeyEvent): boolean => Boolean(e.nativeEvent?.isComposing ?? e.isComposing) || e.keyCode === 229;

/** Enter that means "done", not Enter that picks a word in an input method. */
export const isEnter = (e: KeyEvent): boolean => e.key === "Enter" && !isComposing(e);

/** Escape that means "never mind", not Escape that dismisses an input method's candidates. */
export const isEscape = (e: KeyEvent): boolean => e.key === "Escape" && !isComposing(e);

/**
 * Calls `tick` every `ms` while the page is on screen, and stops while it is
 * not: coming back, it asks at once and then carries on. Returns what stops it.
 */
export function pollWhileVisible(tick: () => void, ms: number): () => void {
  let timer: ReturnType<typeof setInterval> | null = null;
  const start = () => {
    if (timer === null) timer = setInterval(tick, ms);
  };
  const stop = () => {
    if (timer !== null) clearInterval(timer);
    timer = null;
  };
  const onChange = () => {
    if (document.hidden) return stop();
    tick();
    start();
  };
  document.addEventListener("visibilitychange", onChange);
  if (!document.hidden) start();
  return () => {
    document.removeEventListener("visibilitychange", onChange);
    stop();
  };
}

/** The pictures the portal takes, and so what is offered: PNG, JPEG, GIF and WebP. */
export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

/** The files among `list` that are pictures, and the rest. */
export function sortFiles(list: Iterable<File>): { images: File[]; others: File[] } {
  const images: File[] = [];
  const others: File[] = [];
  for (const file of list) (IMAGE_TYPES.includes(file.type) ? images : others).push(file);
  return { images, others };
}

/** A blob's bytes as base64, the part of its data URL after the comma; a failed read is the browser's own error. */
export const blobBase64 = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(reader.error ?? new Error(t("Could not read the picture")));
    reader.readAsDataURL(blob);
  });

/** `where` as a path under `dir`, "" for `dir` itself, or undefined when it is somewhere else: by the text of the paths. */
function below(dir: string, where: string): string | undefined {
  const base = dir.replace(/\/+$/, "");
  if (where === base) return "";
  return where.startsWith(base + "/") ? where.slice(base.length + 1) : undefined;
}

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

/** The place in a list `by` steps from `index`, or undefined at either end: it does not go round. */
export function stepped(index: number, length: number, by: 1 | -1): number | undefined {
  const to = index + by;
  return to >= 0 && to < length ? to : undefined;
}

/** Text without the colour and cursor codes a terminal would act on. */
export const stripAnsi = (text: string) => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
