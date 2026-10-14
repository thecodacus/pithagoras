import { LuBlocks, LuRefreshCw } from "react-icons/lu";
import { StatusDot } from "./StatusDot";
import { ToolSwitches } from "./ToolSwitches";
import { SubagentModelPicker, useSubagentChoice } from "./SubagentModelPicker";
import { useDismiss } from "../use-dismiss";
import { useLeaveRef } from "../motion";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { MENU_WIDTH, anchorLeft } from "../menu-anchor";
import { api, type PiConfig, type PiModel, type Session } from "../api";
import { serialSaver } from "../serial-saver";
import { local } from "../safe-storage";
import { cacheModels, cachedModels, catalogueFresh, forgetModels } from "../model-catalogue";
import { ContextPill } from "./ContextPill";
import { SwitchTrack } from "./SettingsUi";
import { t } from "../i18n";
import { EFFORT_LEVELS, effortLabel } from "../effort";

/**
 * pi's levels, and the same list the server falls back to.
 *
 * Seeded so the effort slider is usable on the first click: it is gated on
 * having levels, and waiting for the catalogue meant the popover opened empty.
 * Replaced by whatever pi actually reports once that arrives.
 */
const DEFAULT_LEVELS = EFFORT_LEVELS;

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
    const raw = JSON.parse(local.get(LEVELS_KEY) || "{}");
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

/** What was last reported for this model, or undefined when nothing has been. */
function knownLevels(provider: string | null | undefined, model: string | null | undefined): string[] | undefined {
  const known = readLevels()[levelsKey(provider ?? "", model ?? "")];
  return Array.isArray(known) && known.length && known.every((l) => typeof l === "string") ? known : undefined;
}

const cachedLevels = (provider: string | null | undefined, model: string | null | undefined) =>
  knownLevels(provider, model) ?? DEFAULT_LEVELS;

/**
 * For a chat naming no model: which model the levels kept under what it names
 * were last reported for. Without it, levels drawn from there could not be
 * told apart from another model's — the default's before it was changed —
 * nor from the same model's, and either stayed wrongly or went wrongly.
 */
const FOLLOWS_KEY = "pithagoras.thinkingLevelsFollow";

