import { randomBytes } from "node:crypto";
import { format } from "node:util";

/**
 * What the server has printed, kept for Settings → Logs.
 *
 * The lines used to be readable only on the host, in the container log or the
 * terminal the portal was started from. The console is wrapped rather than
 * replaced: everything still goes where it went, and a copy of it is kept here,
 * newest at the end, the oldest let go once the buffer is full. It is the
 * running process's own memory, so a restart starts it empty; what the portal
 * was doing when it died is still in the host's log.
 */

export type LogLevel = "info" | "warn" | "error";

export interface LogLine {
  id: number;
  at: string;
  level: LogLevel;
  text: string;
}

/** A busy server prints thousands of lines an hour; this is minutes of that, and about a megabyte at the longest. */
export const LOG_KEEP = 2000;
/** A stack trace or a dumped object is worth reading to the end; a pasted file is not. */
export const LOG_LINE_MAX = 8000;

/** Changes with every start, so a page that has been polling can tell that the ids began again. */
export const LOG_BOOT = randomBytes(6).toString("hex");

let lines: LogLine[] = [];
let nextId = 1;
const listeners = new Set<(line: LogLine) => void>();

export function recordLog(level: LogLevel, text: string): LogLine {
  const line: LogLine = {
    id: nextId++,
    at: new Date().toISOString(),
    level,
    text: text.length > LOG_LINE_MAX ? `${text.slice(0, LOG_LINE_MAX)}… (${text.length - LOG_LINE_MAX} more characters)` : text,
  };
  lines.push(line);
  if (lines.length > LOG_KEEP) lines = lines.slice(lines.length - LOG_KEEP);
  for (const l of listeners) l(line);
  return line;
}

const RANK: Record<LogLevel, number> = { info: 0, warn: 1, error: 2 };

/**
 * The lines after `since` (all of them without one), oldest first, at `min` or
 * worse. Without `since`, the newest `limit`; with it, the first `limit` after
 * it, so a reader that is behind catches up in order.
 */
export function readLogs(opts: { since?: number; min?: LogLevel; limit?: number } = {}): LogLine[] {
  const min = RANK[opts.min ?? "info"];
  const limit = Math.max(1, opts.limit ?? LOG_KEEP);
  const wanted = lines.filter((l) => RANK[l.level] >= min && (opts.since === undefined || l.id > opts.since));
  return opts.since === undefined ? wanted.slice(-limit) : wanted.slice(0, limit);
}

/** The id of the newest line, 0 before there is one. */
export const lastLogId = () => nextId - 1;

/** For a test: forget everything. */
export function resetLogs() {
  lines = [];
  nextId = 1;
}

/** One line of a downloaded file: when, how bad, what. A message over several lines keeps its own breaks. */
export const logFileLine = (l: LogLine) => `${l.at} ${l.level.toUpperCase().padEnd(5)} ${l.text}`;

let installed = false;

/**
 * Starts keeping a copy of the console, and of what the process reports about
 * itself without printing through it: an exception nothing caught, which ends
 * the process, and node's own warnings. Both are watched, not handled — a
 * handler would stop node from ending on the first and from printing the second.
 */
export function installLogCapture() {
  if (installed) return;
  installed = true;
  const wrap = (name: "log" | "info" | "debug" | "warn" | "error", level: LogLevel) => {
    const original = console[name].bind(console);
    console[name] = (...args: unknown[]) => {
      original(...args);
      // Never let a value that cannot be formatted take the caller down.
      try {
        recordLog(level, format(...args));
      } catch {
        /* the original has printed it */
      }
    };
  };
  wrap("log", "info");
  wrap("info", "info");
  wrap("debug", "info");
  wrap("warn", "warn");
  wrap("error", "error");
  process.on("uncaughtExceptionMonitor", (err, origin) => {
    recordLog("error", `${origin}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  });
  process.on("warning", (w) => recordLog("warn", `${w.name}: ${w.message}`));
}
