import { serverTime } from "./time";

/**
 * Chats whose name or folder contains what was typed, in any case; all of them when nothing was.
 * The folder is what the list shows of it (`folderOf`, its name), never the path it works in:
 * a chat must not turn up for a word the user cannot see. Without `folderOf` only the name counts.
 */
export function filterSessions<S extends { title: string }>(
  sessions: readonly S[],
  query: string,
  folderOf?: (s: S) => string,
): S[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...sessions];
  return sessions.filter((s) => `${s.title} ${folderOf?.(s) ?? ""}`.toLowerCase().includes(q));
}

/**
 * The chats a clean-up of old ones takes: not touched for `days` days, and neither pinned nor at work
 * (running, or waiting for an answer), which nobody asking for "the old ones" means.
 * `busy` tells a chat that works, counting its sub-chats; `now` is the clock, for a test.
 */
export function olderThan<S extends { pinned: boolean; updated_at: string }>(
  sessions: readonly S[],
  days: number,
  busy: (s: S) => boolean,
  now = Date.now(),
): S[] {
  const before = now - days * 86_400_000;
  return sessions.filter((s) => !s.pinned && !busy(s) && +serverTime(s.updated_at) < before);
}
