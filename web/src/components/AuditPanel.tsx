import { useEffect, useRef, useState } from "react";
import { LuBan, LuCircleCheck, LuGlobe, LuKeyRound, LuRefreshCw, LuShield, LuShieldAlert, LuShieldCheck, LuTrash2, LuUserX } from "react-icons/lu";
import { confirmDialog } from "./ConfirmDialog";
import { PageHeader, Stat } from "./PageHeader";
import { ErrorBanner, LoadFailed, Segments } from "./SettingsUi";
import { api, type AuditEntry } from "../api";
import { pollWhileVisible } from "../poll";
import { msg, t, tp } from "../i18n";
import { serverTime, sinceThen } from "../time";

/** What each kind means at a glance, without reading the reason. */
const KIND: Record<string, { label: string; icon: JSX.Element; tone: string }> = {
  refused: { label: msg("Refused"), icon: <LuBan className="h-3.5 w-3.5" />, tone: "text-danger" },
  "allowed-by-rule": {
    label: msg("Allowed by rule"),
    icon: <LuCircleCheck className="h-3.5 w-3.5" />,
    tone: "text-ok",
  },
  "allowed-by-approval": {
    label: msg("Allowed by approval"),
    icon: <LuKeyRound className="h-3.5 w-3.5" />,
    tone: "text-ok",
  },
  stranger: { label: msg("Turned away"), icon: <LuUserX className="h-3.5 w-3.5" />, tone: "text-warn" },
  answered: { label: msg("You answered"), icon: <LuShield className="h-3.5 w-3.5" />, tone: "text-accent" },
  browsed: { label: msg("Page opened"), icon: <LuGlobe className="h-3.5 w-3.5" />, tone: "text-fg-muted" },
  cleared: { label: msg("Log cleared"), icon: <LuTrash2 className="h-3.5 w-3.5" />, tone: "text-fg-muted" },
  flagged: { label: msg("Suspected injection"), icon: <LuShieldAlert className="h-3.5 w-3.5" />, tone: "text-warn" },
  trusted: { label: msg("You trusted"), icon: <LuShieldCheck className="h-3.5 w-3.5" />, tone: "text-ok" },
};

const FILTERS = [
  { id: "all", label: msg("Everything") },
  { id: "refused", label: msg("Refused") },
  { id: "allowed", label: msg("Allowed") },
  { id: "stranger", label: msg("Strangers") },
];

const when = (iso: string) => sinceThen(serverTime(iso), { dateAfterDays: 1, dateFormat: { month: "short", day: "numeric" } });

/**
 * What the agent was stopped from doing, and what it was let through on.
 *
 * Refusals used to go to the container log, which answers "is the guard
 * working" and not "what has my agent been asked to do this week" — the
 * question somebody actually has, and the one that tells you whether a rule is
 * pulling its weight or somebody should be a guest.
 */
export function AuditPage() {
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="h-full overflow-y-auto px-4 py-6">
      <div className="mx-auto w-full max-w-3xl">
        {error && <ErrorBanner className="mb-4" onClose={() => setError(null)}>{error}</ErrorBanner>}
        <AuditPanel onError={setError} />
      </div>
    </div>
  );
}

/** What was asked for, two lines of it and the whole with a click: a refused command is the one thing here worth reading to the end. */
function Subject({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <button
      type="button"
      onClick={() => setOpen((v) => !v)}
      aria-expanded={open}
      title={text}
      // `block` only when open: the clamp is a display of its own, and the later of the two rules would win.
      className={`mt-1 w-full break-all text-left font-mono text-[11px] text-fg-muted ${open ? "block whitespace-pre-wrap" : "line-clamp-2"}`}
    >
      {text}
    </button>
  );
}

