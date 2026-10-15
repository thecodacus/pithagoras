import { formatDate, session, t } from "./portal";

/**
 * A timestamp the server wrote: UTC, with or without a zone marker, with a
 * "T" or a space, which Date would otherwise read as local time.
 */
const serverTime = (iso: string): Date => new Date(/(?:Z|[+-]\d\d:?\d\d)$/i.test(iso) ? iso : `${iso.replace(" ", "T")}Z`);

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

/** "5m ago", from a timestamp the server wrote; what cannot be read is shown as it is. */
export const when = (iso: string): string => sinceThen(serverTime(iso)) || iso;

/** Where `where` is below the folder `dir`, as a path from it: "" for the folder itself, undefined for outside it. */
export function below(dir: string, where: string): string | undefined {
  const base = dir.replace(/\/+$/, "");
  if (where === base) return "";
  return where.startsWith(base + "/") ? where.slice(base.length + 1) : undefined;
}

type KeyEvent = { key: string; keyCode?: number; nativeEvent?: { isComposing?: boolean }; isComposing?: boolean };

/**
 * Enter that means "done", not Enter that picks a word: with an input method,
 * Enter first confirms the candidate being composed, and Safari reports that
 * keydown after composition has ended, as keyCode 229.
 */
export const isEnter = (e: KeyEvent): boolean => e.key === "Enter" && !(Boolean(e.nativeEvent?.isComposing ?? e.isComposing) || e.keyCode === 229);

/** A link from GitHub, when it goes to a web page: never one that runs script. */
export function webLink(url: string | undefined): string | undefined {
  return url && /^https?:\/\//i.test(url.trim()) ? url.trim() : undefined;
}

const DRAFT = "pithagoras.git-draft.";
const drafts = new Map<string, string>();

/**
 * What is typed in the panel and not yet used (a commit message, a pull
 * request's body), by what it is for: held in memory, and in the tab's session
 * storage so a reload keeps it. The portal kept these under the same names.
 */
export const gitDrafts = {
  get: (key: string): string => drafts.get(key) ?? session.get(DRAFT + key) ?? "",
  set(key: string, text: string): void {
    if (text) {
      drafts.set(key, text);
      session.set(DRAFT + key, text);
    } else {
      drafts.delete(key);
      session.remove(DRAFT + key);
    }
  },
};
