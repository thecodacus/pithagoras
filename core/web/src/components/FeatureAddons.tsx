import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { LuBot, LuBrain, LuCheck, LuDownload, LuMinus, LuPlus, LuRefreshCw, LuTrash2, LuTriangleAlert } from "react-icons/lu";
import { api, type AvailableModel, type Features, type ImagesFeaturePatch, type ManagedUnderstory, type SubagentMode, type UnderstoryLlmChoice, type VideosFeaturePatch } from "../api";
import { MAX_SIZE, TIMEOUT_SECONDS } from "../../../server/src/image-settings";
import { VIDEO_LIMITS, VIDEO_TIMEOUT_SECONDS } from "../../../server/src/video-settings";
import { confirmDialog } from "./ConfirmDialog";
import { useUnsavedDraft } from "./Modal";
import { forgetNoteDrafts } from "../note-drafts";
import { Select } from "./Select";
import { CollapsibleSection, DetailsGroup, LoadFailed, SwitchRow, inputCls, primaryCls } from "./SettingsUi";
import { local } from "../safe-storage";
import { formatDateTime, msg, t, tp, tx } from "../i18n";

/**
 * The opt-in add-ons: off in a fresh install, one switch each. Each is written
 * into pi's own configuration — a package, an MCP server — so what the switch
 * does can also be seen, and undone, from Extensions and MCP.
 */

/** All the features at once, which is what Understory's tab reads: Subagents and Images each read their own. */
function useFeatures() {
  return useFirstRead(api.features);
}

/**
 * A tab's first read. Until it has come there is nothing to show, so a failure
 * is said where the tab would be, with a way to try again; a banner over a tab
 * that spins on forever said it too quietly.
 */
function useFirstRead<T>(read: () => Promise<T>) {
  const [value, setValue] = useState<T | null>(null);
  const [failed, setFailed] = useState<Error | null>(null);
  const retry = () =>
    read().then(
      (v) => {
        setFailed(null);
        setValue(v);
      },
      (e: Error) => setFailed(e),
    );
  useEffect(() => {
    void retry();
  }, []);
  return [value, setValue, failed, retry] as const;
}

/** What a switch did to the chats that are open. */
function reloadNote(waiting: number): string {
  return waiting
    ? tp(waiting, "Idle chats have it now; one busy chat picks it up once it is idle and reloaded (/reload).", "Idle chats have it now; {n} busy chats pick it up once they are idle and reloaded (/reload).")
    : t("Chats have it from now on.");
}

function Header({ Icon, title, children }: { Icon: typeof LuBot; title: string; children: ReactNode }) {
  return (
    <div className="flex items-start gap-2.5">
      <div className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-accent/10 text-accent">
        <Icon className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm text-fg">{title}</p>
        <p className="mt-0.5 text-[11px] text-fg-faint">{children}</p>
      </div>
    </div>
  );
}

const MODES: { value: SubagentMode; label: string; detail: string }[] = [
  {
    value: "interrupt",
    label: msg("Interrupt"),
    detail: msg("The agent waits for the subagent's answer before it goes on. One agent works at a time — safe on a single GPU or a local model."),
  },
  {
    value: "background",
    label: msg("Background"),
    detail: msg("The agent goes on working while the subagent runs, and its answer arrives as a message when it is done. The agent and its subagent run at once: on local hosting that is two model calls at the same time."),
  },
];

