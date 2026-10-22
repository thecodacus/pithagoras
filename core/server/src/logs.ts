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
 *
 * Lines come at four levels. `debug` lines (see debugLog) are kept and printed
 * only when the server is started with `PITHAGORAS_LOG_LEVEL=debug`; `info` is
 * the default and drops them.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogLine {
  id: number;
  at: string;
  level: LogLevel;
  text: string;
}

/**
 * What the portal's environment says about its logs. `PITHAGORAS_LOG_LEVEL` is `info` (the default) or `debug`;
 * `PITHAGORAS_LOG_LINES` and `PITHAGORAS_LOG_CHARS` size the buffer. A value that is not one of those, or not a whole
 * number, leaves the default and is named in `problems`, which the start prints once the console is kept. A number
 * outside the range is brought to the nearest end of it: below it the page would show almost nothing, above it
 * the page that downloads and renders the list could not.
 */
export interface LogSettings {
  level: "info" | "debug";
  keep: number;
  chars: number;
  problems: string[];
}

const KEEP_DEFAULT = 2000;
const CHARS_DEFAULT = 2_000_000;
const KEEP_RANGE = [100, 50_000] as const;
const CHARS_RANGE = [200_000, 20_000_000] as const;

export function logSettings(env: Record<string, string | undefined> = process.env): LogSettings {
  const problems: string[] = [];
  const level = (env.PITHAGORAS_LOG_LEVEL ?? "").trim().toLowerCase();
  if (level && level !== "info" && level !== "debug") problems.push(`PITHAGORAS_LOG_LEVEL=${JSON.stringify(level.slice(0, 20))} is not info or debug; using info`);
  const size = (name: string, fallback: number, [min, max]: readonly [number, number]) => {
    const raw = (env[name] ?? "").trim();
    if (!raw) return fallback;
    if (!/^\d+$/.test(raw)) {
      problems.push(`${name}=${JSON.stringify(raw.slice(0, 20))} is not a whole number; using ${fallback}`);
      return fallback;
    }
    const n = Math.min(Math.max(Number(raw), min), max);
    if (n !== Number(raw)) problems.push(`${name}=${raw} is outside ${min} to ${max}; using ${n}`);
    return n;
  };
  return {
    level: level === "debug" ? "debug" : "info",
    keep: size("PITHAGORAS_LOG_LINES", KEEP_DEFAULT, KEEP_RANGE),
    chars: size("PITHAGORAS_LOG_CHARS", CHARS_DEFAULT, CHARS_RANGE),
    problems,
  };
}

const settings = logSettings();

/** A busy server prints thousands of lines an hour; this is minutes of that. */
export const LOG_KEEP = settings.keep;
/** A stack trace or a dumped object is worth reading to the end; a pasted file is not. */
export const LOG_LINE_MAX = 8000;
/**
 * The count alone would let a crash loop of long lines fill 2000 x 8000
 * characters, 16 MB for the page to download and render; the oldest lines go
 * once the text held passes this, whatever their number.
 */
export const LOG_CHARS_MAX = settings.chars;

let current = settings.level;
/** Whether debug lines are kept and printed: read once at the start, as the rest of the environment is. */
export const debugOn = () => current === "debug";
/** The level the server runs at: `debug` also keeps and prints the debug lines, `info` drops them. */
export const logLevel = () => current;
/** For a test: change the level the server runs at. */
export function setLogLevel(next: "info" | "debug") {
  current = next;
}

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

/** `listener` is called with each line as it is kept, in the code that printed it: what an extension printed is kept apart for it (extension-host.ts). */
export function onLogLine(listener: (line: LogLine) => void): void {
  listeners.add(listener);
}

const RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/**
 * The lines after `since` (all of them without one), oldest first, at `min` or
 * worse. Without `since`, the newest `limit`; with it, the first `limit` after
 * it, so a reader that is behind catches up in order. Without `min` that is
 * every line held, the debug ones included: there are none unless they are on.
 */
export function readLogs(opts: { since?: number; min?: LogLevel; limit?: number } = {}): LogLine[] {
  const min = RANK[opts.min ?? "debug"];
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

/** Shown where a secret was. */
const HIDDEN = "[redacted]";

/** Environment variables that hold a secret: their values are taken out of a debug line wherever they appear. */
const SECRET_ENV = /secret|token|passw|api_?key|auth|credential|private/i;
/** A field with such a name is never printed, whatever it holds. */
const SECRET_KEY = /secret|token|passw|pwd|api[_-]?key|auth|cookie|credential|private|signature/i;

const SECRET_SHAPES: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, HIDDEN],
  // A header, whole: what follows it is the credential, whatever scheme it uses.
  [/\b(authorization|proxy-authorization|cookie|set-cookie|x-api-key)\s*:[^\r\n]*/gi, `$1=${HIDDEN}`],
  [/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi, `$1 ${HIDDEN}`],
  // user:password@host, and a token standing where the user would. Up to the last @ before the path: a password
  // may hold a raw @, and parsers split at the last one.
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#]+@/gi, `$1${HIDDEN}@`],
  // token=…, "accessToken": "…", ?client_secret=…: any name that ends in one of these words, whatever comes before it
  [
    /((?:token|secret|password|passwd|pwd|api[_-]?key|apikey|auth|authorization|cookie|credentials?|signature|private[_-]?key)(?:[_.-][A-Za-z0-9]+)*)(["']?\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s&;,]+)/gi,
    `$1$2${HIDDEN}`,
  ],
  // The short names, which only count as a whole word (not monkey=, not api_key=, which the pattern above has had).
  [/(?<![A-Za-z0-9_.-])(key|pass|sig)(["']?\s*=\s*|["']\s*:\s*)("[^"]*"|'[^']*'|[^\s&;,]+)/gi, `$1$2${HIDDEN}`],
  // Keys as their issuers print them, for one that turns up with nothing around it to give it away.
  [/\bsk-[A-Za-z0-9_-]{16,}/g, HIDDEN],
  [/\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/g, HIDDEN],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,})/g, HIDDEN],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, HIDDEN],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, HIDDEN],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, HIDDEN],
  [/\b(?:npm|hf)_[A-Za-z0-9]{30,}/g, HIDDEN],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, HIDDEN],
];

