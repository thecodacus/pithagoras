import { LuGlobe } from "react-icons/lu";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
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

/**
 * The model catalogue, kept between sessions and reloads.
 *
 * Fetching it starts pi and enumerates a few hundred models, which is slow
 * enough that opening the picker sat on "Loading models…" every time. The
 * providers are portal-wide, so one cache serves every session, and it is only
 * refetched when somebody asks — a model list does not change on its own.
 */
const CATALOGUE_KEY = "modelCatalogue.v1";

function cachedModels(): PiModel[] {
  try {
    const raw = localStorage.getItem(CATALOGUE_KEY);
    return raw ? (JSON.parse(raw) as PiModel[]) : [];
  } catch {
    return [];
  }
}

const cacheModels = (models: PiModel[]) => {
  try {
    if (models.length) localStorage.setItem(CATALOGUE_KEY, JSON.stringify(models));
  } catch {
    // A full quota is not worth failing a dropdown over.
  }
};

/**
 * What pi last reported for each model.
 *
 * The seeded list above is right for no model in particular: one that offers
 * two levels drew a seven-stop slider until the first response arrived. A
 * model's levels only change when its config does, so the last answer is a
 * better first guess than the full list.
 */
const LEVELS_KEY = "pithagoras.thinkingLevels";

const levelsKey = (provider: string | undefined, model: string | undefined) => `${provider ?? ""}:${model ?? ""}`;

