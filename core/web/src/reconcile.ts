const hasId = (row: unknown): row is { id: string } => typeof (row as { id?: unknown } | null)?.id === "string";

/**
 * `next`, with every part that says what `prev` said being the object it was.
 *
 * A list asked for every few seconds answers with new objects that say the same,
 * and setting state to them draws the page again for nothing. Set to what this
 * returns, a poll that found nothing new is not a draw at all, and one that found
 * a chat changed leaves every other row as it was. Rows with an `id` are matched
 * by it, others by place.
 */
export function reconcile<T>(prev: T, next: T): T {
  if (prev === next) return prev;
  if (Array.isArray(prev) && Array.isArray(next)) {
    const byId = prev.length > 0 && prev.every(hasId) ? new Map(prev.map((row) => [row.id, row])) : null;
    const rows = next.map((row, i) => reconcile(byId && hasId(row) ? byId.get(row.id) : prev[i], row));
    return (rows.length === prev.length && rows.every((row, i) => row === prev[i]) ? prev : rows) as T;
  }
  if (prev && next && typeof prev === "object" && typeof next === "object" && !Array.isArray(prev) && !Array.isArray(next)) {
    const was = prev as Record<string, unknown>;
    const now = next as Record<string, unknown>;
    const keys = Object.keys(now);
    const out: Record<string, unknown> = {};
    let same = keys.length === Object.keys(was).length;
    for (const key of keys) {
      out[key] = reconcile(was[key], now[key]);
      if (out[key] !== was[key]) same = false;
    }
    return (same ? prev : out) as T;
  }
  return next;
}
