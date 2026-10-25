import { memo, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { Select } from "./Select";
import {
  LuBlocks,
  LuBrain,
  LuCheck,
  LuChevronRight,
  LuScrollText,
  LuExternalLink,
  LuEye,
  LuFileJson,
  LuFolder,
  LuHammer,
  LuShield,
  LuShieldCheck,
  LuInfo,
  LuKeyRound,
  LuKeyboard,
  LuLayers,
  LuMonitor,
  LuMoon,
  LuPlug,
  LuPuzzle,
  LuRadio,
  LuWrench,
  LuRefreshCw,
  LuSearch,
  LuServer,
  LuSlidersHorizontal,
  LuSun,
  LuTriangleAlert,
  LuUsers,
} from "react-icons/lu";
import { api, EXTENSIONS_CHANGED, SIGNED_OUT, type ExtensionInfo, type GlobalSettings, type ReportTarget, type ReportTo } from "../api";
import { ChannelsPanel } from "./ChannelsPanel";
import { SkillsPanel } from "./SkillsPanel";
import { McpPanel } from "./McpPanel";
import { LogsPanel } from "./LogsPanel";
import { PasswordPanel } from "./PasswordPanel";
import { SsoPanel } from "./SsoPanel";
import { parseWindow } from "../context-window";
import { KeepRecent, useKeepRecentSave } from "./KeepRecent";
import { formatTokens } from "../transcript";
import { useAsksBeforeDeleting } from "../confirm-prefs";
import { useAnimations } from "../motion";
import { useNotifyState } from "../notify";
import { setCommandTrigger, typedCharacter, useCommandTrigger, validTrigger } from "../command-trigger";
import { DEFAULT_TRIGGER } from "../slash-palette";
import { PeoplePanel } from "./PeoplePanel";
import { VoiceModeSettings } from "./VoiceModeSettings";
import { RestartSection } from "./RestartSection";
import { UpdateSection } from "./UpdateSection";
import { Modal, useUnsavedDraft } from "./Modal";
import { ToolDefaults } from "./ToolDefaults";
import { SandboxSettings } from "./SandboxSettings";
import { GuardSettings } from "./GuardSettings";
import { isEnter } from "../shortcuts";
import { KeyboardShortcuts } from "./KeyboardShortcuts";
import { ProvidersPanel } from "./ProvidersPanel";
import { ModelChoice } from "./ModelChoice";
import { ModesPanel } from "./ModesPanel";
import { EffortPicker, Empty, ErrorBanner, Field, LoadFailed, Section, Switch, SwitchRow, btnCls, inputCls, primaryCls } from "./SettingsUi";
import { ExtensionsPanel } from "./ExtensionsPanel";
import { webLink } from "../package-names";
import { prefetchSettings, refreshFailed, useCached } from "../settings-cache";
import type { Tab } from "../settings-tabs";
import { serialSaver } from "../serial-saver";
import { local } from "../safe-storage";
import { SETTINGS_INDEX, searchSettings, type SettingEntry } from "../settings-search";
import { usePalette, useTheme, type Theme } from "../theme";
import { choose as chooseTheme, useThemes } from "../extensions/themes";
import { humanKey, typed } from "../setting-values";
import { effortLabel } from "../effort";
import { languageChoice, languages, msg, setLanguage, t, tp, tx, useLanguage, type LanguageChoice } from "../i18n";
import { ErrorBoundary, PartFailed } from "./ErrorBoundary";
import { useSlot, type Registered } from "../extensions/slots";
import { failedIn } from "../extensions/loader";
import { translate } from "../extensions/strings";
import { SkeletonGroup } from "./Skeleton";
import { useFlash } from "../use-flash";

/**
 * The pages that lay out the width of the dialog themselves: a grid of
 * packages, lines of a log, a file to edit. Every other page takes the width
 * too, and where the dialog is very wide its sections stand two abreast
 * (`settings-flow`, in shell.css): a field across all of a wide screen is
 * harder to read than two columns of them.
 */
const OWN_LAYOUT = new Set<Tab>(["extensions", "logs", "advanced"]);

/**
 * Either a fixed tab or one extension's own configuration page: by its package's spec, which tells two installs of
 * one package apart, or by its name, as its address names it (/settings/x/<name>).
 */
type Nav = { kind: "tab"; id: Tab } | { kind: "ext"; spec: string } | { kind: "ext"; name: string };

type TabDef = { id: Tab; label: string; icon: ReactNode; hint: string };

/**
 * The rail, in the order a person setting the portal up needs it: where the
 * models come from and how they are used, then what the agent can do, who it
 * talks to, and last the portal itself.
 */
const GROUPS: { label: string; tabs: TabDef[] }[] = [
  {
    label: msg("Models"),
    tabs: [
      { id: "models", label: msg("Providers"), icon: <LuServer />, hint: msg("Where the models come from") },
      { id: "general", label: msg("Defaults"), icon: <LuSlidersHorizontal />, hint: msg("Model, effort and context for new chats") },
    ],
  },
  {
    label: msg("Agent"),
    tabs: [
      { id: "tools", label: msg("Tools"), icon: <LuHammer />, hint: msg("What the agent may reach for, by default") },
      { id: "modes", label: msg("Modes"), icon: <LuLayers />, hint: msg("Your own ways a chat can work, chosen above the message box") },
      { id: "sandbox", label: msg("Sandbox"), icon: <LuShieldCheck />, hint: msg("What the agent may read, change and run") },
      { id: "guard", label: msg("Guard"), icon: <LuShield />, hint: msg("What the agent is held to after it reads something untrusted") },
      { id: "skills", label: msg("Skills"), icon: <LuWrench />, hint: msg("Procedures the agent can reach for") },
      { id: "mcp", label: msg("MCP"), icon: <LuPlug />, hint: msg("Servers the agent can pull tools from") },
      { id: "extensions", label: msg("Extensions"), icon: <LuBlocks />, hint: msg("Install and manage packages") },
    ],
  },
  {
    label: msg("Reach"),
    tabs: [
      { id: "channels", label: msg("Channels"), icon: <LuRadio />, hint: msg("Two-way links into the agent") },
      { id: "people", label: msg("People"), icon: <LuUsers />, hint: msg("Who the agent will talk to") },
    ],
  },
  {
    label: msg("Portal"),
    tabs: [
      { id: "browser", label: msg("This browser"), icon: <LuMonitor />, hint: msg("Theme, notifications, confirmations") },
      { id: "authentication", label: msg("Authentication"), icon: <LuKeyRound />, hint: msg("The password, and signing in through a provider") },
      { id: "shortcuts", label: msg("Shortcuts"), icon: <LuKeyboard />, hint: msg("Keyboard shortcuts, and changing them") },
      { id: "logs", label: msg("Logs"), icon: <LuScrollText />, hint: msg("What the server prints, and a file to take away") },
      { id: "about", label: msg("About"), icon: <LuInfo />, hint: msg("Where this portal keeps things") },
      { id: "advanced", label: msg("Advanced"), icon: <LuFileJson />, hint: msg("pi's raw settings file") },
    ],
  },
];
const TABS = GROUPS.flatMap((g) => g.tabs);

/** The rail's extension pages as last seen, so a reload does not start without them. */
const RAIL_KEY = "pithagoras.settings.extension-rail";
function railSnapshot(): { spec: string; name: string }[] {
  try {
    const list = JSON.parse(local.get(RAIL_KEY) ?? "[]");
    return Array.isArray(list) ? list.filter((e) => e && typeof e.spec === "string" && typeof e.name === "string") : [];
  } catch {
    return [];
  }
}

/**
 * The rail's groups folded by hand in this browser, by their names in English. None is folded until somebody folds
 * it: a rail nobody has touched is the one it always was.
 */
const FOLDED_KEY = "pithagoras.settings.rail-closed";
function foldedGroups(): string[] {
  try {
    const list = JSON.parse(local.get(FOLDED_KEY) ?? "[]");
    return Array.isArray(list) ? list.filter((name) => typeof name === "string") : [];
  } catch {
    return [];
  }
}

/**
 * An extension's page as Settings' rail lists it: the title and the icon its own page gives (`settings.page`), in
 * place of its package's name and the mark every extension has.
 */
function railEntry(name: string, pages: readonly Registered<"settings.page">[]): { label: string; icon: ReactNode } {
  const page = pages.find((p) => p.extension === name);
  return {
    label: page?.title ? translate(name, page.title) : name,
    // An extension's icon is a bare <svg>, sized as the portal's own icons size themselves: by the text beside them.
    icon: page?.icon ? <span className="contents [&>svg]:h-[1em] [&>svg]:w-[1em]"><page.icon /></span> : <LuPuzzle />,
  };
}

export const ConfigModal = memo(function ConfigModal({
  onClose,
  initialTab = "general",
  extension,
  onSetup,
}: {
  onClose: () => void;
  initialTab?: Tab;
  /** An extension's page to open on in place of a tab, by its package's name. */
  extension?: string;
  /** Opens the setup assistant in its place. */
  onSetup?: () => void;
}) {
  const [nav, setNav] = useState<Nav>(extension ? { kind: "ext", name: extension } : { kind: "tab", id: TABS.some((t) => t.id === initialTab) ? initialTab : "general" });
  const [error, setError] = useState<string | null>(null);
  const banner = useRef<HTMLDivElement>(null);
  /** A section a search went to, to scroll to once its page has drawn it. */
  const [target, setTarget] = useState<{ section: string; n: number } | null>(null);
  const page = useRef<HTMLDivElement>(null);

  // Loaded here rather than inside the Extensions tab: the rail lists every
  // extension that exposes settings, so it needs them before anything is shown.
  const exts = useCached("extensions", api.extensions, { onError: refreshFailed("extensions", setError) });
  const extensions = exts.value?.extensions ?? [];
  const settingsPath = exts.value?.settingsPath ?? "";
  const loadingExts = !exts.value && !exts.failed;
  const loadExtensions = async () => (await exts.reload())?.extensions ?? [];
  // What is installed changed, here or elsewhere (another tab, the API, an agent): the list follows without being opened again.
  useEffect(() => {
    const again = () => void exts.reload();
    window.addEventListener(EXTENSIONS_CHANGED, again);
    return () => window.removeEventListener(EXTENSIONS_CHANGED, again);
  }, [exts.reload]);

  useEffect(() => prefetchSettings(), []);
  // What changed in voice mode's settings here, its source chosen on an extension's page among it, reaches the voice controls open as Settings closes.
  useEffect(() => () => void window.dispatchEvent(new Event("voice-config-changed")), []);

  // A refused save is said at the top of the pane, which a long form has scrolled away from: it is brought into
  // view when it comes, and it is not the next section's.
  useEffect(() => {
    if (error) banner.current?.scrollIntoView({ block: "nearest" });
  }, [error]);

  // A package has a page here when the portal found settings it reads, or when it brought a page of its own.
  const settingsPages = useSlot("settings.page");
  const hasPage = (e: ExtensionInfo) => e.settings.length > 0 || settingsPages.some((page) => page.extension === e.name);
  const configurable = exts.value ? extensions.filter(hasPage) : railSnapshot().map((e) => ({ ...e, settings: [] as ExtensionInfo["settings"], placeholder: true }));
  useEffect(() => {
    if (!exts.value) return;
    // Only a head start for next time.
    local.set(RAIL_KEY, JSON.stringify(configurable.map((e) => ({ spec: e.spec, name: e.name }))));
  }, [exts.value]);
  // Opened at its address, the page is that of the first package of the name.
  const activeExt =
    nav.kind === "ext" ? extensions.find((e) => ("spec" in nav ? e.spec === nav.spec : e.name === nav.name)) : undefined;
  // Its entry in the rail: while the list is still asked for, one of the entries drawn from last time's, by the name.
  const railSpec = nav.kind !== "ext" ? undefined : "spec" in nav ? nav.spec : (activeExt ?? configurable.find((e) => e.name === nav.name))?.spec;
  // By the spec once it is known: a page opened at its address and then chosen in the rail is not drawn anew.
  const section = nav.kind === "tab" ? nav.id : activeExt?.spec ?? ("spec" in nav ? nav.spec : nav.name);
  useEffect(() => setError(null), [section]);
  // The extension pages rise in when they arrive late; drawn from what was
  // kept, they are simply there. Once in, a refresh does not replay it.
  // Not over names already drawn from the snapshot: they would rise a second time.
  const railShown = useRef(!!exts.value || railSnapshot().length > 0);
  useEffect(() => {
    if (!exts.value) return;
    const t = setTimeout(() => (railShown.current = true), 600);
    return () => clearTimeout(t);
  }, [exts.value]);

  // Every setting there is, the extensions' own among them, to search — by
  // what it is called here and, in another language, by its English name too.
  const lang = useLanguage();
  const index = useMemo(() => {
    const label = (id: string) => {
      const tab = TABS.find((x) => x.id === id);
      return tab ? t(tab.label) : id;
    };
    const fixed = SETTINGS_INDEX.map((e) => ({
      ...e,
      title: t(e.title),
      section: e.section && t(e.section),
      words: `${e.words ?? ""} ${e.title} ${e.section ?? ""}`,
      where: label(e.tab),
    }));
    const own = extensions.flatMap((x) => {
      const { label } = railEntry(x.name, settingsPages);
      return [
        { tab: "extensions", ext: x.spec, title: label, words: `${x.name} ${x.description ?? ""} extension settings`, where: t("Extension settings") },
        ...x.settings.map((st) => ({ tab: "extensions", ext: x.spec, section: t("Settings"), title: humanKey(st.key), words: `${st.key} ${x.name}`, where: label })),
        // What the extension's own page says is on it, in the words the page shows, and in English too.
        ...settingsPages.filter((page) => page.extension === x.name).flatMap((page) =>
          (page.search ?? []).map((found) => ({
            tab: "extensions",
            ext: x.spec,
            title: translate(x.name, found.title),
            ...(found.section ? { section: translate(x.name, found.section) } : {}),
            words: `${found.words ?? ""} ${found.title} ${found.section ?? ""}`,
            where: label,
          })),
        ),
      ];
    });
    return [...fixed, ...own];
  }, [extensions, settingsPages, lang]);

  const go = (entry: SettingEntry) => {
    setNav(entry.ext ? { kind: "ext", spec: entry.ext } : { kind: "tab", id: entry.tab as Tab });
    if (entry.section) setTarget({ section: entry.section, n: Date.now() });
  };

  // Its page may still be fetching: look for the heading until it is there, for a few seconds.
  useEffect(() => {
    if (!target) return;
    let frame = 0;
    const until = performance.now() + 4000;
    const seek = () => {
      const el = findSection(page.current, target.section);
      if (el) {
        // A section that is closed opens for it, and so does the one a group in it is in (see CollapsibleSection).
        el.dispatchEvent(new Event("settings-reveal", { bubbles: true }));
        el.scrollIntoView({ block: "start", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
        el.classList.remove("setting-flash");
        void el.offsetWidth;
        el.classList.add("setting-flash");
        setTimeout(() => el.classList.remove("setting-flash"), 1700);
        return;
      }
      if (performance.now() < until) frame = requestAnimationFrame(seek);
    };
    frame = requestAnimationFrame(seek);
    return () => cancelAnimationFrame(frame);
  }, [target]);

  return (
    <Modal
      wide
      title={t("Settings")}
      subtitle={t("Applies to the whole portal")}
      onClose={onClose}
      startInRail={!extension && initialTab === "general"}
      section={nav.kind === "tab" ? t(TABS.find((x) => x.id === nav.id)?.label ?? "") : activeExt && railEntry(activeExt.name, settingsPages).label}
      rail={
        <SettingsSearch index={index} onPick={go}>
        <div className="space-y-4">
          {GROUPS.map((g) => (
            <RailGroup key={g.label} name={g.label} label={t(g.label)} held={nav.kind === "tab" && g.tabs.some((tab) => tab.id === nav.id)}>
              {g.tabs.map((tab) => (
                <RailItem
                  key={tab.id}
                  icon={tab.icon}
                  label={t(tab.label)}
                  hint={t(tab.hint)}
                  active={nav.kind === "tab" && nav.id === tab.id}
                  onClick={() => setNav({ kind: "tab", id: tab.id })}
                />
              ))}
            </RailGroup>
          ))}

          {/* Only appears for extensions that actually read settings. */}
          {configurable.length > 0 && (
            <RailGroup
              name="Extension settings"
              label={t("Extension settings")}
              held={configurable.some((e) => e.spec === railSpec)}
              className={exts.value && !railShown.current ? "stagger-in" : ""}
            >
              {configurable.map((e) => (
                <RailItem
                  key={e.spec}
                  {...railEntry(e.name, settingsPages)}
                  active={railSpec === e.spec}
                  onClick={() => setNav({ kind: "ext", spec: e.spec })}
                />
              ))}
            </RailGroup>
          )}
        </div>
        </SettingsSearch>
      }
    >
      {error && <ErrorBanner ref={banner} className="mb-4" onClose={() => setError(null)}>{error}</ErrorBanner>}

      <div key={section} ref={page} className={`settings-page${nav.kind === "tab" && OWN_LAYOUT.has(nav.id) ? "" : " settings-flow"}`}>
      {nav.kind === "tab" && nav.id === "models" && <ProvidersPanel onError={setError} onSetup={onSetup} />}
      {nav.kind === "tab" && nav.id === "general" && <GeneralPanel onError={setError} onProviders={() => setNav({ kind: "tab", id: "models" })} onExtensions={() => setNav({ kind: "tab", id: "extensions" })} onSource={(name) => setNav({ kind: "ext", name })} />}
      {nav.kind === "tab" && nav.id === "browser" && <BrowserPanel onError={setError} />}
      {nav.kind === "tab" && nav.id === "authentication" && <><PasswordPanel /><SsoPanel /></>}
      {nav.kind === "tab" && nav.id === "logs" && <LogsPanel onError={setError} />}
      {nav.kind === "tab" && nav.id === "about" && <AboutPanel onError={setError} />}
      {nav.kind === "tab" && nav.id === "channels" && <ChannelsPanel onError={setError} />}
      {nav.kind === "tab" && nav.id === "people" && <PeoplePanel onError={setError} />}
      {nav.kind === "tab" && nav.id === "tools" && <ToolDefaults onError={setError} />}
      {nav.kind === "tab" && nav.id === "modes" && <ModesPanel onError={setError} />}
      {nav.kind === "tab" && nav.id === "sandbox" && <SandboxSettings onError={setError} />}
      {nav.kind === "tab" && nav.id === "guard" && <GuardSettings onError={setError} onOpen={(id) => setNav({ kind: "tab", id })} />}
      {nav.kind === "tab" && nav.id === "skills" && <SkillsPanel onError={setError} />}
      {nav.kind === "tab" && nav.id === "mcp" && <McpPanel onError={setError} />}
      {nav.kind === "tab" && nav.id === "extensions" && (
        <ExtensionsPanel
          extensions={extensions}
          loading={loadingExts}
          failed={exts.value ? null : exts.failed}
          reveal={target}
          onRetry={exts.reload}
          onError={setError}
          onRefresh={loadExtensions}
          onConfigure={(spec) => setNav({ kind: "ext", spec })}
        />
      )}
      {nav.kind === "tab" && nav.id === "shortcuts" && <KeyboardShortcuts />}
      {nav.kind === "tab" && nav.id === "advanced" && (
        <AdvancedPanel settingsPath={settingsPath} onError={setError} />
      )}
      {nav.kind === "ext" &&
        (activeExt ? (
          <ExtensionPanel ext={activeExt} onError={setError} onSaved={loadExtensions} />
        ) : loadingExts ? (
          <SkeletonGroup className="space-y-2" label={t("Loading…")}><div className="skeleton h-9 w-1/2" /><div className="skeleton h-16 w-full" /><div className="skeleton h-16 w-full" /></SkeletonGroup>
        ) : exts.failed ? (
          <LoadFailed error={exts.failed} onRetry={exts.reload} />
        ) : (
          <Empty>{t("That extension is no longer installed.")}</Empty>
        ))}
      </div>
    </Modal>
  );
});

// --- rail ---

/**
 * One of the rail's groups, under a heading that folds it like a folder. Open or shut as it was left in this
 * browser; held open while one of its pages is showing, so that the page marked as the current one is in view, and a
 * search that goes to a page in a folded group finds the group open. The search's own list stands in for the rail
 * while something is typed, so what it finds is listed whatever is folded.
 */
function RailGroup({
  name,
  label,
  held,
  children,
  className = "",
}: {
  /** What it is kept as: the same in every language. */
  name: string;
  label: string;
  /** One of its pages is showing. */
  held: boolean;
  children: ReactNode;
  className?: string;
}) {
  const [shut, setShut] = useState(() => foldedGroups().includes(name));
  const open = !shut || held;
  const body = useId();
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={body}
        aria-disabled={held || undefined}
        title={held ? t("Open while one of its pages is showing") : undefined}
        onClick={() => {
          // A click that shut nothing, with its page in view, would still be remembered as shut.
          if (held) return;
          // Read again rather than kept from the first draw: the other groups write to the same list.
          const others = foldedGroups().filter((n) => n !== name);
          local.set(FOLDED_KEY, JSON.stringify(shut ? others : [...others, name]));
          setShut(!shut);
        }}
        // Held open, it does nothing when pressed, and does not look as if it did.
        className={`flex w-full items-center gap-1 rounded px-2 pb-1 text-left text-[10px] font-semibold uppercase tracking-wider text-fg-faint transition ${
          held ? "cursor-default" : "hover:text-fg-subtle"
        }`}
      >
        {/* A name wider than the rail goes on to a second line rather than being cut off, as the German for "Extension settings" does. */}
        <span>{label}</span>
        <LuChevronRight aria-hidden className={`ml-auto h-3 w-3 shrink-0 transition-transform motion-reduce:transition-none ${open ? "rotate-90" : ""} ${held ? "opacity-40" : ""}`} />
      </button>
      <div id={body} role="group" aria-label={label} hidden={!open} className={`space-y-0.5 ${className}`}>
        {children}
      </div>
    </div>
  );
}

/** The heading a search names: a Section says its title; other pages have only their headings. */
function findSection(root: HTMLElement | null, name: string): HTMLElement | null {
  if (!root) return null;
  const tagged = [...root.querySelectorAll<HTMLElement>("[data-setting]")].find((el) => el.dataset.setting === name);
  if (tagged) return tagged;
  const want = name.trim().toLowerCase();
  const heading = [...root.querySelectorAll<HTMLElement>("h3")].find((h) => (h.textContent ?? "").trim().toLowerCase().startsWith(want));
  return heading ? (heading.closest("section") as HTMLElement | null) ?? heading : null;
}

/**
 * A search above the rail. While something is typed the rail shows what
 * matches instead of its pages; arrows move through them, Enter goes to one,
 * and Escape clears the search before it closes anything. "/" anywhere in
 * Settings that is not a field comes here.
 */
function SettingsSearch({ index, onPick, children }: { index: (SettingEntry & { where?: string })[]; onPick: (e: SettingEntry) => void; children: ReactNode }) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const field = useRef<HTMLInputElement>(null);
  const hits = useMemo(() => searchSettings(query, index), [query, index]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey) return;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      e.preventDefault();
      field.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const pick = (e: SettingEntry) => {
    onPick(e);
    field.current?.blur();
  };

  return (
    <div>
      <div className="relative mb-3">
        <LuSearch className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-fg-faint" />
        <input
          ref={field}
          value={query}
          onChange={(e) => { setQuery(e.target.value); setActive(0); }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") { e.preventDefault(); setActive((i) => Math.min(i + 1, hits.length - 1)); }
            else if (e.key === "ArrowUp") { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)); }
            else if (e.key === "Enter" && hits[active]) { e.preventDefault(); pick(hits[active]); }
            else if (e.key === "Escape" && query) { e.preventDefault(); e.stopPropagation(); setQuery(""); }
          }}
          placeholder={t("Search settings")}
          aria-label={t("Search settings")}
          role="combobox"
          aria-expanded={!!query}
          aria-controls="settings-search-results"
          aria-activedescendant={query && hits[active] ? `settings-hit-${active}` : undefined}
          className="w-full rounded-lg border border-line bg-surface/70 py-1.5 pl-8 pr-7 text-sm outline-none transition placeholder:text-fg-faint focus:border-accent/60"
        />
        {!query && <kbd className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 rounded border border-line px-1 font-mono text-[10px] text-fg-faint">/</kbd>}
      </div>
      {query ? (
        <div id="settings-search-results" role="listbox" aria-label={t("Settings found")} className="float-in space-y-0.5">
          {hits.length === 0 ? (
            <p className="px-2 py-3 text-xs text-fg-faint">{t("Nothing called that. Try another word.")}</p>
          ) : (
            hits.map((h, i) => (
              <button
                key={`${h.ext ?? h.tab}:${h.title}`}
                id={`settings-hit-${i}`}
                role="option"
                aria-selected={i === active}
                onMouseEnter={() => setActive(i)}
                onClick={() => pick(h)}
                className={`block w-full rounded-lg px-2.5 py-1.5 text-left transition ${i === active ? "bg-accent/10 text-accent" : "text-fg-muted hover:bg-fg/5"}`}
              >
                <span className="block truncate text-sm">{h.title}</span>
                <span className="block truncate text-[10px] text-fg-faint">
                  {h.where}{h.section && h.section !== h.title && h.section !== h.where ? ` › ${h.section}` : ""}
                </span>
              </button>
            ))
          )}
        </div>
      ) : (
        children
      )}
    </div>
  );
}

