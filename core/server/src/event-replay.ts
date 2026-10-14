import { eventTime, eventsSince, type EventRow } from "./db.js";

/** How many events one query catches a reconnecting page up with. */
export const REPLAY_PAGE = 5_000;

/**
 * An event as the page reads it, around its stored text as it is.
 *
 * Payloads are kept as JSON, and used to be parsed and written out again for
 * every page watching: on a long run, tens of megabytes of screenshots for each
 * reconnect, on the one thread that every chat's stream shares. A stored
 * payload is already what the page is to be given.
 */
export function eventJson(row: Pick<EventRow, "seq" | "type" | "payload"> & { created_at?: string }): string {
  // What the activity line counts from, so a refresh mid-run still knows how
  // long the agent has been on this rather than starting from zero.
  const at = eventTime(row.created_at);
  return `{"seq":${row.seq},"type":${JSON.stringify(row.type)},${at === undefined ? "" : `"at":${at},`}"payload":${row.payload ?? "null"}}`;
}

/**
 * Everything stored after `since`, handed to `deliver` a page of rows at a time
 * until the end — a reconnect after a long run has more to catch up on than one
 * query returns, and stopping early loses exactly the part it was reconnecting
 * for.
 *
 * `deliver` says whether to go on: true at once, false when whoever is reading
 * has gone, or a promise of either when it must wait — for a slow reader's
 * buffer to empty. Between pages the other streams get their turn: a long
 * replay held the thread, and every other chat's stream with it.
 */
export async function replaySince(
  sessionId: string,
  since: number,
  deliver: (row: EventRow) => boolean | Promise<boolean>,
  page = REPLAY_PAGE,
): Promise<{ lastSent: number; gone: boolean }> {
  let lastSent = since;
  for (;;) {
    const batch = eventsSince(sessionId, lastSent, page);
    for (const row of batch) {
      const go = deliver(row);
      lastSent = row.seq;
      if (go !== true && !(await go)) return { lastSent, gone: true };
    }
    if (batch.length < page) return { lastSent, gone: false };
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}
