import { useMemo, useState } from "react";
import { LuArrowRight, LuPlus, LuRefreshCw, LuRocket } from "react-icons/lu";
import { api, type AvailableModel } from "../api";
import { forget, refreshFailed, useCached } from "../settings-cache";
import { Modal } from "./Modal";
import { PackageCatalog } from "./PackageCatalog";
import { KindIcon, ProviderEditor, StatusBadge, takenProviderIds, useInstalledPackages, useProviderStatus } from "./ProvidersPanel";
import { Select } from "./Select";
import { SetupNav, SetupSteps } from "./SetupSteps";
import { EffortPicker, LoadFailed, ghostCls, primaryCls } from "./SettingsUi";
import { msg, t, tp } from "../i18n";
import { SkeletonGroup } from "./Skeleton";

import { modelTraits } from "../model-traits";
import { dismissSetup as dismiss } from "../setup-state";

const STEPS = [
  { title: msg("Provider"), lead: msg("Where the models come from") },
  { title: msg("Model"), lead: msg("What new chats start with") },
  { title: msg("Agent"), lead: msg("What it can do besides") },
];

/**
 * The first run, one step at a time: a provider, the model new chats start
 * with, and what the agent can do beyond its own tools. Each step is what
 * the matching Settings page does, and each can be changed there later.
 * It opens by itself while no model can be used, until it is finished or
 * skipped; Settings → Providers opens it again.
 */
