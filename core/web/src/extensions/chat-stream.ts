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
}

const EMPTY: ChatEvents = { events: [], status: "idle", loading: false, missing: false };

/** A chat's events by its id, streamed while the component is drawn; nothing, and nothing asked, without an id. */
export function useChatEvents(chatId: string | undefined): ChatEvents {
  const chat = useChat(chatId);
  return useMemo(
    () => (chatId ? { events: chat.events, status: chat.status, loading: !chat.loaded, missing: chat.missing } : EMPTY),
    [chatId, chat.events, chat.status, chat.loaded, chat.missing],
  );
}
