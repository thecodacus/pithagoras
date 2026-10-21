import { useEffect, useState } from "react";
import { LuCheck, LuDownload, LuRefreshCw, LuTrash2, LuTriangleAlert } from "react-icons/lu";
import { api, type ManagedUnderstory, type UnderstoryLlmChoice, type UnderstoryState } from "./api";
import { forgetNoteDrafts } from "./note-drafts";
import { publish } from "./state";
import { Link, Select, confirmDialog, formatDateTime, memoryPage, msg, portal, t, tp, tx } from "../portal";

/**
 * The page's first read. Until it has come there is nothing to show, so a
 * failure is said where the page would be, with a way to try again; a banner
 * over a page that spins on forever said it too quietly.
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
    ? tp(waiting, "Idle chats have it now; one busy chat has it from its next step.", "Idle chats have it now; {n} busy chats have it from their next step.")
    : t("Chats have it from now on.");
}

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

/**
 * Understory's page in Settings: run it here, in a container of its own, with
 * the model that keeps the memory and when it tidies up, or point the agent at
 * one run elsewhere; and the switch that makes it the agent's memory.
 */
export function MemorySettings() {
  portal.locale.use();
  const { ui } = portal;
  const inputCls = ui.classes.input;
  const [state, setState, failed, retry] = useFirstRead(api.state);
  const [error, setError] = useState<string | null>(null);
  // The sidebar has the Memory page while Understory is the agent's memory: it follows what this page last read.
  useEffect(() => {
    if (state) publish(state);
  }, [state]);
  const [url, setUrl] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // Said in the language shown, whenever it is drawn.
  const [note, setNote] = useState<(() => string) | null>(null);
  // What is changed here and not saved is in no other place.
  ui.useUnsavedDraft(!!draft);

  // While it is installed, and its image pulled, what the daemon says.
  const watching = Boolean(state?.managed.pulling.active) || busy === INSTALLING;
  // One after the other, never on top of each other: an answer can take a
  // while — it asks whether Understory answers — and older ones must not land last.
  useEffect(() => {
    if (!watching) return;
    let on = true;
    let t: ReturnType<typeof setTimeout> | undefined;
    const next = () => {
      t = setTimeout(async () => {
        const s = await api.state().catch(() => null);
        if (!on) return;
        if (s) setState(s);
        next();
      }, 1500);
    };
    next();
    return () => {
      on = false;
      clearTimeout(t);
    };
  }, [watching]);

  if (!state) return failed ? <ui.LoadFailed error={failed} onRetry={retry} /> : <Loading />;
  const u = state;
  const m = u.managed;
  const form = draft ?? draftOf(m);
  const edit = (patch: Partial<Draft>) => setDraft({ ...form, ...patch });
  const choice = choiceOf(form);
  const runsHere = m.container === "running" || m.container === "stopped";
  const foreign = m.container === "foreign";
  const address = url ?? u.url;
  const origin = originOf(u.url) || null;

  /** Runs one change, and takes what the server says the state is after it. */
  const act = async (what: string, run: () => Promise<{ understory: UnderstoryState; waiting?: number }>) => {
    setBusy(what);
    setNote(null);
    setError(null);
    try {
      const { understory, waiting } = await run();
      setState(understory);
      if (waiting !== undefined) setNote(() => () => reloadNote(waiting));
      return true;
    } catch (e) {
      setError((e as Error).message);
      // What did happen, all the same: a pass that failed is kept as the last one.
      api.state().then(setState).catch(() => {});
      return false;
    } finally {
      setBusy(null);
    }
  };

  const saveSettings = async () => {
    if (!choice) return;
    const ok = await act(runsHere ? msg("Restarting Understory…") : msg("Saving…"), () =>
      api.setConfig(
        { llm: choice, dreamInterval: form.dream === "interval" ? form.dreamInterval : "", dreamAt: form.dream === "time" ? form.dreamAt : "" },
      ),
    );
    if (ok) setDraft(null);
  };
  const saved = !draft;
  const providerModels = m.providers.find((p) => p.id === form.provider)?.models ?? [];

  return (
    <div className="space-y-3">
      {error && (
        <ui.ErrorBanner onClose={() => setError(null)}>
          {error}
        </ui.ErrorBanner>
      )}
      {/* The page's head, drawn by Settings, has the memory's name and mark already. */}
      <p className="rounded-xl border border-line bg-raised/40 p-3 text-[11px] text-fg-faint">
        {tx("A memory that grows: plain markdown on disk, cross-linked and kept tidy, which the agent looks things up in and adds to through its {tools} tools. The portal can run it for you, or point the agent at one you run yourself.", { tools: <code>memory_*</code> })}
      </p>

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
                {!m.autoPossible && ` ${t("Not now: the port Understory reaches the chat's model at could not be taken. UNDERSTORY_LLM_PORT sets another.")}`}
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
                      onClick={() => void act(msg("Tidying up — this takes as long as the model needs…"), () => api.dream())}
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
                onClick={() => void act(INSTALLING, () => api.install())}
                className="inline-flex items-center gap-1.5 rounded-lg bg-accent/12 px-3 py-1.5 text-xs text-accent ring-1 ring-inset ring-accent/25 transition hover:bg-accent/20 disabled:opacity-40"
              >
                <LuDownload className="h-3.5 w-3.5" /> {t("Install and use as the agent's memory")}
              </button>
            ) : (
              <>
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void act(m.container === "running" ? msg("Stopping…") : msg("Starting…"), () => (m.container === "running" ? api.stop() : api.start()))}
                  className="rounded-lg bg-fg/5 px-3 py-1.5 text-xs text-fg-muted transition hover:bg-fg/10"
                >
                  {m.container === "running" ? t("Stop") : t("Start")}
                </button>
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void act(msg("Removing…"), () => api.remove())}
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
                      const removed = await api.remove(true);
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

      <ui.SwitchRow
        title={t("Use Understory as the agent's memory")}
        detail={
          u.enabled
            ? t("On: MEMORY.md is not read while it is. The file is kept, and read again once this is off.")
            : t("Off: the agent's memory is MEMORY.md. Switching on also installs pi-mcp-adapter where it is not, which makes MCP servers into tools.")
        }
        on={u.enabled}
        onChange={(enabled) => void act(enabled ? msg("Switching on…") : msg("Switching off…"), () => api.setUse(enabled && !runsHere ? { enabled, url: address.trim() } : { enabled }))}
        disabled={busy !== null}
      />
      {u.enabled && !runsHere && url !== null && url.trim() !== u.url && (
        <button type="button" disabled={busy !== null} onClick={() => void act(msg("Switching…"), () => api.setUse({ enabled: true, url: address.trim() }))} className="text-xs text-accent hover:underline">
          {t("Use the new address")}
        </button>
      )}
      {u.enabled && (
        <Link to={memoryPage()} className="inline-block text-xs text-accent hover:underline">
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

const originOf = (address: string): string => {
  try {
    return new URL(address).origin;
  } catch {
    return "";
  }
};

function Loading() {
  return (
    <p className="flex items-center gap-2 text-sm text-fg-subtle">
      <LuRefreshCw className="h-3.5 w-3.5 animate-spin" /> {t("Loading…")}
    </p>
  );
}
