import { useEffect, useState, type ReactNode } from "react";
import {
  LuBlocks,
  LuCheck,
  LuChevronRight,
  LuCircleAlert,
  LuDownload,
  LuExternalLink,
  LuFileJson,
  LuPlug,
  LuPuzzle,
  LuRadio,
  LuWrench,
  LuRefreshCw,
  LuServer,
  LuSlidersHorizontal,
  LuTrash2,
  LuTriangleAlert,
  LuUsers,
} from "react-icons/lu";
import { api, type ExtensionInfo, type GlobalSettings, type ReportTarget, type ReportTo } from "../api";
import { ChannelsPanel } from "./ChannelsPanel";
import { SkillsPanel } from "./SkillsPanel";
import { McpPanel } from "./McpPanel";
import { KeepRecent, formatTokens, useKeepRecentSave } from "./KeepRecent";
import { PeoplePanel } from "./PeoplePanel";
import { PortalExtensions } from "./PortalExtensions";
import { Modal } from "./Modal";

export type Tab =
  | "general"
  | "channels"
  | "people"
  | "add-ons"
  | "skills"
  | "mcp"
  | "extensions"
  | "advanced";

/** Either a fixed tab or one extension's own configuration page. */
type Nav = { kind: "tab"; id: Tab } | { kind: "ext"; spec: string };

const TABS: { id: Tab; label: string; icon: ReactNode; hint: string }[] = [
  {
    id: "general",
    label: "General",
    icon: <LuSlidersHorizontal />,
    hint: "Defaults applied to new sessions",
  },
  {
    id: "channels",
    label: "Channels",
    icon: <LuRadio />,
    hint: "Two-way links into the agent",
  },
  {
    id: "people",
    label: "People",
    icon: <LuUsers />,
    hint: "Who the agent will talk to",
  },
  {
    id: "add-ons",
    label: "Add-ons",
    icon: <LuPuzzle />,
    hint: "Optional parts of the portal itself",
  },
  {
    id: "skills",
    label: "Skills",
    icon: <LuWrench />,
    hint: "Procedures the agent can reach for",
  },
  {
    id: "mcp",
    label: "MCP",
    icon: <LuPlug />,
    hint: "Servers the agent can pull tools from",
  },
  { id: "extensions", label: "Extensions", icon: <LuBlocks />, hint: "Install and manage packages" },
  { id: "advanced", label: "Advanced", icon: <LuFileJson />, hint: "pi's raw settings file" },
];