function AuditPanel({ onError }: { onError: (e: string | null) => void }) {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [filter, setFilter] = useState("all");
  const [loading, setLoading] = useState(true);
  // Why the first read failed: an empty list and "0 refused" would say there is nothing to see, and the page tries again by itself only every ten seconds.
  const [failed, setFailed] = useState<string | null>(null);
  const had = useRef(false);
  const [clearing, setClearing] = useState(false);
  // Shown by the button, as MemoryPage's log does, so a poll that works does
  // not take it off the page banner before it is read.
  const [clearFailed, setClearFailed] = useState<string | null>(null);
  // Counts clears: an answer asked for before one must not bring the cleared
  // entries back when it arrives after it. Only clears, not every poll — on a
  // slow link each answer can land after the next poll went out, and must
  // still count.
  const cleared = useRef(0);

  const load = () => {
    const since = cleared.current;
    return api
      .audit(300)
      .then((r) => {
        if (since !== cleared.current) return;
        had.current = true;
        setFailed(null);
        setEntries(r.entries);
        onError(null);
      })
      .catch((e) => {
        if (since !== cleared.current) return;
        // A refresh of what is shown goes to the banner; with nothing read yet the page says it itself.
        if (had.current) onError((e as Error).message);
        else setFailed((e as Error).message);
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
    return pollWhileVisible(load, 10_000);
  }, []);

  // The "cleared" notes are housekeeping, not decisions, and a clear keeps them.
  const decisions = entries.filter((e) => e.kind !== "cleared");

  /**
   * The history up to the newest entry shown, after asking. Always asking: not
   * `deletes`, which Settings can switch off — this is the record of what the
   * guard decided, and one stray click should not end it.
   */
  const clear = async () => {
    if (decisions.length === 0) return;
    const through = Math.max(...entries.map((e) => e.id));
    const ok = await confirmDialog({
      title: t("Clear the audit log?"),
      message: t("Every recorded decision is deleted, not only the ones the filter shows. This cannot be undone."),
      confirmLabel: t("Clear the audit log"),
      danger: true,
    });
    if (!ok) return;
    setClearing(true);
    setClearFailed(null);
    try {
      await api.clearAudit(through);
      // Gone even if the reload below fails, which would otherwise leave the
      // deleted entries on screen. The notes stay, as they do on the server.
      cleared.current++;
      setEntries((now) => now.filter((e) => e.id > through || e.kind === "cleared"));
      await load();
    } catch (e) {
      setClearFailed((e as Error).message);
    } finally {
      setClearing(false);
    }
  };

  const shown = entries.filter((e) =>
    filter === "all"
      ? true
      : filter === "allowed"
        ? e.kind.startsWith("allowed")
        : e.kind === filter
  );

  if (loading) {
    return (
      <p className="flex items-center gap-2 text-sm text-fg-subtle">
        <LuRefreshCw className="h-3.5 w-3.5 animate-spin" /> {t("Loading…")}
      </p>
    );
  }

  if (failed && !had.current) return <LoadFailed error={failed} onRetry={load} />;

  const counts = {
    refused: entries.filter((e) => e.kind === "refused").length,
    allowed: entries.filter((e) => e.kind.startsWith("allowed")).length,
    strangers: entries.filter((e) => e.kind === "stranger").length,
  };

  return (
    <>
      <PageHeader
        icon={<LuShield />}
        title={t("Audit")}
        className="mb-5"
        description={
          <>
            {tp(decisions.length, "What the agent was stopped from doing, what it was let through on, and who was turned away. The last decision.", "What the agent was stopped from doing, what it was let through on, and who was turned away. The last {n} decisions.")}
          </>
        }
      >
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Stat value={counts.refused} label={t("refused")} tone="text-danger" />
          <Stat value={counts.allowed} label={t("allowed")} tone="text-ok" />
          <Stat value={counts.strangers} label={t("turned away")} tone="text-warn" />
        </div>
      </PageHeader>

      <div className="mb-3 flex flex-wrap items-center gap-1">
        <Segments label={t("Which decisions to show")} value={filter} options={FILTERS} onChange={setFilter} />
        <span className="ml-auto text-xs text-fg-faint">{shown.filter((e) => e.kind !== "cleared").length}</span>
        <button
          onClick={clear}
          disabled={decisions.length === 0 || clearing}
          className="ml-2 flex items-center gap-1 rounded-lg bg-fg/5 px-2.5 py-1 text-xs text-fg-muted transition hover:bg-danger/10 hover:text-danger disabled:pointer-events-none disabled:opacity-40"
        >
          <LuTrash2 className="h-3 w-3" /> {t("Clear the log")}
        </button>
      </div>
      {clearFailed && <p role="alert" className="mb-3 text-xs text-danger">{clearFailed}</p>}

      {shown.length === 0 ? (
        <p className="rounded-xl border border-dashed border-line px-3 py-6 text-center text-xs text-fg-faint">
          {decisions.length > 0
            ? t("Nothing matches this filter.")
            : t("Nothing recorded. The guard writes here when it refuses something, lets something through on a rule or an approval, or turns a stranger away.")}
        </p>
      ) : (
        <ul className="stagger-in space-y-1">
          {shown.map((e) => {
            const k = KIND[e.kind] ?? {
              label: e.kind,
              icon: <LuShield className="h-3.5 w-3.5" />,
              tone: "text-fg-muted",
            };
            return (
              <li key={e.id} className="rounded-xl border border-line bg-raised/40 px-3 py-2">
                <div className="flex items-center gap-2">
                  <span className={`shrink-0 ${k.tone}`}>{k.icon}</span>
                  <span className={`shrink-0 text-xs ${k.tone}`}>{t(k.label)}</span>
                  {e.person_name && (
                    <span className="truncate text-xs text-fg-muted">{e.person_name}</span>
                  )}
                  <span className="ml-auto shrink-0 text-[11px] text-fg-faint">{when(e.at)}</span>
                </div>
                {e.subject && <Subject text={`${e.tool ? `${e.tool}: ` : ""}${e.subject}`} />}
                {e.kind === "cleared" && Number.isFinite(Number(e.reason)) ? (
                  <p className="mt-0.5 text-[11px] text-fg-faint">
                    {tp(Number(e.reason), "One entry was deleted.", "{n} entries were deleted.")}
                  </p>
                ) : (
                  e.reason && <p className="mt-0.5 text-[11px] text-fg-faint">{e.reason}</p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
