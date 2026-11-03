import { useEffect, useMemo, useRef, useState } from "react";
import { LuCheck, LuCircleAlert, LuRefreshCw } from "react-icons/lu";
import { api, type ShippedExtension } from "../api";
import { forget, useCached } from "../settings-cache";
import { msg, t, tp } from "../i18n";
import { shippedLabel, shippedLine } from "../shipped-extensions";
import { InstallProgress, installExtension, type InstallStep } from "./ExtensionInstall";
import { useInstalledPackages } from "./ProvidersPanel";
import { LoadFailed } from "./SettingsUi";
import { SkeletonGroup } from "./Skeleton";

/**
 * The setup assistant's extension step: a set of the portal's own extensions to start from, or a choice by hand, and
 * what is missing of it installed the way Settings → Extensions → Discover installs one (ExtensionInstall.tsx), with
 * what an extension needs installed first. The state is the assistant's, so its buttons can act on it.
 */

const DOCKER = "pithagoras-docker";

/** The sets by id, as a person is told of them. One the portal offers that is not here is shown by its id. */
const PRESETS: Record<string, { label: string; line: string }> = {
  minimal: { label: msg("Minimal"), line: msg("Terminal, Files and the themes") },
  developer: { label: msg("Developer"), line: msg("Adds Git, Docker for extensions and Documents") },
  creative: { label: msg("Creative"), line: msg("Adds Media, Canvases and Voice") },
  everything: { label: msg("Everything"), line: msg("Every extension that comes with Pithagoras") },
};

type Progress = { state: "waiting" | "installing" | "done" } | { state: "failed"; error: string };

export function useExtensionChoice() {
  const shipped = useCached("extensions-shipped", api.shippedExtensions, { freshMs: 30_000 });
  const presets = useCached("extension-presets", api.extensionPresets, { freshMs: 60_000 });
  const installed = useInstalledPackages();
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<Record<string, Progress>>({});
  const [step, setStep] = useState<InstallStep | null>(null);
  // The assistant can be closed while an install goes on: it then begins no other.
  const here = useRef(true);
  useEffect(() => {
    here.current = true;
    return () => void (here.current = false);
  }, []);

  const list = useMemo(() => {
    const all = shipped.value?.extensions ?? [];
    // The order of the biggest set: what a portal starts with first, then the rest as the portal lists them.
    const order = presets.value?.presets.find((p) => p.id === "everything")?.extensions ?? [];
    const rank = (name: string) => (order.includes(name) ? order.indexOf(name) : order.length);
    return [...all].sort((a, b) => rank(a.name) - rank(b.name));
  }, [shipped.value, presets.value]);
  const names = useMemo(() => new Set(list.map((ext) => ext.name)), [list]);
  const have = (name: string) => installed.names.has(name);

  // Minimal until the person chooses: with what is installed already counted in either way.
  const minimal = presets.value?.presets.find((p) => p.id === "minimal")?.extensions ?? [];
  const selected = picked ?? new Set(minimal);
  const wanted = (from: Iterable<string>) => new Set([...from, ...[...names].filter(have)].filter((name) => names.has(name)));
  const active = presets.value?.presets.find((p) => {
    const a = wanted(p.extensions);
    const b = wanted(selected);
    return a.size === b.size && [...a].every((name) => b.has(name));
  })?.id;

  const missing = list.filter((ext) => selected.has(ext.name) && !have(ext.name));
  // Told before they are installed, since they are installed without another question.
  const needDocker = missing.filter((ext) => ext.requires && DOCKER in ext.requires && ext.name !== DOCKER && !have(DOCKER));
  const failed = Object.values(progress).some((p) => p.state === "failed");

  const choose = (names: string[]) => {
    setPicked(new Set(names));
    setProgress({});
  };
  const toggle = (name: string) => {
    const next = new Set(selected);
    if (!next.delete(name)) next.add(name);
    setPicked(next);
    setProgress({});
  };

  /** Installs what is missing, those that need nothing first. Resolves true when every one of them is in. */
  const run = async (): Promise<boolean> => {
    setRunning(true);
    const todo = [...missing].sort((a, b) => Number(Boolean(a.requires)) - Number(Boolean(b.requires)));
    setProgress(Object.fromEntries(todo.map((ext) => [ext.name, { state: "waiting" } as Progress])));
    let ok = true;
    try {
      for (const ext of todo) {
        if (!here.current) return false;
        try {
          // What an extension before it brought in (Docker for extensions, for Voice) is not installed again.
          const now = new Set((await api.extensions()).extensions.map((e) => e.name));
          if (!now.has(ext.name)) {
            setProgress((all) => ({ ...all, [ext.name]: { state: "installing" } }));
            if ((await installExtension(ext.spec, { progress: setStep, announced: true })) === false) throw new Error(t("Not installed."));
          }
          setProgress((all) => ({ ...all, [ext.name]: { state: "done" } }));
        } catch (e) {
          ok = false;
          setProgress((all) => ({ ...all, [ext.name]: { state: "failed", error: (e as Error).message } }));
        }
      }
    } finally {
      forget("extensions");
      forget("extensions-shipped");
      await installed.reload();
      if (here.current) setRunning(false);
    }
    return ok;
  };

  return { shipped, presets, list, have, selected, active, choose, toggle, missing, needDocker, failed, running, progress, step, run };
}