export function SubagentAddon({ onError }: { onError: (e: string) => void }) {
  // Its own, not with Understory's: a Docker that cannot be reached is not this tab's to wait on.
  const [subagent, setSubagent, failed, retry] = useFirstRead(() => api.subagentFeature().then((r) => r.subagent));
  const [busy, setBusy] = useState(false);
  // Said in the language shown, whenever it is drawn.
  const [note, setNote] = useState<(() => string) | null>(null);
  const name = useId();
  // Every model there is, to name one for subagents rather than the chat's.
  const [models, setModels] = useState<AvailableModel[]>([]);
  useEffect(() => {
    api.allModels().then((r) => setModels(r.models)).catch(() => {});
  }, []);

  if (!subagent) return failed ? <ReadFailed error={failed} onRetry={retry} /> : <Loading />;
  const s = subagent;

  const change = async (patch: { enabled?: boolean; mode?: SubagentMode; maxParallel?: number; model?: string }) => {
    setBusy(true);
    setNote(null);
    // The choice shows at once; what the server says after is what stays.
    if (patch.mode || patch.maxParallel || patch.model) setSubagent({ ...s, ...patch });
    try {
      const { subagent: saved, waiting } = await api.setSubagentFeature(patch);
      setSubagent(saved);
      setNote(() => () => reloadNote(waiting));
      // A chat's model menu has the subagents' model while the tool is on.
      window.dispatchEvent(new Event("features-changed"));
    } catch (e) {
      setSubagent(s);
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-4 space-y-3">
      <div className="rounded-xl border border-line bg-raised/40 p-3">
        <Header Icon={LuBot} title={t("Subagents")}>
          {tx("A {tool} tool: the agent hands a self-contained task to a second agent with a context of its own, and gets its answer back. You can watch it beside the chat and give it instructions while it works.", { tool: <code>subagent</code> })}
        </Header>
      </div>
      <SwitchRow
        title={t("Subagent tool")}
        detail={s.enabled ? t("Installed as a pi package ({source}).", { source: s.source ?? "" }) : t("Off: the agent has no subagent tool.")}
        on={s.enabled}
        onChange={(enabled) => void change({ enabled })}
        disabled={busy || (!s.available && !s.installed)}
        note={!s.available && !s.installed ? t("This install does not carry the subagent tool.") : undefined}
      />
      <fieldset className="rounded-xl border border-line bg-raised/40 p-3" disabled={busy}>
        <legend className="px-1 text-xs text-fg-muted">{t("How a subagent runs against the agent")}</legend>
        <div className="space-y-2">
          {MODES.map((m) => (
            <label key={m.value} className="flex cursor-pointer items-start gap-2.5 rounded-lg p-1.5 hover:bg-fg/5">
              <input
                type="radio"
                name={name}
                value={m.value}
                checked={s.mode === m.value}
                onChange={() => void change({ mode: m.value })}
                className="mt-0.5 accent-current"
              />
              <span className="min-w-0 text-sm text-fg">
                {t(m.label)}
                <span className="mt-0.5 block text-xs text-fg-faint">{t(m.detail)}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <div className="rounded-xl border border-line bg-raised/40 p-3 text-sm text-fg">
        {t("Model")}
        <span className="mt-0.5 block text-xs text-fg-faint">
          {t("What a subagent runs on unless its chat says otherwise (in the chat's model menu). The chat's own is the one already loaded, so no second model is started.")}
        </span>
        <Select
          aria-label={t("Subagent model")}
          size="sm"
          className="mt-2 w-full"
          value={s.model}
          disabled={busy}
          onChange={(model) => void change({ model })}
          options={[
            { value: "auto", label: t("Same as the chat"), hint: t("The model the chat is on when it starts one") },
            ...(models.some((m) => `${m.provider}/${m.id}` === s.model) || s.model === "auto" ? [] : [{ value: s.model, label: s.model }]),
            ...models.map((m) => ({ value: `${m.provider}/${m.id}`, label: m.name || m.id, hint: `${m.provider}/${m.id}` })),
          ]}
        />
      </div>
      <div className="flex items-start gap-3 rounded-xl border border-line bg-raised/40 p-3">
        <div className="min-w-0 flex-1 text-sm text-fg">
          {t("Subagents at once")}
          <span className="mt-0.5 block text-xs text-fg-faint">
            {t("Across every chat. One asked for beyond it waits for a free slot — its call waits in interrupt mode, and in the background it starts once another has finished. Each one is a model running.")}
          </span>
        </div>
        <div role="group" aria-label={t("Subagents at once")} className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            aria-label={t("Fewer at once")}
            disabled={busy || s.maxParallel <= 1}
            onClick={() => void change({ maxParallel: s.maxParallel - 1 })}
            className="grid h-7 w-7 place-items-center rounded-lg bg-fg/5 text-fg-muted transition hover:bg-fg/10 disabled:opacity-40"
          >
            <LuMinus className="h-3.5 w-3.5" />
          </button>
          <output aria-live="polite" className="w-6 text-center text-sm tabular-nums text-fg">{s.maxParallel}</output>
          <button
            type="button"
            aria-label={t("More at once")}
            disabled={busy || s.maxParallel >= (s.maxParallelLimit ?? MAX_PARALLEL)}
            onClick={() => void change({ maxParallel: s.maxParallel + 1 })}
            className="grid h-7 w-7 place-items-center rounded-lg bg-fg/5 text-fg-muted transition hover:bg-fg/10 disabled:opacity-40"
          >
            <LuPlus className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      {busy && (
        <p className="flex items-center gap-2 text-xs text-fg-subtle">
          <LuRefreshCw className="h-3.5 w-3.5 animate-spin" /> {t("Applying…")}
        </p>
      )}
      {note && !busy && <p role="status" className="text-xs text-fg-muted">{note()}</p>}
    </div>
  );
}

/** As many as the tool allows at once, where the server does not say. */
const MAX_PARALLEL = 16;

const COMPOSE = `services:
  understory:
    image: ghcr.io/thecodacus/understory:latest
    ports: ["3800:3800"]
    volumes: [understory-memory:/bundle]
    environment:
      BUNDLE_ROOT: /bundle
      LLM_API_BASE_URL: \${LLM_API_BASE_URL}
      LLM_API_KEY: \${LLM_API_KEY}
      LLM_API_FORMAT: openai
      LLM_MODEL: \${LLM_MODEL}
      # DREAM_INTERVAL: 6h
    restart: unless-stopped
volumes:
  understory-memory:`;

/** How often Understory tidies its memory up, on its own timer, as it reads it. */
const INTERVALS: { value: string; label: string }[] = [
  { value: "1h", label: msg("Every hour") },
  { value: "6h", label: msg("Every 6 hours") },
  { value: "12h", label: msg("Every 12 hours") },
  { value: "1d", label: msg("Every 24 hours") },
  { value: "7d", label: msg("Every week") },
];

/** Never, once a day at a time of day (started by the portal), or on Understory's own interval — one of them. */
type DreamMode = "never" | "time" | "interval";
const DREAM_MODES: { value: DreamMode; label: string }[] = [
  { value: "never", label: msg("Never") },
  { value: "time", label: msg("At a time of day") },
  { value: "interval", label: msg("On an interval") },
];

/** The form's copy of the settings, before they are saved. */
interface Draft {
  source: "auto" | "provider" | "custom";
  provider: string;
  providerModel: string;
  baseUrl: string;
  model: string;
  format: "openai" | "anthropic";
  /** Typed anew; empty keeps the one saved. */
  apiKey: string;
  dream: DreamMode;
  /** Kept for each while the other is chosen, so switching back finds it. */
  dreamInterval: string;
  dreamAt: string;
}

function draftOf(m: ManagedUnderstory): Draft {
  const llm = m.config.llm;
  const first = m.providers[0];
  return {
    source: llm.source,
    provider: llm?.source === "provider" ? llm.provider : (first?.id ?? ""),
    providerModel: llm?.source === "provider" ? llm.model : (first?.models[0] ?? ""),
    baseUrl: llm?.source === "custom" ? llm.baseUrl : "",
    model: llm?.source === "custom" ? llm.model : "",
    format: llm?.source === "custom" ? llm.format : "openai",
    apiKey: "",
    dream: m.config.dreamAt ? "time" : m.config.dreamInterval ? "interval" : "never",
    dreamInterval: m.config.dreamInterval || "6h",
    dreamAt: m.config.dreamAt || "03:00",
  };
}

function choiceOf(d: Draft): UnderstoryLlmChoice | null {
  if (d.source === "auto") return { source: "auto" };
  if (d.source === "provider") return d.provider && d.providerModel ? { source: "provider", provider: d.provider, model: d.providerModel } : null;
  if (!d.baseUrl.trim() || !d.model.trim()) return null;
  return { source: "custom", baseUrl: d.baseUrl.trim(), model: d.model.trim(), format: d.format, ...(d.apiKey ? { apiKey: d.apiKey } : {}) };
}

const INSTALLING = msg("Installing Understory…");

export function MemoryAddon({ onError }: { onError: (e: string) => void }) {
  const [features, setFeatures, failed, retry] = useFeatures();
  const [url, setUrl] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // Said in the language shown, whenever it is drawn.
  const [note, setNote] = useState<(() => string) | null>(null);
  // What is changed here and not saved is in no other place.
  useUnsavedDraft(!!draft);

  // While it is installed, and its image pulled, what the daemon says.
  const watching = Boolean(features?.understory.managed.pulling.active) || busy === INSTALLING;
  // One after the other, never on top of each other: an answer can take a
  // while — it asks whether Understory answers — and older ones must not land last.
  useEffect(() => {
    if (!watching) return;
    let on = true;
    let t: ReturnType<typeof setTimeout> | undefined;
    const next = () => {
      t = setTimeout(async () => {
        const f = await api.features().catch(() => null);
        if (!on) return;
        if (f) setFeatures(f);
        next();
      }, 1500);
    };
    next();
    return () => {
      on = false;
      clearTimeout(t);
    };
  }, [watching]);

  if (!features) return failed ? <ReadFailed error={failed} onRetry={retry} /> : <Loading />;
  const u = features.understory;
  const m = u.managed;
  const form = draft ?? draftOf(m);
  const edit = (patch: Partial<Draft>) => setDraft({ ...form, ...patch });
  const choice = choiceOf(form);
  const runsHere = m.container === "running" || m.container === "stopped";
  const foreign = m.container === "foreign";
  const address = url ?? u.url;
  const origin = originOf(u.url) || null;

  /** Runs one change, and takes what the server says the state is after it. */
  const act = async (what: string, run: () => Promise<{ understory: Features["understory"]; waiting?: number }>) => {
    setBusy(what);
    setNote(null);
    try {
      const { understory, waiting } = await run();
      setFeatures({ ...features, understory });
      if (waiting !== undefined) setNote(() => () => reloadNote(waiting));
      // The sidebar has the Memory page while Understory is the agent's memory.
      window.dispatchEvent(new Event("features-changed"));
      return true;
    } catch (e) {
      onError((e as Error).message);
      // What did happen, all the same: a pass that failed is kept as the last one.
      api.features().then(setFeatures).catch(() => {});
      return false;
    } finally {
      setBusy(null);
    }
  };

  const saveSettings = async () => {
    if (!choice) return;
    const ok = await act(runsHere ? msg("Restarting Understory…") : msg("Saving…"), () =>
      api.setUnderstoryConfig(
        { llm: choice, dreamInterval: form.dream === "interval" ? form.dreamInterval : "", dreamAt: form.dream === "time" ? form.dreamAt : "" },
      ),
    );
    if (ok) setDraft(null);
  };
  const saved = !draft;
  const providerModels = m.providers.find((p) => p.id === form.provider)?.models ?? [];

  return (
    <div className="mt-4 space-y-3">
      <div className="rounded-xl border border-line bg-raised/40 p-3">
        <Header Icon={LuBrain} title={t("Memory: Understory")}>
          {tx("A memory that grows: plain markdown on disk, cross-linked and kept tidy, which the agent looks things up in and adds to through its {tools} tools. The portal can run it for you, or point the agent at one you run yourself.", { tools: <code>memory_*</code> })}
        </Header>
      </div>

      {m.available && (
        <section aria-label={t("Understory run here")} className="space-y-3 rounded-xl border border-line bg-raised/40 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm text-fg">{t("Run it here")}</p>
            {runsHere && (
              <span className={`inline-flex items-center gap-1 text-[11px] ${m.container === "running" ? "text-ok" : "text-fg-subtle"}`}>
                <LuCheck className="h-3 w-3" /> {m.container === "running" ? t("running") : t("stopped")}
              </span>
            )}
          </div>
          <p className="text-[11px] text-fg-faint">
            {t("In a container of its own beside the portal, with its memory in a volume that stays when it is removed or made again.")}
          </p>

          <fieldset disabled={busy !== null} className="space-y-3">
            <legend className="text-xs text-fg-muted">{t("The model that keeps the memory")}</legend>
            <div role="radiogroup" aria-label={t("Where the model comes from")} className="flex gap-1 rounded-lg bg-fg/5 p-0.5 text-xs">
              {(["auto", "provider", "custom"] as const).map((src) => (
                <button
                  key={src}
                  type="button"
                  role="radio"
                  aria-checked={form.source === src}
                  disabled={(src === "provider" && !m.providers.length) || (src === "auto" && !m.autoPossible)}
                  onClick={() => edit({ source: src })}
                  className={`flex-1 rounded-md px-2 py-1 transition disabled:opacity-40 ${form.source === src ? "bg-surface text-fg shadow-sm" : "text-fg-muted hover:text-fg"}`}
                >
                  {src === "auto" ? t("The chat's model") : src === "provider" ? t("A provider set up here") : t("An address of its own")}
                </button>
              ))}
            </div>
            {form.source === "auto" ? (
              <p className="text-[11px] text-fg-faint">
                {t("The model the chat asking is on — the one already loaded, so no second model is started for the memory. When no chat is asking, as when it tidies up, the one that asked last; before any has, the default model for new chats. It needs a model with an OpenAI-compatible API, as local servers and OpenRouter have.")}
                {!m.autoPossible && ` ${t("Not while the portal serves its own TLS: Understory cannot reach it through that.")}`}
              </p>
            ) : form.source === "provider" ? (
              <div className="grid gap-2 sm:grid-cols-2">
                <div className="text-xs text-fg-muted">
                  {t("Provider")}
                  <Select
                    aria-label={t("Provider")}
                    size="sm"
                    className="mt-1 w-full"
                    value={form.provider}
                    onChange={(provider) => edit({ provider, providerModel: m.providers.find((p) => p.id === provider)?.models[0] ?? "" })}
                    options={m.providers.map((p) => ({ value: p.id, label: p.id }))}
                  />
                </div>
                <div className="text-xs text-fg-muted">
                  {t("Model")}
                  <Select
                    aria-label={t("Model")}
                    size="sm"
                    className="mt-1 w-full"
                    value={form.providerModel}
                    onChange={(providerModel) => edit({ providerModel })}
                    options={providerModels.map((id) => ({ value: id, label: id }))}
                  />
                </div>
                <p className="text-[11px] text-fg-faint sm:col-span-2">{t("Its address and key are taken from the provider each time Understory is started.")}</p>
              </div>
            ) : (
              <div className="grid gap-2 sm:grid-cols-2">
                <label className="text-xs text-fg-muted sm:col-span-2">
                  {t("API address")}
                  <input
                    value={form.baseUrl}
                    onChange={(e) => edit({ baseUrl: e.target.value })}
                    placeholder="https://api.deepseek.com/v1"
                    spellCheck={false}
                    className={`${inputCls} mt-1 font-mono text-xs`}
                  />
                </label>
                <label className="text-xs text-fg-muted">
                  {t("API key")}
                  <input
                    type="password"
                    value={form.apiKey}
                    onChange={(e) => edit({ apiKey: e.target.value })}
                    placeholder={m.config.llm?.source === "custom" && m.config.llm.hasKey ? t("saved — type to replace") : t("none needed for a local server")}
                    autoComplete="off"
                    className={`${inputCls} mt-1 text-xs`}
                  />
                </label>
                <label className="text-xs text-fg-muted">
                  {t("Model")}
                  <input
                    value={form.model}
                    onChange={(e) => edit({ model: e.target.value })}
                    placeholder="deepseek-chat"
                    spellCheck={false}
                    className={`${inputCls} mt-1 font-mono text-xs`}
                  />
                </label>
                <div className="text-xs text-fg-muted">
                  {t("Format")}
                  <Select<"openai" | "anthropic">
                    aria-label={t("Format")}
                    size="sm"
                    className="mt-1 w-full"
                    value={form.format}
                    onChange={(format) => edit({ format })}
                    options={[
                      { value: "openai", label: t("OpenAI-compatible") },
                      { value: "anthropic", label: "Anthropic" },
                    ]}
                  />
                </div>
              </div>
            )}

            <div className="text-xs text-fg-muted">
              {t("Tidying up")}
              <div role="radiogroup" aria-label={t("Tidying up")} className="mt-1 flex gap-1 rounded-lg bg-fg/5 p-0.5">
                {DREAM_MODES.map((d) => (
                  <button
                    key={d.value}
                    type="button"
                    role="radio"
                    aria-checked={form.dream === d.value}
                    onClick={() => edit({ dream: d.value })}
                    className={`flex-1 rounded-md px-2 py-1 transition ${form.dream === d.value ? "bg-surface text-fg shadow-sm" : "text-fg-muted hover:text-fg"}`}
                  >
                    {t(d.label)}
                  </button>
                ))}
              </div>
              {form.dream === "time" && (
                <label className="mt-2 flex flex-wrap items-center gap-2 text-xs text-fg-muted">
                  {t("Every day at")}
                  <input
                    type="time"
                    value={form.dreamAt}
                    onChange={(e) => edit({ dreamAt: e.target.value })}
                    aria-label={t("Tidy up at")}
                    className="rounded-lg border border-line bg-raised/60 px-2 py-1 text-sm tabular-nums outline-none focus:border-accent/60"
                  />
                  <span className="text-[11px] text-fg-faint">{t("the portal's time ({zone})", { zone: m.timeZone })}</span>
                </label>
              )}
              {form.dream === "interval" && (
                <Select
                  aria-label={t("How often")}
                  size="sm"
                  className="mt-2 w-full"
                  value={form.dreamInterval}
                  onChange={(dreamInterval) => edit({ dreamInterval })}
                  options={[
                    ...INTERVALS.map((d) => ({ value: d.value, label: t(d.label) })),
                    ...(INTERVALS.some((d) => d.value === form.dreamInterval) ? [] : [{ value: form.dreamInterval, label: t("Every {interval}", { interval: form.dreamInterval }) }]),
                  ]}
                />
              )}
              <p className="mt-1 text-[11px] text-fg-faint">
                {t("Understory's own pass over the memory — merging, linking and pruning notes with the model above, which costs tokens each time, and does nothing when the memory is already tidy.")}{" "}
                {form.dream === "time"
                  ? t("At a time of day the portal starts it, once a day while Understory runs; Understory's own timer stays off.")
                  : form.dream === "interval"
                    ? t("An interval is Understory's own timer: it counts from when Understory starts, so saving here begins the count anew.")
                    : ""}
              </p>
              {(runsHere || m.lastDream) && (
                <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
                  {m.lastDream && (
                    <span className={m.lastDream.ok ? "text-fg-muted" : "text-warn"}>
                      {t("Last: {when} — {said}", { when: formatDateTime(m.lastDream.at), said: m.lastDream.said })}
                    </span>
                  )}
                  {m.nextDream && m.config.dreamAt && <span className="text-fg-faint">{t("Next: {when}", { when: formatDateTime(m.nextDream) })}</span>}
                  {m.container === "running" && (
                    <button
                      type="button"
                      disabled={busy !== null || m.dreaming}
                      onClick={() => void act(msg("Tidying up — this takes as long as the model needs…"), () => api.dreamUnderstory())}
                      className="text-accent hover:underline disabled:opacity-40"
                    >
                      {t("Tidy up now")}
                    </button>
                  )}
                </p>
              )}
            </div>

            {!saved && (
              <button
                type="button"
                disabled={!choice}
                onClick={() => void saveSettings()}
                className="inline-flex items-center gap-1.5 rounded-lg bg-accent/12 px-3 py-1.5 text-xs text-accent ring-1 ring-inset ring-accent/25 transition hover:bg-accent/20 disabled:opacity-40"
              >
                {runsHere ? t("Save and restart Understory") : t("Save")}
              </button>
            )}
          </fieldset>

          {foreign && (
            <p role="alert" className="text-[11px] text-warn">
              {t("A container named pithagoras-understory is there that the portal did not make. It is left alone: rename or remove it to run Understory here.")}
            </p>
          )}
          <div className="flex flex-wrap gap-2 border-t border-line pt-3">
            {!runsHere ? (
              <button
                type="button"
                disabled={busy !== null || !saved || foreign}
                title={!saved ? t("Save the settings first") : undefined}
                onClick={() => void act(INSTALLING, () => api.installUnderstory())}
                className="inline-flex items-center gap-1.5 rounded-lg bg-accent/12 px-3 py-1.5 text-xs text-accent ring-1 ring-inset ring-accent/25 transition hover:bg-accent/20 disabled:opacity-40"
              >
                <LuDownload className="h-3.5 w-3.5" /> {t("Install and use as the agent's memory")}
              </button>
            ) : (
              <>
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void act(m.container === "running" ? msg("Stopping…") : msg("Starting…"), () => api.understoryAction(m.container === "running" ? "stop" : "start"))}
                  className="rounded-lg bg-fg/5 px-3 py-1.5 text-xs text-fg-muted transition hover:bg-fg/10"
                >
                  {m.container === "running" ? t("Stop") : t("Start")}
                </button>
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void act(msg("Removing…"), () => api.removeUnderstory())}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-fg/5 px-3 py-1.5 text-xs text-fg-muted transition hover:bg-danger/10 hover:text-danger"
                >
                  <LuTrash2 className="h-3.5 w-3.5" /> {t("Remove")}
                </button>
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={async () => {
                    const ok = await confirmDialog({
                      title: t("Forget the whole memory?"),
                      message: t("Understory is removed and its volume deleted, with every note the agent kept in it. This cannot be undone."),
                      confirmLabel: t("Forget it"),
                      danger: true,
                      deletes: true,
                    });
                    // The notes are gone with it: an edit kept for one would come back over a note made again at its path.
                    if (ok) await act(msg("Removing…"), async () => {
                      const removed = await api.removeUnderstory(true);
                      forgetNoteDrafts();
                      return removed;
                    });
                  }}
                  className="rounded-lg px-3 py-1.5 text-xs text-fg-subtle transition hover:bg-danger/10 hover:text-danger"
                >
                  {t("Remove and forget the memory")}
                </button>
              </>
            )}
          </div>
          {m.pulling.active && <p className="font-mono text-[11px] text-fg-faint">{m.pulling.line}</p>}
          {m.pulling.error && <p role="alert" className="text-[11px] text-warn">{m.pulling.error}</p>}
          {!runsHere && <p className="text-[11px] text-fg-faint">{t("Installing downloads its image the first time.")}</p>}
        </section>
      )}

      {!runsHere && (
        <details open={!m.available} className="rounded-xl border border-line p-3">
          <summary className="cursor-pointer text-xs text-fg-muted">{m.available ? t("Or use one you run yourself") : t("Use one you run yourself")}</summary>
          <div className="mt-3 space-y-2">
            {!m.available && <p className="text-[11px] text-fg-faint">{t("The portal cannot reach Docker here, so it cannot run Understory itself.")}</p>}
            <label className="block text-xs text-fg-muted">
              {t("Understory's MCP address")}
              <input
                value={address}
                onChange={(e) => setUrl(e.target.value)}
                spellCheck={false}
                aria-label={t("Understory's MCP address")}
                className={`${inputCls} mt-1.5 font-mono text-xs`}
              />
            </label>
            <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
              {u.reachable ? (
                <span className="inline-flex items-center gap-1 text-ok">
                  <LuCheck className="h-3 w-3" /> {t("Something answers there")}
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 text-warn">
                  <LuTriangleAlert className="h-3 w-3" /> {t("Nothing answers at {address} — start Understory first", { address: origin ?? u.url })}
                </span>
              )}
              <span className="text-fg-faint">
                {u.tokenSet ? t("A token is set and sent.") : t("No token (MEMORY_UNDERSTORY_AUTH_TOKEN) — only needed when Understory has an AUTH_TOKEN.")}
              </span>
            </p>
            <p className="text-[11px] text-fg-faint">
              {tx("Its model and how often it tidies up are set in its own environment ({llm}, {dream}):", { llm: <code>LLM_*</code>, dream: <code>DREAM_INTERVAL</code> })}
            </p>
            <pre className="overflow-x-auto rounded-lg bg-fg/5 p-2 font-mono text-[11px] text-fg-muted">{COMPOSE}</pre>
          </div>
        </details>
      )}

      <SwitchRow
        title={t("Use Understory as the agent's memory")}
        detail={
          u.enabled
            ? t("On: MEMORY.md is not read while it is. The file is kept, and read again once this is off.")
            : u.adapterInstalled
              ? t("Off: the agent's memory is MEMORY.md.")
              : t("Off: the agent's memory is MEMORY.md. Switching on also installs pi-mcp-adapter, which makes MCP servers into tools.")
        }
        on={u.enabled}
        onChange={(enabled) => void act(enabled ? msg("Switching on…") : msg("Switching off…"), () => api.setUnderstoryFeature(enabled && !runsHere ? { enabled, url: address.trim() } : { enabled }))}
        disabled={busy !== null || !!u.configError}
        note={u.configError ? t("mcp.json cannot be read: {error}. Fix it in Settings → MCP.", { error: u.configError }) : undefined}
      />
      {u.enabled && !runsHere && url !== null && url.trim() !== u.url && (
        <button type="button" disabled={busy !== null} onClick={() => void act(msg("Switching…"), () => api.setUnderstoryFeature({ enabled: true, url: address.trim() }))} className="text-xs text-accent hover:underline">
          {t("Use the new address")}
        </button>
      )}
      {u.enabled && (
        <Link to="/memory" className="inline-block text-xs text-accent hover:underline">
          {t("Read the memory")}
        </Link>
      )}
      {busy && (
        <p className="flex items-center gap-2 text-xs text-fg-subtle">
          <LuRefreshCw className="h-3.5 w-3.5 animate-spin" /> {t(busy)}
        </p>
      )}
      {note && !busy && <p role="status" className="text-xs text-fg-muted">{note()}</p>}
    </div>
  );
}

/** The form's copy of the image endpoint's settings, before they are saved. */
interface ImagesDraft {
  baseUrl: string;
  model: string;
  size: string;
  /** As typed: whole seconds, or not yet. */
  timeout: string;
  /** Typed anew; empty keeps the one saved. */
  apiKey: string;
}

/** What the server takes as a time limit, in seconds. */
const TIMEOUT = TIMEOUT_SECONDS;
/** Empty is the default, as it is for the model and the size: it takes a saved limit away. */
const timeoutOk = (typed: string, limits: { min: number; max: number } = TIMEOUT) => typed.trim() === "" || (/^\d+$/.test(typed.trim()) && Number(typed) >= limits.min && Number(typed) <= limits.max);

/** The same for editing, which has its own address, model and key. */
interface ImagesEditDraft {
  baseUrl: string;
  model: string;
  /** As typed: "2048x2048", or empty for no limit. */
  maxSize: string;
  /** Typed anew; empty keeps the one saved. */
  apiKey: string;
}

/** What the server takes as a maximum size: empty is none. */
const maxSizeOk = (typed: string) => typed.trim() === "" || MAX_SIZE.test(typed.trim());

const originOf = (address: string): string => {
  try {
    return new URL(address).origin;
  } catch {
    return "";
  }
};

/** The host of an address, for a summary: what a person knows a server by. */
const hostOf = (address: string): string => {
  try {
    return new URL(address).host;
  } catch {
    return address;
  }
};

const OPEN_KEY = "pithagoras.settings.media-open";

/**
 * Whether the section of a model is open: the person's last choice, kept in this browser, else open while the model
 * is not set up. Which of the two was decided when its settings were first read, so that saving the address does not
 * close the section under the hand. `setUp` is undefined until they are read; `locked` keeps it open.
 */
function useSectionOpen(id: "image" | "video", setUp: boolean | undefined, locked: boolean): [boolean, () => void] {
  const [picked, setPicked] = useState<boolean | null>(() => {
    try {
      const kept = JSON.parse(local.get(OPEN_KEY) ?? "{}")[id];
      return typeof kept === "boolean" ? kept : null;
    } catch {
      return null;
    }
  });
  const first = useRef<boolean | undefined>(undefined);
  if (first.current === undefined && setUp !== undefined) first.current = !setUp;
  const open = locked || (picked ?? first.current ?? true);
  const toggle = () => {
    const next = !open;
    setPicked(next);
    try {
      local.set(OPEN_KEY, JSON.stringify({ ...JSON.parse(local.get(OPEN_KEY) ?? "{}"), [id]: next }));
    } catch {
      // Not remembered, but the section works.
    }
  };
  return [open, toggle];
}

/**
 * A model's section while its settings are being read, or could not be. Not a section a search can name: one that
 * does would be found and lit up here, and the section that replaces it would be neither.
 */
function ModelPending({ title, failed, onRetry }: { title: string; failed: Error | null; onRetry: () => unknown }) {
  return (
    <div className="mb-7">
      <p className="text-xs font-semibold uppercase tracking-wider text-fg-subtle">{title}</p>
      <div className="mt-2.5">{failed ? <LoadFailed error={failed} onRetry={onRetry} /> : <p className="flex items-center gap-2 text-sm text-fg-subtle"><LuRefreshCw className="h-3.5 w-3.5 animate-spin" /> {t("Loading…")}</p>}</div>
    </div>
  );
}

export function ImagesAddon({ onError }: { onError: (e: string) => void }) {
  // Its own, not with Understory's: a Docker that cannot be reached is not this tab's to wait on.
  const [images, setImages, failed, retry] = useFirstRead(() => api.imagesFeature().then((r) => r.images));
  const [draft, setDraft] = useState<ImagesDraft | null>(null);
  const [editDraft, setEditDraft] = useState<ImagesEditDraft | null>(null);
  const [busy, setBusy] = useState(false);
  // Said in the language shown, whenever it is drawn.
  const [note, setNote] = useState<(() => string) | null>(null);
  // What is changed here and not saved is in no other place.
  useUnsavedDraft(!!draft || !!editDraft);
  const [open, toggle] = useSectionOpen("image", images ? images.baseUrl !== "" : undefined, !!draft || !!editDraft);

  if (!images) return <ModelPending title={t("Image model")} failed={failed} onRetry={retry} />;
  const form = draft ?? { baseUrl: images.baseUrl, model: images.model, size: images.size, timeout: String(images.timeoutSeconds), apiKey: "" };
  const edit = (patch: Partial<ImagesDraft>) => setDraft({ ...form, ...patch });
  const editForm = editDraft ?? { baseUrl: images.editBaseUrl, model: images.editModel, maxSize: images.editMaxSize, apiKey: "" };
  const editEdit = (patch: Partial<ImagesEditDraft>) => setEditDraft({ ...editForm, ...patch });
  // The key of generation goes along when edits go to the same server and have none of their own: the server says the same.
  const usesKeyAbove = images.keySet && !images.editKeySet && originOf(editForm.baseUrl || images.baseUrl) === originOf(images.baseUrl);

  const change = async (patch: ImagesFeaturePatch) => {
    setBusy(true);
    setNote(null);
    try {
      const { images: saved, changed, waiting } = await api.setImagesFeature(patch);
      setImages(saved);
      // The form's settings are saved now, so it shows them as the server has them; the key typed is not shown again.
      if (patch.baseUrl !== undefined) setDraft(null);
      if (patch.editBaseUrl !== undefined) setEditDraft(null);
      if (changed) setNote(() => () => reloadNote(waiting));
      // The Media page is in the sidebar while there is an endpoint to make pictures with.
      window.dispatchEvent(new Event("features-changed"));
      return true;
    } catch (e) {
      onError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  return (
    <CollapsibleSection
      title={t("Image model")}
      hint={t("Making and changing pictures, on the Media page and for the agent.")}
      summary={draft || editDraft ? t("Unsaved changes") : images.baseUrl ? [hostOf(images.baseUrl), images.model].filter(Boolean).join(" · ") : t("Not set up")}
      open={open}
      onToggle={toggle}
      locked={!!draft || !!editDraft}
      controls={
        <>
          <SwitchRow
            title={t("Image generation")}
            detail={images.enabled ? t("On: pictures are made on the Media page and by the agent.") : t("Off: no pictures are made.")}
            on={images.enabled}
            onChange={(enabled) => void change({ enabled })}
            disabled={busy || !!draft || (!images.baseUrl && !images.enabled)}
            note={draft ? t("Save or discard the changes first.") : !images.baseUrl && !images.enabled ? t("Save the address of an image endpoint first.") : undefined}
          />
          <SwitchRow
            title={t("Image editing")}
            detail={images.editEnabled ? t("On: pictures are changed on the Media page and by the agent.") : t("Off: no pictures are changed.")}
            on={images.editEnabled}
            onChange={(editEnabled) => void change({ editEnabled })}
            disabled={busy || !!editDraft || (!(images.editBaseUrl || images.baseUrl) && !images.editEnabled)}
            note={editDraft ? t("Save or discard the changes first.") : !(images.editBaseUrl || images.baseUrl) && !images.editEnabled ? t("Save the address of an image endpoint first.") : undefined}
          />
          {busy && (
            <p className="flex items-center gap-2 text-xs text-fg-subtle">
              <LuRefreshCw className="h-3.5 w-3.5 animate-spin" /> {t("Applying…")}
            </p>
          )}
          {note && !busy && <p role="status" className="text-xs text-fg-muted">{note()}</p>}
        </>
      }
    >
      <fieldset disabled={busy} className="space-y-3 rounded-xl border border-line bg-raised/40 p-3">
        <legend className="px-1 text-xs text-fg-muted">{t("The image endpoint")}</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="text-xs text-fg-muted sm:col-span-2">
            {t("API address")}
            <input
              value={form.baseUrl}
              onChange={(e) => edit({ baseUrl: e.target.value })}
              placeholder="https://images.example.com/v1"
              spellCheck={false}
              autoComplete="off"
              className={`${inputCls} mt-1 font-mono text-xs`}
            />
          </label>
          <label className="text-xs text-fg-muted">
            {t("API key")}
            <input
              type="password"
              value={form.apiKey}
              onChange={(e) => edit({ apiKey: e.target.value })}
              placeholder={images.keySet ? t("saved — type to replace") : t("none needed for a local server")}
              autoComplete="off"
              className={`${inputCls} mt-1 text-xs`}
            />
          </label>
          <label className="text-xs text-fg-muted">
            {t("Model")}
            <input
              value={form.model}
              onChange={(e) => edit({ model: e.target.value })}
              placeholder="image-model"
              spellCheck={false}
              autoComplete="off"
              className={`${inputCls} mt-1 font-mono text-xs`}
            />
          </label>
          <label className="text-xs text-fg-muted">
            {t("Picture size")}
            <input
              value={form.size}
              onChange={(e) => edit({ size: e.target.value })}
              placeholder="1024x1024"
              spellCheck={false}
              autoComplete="off"
              className={`${inputCls} mt-1 font-mono text-xs`}
            />
          </label>
          <label className="text-xs text-fg-muted">
            {t("Time limit (seconds)")}
            <input
              inputMode="numeric"
              value={form.timeout}
              onChange={(e) => edit({ timeout: e.target.value })}
              placeholder={String(TIMEOUT.default)}
              aria-invalid={!timeoutOk(form.timeout)}
              className={`${inputCls} mt-1 font-mono text-xs`}
            />
          </label>
        </div>
        <p className="text-[11px] text-fg-faint">
          {tx("Any server with an OpenAI-style {route}. The key goes only to this address. Empty model and size mean the server's own.", { route: <code>images/generations</code> })}
        </p>
        <p className="text-[11px] text-fg-faint">
          {t("The time limit is how long the portal waits for one picture: {min} to {max} seconds, {default} by default.", TIMEOUT)}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {draft && (
            <button
              type="button"
              className={primaryCls}
              disabled={!timeoutOk(form.timeout)}
              onClick={() =>
                void change({
                  baseUrl: form.baseUrl,
                  model: form.model,
                  size: form.size,
                  // Only when changed, so that saving the rest does not state a limit the person never chose.
                  ...(form.timeout.trim() === "" ? { timeoutSeconds: null } : Number(form.timeout) !== images.timeoutSeconds ? { timeoutSeconds: Number(form.timeout) } : {}),
                  ...(form.apiKey ? { apiKey: form.apiKey } : {}),
                })
              }
            >
              {t("Save")}
            </button>
          )}
          {draft && (
            <button type="button" className="text-xs text-fg-muted hover:text-fg" onClick={() => setDraft(null)}>
              {t("Discard")}
            </button>
          )}
          {images.keySet && !draft && (
            <button type="button" className="text-xs text-fg-muted hover:text-danger" onClick={() => void change({ apiKey: "" })}>
              {t("Remove the saved key")}
            </button>
          )}
        </div>
      </fieldset>

      <DetailsGroup
        title={t("Editing endpoint")}
        summary={editDraft ? t("Unsaved changes") : images.editBaseUrl ? hostOf(images.editBaseUrl) : t("Uses the image endpoint")}
        defaultOpen={!!(images.editBaseUrl || images.editModel || images.editMaxSize)}
      >
        <fieldset disabled={busy} className="space-y-3">
          <p className="text-[11px] text-fg-faint">
            {tx("Changing pictures that exist, with an OpenAI-style {route}. The original stays; the result is a new picture.", { route: <code>images/edits</code> })}
          </p>
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="text-xs text-fg-muted sm:col-span-2">
              {t("Editing address")}
              <input
                value={editForm.baseUrl}
                onChange={(e) => editEdit({ baseUrl: e.target.value })}
                placeholder={images.baseUrl || "https://images.example.com/v1"}
                spellCheck={false}
                autoComplete="off"
                className={`${inputCls} mt-1 font-mono text-xs`}
              />
            </label>
            <label className="text-xs text-fg-muted">
              {t("Editing key")}
              <input
                type="password"
                value={editForm.apiKey}
                onChange={(e) => editEdit({ apiKey: e.target.value })}
                placeholder={images.editKeySet ? t("saved — type to replace") : usesKeyAbove ? t("the key above is used") : t("none needed for a local server")}
                autoComplete="off"
                className={`${inputCls} mt-1 text-xs`}
              />
            </label>
            <label className="text-xs text-fg-muted">
              {t("Editing model")}
              <input
                value={editForm.model}
                onChange={(e) => editEdit({ model: e.target.value })}
                placeholder="image-edit-model"
                spellCheck={false}
                autoComplete="off"
                className={`${inputCls} mt-1 font-mono text-xs`}
              />
            </label>
            <label className="text-xs text-fg-muted">
              {t("Maximum picture size")}
              <input
                value={editForm.maxSize}
                onChange={(e) => editEdit({ maxSize: e.target.value })}
                placeholder="2048x2048"
                spellCheck={false}
                autoComplete="off"
                aria-invalid={!maxSizeOk(editForm.maxSize)}
                className={`${inputCls} mt-1 font-mono text-xs`}
              />
            </label>
          </div>
          <p className="text-[11px] text-fg-faint">
            {t("Leave the address empty to edit with the server above, and the model empty for the server's own. A key goes only to the address it was given for.")}
          </p>
          <p className="text-[11px] text-fg-faint">
            {t("The maximum picture size is the most pixels a picture sent to be edited may have, such as 2048x2048. Empty is no limit.")}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            {editDraft && (
              <button
                type="button"
                className={primaryCls}
                disabled={!maxSizeOk(editForm.maxSize)}
                onClick={() => void change({ editBaseUrl: editForm.baseUrl, editModel: editForm.model, ...(editForm.maxSize.trim() !== images.editMaxSize ? { editMaxSize: editForm.maxSize.trim() } : {}), ...(editForm.apiKey ? { editApiKey: editForm.apiKey } : {}) })}
              >
                {t("Save")}
              </button>
            )}
            {editDraft && (
              <button type="button" className="text-xs text-fg-muted hover:text-fg" onClick={() => setEditDraft(null)}>
                {t("Discard")}
              </button>
            )}
            {images.editKeySet && !editDraft && (
              <button type="button" className="text-xs text-fg-muted hover:text-danger" onClick={() => void change({ editApiKey: "" })}>
                {t("Remove the saved editing key")}
              </button>
            )}
          </div>
        </fieldset>
      </DetailsGroup>

      <DetailsGroup title={t("More options")} summary={[images.editMultiple && t("Several pictures per edit"), images.sdExtras && t("Stable Diffusion extra settings")].filter(Boolean).join(" · ") || t("None on")}>
        <SwitchRow
          title={t("Several pictures per edit")}
          detail={images.editMultiple ? t("On: an edit takes up to eight pictures.") : t("Off: an edit takes one picture.")}
          on={images.editMultiple}
          onChange={(editMultiple) => void change({ editMultiple })}
          disabled={busy || !!editDraft}
        />
        <p className="text-[11px] text-fg-faint">
          {t("Switch it on only if the editing endpoint takes more than one picture in a request.")}
        </p>
        <SwitchRow
          title={t("Stable Diffusion extra settings")}
          detail={
            images.sdExtras
              ? t("On: the Media page shows stable-diffusion.cpp settings under Advanced.")
              : t("Off: the Media page shows only the settings of the OpenAI image format.")
          }
          on={images.sdExtras}
          onChange={(sdExtras) => void change({ sdExtras })}
          // Saving a new address of another server takes it off again, so it waits for the save as the other switches of the endpoint do.
          disabled={busy || !!draft || !!editDraft}
        />
        <p className="text-[11px] text-fg-faint">
          {t("Only for a stable-diffusion.cpp server: it adds a seed, steps, a negative prompt and, for edits, a strength and starting from noise, as a block in the description. Any other endpoint would take the block as part of the description. The agent does not use these settings.")}
        </p>
      </DetailsGroup>
    </CollapsibleSection>
  );
}

/** The form's copy of the video endpoint's settings, before they are saved. */
interface VideosDraft {
  baseUrl: string;
  model: string;
  size: string;
  /** As typed: whole numbers, or empty for the endpoint's own. */
  frames: string;
  fps: string;
  timeout: string;
  /** As typed: whole megabytes, or empty for no limit. */
  storage: string;
  /** Typed anew; empty keeps the one saved. */
  apiKey: string;
}

/** A setting that is a whole number in a range, or empty for none. */
const wholeOrEmpty = (typed: string, min: number, max: number) => typed.trim() === "" || (/^\d+$/.test(typed.trim()) && Number(typed) >= min && Number(typed) <= max);
const STORAGE_MB = { min: 1, max: 100_000_000 };

export function VideosAddon({ onError }: { onError: (e: string) => void }) {
  // Its own, as the image endpoint's is: a Docker that cannot be reached is not this tab's to wait on.
  const [videos, setVideos, failed, retry] = useFirstRead(() => api.videosFeature().then((r) => r.videos));
  const [draft, setDraft] = useState<VideosDraft | null>(null);
  const [busy, setBusy] = useState(false);
  // Said in the language shown, whenever it is drawn.
  const [note, setNote] = useState<(() => string) | null>(null);
  // What is changed here and not saved is in no other place.
  useUnsavedDraft(!!draft);
  const [open, toggle] = useSectionOpen("video", videos ? videos.baseUrl !== "" : undefined, !!draft);

  if (!videos) return <ModelPending title={t("Video model")} failed={failed} onRetry={retry} />;
  const form: VideosDraft = draft ?? {
    baseUrl: videos.baseUrl,
    model: videos.model,
    size: videos.size,
    frames: videos.frames === null ? "" : String(videos.frames),
    fps: videos.fps === null ? "" : String(videos.fps),
    timeout: String(videos.timeoutSeconds),
    storage: videos.storageLimitMb ? String(videos.storageLimitMb) : "",
    apiKey: "",
  };
  const edit = (patch: Partial<VideosDraft>) => setDraft({ ...form, ...patch });
  const valid =
    timeoutOk(form.timeout, VIDEO_TIMEOUT_SECONDS) &&
    wholeOrEmpty(form.frames, VIDEO_LIMITS.frames.min, VIDEO_LIMITS.frames.max) &&
    wholeOrEmpty(form.fps, VIDEO_LIMITS.fps.min, VIDEO_LIMITS.fps.max) &&
    wholeOrEmpty(form.storage, STORAGE_MB.min, STORAGE_MB.max);

  const change = async (patch: VideosFeaturePatch) => {
    setBusy(true);
    setNote(null);
    try {
      const { videos: saved, changed, waiting } = await api.setVideosFeature(patch);
      setVideos(saved);
      // The form's settings are saved now, so it shows them as the server has them; the key typed is not shown again.
      if (patch.baseUrl !== undefined) setDraft(null);
      if (changed) setNote(() => () => reloadNote(waiting));
      // The Media page is in the sidebar while there is an endpoint to make videos with.
      window.dispatchEvent(new Event("features-changed"));
      return true;
    } catch (e) {
      onError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  /** A number setting as it is sent: only when it differs from the saved one, so that saving the rest does not state a value the person never chose. */
  const numberPatch = <K extends "frames" | "fps" | "storageLimitMb">(name: K, typed: string, saved: number | null): Partial<Record<K, number | null>> => {
    const next = typed.trim() === "" ? null : Number(typed);
    return (next === saved ? {} : { [name]: next }) as Partial<Record<K, number | null>>;
  };

  // What a video address has to be, said where it is typed while the section is open and under its heading while it is closed, so that it is seen either way.
  const works = (
    <div role="note" className="flex items-start gap-2 rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-fg-muted">
      <LuTriangleAlert aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warn" />
      <div className="space-y-1">
        <p>
          {tx("Only a stable-diffusion.cpp server works, through its native API ({route}) with a video model started on it. An OpenAI-style /v1 endpoint or another video server does not.", { route: <code>/sdcpp/v1</code> })}
        </p>
        <p>{tx("Through llama-swap the address is {upstream}.", { upstream: <code>{"http://host:port/upstream/<model>"}</code> })}</p>
      </div>
    </div>
  );

  return (
    <CollapsibleSection
      title={t("Video model")}
      hint={t("Making videos, on the Media page and for the agent.")}
      summary={draft ? t("Unsaved changes") : videos.baseUrl ? [hostOf(videos.baseUrl), videos.model].filter(Boolean).join(" · ") : t("Not set up")}
      open={open}
      onToggle={toggle}
      locked={!!draft}
      controls={
        <>
          <SwitchRow
            title={t("Video generation")}
            detail={videos.enabled ? t("On: videos are made on the Media page and by the agent.") : t("Off: no videos are made.")}
            on={videos.enabled}
            onChange={(enabled) => void change({ enabled })}
            disabled={busy || !!draft || (!videos.baseUrl && !videos.enabled)}
            note={draft ? t("Save or discard the changes first.") : !videos.baseUrl && !videos.enabled ? t("Save the address of a video endpoint first.") : undefined}
          />
          {busy && (
            <p className="flex items-center gap-2 text-xs text-fg-subtle">
              <LuRefreshCw className="h-3.5 w-3.5 animate-spin" /> {t("Applying…")}
            </p>
          )}
          {note && !busy && <p role="status" className="text-xs text-fg-muted">{note()}</p>}
        </>
      }
      whileClosed={works}
    >
      <fieldset disabled={busy} className="space-y-3 rounded-xl border border-line bg-raised/40 p-3">
        <legend className="px-1 text-xs text-fg-muted">{t("The video endpoint")}</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="text-xs text-fg-muted sm:col-span-2">
            {t("API address")}
            <input
              value={form.baseUrl}
              onChange={(e) => edit({ baseUrl: e.target.value })}
              placeholder="https://video.example.com"
              spellCheck={false}
              autoComplete="off"
              className={`${inputCls} mt-1 font-mono text-xs`}
            />
          </label>
          {open && <div className="sm:col-span-2">{works}</div>}
          <label className="text-xs text-fg-muted">
            {t("API key")}
            <input
              type="password"
              value={form.apiKey}
              onChange={(e) => edit({ apiKey: e.target.value })}
              placeholder={videos.keySet ? t("saved — type to replace") : t("none needed for a local server")}
              autoComplete="off"
              className={`${inputCls} mt-1 text-xs`}
            />
          </label>
          <label className="text-xs text-fg-muted">
            {t("Model")}
            <input
              value={form.model}
              onChange={(e) => edit({ model: e.target.value })}
              placeholder="video-model"
              spellCheck={false}
              autoComplete="off"
              className={`${inputCls} mt-1 font-mono text-xs`}
            />
          </label>
          <div className="grid gap-2 sm:col-span-2 sm:grid-cols-3">
            <label className="text-xs text-fg-muted">
              {t("Video size")}
              <input
                value={form.size}
                onChange={(e) => edit({ size: e.target.value })}
                placeholder="832x480"
                spellCheck={false}
                autoComplete="off"
                className={`${inputCls} mt-1 font-mono text-xs`}
              />
            </label>
            <label className="text-xs text-fg-muted">
              {t("Frames")}
              <input
                inputMode="numeric"
                value={form.frames}
                onChange={(e) => edit({ frames: e.target.value })}
                placeholder={t("the server's own")}
                aria-invalid={!wholeOrEmpty(form.frames, VIDEO_LIMITS.frames.min, VIDEO_LIMITS.frames.max)}
                className={`${inputCls} mt-1 font-mono text-xs`}
              />
            </label>
            <label className="text-xs text-fg-muted">
              {t("Frame rate")}
              <input
                inputMode="numeric"
                value={form.fps}
                onChange={(e) => edit({ fps: e.target.value })}
                placeholder={t("the server's own")}
                aria-invalid={!wholeOrEmpty(form.fps, VIDEO_LIMITS.fps.min, VIDEO_LIMITS.fps.max)}
                className={`${inputCls} mt-1 font-mono text-xs`}
              />
            </label>
          </div>
          <label className="text-xs text-fg-muted">
            {t("Time limit (seconds)")}
            <input
              inputMode="numeric"
              value={form.timeout}
              onChange={(e) => edit({ timeout: e.target.value })}
              placeholder={String(VIDEO_TIMEOUT_SECONDS.default)}
              aria-invalid={!timeoutOk(form.timeout, VIDEO_TIMEOUT_SECONDS)}
              className={`${inputCls} mt-1 font-mono text-xs`}
            />
          </label>
          <label className="text-xs text-fg-muted">
            {t("Disk limit (MB)")}
            <input
              inputMode="numeric"
              value={form.storage}
              onChange={(e) => edit({ storage: e.target.value })}
              placeholder={t("no limit")}
              aria-invalid={!wholeOrEmpty(form.storage, STORAGE_MB.min, STORAGE_MB.max)}
              className={`${inputCls} mt-1 font-mono text-xs`}
            />
          </label>
        </div>
        <p className="text-[11px] text-fg-faint">
          {tx("The address of a {server} server, such as {example}. The key goes only to this address. Empty model, size, frames and frame rate mean the server's own.", {
            server: <b>{(videos.backends.find((b) => b.id === videos.backend) ?? videos.backends[0])?.label ?? "stable-diffusion.cpp"}</b>,
            example: <code>http://localhost:1234</code>,
          })}
        </p>
        <p className="text-[11px] text-fg-faint">
          {t("The time limit is how long the portal waits for one video, in the server's queue and while it is made: {min} to {max} seconds, {default} by default.", VIDEO_TIMEOUT_SECONDS)}
        </p>
        <p className="text-[11px] text-fg-faint">
          {t("The disk limit is what the videos made on the Media page may take together; at the limit no new one is made there. Empty is no limit.")}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {draft && (
            <button
              type="button"
              className={primaryCls}
              disabled={!valid}
              onClick={() =>
                void change({
                  baseUrl: form.baseUrl,
                  model: form.model,
                  size: form.size,
                  ...numberPatch("frames", form.frames, videos.frames),
                  ...numberPatch("fps", form.fps, videos.fps),
                  ...numberPatch("storageLimitMb", form.storage, videos.storageLimitMb || null),
                  // Only when changed, so that saving the rest does not state a limit the person never chose.
                  ...(form.timeout.trim() === "" ? { timeoutSeconds: null } : Number(form.timeout) !== videos.timeoutSeconds ? { timeoutSeconds: Number(form.timeout) } : {}),
                  ...(form.apiKey ? { apiKey: form.apiKey } : {}),
                })
              }
            >
              {t("Save")}
            </button>
          )}
          {draft && (
            <button type="button" className="text-xs text-fg-muted hover:text-fg" onClick={() => setDraft(null)}>
              {t("Discard")}
            </button>
          )}
          {videos.keySet && !draft && (
            <button type="button" className="text-xs text-fg-muted hover:text-danger" onClick={() => void change({ apiKey: "" })}>
              {t("Remove the saved key")}
            </button>
          )}
        </div>
      </fieldset>
    </CollapsibleSection>
  );
}

function ReadFailed({ error, onRetry }: { error: Error; onRetry: () => unknown }) {
  return (
    <div className="mt-4">
      <LoadFailed error={error} onRetry={onRetry} />
    </div>
  );
}

function Loading() {
  return (
    <p className="mt-4 flex items-center gap-2 text-sm text-fg-subtle">
      <LuRefreshCw className="h-3.5 w-3.5 animate-spin" /> {t("Loading…")}
    </p>
  );
}