export function SetupAssistant({ onClose, onStartChat }: { onClose: () => void; onStartChat: () => void }) {
  const [step, setStep] = useState(0);
  const [back, setBack] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const providers = useCached("providers", api.providers, { onError: refreshFailed("providers", setError) });
  const models = useCached("models", api.allModels, { freshMs: 0 });
  const settings = useCached("settings", api.settings);
  const status = useProviderStatus();
  const installed = useInstalledPackages();
  const [adding, setAdding] = useState(false);
  const [choice, setChoice] = useState<string | null>(null);
  const [effort, setEffort] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const list = models.value?.models ?? [];
  const ready = list.length > 0;
  const configured = providers.value?.providers ?? [];

  const keyOf = (m: { provider: string; id: string }) => `${m.provider}\u0000${m.id}`;
  const stored = settings.value?.stored.model ? `${settings.value.stored.provider || settings.value.defaults.provider}\u0000${settings.value.stored.model}` : "";
  // A stored model that can no longer be used is no choice: the first that can is offered instead, and saved on Next.
  // Nothing until what is stored is known, or the first would be offered over a stored one that is fine.
  const current = choice ?? (!settings.value ? "" : list.some((m) => keyOf(m) === stored) ? stored : list[0] ? keyOf(list[0]) : "");
  const picked = list.find((m) => keyOf(m) === current);
  const level = effort ?? settings.value?.stored.thinkingLevel ?? "";

  // What this step is drawn from. Without it the menu is empty and Next is off, and nothing says why.
  const stepOneFailed = (!models.value && models.failed) || (!settings.value && settings.failed) || null;

  const go = (to: number) => {
    setBack(to < step);
    setError(null);
    setStep(to);
  };

  const providerSaved = async () => {
    forget("models");
    setAdding(false);
    await Promise.all([providers.reload(), models.reload()]);
    status.check();
  };

  const saveModel = async () => {
    if (!settings.value) return;
    if (!picked) return go(2);
    setSaving(true);
    try {
      // A model that does not think leaves the effort stored as it is, for the ones that do.
      await api.saveSettings({ provider: picked.provider, model: picked.id, thinkingLevel: picked.reasoning ? level : settings.value.stored.thinkingLevel ?? "" });
      forget("settings");
      go(2);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const later = () => {
    dismiss("skipped");
    onClose();
  };

  const finish = (start: boolean) => {
    dismiss("done");
    onClose();
    if (start) onStartChat();
  };

  const modelOptions = useMemo(
    () =>
      list.map((m) => ({
        value: keyOf(m),
        label: m.name,
        text: `${m.name} ${m.id} ${m.provider}`,
        hint: describe(m, models.value?.providers[m.provider]),
      })),
    [list, models.value],
  );

  return (
    <Modal
      title={t("Set up Pithagoras")}
      subtitle={t("Three steps. Everything here can be changed later in Settings.")}
      onClose={later}
      footer={
        <>
          <SetupNav
            onBack={step > 0 ? () => go(step - 1) : undefined}
            busy={saving}
            leave={<button type="button" onClick={later} className={ghostCls}>{t("Set up later")}</button>}
          >
            {step === 0 && (
              <button type="button" disabled={!ready} onClick={() => go(1)} className={primaryCls} title={ready ? undefined : t("Add a provider with at least one model first")}>
                {t("Next")} <LuArrowRight className="h-4 w-4" />
              </button>
            )}
            {step === 1 && (
              <button type="button" disabled={saving || !settings.value} onClick={() => void saveModel()} className={primaryCls}>
                {saving ? <LuRefreshCw className="h-4 w-4 animate-spin" /> : null} {t("Next")} <LuArrowRight className="h-4 w-4" />
              </button>
            )}
            {step === 2 && (
              <>
                <button type="button" onClick={() => finish(false)} className={ghostCls}>{t("Done")}</button>
                <button type="button" onClick={() => finish(true)} className={primaryCls}><LuRocket className="h-4 w-4" /> {t("Start a chat")}</button>
              </>
            )}
          </SetupNav>
          {/* In the footer, which is always in sight, rather than in the one-line
              subtitle, where it was cut off: every way out (Set up later, close,
              Escape) leaves the assistant for good. */}
          <p className="mt-2 text-[11px] text-fg-faint">{t("{settings} → {providers} opens this assistant again.", { settings: t("Settings"), providers: t("Providers") })}</p>
        </>
      }
    >
      <div className="mb-5">
        <SetupSteps steps={STEPS.map((s) => s.title)} current={step} />
      </div>

      {error && <p role="alert" className="mb-3 rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger">{error}</p>}

      {/* One height for every step: the dialog is centred, and a step of
          another height moved the whole of it up or down as it came in. */}
      <div key={step} className={`setup-pane min-h-[min(30rem,58vh)] ${back ? "is-back" : ""}`}>
        <h3 className="text-base font-medium text-fg">{t(STEPS[step].lead)}</h3>

        {step === 0 && (
          <div className="mt-1">
            <p className="mb-4 text-sm text-fg-subtle">
              {t("A server on your network — llama.cpp, llama-swap, Ollama — or a hosted service with a key. Its models are looked up as soon as it answers.")}
            </p>
            {!providers.value && providers.failed ? (
              <LoadFailed error={providers.failed} onRetry={providers.reload} />
            ) : !providers.value ? (
              <SkeletonGroup className="space-y-2" label={t("Loading…")}><div className="skeleton h-10 w-full" /><div className="skeleton h-24 w-full" /></SkeletonGroup>
            ) : configured.length > 0 && !adding ? (
              <>
                <ul className="stagger-in space-y-1.5">
                  {configured.map((p) => (
                    <li key={p.id} className="flex items-center gap-3 rounded-xl border border-line bg-raised/40 px-3 py-2.5">
                      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-accent/10 text-accent"><KindIcon kind={p.kind} /></span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm text-fg">{p.label}</p>
                        <p className="truncate text-[11px] text-fg-faint">
                          {p.endpoint ? `${tp(p.models.length, "{n} model", "{n} models")} · ${p.baseUrl}` : t("Hosted — every model pi knows of from it")}
                        </p>
                      </div>
                      {p.endpoint && <StatusBadge status={status.of[p.id]} />}
                    </li>
                  ))}
                </ul>
                <button type="button" onClick={() => setAdding(true)} className={`${ghostCls} mt-2`}><LuPlus className="h-3.5 w-3.5" /> {t("Add another")}</button>
                {!ready && models.value && <p className="mt-2 text-xs text-warn">{t("None of these offers a model yet — edit one in Settings → Providers, or add another.")}</p>}
              </>
            ) : (
              <div className="rounded-xl border border-line bg-raised/30 p-4">
                <ProviderEditor
                  embedded
                  view={providers.value}
                  taken={takenProviderIds(configured)}
                  onCancel={() => setAdding(false)}
                  onSaved={() => void providerSaved()}
                  onInstalled={() => void Promise.all([providers.reload(), models.reload()])}
                  onError={setError}
                />
                {configured.length > 0 && (
                  <button type="button" onClick={() => setAdding(false)} className={`${ghostCls} mt-2`}>{t("Keep what is set up")}</button>
                )}
              </div>
            )}
          </div>
        )}

        {/* Nothing changes while the model saves: a change would miss what is sent. */}
        {step === 1 && stepOneFailed && (
          <div className="mt-3">
            <LoadFailed error={stepOneFailed} onRetry={() => Promise.all([models.reload(), settings.reload()])} />
          </div>
        )}
        {step === 1 && !stepOneFailed && (
          <fieldset disabled={saving} className="mt-1 min-w-0 space-y-4">
            <p className="text-sm text-fg-subtle">{t("Each chat can switch under its chat box; this is only where they start.")}</p>
            <Select className="w-full" aria-label={t("Model for new chats")} value={current} options={modelOptions} onChange={setChoice} placeholder={t("Choose a model…")} />
            {picked?.reasoning ? (
              <div className="float-in">
                <p className="mb-1 text-xs text-fg-muted">{t("How hard it thinks")} <span className="text-fg-faint">{t("— more is slower, and usually better")}</span></p>
                <EffortPicker label={t("Effort for new chats")} value={level} inherited={settings.value?.defaults.thinkingLevel} onChange={setEffort} />
              </div>
            ) : picked ? (
              <p className="text-xs text-fg-faint">{t("This model answers straight away, without a thinking phase.")}</p>
            ) : null}
          </fieldset>
        )}

        {step === 2 && (
          <div className="mt-1">
            <p className="mb-4 text-sm text-fg-subtle">
              {t("pi reads, writes and runs commands on its own. Packages add more — searching the web, delegating to helpers, other tools. These are the most used; Settings → Extensions has the rest.")}
            </p>
            <PackageCatalog installed={installed.names} onInstalled={() => void installed.reload()} onError={setError} limit={5} searchable={false} />
          </div>
        )}
      </div>
    </Modal>
  );
}

function describe(m: AvailableModel, providerName?: string): string {
  return [providerName ?? m.provider, ...modelTraits(m)].join(" · ");
}
