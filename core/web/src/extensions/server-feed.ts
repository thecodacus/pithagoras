import { failedIn } from "./loader";

/**
 * What an extension's server half tells the pages open on a chat, passed from
 * the chat's event stream to the extension's browser half. The server's side
 * of it is `portal.chats.send` and `portal.chats.onOpen` in extension-host.ts.
 *
 * A page's stream opens, and says where things stand, before the extensions'
 * modules are in the page. So what comes for an extension that is not there
 * yet waits for it, and is handed over, in order, once its module has been
 * called: a module that listens as it is called misses nothing.
 */

type Handler = (chatId: string, data: unknown) => void;

const handlers = new Map<string, Set<Handler>>();
const waiting = new Map<string, [string, unknown][]>();
const here = new Set<string>();
/** No more than this waits for one extension: one that never comes must not hold the page's memory. */
const WAITING_MOST = 500;

/** Something a server half said to its browser half on a chat's page. */
export function serverPush(chatId: string, extension: string, data: unknown): void {
  if (!here.has(extension)) {
    const queue = waiting.get(extension) ?? [];
    if (queue.length < WAITING_MOST) queue.push([chatId, data]);
    waiting.set(extension, queue);
    return;
  }
  for (const handler of [...(handlers.get(extension) ?? [])]) {
    try {
      handler(chatId, data);
    } catch (e) {
      console.error(`[extensions] ${extension} failed on hearing from its server half:`, e);
      failedIn(extension)(e);
    }
  }
}

let onScreen: string | undefined;
/** The chat whose stream the page has open, or none: the one a browser half that comes later has missed the start of. */
export function setChatOnScreen(chatId: string | undefined): void {
  onScreen = chatId;
}
export const chatOnScreen = (): string | undefined => onScreen;

/** Hear what an extension's server half says, for whichever chat. Returns the unsubscribe. */
export function onServerPush(extension: string, handler: Handler): () => void {
  let set = handlers.get(extension);
  if (!set) handlers.set(extension, (set = new Set()));
  set.add(handler);
  return () => {
    set.delete(handler);
    if (!set.size && handlers.get(extension) === set) handlers.delete(extension);
  };
}

/** An extension's module has been called: what waited for it is handed over. */
export function extensionHere(extension: string): void {
  here.add(extension);
  const queue = waiting.get(extension) ?? [];
  waiting.delete(extension);
  for (const [chatId, data] of queue) serverPush(chatId, extension, data);
}

/** An extension was taken out of the page. */
export function extensionGone(extension: string): void {
  here.delete(extension);
  handlers.delete(extension);
  waiting.delete(extension);
}

/** The extensions that have a browser half are known: nothing waits for any other. */
export function onlyWaitFor(extensions: readonly string[]): void {
  for (const name of [...waiting.keys()]) if (!extensions.includes(name)) waiting.delete(name);
}