export function ConfigModal({
  onClose,
  initialTab = "general",
}: {
  onClose: () => void;
  initialTab?: Tab;
}) {
  const [nav, setNav] = useState<Nav>({ kind: "tab", id: initialTab });
  const [error, setError] = useState<string | null>(null);

  // Loaded here rather than inside the Extensions tab: the rail lists every
  // extension that exposes settings, so it needs them before anything is shown.
  const [extensions, setExtensions] = useState<ExtensionInfo[]>([]);
  const [settingsPath, setSettingsPath] = useState("");
  const [loadingExts, setLoadingExts] = useState(true);

  const loadExtensions = async () => {
    setLoadingExts(true);
    try {
      const r = await api.extensions();
      setExtensions(r.extensions);
      setSettingsPath(r.settingsPath);
      return r.extensions;
    } catch (e) {
      setError((e as Error).message);
      return [];
    } finally {
      setLoadingExts(false);
    }
  };

  useEffect(() => {
    loadExtensions();
  }, []);

  const configurable = extensions.filter((e) => e.settings.length > 0);
  const activeExt =
    nav.kind === "ext" ? extensions.find((e) => e.spec === nav.spec) : undefined;

  return (
    <Modal
      wide
      title="Settings"
      subtitle="Applies to the whole portal"
      onClose={onClose}
      rail={
        <div className="space-y-4">
          <RailGroup>
            {TABS.map((t) => (
              <RailItem
                key={t.id}
                icon={t.icon}
                label={t.label}
                active={nav.kind === "tab" && nav.id === t.id}
                onClick={() => setNav({ kind: "tab", id: t.id })}
              />
            ))}
          </RailGroup>

          {/* Only appears for extensions that actually read settings. */}
          {configurable.length > 0 && (
            <RailGroup label="Extension config">
              {configurable.map((e) => (
                <RailItem
                  key={e.spec}
                  icon={<LuPuzzle />}
                  label={e.name}
                  active={nav.kind === "ext" && nav.spec === e.spec}
                  onClick={() => setNav({ kind: "ext", spec: e.spec })}
                />
              ))}
            </RailGroup>
          )}
        </div>
      }
    >
      {error && (
        <div className="mb-4 flex items-start gap-2 rounded-xl border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
          <LuCircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <span className="min-w-0 flex-1">{error}</span>
          <button onClick={() => setError(null)} className="text-danger/70 hover:text-danger">
            ✕
          </button>
        </div>
      )}

      {nav.kind === "tab" && nav.id === "general" && <GeneralPanel onError={setError} />}
      {nav.kind === "tab" && nav.id === "channels" && <ChannelsPanel onError={setError} />}
      {nav.kind === "tab" && nav.id === "people" && <PeoplePanel onError={setError} />}
      {nav.kind === "tab" && nav.id === "add-ons" && <PortalExtensions onError={setError} />}
      {nav.kind === "tab" && nav.id === "skills" && <SkillsPanel onError={setError} />}
      {nav.kind === "tab" && nav.id === "mcp" && <McpPanel onError={setError} />}
      {nav.kind === "tab" && nav.id === "extensions" && (
        <ExtensionsPanel
          extensions={extensions}
          loading={loadingExts}
          onError={setError}
          onRefresh={loadExtensions}
          onConfigure={(spec) => setNav({ kind: "ext", spec })}
        />
      )}
      {nav.kind === "tab" && nav.id === "advanced" && (
        <AdvancedPanel settingsPath={settingsPath} onError={setError} />
      )}
      {nav.kind === "ext" &&
        (activeExt ? (
          <ExtensionPanel ext={activeExt} onError={setError} onSaved={loadExtensions} />
        ) : (
          <Empty>That extension is no longer installed.</Empty>
        ))}
    </Modal>
  );
}

// --- rail ---

function RailGroup({ label, children }: { label?: string; children: ReactNode }) {
  return (
    <div>
      {label && (
        <p className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-fg-faint">
          {label}
        </p>
      )}
      <div className="space-y-0.5">{children}</div>
    </div>
  );
}