function RailItem({
  icon,
  label,
  hint,
  active,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  hint?: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      title={hint}
      aria-current={active ? "page" : undefined}
      className={`rail-item flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition ${
        active
          ? "bg-accent/10 text-accent ring-1 ring-inset ring-accent/20"
          : "text-fg-muted hover:bg-fg/5 hover:text-fg"
      }`}
    >
      <span className={`shrink-0 ${active ? "text-accent" : "text-fg-subtle"}`}>{icon}</span>
      <span className="truncate">{label}</span>
    </button>
  );
}

// --- general ---

/**
 * Where a routine reports when it does not name a destination itself.
 *
 * Lives here rather than on the Routines page because it is a portal-wide
 * default: a routine created by the agent from a chat gets it without anyone
 * opening a form.
 */
function ReportDefault({ onError }: { onError: (e: string) => void }) {
  const { value: kept, failed, reload: load } = useCached("report-targets", api.reportTargets, { onError: refreshFailed("report-targets", onError) });
  if (!kept) {
    // Said as it is: the setting is not missing, it was not read.
    return failed ? (
      <Section title={t("Routine reports")}>
        <LoadFailed error={failed} onRetry={load} />
      </Section>
    ) : null;
  }
  const targets: ReportTarget[] = kept.targets;
  const current: ReportTo | null = kept.default;

  const value = current ? `${current.channel}\u0000${current.target}` : "";

  return (
    <Section
      title={t("Routine reports")}
      hint={t("Where a scheduled run reaches you when it has something worth saying. The agent decides whether a run is worth reporting; a routine can point somewhere else of its own.")}
    >
      <Select
        className="w-full"
        value={value}
        options={[
          { value: "", label: t("Nowhere — routines stay silent") },
          ...targets.map((t) => ({ value: `${t.channel}\u0000${t.target}`, label: `${t.channel} — ${t.label}` })),
        ]}
        onChange={async (next) => {
          const [channel, target] = next.split("\u0000");
          try {
            await api.setReportDefault(channel && target ? { channel, target } : null);
            await load();
          } catch (err) {
            onError((err as Error).message);
          }
        }}
      />
      {targets.length === 0 && (
        <p className="mt-1.5 text-xs text-fg-faint">
          {t("Nothing to pick yet. A destination is a conversation that already exists on a channel that can speak first — message your bot once and it appears here. A webhook never will: it can only answer.")}
        </p>
      )}
    </Section>
  );
}

