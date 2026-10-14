import { useEffect, useState } from "react";
import { api, type PiModel } from "../api";
import { load, peek, useCached } from "../settings-cache";
import { Select } from "./Select";
import { t } from "../i18n";

interface SubagentChoice {
  /** The subagent tool is on: there is something to decide. */
  on: boolean;
  /** This chat's own choice (null follows `default`), once known. */
  choice?: { model: string | null; default: string };
  set(model: string | null): void;
}

/**
 * What this chat's subagents run on, fetched with the chat rather than when
 * its model menu opens: asked then, the menu opened without it and the row
 * arrived a moment later, pushing the rest down. Kept per chat, so going back
 * to one draws it at once, and asked again quietly.
 */
export function useSubagentChoice(sessionId: string, onError?: (e: string) => void): SubagentChoice {
  const features = useCached("feature-flags", api.featureFlags, { freshMs: 30_000 });
  const on = features.value?.subagent?.enabled === true;
  // Asked only while the tool is on: otherwise there is nothing to show, and a chat not yet saved has no answer.
  const key = `subagent-model:${sessionId}`;
  const [value, setValue] = useState<{ model: string | null; default: string } | undefined>(() => peek(key));
  const reloadStored = () => load(key, () => api.subagentModel(sessionId), 0, true).then(setValue, () => {});
  useEffect(() => {
    setValue(peek(key));
    if (!on) return;
    let current = true;
    load(key, () => api.subagentModel(sessionId), 30_000).then((v) => current && setValue(v), () => {});
    return () => {
      current = false;
    };
  }, [key, on]);
  // What was just chosen here, until the server has said it back.
  const [picked, setPicked] = useState<{ model: string | null } | null>(null);
  useEffect(() => setPicked(null), [sessionId]);

  // Settings → Add-ons says when it switches the tool on or off.
  const reloadFeatures = features.reload;
  useEffect(() => {
    const again = () => void reloadFeatures();
    window.addEventListener("features-changed", again);
    return () => window.removeEventListener("features-changed", again);
  }, [reloadFeatures]);

  // Only an answer that is one: a server that says something else leaves the menu as it was.
  const known = typeof value?.default === "string" ? value : undefined;
  const choice = known && (picked ? { ...known, ...picked } : known);
  return {
    on,
    choice,
    set: (model) => {
      setPicked({ model });
      api.setSubagentModel(sessionId, model).then(
        () => reloadStored().then(() => setPicked(null)),
        (e: Error) => {
          setPicked(null);
          onError?.(e.message);
        },
      );
    },
  };
}

/**
 * The row in a chat's model menu: its subagents run on the portal's default,
 * the chat's own model, or one named. Only while the subagent tool is on.
 * Read when a subagent starts, so a change needs no restart.
 */
export function SubagentModelPicker({ subagents, models }: { subagents: SubagentChoice; models: PiModel[] }) {
  const { on, choice, set } = subagents;
  if (!on || !choice) return null;
  const named = (value: string) => (value === "auto" ? t("this chat's model") : value);
  const value = choice.model ?? "";
  return (
    <div className="px-3 py-1.5">
      <p className="text-[11px] text-fg-subtle">{t("Subagents in this chat run on")}</p>
      <Select
        aria-label={t("Subagents in this chat run on")}
        size="sm"
        className="mt-1 w-full"
        value={value}
        onChange={(v) => set(v === "" ? null : v)}
        options={[
          { value: "", label: t("Default — {model}", { model: named(choice.default) }) },
          { value: "auto", label: t("This chat's model"), hint: t("The one it is on when it starts one") },
          ...(value && value !== "auto" && !models.some((m) => `${m.provider}/${m.id}` === value) ? [{ value, label: value }] : []),
          ...models.map((m) => ({ value: `${m.provider}/${m.id}`, label: m.name || m.id, hint: `${m.provider}/${m.id}` })),
        ]}
      />
    </div>
  );
}
