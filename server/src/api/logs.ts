import express, { type Router } from "express";
import { LOG_BOOT, LOG_KEEP, lastLogId, logFileLine, readLogs, type LogLevel } from "../logs.js";

const LEVELS: LogLevel[] = ["info", "warn", "error"];

/** Settings → Logs: what the server has printed, to read as it comes and to take away. */
export function logsRouter(): Router {
  const router = express.Router();

  /**
   * `?since=<id>` returns what came after that line, so the page asks every few
   * seconds for the new ones only. `boot` names this start of the server: the
   * ids begin again with each, and a page holding one from before is told so.
   */
  router.get("/logs", (req, res) => {
    const since = req.query.since === undefined ? undefined : Number(req.query.since);
    if (since !== undefined && !(Number.isInteger(since) && since >= 0)) {
      return res.status(400).json({ error: "since must be a line id" });
    }
    const level = req.query.level === undefined ? "info" : String(req.query.level);
    if (!LEVELS.includes(level as LogLevel)) return res.status(400).json({ error: `level must be one of ${LEVELS.join(", ")}` });
    const requested = Number(req.query.limit);
    const limit = Number.isFinite(requested) && requested > 0 ? Math.min(Math.floor(requested), LOG_KEEP) : 500;
    res.json({ boot: LOG_BOOT, last: lastLogId(), lines: readLogs({ since, min: level as LogLevel, limit }) });
  });

  /** All that is kept, as a text file. */
  router.get("/logs/download", (_req, res) => {
    const day = new Date().toISOString().slice(0, 10);
    res.set({
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Disposition": `attachment; filename="pithagoras-logs-${day}.log"`,
      "Cache-Control": "no-store",
    });
    res.send(readLogs().map(logFileLine).join("\n") + "\n");
  });

  return router;
}