function RailItem({
  icon,
  label,
  active,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition ${
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

// --- shared bits ---

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="mb-6">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-fg-subtle">{title}</h3>
      {hint && <p className="mt-0.5 text-xs text-fg-subtle">{hint}</p>}
      <div className="mt-2.5">{children}</div>
    </section>
  );
}

/** Labels a field and says what it falls back to when left blank. */
function Inherited({
  label,
  value,
  children,
}: {
  label: string;
  value: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <div className="flex items-baseline gap-2">
        <span className="text-xs text-fg-muted">{label}</span>
        {value && (
          <span className="truncate font-mono text-[10px] text-fg-faint">inherits {value}</span>
        )}
      </div>
      {children}
    </label>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-line px-3 py-8 text-center text-sm text-fg-subtle">
      {children}
    </div>
  );
}

const inputCls =
  "w-full rounded-lg border border-line bg-raised/60 px-3 py-2 text-sm outline-none transition placeholder:text-fg-faint focus:border-accent/60";
const btnCls =
  "inline-flex items-center gap-1.5 rounded-lg bg-fg/5 px-3 py-2 text-sm text-fg transition hover:bg-fg/10 disabled:opacity-40";
const primaryCls =
  "inline-flex items-center gap-1.5 rounded-lg bg-accent/12 px-3 py-2 text-sm text-accent ring-1 ring-inset ring-accent/25 transition hover:bg-accent/20 disabled:opacity-40";

const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

// --- general ---

/**
 * Where a routine reports when it does not name a destination itself.
 *
 * Lives here rather than on the Routines page because it is a portal-wide
 * default: a routine created by the agent from a chat gets it without anyone
 * opening a form.
 */
function ReportDefault({ onError }: { onError: (e: string) => void }) {
  const [targets, setTargets] = useState<ReportTarget[]>([]);
  const [current, setCurrent] = useState<ReportTo | null>(null);
  const [loaded, setLoaded] = useState(false);

  const load = () =>
    api
      .reportTargets()
      .then((r) => {
        setTargets(r.targets);
        setCurrent(r.default);
        setLoaded(true);
      })
      .catch((e) => onError((e as Error).message));

  useEffect(() => {
    load();
  }, []);

  if (!loaded) return null;

  const value = current ? `${current.channel}\u0000${current.target}` : "";

  return (
    <Section
      title="Routine reports"
      hint="Where a scheduled run reaches you when it has something worth saying. The agent decides whether a run is worth reporting; a routine can point somewhere else of its own."
    >
      <select
        value={value}
        onChange={async (e) => {
          const [channel, target] = e.target.value.split("\u0000");
          try {
            await api.setReportDefault(channel && target ? { channel, target } : null);
            await load();
          } catch (err) {
            onError((err as Error).message);
          }
        }}
        className={inputCls}
      >
        <option value="">Nowhere — routines stay silent</option>
        {targets.map((t) => (
          <option key={`${t.channel}\u0000${t.target}`} value={`${t.channel}\u0000${t.target}`}>
            {t.channel} — {t.label}
          </option>
        ))}
      </select>
      {targets.length === 0 && (
        <p className="mt-1.5 text-xs text-fg-faint">
          Nothing to pick yet. A destination is a conversation that already exists on a channel
          that can speak first — message your bot once and it appears here. A webhook never will:
          it can only answer.
        </p>
      )}
    </Section>
  );
}

function GeneralPanel({ onError }: { onError: (e: string) => void }) {
  /** Only the explicit overrides — an empty field means "inherit". */
  const [stored, setStored] = useState<Partial<GlobalSettings> | null>(null);
  const [defaults, setDefaults] = useState<GlobalSettings | null>(null);
  const [meta, setMeta] = useState<{
    executor: string;
    workspaceRoot: string;
    piSettingsPath: string;
  } | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [keepRecent, setKeepRecent] = useState<number | null>(null);
  const [applied, setApplied] = useState<string | null>(null);

  const load = () =>
    api
      .settings()
      .then((r) => {
        setStored(r.stored);
        setDefaults(r.defaults);
        setKeepRecent(r.compaction.keepRecentTokens);
        setMeta({
          executor: r.executor,
          workspaceRoot: r.workspaceRoot,
          piSettingsPath: r.piSettingsPath,
        });
      })
      .catch((e) => onError((e as Error).message));

  useEffect(() => {
    load();
  }, []);

  /**
   * Saved on release, on its own.
   *
   * Not folded into Save defaults: that would submit whatever was loaded when
   * the panel opened, so a value set from the context popup in the meantime
   * would be silently rolled back by a save of unrelated fields.
   */
  const saveKeepRecent = useKeepRecentSave(
    (compaction, refreshed) => {
      setKeepRecent(compaction.keepRecentTokens);
      setApplied(
        refreshed > 0 ? `Applied to ${refreshed} open session${refreshed === 1 ? "" : "s"}` : "Saved",
      );
      setTimeout(() => setApplied(null), 3000);
    },
    (error) => {
      onError(error.message);
      void load();
    },
  );

  if (!stored || !defaults) return <p className="text-sm text-fg-subtle">Loading…</p>;

  const save = async () => {
    setBusy(true);
    try {
      // Sent even when blank: an empty value clears the override server-side.
      await api.saveSettings({
        provider: stored.provider ?? "",
        model: stored.model ?? "",
        thinkingLevel: stored.thinkingLevel ?? "",
      });
      await load();
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Section
        title="Defaults for new sessions"
        hint="Leave a field empty to inherit it from pi's own settings.json. A session keeps whatever you pick for it under the chat box."
      >
        <div className="space-y-3">
          <Inherited label="Provider" value={defaults.provider}>
            <input
              value={stored.provider ?? ""}
              onChange={(e) => setStored({ ...stored, provider: e.target.value })}
              placeholder={defaults.provider || "inherit"}
              className={`${inputCls} mt-1 font-mono`}
            />
          </Inherited>
          <Inherited label="Model" value={defaults.model}>
            <input
              value={stored.model ?? ""}
              onChange={(e) => setStored({ ...stored, model: e.target.value })}
              placeholder={defaults.model || "pi decides"}
              className={`${inputCls} mt-1 font-mono`}
            />
          </Inherited>
          <div>
            <div className="flex items-baseline gap-2">
              <span className="text-xs text-fg-muted">Effort</span>
              {!stored.thinkingLevel && defaults.thinkingLevel && (
                <span className="text-[10px] text-fg-faint">
                  inheriting {defaults.thinkingLevel}
                </span>
              )}
            </div>
            <div className="mt-1 flex flex-wrap gap-1">
              {LEVELS.map((lvl) => (
                <button
                  key={lvl}
                  onClick={() =>
                    setStored({
                      ...stored,
                      // Clicking the active level again hands it back to pi.
                      thinkingLevel: stored.thinkingLevel === lvl ? "" : lvl,
                    })
                  }
                  className={`rounded-lg px-2.5 py-1 text-xs capitalize transition ${
                    stored.thinkingLevel === lvl
                      ? "bg-warn/12 text-warn ring-1 ring-inset ring-warn/30"
                      : "bg-fg/5 text-fg-muted hover:bg-fg/10"
                  }`}
                >
                  {lvl}
                </button>
              ))}
            </div>
          </div>
          <button onClick={save} disabled={busy} className={`${primaryCls} w-full justify-center`}>
            {busy ? (
              <>
                <LuRefreshCw className="h-4 w-4 animate-spin" /> Saving…
              </>
            ) : saved ? (
              <>
                <LuCheck className="h-4 w-4" /> Saved
              </>
            ) : (
              "Save defaults"
            )}
          </button>
        </div>
      </Section>

      <Section
        title="Compaction"
        hint="What a compaction leaves untouched. The most recent stretch of a conversation is kept word for word; only what is older is replaced by a summary."
      >
        <div className="rounded-xl border border-line bg-raised/40 p-3">
          {keepRecent !== null && (
            <KeepRecent
              value={keepRecent}
              onChange={setKeepRecent}
              onCommit={saveKeepRecent}
              disabled={busy}
            />
          )}
          <p className="mt-2 text-xs text-fg-faint">
            This is the floor a compacted session settles at, before the summary is added — pi's
            default of {formatTokens(20000)} is a third of a 64k window, which is why compacting can
            look as though it did nothing. Saved as you release the slider, and unlike the defaults
            above it reaches sessions that are already open.
          </p>
          {applied && <p className="mt-1 text-xs text-ok">{applied}</p>}
        </div>
      </Section>

      <ReportDefault onError={onError} />

      <Section title="Deployment">
        <dl className="rounded-xl border border-line bg-raised/40 p-3 text-sm">
          <div className="flex items-center gap-2 py-0.5">
            <LuServer className="h-3.5 w-3.5 shrink-0 text-fg-faint" />
            <dt className="text-fg-subtle">executor</dt>
            <dd className="ml-auto font-mono text-fg-muted">{meta?.executor}</dd>
          </div>
          <div className="flex items-center gap-2 py-0.5">
            <LuChevronRight className="h-3.5 w-3.5 shrink-0 text-fg-faint" />
            <dt className="shrink-0 text-fg-subtle">workspaces</dt>
            <dd className="ml-auto truncate pl-4 font-mono text-fg-muted">{meta?.workspaceRoot}</dd>
          </div>
          <div className="flex items-center gap-2 py-0.5">
            <LuFileJson className="h-3.5 w-3.5 shrink-0 text-fg-faint" />
            <dt className="shrink-0 text-fg-subtle">pi settings</dt>
            <dd className="ml-auto truncate pl-4 font-mono text-fg-muted">
              {meta?.piSettingsPath}
            </dd>
          </div>
          <p className="mt-1.5 text-xs text-fg-faint">
            Executor and workspace root are set at deploy time via environment.
          </p>
        </dl>
      </Section>
    </>
  );
}

// --- extensions ---

const SOURCES = [
  { label: "npm", placeholder: "npm:@scope/package", hint: "published on npm" },
  { label: "git", placeholder: "git:github.com/user/repo@v1", hint: "a git repository" },
  { label: "url", placeholder: "https://github.com/user/repo", hint: "a URL" },
  { label: "path", placeholder: "/absolute/path/to/package", hint: "a local directory" },
];

function ExtensionsPanel({
  extensions,
  loading,
  onError,
  onRefresh,
  onConfigure,
}: {
  extensions: ExtensionInfo[];
  loading: boolean;
  onError: (e: string) => void;
  onRefresh: () => Promise<ExtensionInfo[]>;
  onConfigure: (spec: string) => void;
}) {
  const [spec, setSpec] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const act = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    try {
      await fn();
      await onRefresh();
      setSpec("");
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <Section
        title="Install"
        hint="Extensions, skills, prompt templates and themes. They persist across restarts."
      >
        <div className="flex gap-2">
          <input
            value={spec}
            onChange={(e) => setSpec(e.target.value)}
            onKeyDown={(e) =>
              e.key === "Enter" &&
              spec.trim() &&
              act("install", () => api.installPackage(spec.trim()))
            }
            placeholder="npm:@scope/package"
            className={`${inputCls} font-mono text-xs`}
          />
          <button
            disabled={!spec.trim() || busy !== null}
            onClick={() => act("install", () => api.installPackage(spec.trim()))}
            className={primaryCls}
          >
            <LuDownload className="h-4 w-4" />
            {busy === "install" ? "Installing…" : "Install"}
          </button>
        </div>
        <div className="mt-2 flex flex-wrap gap-1">
          {SOURCES.map((s) => (
            <button
              key={s.label}
              onClick={() => setSpec(s.placeholder)}
              title={`Install from ${s.hint}`}
              className="rounded-lg bg-fg/5 px-2 py-0.5 font-mono text-[11px] text-fg-muted transition hover:bg-fg/10 hover:text-fg"
            >
              {s.label}
            </button>
          ))}
        </div>
      </Section>

      <Section title={`Installed${extensions.length ? ` (${extensions.length})` : ""}`}>
        {loading ? (
          <p className="text-sm text-fg-subtle">Reading installed packages…</p>
        ) : extensions.length === 0 ? (
          <Empty>
            Nothing installed yet.
            <p className="mt-1 text-xs text-fg-faint">
              Installed commands show up in the chat box when you type “/”.
            </p>
          </Empty>
        ) : (
          <ul className="space-y-1.5">
            {extensions.map((ext) => (
              <li
                key={ext.spec}
                className="rounded-xl border border-line bg-raised/40 px-3 py-2.5"
              >
                <div className="flex items-center gap-2">
                  <LuPuzzle className="h-4 w-4 shrink-0 text-fg-subtle" />
                  <p className="truncate text-sm text-fg">{ext.name}</p>
                  {ext.version && (
                    <span className="shrink-0 rounded bg-fg/5 px-1.5 py-0.5 font-mono text-[10px] text-fg-subtle">
                      v{ext.version}
                    </span>
                  )}
                  {ext.scope && (
                    <span className="shrink-0 rounded bg-fg/5 px-1.5 py-0.5 text-[10px] text-fg-subtle">
                      {ext.scope}
                    </span>
                  )}
                  <button
                    disabled={busy !== null}
                    onClick={() => act(ext.spec, () => api.removePackage(ext.spec))}
                    title="Remove"
                    className="ml-auto shrink-0 rounded-lg p-1.5 text-fg-subtle transition hover:bg-danger/10 hover:text-danger disabled:opacity-40"
                  >
                    {busy === ext.spec ? (
                      <LuRefreshCw className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <LuTrash2 className="h-3.5 w-3.5" />
                    )}
                  </button>
                </div>

                {ext.description && (
                  <p className="mt-1 line-clamp-2 text-xs text-fg-subtle">{ext.description}</p>
                )}

                <div className="mt-1.5 flex items-center gap-3">
                  <span className="truncate font-mono text-[10px] text-fg-faint">{ext.spec}</span>
                  {ext.settings.length > 0 && (
                    <button
                      onClick={() => onConfigure(ext.spec)}
                      className="ml-auto shrink-0 text-[11px] text-accent hover:text-accent"
                    >
                      Configure ({ext.settings.length}) ›
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}

        <div className="mt-2.5 flex items-center gap-2">
          <button
            disabled={busy !== null}
            onClick={() => act("update", () => api.updatePackages())}
            className={btnCls}
          >
            <LuDownload className="h-4 w-4" />
            {busy === "update" ? "Updating…" : "Update all"}
          </button>
          <button onClick={() => onRefresh()} className={btnCls}>
            <LuRefreshCw className="h-4 w-4" /> Refresh
          </button>
        </div>
      </Section>
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

  // Reset when switching between extensions, or the previous one's edits leak.
  useEffect(() => {
    setValues(
      Object.fromEntries(ext.settings.map((s) => [s.key, s.value == null ? "" : String(s.value)]))
    );
  }, [ext.spec]);

  const save = async (key: string) => {
    setBusy(key);
    try {
      await api.setExtensionSetting(key, values[key]);
      await onSaved();
      setSavedKey(key);
      setTimeout(() => setSavedKey(null), 2000);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <div className="mb-5 flex items-start gap-3">
        <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-accent/10 text-accent">
          <LuPuzzle className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-medium text-fg">{ext.name}</h3>
          {ext.description && <p className="text-xs text-fg-subtle">{ext.description}</p>}
          <p className="mt-0.5 truncate font-mono text-[10px] text-fg-faint">{ext.spec}</p>
        </div>
        {ext.homepage && (
          <a
            href={ext.homepage}
            target="_blank"
            rel="noreferrer"
            className="shrink-0 rounded-lg p-1.5 text-fg-subtle transition hover:bg-fg/10 hover:text-fg"
            title="Homepage"
          >
            <LuExternalLink className="h-4 w-4" />
          </a>
        )}
      </div>

      <Section title="Settings">
        <div className="space-y-3">
          {ext.settings.map((s) => (
            <div key={s.key}>
              <div className="flex items-baseline gap-2">
                <label className="font-mono text-xs text-fg-muted">{s.key}</label>
                {!s.configured && (
                  <span className="text-[10px] text-fg-faint">not set — using its default</span>
                )}
              </div>
              <div className="mt-1 flex gap-2">
                <input
                  value={values[s.key] ?? ""}
                  onChange={(e) => setValues({ ...values, [s.key]: e.target.value })}
                  onKeyDown={(e) => e.key === "Enter" && save(s.key)}
                  placeholder="empty to unset"
                  className={`${inputCls} font-mono text-xs`}
                />
                <button
                  disabled={busy !== null}
                  onClick={() => save(s.key)}
                  className={savedKey === s.key ? primaryCls : btnCls}
                >
                  {busy === s.key ? (
                    <LuRefreshCw className="h-4 w-4 animate-spin" />
                  ) : savedKey === s.key ? (
                    <LuCheck className="h-4 w-4" />
                  ) : (
                    "Save"
                  )}
                </button>
              </div>
            </div>
          ))}
        </div>
      </Section>

      <div className="flex items-start gap-2 rounded-xl border border-warn/25 bg-warn/10 px-3 py-2 text-xs text-warn/90">
        <LuTriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <p>
          pi publishes no schema for extension settings, so these keys are recovered by reading the
          package's source. A key built dynamically at runtime won't appear here — use Advanced to
          edit settings.json directly.
        </p>
      </div>
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
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.piSettings().then(setFile).catch((e) => onError((e as Error).message));
  }, []);

  return (
    <Section
      title="settings.json"
      hint="pi's own settings file, where installed extensions keep their configuration."
    >
      {!file ? (
        <p className="text-sm text-fg-subtle">Loading…</p>
      ) : (
        <div className="space-y-2">
          <textarea
            value={file.content}
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
                  setSaved(true);
                  setTimeout(() => setSaved(false), 2000);
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
                  <LuCheck className="h-4 w-4" /> Saved
                </>
              ) : (
                "Save file"
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
