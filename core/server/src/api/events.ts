import express, { type Router } from "express";
import { eventsBefore, getSession, replayStart, type EventRow } from "../db.js";
import { watchStream } from "../login-streams.js";
import { eventJson, replaySince } from "../event-replay.js";
import { sessions } from "../session-manager.js";
import { openingPushes, pagePushes } from "../extension-host.js";

/**
 * How much of a long conversation a fresh page load replays.
 *
 * Small on purpose. Not a correctness limit — a reconnect with a cursor still
 * receives everything it missed, and older events are fetched on demand as you
 * scroll back. Replaying twenty thousand meant a refresh rendered the entire
 * history and then visibly scrolled through it.
 */
const REPLAY_EVENTS = 1_200;


/**
 * Live events a snapshot already holds, which a page reads after the replay: one
 * that came while the replay was going is in it, and said again it would be
 * added twice.
 */
const IN_SNAPSHOT = new Set(["message_update", "tool_execution_update", "portal_subagent_live"]);

export function eventsRouter(): Router {
  const router = express.Router();

  /** What came before a cursor: the transcript scrolling back rather than forward. */
  router.get("/sessions/:id/events/before", (req, res) => {
    const session = getSession(req.params.id);
    if (!session) return res.status(404).json({ error: "Not found" });
    const before = Number(req.query.before ?? 0) || 0;
    // At least one: SQLite takes a negative LIMIT as no limit at all.
    const limit = Math.max(1, Math.min(Math.floor(Number(req.query.limit)) || REPLAY_EVENTS, 3000));
    const rows = eventsBefore(session.id, before, limit);
    // Whether asking again would return anything, so the UI knows to stop.
    res.type("json").send(`{"events":[${rows.map(eventJson).join(",")}],"more":${rows.length === limit}}`);
  });

  /**
   * Replay-then-tail. The client passes the last seq it saw, so reconnecting
   * after minutes or days delivers exactly what was missed and then continues
   * live — no gap, no duplicates.
   */
  router.get("/sessions/:id/events", (req, res) => {
    const session = getSession(req.params.id);
    if (!session) return res.status(404).json({ error: "Not found" });

    const since = Number(req.query.since ?? 0) || 0;

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    // The page went away: nothing more is written to it, and a replay waiting on
    // it stops. Live events wait while a replay is going, and are let through
    // once it has caught up: attached after it, they would miss whatever came
    // while a slow reader was being waited for.
    let gone = false;
    let replaying = true;
    const waiting: EventRow[] = [];
    let heartbeat: ReturnType<typeof setInterval> | undefined;

    // False when the socket has more than it can send at once.
    const write = (row: { seq: number; type: string; payload: string; created_at?: string }) =>
      res.write(`${row.seq > 0 ? `id: ${row.seq}\n` : ""}data: ${eventJson(row)}\n\n`);
    // Closed is told by the event, which comes after the socket is destroyed.
    const left = () => gone || res.destroyed;
    /**
     * Waits for the socket to take what is buffered. False when the page has gone
     * instead, which is said at once for one that went already: a socket that is
     * closed neither drains nor closes again, and this would wait for ever.
     */
    const drained = () =>
      new Promise<boolean>((resolve) => {
        if (left()) return resolve(false);
        const done = () => {
          res.off("drain", done);
          res.off("close", done);
          resolve(!gone);
        };
        res.once("drain", done);
        res.once("close", done);
      });

    // What the installed extensions' server halves tell what they drew on this
    // chat's page, on the same stream under a name of its own: where things
    // stand first, then each thing as it is said. See extension-host.ts.
    const writePush = (message: string) => res.write(`event: extension\ndata: ${message}\n\n`);
    pagePushes.on(session.id, writePush);
    openingPushes(session.id, writePush);

    // How often this chat's events were put back under seqs a page had read
    // past (see bumpReloads): a page that last saw another count missed one, and
    // loads the chat again rather than go on from its cursor.
    res.write(`event: reloads\ndata: ${JSON.stringify({ reloads: session.reloads ?? 0 })}\n\n`);
    // The versions of its messages, as they are now; later changes come live
    // (portal_versions). A page does not ask for them after each change.
    res.write(`event: versions\ndata: ${JSON.stringify({ versions: sessions.messageVersions(session.id) })}\n\n`);
    // Replace stale in-memory deltas before durable replay, then restore the current snapshot.
    res.write("event: live-reset\ndata: {}\n\n");

    let lastSent = 0;
    const onEvent = (row: EventRow) => {
      if (replaying) {
        if (!IN_SNAPSHOT.has(row.type)) waiting.push(row);
        return;
      }
      // Live-only events carry a negative seq: deliver them, but never let one
      // move the replay cursor, or a reconnect would skip stored history.
      if (row.seq < 0) {
        write(row);
        return;
      }
      // Guard against double-sending anything the replay already covered.
      if (row.seq <= lastSent) return;
      lastSent = row.seq;
      write(row);
    };
    sessions.on(`session:${session.id}`, onEvent);

    // Ended when the password changes: this login is not the portal's any more, and the stream was checked only as it opened.
    const unwatch = watchStream(() => res.destroy());
    res.on("close", () => {
      unwatch();
      gone = true;
      clearInterval(heartbeat);
      sessions.off(`session:${session.id}`, onEvent);
      pagePushes.off(session.id, writePush);
    });

    void (async () => {
      // A fresh load gets the end of the conversation, not the beginning. Replaying
      // from zero and stopping at the batch limit is how a long session came back
      // from a refresh showing its first few thousand events and nothing since —
      // the transcript ended mid-turn, on whatever the cap happened to land on.
      const cursor = since === 0 ? replayStart(session.id, REPLAY_EVENTS) : since;
      // Nothing is written to a page that has gone, as between two pages of a long replay.
      const replay = await replaySince(session.id, cursor, (row) => (left() ? false : write(row) ? !gone : drained()));
      if (gone || replay.gone) return;
      lastSent = replay.lastSent;
      for (const row of sessions.liveSnapshot(session.id)) write(row);
      res.write(`event: caught-up\ndata: ${JSON.stringify({ seq: lastSent })}\n\n`);
      replaying = false;
      for (const row of waiting.splice(0)) onEvent(row);
      heartbeat = setInterval(() => res.write(": ping\n\n"), 25_000);
    })().catch((e) => {
      console.error(`[portal] could not replay ${session.id}:`, (e as Error).message);
      res.end();
    });
  });

  return router;
}