/**
 * Takes what looks like a secret out of a text: the values of this process's own secret environment variables
 * wherever they stand, then the shapes credentials come in (headers, `token=…`, the userinfo of a URL, the keys
 * the common services issue). A guard, not a promise: a debug line is built from fields chosen not to hold one
 * (names, outcomes, durations, ids), and this catches what a careless one lets through.
 */
export function scrubSecrets(text: string): string {
  let out = text;
  for (const [name, value] of Object.entries(process.env)) {
    if (value && value.length >= 8 && SECRET_ENV.test(name) && out.includes(value)) out = out.split(value).join(HIDDEN);
  }
  for (const [shape, to] of SECRET_SHAPES) out = out.replace(shape, to);
  return out;
}

/** The fields of a debug line are plain values: an object would be dumped whole, with whatever it holds. */
export type LogFields = Record<string, string | number | boolean | null | undefined>;

/** A value longer than this is cut: a debug line says what happened, it does not carry the data. */
const FIELD_MAX = 120;
const FIELD_SCAN = 2000;

/** One line: a line break or an escape sequence in a value would forge another line, or a field. */
const oneLine = (text: string) => text.replace(/[\u0000-\u001f\u007f\s]+/g, " ").trim();

function fieldText(value: string | number | boolean): string {
  if (typeof value !== "string") return String(value);
  // Scrubbed before it is cut, so that a secret is not cut into a piece too short to be recognised; the first
  // part only, since that is all the field shows and a pattern is slower on a text of megabytes.
  const flat = oneLine(scrubSecrets(value.slice(0, FIELD_SCAN)));
  const cut = flat.length > FIELD_MAX ? `${flat.slice(0, FIELD_MAX)}…` : flat;
  return /^[^\s="]+$/.test(cut) ? cut : JSON.stringify(cut);
}

/** `[scope] message key=value …`, on one line, with nothing in it that looks like a secret. */
export function debugText(scope: string, message: string, fields: LogFields = {}): string {
  const parts = [oneLine(scrubSecrets(`[${scope}] ${message}`))];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null || !/^[a-z][a-z0-9_]*$/i.test(key)) continue;
    parts.push(`${key}=${SECRET_KEY.test(key) ? HIDDEN : fieldText(value)}`);
  }
  return scrubSecrets(parts.join(" "));
}

/**
 * A debug line: kept for Settings → Logs and printed only when the server runs at `debug`, and otherwise nothing
 * (the arguments are not even formatted). The one way to write one; the fields are what happened, as ids, names,
 * outcomes and durations. Never the content of a call, a message or a file: those can hold anything.
 */
export function debugLog(scope: string, message: string, fields: LogFields = {}): void {
  if (!debugOn()) return;
  try {
    console.debug(debugText(scope, message, fields));
  } catch {
    // A line that cannot be built is dropped, not printed as it is.
  }
}

let installed = false;

/** How node prints its own warnings: `(node:123) DeprecationWarning: …`, with a `[DEP0040] ` before the name for some. */
const NODE_WARNING = /^\(node:\d+\) (?:\[[A-Z0-9_]+\] )?\w*Warning:/;

/**
 * Starts keeping a copy of the console. Node prints its own warnings through
 * `console.error`, so they arrive here by that way (a `process.on("warning")`
 * listener would record each a second time); they are warnings, not errors, and
 * are filed as such. An uncaught exception is not recorded: it ends the process
 * and the list with it, so what it printed is only in the host's log. One of an
 * extension's server half does not end it: it is said, and kept (extension-host.ts).
 */
export function installLogCapture() {
  if (installed) return;
  installed = true;
  const wrap = (name: "log" | "info" | "debug" | "warn" | "error", level: LogLevel) => {
    const original = console[name].bind(console);
    console[name] = (...args: unknown[]) => {
      if (name === "debug") {
        // console.debug is the debug channel, for what any code prints through it: below `debug` it prints and keeps
        // nothing, and above it it passes the same scrubbing as the helper's own lines.
        if (!debugOn()) return;
        try {
          // The patterns are slower on a long text; the list keeps the first LOG_LINE_MAX characters of it anyway.
          const text = scrubSecrets(format(...args).slice(0, 2 * LOG_LINE_MAX));
          original(text);
          recordLog(level, text);
        } catch {
          /* a line that cannot be formatted is dropped */
        }
        return;
      }
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
  wrap("debug", "debug");
  wrap("warn", "warn");
  wrap("error", "error");
  for (const problem of settings.problems) console.warn(`[logs] ${problem}`);
  if (debugOn()) console.info("[logs] debug lines are on (PITHAGORAS_LOG_LEVEL=debug): they are kept here and printed to the host's log");
}