/** The one question the portal asks before it deletes, and whether it asks it. */
function Confirmations() {
  const [ask, setAsk] = useAsksBeforeDeleting();
  return (
    <SwitchRow
      title={t("Ask before deleting")}
      detail={t("Chats, messages, files, skills, routines, projects, voices, channels, providers, MCP servers and extensions. Unsaved changes are still asked about: there is no other copy of them.")}
      on={ask}
      onChange={setAsk}
    />
  );
}

/** The flourishes on top of the portal's own motion: one switch, kept in this browser. */
function Animations() {
  const { chosen, reduced, set } = useAnimations();
  return (
    <SwitchRow
      title={t("Fancy animations")}
      detail={t("The portal opens through two doors, chats swing in, deleted rows break apart and panels dock with a bounce. Short ones, and none of them waits for you or gets in your way. Off, the portal is as quiet as it was before.")}
      on={chosen}
      onChange={set}
      note={reduced ? t("Your system asks for reduced motion, so none of them play, whatever this says.") : undefined}
    />
  );
}

/**
 * What a command starts with in the message box: "/" until another is picked.
 *
 * Kept as soon as it is typed, over the old one. A character that cannot be
 * one is said so and not kept, and the field shows the one in use again once
 * it is left.
 */
function CommandCharacter() {
  const trigger = useCommandTrigger();
  const [text, setText] = useState(trigger);
  const [refused, setRefused] = useState(false);
  // A change made elsewhere — Reset, another tab — is what the field shows.
  useEffect(() => {
    setText(trigger);
    setRefused(false);
  }, [trigger]);
  return (
    <div className="rounded-xl border border-line bg-raised/40 p-3">
      <div className="flex items-center gap-3">
        <div className="w-16">
          <input
            value={text}
            aria-label={t("Command character")}
            aria-invalid={refused}
            autoComplete="off"
            spellCheck={false}
            onFocus={(e) => e.currentTarget.select()}
            onBlur={() => {
              setText(trigger);
              setRefused(false);
            }}
            onChange={(e) => {
              const next = typedCharacter(text, e.target.value);
              setText(next);
              setRefused(next !== "" && !validTrigger(next));
              if (validTrigger(next)) setCommandTrigger(next);
            }}
            className={`${inputCls} text-center font-mono`}
          />
        </div>
        <button onClick={() => setCommandTrigger(DEFAULT_TRIGGER)} disabled={trigger === DEFAULT_TRIGGER} className={btnCls}>
          {t("Reset")}
        </button>
      </div>
      <p className="mt-2 text-xs text-fg-faint">
        {t("Type {command} in the message box to see the commands, or {skill} to run a skill.", { command: trigger, skill: `${trigger}skill:name` })}
      </p>
      {refused && (
        <p role="alert" className="mt-1 text-xs text-warn">
          {t("That cannot be it. Use one punctuation mark or symbol: a letter or digit would open the list for every message, and - _ : are part of a command's name.")}
        </p>
      )}
    </div>
  );
}

