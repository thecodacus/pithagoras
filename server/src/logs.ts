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

/** A busy server prints thousands of lines an hour; this is minutes of that. */
export const LOG_KEEP = 2000;
/** A stack trace or a dumped object is worth reading to the end; a pasted file is not. */
export const LOG_LINE_MAX = 8000;
/**
 * The count alone would let a crash loop of long lines fill 2000 x 8000
 * characters, 16 MB for the page to download and render; the oldest lines go
 * once the text held passes this, whatever their number.
 */
export const LOG_CHARS_MAX = 2_000_000;

/** Changes with every start, so a page that has been polling can tell that the ids began again. */
export const LOG_BOOT = randomBytes(6).toString("hex");

let lines: LogLine[] = [];
let chars = 0;
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
  chars += line.text.length;
  // The oldest go until both limits hold; the newest line stays, however long.
  let drop = 0;
  while (lines.length - drop > 1 && (lines.length - drop > LOG_KEEP || chars > LOG_CHARS_MAX)) chars -= lines[drop++].text.length;
  if (drop) lines = lines.slice(drop);
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

/** Whether lines after `since` have been let go, so that a reader holding it has missed some. */
export const logGap = (since: number) => since + 1 < (lines.length ? lines[0].id : nextId);

/** For a test: forget everything. */
export function resetLogs() {
  lines = [];
  chars = 0;
  nextId = 1;
}

/** One line of a downloaded file: when, how bad, what. A message over several lines keeps its own breaks. */
export const logFileLine = (l: LogLine) => `${l.at} ${l.level.toUpperCase().padEnd(5)} ${l.text}`;

let installed = false;

/** How node prints its own warnings: `(node:123) DeprecationWarning: …`, with a `[DEP0040] ` before the name for some. */
const NODE_WARNING = /^\(node:\d+\) (?:\[[A-Z0-9_]+\] )?\w*Warning:/;

/**
 * Starts keeping a copy of the console. Node prints its own warnings through
 * `console.error`, so they arrive here by that way (a `process.on("warning")`
 * listener would record each a second time); they are warnings, not errors, and
 * are filed as such. An uncaught exception is not recorded: it ends the process
 * and the list with it, so what it printed is only in the host's log.
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
        const text = format(...args);
        recordLog(name === "error" && NODE_WARNING.test(text) ? "warn" : level, text);
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
}
