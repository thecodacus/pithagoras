import { useEffect, useState } from "react";
import { LuCheck, LuDownload, LuExternalLink, LuPackage, LuRefreshCw, LuSearch, LuTrendingUp } from "react-icons/lu";
import { api, type CatalogPackage } from "../api";
import { ago, compactCount, webLink } from "../package-names";
import { InstallProgress, installExtension, type InstallStep } from "./ExtensionInstall";
import { load, peek } from "../settings-cache";
import { gridCls, inputCls } from "./SettingsUi";
import { formatNumber, t } from "../i18n";
import { SkeletonGroup } from "./Skeleton";

/**
 * pi packages published on npm, to install with a click rather than a spec
 * typed from memory. Without a search, the most used come first; `topic`
 * "provider" narrows it to packages that bring models.
 */
export function PackageCatalog({
  topic,
  installed,
  onInstalled,
  onError,
  limit = 8,
  searchable = true,
  wide = false,
}: {
  topic?: "provider";
  /** npm names already installed. */
  installed: Set<string>;
  /** Told when what is installed has changed: after an install, and after one that failed once what it needs was installed. */
  onInstalled: () => void;
  onError: (e: string) => void;
  limit?: number;
  searchable?: boolean;
  /** Side by side where there is room for two, for a page that has it. */
  wide?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [asked, setAsked] = useState("");
  const key = (q: string) => `catalog:${topic ?? ""}:${q.trim().toLowerCase()}`;
  const [found, setFound] = useState<CatalogPackage[] | undefined>(() => peek(key("")));
  const [failed, setFailed] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  // Which package an install of more than one has come to: one that needs others installs them first.
  const [step, setStep] = useState<InstallStep | null>(null);
  const [done, setDone] = useState<Set<string>>(new Set());

  // Asked a moment after the last key, not on every one.
  useEffect(() => {
    const t = setTimeout(() => setAsked(query), query ? 350 : 0);
    return () => clearTimeout(t);
  }, [query]);

  const fetchList = (q: string) => {
    let current = true;
    setFailed(null);
    const kept = peek<CatalogPackage[]>(key(q));
    if (kept) setFound(kept);
    load(key(q), () => api.catalog(q, topic).then((r) => r.packages), 10 * 60_000).then(
      (list) => { if (current) { setFound(list); setMore(false); } },
      (e: Error) => { if (current) setFailed(e.message); },
    );
    return () => { current = false; };
  };
  useEffect(() => fetchList(asked), [asked, topic]);

  const install = async (p: CatalogPackage) => {
    // Busy from the start, as what it needs is asked of the server before the question that lists it; said to be installing once it is.
    setBusy(p.name);
    // Which package it came to: one that fails after what it needs was installed has changed what is installed all the same.
    let reached = 0;
    try {
      const installed = await installExtension(`npm:${p.name}`, {
        ask: {
          title: t("Install {name}?", { name: p.name }),
          message: `${t("It is installed from npm and runs inside pi with the same rights as the agent — reading files, running commands. Install packages you trust.")}${p.author ? ` ${t("Published by {author}.", { author: p.author })}` : ""}`,
        },
        progress: (step) => {
          setStep(step);
          if (step) reached = step.n;
        },
      });
      if (!installed) return;
      setDone((d) => new Set(d).add(p.name));
      onInstalled();
    } catch (e) {
      onError((e as Error).message);
      if (reached > 1) onInstalled();
    } finally {
      setBusy(null);
    }
  };

  const shown = found ? (more ? found : found.slice(0, limit)) : [];
  const rows = wide ? gridCls : "space-y-1.5";

  return (
    <div>
      {searchable && (
        <div className={`relative ${wide ? "max-w-3xl" : ""}`}>
          <LuSearch className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-fg-faint" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={topic === "provider" ? t("Search provider packages — litellm, cohere, gateway…") : t("Search pi packages — web search, subagents, themes…")}
            aria-label={t("Search packages")}
            className={`${inputCls} pl-8`}
          />
        </div>
      )}
      <InstallProgress step={step} />

      {failed ? (
        <div className="mt-2 flex items-center gap-2 rounded-xl border border-dashed border-line px-3 py-4 text-xs text-fg-subtle">
          <span className="flex-1">{failed}</span>
          <button type="button" onClick={() => fetchList(asked)} className="text-accent hover:underline">{t("Try again")}</button>
        </div>
      ) : !found ? (
        <SkeletonGroup className={`mt-2 ${rows}`} label={t("Loading packages")}>
          {[0, 1, 2].map((i) => <div key={i} className="skeleton h-16 w-full" />)}
        </SkeletonGroup>
      ) : found.length === 0 ? (
        <p className="mt-2 rounded-xl border border-dashed border-line px-3 py-6 text-center text-xs text-fg-subtle">
          {asked ? t("Nothing published matches “{query}”.", { query: asked }) : t("Nothing published matches.")}
        </p>
      ) : (
        <ul key={asked} className={`stagger-in mt-2 ${rows}`}>
          {shown.map((p) => {
            const has = installed.has(p.name) || done.has(p.name);
            const link = webLink(p.homepage) ?? webLink(p.npm);
            return (
              <li key={p.name} className="min-w-0 rounded-xl border border-line bg-raised/40 p-3 transition hover:border-fg/15">
                <div className="flex items-start gap-3">
                  <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-fg/5 text-fg-muted">
                    <LuPackage aria-hidden className="h-[18px] w-[18px]" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline gap-x-2">
                      <p className="truncate text-sm text-fg">{p.name}</p>
                      <span className="font-mono text-[10px] text-fg-faint">v{p.version}</span>
                    </div>
                    {p.description && <p className="mt-0.5 line-clamp-2 text-xs text-fg-subtle">{p.description}</p>}
                    <p className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[10px] text-fg-faint">
                      {p.weekly !== undefined && (
                        <span className="inline-flex items-center gap-1" title={t("{n} downloads last week", { n: formatNumber(p.weekly) })}>
                          <LuTrendingUp className="h-3 w-3" /> {t("{n}/week", { n: compactCount(p.weekly) })}
                        </span>
                      )}
                      {p.date && <span>{t("updated {when}", { when: ago(p.date) })}</span>}
                      {p.author && <span>{t("by {author}", { author: p.author })}</span>}
                      {link && (
                        <a href={link} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 hover:text-fg-muted">
                          {t("more")} <LuExternalLink className="h-2.5 w-2.5" />
                        </a>
                      )}
                    </p>
                  </div>
                  {has ? (
                    <span className="pop-in inline-flex shrink-0 items-center gap-1 rounded-lg bg-ok/10 px-2 py-1 text-[11px] text-ok">
                      <LuCheck className="h-3.5 w-3.5" /> {t("Installed")}
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => void install(p)}
                      disabled={busy !== null}
                      aria-label={t("Install {name}", { name: p.name })}
                      className="inline-flex shrink-0 items-center gap-1 rounded-lg bg-accent/12 px-2 py-1 text-[11px] text-accent ring-1 ring-inset ring-accent/25 transition hover:bg-accent/20 disabled:opacity-40"
                    >
                      {busy === p.name && step ? <LuRefreshCw className="h-3.5 w-3.5 animate-spin" /> : <LuDownload className="h-3.5 w-3.5" />}
                      {busy === p.name && step ? t("Installing…") : t("Install")}
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {found && found.length > limit && (
        <button type="button" onClick={() => setMore(!more)} className="mt-2 text-[11px] text-accent hover:underline">
          {more ? t("Fewer") : t("{n} more", { n: found.length - limit })}
        </button>
      )}
    </div>
  );
}