/** Only where there is a password: without one there is nothing to sign out of. */
function SignOut({ onError }: { onError: (e: string) => void }) {
  const [required, setRequired] = useState(false);
  const [short, setShort] = useState(false);
  const [sso, setSso] = useState(false);
  useEffect(() => {
    api.authStatus().then((s) => { setRequired(s.authRequired); setShort(Boolean(s.shortPassword)); setSso(Boolean(s.oidc)); }).catch(() => {});
  }, []);
  if (!required) return null;
  const signOut = () =>
    api
      .logout()
      // Where single sign-on ends the session at the provider too (Settings → Authentication), the browser goes there.
      .then((r) => (r.endSession ? window.location.assign(r.endSession) : window.dispatchEvent(new Event(SIGNED_OUT))))
      .catch((e) => onError((e as Error).message));
  return (
    <Section
      title={t("Signed in")}
      hint={sso ? t("Signing out asks you to sign in here again. Other browsers stay signed in.") : t("Signing out asks for the password here again. Other browsers stay signed in.")}
    >
      <button onClick={signOut} className={btnCls}>
        {t("Sign out")}
      </button>
      {short && (
        <p role="note" className="mt-3 text-xs text-warn">
          {t("The portal's password is shorter than 8 characters. It keeps working because it was already in use, but anybody who can reach the portal can try to guess it. Change it under Settings → Authentication.")}
        </p>
      )}
    </Section>
  );
}

