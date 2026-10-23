import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { LuCheck, LuCompass, LuDownload, LuPackageCheck, LuPalette, LuPanelsTopLeft, LuPuzzle, LuRefreshCw, LuTrash2 } from "react-icons/lu";
import { api, type ExtensionInfo, type PackageKind, type ShippedExtension } from "../api";
import { displayName } from "../tool-groups";
import { packageName } from "../package-names";
import { useExtensions } from "../extensions/loader";
import { useSlot } from "../extensions/slots";
import { useCached } from "../settings-cache";
import { isEnter } from "../shortcuts";
import { tabKeys } from "../tab-keys";
import { formatDateTime, msg, t, tp } from "../i18n";
import { confirmDialog } from "./ConfirmDialog";
import { InstallProgress, installExtension, type InstallStep } from "./ExtensionInstall";
import { PackageCatalog } from "./PackageCatalog";
import { Empty, LoadFailed, Section, Switch, btnCls, gridCls, inputCls, primaryCls } from "./SettingsUi";
import { SkeletonGroup } from "./Skeleton";

/**
 * Settings → Extensions, in two views: what is installed, told apart by what
 * it brings, and what there is to install.
 */

const SOURCES = [
  { label: "npm", placeholder: "npm:@scope/package", hint: msg("Install from npm") },
  { label: "git", placeholder: "git:github.com/user/repo@v1", hint: msg("Install from a git repository") },
  { label: "url", placeholder: "https://github.com/user/repo", hint: msg("Install from a URL") },
  { label: "path", placeholder: "/absolute/path/to/package", hint: msg("Install from a folder on the server") },
];

type View = "installed" | "discover";

/** The headings of the second view, as written: a search that names one opens that view. */
const DISCOVER_SECTIONS = [msg("Comes with Pithagoras"), msg("Find packages"), msg("Install by name")];

/** What a package brings. The first two are names, and stay as they are in every language. */
const KINDS: { id: PackageKind; label: () => string; hint: string }[] = [
  { id: "pi", label: () => "pi", hint: msg("For the agent: tools, commands, skills and prompts") },
  { id: "pithagoras", label: () => "Pithagoras", hint: msg("For the portal: what it draws, or runs beside the chats") },
  { id: "themes", label: () => t("Themes"), hint: msg("Colours for the portal") },
];

const kindsOf = (pkg: { kinds?: PackageKind[] }) => pkg.kinds ?? [];

function KindIcon({ kinds, className }: { kinds: PackageKind[]; className?: string }) {
  const Icon = kinds.includes("pithagoras") ? LuPanelsTopLeft : kinds.includes("themes") && !kinds.includes("pi") ? LuPalette : LuPuzzle;
  return <Icon aria-hidden className={className} />;
}

const pillCls = "shrink-0 rounded-md bg-fg/5 px-1.5 py-0.5 text-[10px] leading-4 text-fg-subtle";

function KindPills({ kinds }: { kinds: PackageKind[] }) {
  return (
    <>
      {KINDS.filter((kind) => kinds.includes(kind.id)).map((kind) => (
        <span key={kind.id} title={t(kind.hint)} className={pillCls}>
          {kind.label()}
        </span>
      ))}
    </>
  );
}

