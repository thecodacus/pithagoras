import { session } from "./portal";

/** A file in Files with changes not saved, and what they were made on. */
export interface FileDraft {
  path: string;
  /** What is in the editor. */
  text: string;
  /** What the file held when it was read: the edit is measured against it. */
  saved: string;
  /** The file's modification time then: what a save is checked against. */
  mtime: number;
  size: number;
  /** Whether the file was shown as the source because it is to be written in; a draft kept before this was known has none. */
  writing?: boolean;
}

/**
 * Held in memory and mirrored to session storage, so a reload does not lose an
 * edit either. Under the keys the portal's own Files kept them by, so an edit
 * left from before Files was an extension comes back too.
 */
const PREFIX = "pithagoras.file-draft.";
const memory = new Map<string, string>();
const store = {
  get: (chat: string): string => memory.get(chat) ?? session.get(PREFIX + chat) ?? "",
  set: (chat: string, text: string): void => {
    if (text) {
      memory.set(chat, text);
      session.set(PREFIX + chat, text);
    } else {
      memory.delete(chat);
      session.remove(PREFIX + chat);
    }
  },
};
/** The latest edit of each chat that is not written yet: a file can be a megabyte, and a keystroke is not worth writing one. */
const waiting = new Map<string, { draft: FileDraft; timer: ReturnType<typeof setTimeout> }>();
const WAIT_MS = 400;

const valid = (d: unknown): d is FileDraft => {
  const x = d as Partial<FileDraft> | null;
  return !!x && typeof x.path === "string" && typeof x.text === "string" && typeof x.saved === "string" && typeof x.mtime === "number" && typeof x.size === "number" && (x.writing === undefined || typeof x.writing === "boolean");
};

/**
 * The edit a chat's Files panel was left with. The panel is unmounted when the
 * chat is switched or left, and an edit that went with it was lost without the
 * question closing the panel asks.
 */
export function readFileDraft(chat: string): FileDraft | null {
  const pending = waiting.get(chat);
  if (pending) return pending.draft;
  try {
    const d = JSON.parse(store.get(chat) || "null");
    return valid(d) ? d : null;
  } catch {
    return null;
  }
}

/** Keeps the edit, a moment after the last change; `null` forgets it at once. */
export function keepFileDraft(chat: string, draft: FileDraft | null): void {
  clearTimeout(waiting.get(chat)?.timer);
  waiting.delete(chat);
  if (!draft) return store.set(chat, "");
  waiting.set(chat, { draft, timer: setTimeout(() => flushFileDraft(chat), WAIT_MS) });
}

/** The edit was given up on purpose: the panel is closed after "Discard", and nothing is to be brought back. */
export const forgetFileDraft = (chat: string): void => keepFileDraft(chat, null);

/** Writes what is waiting now: the panel is going away, or the page is. */
export function flushFileDraft(chat: string): void {
  const pending = waiting.get(chat);
  if (!pending) return;
  clearTimeout(pending.timer);
  waiting.delete(chat);
  store.set(chat, JSON.stringify(pending.draft));
}

/** What is waiting written as the page goes. Returns the way to stop, for the extension taken out. */
export function flushOnLeave(): () => void {
  const leave = () => [...waiting.keys()].forEach(flushFileDraft);
  window.addEventListener("pagehide", leave);
  return () => window.removeEventListener("pagehide", leave);
}
