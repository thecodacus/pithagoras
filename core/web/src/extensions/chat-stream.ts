import { useMemo } from "react";
import type { PortalEvent, SessionStatus } from "../api";
import { useChat } from "../kernel/use";

/**
 * `chats.useEvents`: a chat's events by its id, streamed as the chat on screen streams its own, for an extension that
 * draws a chat beside the one on screen (a child chat's run in a panel, with `ui.Transcript`). Of a long conversation
 * its latest part, as a page load replays it; nothing older is fetched.
 *
 * The kernel's chats store holds the stream (kernel/chats.ts): one for each chat however many parts ask, open while one
 * of them is drawn, and the page keeps at most four open at once. A chat past that is read as a snapshot, which is
 * asked for again every few seconds instead of streamed.
 */
export interface ChatEvents {
  events: readonly PortalEvent[];
  /** How the chat stands, as its events last said: "idle" until one says otherwise. */
  status: SessionStatus;
  /** Its replay has not all come yet. */
  loading: boolean;
  /** The portal has no such chat: deleted, say, or never made. Nothing more is asked. */
  missing: boolean;
  /** The versions of messages edited or sent again, by the seq of the one shown: the seqs of all of them, oldest first. */
  versions: Readonly<Record<number, readonly number[]>>;
  /** Anything older than what is held is on the portal still (`controller(id).loadEarlier()` reads it). */
  hasEarlier: boolean;
  loadingEarlier: boolean;
  /** Streamed; false for a snapshot asked for every few seconds, which the chats past the fourth are. */
  live: boolean;
}

const EMPTY: ChatEvents = { events: [], status: "idle", loading: false, missing: false, versions: {}, hasEarlier: false, loadingEarlier: false, live: true };

/** A chat's events by its id, streamed while the component is drawn; nothing, and nothing asked, without an id. */
export function useChatEvents(chatId: string | undefined): ChatEvents {
  const chat = useChat(chatId);
  return useMemo(
    () =>
      chatId
        ? { events: chat.events, status: chat.status, loading: !chat.loaded, missing: chat.missing, versions: chat.versions, hasEarlier: chat.loaded && chat.moreBefore, loadingEarlier: chat.loadingBefore, live: chat.live }
        : EMPTY,
    [chatId, chat.events, chat.status, chat.loaded, chat.missing, chat.versions, chat.moreBefore, chat.loadingBefore, chat.live],
  );
}
