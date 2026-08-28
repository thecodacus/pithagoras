import { useEffect, useMemo, useRef, useState } from "react";
import { api, type PiConfig, type PiModel, type Session } from "../api";
import { ContextPill } from "./ContextPill";

/**
 * pi's levels, and the same list the server falls back to.
 *
 * Seeded so the effort slider is usable on the first click: it is gated on
 * having levels, and waiting for the catalogue meant the popover opened empty.
 * Replaced by whatever pi actually reports once that arrives.
 */
const DEFAULT_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

const RECENTS_KEY = "pithagoras.recentModels";
const MAX_RECENTS = 4;

function readRecents(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENTS_KEY) || "[]");
    return Array.isArray(raw) ? raw.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function pushRecent(id: string): string[] {
  const next = [id, ...readRecents().filter((x) => x !== id)].slice(0, MAX_RECENTS);
  try {
    localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
  } catch {
    // Private mode or full storage — recents are a convenience, not a feature.
  }
  return next;
}

/** "Anthropic: Claude Sonnet 5" reads better as "Claude Sonnet 5". */
const shortName = (m: { name: string }) => m.name.split(":").pop()!.trim();

/**
 * Toolbar under the composer: the session's live model and effort level as
 * pills you can click to change, plus context usage.
 */
export function ComposerBar({
  sessionId,
  session,
  running,
  panelRequest,
  onPanelConsumed,
}: {
  sessionId: string;
  /** What the sidebar already knows, so the pills can paint immediately. */
  session: Session;
  running: boolean;
  /** Set by /model so the slash command opens the same picker as the pill. */
  panelRequest?: "model" | "effort" | null;
  onPanelConsumed?: () => void;
}) {
  // Seeded from the session row rather than starting empty. Waiting on a
  // request to draw the model name meant the pills appeared blank for as long
  // as the round trip took — and that request used to boot pi.
  const seed = (s: Session): PiConfig => ({
    live: false,
    state: {
      model: { id: s.model ?? "", name: s.model ?? "default", provider: s.provider ?? "" },
      thinkingLevel: s.thinking_level ?? "medium",
    },
    thinking: { levels: DEFAULT_LEVELS },
    models: { models: [] },
    stats: null,
  });

  const [cfg, setCfg] = useState<PiConfig>(() => seed(session));
  /** The catalogue is fetched separately, the first time a picker is opened. */
  const [catalogue, setCatalogue] = useState(false);
  const [open, setOpen] = useState<null | "model" | "effort">(null);
  const [showAll, setShowAll] = useState(false);
  const [filter, setFilter] = useState("");
  const [recents, setRecents] = useState<string[]>(readRecents);
  const [busy, setBusy] = useState(false);
  /** Where the handle sits mid-drag, before the change is sent. */
  const [dragEffort, setDragEffort] = useState<number | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  const load = () =>
    api
      .config(sessionId)
      .then((next) =>
        setCfg((prev) => ({
          ...next,
          // /config is the cheap route and reports neither, so anything already
          // known — seeded levels, a catalogue already fetched — is kept.
          thinking: next.thinking.levels.length ? next.thinking : prev.thinking,
          models: next.models.models.length ? next.models : prev.models,
        }))
      )
      .catch(() => {});

  useEffect(() => {
    setCfg(seed(session));
    setCatalogue(false);
    setOpen(null);
    setDragEffort(null);
    load();
  }, [sessionId]);

  // Only when a picker is actually opened, since this is the call that starts
  // pi to read the model catalogue.
  useEffect(() => {
    if (!open || catalogue) return;
    setCatalogue(true);
    api
      .models(sessionId)
      .then(setCfg)
      .catch(() => setCatalogue(false));
  }, [open]);

  // Refresh once a run ends so token and cost figures stay current.
  useEffect(() => {
    if (!running) load();
  }, [running]);

  useEffect(() => {
    if (!panelRequest) return;
    setOpen(panelRequest);
    onPanelConsumed?.();
  }, [panelRequest]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) {
        setOpen(null);
        setShowAll(false);
        setFilter("");
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const models = cfg.models.models ?? [];
  const byId = useMemo(() => new Map(models.map((m) => [m.id, m])), [models]);

  // Short list: models picked here before, plus the current one.
  const quick = useMemo(() => {
    const ids = [...recents];
    if (cfg.state.model.id && !ids.includes(cfg.state.model.id)) ids.push(cfg.state.model.id);
    return ids.map((id) => byId.get(id) ?? (id === cfg.state.model.id ? cfg.state.model : null)).filter(Boolean) as PiModel[];
  }, [recents, cfg, byId]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return (q ? models.filter((m) => (m.id + m.name).toLowerCase().includes(q)) : models).slice(0, 200);
  }, [models, filter]);

  const applyModel = async (id: string) => {
    setBusy(true);
    try {
      await api.setConfig(sessionId, { modelId: id });
      setRecents(pushRecent(id));
      await load();
      setOpen(null);
      setShowAll(false);
      setFilter("");
    } finally {
      setBusy(false);
    }
  };

  const levels = cfg.thinking.levels ?? [];
  const serverEffort = Math.max(0, levels.indexOf(cfg.state.thinkingLevel));
  // While dragging, the slider follows the pointer rather than the server. It
  // used to be disabled during the request, which dropped pointer capture and
  // ended the drag after a single step.
  const effortIndex = dragEffort ?? serverEffort;

  const commitEffort = async (index: number) => {
    const level = levels[index];
    if (!level || level === cfg.state.thinkingLevel) {
      setDragEffort(null);
      return;
    }
    setBusy(true);
    try {
      await api.setConfig(sessionId, { thinkingLevel: level });
      await load();
    } finally {
      setBusy(false);
      setDragEffort(null);
    }
  };

  return (
    <div ref={ref} className="relative mt-1.5 flex items-center gap-1 text-xs">
      <div className="ml-auto flex items-center gap-1">
        <button
          type="button"
          disabled={busy}
          onClick={() => setOpen(open === "model" ? null : "model")}
          className={`max-w-[220px] truncate rounded-lg px-2 py-1 transition disabled:opacity-50 ${
            open === "model" ? "bg-fg/10 text-fg" : "text-fg-subtle hover:bg-fg/5 hover:text-fg-muted"
          }`}
          title={cfg.state.model.id}
        >
          {shortName(cfg.state.model)}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => setOpen(open === "effort" ? null : "effort")}
          className={`rounded-lg px-2 py-1 capitalize transition disabled:opacity-50 ${
            open === "effort" ? "bg-fg/10 text-fg" : "text-fg-subtle hover:bg-fg/5 hover:text-fg-muted"
          }`}
          title="Effort / thinking level"
        >
          {cfg.state.thinkingLevel}
        </button>
        {cfg.stats && (
          <ContextPill
            sessionId={sessionId}
            cfg={cfg as PiConfig & { stats: NonNullable<PiConfig["stats"]> }}
            onChanged={load}
          />
        )}
        <span
          className={`ml-1 h-2 w-2 rounded-full ${running ? "animate-pulse bg-warn" : "bg-raised"}`}
          title={running ? "working" : "idle"}
        />
      </div>

      {/* Models */}
      {open === "model" && (
        <div className="absolute bottom-full right-0 mb-2 w-72 overflow-hidden rounded-xl border border-line bg-surface py-1 shadow-pop">
          <p className="px-3 py-1 text-[11px] text-fg-subtle">Models</p>
          {!showAll ? (
            <>
              {quick.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => applyModel(m.id)}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-fg hover:bg-raised"
                  title={m.id}
                >
                  <span className="truncate">{shortName(m)}</span>
                  {m.id === cfg.state.model.id && (
                    <span className="ml-auto text-fg-muted">✓</span>
                  )}
                </button>
              ))}
              <div className="my-1 border-t border-line" />
              <button
                type="button"
                disabled={!models.length}
                onClick={() => setShowAll(true)}
                className="flex w-full items-center px-3 py-1.5 text-left text-sm text-fg-muted transition hover:bg-fg/5 disabled:opacity-50"
              >
                {models.length ? "More models" : "Loading models…"}
                {models.length > 0 && <span className="ml-auto text-fg-subtle">›</span>}
              </button>
            </>
          ) : (
            <>
              <input
                autoFocus
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Filter models…"
                className="mx-2 mb-1 w-[calc(100%-1rem)] rounded border border-line bg-canvas px-2 py-1 text-xs outline-none focus:border-accent"
              />
              <div className="max-h-72 overflow-y-auto">
                {filtered.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => applyModel(m.id)}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-fg-muted hover:bg-raised"
                    title={m.id}
                  >
                    <span className="truncate">{shortName(m)}</span>
                    {m.id === cfg.state.model.id && (
                      <span className="ml-auto text-fg-muted">✓</span>
                    )}
                  </button>
                ))}
                {filtered.length === 0 && (
                  <p className="px-3 py-2 text-xs text-fg-subtle">No matches</p>
                )}
              </div>
            </>
          )}
        </div>
      )}

      {/* Effort */}
      {open === "effort" && levels.length > 0 && (
        <div className="absolute bottom-full right-0 mb-2 w-72 rounded-xl border border-line bg-surface p-3 shadow-pop">
          <p className="text-sm text-fg-muted">
            Effort <span className="capitalize text-fg">{levels[effortIndex] ?? cfg.state.thinkingLevel}</span>
          </p>
          <div className="mt-3 flex justify-between text-[11px] text-fg-subtle">
            <span>Faster</span>
            <span>Smarter</span>
          </div>
          <input
            type="range"
            min={0}
            max={levels.length - 1}
            step={1}
            value={effortIndex}
            onChange={(e) => setDragEffort(Number(e.target.value))}
            onPointerUp={(e) => commitEffort(Number(e.currentTarget.value))}
            onKeyUp={(e) => commitEffort(Number(e.currentTarget.value))}
            onBlur={(e) => commitEffort(Number(e.currentTarget.value))}
            className="mt-1 w-full accent-[rgb(var(--warn))]"
          />
          <div className="mt-1 flex justify-between">
            {levels.map((lvl) => (
              <span
                key={lvl}
                title={lvl}
                className={`h-1 w-1 rounded-full ${
                  lvl === levels[effortIndex] ? "bg-warn" : "bg-raised"
                }`}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