/** Whether the browser may say so when a chat finishes or needs an answer. */
function Notifications() {
  const [state, setOn] = useNotifyState();
  const note: Record<string, string> = {
    unsupported: t("This browser does not offer them here — they need a secure connection (HTTPS, or localhost)."),
    denied: t("The browser has blocked them for this site. Allow them in its site settings, then come back."),
  };
  return (
    <SwitchRow
      title={t("Tell me when a chat is done or needs me")}
      detail={t("Only while you are on another tab or window: nobody needs telling about the chat in front of them. The tab title shows what a chat is doing either way.")}
      on={state === "on"}
      disabled={state === "unsupported" || state === "denied"}
      onChange={(on) => void setOn(on)}
      note={note[state]}
    />
  );
}

const THEMES: { value: Theme; label: string; icon: ReactNode }[] = [
  { value: "light", label: msg("Light"), icon: <LuSun /> },
  { value: "dark", label: msg("Dark"), icon: <LuMoon /> },
  { value: "system", label: msg("Match the system"), icon: <LuMonitor /> },
];

/**
 * Light, dark, or whichever the system is — as three cards, each a glimpse of
 * itself. And, where an installed extension brought any, whose colours: the
 * portal's own or a theme's (see extensions/themes.ts).
 */
function Appearance() {
  const { theme, setTheme } = useTheme();
  const brought = useThemes();
  const chosen = usePalette();
  // The one chosen is offered before its extension is loaded as well: it is what is painted.
  const colours = [
    { value: "", label: t("The portal's own") },
    ...brought.map((th) => ({ value: th.id, label: th.name, hint: th.extension })),
    ...(chosen && !brought.some((th) => th.id === chosen.id) ? [{ value: chosen.id, label: chosen.name }] : []),
  ];
  return (
    <>
    <div role="radiogroup" aria-label={t("Theme")} className="grid grid-cols-3 gap-2">
      {THEMES.map((th) => (
        <button
          key={th.value}
          type="button"
          role="radio"
          aria-checked={theme === th.value}
          onClick={() => setTheme(th.value)}
          className={`group rounded-xl border p-2 text-left transition ${
            theme === th.value ? "border-accent/50 bg-accent/5 ring-1 ring-inset ring-accent/30" : "border-line hover:border-fg/20 hover:bg-fg/[.03]"
          }`}
        >
          <span className={`theme-swatch theme-swatch-${th.value}`} aria-hidden="true"><i /><i /><i /></span>
          <span className="mt-2 flex items-center gap-1.5 text-xs text-fg [&>svg]:h-3.5 [&>svg]:w-3.5">
            {th.icon} {t(th.label)}
          </span>
        </button>
      ))}
    </div>
    {colours.length > 1 && (
      <Field label={t("Colours")} hint={t("Themes the installed extensions brought.")} className="mt-4">
        <Select
          className="w-full sm:w-72"
          aria-label={t("Colours")}
          value={chosen?.id ?? ""}
          options={colours}
          onChange={(id) => {
            if (id !== (chosen?.id ?? "")) chooseTheme(id || null);
          }}
        />
      </Field>
    )}
    </>
  );
}

/**
 * The portal's language: one of those there are, or the browser's — which is
 * what it follows until one is picked.
 */
function LanguagePicker() {
  const lang = useLanguage();
  const [choice, setChoice] = useState<LanguageChoice>(languageChoice);
  const system = languages().find((l) => l.code === lang)?.name ?? lang;
  // One chosen here whose file has since gone is English now, and says so.
  const shown = choice === "system" || languages().some((l) => l.code === choice) ? choice : lang;
  return (
    <Select
      className="w-full sm:w-72"
      aria-label={t("Language")}
      value={shown}
      options={[
        { value: "system", label: t("Match the browser"), hint: choice === "system" ? system : undefined },
        ...languages().map((l) => ({ value: l.code, label: l.name })),
      ]}
      onChange={(next) => {
        setChoice(next);
        setLanguage(next);
      }}
    />
  );
}

