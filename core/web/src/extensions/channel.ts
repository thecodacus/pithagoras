import { api } from "../api";
import { failedIn } from "./loader";
import type { Channel } from "./slots";

/**
 * What an extension's two halves say to each other in a chat, passed from the
 * chat's event stream to what the browser half drew there, and back by a
 * request. The server's side of it is extension-ui.ts.
 */

type Handler = (data: unknown) => void;

const handlers = new Map<string, Set<Handler>>();
const channels = new Map<string, Channel>();
const at = (chatId: string, extension: string) => `${chatId}\n${extension}`;

/** Something an extension said to its browser half in a chat. */
export function extensionMessage(chatId: string, extension: string, data: unknown): void {
  for (const handler of [...(handlers.get(at(chatId, extension)) ?? [])]) {
    try {
      handler(data);
    } catch (e) {
      console.error(`[extensions] ${extension} failed on hearing from its extension:`, e);
      failedIn(extension)(e);
    }
  }
}

/** An extension's channel in a chat: the same one each time, so that what is drawn with it is not drawn again for it. */
export function channelFor(chatId: string, extension: string): Channel {
  const key = at(chatId, extension);
  let channel = channels.get(key);
  if (!channel) {
    channel = {
      send: (data) => api.tellExtension(chatId, extension, data).then(() => undefined),
      on: (handler) => {
        let set = handlers.get(key);
        if (!set) handlers.set(key, (set = new Set()));
        set.add(handler);
        return () => {
          set.delete(handler);
          if (!set.size && handlers.get(key) === set) handlers.delete(key);
        };
      },
    };
    channels.set(key, channel);
  }
  return channel;
}