export type ExtensionChoice = ReturnType<typeof useExtensionChoice>;

export function ExtensionStep({ choice }: { choice: ExtensionChoice }) {
  const { shipped, presets, list, have, selected, active, choose, toggle, needDocker, running, progress, step } = choice;
  const label = (name: string) => shippedLabel(name);
  const loadFailed = (!shipped.value && shipped.failed) || (!presets.value && presets.failed) || null;
  return (
    <div className="mt-1">
      <p className="mb-4 text-sm text-fg-subtle">
        {t("Pick a set to start from, or choose the extensions by hand. All of it can be changed later in Settings → Extensions.")}
      </p>
      {loadFailed ? (
        <LoadFailed error={loadFailed} onRetry={() => Promise.all([shipped.reload(), presets.reload()])} />
      ) : !shipped.value || !presets.value ? (
        <SkeletonGroup className="space-y-2" label={t("Loading…")}><div className="skeleton h-16 w-full" /><div className="skeleton h-16 w-full" /></SkeletonGroup>
      ) : list.length === 0 ? (
        <p className="text-sm text-fg-faint">{t("This portal has no extensions of its own to offer.")}</p>
      ) : (
        <fieldset disabled={running} className="min-w-0 space-y-4">
          <div role="radiogroup" aria-label={t("Set of extensions")} className="grid gap-2 sm:grid-cols-2">
            {presets.value.presets.map((p) => {
              const on = active === p.id;
              return (
                <button
                  key={p.id}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  onClick={() => choose(p.extensions)}
                  className={`rounded-xl px-3 py-2.5 text-left transition ${on ? "bg-accent/12 ring-1 ring-inset ring-accent/30" : "bg-fg/5 hover:bg-fg/10"}`}
                >
                  <span className={`block text-sm font-medium ${on ? "text-accent" : "text-fg"}`}>{PRESETS[p.id] ? t(PRESETS[p.id].label) : p.id}</span>
                  <span className="block text-xs text-fg-faint">{PRESETS[p.id] ? t(PRESETS[p.id].line) : ""}</span>
                </button>
              );
            })}
          </div>

          <details className="rounded-xl border border-line bg-raised/30">
            <summary className="cursor-pointer px-3 py-2 text-sm text-fg-muted">
              {t("Choose by hand")}
              {active === undefined && <span className="ml-2 text-xs text-accent">{t("Your own choice")}</span>}
            </summary>
            <ul className="divide-y divide-line">
              {list.map((ext: ShippedExtension) => {
                const installedNow = have(ext.name);
                const needs = Object.keys(ext.requires ?? {});
                return (
                  <li key={ext.name}>
                    <label className="flex cursor-pointer items-start gap-3 px-3 py-2">
                      <input
                        type="checkbox"
                        aria-label={label(ext.name)}
                        checked={installedNow || selected.has(ext.name)}
                        disabled={installedNow}
                        onChange={() => toggle(ext.name)}
                        className="mt-1 h-3.5 w-3.5 accent-accent"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm text-fg">{label(ext.name)}</span>
                        <span className="block text-xs text-fg-faint">{shippedLine(ext.name, ext.description)}</span>
                        {needs.length > 0 && <span className="block text-xs text-fg-muted">{t("Needs {names}", { names: needs.map(label).join(", ") })}</span>}
                      </span>
                      {installedNow && (
                        <span className="inline-flex shrink-0 items-center gap-1 rounded-lg bg-ok/10 px-2 py-0.5 text-[11px] text-ok">
                          <LuCheck className="h-3.5 w-3.5" /> {t("Installed")}
                        </span>
                      )}
                    </label>
                  </li>
                );
              })}
            </ul>
          </details>

          {needDocker.length > 0 && (
            <p className="text-xs text-fg-muted">
              {tp(needDocker.length, "{names} needs Docker for extensions, which is installed first.", "{names} need Docker for extensions, which is installed first.", { names: needDocker.map((ext) => label(ext.name)).join(", ") })}
            </p>
          )}

          {Object.keys(progress).length > 0 && (
            <ul className="space-y-1.5" aria-label={t("Installing")}>
              {Object.entries(progress).map(([name, p]) => (
                <li key={name} className="flex items-start gap-2 text-xs">
                  {p.state === "installing" ? <LuRefreshCw className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin text-fg-muted" aria-hidden /> : p.state === "done" ? <LuCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ok" aria-hidden /> : p.state === "failed" ? <LuCircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-danger" aria-hidden /> : <span className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
                  <span className="min-w-0 flex-1">
                    <span className="text-fg">{label(name)}</span>{" "}
                    {p.state === "failed" ? (
                      <span role="alert" className="whitespace-pre-wrap break-words text-danger">{p.error}</span>
                    ) : (
                      <span className="text-fg-faint">{p.state === "waiting" ? t("Waiting") : p.state === "installing" ? t("Installing…") : t("Installed")}</span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <InstallProgress step={step} />
        </fieldset>
      )}
    </div>
  );
}
