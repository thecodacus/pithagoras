import { useEffect, useId, useState } from "react";
import { Select, msg, portal, t, tp, tx } from "../portal";

/**
 * The subagent extension's page in Settings: how a subagent runs against the agent, what it runs on unless its chat
 * says otherwise, and how many run at once. It is switched on and off in Settings → Extensions, like any extension.
 */

type Mode = "interrupt" | "background";

/** The settings as the server half says them (server.ts). */
interface Shown {
  mode: Mode;
  maxParallel: number;
  /** The most that may be set. */
  maxParallelLimit: number;
  /** "auto", the model the chat is on, or "provider/model". */
  model: string;
}

/** A model pi can use now, as the portal lists them (GET /api/models). */
interface Model {
  provider: string;
  id: string;
  name?: string;
}

const settingsUrl = () => portal.api.url("/settings");
const readSettings = () => portal.api.json<Shown>(settingsUrl());
const saveSettings = (change: Partial<Pick<Shown, "mode" | "maxParallel" | "model">>) =>
  portal.api.json<Shown & { reloaded: number; waiting: number }>(settingsUrl(), { method: "PUT", body: JSON.stringify(change) });

/** What a change did to the chats that are open. */
function reloadNote(waiting: number): string {
  return waiting
    ? tp(waiting, "Idle chats have it now; one busy chat has it from its next step.", "Idle chats have it now; {n} busy chats have it from their next step.")
    : t("Chats have it from now on.");
}

const MODES: { value: Mode; label: string; detail: string }[] = [
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

export function SubagentSettings() {
  const ui = portal.ui;
  const [shown, setShown] = useState<Shown | null>(null);
  const [failed, setFailed] = useState<Error | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Said in the language shown, whenever it is drawn.
  const [note, setNote] = useState<(() => string) | null>(null);
  const name = useId();
  // Every model there is, to name one for subagents rather than the chat's.
  const [models, setModels] = useState<Model[]>([]);

  const read = () =>
    readSettings().then(
      (s) => {
        setFailed(null);
        setShown(s);
      },
      (e: Error) => setFailed(e),
    );
  useEffect(() => {
    void read();
    portal.api.json<{ models: Model[] }>("/api/models").then((r) => setModels(r.models), () => {});
  }, []);

  // A first read that failed is said where the page would be, with a way to try again.
  if (!shown) return failed ? <ui.LoadFailed error={failed} onRetry={read} /> : <p className="text-sm text-fg-subtle">{t("Loading…")}</p>;
  const s = shown;

  const change = async (patch: Partial<Pick<Shown, "mode" | "maxParallel" | "model">>) => {
    setBusy(true);
    setNote(null);
    setError(null);
    // The choice shows at once; what the server says after is what stays.
    setShown({ ...s, ...patch });
    try {
      const { reloaded: _reloaded, waiting, ...saved } = await saveSettings(patch);
      setShown(saved);
      setNote(() => () => reloadNote(waiting));
    } catch (e) {
      setShown(s);
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      {error && <ui.ErrorBanner onClose={() => setError(null)}>{error}</ui.ErrorBanner>}
      {/* The page's head, drawn by Settings, has the extension's name and mark already. Each part is named for Settings' search (client.tsx). */}
      <p className="text-xs text-fg-faint">
        {tx("A {tool} tool: the agent hands a self-contained task to a second agent with a context of its own, and gets its answer back. You can watch it beside the chat and give it instructions while it works.", { tool: <code>subagent</code> })}
      </p>
      <div className="space-y-3">
        <fieldset data-setting={t("How a subagent runs against the agent")} className="rounded-xl border border-line bg-raised/40 p-3" disabled={busy}>
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
        <div data-setting={t("Subagent model")} className="rounded-xl border border-line bg-raised/40 p-3 text-sm text-fg">
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
        <div data-setting={t("Subagents at once")} className="flex items-start gap-3 rounded-xl border border-line bg-raised/40 p-3">
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
              <Sign plus={false} />
            </button>
            <output aria-live="polite" className="w-6 text-center text-sm tabular-nums text-fg">{s.maxParallel}</output>
            <button
              type="button"
              aria-label={t("More at once")}
              disabled={busy || s.maxParallel >= s.maxParallelLimit}
              onClick={() => void change({ maxParallel: s.maxParallel + 1 })}
              className="grid h-7 w-7 place-items-center rounded-lg bg-fg/5 text-fg-muted transition hover:bg-fg/10 disabled:opacity-40"
            >
              <Sign plus />
            </button>
          </div>
        </div>
        {busy && <p className="text-xs text-fg-subtle">{t("Applying…")}</p>}
        {note && !busy && <p role="status" className="text-xs text-fg-muted">{note()}</p>}
      </div>
    </div>
  );
}

/** The stepper's minus or plus, drawn as the portal's icons are, at the size of its text. */
function Sign({ plus }: { plus: boolean }) {
  return (
    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d={plus ? "M5 12h14M12 5v14" : "M5 12h14"} />
    </svg>
  );
}