/** A package as a card: what it is on top, and what can be done with it along the bottom. */
function Card({ kinds, name, title, version, description, off, action, children, foot }: {
  kinds: PackageKind[];
  name: string;
  title?: string;
  version?: string;
  description?: string;
  off?: boolean;
  action: ReactNode;
  children?: ReactNode;
  foot?: ReactNode;
}) {
  return (
    <li className="flex min-w-0 flex-col rounded-xl border border-line bg-raised/40 p-3 transition hover:border-fg/15">
      <div className="flex items-start gap-3">
        <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-fg/5 ${off ? "text-fg-faint" : "text-fg-muted"}`}>
          <KindIcon kinds={kinds} className="h-[18px] w-[18px]" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <p title={title ?? name} className={`truncate text-sm font-medium ${off ? "text-fg-subtle" : "text-fg"}`}>{name}</p>
            {version && <span className="shrink-0 font-mono text-[10px] text-fg-faint">v{version}</span>}
          </div>
          {description && <p className="mt-0.5 line-clamp-2 text-xs text-fg-subtle">{description}</p>}
          <div className="mt-1.5 flex flex-wrap items-center gap-1">{children}</div>
        </div>
        <div className="flex shrink-0 items-center gap-1">{action}</div>
      </div>
      {foot && <div className="mt-auto flex items-center gap-3 pt-2.5">{foot}</div>}
    </li>
  );
}


export function ExtensionsPanel({
  extensions,
  loading,
  failed,
  reveal,
  onRetry,
  onError,
  onRefresh,
  onConfigure,
}: {
  extensions: ExtensionInfo[];
  loading: boolean;
  /** Why the list could not be read, when it has not been: "Nothing installed" would be a claim. */
  failed: Error | null;
  /** A section a search went to: the view it is in is the one shown. */
  reveal?: { section: string; n: number } | null;
  onRetry: () => unknown;
  onError: (e: string) => void;
  onRefresh: () => Promise<ExtensionInfo[]>;
  onConfigure: (spec: string) => void;
}) {
  const id = useId();
  const [view, setView] = useState<View>("installed");
  // The second view asks npm: not before it is looked at, and then kept, with what was typed into it.
  const [seen, setSeen] = useState(false);
  const show = (next: View) => {
    setView(next);
    if (next === "discover") setSeen(true);
  };
  useEffect(() => {
    if (reveal) show(DISCOVER_SECTIONS.some((section) => t(section) === reveal.section) ? "discover" : "installed");
  }, [reveal?.n]);

  const [filter, setFilter] = useState<PackageKind | "all">("all");
  const [spec, setSpec] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  // Which package an install of more than one has come to.
  const [step, setStep] = useState<InstallStep | null>(null);
  // Why a package's interface is not in the page, or failed in a page (this one or another), or its server half is not
  // running, where it brings one: see extensions/loader.ts.
  const { failures, clientFailures, serverFailures, serverCrashes } = useExtensions();
  const ownPages = useSlot("settings.page");
  // The same, readable by a second Enter that comes before the draw.
  const busyRef = useRef(false);
  /** What the last switch did to the conversations that were open. */
  const [note, setNote] = useState<(() => string) | null>(null);
  // The names given in Settings → Tools. A package is one thing and should be
  // called the same thing wherever it appears; the spec underneath is what it
  // is installed and removed by, and that does not change.
  const [names, setNames] = useState<Record<string, string>>({});
  useEffect(() => {
    api
      .toolNames()
      .then((r) => setNames(r.names))
      .catch(() => setNames({}));
  }, []);
  const shipped = useCached("extensions-shipped", api.shippedExtensions, { freshMs: 30_000 });

  /** Runs `fn`, one at a time; one the person said no to (false) changes nothing. */
  const act = async (label: string, fn: () => Promise<unknown>) => {
    // Enter in the name field gets here without the disabled button's say: a second install into the same folder collides with the first.
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(label);
    setNote(null);
    try {
      if ((await fn()) === false) return;
      await onRefresh();
      setSpec("");
    } catch (e) {
      onError((e as Error).message);
      // What it did before it failed stays done (what an extension needs, installed before it): the list is read again.
      await onRefresh();
    } finally {
      busyRef.current = false;
      setBusy(null);
    }
  };

  const switchPackage = (ext: ExtensionInfo) =>
    act(ext.spec, async () => {
      const on = !ext.enabled;
      const r = await api.setExtensionEnabled(ext.spec, on);
      const name = displayName(ext.name, names);
      const parts = [() => (on ? t("{name} is on.", { name }) : t("{name} is off.", { name }))];
      if (r.reloaded) parts.push(() => tp(r.reloaded, "{n} open conversation reloaded.", "{n} open conversations reloaded."));
      if (r.waiting)
        parts.push(() =>
          tp(r.waiting, "{n} still working — it takes the change at its next step.", "{n} still working — they take the change at their next step."),
        );
      setNote(() => () => parts.map((part) => part()).join(" "));
    });

  const remove = async (ext: ExtensionInfo) => {
    // Its commands, tools and skills go from every chat, and the switch beside it is easy to miss for this one.
    const name = displayName(ext.name, names);
    if (!(await confirmDialog({ title: t("Remove {name}?", { name }), message: t("It is uninstalled: its commands, tools and skills are gone from every chat."), confirmLabel: t("Remove"), danger: true, deletes: true }))) return;
    await act(ext.spec, () => api.removePackage(ext.spec));
  };

  const installed = useMemo(() => new Set(extensions.flatMap((e) => [e.name, packageName(e.spec)])), [extensions]);
  const counts = useMemo(() => Object.fromEntries(KINDS.map((kind) => [kind.id, extensions.filter((e) => kindsOf(e).includes(kind.id)).length])), [extensions]);
  const shown = filter === "all" ? extensions : extensions.filter((e) => kindsOf(e).includes(filter));

  const tab = (which: View, label: string, Icon: typeof LuCompass, count?: number) => (
    <button
      id={`${id}-${which}-tab`}
      type="button"
      role="tab"
      aria-selected={view === which}
      aria-controls={`${id}-${which}-panel`}
      tabIndex={view === which ? 0 : -1}
      onClick={() => show(which)}
      className={`flex min-w-0 flex-1 items-center justify-center gap-2 rounded-lg px-4 py-2 text-xs font-medium transition-colors sm:min-w-[10rem] sm:flex-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent ${view === which ? "bg-accent/12 text-accent shadow-sm ring-1 ring-inset ring-accent/25" : "text-fg-muted hover:bg-fg/5 hover:text-fg"}`}
    >
      <Icon aria-hidden className="h-4 w-4 shrink-0" />
      {label}
      {count !== undefined && count > 0 && <span className="rounded-full bg-fg/10 px-1.5 text-[10px] leading-4 text-fg-muted">{count}</span>}
    </button>
  );

  const chip = (which: PackageKind | "all", label: string, count: number, hint?: string) => (
    <button
      key={which}
      type="button"
      aria-pressed={filter === which}
      title={hint}
      onClick={() => setFilter(which)}
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition ${filter === which ? "border-accent/30 bg-accent/12 text-accent" : "border-line text-fg-muted hover:bg-fg/5 hover:text-fg"}`}
    >
      {label}
      <span className={filter === which ? "text-accent/80" : "text-fg-faint"}>{count}</span>
    </button>
  );

  return (
    <div>
      <div role="tablist" aria-label={t("Extensions")} onKeyDown={tabKeys} className="mb-4 flex gap-1 rounded-xl border border-line bg-raised/40 p-1 sm:inline-flex">
        {tab("installed", t("Installed"), LuPackageCheck, extensions.length)}
        {tab("discover", t("Discover"), LuCompass)}
      </div>

      <div role="tabpanel" id={`${id}-installed-panel`} aria-labelledby={`${id}-installed-tab`} hidden={view !== "installed"} data-setting={t("Installed")}>
        {loading ? (
          <SkeletonGroup className={gridCls} label={t("Reading installed packages…")}>
            {[0, 1, 2, 3].map((i) => <div key={i} className="skeleton h-24 w-full" />)}
          </SkeletonGroup>
        ) : failed ? (
          <LoadFailed error={failed} onRetry={onRetry} />
        ) : extensions.length === 0 ? (
          <Empty>
            {t("Nothing installed yet.")}
            <p className="mt-1 text-xs text-fg-faint">{t("Installed commands show up in the chat box when you type “/”.")}</p>
            <button type="button" onClick={() => show("discover")} className={`${btnCls} mt-3`}>
              <LuCompass className="h-4 w-4" /> {t("See what there is")}
            </button>
          </Empty>
        ) : (
          <>
            <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2">
              <div role="group" aria-label={t("Show")} className="flex flex-wrap gap-1.5">
                {chip("all", t("All"), extensions.length)}
                {KINDS.map((kind) => chip(kind.id, kind.label(), counts[kind.id], t(kind.hint)))}
              </div>
              <div className="ml-auto flex items-center gap-2">
                <button disabled={busy !== null} onClick={() => act("update", () => api.updatePackages())} className={btnCls}>
                  <LuDownload className="h-4 w-4" />
                  {busy === "update" ? t("Updating…") : t("Update all")}
                </button>
                <button onClick={() => onRefresh()} className={btnCls}>
                  <LuRefreshCw className="h-4 w-4" /> {t("Refresh")}
                </button>
              </div>
            </div>

            {note && (
              <p role="status" className="mb-3 text-xs text-fg-muted">
                {note()}
              </p>
            )}

            {shown.length === 0 ? (
              <Empty>
                {filter === "themes" ? t("Nothing installed brings colours for the portal.") : filter === "pithagoras" ? t("Nothing installed draws in the portal.") : t("Nothing installed is for the agent.")}
              </Empty>
            ) : (
              <ul className={gridCls}>
                {shown.map((ext) => {
                  const name = displayName(ext.name, names);
                  const off = ext.enabled === false;
                  const configurable = ext.settings.length > 0 || ownPages.some((page) => page.extension === ext.name);
                  return (
                    <Card
                      key={ext.spec}
                      kinds={kindsOf(ext)}
                      name={name}
                      title={ext.name}
                      version={ext.version}
                      description={ext.description}
                      off={off}
                      action={
                        ext.enabled !== undefined && (
                          <Switch
                            on={ext.enabled}
                            onChange={() => switchPackage(ext)}
                            label={ext.enabled ? t("Switch off {name}", { name }) : t("Switch on {name}", { name })}
                            title={ext.enabled ? t("On — click to switch it off without uninstalling it") : t("Off — its commands, skills and tools are not loaded. Click to switch it on")}
                            disabled={busy !== null}
                          />
                        )
                      }
                      foot={
                        <>
                          <span title={ext.spec} className="min-w-0 truncate font-mono text-[10px] text-fg-faint">{ext.spec}</span>
                          <span className="ml-auto flex shrink-0 items-center gap-1">
                            {configurable && (
                              <button onClick={() => onConfigure(ext.spec)} className="rounded-lg px-2 py-1 text-[11px] text-accent transition hover:bg-accent/10">
                                {ext.settings.length > 0 ? t("Configure ({n})", { n: ext.settings.length }) : t("Configure")} ›
                              </button>
                            )}
                            <button
                              disabled={busy !== null}
                              onClick={() => void remove(ext)}
                              title={t("Remove")}
                              aria-label={t("Remove {name}", { name })}
                              className="rounded-lg p-1.5 text-fg-subtle transition hover:bg-danger/10 hover:text-danger disabled:opacity-40"
                            >
                              {busy === ext.spec ? <LuRefreshCw className="h-3.5 w-3.5 animate-spin" /> : <LuTrash2 className="h-3.5 w-3.5" />}
                            </button>
                          </span>
                        </>
                      }
                    >
                      <KindPills kinds={kindsOf(ext)} />
                      {off && <span className="shrink-0 rounded-md bg-warn/10 px-1.5 py-0.5 text-[10px] leading-4 text-warn">{t("off")}</span>}
                      {ext.filtered && (
                        <span title={t("Some of what it brings is switched off in settings.json. Switching it off and on again keeps that.")} className={pillCls}>
                          {t("filtered")}
                        </span>
                      )}
                      {/* Said where it is not the usual one: a package a project brings has no switch here, and this is why. */}
                      {ext.scope && !/^user/i.test(ext.scope) && <span className={pillCls}>{ext.scope}</span>}
                      {/* The extension whose own folder it is in; when, where that extension installed it itself. */}
                      {ext.installedFrom && (
                        <span className={pillCls} title={ext.installedFrom.at ? formatDateTime(ext.installedFrom.at) : undefined}>
                          {t("From {name}", { name: displayName(ext.installedFrom.extension, names) })}
                        </span>
                      )}
                      {/* The extension's own words, shown as they are. */}
                      {ext.installedFrom?.note && <p className="basis-full break-words text-xs text-fg-subtle">{ext.installedFrom.note}</p>}
                      {failures[ext.name] ? (
                        <p role="alert" className="basis-full break-words text-xs text-warn">
                          {t("Its interface could not be loaded: {reason}", { reason: failures[ext.name] })}
                        </p>
                      ) : (
                        clientFailures[ext.name] && (
                          <p role="alert" className="basis-full break-words text-xs text-warn">
                            {t("Its interface failed in a page: {reason}", { reason: clientFailures[ext.name] })}
                          </p>
                        )
                      )}
                      {serverCrashes[ext.name] ? (
                        <div role="alert" className="basis-full text-xs text-warn">
                          <p className="break-words">
                            {t("Its server half crashed at {time}, and is off until another version of it is installed, or it is switched off and on: {error}", {
                              time: formatDateTime(serverCrashes[ext.name].at),
                              error: serverCrashes[ext.name].error,
                            })}
                          </p>
                          {serverCrashes[ext.name].lines.length > 0 && (
                            <details className="mt-1">
                              <summary className="cursor-pointer text-fg-subtle">{t("What it said last")}</summary>
                              <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md bg-fg/5 p-2 font-mono text-[10px] leading-4 text-fg-muted">
                                {serverCrashes[ext.name].lines.join("\n")}
                              </pre>
                            </details>
                          )}
                        </div>
                      ) : (
                        serverFailures[ext.name] && (
                          <p role="alert" className="basis-full break-words text-xs text-warn">
                            {t("Its server half could not be started: {reason}", { reason: serverFailures[ext.name] })}
                          </p>
                        )
                      )}
                    </Card>
                  );
                })}
              </ul>
            )}
          </>
        )}
      </div>

      <div role="tabpanel" id={`${id}-discover-panel`} aria-labelledby={`${id}-discover-tab`} hidden={view !== "discover"}>
        {seen && (
          <>
            {(shipped.failed || (shipped.value?.extensions.length ?? 0) > 0) && (
              <Section title={t("Comes with Pithagoras")} hint={t("Shipped with this portal, and installed from its own folder.")}>
                {shipped.value ? (
                  <>
                    <ul className={gridCls}>
                      {shipped.value.extensions.map((ext: ShippedExtension) => (
                        <Card
                          key={ext.name}
                          kinds={ext.kinds}
                          name={ext.name}
                          version={ext.version}
                          description={ext.description}
                          action={
                            installed.has(ext.name) ? (
                              <span className="pop-in inline-flex shrink-0 items-center gap-1 rounded-lg bg-ok/10 px-2 py-1 text-[11px] text-ok">
                                <LuCheck className="h-3.5 w-3.5" /> {t("Installed")}
                              </span>
                            ) : (
                              <button
                                type="button"
                                onClick={() => act(ext.spec, () => installExtension(ext.spec, { progress: setStep }))}
                                disabled={busy !== null}
                                aria-label={t("Install {name}", { name: ext.name })}
                                className="inline-flex shrink-0 items-center gap-1 rounded-lg bg-accent/12 px-2 py-1 text-[11px] text-accent ring-1 ring-inset ring-accent/25 transition hover:bg-accent/20 disabled:opacity-40"
                              >
                                {busy === ext.spec ? <LuRefreshCw className="h-3.5 w-3.5 animate-spin" /> : <LuDownload className="h-3.5 w-3.5" />}
                                {busy === ext.spec ? t("Installing…") : t("Install")}
                              </button>
                            )
                          }
                        >
                          <KindPills kinds={ext.kinds} />
                          {ext.requires && (
                            <span title={t("It does not run without these: installing it installs them too, where they are not there")} className={pillCls}>
                              {t("Needs {names}", { names: Object.keys(ext.requires).join(", ") })}
                            </span>
                          )}
                        </Card>
                      ))}
                    </ul>
                    {shipped.value.extensions.some((ext) => ext.spec === busy) && <InstallProgress step={step} />}
                  </>
                ) : (
                  <LoadFailed error={shipped.failed!} onRetry={shipped.reload} />
                )}
              </Section>
            )}

            <Section title={t("Find packages")} hint={t("Published for pi on npm: tools, skills, providers and themes. The most used first.")}>
              <PackageCatalog installed={installed} onInstalled={() => void onRefresh()} onError={onError} limit={12} wide />
            </Section>

            <Section title={t("Install by name")} hint={t("From npm, git, a URL or a folder on the server. They persist across restarts.")}>
              <div className="flex max-w-3xl gap-2">
                <input
                  value={spec}
                  onChange={(e) => setSpec(e.target.value)}
                  onKeyDown={(e) => isEnter(e) && spec.trim() && act("install", () => installExtension(spec.trim(), { progress: setStep }))}
                  placeholder="npm:@scope/package"
                  aria-label={t("Install by name")}
                  className={`${inputCls} font-mono text-xs`}
                />
                <button disabled={!spec.trim() || busy !== null} onClick={() => act("install", () => installExtension(spec.trim(), { progress: setStep }))} className={primaryCls}>
                  <LuDownload className="h-4 w-4" />
                  {busy === "install" ? t("Installing…") : t("Install")}
                </button>
              </div>
              {busy === "install" && <InstallProgress step={step} />}
              <div className="mt-2 flex flex-wrap gap-1">
                {SOURCES.map((s) => (
                  <button
                    key={s.label}
                    onClick={() => setSpec(s.placeholder)}
                    title={t(s.hint)}
                    className="rounded-lg bg-fg/5 px-2 py-0.5 font-mono text-[11px] text-fg-muted transition hover:bg-fg/10 hover:text-fg"
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            </Section>
          </>
        )}
      </div>
    </div>
  );
}
