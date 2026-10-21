import { useEffect, useId, useState, type ReactNode } from "react";
import { LuBot, LuMinus, LuPlus, LuRefreshCw } from "react-icons/lu";
import { api, type AvailableModel, type SubagentMode } from "../api";
import { Select } from "./Select";
import { LoadFailed, SwitchRow } from "./SettingsUi";
import { msg, t, tp, tx } from "../i18n";

/**
 * The opt-in add-ons: off in a fresh install, one switch each. Each is written
 * into pi's own configuration — a package — so what the switch does can also
 * be seen, and undone, from Extensions.
 */

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
