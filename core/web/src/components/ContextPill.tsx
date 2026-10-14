import { useEffect, useRef, useState } from "react";
import { LuChevronRight, LuRefreshCw } from "react-icons/lu";
import { api, type PiConfig } from "../api";
import { parseWindow } from "../context-window";
import { KeepRecent, useKeepRecentSave } from "./KeepRecent";
import { SwitchTrack } from "./SettingsUi";
import { isEnter } from "../shortcuts";
import { MENU_WIDTH, anchorLeft } from "../menu-anchor";
import { useDismiss } from "../use-dismiss";
import { useLeaveRef } from "../motion";
import { formatNumber, t } from "../i18n";

/**
 * Context fill is the number that decides whether a long session keeps working,
 * so it gets a permanent readout rather than a tooltip: a donut that fills and
 * changes colour, opening onto everything context-related in one place.
 */

const RING = { r: 7, stroke: 3 };
const CIRC = 2 * Math.PI * RING.r;

/** Green while there's room, amber once compaction is near, red when it's close. */
function tone(pct: number) {
  if (pct >= 90) return { stroke: "stroke-danger", text: "text-danger", bar: "bg-danger" };
  if (pct >= 50) return { stroke: "stroke-warn", text: "text-warn", bar: "bg-warn" };
  return { stroke: "stroke-ok", text: "text-ok", bar: "bg-ok" };
}

/**
 * What the model can really hold — the number the percentage and the moment of
 * compaction are measured against.
 *
 * pi takes it from the model's definition, which cannot know how the server is
 * run: llama.cpp with `--parallel 2` gives each chat half of `ctx-size`, so a
 * chat compacts far too late and then fails at the server. This is where it is
 * put right for one model, and it holds for every chat that uses it. A default
 * for all models is in Settings; what is set here wins over it.
 */
function ContextWindow({
  cfg,
  onChanged,
  onError,
}: {
  cfg: PiConfig;
  onChanged: () => Promise<void> | void;
  onError: (error: Error) => void;
}) {
  const { provider, id } = cfg.state.model;
  const limit = cfg.contextLimit ?? null;

  const fallback = cfg.contextDefault ?? null;
  const declared = cfg.models.models.find((m) => m.id === id && m.provider === provider)?.contextWindow;
  // The default is a ceiling: a model that declares less keeps its own.
  const byDefault = fallback ? (declared ? Math.min(declared, fallback) : fallback) : declared;
  // Not `??`: pi reports 0, not nothing, when it cannot work a window out.
  const measured = cfg.stats?.contextUsage.contextWindow;
  const shown = measured && measured > 0 ? measured : (limit ?? byDefault);
  const source = limit
    ? t("set for this model")
    : fallback && (!declared || fallback < declared)
      ? t("default from Settings")
      : declared
        ? t("from the model")
        : "";
  const [text, setText] = useState(shown ? String(shown) : "");
  /** Whether the field has been typed in, as opposed to showing what is set. */
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);

  const restore = () => {
    setText(shown ? String(shown) : "");
    setDirty(false);
  };

  // Follows the server when the number changes there, and leaves what is being
  // typed alone while it does not.
  useEffect(restore, [shown, limit]);

  const save = async (tokens: number | null) => {
    setBusy(true);
    try {
      await api.setContextLimit(provider, id, tokens);
      await onChanged();
    } catch (e) {
      onError(e as Error);
      restore();
    } finally {
      setBusy(false);
    }
  };

  const commit = () => {
    if (!dirty) return;
    const parsed = parseWindow(text);
    if (parsed.kind === "empty") return restore();
    if (parsed.kind === "bad") {
      onError(new Error(parsed.message));
      return restore();
    }
    // Against what is set for this model, not what is in force: typing the number
    // the default already gives is how a model is pinned to it.
    if (parsed.tokens === limit) return restore();
    setDirty(false);
    void save(parsed.tokens);
  };

  return (
    <div className="rounded-lg bg-raised/40 px-2 py-2">
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-sm text-fg">{t("Context window")}</p>
        <p className="text-[11px] text-fg-subtle">{source}</p>
      </div>
      <div className="mt-1.5 flex items-center gap-1.5">
        <input
          type="text"
          inputMode="numeric"
          value={text}
          disabled={busy}
          aria-label={t("Context window in tokens")}
          onChange={(e) => {
            setText(e.target.value);
            setDirty(true);
          }}
          onBlur={commit}
          onKeyDown={(e) => isEnter(e) && e.currentTarget.blur()}
          className="min-w-0 flex-1 rounded-md border border-line bg-surface px-2 py-1 text-sm tabular-nums text-fg disabled:opacity-50"
        />
        {limit ? (
          <button
            type="button"
            disabled={busy}
            // Keeps focus in the field, so it is not left first: leaving it commits what
            // was typed, which disables this button before the click can land.
            onMouseDown={(e) => e.preventDefault()}
            title={
              byDefault
                ? fallback && byDefault === fallback
                  ? t("Back to {n}, the default from Settings", { n: formatNumber(byDefault) })
                  : t("Back to {n}, what the model says", { n: formatNumber(byDefault) })
                : t("Back to what the model says")
            }
            onClick={() => {
              setDirty(false);
              void save(null);
            }}
            className="shrink-0 rounded-md px-2 py-1 text-xs text-fg-muted hover:bg-raised disabled:opacity-50"
          >
            {t("Reset")}
          </button>
        ) : null}
      </div>
      <p className="mt-1.5 text-[11px] text-fg-faint">
        {t("What the server holds for one chat. Applies to every chat on this model.")}
      </p>
    </div>
  );
}