/** What is kept in this browser rather than on the server. */
function BrowserPanel({ onError }: { onError: (e: string) => void }) {
  return (
    <>
      <p className="mb-5 text-xs text-fg-faint">
        {t("Kept in this browser only — a phone can differ from the laptop.")}
      </p>
      <Section title={t("Appearance")}>
        <Appearance />
      </Section>
      <Section title={t("Animations")}>
        <Animations />
      </Section>
      <Section title={t("Language")} hint={t("The portal's own words. What the agent writes is up to the agent.")}>
        <LanguagePicker />
      </Section>
      <Section title={t("Notifications")}>
        <Notifications />
      </Section>
      <Section
        title={t("Command character")}
        hint={t("What a command starts with when you type it in the message box. The agent is still sent the slash form, so skills and every other command keep working. A dead key, such as ^ on a German keyboard, starts a command in the box, but cannot be used to jump to it from elsewhere on the page.")}
      >
        <CommandCharacter />
      </Section>
      <Section title={t("Confirmations")}>
        <Confirmations />
      </Section>
      <SignOut onError={onError} />
    </>
  );
}

/** Where this portal keeps what it keeps, set when it was deployed; and updating it. */
function AboutPanel({ onError }: { onError: (e: string) => void }) {
  return (
    <>
      <AboutDeployment onError={onError} />
      <UpdateSection />
      <RestartSection />
    </>
  );
}

function AboutDeployment({ onError }: { onError: (e: string) => void }) {
  // What Defaults reads too, fetched ahead: drawn at once from what is kept.
  const { value: meta, failed, reload } = useCached("settings", api.settings, { onError: refreshFailed("settings", onError) });
  if (!meta && failed) return <LoadFailed error={failed} onRetry={reload} />;
  if (!meta) return <SkeletonGroup className="space-y-2" label={t("Loading…")}><div className="skeleton h-4 w-32" /><div className="skeleton h-28 w-full" /></SkeletonGroup>;
  const agentDir = meta.piSettingsPath.replace(/\/settings\.json$/, "");
  const rows: { icon: ReactNode; label: string; value: string; detail: string }[] = [
    {
      icon: <LuServer />,
      label: t("Where the agent runs"),
      value: meta.executor === "container" ? t("In a container") : t("On this host"),
      detail: meta.executor === "container" ? t("Each chat's pi runs in its own container.") : t("pi runs inside the portal's own process."),
    },
    { icon: <LuFolder />, label: t("Workspaces"), value: meta.workspaceRoot, detail: t("Where each chat's folder is made.") },
    { icon: <LuFileJson />, label: t("pi's files"), value: agentDir, detail: t("settings.json, models.json, auth.json, and installed packages.") },
  ];
  return (
    <>
      <Section title={t("This portal")} hint={t("Set when it was deployed, through its environment.")}>
        <dl className="divide-y divide-line/70 overflow-hidden rounded-xl border border-line bg-raised/40">
          {rows.map((r) => (
            <div key={r.label} className="flex items-start gap-3 px-3 py-2.5">
              <span className="mt-0.5 text-fg-faint [&>svg]:h-4 [&>svg]:w-4">{r.icon}</span>
              <div className="min-w-0 flex-1">
                <dt className="text-xs text-fg-subtle">{r.label}</dt>
                <dd className="truncate text-sm text-fg" title={r.value}>{r.value}</dd>
                <p className="text-[11px] text-fg-faint">{r.detail}</p>
              </div>
            </div>
          ))}
        </dl>
      </Section>
    </>
  );
}

