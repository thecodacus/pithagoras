/**
 * Sub-chats: the child chats a chat has (a server half makes them, see the
 * extension guide's "Child chats"), listed under it rather than among the
 * chats. The sidebar and the Sessions page both split the list here, so that
 * they agree: a sub-chat is not counted in a folder, nor against how many
 * chats a list shows, nor in the Sessions page's totals, and its own run
 * ending is not told on its own. It shows under its chat, which says when one
 * of them works or waits for you.
 */

import type { SessionStatus } from "./api";

type Chat = { id: string; parent?: string };

/** The chats listed on their own (`top`), in the order given, and the sub-chats of each, by its id. */
export type Families<S> = { top: S[]; under: ReadonlyMap<string, S[]> };

/**
 * The chats split into those listed on their own and the sub-chats of each,
 * both in the order they were given. A sub-chat whose chat is not in the list
 * — a chat that came through a channel, say, which the list leaves out — is
 * listed on its own rather than lost.
 */
export function splitSubChats<S extends Chat>(sessions: readonly S[]): Families<S> {
  const ids = new Set(sessions.map((s) => s.id));
  const top: S[] = [];
  const under = new Map<string, S[]>();
  for (const s of sessions) {
    if (!s.parent || !ids.has(s.parent)) top.push(s);
    else under.set(s.parent, [...(under.get(s.parent) ?? []), s]);
  }
  return { top, under };
}

/**
 * What a search found (`hits`), as the lists show it: a chat with its
 * sub-chats. A chat is there when it or one of its sub-chats was found. Under
 * it are the sub-chats that were found, or all of them where only the chat
 * itself was, so that it does not look as if it had none.
 */
export function familiesFound<S extends Chat>(all: Families<S>, hits: readonly S[]): Families<S> {
  const found = new Set(hits.map((s) => s.id));
  const top: S[] = [];
  const under = new Map<string, S[]>();
  for (const s of all.top) {
    const subs = all.under.get(s.id) ?? [];
    const matching = subs.filter((c) => found.has(c.id));
    if (!found.has(s.id) && !matching.length) continue;
    top.push(s);
    if (subs.length) under.set(s.id, matching.length ? matching : subs);
  }
  return { top, under };
}

/**
 * The folder name a search matches a chat by, given how folders are named
 * (`nameOf`): none for a pinned chat, which is listed at the top with no folder
 * beside it, and none for its sub-chats either, or the folder would find the
 * pinned chat through them.
 */
export function searchFolderOf<S extends Chat & { pinned?: boolean }>(sessions: readonly S[], nameOf: (s: S) => string): (s: S) => string {
  const pinned = new Set(sessions.filter((s) => s.pinned).map((s) => s.id));
  return (s) => (s.pinned || (s.parent && pinned.has(s.parent)) ? "" : nameOf(s));
}

/** How a chat shows in a list: as its status, or as waiting for you. */
export type ShownStatus = SessionStatus | "asking";

/**
 * How a chat shows in a list, with its sub-chats: waiting for you while it or
 * one of them waits on a person — before anything else, since nobody may be
 * looking at that sub-chat's page — running while one of them runs, and
 * otherwise as it is.
 */
export function shownStatus(
  s: { status: SessionStatus; asking?: boolean },
  subs: readonly { status: SessionStatus; asking?: boolean }[] = [],
): ShownStatus {
  if (s.asking || subs.some((c) => c.asking)) return "asking";
  if (s.status !== "running" && subs.some((c) => c.status === "running")) return "running";
  return s.status;
}

/**
 * Whether a chat works, or one of its sub-chats does: what a folder's mark and
 * the Sessions page's count of running chats go by, whatever else it shows.
 */
export const familyRunning = (s: { status: SessionStatus }, subs: readonly { status: SessionStatus }[] = []) =>
  s.status === "running" || subs.some((c) => c.status === "running");

/** The chat listed on its own that holds `id`: the chat itself, or the chat of a sub-chat. */
export const topOf = <S extends Chat>(all: Families<S>, id: string | null | undefined): S | undefined =>
  id ? all.top.find((s) => s.id === id || all.under.get(s.id)?.some((c) => c.id === id)) : undefined;
