import { api } from "./api";
import { session, type SafeStorage } from "./safe-storage";

const PREFIX = "pithagoras.draft.";

/**
 * What has been typed into each chat's message box and not yet sent.
 *
 * The box is one component for every chat, so without this whatever was half
 * written in one followed you into the next — and could be sent there. Held in
 * memory, and mirrored to session storage so that a reload does not lose it
 * either; a browser that will not store it still keeps drafts while the page
 * is open.
 *
 * `tell` hears each change, for the portal: an extension can ask what is in
 * the box. `prefix` keeps one store's entries apart from another's.
 */
export function createDrafts(store: SafeStorage = session, tell?: (id: string, text: string) => void, prefix = PREFIX) {
  const memory = new Map<string, string>();
  return {
    get(id: string): string {
      return memory.get(id) ?? store.get(prefix + id) ?? "";
    },
    set(id: string, text: string): void {
      if (text) {
        memory.set(id, text);
        store.set(prefix + id, text);
      } else {
        memory.delete(id);
        store.remove(prefix + id);
      }
      tell?.(id, text);
    },
    /** The cursor moved in a chat's box: told again, with where it is now. */
    moved(id: string): void {
      const text = this.get(id);
      if (text) tell?.(id, text);
    },
  };
}

/** Where a chat's cursor is, told with its text: the chat box says, for the chat it shows. */
let caretOf: (id: string) => { start: number; end: number } | undefined = () => undefined;
export function caretFrom(read: typeof caretOf): void {
  caretOf = read;
}

/**
 * The chats whose pi is up, as their background list last said: only then can
 * an extension ask what is in the box. Told of every pause and cursor move
 * otherwise, the portal kept text nothing would read.
 */
const piUp = new Set<string>();

/**
 * The portal told what is in a chat's box once typing pauses. Emptied — sent,
 * most often — at once, ahead of the message: a command that read the box
 * would otherwise find itself in it.
 */
function tellPortal(): (id: string, text: string) => void {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const send = (id: string, text: string) => void api.draft(id, text, text ? caretOf(id) : undefined).catch(() => {});
  return (id, text) => {
    clearTimeout(timers.get(id));
    timers.delete(id);
    if (!piUp.has(id)) return;
    if (!text) send(id, text);
    else timers.set(id, setTimeout(() => (timers.delete(id), send(id, text)), 300));
  };
}

export const drafts = createDrafts(session, tellPortal());

/**
 * What is typed into the Git panel and not yet sent: a commit message, a pull
 * request being opened, a comment. Kept apart from the message box's drafts, and
 * never told to the portal: no extension reads them.
 */
export const gitDrafts = createDrafts(session, undefined, "pithagoras.git-draft.");

/** Whether a chat's pi is up. Once it is, what is in the box is told at once: it may have been typed before. */
export function piRunning(id: string, up: boolean): void {
  if (up === piUp.has(id)) return;
  if (!up) {
    piUp.delete(id);
    return;
  }
  piUp.add(id);
  drafts.moved(id);
}

/**
 * A message that did not go, back in front of whatever has been typed since.
 *
 * Put back rather than lost; and put before rather than over, so nothing typed
 * while it was on its way is thrown away either.
 */
export function withUnsent(current: string, unsent: string): string {
  return current.trim() ? `${unsent}\n${current}` : unsent;
}
