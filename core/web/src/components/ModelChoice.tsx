import { useEffect, useMemo, useState } from "react";
import type { AvailableModel } from "../api";
import { t, tp } from "../i18n";
import { modelTraits } from "../model-traits";
import { Select } from "./Select";
import { inputCls } from "./SettingsUi";

/** What a model can do, said in a few words under its name. */
function modelHint(m: AvailableModel): string {
  return [m.name !== m.id ? m.id : "", ...modelTraits(m)].filter(Boolean).join(" · ");
}

/**
 * The provider and model menus of Settings → Defaults, which Settings → Modes chooses with too, so that the two
 * cannot drift. Not the composer's: those are bound to a live chat. A blank in either is left to what is under the
 * choice (`inherit`). A provider chosen keeps the model where it offers it too. Where the models cannot be read, two
 * fields to type the names in, each saved as it is left.
 */
export function ModelChoice({
  models,
  failed,
  provider,
  model,
  onChange,
  labels,
  inherit,
}: {
  /** The models there are (GET /api/models), null while they are asked for. */
  models: { models: AvailableModel[]; providers: Record<string, string> } | null;
  /** They could not be read. */
  failed: boolean;
  /** What is chosen; "" for none. */
  provider: string;
  model: string;
  onChange: (next: { provider: string; model: string }) => void;
  /** What a screen reader calls the two menus. */
  labels: { provider: string; model: string };
  /**
   * What a blank stands for: the provider and model under the choice, where they are known, which the first option
   * of each menu is called by (`label`, with the name), and what that option says under it.
   */
  inherit: { provider?: string; model?: string; label: (name?: string) => string; hints?: { provider: string; model: string } };
}) {
  const [typed, setTyped] = useState({ provider, model });
  useEffect(() => setTyped({ provider, model }), [provider, model]);

  const byProvider = useMemo(() => {
    const map = new Map<string, AvailableModel[]>();
    for (const m of models?.models ?? []) map.set(m.provider, [...(map.get(m.provider) ?? []), m]);
    return map;
  }, [models]);

  const providerName = (id: string) => models?.providers[id] ?? id;
  const providerOptions = [
    { value: "", label: inherit.label(inherit.provider ? providerName(inherit.provider) : undefined), hint: inherit.hints?.provider },
    ...[...byProvider.entries()].map(([id, list]) => ({ value: id, label: providerName(id), hint: tp(list.length, "{n} model", "{n} models") })),
    ...(provider && !byProvider.has(provider) ? [{ value: provider, label: provider, hint: t("Not available now — no key, or not set up") }] : []),
  ];
  const offered = byProvider.get(provider || (inherit.provider ?? "")) ?? [];
  const modelOptions = [
    {
      value: "",
      label: inherit.label(inherit.model && (!provider || provider === inherit.provider) ? (offered.find((m) => m.id === inherit.model)?.name ?? inherit.model) : undefined),
      hint: inherit.hints?.model,
    },
    ...offered.map((m) => ({ value: m.id, label: m.name, text: `${m.name} ${m.id}`, hint: modelHint(m) || undefined })),
    ...(model && !offered.some((m) => m.id === model) ? [{ value: model, label: model, hint: t("Not offered by this provider now") }] : []),
  ];

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="block">
        <span className="text-xs text-fg-muted">{t("Provider")}</span>
        {failed ? (
          <input value={typed.provider} onChange={(e) => setTyped({ ...typed, provider: e.target.value })} onBlur={() => onChange(typed)} placeholder={inherit.provider || t("inherit")} className={`${inputCls} mt-1 font-mono`} />
        ) : (
          <Select
            className="mt-1 w-full"
            aria-label={labels.provider}
            value={provider}
            options={providerOptions}
            disabled={!models}
            placeholder={t("Loading…")}
            onChange={(next) => {
              const keeps = (byProvider.get(next || (inherit.provider ?? "")) ?? []).some((m) => m.id === model);
              onChange({ provider: next, model: keeps ? model : "" });
            }}
          />
        )}
      </label>
      <label className="block">
        <span className="text-xs text-fg-muted">{t("Model")}</span>
        {failed ? (
          <input value={typed.model} onChange={(e) => setTyped({ ...typed, model: e.target.value })} onBlur={() => onChange(typed)} placeholder={inherit.model || t("pi decides")} className={`${inputCls} mt-1 font-mono`} />
        ) : (
          <Select
            className="mt-1 w-full"
            aria-label={labels.model}
            value={model}
            options={modelOptions}
            disabled={!models}
            placeholder={t("Loading…")}
            onChange={(next) => onChange({ provider, model: next })}
          />
        )}
      </label>
    </div>
  );
}