function readFollows(): Record<string, string> {
  try {
    const raw = JSON.parse(local.get(FOLLOWS_KEY) || "{}");
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

/** The model the levels a chat's first paint draws are for, when that is known. */
function levelsModel(provider: string | null | undefined, model: string | null | undefined): string | undefined {
  if (model) return levelsKey(provider ?? "", model);
  const known = readFollows()[levelsKey(provider ?? "", "")];
  return typeof known === "string" ? known : undefined;
}

/**
 * `named`: what the chat's row names, as the server read it — said only when
 * pi is on the model the row comes to. A chat naming no model follows the
 * default, and its first paint looks the levels up by what the row names —
 * its provider, if any, and no model — so they are kept there too, with the
 * model they were for, and the next chat like it draws the default's control
 * rather than the full slider.
 */
function cacheLevels(provider: string, model: string, levels: string[], named?: PiConfig["named"]) {
  if (!model || !levels.length) return;
  const follows = named && !named.model ? levelsKey(named.provider ?? "", "") : undefined;
  // Same as the catalogue: storage that will not take it is not worth failing the pill over.
  local.set(LEVELS_KEY, JSON.stringify({
    ...readLevels(),
    [levelsKey(provider, model)]: levels,
    ...(follows ? { [follows]: levels } : {}),
  }));
  if (follows) local.set(FOLLOWS_KEY, JSON.stringify({ ...readFollows(), [follows]: levelsKey(provider, model) }));
}

const RECENTS_KEY = "pithagoras.recentModels";
const MAX_RECENTS = 4;

/**
 * What a recent is kept by. Two providers can offer a model of the same id, and
 * keyed by the id alone the one picked last was shown for both. Recents kept
 * before this are bare ids; see `quick`.
 */
const modelKey = (m: { provider: string; id: string }) => `${m.provider}/${m.id}`;

/** The same model, where one side may not know its provider yet: a chat's seed, or pi's own default. */
const sameModel = (a: { provider: string; id: string }, b: { provider: string; id: string }) =>
  a.id === b.id && (!a.provider || !b.provider || a.provider === b.provider);

function readRecents(): string[] {
  try {
    const raw = JSON.parse(local.get(RECENTS_KEY) || "[]");
    return Array.isArray(raw) ? raw.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function pushRecent(id: string): string[] {
  const next = [id, ...readRecents().filter((x) => x !== id)].slice(0, MAX_RECENTS);
  // Private mode or full storage: recents are a convenience, not a feature.
  local.set(RECENTS_KEY, JSON.stringify(next));
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
      {o.local ? t("local") : o.label}
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
  turns,
  started = true,
  panelRequest,
  onPanelConsumed,
  actions,
}: {
  sessionId: string;
  /** What the sidebar already knows, so the pills can paint immediately. */
  session: Session;
  running: boolean;
  /** How many turns the transcript holds; each one that ends leaves pi with a new token count. */
  turns?: number;
  /**
   * Whether anything has been said in this conversation. Before that there is
   * no context to measure — pi reports 0%, and a meter that reads 0% is not
   * information, only a control that comes and goes with how the chat was made.
   */
  started?: boolean;
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
  /** Which model the levels drawn are for, when that is known; see load. */
  const levelsFor = useRef<string | undefined>(levelsModel(session.provider, session.model));
  /** True while a catalogue fetch is in flight — not "has one ever run". */
  const [loadingCatalogue, setLoadingCatalogue] = useState(false);
  const [open, setOpen] = useState<null | "model" | "effort" | "tools">(null);
  const navigate = useNavigate();
  const [showAll, setShowAll] = useState(false);
  const [filter, setFilter] = useState("");
  const [recents, setRecents] = useState<string[]>(readRecents);
  const [busy, setBusy] = useState(false);
  /** Why the last model picked was not taken, shown in the menu where it was picked. */
  const [pickError, setPickError] = useState<string | null>(null);
  /** Why the last change of effort was not taken: shown beside the pills, where the slider snapped back to the old level. */
  const [levelError, setLevelError] = useState<string | null>(null);
  /** Where the handle sits mid-drag, before the change is sent. */
  const [dragEffort, setDragEffort] = useState<number | null>(null);
  // Each menu opens over its own button; see menu-anchor.ts.
  const pills = { model: useRef<HTMLButtonElement>(null), effort: useRef<HTMLButtonElement>(null), tools: useRef<HTMLButtonElement>(null) };
  const [menuLeft, setMenuLeft] = useState<number | undefined>();
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => setMenuLeft(anchorLeft(pills[open].current, MENU_WIDTH));
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open]);

  // This component outlives a switch between chats: an answer for one that has
  // been left is not this one's, and must not draw its model or levels here.
  const currentSession = useRef(sessionId);
  currentSession.current = sessionId;

  const load = () => {
    const asked = sessionId;
    return api
      .config(asked)
      .then((next) => {
        cacheLevels(next.state.model.provider, next.state.model.id, next.thinking.levels, next.named);
        if (currentSession.current !== asked) return;
        // /config is the cheap route and reports neither when pi's catalogue
        // has not answered. The levels are then what was last reported for the
        // model it names — not for the one the seed guessed, which for a chat
        // with no model of its own (a fresh /new) was nothing at all, and drew
        // the full slider for a model that only switches on and off.
        //
        // Failing that, what is drawn stays, unless it is known to be another
        // model's: the default's, drawn first for a chat that follows it, once
        // the default has been changed. Not merely because the seed named no
        // model — that is every chat on the default, and the right control
        // went back to the full slider whenever the catalogue was slow. Nor for
        // pi's own default, which an idle chat cannot name: its answer says
        // "default", and there is nothing to tell the two apart by.
        const nextKey = levelsKey(next.state.model.provider, next.state.model.id);
        const known = knownLevels(next.state.model.provider, next.state.model.id);
        const unnamed = !next.live && next.state.model.id === "default";
        let thinking: PiConfig["thinking"] | null;
        if (next.thinking.levels.length) thinking = next.thinking;
        else if (known) thinking = { levels: known };
        else if (unnamed || levelsFor.current === undefined || levelsFor.current === nextKey) thinking = null;
        else thinking = { levels: DEFAULT_LEVELS };
        if (thinking) levelsFor.current = thinking.levels === DEFAULT_LEVELS ? undefined : nextKey;
        setCfg((prev) => ({
          ...next,
          thinking: thinking ?? prev.thinking,
          models: next.models.models.length ? next.models : prev.models,
        }));
      })
      .catch(() => {});
  };

  /** The chat shown now: what a change asked of another one says, when it settles, is not for this one. */
  const shown = useRef(sessionId);
  shown.current = sessionId;

  /** Whether the chat had started when last looked at — see the effect on `started`. */
  const wasStarted = useRef(started);
  useEffect(() => {
    levelsFor.current = levelsModel(session.provider, session.model);
    setCfg(seed(session));
    setOpen(null);
    setPickError(null);
    setLevelError(null);
    setBusy(false);
    setDragEffort(null);
    // Another chat, loaded here: its having started already is no change.
    wasStarted.current = started;
    load();
  }, [sessionId]);

  const refreshCatalogue = () => {
    const asked = sessionId;
    setLoadingCatalogue(true);
    api
      .models(asked)
      .then((next) => {
        cacheModels(next.models?.models ?? []);
        cacheLevels(next.state.model.provider, next.state.model.id, next.thinking.levels, next.named);
        if (currentSession.current !== asked) return;
        setCfg(next);
        levelsFor.current = levelsKey(next.state.model.provider, next.state.model.id);
      })
      .catch(() => {})
      .finally(() => setLoadingCatalogue(false));
  };

  // When there is nothing cached, or what is cached has expired or was dropped
  // because a provider changed (see model-catalogue.ts). Otherwise the list is
  // what you last saw until you ask for a new one — this call starts pi. The
  // list drawn meanwhile stays, so the menu is not empty while it loads.
  useEffect(() => {
    if (open === "model" && (!cfg.models.models.length || !catalogueFresh()) && !loadingCatalogue) refreshCatalogue();
  }, [open]);

  // Refresh once a run ends so token and cost figures stay current.
  useEffect(() => {
    if (!running) load();
  }, [running]);

  // And when the first thing is said. The meter is not drawn before that, and
  // what it would show is whatever was fetched while the chat was still empty —
  // nothing, for a chat pi had not started. A run that ends before the page has
  // seen it begin would otherwise leave it out until the next one.
  //
  // Only when it changes to started: a chat opened with messages in it is
  // loaded by the effects above, and a third request for the same would be
  // one more rebuild of the model catalogue.
  useEffect(() => {
    if (started && !wasStarted.current) load();
    wasStarted.current = started;
  }, [started]);

  // And after each turn of a run, when pi has the new token count: this used to
  // wait for the whole run to end, so the percentage sat still for as long as
  // the agent worked — the very time it is changing. Not while idle, where the
  // ticks of an old transcript being opened would only be requests for nothing.
  //
  // Only the figures are asked for, not the whole config: that one carries the
  // model catalogue, which pi rebuilds from each provider's credentials every
  // time it is asked, and a long run has a great many turns.
  useEffect(() => {
    if (!running || !turns) return;
    const asked = sessionId;
    api
      .stats(asked)
      .then((r) => {
        // An answer for a chat that has since been left is not this one's.
        if (r.stats && currentSession.current === asked) setCfg((prev) => ({ ...prev, stats: r.stats }));
      })
      .catch(() => {});
  }, [turns, running, sessionId]);

  useEffect(() => {
    if (!panelRequest) return;
    setOpen(panelRequest);
    onPanelConsumed?.();
  }, [panelRequest]);

  const menu = useRef<HTMLDivElement>(null);
  // Shut, a menu drops away as a picture of itself (see motion.ts).
  const menuRef = useLeaveRef<HTMLDivElement>("menu", menu);
  const trigger = open ? pills[open] : undefined;
  useDismiss(
    !!open,
    trigger ? [menu, trigger] : [menu],
    () => {
      setOpen(null);
      setShowAll(false);
      setFilter("");
      setPickError(null);
    },
    trigger,
  );

  // With the chat, not with the menu: ready by the time the menu opens.
  const subagents = useSubagentChoice(sessionId);
  const models = cfg.models.models ?? [];
  const byKey = useMemo(() => new Map(models.map((m) => [modelKey(m), m])), [models]);

  // Short list: models picked here before, plus the current one. A recent kept
  // before they were keyed by provider is a bare id: the first model of that id.
  const quick = useMemo(() => {
    const current = cfg.state.model;
    const keys = [...recents];
    if (current.id && !keys.some((k) => k === modelKey(current) || k === current.id)) keys.push(modelKey(current));
    const picked = keys
      .map((k) => byKey.get(k) ?? models.find((m) => m.id === k) ?? (k === modelKey(current) || k === current.id ? current : null))
      .filter(Boolean) as PiModel[];
    // Two recents can come to one model: an old bare id and the key it was kept under since.
    return picked.filter((m, i) => picked.findIndex((o) => modelKey(o) === modelKey(m)) === i);
  }, [recents, cfg, byKey, models]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return (q ? models.filter((m) => (m.id + m.name).toLowerCase().includes(q)) : models).slice(0, 200);
  }, [models, filter]);

  // The provider goes with the id: without it the server looks for the model
  // among the chat's own provider, and one that another provider lists is not found.
  const applyModel = async (m: PiModel) => {
    const asked = sessionId;
    setBusy(true);
    setPickError(null);
    try {
      await api.setConfig(sessionId, { provider: m.provider, modelId: m.id });
      setRecents(pushRecent(modelKey(m)));
      await load();
      setOpen(null);
      setShowAll(false);
      setFilter("");
    } catch (e) {
      if (shown.current === asked) setPickError((e as Error).message);
    } finally {
      if (shown.current === asked) setBusy(false);
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

  // Saves go out one at a time, and the last level picked is the one that
  // stays — see serialSaver. Not one request per move: a drag ends in pointerup
  // and then very likely a blur or keyup, all reading the same value before the
  // first save has come back, and the slider is not disabled while a save is
  // out, so a second level can be picked before the first returns. Held in a
  // ref-like memo so it is there for the very next event, before any re-render,
  // and made anew per chat so a level picked in one is never sent to another.
  const saver = useMemo(
    () =>
      serialSaver(
        (level: string) => api.setConfig(sessionId, { thinkingLevel: level }).then(() => {}),
        load,
      ),
    [sessionId],
  );

  const applyLevel = async (level: string | undefined) => {
    if (!level) {
      setDragEffort(null);
      return;
    }
    // A save is out: leave this level waiting for it, replacing any older one.
    // The comparison below would be against a level the server may already have left.
    if (saver.busy) {
      void saver.request(level);
      return;
    }
    if (level === cfg.state.thinkingLevel) {
      setDragEffort(null);
      return;
    }
    const asked = sessionId;
    setBusy(true);
    setLevelError(null);
    try {
      await saver.request(level);
    } catch (e) {
      if (shown.current === asked) setLevelError((e as Error).message);
    } finally {
      // Only now: the slider stays where it was dragged, and the controls stay
      // busy, until the last save has landed.
      if (shown.current === asked) {
        setBusy(false);
        setDragEffort(null);
      }
    }
  };
  const commitEffort = (index: number) => applyLevel(levels[index]);
  const flipThinking = () => applyLevel(thinkingOn ? "off" : onLevel);

  return (
    <div className="composer-toolbar relative text-xs">
      <div className="composer-settings">
        <button
          ref={pills.model}
          type="button"
          disabled={busy}
          onClick={() => setOpen(open === "model" ? null : "model")}
          aria-label={t("Model: {name}", { name: shortName(cfg.state.model) })}
          aria-haspopup="true"
          aria-expanded={open === "model"}
          className={`max-w-[220px] truncate rounded-lg px-2 py-1.5 transition disabled:opacity-50 ${
            open === "model" ? "bg-fg/10 text-fg" : "text-fg-subtle hover:bg-fg/5 hover:text-fg-muted"
          }`}
          title={cfg.state.model.id}
        >
          <span className="inline-flex items-center gap-1.5">
            {origin(cfg.state.model.provider).local && (
              <span className="h-1.5 w-1.5 rounded-full bg-ok" title={t("Running locally")} />
            )}
            {shortName(cfg.state.model)}
          </span>
        </button>
        <button
          ref={pills.effort}
          type="button"
          disabled={busy || fixed}
          // On/off models flip right here; there is no scale to open a panel for.
          onClick={() => (onOff ? flipThinking() : setOpen(open === "effort" ? null : "effort"))}
          aria-pressed={onOff ? thinkingOn : undefined}
          aria-label={onOff ? undefined : t("Effort: {level}", { level: effortLabel(cfg.state.thinkingLevel) })}
          aria-haspopup={onOff ? undefined : "true"}
          aria-expanded={onOff ? undefined : open === "effort"}
          className={`rounded-lg px-2 py-1 transition first-letter:uppercase disabled:opacity-50 ${
            open === "effort"
              ? "bg-fg/10 text-fg"
              : onOff && thinkingOn
                ? "text-warn hover:bg-fg/5"
                : "text-fg-subtle hover:bg-fg/5 hover:text-fg-muted"
          }`}
          title={
            onOff
              ? t("Thinking on / off")
              : fixed
                ? t("This model has a single thinking level")
                : t("Effort / thinking level")
          }
        >
          {onOff ? (thinkingOn ? t("thinking on") : t("thinking off")) : effortLabel(cfg.state.thinkingLevel)}
        </button>
        {/* Everything the agent may reach for in this conversation, the
            browser included — it brings tools like any other package, and a
            second switch of its own was two answers to one question. */}
        <button
          ref={pills.tools}
          type="button"
          onClick={() => setOpen(open === "tools" ? null : "tools")}
          aria-label={t("Which tools this conversation may use")}
          aria-haspopup="true"
          aria-expanded={open === "tools"}
          className={`rounded-lg px-2 py-1 transition ${
            open === "tools" ? "bg-fg/10 text-fg" : "text-fg-subtle hover:bg-fg/5 hover:text-fg-muted"
          }`}
          title={t("Which tools this conversation may use")}
        >
          <LuBlocks className="h-3.5 w-3.5" />
        </button>
        {cfg.stats && started && (
          <ContextPill
            sessionId={sessionId}
            cfg={cfg as PiConfig & { stats: NonNullable<PiConfig["stats"]> }}
            onChanged={load}
          />
        )}
        {levelError && <p role="alert" className="basis-full px-2 py-0.5 text-danger">{levelError}</p>}
        {/* The same mark as a working chat has in the lists, and its word shimmering as "Thinking" does. */}
        {running && (
          <span className="composer-working ml-1 inline-flex items-center gap-1.5">
            <StatusDot status="running" bare />
            <span className="working-text max-sm:hidden">{t("Working")}</span>
          </span>
        )}
      </div>
      {actions && <div className="composer-actions">{actions}</div>}

      {/* Tools */}
      {open === "tools" && (
        <div ref={menuRef} role="group" aria-label={t("Tools in this chat")} style={{ left: menuLeft }} className="composer-menu float-in absolute bottom-full left-0 z-20 mb-2 w-72 max-w-full overflow-hidden rounded-xl border border-line bg-surface py-1 shadow-pop">
          <p className="px-3 py-1 text-[11px] text-fg-subtle">{t("Tools in this chat")}</p>
          <ToolSwitches sessionId={sessionId} />
        </div>
      )}

      {/* Models */}
      {open === "model" && (
        <div ref={menuRef} role="group" aria-label={t("Models")} style={{ left: menuLeft }} className="composer-menu float-in absolute bottom-full left-0 z-20 mb-2 w-72 max-w-full overflow-hidden rounded-xl border border-line bg-surface py-1 shadow-pop">
          <div className="flex items-center gap-2 px-3 py-1">
            <p className="text-[11px] text-fg-subtle">{t("Models")}</p>
            {/* The cached copy goes first: a fetch that fails leaves nothing old behind for the next menu. */}
            <button
              type="button"
              onClick={() => { forgetModels(); refreshCatalogue(); }}
              disabled={loadingCatalogue}
              aria-label={t("Refresh models")}
              title={t("Re-read the list from pi — needed after starting a local server")}
              className="ml-auto rounded p-1 text-fg-faint transition hover:bg-fg/5 hover:text-fg disabled:opacity-50"
            >
              <LuRefreshCw className={`h-3.5 w-3.5 ${loadingCatalogue ? "animate-spin" : ""}`} aria-hidden />
            </button>
          </div>
          {!showAll ? (
            <>
              {quick.map((m) => (
                <button
                  key={modelKey(m)}
                  type="button"
                  onClick={() => applyModel(m)}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-fg hover:bg-raised"
                  title={m.id}
                >
                  <span className="truncate">{shortName(m)}</span>
                  {sameModel(m, cfg.state.model) && <span className="text-fg-muted">✓</span>}
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
                {models.length ? t("More models") : loadingCatalogue ? t("Loading models…") : t("No models — refresh")}
                {models.length > 0 && <span className="ml-auto text-fg-subtle">›</span>}
              </button>
            </>
          ) : (
            <>
              <input
                autoFocus
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder={t("Filter models…")}
                aria-label={t("Filter models…")}
                className="mx-2 mb-1 w-[calc(100%-1rem)] rounded border border-line bg-canvas px-2 py-1 text-xs outline-none focus:border-accent"
              />
              <div className="max-h-72 overflow-y-auto">
                {filtered.map((m) => (
                  <button
                    key={modelKey(m)}
                    type="button"
                    onClick={() => applyModel(m)}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-fg-muted hover:bg-raised"
                    title={m.id}
                  >
                    <span className="truncate">{shortName(m)}</span>
                    {sameModel(m, cfg.state.model) && <span className="text-fg-muted">✓</span>}
                    <OriginTag provider={m.provider} />
                  </button>
                ))}
                {filtered.length === 0 && (
                  <p className="px-3 py-2 text-xs text-fg-subtle">{t("No matches")}</p>
                )}
              </div>
            </>
          )}
          {pickError && <p role="alert" className="px-3 py-1 text-xs text-danger">{pickError}</p>}
          <SubagentModelPicker subagents={subagents} models={models} />
          <div className="my-1 border-t border-line" />
          <button
            type="button"
            // The menu goes with the click, and Settings gives focus back to what had it: the pill, not an item that is gone.
            onClick={() => { pills.model.current?.focus(); setOpen(null); navigate(`/s/${sessionId}/settings/models`); }}
            className="flex w-full items-center px-3 py-1.5 text-left text-xs text-fg-subtle transition hover:bg-fg/5 hover:text-fg"
          >
            {t("Add or change providers…")}
          </button>
        </div>
      )}

      {/* Effort */}
      {open === "effort" && levels.length > 1 && (
        <div ref={menuRef} role="group" aria-label={t("Effort")} style={{ left: menuLeft }} className="composer-menu float-in absolute bottom-full left-0 z-20 mb-2 w-72 max-w-full rounded-xl border border-line bg-surface p-3 shadow-pop">
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
              <span>{t("Thinking")}</span>
              <SwitchTrack on={thinkingOn} tone="warn" />
            </button>
          ) : (
            <>
              <p className="text-sm text-fg-muted">
                {t("Effort")} <span className="inline-block text-fg first-letter:uppercase">{effortLabel(levels[effortIndex] ?? cfg.state.thinkingLevel)}</span>
              </p>
              <div className="mt-3 flex justify-between text-[11px] text-fg-subtle">
                <span>{t("Faster")}</span>
                <span>{t("Smarter")}</span>
              </div>
              <input
                type="range"
                min={0}
                max={levels.length - 1}
                step={1}
                value={effortIndex}
                aria-label={t("Effort")}
                aria-valuetext={effortLabel(levels[effortIndex] ?? cfg.state.thinkingLevel)}
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