function Donut({ pct, color }: { pct: number; color: string }) {
  const filled = Math.max(0, Math.min(100, pct));
  return (
    <svg width={18} height={18} viewBox="0 0 18 18" className="-rotate-90">
      <circle cx={9} cy={9} r={RING.r} fill="none" className="stroke-fg/15" strokeWidth={RING.stroke} />
      <circle
        cx={9}
        cy={9}
        r={RING.r}
        fill="none"
        strokeWidth={RING.stroke}
        strokeLinecap="round"
        strokeDasharray={`${(filled / 100) * CIRC} ${CIRC}`}
        className={`${color} transition-[stroke-dasharray] duration-500`}
      />
    </svg>
  );
}

export function ContextPill({
  sessionId,
  cfg,
  onChanged,
}: {
  sessionId: string;
  /** Only rendered once pi is live, so the stats are known to be there. */
  cfg: PiConfig & { stats: NonNullable<PiConfig["stats"]> };
  /** Stats move after compaction and after toggling auto-compaction. */
  onChanged: () => Promise<void> | void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<null | "compact" | "auto">(null);
  /** Read when the popup opens rather than with the transcript — it is pi's file. */
  const [keepRecent, setKeepRecent] = useState<number | null>(null);
  /** pi refuses to compact a short session, so its reason has to be visible. */
  const [note, setNote] = useState<{ text: string; error: boolean } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const pill = useRef<HTMLButtonElement>(null);
  const card = useLeaveRef<HTMLDivElement>("menu");

  useEffect(() => {
    if (!open || keepRecent !== null) return;
    api
      .settings()
      .then((r) => setKeepRecent(r.compaction.keepRecentTokens))
      .catch(() => {});
  }, [open, keepRecent]);

  useDismiss(open, [ref], () => setOpen(false), pill);

  const usage = cfg.stats.contextUsage;
  // Unknown just after a compaction, until the next reply is counted. An empty
  // ring and a dash say so; 0% claimed the summary and the recent turns weighed nothing.
  const known = usage.percent !== null && usage.tokens !== null;
  const pct = usage.percent ?? 0;
  const look = tone(pct);
  const auto = cfg.state.autoCompactionEnabled !== false;

  const compactNow = async () => {
    setBusy("compact");
    setNote(null);
    try {
      await api.compact(sessionId);
      await onChanged();
      setNote({ text: t("Compacted."), error: false });
    } catch (e) {
      setNote({ text: (e as Error).message, error: true });
    } finally {
      setBusy(null);
    }
  };

  /**
   * Saved when the drag ends, not on every step, and applied to open sessions
   * by the server — including this one, so the next compaction uses it.
   */
  const saveKeepRecent = useKeepRecentSave(
    (compaction) => setKeepRecent(compaction.keepRecentTokens),
    (error) => setNote({ text: error.message, error: true }),
  );

  const toggleAuto = async () => {
    setBusy("auto");
    setNote(null);
    try {
      await api.setConfig(sessionId, { autoCompaction: !auto });
      await onChanged();
    } catch (e) {
      setNote({ text: (e as Error).message, error: true });
    } finally {
      setBusy(null);
    }
  };

  const rows: [string, string][] = [
    [t("Input"), formatNumber(cfg.stats.tokens.input)],
    [t("Output"), formatNumber(cfg.stats.tokens.output)],
    [t("Messages"), formatNumber(cfg.stats.totalMessages ?? 0)],
    [t("Tool calls"), formatNumber(cfg.stats.toolCalls ?? 0)],
    [t("Cost"), `$${formatNumber(cfg.stats.cost, { minimumFractionDigits: 4, maximumFractionDigits: 4 })}`],
  ];

  // The donut says it in colour; the pill says it in words, as its name and its tooltip.
  const fullness = known ? t("Context {n}% full", { n: formatNumber(pct, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) }) : t("Context: counted again at the next reply");

  return (
    // Not positioned itself: the card is placed in the toolbar, over this pill
    // (see menu-anchor.ts), rather than hanging leftwards off its right edge.
    <div ref={ref}>
      <button
        ref={pill}
        type="button"
        onClick={() => setOpen(!open)}
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={fullness}
        title={fullness}
        className={`flex items-center gap-1.5 rounded px-2 py-1 ${
          open ? "bg-raised" : "hover:bg-raised"
        }`}
      >
        <Donut pct={pct} color={look.stroke} />
        <span className={`tabular-nums ${known ? look.text : "text-fg-subtle"}`}>{known ? `${pct.toFixed(0)}%` : "–"}</span>
      </button>

      {open && (
        <div ref={card} role="group" aria-label={t("Context")} style={{ left: anchorLeft(pill.current, MENU_WIDTH) }} className="composer-menu float-in absolute bottom-full left-0 z-20 mb-2 w-72 max-w-full rounded-xl border border-line bg-surface p-3 shadow-pop">
          <div className="flex items-baseline justify-between">
            <p className="text-sm text-fg-muted">{t("Context")}</p>
            <p className={`text-sm tabular-nums ${known ? look.text : "text-fg-subtle"}`}>{known ? t("{n}% full", { n: formatNumber(pct, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) }) : t("just compacted")}</p>
          </div>

          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-raised">
            <div
              className={`h-full rounded-full transition-all duration-500 ${look.bar}`}
              style={{ width: `${Math.min(100, pct)}%` }}
            />
          </div>
          <p className="mt-1.5 text-[11px] tabular-nums text-fg-subtle">
            {usage.tokens !== null ? (
              <>
                {t("{used} of {all} tokens · {left} left", { used: formatNumber(usage.tokens), all: formatNumber(usage.contextWindow), left: formatNumber(Math.max(0, usage.contextWindow - usage.tokens)) })}
              </>
            ) : (
              <>{t("Counted again with the next reply · {n} tokens in all", { n: formatNumber(usage.contextWindow) })}</>
            )}
          </p>

          <div className="my-3 border-t border-line" />

          {cfg.contextLimitSupported === false ? (
            <p className="rounded-lg bg-raised/40 px-2 py-2 text-[11px] text-fg-faint">
              {cfg.contextLimitNote ?? t("The context window cannot be changed here.")}
            </p>
          ) : (
            <ContextWindow cfg={cfg} onChanged={onChanged} onError={(e) => setNote({ text: e.message, error: true })} />
          )}

          <div className="my-3 border-t border-line" />

          <button
            type="button"
            role="switch"
            aria-checked={auto}
            onClick={toggleAuto}
            disabled={busy !== null}
            className="flex w-full items-center gap-2 rounded-lg px-1 py-1.5 text-left hover:bg-raised disabled:opacity-50"
          >
            <div className="min-w-0 flex-1">
              <p className="text-sm text-fg">{t("Auto-compact")}</p>
              <p className="text-[11px] text-fg-subtle">{t("Summarise automatically before it fills")}</p>
            </div>
            <SwitchTrack on={auto} />
          </button>

          {keepRecent !== null && (
            <div className="mt-2 rounded-lg bg-raised/40 px-2 py-2">
              <KeepRecent
                value={keepRecent}
                contextWindow={usage.contextWindow}
                onChange={setKeepRecent}
                onCommit={saveKeepRecent}
                disabled={busy !== null}
              />
              <p className="mt-1.5 text-[11px] text-fg-faint">
                {t("Kept word for word; only what is older is summarised. This is where a compaction lands, before the summary is added.")}
              </p>
            </div>
          )}

          <button
            type="button"
            onClick={compactNow}
            disabled={busy !== null}
            className="mt-1 flex w-full items-center gap-2 rounded-lg px-1 py-1.5 text-left hover:bg-raised disabled:opacity-50"
          >
            <div className="min-w-0 flex-1">
              <p className="text-sm text-fg">{t("Compact now")}</p>
              <p className="text-[11px] text-fg-subtle">{t("Summarise the conversation so far")}</p>
            </div>
            {busy === "compact" ? (
              <LuRefreshCw className="h-4 w-4 shrink-0 animate-spin text-fg-muted" />
            ) : (
              <LuChevronRight className="h-4 w-4 shrink-0 text-fg-faint" />
            )}
          </button>

          {note && (
            <p className={`mt-2 text-[11px] ${note.error ? "text-danger" : "text-ok"}`}>
              {note.text}
            </p>
          )}

          <div className="my-3 border-t border-line" />

          <dl className="space-y-1">
            {rows.map(([label, value]) => (
              <div key={label} className="flex justify-between text-[11px]">
                <dt className="text-fg-subtle">{label}</dt>
                <dd className="tabular-nums text-fg-muted">{value}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}
    </div>
  );
}