function GeneralPanel({ onError, onProviders, onExtensions, onSource }: { onError: (e: string) => void; onProviders: () => void; onExtensions: () => void; onSource: (name: string) => void }) {
  // All three are fetched ahead and kept, and the page waits for all three:
  // drawn part by part, the model menus filled in and a warning pushed the
  // context settings down after the page was already on screen.
  const settings = useCached("settings", api.settings, { onError: refreshFailed("settings", onError) });
  const modelsQuery = useCached("models", api.allModels);
  const reports = useCached("report-targets", api.reportTargets);
  const r = settings.value;
  const models = modelsQuery.value ?? null;
  const modelsFailed = !!modelsQuery.failed;
  const defaults: GlobalSettings | null = r?.defaults ?? null;
  const executor = r?.executor ?? "";

  /** Only the explicit overrides — an empty value means "inherit". */
  const [stored, setStored] = useState<Partial<GlobalSettings> | null>(r?.stored ?? null);
  // What each save said, in the language shown when it is drawn.
  const [saved, setSaved] = useState<(() => string) | null>(null);
  const [keepRecent, setKeepRecent] = useState<number | null>(r?.compaction.keepRecentTokens ?? null);
  const [applied, setApplied] = useState<(() => string) | null>(null);
  /** Typed text, so that a half-written number is not turned into a request. */
  const [ctxText, setCtxText] = useState(r?.contextDefault ? String(r.contextDefault) : "");
  const [ctxSaved, setCtxSaved] = useState<number | null>(r?.contextDefault ?? null);
  const [ctxNote, setCtxNote] = useState<(() => string) | null>(null);
  /** The window's field, which what is saved elsewhere does not overwrite while it is being typed in. */
  const ctxField = useRef<HTMLInputElement>(null);

  /**
   * Each change is saved as it is made: there is no form to forget to submit.
   * One save at a time, ending on the last change asked for: two clicks in a
   * row sent side by side could land in either order. Read again once the
   * last one is in.
   */
  const saver = useMemo(
    () =>
      serialSaver<Partial<GlobalSettings>>(
        async (next) => {
          // Sent even when blank: an empty value clears the override server-side.
          await api.saveSettings({ provider: next.provider ?? "", model: next.model ?? "", thinkingLevel: next.thinkingLevel ?? "" });
        },
        async () => {
          setSaved(() => () => t("Saved"));
          setTimeout(() => setSaved(null), 2000);
          await settings.reload();
        },
      ),
    // One saver for the page's life; what it calls stays the same.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // What was kept is brought up to date when the page opens, or after a save —
  // not while one is out, when what was read may be from before it.
  useEffect(() => {
    if (!r) return;
    if (!saver.busy) setStored(r.stored);
    setKeepRecent(r.compaction.keepRecentTokens);
    setCtxSaved(r.contextDefault);
    if (document.activeElement !== ctxField.current) {
      setCtxText(r.contextDefault ? String(r.contextDefault) : "");
    }
  }, [r]);

  const load = () => settings.reload();

  /**
   * Saved on release, on its own.
   *
   * Not folded into the defaults: that would submit whatever was loaded when
   * the panel opened, so a value set from the context popup in the meantime
   * would be silently rolled back by a save of unrelated fields.
   */
  const saveKeepRecent = useKeepRecentSave(
    (compaction, refreshed) => {
      setKeepRecent(compaction.keepRecentTokens);
      setApplied(() => () =>
        refreshed > 0 ? tp(refreshed, "Applied to {n} open session", "Applied to {n} open sessions") : t("Saved"),
      );
      void load();
      setTimeout(() => setApplied(null), 3000);
    },
    (error) => {
      onError(error.message);
      void load();
    },
  );

  /** On leaving the field, on its own — like the slider above, not part of the defaults. */
  const saveContextDefault = async () => {
    const parsed = parseWindow(ctxText);
    const n = parsed.kind === "ok" ? parsed.tokens : null;
    if (parsed.kind === "bad") {
      onError(t("{problem} — or leave it empty for none", { problem: parsed.message }));
      return setCtxText(ctxSaved ? String(ctxSaved) : "");
    }
    if (n === ctxSaved) return setCtxText(ctxSaved ? String(ctxSaved) : "");
    try {
      const r = await api.setContextDefault(n);
      setCtxSaved(r.contextDefault);
      setCtxText(r.contextDefault ? String(r.contextDefault) : "");
      setCtxNote(() => () => (n === null ? t("Removed") : t("Saved")));
      void load();
      setTimeout(() => setCtxNote(null), 3000);
    } catch (e) {
      onError((e as Error).message);
      setCtxText(ctxSaved ? String(ctxSaved) : "");
    }
  };

  const ready = stored && defaults && (models || modelsFailed) && (reports.value || reports.failed);
  // Without the settings there is nothing to show: no skeleton that never ends.
  if (!r && settings.failed) return <LoadFailed error={settings.failed} onRetry={settings.reload} />;
  if (!ready) {
    // The shape of the page, so it does not jump when the page replaces it.
    return (
      <SkeletonGroup className="space-y-7" label={t("Loading")}>
        {[56, 44].map((h) => (
          <div key={h} className="space-y-2.5">
            <div className="skeleton h-3 w-28" />
            <div className="skeleton h-3 w-3/4" />
            <div className="skeleton w-full" style={{ height: `${h / 4}rem` }} />
          </div>
        ))}
      </SkeletonGroup>
    );
  }

  const save = async (next: Partial<GlobalSettings>) => {
    setStored(next);
    try {
      await saver.request(next);
    } catch (e) {
      onError((e as Error).message);
      void load();
    }
  };

  return (
    <>
      <Section
        title={t("For new chats")}
        hint={t("What a new chat starts with. Each chat keeps whatever is picked for it under the chat box.")}
        action={saved && <span className="pop-in inline-flex items-center gap-1 text-xs text-ok"><LuCheck className="h-3.5 w-3.5" /> {saved()}</span>}
      >
        <div className="space-y-3 rounded-xl border border-line bg-raised/40 p-3">
          {models && models.models.length === 0 && (
            <div className="flex items-center gap-2 rounded-lg bg-warn/10 px-3 py-2 text-xs text-warn">
              <LuTriangleAlert className="h-3.5 w-3.5 shrink-0" />
              <span className="flex-1">{t("No model is ready to use yet.")}</span>
              <button type="button" onClick={onProviders} className="font-medium underline-offset-2 hover:underline">{t("Add a provider")}</button>
            </div>
          )}
          <ModelChoice
            models={models}
            failed={modelsFailed}
            provider={stored.provider ?? ""}
            model={stored.model ?? ""}
            onChange={(next) => void save({ ...stored, ...next })}
            labels={{ provider: t("Default provider"), model: t("Default model") }}
            inherit={{
              provider: defaults.provider,
              model: defaults.model,
              label: (name) => (name ? t("pi's default — {name}", { name }) : t("pi's default")),
              hints: { provider: t("From pi's own settings.json"), model: t("Whatever pi picks for the provider") },
            }}
          />
          <div>
            <div className="flex items-baseline gap-2">
              <span className="text-xs text-fg-muted">{t("Effort")}</span>
              <span className="text-[10px] text-fg-faint">
                {stored.thinkingLevel ? t("click again to go back to pi's default") : defaults.thinkingLevel ? t("pi's default: {level}", { level: effortLabel(defaults.thinkingLevel) }) : ""}
              </span>
            </div>
            <div className="mt-1">
              <EffortPicker
                label={t("Default effort")}
                value={stored.thinkingLevel ?? ""}
                inherited={defaults.thinkingLevel}
                // Clicking the active level again hands it back to pi.
                onChange={(lvl) => void save({ ...stored, thinkingLevel: lvl })}
              />
            </div>
          </div>
          <p className="flex items-center gap-3 text-[11px] text-fg-faint">
            <span className="inline-flex items-center gap-1"><LuEye className="h-3 w-3" /> {t("sees images")}</span>
            <span className="inline-flex items-center gap-1"><LuBrain className="h-3 w-3" /> {t("thinks — effort applies")}</span>
            <button type="button" onClick={onProviders} className="ml-auto text-accent hover:underline">{t("Providers ›")}</button>
          </p>
        </div>
      </Section>

      <Section
        title={t("Context")}
        hint={t("How much of a conversation a chat carries, and what is kept word for word when it is compacted.")}
      >
        <div className="space-y-3 rounded-xl border border-line bg-raised/40 p-3">
          <div>
            <p className="text-xs text-fg-muted">{t("Window")}</p>
            <input
              ref={ctxField}
              value={ctxText}
              disabled={executor === "container"}
              inputMode="numeric"
              onChange={(e) => setCtxText(e.target.value)}
              onBlur={saveContextDefault}
              onKeyDown={(e) => isEnter(e) && e.currentTarget.blur()}
              placeholder={t("what each model says")}
              aria-label={t("Default context window in tokens")}
              className={`${inputCls} mt-1 font-mono`}
            />
            <p className="mt-1.5 text-xs text-fg-faint">
              {tx("How many tokens a chat may hold before it is compacted, in every chat, open ones included. A model that says it has less keeps its own number, and one set for a model in its context pill wins over this. For a server that gives each chat less than the model declares — llama.cpp with {flag} gives each chat half of {size}. Saved when you leave the field.", { flag: <code>--parallel 2</code>, size: <code>ctx-size</code> })}
            </p>
            {executor === "container" && (
              <p className="mt-1 text-xs text-warn">
                {t("Not available with the container executor: pi runs inside the container, where the portal cannot change its context window.")}
              </p>
            )}
            {ctxNote && <p className="mt-1 text-xs text-ok">{ctxNote()}</p>}
          </div>
          <div className="border-t border-line/70 pt-3">
            <p className="text-xs text-fg-muted">{t("Kept when compacting")}</p>
            {keepRecent !== null && (
              <KeepRecent value={keepRecent} onChange={setKeepRecent} onCommit={saveKeepRecent} />
            )}
            <p className="mt-2 text-xs text-fg-faint">
              {t("The most recent stretch is kept word for word; only what is older becomes a summary. pi's default of {n} is a third of a 64k window, which is why compacting can look as though it did nothing. Saved as you let go, and it reaches open chats too.", { n: formatTokens(20000) })}
            </p>
            {applied && <p className="mt-1 text-xs text-ok">{applied()}</p>}
          </div>
        </div>
      </Section>

      <ReportDefault onError={onError} />
      <VoiceModeSettings onError={onError} onExtensions={onExtensions} onSource={onSource} />
    </>
  );
}

// --- one extension's own settings ---

function ExtensionPanel({
  ext,
  onError,
  onSaved,
}: {
  ext: ExtensionInfo;
  onError: (e: string) => void;
  onSaved: () => Promise<ExtensionInfo[]>;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [savedKey, setSavedKey] = useState<string | null>(null);
  const settingsPages = useSlot("settings.page");

  /** A stored value as the field shows it. */
  const shown = (s: ExtensionInfo["settings"][number]) => (s.value == null ? "" : typeof s.value === "object" ? JSON.stringify(s.value) : String(s.value));
  // Reset when switching between extensions, or the previous one's edits leak.
  useEffect(() => {
    setValues(Object.fromEntries(ext.settings.map((s) => [s.key, shown(s)])));
  }, [ext.spec]);
  // A field with something typed in that its own Save has not stored. (A switch saves as it is flipped.)
  useUnsavedDraft(ext.settings.some((s) => s.key in values && values[s.key] !== shown(s)));

  /** What was typed for a key, as the kind of value it is — told from the text when nothing is set yet. */
  const typedFor = (key: string) => {
    const setting = ext.settings.find((s) => s.key === key);
    return typed(setting?.configured ? setting.value : undefined, values[key], key);
  };

  /**
   * Stored as what it is: a number as a number, and a switch as true or false.
   * Written as text, "false" was a string — which an extension reading
   * `if (settings.x)` takes as on.
   */
  const save = async (key: string, value: unknown = typedFor(key)) => {
    setBusy(key);
    try {
      await api.setExtensionSetting(key, value);
      const now = (await onSaved()).find((e) => e.spec === ext.spec)?.settings.find((s) => s.key === key);
      // What the field holds is what is stored now, in the form it is stored in: it is not a draft any more.
      if (now) setValues((was) => ({ ...was, [key]: shown(now) }));
      setSavedKey(key);
      setTimeout(() => setSavedKey(null), 2000);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  // Headed as its entry in the rail is: by the title and the icon its own page gives.
  const { label, icon } = railEntry(ext.name, settingsPages);

  return (
    <>
      <div className="mb-5 flex items-start gap-3">
        {/* At the size the mark had here: the icon sizes itself by the text. */}
        <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-accent/10 text-base text-accent">
          {icon}
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-medium text-fg">{label}</h3>
          {ext.description && <p className="text-xs text-fg-subtle">{ext.description}</p>}
          <p className="mt-0.5 truncate font-mono text-[10px] text-fg-faint">{ext.spec}</p>
        </div>
        {webLink(ext.homepage) && (
          <a
            href={webLink(ext.homepage)}
            target="_blank"
            rel="noreferrer"
            className="shrink-0 rounded-lg p-1.5 text-fg-subtle transition hover:bg-fg/10 hover:text-fg"
            title={t("Homepage")}
          >
            <LuExternalLink className="h-4 w-4" />
          </a>
        )}
      </div>

      {/* The package's own page, where it brought one, above what the portal found for it. One that fails to draw says so, and the fields stay. */}
      {settingsPages.filter((page) => page.extension === ext.name).map((page) => (
        <div key={page.key} className="mb-5" data-extension={page.extension}>
          <ErrorBoundary resetKey={page.key} fallback={(error) => <PartFailed error={error} />} onError={failedIn(page.extension)}>
            <page.component />
          </ErrorBoundary>
        </div>
      ))}
      {ext.settings.length > 0 && (
      <Section title={t("Settings")} hint={t("Saved into pi's settings.json. An extension reads them when a chat starts.")}>
        <div className="stagger-in space-y-2">
          {ext.settings.map((s) => {
            const flag = typeof s.value === "boolean" || s.value === "true" || s.value === "false";
            return (
              <div key={s.key} className="rounded-xl border border-line bg-raised/40 p-3">
                <div className="flex items-center gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-fg">{humanKey(s.key)}</p>
                    <p className="font-mono text-[10px] text-fg-faint">
                      {s.key}
                      {!s.configured && ` · ${t("not set, so the extension's own default")}`}
                    </p>
                  </div>
                  {flag && (
                    <Switch
                      on={s.value === true || s.value === "true"}
                      label={humanKey(s.key)}
                      disabled={busy !== null}
                      onChange={(on) => void save(s.key, on)}
                    />
                  )}
                  {flag && savedKey === s.key && <LuCheck className="pop-in h-4 w-4 text-ok" />}
                </div>
                {!flag && (
                  <div className="mt-2 flex gap-2">
                    <input
                      value={values[s.key] ?? ""}
                      onChange={(e) => setValues({ ...values, [s.key]: e.target.value })}
                      onKeyDown={(e) => isEnter(e) && save(s.key)}
                      inputMode={typeof s.value === "number" ? "numeric" : undefined}
                      type={/(key|token|secret|password)$/i.test(s.key) ? "password" : "text"}
                      placeholder={t("empty to unset")}
                      className={`${inputCls} font-mono text-xs`}
                      aria-label={humanKey(s.key)}
                    />
                    <button
                      disabled={busy !== null || (values[s.key] ?? "") === (s.value == null ? "" : String(s.value))}
                      onClick={() => save(s.key)}
                      className={savedKey === s.key ? primaryCls : btnCls}
                    >
                      {busy === s.key ? (
                        <LuRefreshCw className="h-4 w-4 animate-spin" />
                      ) : savedKey === s.key ? (
                        <LuCheck className="h-4 w-4" />
                      ) : (
                        t("Save")
                      )}
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </Section>
      )}

      {ext.settings.length > 0 && (
      <div className="flex items-start gap-2 rounded-xl border border-warn/25 bg-warn/10 px-3 py-2 text-xs text-warn/90">
        <LuTriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <p>
          {t("pi publishes no schema for extension settings, so these keys are recovered by reading the package's source. A key built dynamically at runtime won't appear here — use Advanced to edit settings.json directly.")}
        </p>
      </div>
      )}
    </>
  );
}

// --- advanced ---

function AdvancedPanel({
  settingsPath,
  onError,
}: {
  settingsPath: string;
  onError: (e: string) => void;
}) {
  const [file, setFile] = useState<{ path: string; content: string } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [saved, flashSaved] = useFlash();
  const [busy, setBusy] = useState(false);
  // The file as it was read or last saved: what is typed over it and not saved is a draft.
  const [from, setFrom] = useState("");
  useUnsavedDraft(!!file && !busy && file.content !== from);

  const read = () =>
    api.piSettings().then(
      (f) => {
        setFailed(null);
        setFile(f);
        setFrom(f.content);
      },
      (e) => setFailed((e as Error).message),
    );
  useEffect(() => {
    void read();
  }, []);

  return (
    <Section
      title="settings.json"
      hint={t("pi's own settings file, where installed extensions keep their configuration.")}
    >
      {!file ? (
        failed ? <LoadFailed error={failed} onRetry={read} /> : <p className="text-sm text-fg-subtle">{t("Loading…")}</p>
      ) : (
        <div className="space-y-2">
          <textarea
            value={file.content}
            aria-label="settings.json"
            onChange={(e) => setFile({ ...file, content: e.target.value })}
            rows={16}
            spellCheck={false}
            className={`${inputCls} resize-y font-mono text-xs`}
          />
          <div className="flex items-center gap-2">
            <button
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await api.savePiSettings(file.content);
                  setFrom(file.content);
                  flashSaved();
                } catch (e) {
                  onError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
              className={primaryCls}
            >
              {saved ? (
                <>
                  <LuCheck className="h-4 w-4" /> {t("Saved")}
                </>
              ) : (
                t("Save file")
              )}
            </button>
            <span className="truncate font-mono text-[11px] text-fg-faint">
              {file.path || settingsPath}
            </span>
          </div>
        </div>
      )}
    </Section>
  );
}
