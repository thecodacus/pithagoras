import { useEffect, useMemo, useRef, useState } from "react";
import { LuDownload, LuSearch } from "react-icons/lu";
import { api, type LogLevel, type LogLine } from "../api";
import { pollWhileVisible } from "../poll";
import { msg, t, tp } from "../i18n";
import { LoadFailed, Section, Segments, ghostCls, inputCls } from "./SettingsUi";

/**
 * What the server keeps unless it says otherwise (it can be set where it starts): this many lines, and no more than
 * this many characters of them. The page holds no more than that either. It asks for as many as the server allows
 * at the first read, and takes the limits from the answer.
 */
const KEEP = 2000;
const KEEP_CHARS = 2_000_000;
const ASK_ALL = 50_000;

/** The newest lines within both limits; the newest one stays, however long. */
function newest(lines: LogLine[], keep: number, keepChars: number): LogLine[] {
  let from = lines.length;
  let chars = 0;
  while (from > 0 && lines.length - from < keep && (from === lines.length || chars + lines[from - 1].text.length <= keepChars)) {
    chars += lines[from - 1].text.length;
    from--;
  }
  return lines.slice(from);
}

const FILTERS: { id: "all" | "warn" | "error"; label: string }[] = [
  { id: "all", label: msg("Everything") },
  { id: "warn", label: msg("Warnings and errors") },
  { id: "error", label: msg("Errors") },
];

const RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const TONE: Record<LogLevel, string> = { debug: "text-fg-faint", info: "text-fg-faint", warn: "text-warn", error: "text-danger" };

const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour12: false });

/**
 * Settings → Logs: what the server prints, as it prints it.
 *
 * Until now it was readable only on the host. The newest lines are asked for
 * every few seconds while the page is on screen, and the list follows them
 * unless it has been scrolled up to read something.
 */
export function LogsPanel({ onError }: { onError: (message: string | null) => void }) {
  const [lines, setLines] = useState<LogLine[]>([]);
  const [filter, setFilter] = useState<"all" | "warn" | "error">("all");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  // What the server runs at, once it has said.
  const [level, setLevel] = useState<"info" | "debug" | undefined>();
  // Why the first read failed: an empty list would say that the server has printed nothing.
  const [failed, setFailed] = useState<string | null>(null);
  const had = useRef(false);
  const boot = useRef("");
  const last = useRef(0);
  const limits = useRef({ keep: KEEP, chars: KEEP_CHARS });
  // One answer at a time: a slow one landing after the next poll would put its lines in twice.
  const busy = useRef(false);
  const box = useRef<HTMLDivElement>(null);
  // Whether the list is at its end, and so follows what comes.
  const atEnd = useRef(true);

  const load = async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      const first = !had.current;
      let r = await api.logs(first ? { limit: ASK_ALL } : { since: last.current });
      // The ids began again, or lines went by unread: what is held no longer joins the answer, and is replaced.
      const restarted = !first && (r.boot !== boot.current || r.gap);
      if (restarted) r = await api.logs({ limit: ASK_ALL });
      boot.current = r.boot;
      limits.current = { keep: r.keep ?? KEEP, chars: r.chars ?? KEEP_CHARS };
      setLevel(r.level);
      if (r.lines.length) last.current = r.lines[r.lines.length - 1].id;
      else if (first || restarted) last.current = r.last;
      if (first || restarted) setLines(r.lines);
      else if (r.lines.length) setLines((now) => newest([...now, ...r.lines], limits.current.keep, limits.current.chars));
      had.current = true;
      setFailed(null);
      onError(null);
    } catch (e) {
      // A refresh of what is shown goes to the banner; with nothing read yet the page says it itself.
      if (had.current) onError((e as Error).message);
      else setFailed((e as Error).message);
    } finally {
      busy.current = false;
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    return pollWhileVisible(() => void load(), 2000);
  }, []);

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return lines.filter(
      (l) => RANK[l.level] >= RANK[filter === "all" ? "debug" : filter] && (!needle || l.text.toLowerCase().includes(needle)),
    );
  }, [lines, filter, query]);

  // Down to the newest line, if that is where the reader was.
  useEffect(() => {
    const el = box.current;
    if (el && atEnd.current) el.scrollTop = el.scrollHeight;
  }, [shown]);

  if (failed && !had.current) return <LoadFailed error={failed} onRetry={load} />;

  const errors = lines.filter((l) => l.level === "error").length;

  return (
    <Section
      title={t("Logs")}
      hint={
        <>
          {t("What the portal's server prints, newest at the bottom. Kept in memory: a restart starts the list again.")}
          {level && (
            <>
              {" "}
              {level === "debug"
                ? t("Debug lines are included: the portal runs with PITHAGORAS_LOG_LEVEL=debug.")
                : t("For debug lines, start the portal with PITHAGORAS_LOG_LEVEL=debug.")}
            </>
          )}
        </>
      }
      action={
        <a href="/api/logs/download" download className={`${ghostCls} inline-flex items-center gap-1`}>
          <LuDownload className="h-3.5 w-3.5" /> {t("Download")}
        </a>
      }
    >
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <Segments label={t("Which lines to show")} value={filter} options={FILTERS} onChange={setFilter} />
        <label className="relative ml-auto min-w-40 flex-1 basis-48 sm:max-w-64">
          <LuSearch className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-fg-faint" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label={t("Search the logs")}
            placeholder={t("Search")}
            className={`${inputCls} !py-1 pl-8 text-xs`}
          />
        </label>
      </div>
      <p className="mb-2 text-[11px] text-fg-faint" role="status">
        {tp(shown.length, "{n} line", "{n} lines")}
        {errors > 0 && <span className="text-danger"> · {tp(errors, "one error", "{n} errors")}</span>}
      </p>
      <div
        ref={box}
        onScroll={(e) => {
          const el = e.currentTarget;
          atEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
        tabIndex={0}
        role="log"
        aria-label={t("Server logs")}
        className="h-[60vh] min-h-64 overflow-auto rounded-xl border border-line bg-raised/40 p-2 font-mono text-[11px] leading-relaxed"
      >
        {loading ? (
          <p className="px-1 text-fg-subtle">{t("Loading…")}</p>
        ) : shown.length === 0 ? (
          <p className="px-1 py-4 text-center text-fg-faint">
            {lines.length > 0 ? t("Nothing matches.") : t("The server has printed nothing yet.")}
          </p>
        ) : (
          shown.map((l) => (
            <div key={l.id} className="flex gap-2 py-px">
              <span className="shrink-0 text-fg-faint" title={l.at}>{clock(l.at)}</span>
              <span className={`w-9 shrink-0 uppercase ${TONE[l.level]}`}>{l.level}</span>
              <span className={`min-w-0 flex-1 whitespace-pre-wrap break-words ${l.level === "debug" ? "text-fg-subtle" : l.level === "info" ? "text-fg-muted" : "text-fg"}`}>{l.text}</span>
            </div>
          ))
        )}
      </div>
    </Section>
  );
}