function readLevels(): Record<string, string[]> {
  try {
    const raw = JSON.parse(localStorage.getItem(LEVELS_KEY) || "{}");
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

function cachedLevels(provider: string | null | undefined, model: string | null | undefined): string[] {
  const known = readLevels()[levelsKey(provider ?? "", model ?? "")];
  return Array.isArray(known) && known.length && known.every((l) => typeof l === "string") ? known : DEFAULT_LEVELS;
}

function cacheLevels(provider: string, model: string, levels: string[]) {
  if (!model || !levels.length) return;
  try {
    localStorage.setItem(LEVELS_KEY, JSON.stringify({ ...readLevels(), [levelsKey(provider, model)]: levels }));
  } catch {
    // Same as the catalogue: a full quota is not worth failing the pill over.
  }
}

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
 * Where a model actually runs.
 *
 * A local provider is spelled `llama-server=http://host:port`, so the interesting
 * part is the scheme rather than the name — anything pointing at a URL is
 * something you are hosting, and everything else is somebody else's API.
 */
function origin(provider: string): { label: string; local: boolean } {
  if (/^(llama|llamacpp|llama-server|local|ollama|lmstudio|vllm)/i.test(provider) || provider.includes("://")) {
    return { label: provider.split("=")[0] || "local", local: true };
  }
  return { label: provider, local: false };
}

/** A word saying whose machine answers, because the model name never says. */
function OriginTag({ provider }: { provider: string }) {
  const o = origin(provider);
  return (
    <span
      title={provider}
      className={`ml-auto shrink-0 rounded px-1.5 py-0.5 text-[10px] ${
        o.local ? "bg-ok/10 text-ok" : "bg-fg/5 text-fg-subtle"
      }`}
    >
      {o.local ? "local" : o.label}
    </span>
  );
}

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
  actions,
}: {
  sessionId: string;
  /** What the sidebar already knows, so the pills can paint immediately. */
  session: Session;
  running: boolean;
  /** Set by /model so the slash command opens the same picker as the pill. */
  panelRequest?: "model" | "effort" | null;
  onPanelConsumed?: () => void;
  actions?: ReactNode;
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
    thinking: { levels: cachedLevels(s.provider, s.model) },
    models: { models: cachedModels() },
    stats: null,
  });

  const [cfg, setCfg] = useState<PiConfig>(() => seed(session));
  /** True while a catalogue fetch is in flight — not "has one ever run". */
  const [loadingCatalogue, setLoadingCatalogue] = useState(false);
  const [open, setOpen] = useState<null | "model" | "effort">(null);
  const [browser, setBrowser] = useState(false);
  const [hasBrowser, setHasBrowser] = useState(false);

  // The browser is optional and its answer changes only when somebody starts a
  // container, so this is asked once per session rather than polled.
  useEffect(() => {
    api
      .browser()
      .then((b) => {
        setHasBrowser(b.running || b.sessions.length > 0);
        setBrowser(b.sessions.some((x) => x.id === sessionId));
      })
      .catch(() => setHasBrowser(false));
  }, [sessionId]);
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
      .then((next) => {
        cacheLevels(next.state.model.provider, next.state.model.id, next.thinking.levels);
        setCfg((prev) => ({
          ...next,
          // /config is the cheap route and reports neither, so anything already
          // known — seeded levels, a catalogue already fetched — is kept.
          thinking: next.thinking.levels.length ? next.thinking : prev.thinking,
          models: next.models.models.length ? next.models : prev.models,
        }));
      })
      .catch(() => {});

  useEffect(() => {
    setCfg(seed(session));
    setOpen(null);
    setDragEffort(null);
    load();
  }, [sessionId]);

  const refreshCatalogue = () => {
    setLoadingCatalogue(true);
    api
      .models(sessionId)
      .then((next) => {
        setCfg(next);
        cacheModels(next.models?.models ?? []);
      })
      .catch(() => {})
      .finally(() => setLoadingCatalogue(false));
  };

  // Only when there is nothing cached at all. After that the list is what you
  // last saw until you ask for a new one — this call starts pi.
  useEffect(() => {
    if (open === "model" && !cfg.models.models.length && !loadingCatalogue) refreshCatalogue();
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

  // A model that only switches thinking on or off has no scale to slide along:
  // its levels are "off" and one other. One level at all leaves nothing to set.
  const onOff = levels.length === 2 && levels.includes("off");
  const onLevel = levels.find((l) => l !== "off") ?? "";
  const thinkingOn = cfg.state.thinkingLevel !== "off";
  const fixed = levels.length <= 1;

  // The levels being saved right now. A drag ends in pointerup and then very
  // likely a blur or keyup, all reading the same value before the first save
  // has come back — and until it has, the comparison below is still against the
  // old level, so each of them would save it again. A ref, not state: it has to
  // be visible to the very next event, before any re-render.
  //
  // A set rather than one slot, because the slider is not disabled while a save
  // is out: a second level can start before the first returns, and each request
  // must only clear itself. One slot let the first to finish wipe the other's
  // entry and end the busy state early.
  const saving = useRef(new Set<string>());

  const applyLevel = async (level: string | undefined) => {
    if (!level || level === cfg.state.thinkingLevel) {
      setDragEffort(null);
      return;
    }
    if (saving.current.has(level)) return;
    saving.current.add(level);
    setBusy(true);
    try {
      await api.setConfig(sessionId, { thinkingLevel: level });
      await load();
    } finally {
      saving.current.delete(level);
      // Only when nothing else is still out: the slider stays where it was
      // dragged, and the controls stay busy, until the last save has landed.
      if (saving.current.size === 0) {
        setBusy(false);
        setDragEffort(null);
      }
    }
  };
  const commitEffort = (index: number) => applyLevel(levels[index]);
  const flipThinking = () => applyLevel(thinkingOn ? "off" : onLevel);

  return (
    <div ref={ref} className="composer-toolbar relative text-xs">
      <div className="composer-settings">
        <button
          type="button"
          disabled={busy}
          onClick={() => setOpen(open === "model" ? null : "model")}
          className={`max-w-[220px] truncate rounded-lg px-2 py-1.5 transition disabled:opacity-50 ${
            open === "model" ? "bg-fg/10 text-fg" : "text-fg-subtle hover:bg-fg/5 hover:text-fg-muted"
          }`}
          title={cfg.state.model.id}
        >
          <span className="inline-flex items-center gap-1.5">
            {origin(cfg.state.model.provider).local && (
              <span className="h-1.5 w-1.5 rounded-full bg-ok" title="Running locally" />
            )}
            {shortName(cfg.state.model)}
          </span>
        </button>
        <button
          type="button"
          disabled={busy || fixed}
          // On/off models flip right here; there is no scale to open a panel for.
          onClick={() => (onOff ? flipThinking() : setOpen(open === "effort" ? null : "effort"))}
          aria-pressed={onOff ? thinkingOn : undefined}
          className={`rounded-lg px-2 py-1 capitalize transition disabled:opacity-50 ${
            open === "effort"
              ? "bg-fg/10 text-fg"
              : onOff && thinkingOn
                ? "text-warn hover:bg-fg/5"
                : "text-fg-subtle hover:bg-fg/5 hover:text-fg-muted"
          }`}
          title={
            onOff
              ? "Thinking on / off"
              : fixed
                ? "This model has a single thinking level"
                : "Effort / thinking level"
          }
        >
          {onOff ? `thinking ${thinkingOn ? "on" : "off"}` : cfg.state.thinkingLevel}
        </button>
        {/* Only where there is a browser to grant. On a deployment without the
            optional service this is not a disabled control, it is nothing. */}
        {hasBrowser && (
          <button
            onClick={async () => {
              const next = !browser;
              setBrowser(next);
              try {
                await api.setSessionBrowser(sessionId, next);
              } catch {
                setBrowser(!next);
              }
            }}
            className={`rounded-lg px-2 py-1 transition ${
              browser ? "bg-accent/12 text-accent" : "text-fg-subtle hover:bg-fg/5 hover:text-fg-muted"
            }`}
            title={
              browser
                ? "Browser on for this session — takes effect on its next start"
                : "Let this session drive the agent's browser"
            }
          >
            <LuGlobe className="h-3.5 w-3.5" />
          </button>
        )}
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
      {actions && <div className="composer-actions">{actions}</div>}

      {/* Models */}
      {open === "model" && (
        <div className="absolute bottom-full right-0 mb-2 w-72 overflow-hidden rounded-xl border border-line bg-surface py-1 shadow-pop">
          <div className="flex items-center gap-2 px-3 py-1">
            <p className="text-[11px] text-fg-subtle">Models</p>
            <button
              type="button"
              onClick={refreshCatalogue}
              disabled={loadingCatalogue}
              title="Re-read the list from pi — needed after starting a local server"
              className="ml-auto rounded px-1 text-[11px] text-fg-faint transition hover:text-fg disabled:opacity-50"
            >
              {loadingCatalogue ? "refreshing…" : "refresh"}
            </button>
          </div>
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
                  {m.id === cfg.state.model.id && <span className="text-fg-muted">✓</span>}
                  <OriginTag provider={m.provider} />
                </button>
              ))}
              <div className="my-1 border-t border-line" />
              <button
                type="button"
                disabled={!models.length}
                onClick={() => setShowAll(true)}
                className="flex w-full items-center px-3 py-1.5 text-left text-sm text-fg-muted transition hover:bg-fg/5 disabled:opacity-50"
              >
                {models.length ? "More models" : loadingCatalogue ? "Loading models…" : "No models — refresh"}
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
                    {m.id === cfg.state.model.id && <span className="text-fg-muted">✓</span>}
                    <OriginTag provider={m.provider} />
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
      {open === "effort" && levels.length > 1 && (
        <div className="absolute bottom-full right-0 mb-2 w-72 rounded-xl border border-line bg-surface p-3 shadow-pop">
          {onOff ? (
            // Reached through /effort; the pill flips the same switch directly.
            <button
              type="button"
              role="switch"
              aria-checked={thinkingOn}
              disabled={busy}
              onClick={flipThinking}
              className="flex w-full items-center justify-between text-sm text-fg-muted disabled:opacity-50"
            >
              <span>Thinking</span>
              <span className={`relative h-5 w-9 rounded-full transition ${thinkingOn ? "bg-warn" : "bg-raised"}`}>
                <span
                  className={`absolute top-0.5 h-4 w-4 rounded-full bg-surface transition-all ${
                    thinkingOn ? "left-[1.125rem]" : "left-0.5"
                  }`}
                />
              </span>
            </button>
          ) : (
            <>
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
            </>
          )}
        </div>
      )}
    </div>
  );
}
