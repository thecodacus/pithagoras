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
