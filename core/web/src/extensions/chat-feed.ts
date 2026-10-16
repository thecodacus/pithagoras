import { useCallback, useRef, useSyncExternalStore } from "react";
import type { ToolCallView } from "@pithagoras/extension-api";
import type { BackgroundState, PortalEvent, SessionStatus } from "../api";
import type { Item } from "../transcript";

/**
 * A chat as the page has it, for what an extension drew there: its events as
 * they come, the conversation made of them, and whether the agent is at work.
 * The chat on screen says it here each time it changes; whoever reads it is
 * drawn again.
 *
 * `events` are the chat's own: pi's (a message as it streams, a tool call's
 * start, its output as it comes, its end) and the portal's (`portal_*`). Of a
 * long conversation they are its latest part, more as the person scrolls back.
 */
export interface ChatFeed {
  events: readonly PortalEvent[];
  /** The conversation as the portal draws it: messages, tool calls with their output, notices. */
  items: readonly Item[];
  /** The tool calls that have not ended: being written by the model, with what has come of their arguments, or running. See open-calls.ts. */
  calls: readonly ToolCallView[];
  /** A call of the conversation by its id, ended or not; nothing for one the page does not have. */
  call(callId: string): ToolCallView | undefined;
  /** The agent is at work. */
  running: boolean;
  /** How the chat stands: at work, waiting, or stopped by an error or by hand. After those two, a call that has not ended will not. */
  status: SessionStatus;
  /** The conversation is still being fetched. */
  loading: boolean;
  /** Its background jobs and what extensions say of themselves, asked of the portal while the chat is on screen. */
  background: BackgroundState;
  /** Asks for `background` again at once: after a job was stopped, or the finished ones cleared. */
  refreshBackground(): void;
}

const NOTHING: ChatFeed = {
  events: [],
  items: [],
  calls: [],
  call: () => undefined,
  running: false,
  status: "idle",
  loading: true,
  background: { supported: false, jobs: [], statuses: [], widgets: [] },
  refreshBackground: () => undefined,
};
const feeds = new Map<string, ChatFeed>();
const watchers = new Map<string, Set<() => void>>();

/** What the chat on screen holds now. One that fails on hearing it fails alone: the chat that says it, and the rest that hear it, go on. */
export function publishChat(chatId: string, feed: ChatFeed): void {
  feeds.set(chatId, feed);
  for (const watcher of [...(watchers.get(chatId) ?? [])]) {
    try {
      watcher();
    } catch (e) {
      console.error("[extensions] hearing a chat change failed:", e);
    }
  }
}

/** The chat left the screen: nothing of it is kept. */
export function forgetChatFeed(chatId: string): void {
  feeds.delete(chatId);
}

export const chatFeed = (chatId: string): ChatFeed => feeds.get(chatId) ?? NOTHING;

/** A list, or an object written as one: what is told apart by what it holds. A Set, a Map or a Date holds what `Object.keys` does not see. */
const plain = (value: object) => Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null;

/** Whether two picks say the same: the same value, or lists or plain objects holding the same values. Anything else only when it is the same one. */
export function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || !a || !b) return false;
  if (!plain(a) || !plain(b) || Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => Object.is((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

function watchChat(chatId: string, watcher: () => void): () => void {
  let set = watchers.get(chatId);
  if (!set) watchers.set(chatId, (set = new Set()));
  set.add(watcher);
  return () => {
    set.delete(watcher);
    // Only if it is still the chat's: one emptied and since made anew is other watchers', not this one's to take away.
    if (!set.size && watchers.get(chatId) === set) watchers.delete(chatId);
  };
}

/** Told each time a chat changes, outside any component: for an extension that keeps something of its own from it. Returns the unsubscribe. */
export function onChatFeed(chatId: string, handler: (feed: ChatFeed) => void): () => void {
  return watchChat(chatId, () => handler(chatFeed(chatId)));
}

/**
 * A chat as the page has it, for a component. With `pick`, only what the
 * component uses of it: a chat changes with every token of a reply, and the
 * component is drawn again only when what it picked is no longer the same
 * (`same`; by default the same value, or a list or object of the same values).
 * Without it, with every change.
 */
export function useChatFeed<T = ChatFeed>(chatId: string, pick?: (feed: ChatFeed) => T, same: (a: T, b: T) => boolean = sameValue): T {
  const last = useRef<{ feed: ChatFeed; pick: typeof pick; picked: T } | null>(null);
  const subscribe = useCallback((watcher: () => void) => watchChat(chatId, watcher), [chatId]);
  return useSyncExternalStore(subscribe, () => {
    const feed = chatFeed(chatId);
    const was = last.current;
    if (was && was.feed === feed && was.pick === pick) return was.picked;
    const picked = pick ? pick(feed) : (feed as unknown as T);
    // The same as before: the one already handed out, so the component is not drawn again for it.
    last.current = { feed, pick, picked: was && same(was.picked, picked) ? was.picked : picked };
    return last.current.picked;
  });
}
