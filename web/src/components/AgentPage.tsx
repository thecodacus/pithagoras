import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { OrbStudio } from "./OrbStudio";
import { ActivityFeed, HeartbeatSettings } from "./AgentHeartbeat";
import { AgentSkills } from "./AgentSkills";
import { VoiceOrb, type VoiceLevels } from "./VoiceOrb";
import {
  LuBot,
  LuCheck,
  LuChevronLeft,
  LuFileText,
  LuFolder,
  LuMessageSquare,
  LuMonitor,
  LuPencil,
  LuPlus,
  LuRadio,
  LuRefreshCw,
  LuTrash2,
  LuUser,
  LuX,
} from "react-icons/lu";
import { PageHeader, Stat } from "./PageHeader";
import { RowsSkeleton } from "./Skeleton";
import { api, ApiError, type Agent, type AgentSession, type AgentSetup as Setup } from "../api";
import { AgentSetup } from "./AgentSetup";
import { ToolSwitches } from "./ToolSwitches";
import { confirmDeleteSession } from "./SessionActions";
import { Modal } from "./Modal";
import { ErrorBanner, LoadFailed, primarySmCls } from "./SettingsUi";
import { StatusDot } from "./StatusDot";
import { TitleInput } from "./TitleInput";
import { pollWhileVisible } from "../poll";
import { msg, t, tp } from "../i18n";
import { tabKeys } from "../tab-keys";
import { useFlash } from "../use-flash";
import { when } from "../time";

/**
 * The agents: a card for each, with its avatar and name, and a way to make
 * another. A card opens that agent (`?agent=`), with its own home, files and
 * conversations.
 */
export function AgentPage({ onSelect }: { onSelect: (id: string) => void }) {
  const [params, setParams] = useSearchParams();
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [creating, setCreating] = useState(false);
  // The files an agent's folder already had, and so its answers did not replace: said on its page until it is told to go or the agent is left, not again.
  const [madeKept, setMadeKept] = useState<{ id: string; files: string[] } | null>(null);
  const [error, setError] = useState("");

  const loadAgents = useCallback(
    () =>
      api.agents().then(
        (r) => {
          setAgents(r.agents);
          setError("");
        },
        (e) => setError((e as Error).message),
      ),
    [],
  );
  useEffect(() => {
    void loadAgents();
  }, [loadAgents]);

  const asked = params.get("agent");
  const agent = asked ? agents?.find((a) => a.id === asked) : undefined;
  // However the agent is left — the link back, the browser's Back, the sidebar — the note goes with it. Only when the
  // link changes: a new agent's note is set a moment before the link comes to name it.
  useEffect(() => {
    setMadeKept((made) => (made && made.id !== asked ? null : made));
  }, [asked]);

  if (creating) {
    return (
      <div className="flex h-full flex-col overflow-y-auto">
        <AgentSetup
          onCancel={() => setCreating(false)}
          onSubmit={async (input) => {
            const made = await api.createAgent(input);
            await loadAgents();
            setMadeKept({ id: made.id, files: answersLeft(made.kept) });
            setCreating(false);
            setParams({ agent: made.id });
          }}
        />
      </div>
    );
  }

  if (!agents) {
    return (
      <div className="mx-auto w-full max-w-3xl px-4 py-6">
        {error ? <LoadFailed error={error} onRetry={loadAgents} /> : <RowsSkeleton />}
      </div>
    );
  }

  // No agent asked for, or one that is gone since: the cards.
  if (!agent) return <AgentCards agents={agents} onOpen={(id) => setParams({ agent: id })} onNew={() => setCreating(true)} />;

  return (
    <AgentView
      // Its own state for each agent: a draft of one's SOUL.md is not another's.
      key={agent.id}
      agent={agent}
      kept={madeKept?.id === agent.id ? madeKept.files : []}
      onKept={(files) => setMadeKept({ id: agent.id, files })}
      back={
        <button
          onClick={() => setParams({})}
          className="mb-4 inline-flex items-center gap-1.5 text-xs text-fg-subtle transition hover:text-fg-muted"
        >
          <LuChevronLeft className="h-3.5 w-3.5" /> {t("Agents")}
        </button>
      }
      onChanged={loadAgents}
      onDeleted={async () => {
        await loadAgents();
        setParams({});
      }}
      onSelect={onSelect}
    />
  );
}

/** What the wizard's answers are written to: of the files an agent's folder already had, the ones it left as they were. */
const answersLeft = (kept?: string[]) => (kept ?? []).filter((file) => file === "SOUL.md" || file === "PrimaryUser.md");

/** A card for each agent, with its avatar and name, and one that makes a new agent. */
function AgentCards({ agents, onOpen, onNew }: { agents: Agent[]; onOpen: (id: string) => void; onNew: () => void }) {
  // Still: a page of them all moving at once would be busy.
  const still = useRef<VoiceLevels>({ input: 0, output: 0 });
  return (
    <div className="h-full overflow-y-auto px-4 py-6">
      <div className="mx-auto w-full max-w-3xl">
        <PageHeader
          icon={<LuBot />}
          title={t("Agents")}
          description={t("Each agent has its own character, memory and files, in a home folder of its own. Open one for its conversations and files.")}
        />
        <ul className="stagger-in mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3">
          {agents.map((a) => (
            <li key={a.id}>
              <button
                onClick={() => onOpen(a.id)}
                className="group relative flex w-full flex-col items-center rounded-2xl border border-line bg-raised/40 px-3 pb-4 pt-5 text-center transition hover:border-accent/40 hover:bg-raised/70"
              >
                {/* Room around the orb for its glow, and for a hat or a prop. */}
                <div className="flex h-28 w-28 items-center justify-center rounded-2xl bg-[#0b1220]">
                  <div className="voice-avatar w-[56%]">
                    <VoiceOrb mode="idle" levels={still} look={a.orb} />
                  </div>
                </div>
                {a.unread > 0 && (
                  <span className="absolute right-2.5 top-2.5 rounded-full bg-accent/15 px-1.5 text-[11px] text-accent" title={tp(a.unread, "{n} new note", "{n} new notes")}>
                    {a.unread}
                  </span>
                )}
                <p className="mt-3 w-full truncate text-sm font-medium text-fg">{a.name}</p>
                <p className="mt-0.5 text-[11px] text-fg-faint">
                  {a.initialised ? tp(a.chats, "{n} chat", "{n} chats") : t("Not set up yet")}
                  {a.channels.length > 0 && ` · ${tp(a.channels.length, "{n} channel", "{n} channels")}`}
                </p>
              </button>
            </li>
          ))}
          <li>
            <button
              onClick={onNew}
              className="flex h-full min-h-[11rem] w-full flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-line text-sm text-fg-subtle transition hover:border-accent/40 hover:text-accent"
            >
              <LuPlus className="h-5 w-5" />
              {t("New agent")}
            </button>
          </li>
        </ul>
      </div>
    </div>
  );
}

/** Conversations started here rather than arriving through a channel. */
const BROWSER = "browser";

/**
 * The agent's conversations, one per chat rather than one overall.
 *
 * A channel package supplies a key for each conversation it sees — a Telegram
 * chat id, a Slack channel — and the portal turns each into its own session.
 * That is what stops a group chat and a DM sharing a memory. They are ordinary
 * sessions, so they open in the ordinary chat view.
 */
function AgentView({
  agent,
  kept,
  onKept,
  back,
  onChanged,
  onDeleted,
  onSelect,
}: {
  agent: Agent;
  /** The files its folder already had, which the answers did not replace (see `answersLeft`), until they are dismissed. Held by the page, so that it is said once and not again each time the agent is opened. */
  kept: string[];
  onKept: (files: string[]) => void;
  back: ReactNode;
  onChanged: () => Promise<void>;
  onDeleted: () => Promise<void>;
  onSelect: (id: string) => void;
}) {
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  const [setup, setSetup] = useState<Setup | null>(null);
  const [setupFailed, setSetupFailed] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState("");
  // Kept apart from `error`: this one comes back by itself when the next
  // refresh works, and must not wipe out — or be wiped by — the answer to a
  // rename or a delete.
  const [loadError, setLoadError] = useState("");
  // Whether the list was ever read: a failure before that is not "out of date", there is nothing to be out of date.
  const listRead = useRef(false);
  // The conversation whose name is open for editing, if any; the agent's own as "agent".
  const [renaming, setRenaming] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  // The tab shown, kept in the link beside the agent: Conversations without one.
  const [params, setParams] = useSearchParams();
  const tab: AgentTab = AGENT_TABS.find(([id]) => id === params.get("tab"))?.[0] ?? "conversations";
  const setTab = (id: AgentTab) =>
    setParams((p) => {
      const next = new URLSearchParams(p);
      if (id === "conversations") next.delete("tab");
      else next.set("tab", id);
      return next;
    });
  // What the agent's heartbeat is doing, and how many notes are unread, change on their own.
  useEffect(() => pollWhileVisible(() => void onChanged(), 15_000), [onChanged]);

  const load = () =>
    api
      .agentSessions(agent.id)
      .then((r) => {
        listRead.current = true;
        setSessions(r.sessions);
        setLoadError("");
      })
      // The list stays as it was rather than being emptied, and the page says
      // it is out of date: an empty list that is really a failed fetch reads as
      // "the agent has no conversations".
      .catch((e) => setLoadError((e as Error).message))
      .finally(() => setLoading(false));

  // A file that is a link is left alone and has no editor under Files, so the note does not send anybody there.
  const links = kept.filter((name) => setup?.files.find((f) => f.name === name)?.link);
  const edits = kept.filter((name) => !links.includes(name));

  const readSetup = () =>
    api.agentSetup(agent.id).then(
      (r) => {
        setSetupFailed(null);
        setSetup(r);
      },
      (e) => setSetupFailed((e as Error).message),
    );

  useEffect(() => {
    void readSetup();
    load();
    return pollWhileVisible(load, 5000);
    // Keyed on the agent by its parent: one agent per mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const renameAgent = async (next: string) => {
    setRenaming(null);
    if (next === agent.name) return;
    setError("");
    try {
      await api.renameAgent(agent.id, next);
      await onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  /**
   * Rename and delete, as the sidebar does them: these are the same sessions,
   * and the same two routes. Deleting one that arrived through a channel does
   * not block the chat — the next message in it simply starts a new
   * conversation, which is the reason to say so first.
   */
  const rename = async (s: AgentSession, next: string) => {
    setRenaming(null);
    setError("");
    try {
      await api.renameSession(s.id, next);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const remove = async (s: AgentSession) => {
    if (!(await confirmDeleteSession(s.title, Boolean(s.channel && s.channel.slug !== BROWSER)))) return;
    setError("");
    try {
      await api.deleteSession(s.id);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  // Grouped by the door each conversation came through.
  const groups = useMemo(() => {
    const out = new Map<
      string,
      { name: string; kind: string | null; present: boolean; items: AgentSession[] }
    >();
    for (const s of sessions) {
      const key = s.channel?.slug ?? "none";
      if (!out.has(key)) {
        out.set(key, {
          name: s.channel?.name ?? "",
          kind: s.channel?.kind ?? null,
          // A browser conversation has no channel by design, so it must not be
          // flagged as one whose channel went missing.
          present: key === BROWSER ? true : (s.channel?.present ?? false),
          items: [],
        });
      }
      out.get(key)!.items.push(s);
    }
    return [...out.entries()];
  }, [sessions]);

  // Nothing else on this page means much until the agent has a character and
  // knows who it is talking to.
  if (setup && !setup.initialised) {
    return (
      <div className="flex h-full flex-col overflow-y-auto">
        <div className="mx-auto w-full max-w-xl px-4 pt-6">{back}</div>
        <AgentSetup
          home={setup.home}
          onSubmit={async (input) => {
            const done = await api.runAgentWizard(agent.id, input);
            setSetup(done);
            onKept(answersLeft(done.kept));
            await onChanged();
          }}
        />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-y-auto px-4 py-6">
        <div className="mx-auto w-full max-w-3xl">
          {back}
          <PageHeader
            icon={<LuBot />}
            media={<OrbStudio agent={agent.id} orb={agent.orb} voice={agent.voice} onSaved={() => void onChanged()} />}
            title={
              renaming === "agent" ? (
                <TitleInput value={agent.name} label={t("Agent name")} className="w-full" onCommit={renameAgent} onCancel={() => setRenaming(null)} />
              ) : (
                <span className="inline-flex min-w-0 items-center gap-1">
                  <span className="truncate">{agent.name}</span>
                  <button
                    onClick={() => setRenaming("agent")}
                    title={t("Rename")}
                    aria-label={t("Rename {name}", { name: agent.name })}
                    className="rounded p-1 text-fg-subtle transition hover:text-accent"
                  >
                    <LuPencil className="h-3.5 w-3.5" />
                  </button>
                  {!agent.first && (
                    <button
                      onClick={() => setDeleting(true)}
                      title={t("Delete agent")}
                      aria-label={t("Delete {name}", { name: agent.name })}
                      className="rounded p-1 text-fg-subtle transition hover:text-danger"
                    >
                      <LuTrash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </span>
              )
            }
            description={
              <>
                {t("Conversations that reached the agent through a channel. Each chat gets its own session, so a group and a DM never share a memory.")}
              </>
            }
            action={
              <button
                onClick={async () => {
                  setStarting(true);
                  setError("");
                  try {
                    onSelect((await api.startAgentChat(agent.id)).id);
                  } catch (e) {
                    setError((e as Error).message);
                  } finally {
                    setStarting(false);
                  }
                }}
                disabled={starting}
                className={primarySmCls}
              >
                {starting ? (
                  <LuRefreshCw className="h-4 w-4 animate-spin" />
                ) : (
                  <LuPlus className="h-4 w-4" />
                )}
                {t("New conversation")}
              </button>
            }
          >
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <Stat value={sessions.length} label={tp(sessions.length, "conversation", "conversations")} />
              <Stat value={sessions.filter((s) => s.status === "running").length} label={t("running")} tone="text-accent" />
              <div className="flex min-w-0 items-center gap-1.5 rounded-lg bg-raised/60 px-2.5 py-1">
                <LuFolder className="h-3 w-3 shrink-0 text-fg-faint" />
                <span className="truncate font-mono text-[11px] text-fg-subtle">{agent.home}</span>
              </div>
              <div className="flex min-w-0 items-center gap-1.5 rounded-lg bg-raised/60 px-2.5 py-1" title={t("The user it runs as when the sandbox is on")}>
                <LuUser className="h-3 w-3 shrink-0 text-fg-faint" />
                <span className="truncate font-mono text-[11px] text-fg-subtle">{agent.sandboxUser}</span>
              </div>
            </div>
          </PageHeader>

          {kept.length > 0 && (setup || setupFailed) && (
            <div role="status" className="mt-4 flex items-start gap-2 rounded-lg bg-warn/10 px-3 py-2 text-sm text-warn">
              <span className="min-w-0 flex-1">
                {edits.length > 0 &&
                  tp(
                    edits.length,
                    "This agent's folder already had {files}, so what you answered was not written to it. Edit it under Files.",
                    "This agent's folder already had {files}, so what you answered was not written to them. Edit them under Files.",
                    { files: edits.join(", ") },
                  )}
                {edits.length > 0 && links.length > 0 && " "}
                {links.length > 0 &&
                  tp(
                    links.length,
                    "This agent's folder already had {files} as a link, so what you answered was not written to it. It is left as it is.",
                    "This agent's folder already had {files} as links, so what you answered was not written to them. They are left as they are.",
                    { files: links.join(", ") },
                  )}
              </span>
              <button type="button" onClick={() => onKept([])} aria-label={t("Dismiss")} title={t("Dismiss")} className="shrink-0 rounded p-0.5 hover:bg-warn/10">
                <LuX aria-hidden className="h-4 w-4" />
              </button>
            </div>
          )}

          <AgentTabs tab={tab} onTab={setTab} unread={agent.unread} />

          {error && <ErrorBanner className="mt-4" onClose={() => setError("")}>{error}</ErrorBanner>}

          {tab === "activity" && <ActivityFeed agent={agent} onChanged={onChanged} onSelect={onSelect} />}
          {tab === "heartbeat" && <HeartbeatSettings agent={agent} onChanged={onChanged} />}
          {tab === "tools" && <AgentTools agent={agent.id} />}
          {tab === "skills" && <AgentSkills agent={agent} />}
          {tab === "files" && setup?.initialised && <AgentFiles agent={agent.id} setup={setup} onSaved={setSetup} />}
          {tab === "files" && !setup && setupFailed && (
            <div className="mt-4">
              <LoadFailed error={setupFailed} onRetry={readSetup} />
            </div>
          )}

          {tab === "conversations" && (
          <>
          {loadError && listRead.current && (
            <div className="mt-4 rounded-lg bg-warn/10 px-3 py-2 text-sm text-warn">
              {t("Could not refresh the conversations — what is shown may be out of date.")} {loadError}
            </div>
          )}
          {loading ? (
            <RowsSkeleton />
          ) : loadError && !listRead.current ? (
            <div className="mt-4">
              <LoadFailed error={loadError} onRetry={load} />
            </div>
          ) : sessions.length === 0 ? (
            <div className="mt-4 rounded-xl border border-dashed border-line px-4 py-10 text-center">
              <p className="text-sm text-fg-muted">{t("Nothing has reached the agent yet.")}</p>
              <p className="mx-auto mt-2 max-w-md text-xs text-fg-faint">
                {t("Start one here, or message a channel — a Telegram chat, a webhook — and it appears in this list. They all reach the same agent and share its memory.")}
              </p>
            </div>
          ) : (
            <div className="mt-5 space-y-5">
              {groups.map(([id, group]) => (
                <section key={id}>
                  <div className="flex items-center gap-2 px-1">
                    {id === BROWSER ? (
                      <LuMonitor className="h-3.5 w-3.5 shrink-0 text-fg-faint" />
                    ) : (
                      <LuRadio className="h-3.5 w-3.5 shrink-0 text-fg-faint" />
                    )}
                    <h3 className="truncate text-xs font-medium text-fg-muted">{id === BROWSER ? t("Here, in the portal") : group.name || t("No channel")}</h3>
                    {group.kind && id !== BROWSER && (
                      <span className="shrink-0 rounded bg-fg/5 px-1.5 py-0.5 text-[10px] text-fg-subtle">
                        {group.kind}
                      </span>
                    )}
                    {!group.present && (
                      <span
                        className="shrink-0 rounded bg-warn/10 px-1.5 py-0.5 text-[10px] text-warn/90"
                        title={t("Recreate a channel with the slug \"{slug}\" to reconnect these", { slug: id })}
                      >
                        {t("no channel")}
                      </span>
                    )}
                    <span className="ml-auto shrink-0 text-[11px] text-fg-faint">
                      {group.items.length}
                    </span>
                  </div>

                  <ul className="stagger-in mt-1.5 space-y-1">
                    {group.items.map((s) => (
                      <li key={s.id} className="group relative">
                        {renaming === s.id ? (
                          // Not a button while the name is being typed: an input
                          // inside one cannot be focused reliably, and a click in
                          // the field must not open the conversation.
                          <div className={ROW}>
                            <RowBody
                              s={s}
                              title={
                                <TitleInput
                                  value={s.title}
                                  label={t("Conversation name")}
                                  className="w-full text-sm"
                                  onCommit={(next) => rename(s, next)}
                                  onCancel={() => setRenaming(null)}
                                />
                              }
                            />
                          </div>
                        ) : (
                          <>
                            <button onClick={() => onSelect(s.id)} className={`${ROW} hover:bg-fg/5`}>
                              <RowBody
                                s={s}
                                title={<p className="truncate text-sm text-fg">{s.title}</p>}
                              />
                            </button>
                            {/* Over the timestamp rather than beside it: the row is
                                a button, and one button cannot hold another. */}
                            <div className="absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-0.5 opacity-0 transition focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100">
                              <button
                                onClick={() => setRenaming(s.id)}
                                title={t("Rename")}
                                aria-label={t("Rename {name}", { name: s.title })}
                                className="rounded p-1.5 text-fg-subtle transition hover:text-accent"
                              >
                                <LuPencil className="h-3.5 w-3.5" />
                              </button>
                              <button
                                onClick={() => remove(s)}
                                title={t("Delete conversation")}
                                aria-label={t("Delete {name}", { name: s.title })}
                                className="rounded p-1.5 text-fg-subtle transition hover:text-danger"
                              >
                                <LuTrash2 className="h-3.5 w-3.5" />
                              </button>
                            </div>
                          </>
                        )}
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          )}
          </>
          )}
        </div>
      </div>
      {deleting && <DeleteAgent agent={agent} onClose={() => setDeleting(false)} onDeleted={onDeleted} />}
    </div>
  );
}

const AGENT_TABS = [
  ["conversations", msg("Conversations")],
  ["activity", msg("Activity")],
  ["heartbeat", msg("Heartbeat")],
  ["tools", msg("Tools")],
  ["skills", msg("Skills")],
  ["files", msg("Files")],
] as const;
type AgentTab = (typeof AGENT_TABS)[number][0];

/** The tabs under an agent's header; Activity counts what is unread. */
function AgentTabs({ tab, onTab, unread }: { tab: AgentTab; onTab: (id: AgentTab) => void; unread: number }) {
  return (
    <div role="tablist" aria-label={t("Agent sections")} onKeyDown={tabKeys} className="mt-5 flex gap-1 overflow-x-auto overflow-y-hidden border-b border-line">
      {AGENT_TABS.map(([id, label]) => (
        <button
          key={id}
          role="tab"
          type="button"
          aria-selected={tab === id}
          tabIndex={tab === id ? 0 : -1}
          onClick={() => onTab(id)}
          className={`-mb-px inline-flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2 text-sm transition ${
            tab === id ? "border-accent text-fg" : "border-transparent text-fg-muted hover:text-fg"
          }`}
        >
          {t(label)}
          {id === "activity" && unread > 0 && <span className="rounded-full bg-accent/15 px-1.5 text-[11px] text-accent">{unread}</span>}
        </button>
      ))}
    </div>
  );
}

/**
 * Deleting an agent: its chats go with it, and its folder — SOUL.md, its
 * memory, anything it kept there — only if that is chosen. Kept, the folder is
 * taken up again by an agent made under the same name.
 */
function DeleteAgent({ agent, onClose, onDeleted }: { agent: Agent; onClose: () => void; onDeleted: () => Promise<void> }) {
  const [folder, setFolder] = useState<"keep" | "delete">("keep");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const bound = agent.channels.length > 0;

  const remove = async () => {
    setBusy(true);
    setError("");
    try {
      await api.deleteAgent(agent.id, folder);
      onClose();
      await onDeleted();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  const choice = (value: "keep" | "delete", title: string, detail: string) => (
    <label
      className={`flex cursor-pointer items-start gap-3 rounded-xl border px-3 py-2.5 transition ${
        folder === value ? (value === "delete" ? "border-danger/40 bg-danger/5" : "border-accent/40 bg-accent/5") : "border-line hover:bg-fg/5"
      }`}
    >
      <input type="radio" name="agent-folder" checked={folder === value} onChange={() => setFolder(value)} className="mt-1" />
      <span className="min-w-0">
        <span className="block text-sm text-fg">{title}</span>
        <span className="block text-xs text-fg-muted">{detail}</span>
      </span>
    </label>
  );

  return (
    <Modal
      title={t("Delete \"{name}\"?", { name: agent.name })}
      onClose={onClose}
      footer={
        <div className="flex items-center justify-end gap-2">
          {error && <p role="alert" className="mr-auto text-xs text-danger">{error}</p>}
          <button onClick={onClose} className="rounded-lg px-3 py-1.5 text-sm text-fg-muted hover:bg-fg/5">
            {t("Cancel")}
          </button>
          <button
            onClick={remove}
            disabled={busy || bound}
            className="rounded-lg bg-danger/15 px-3 py-1.5 text-sm text-danger ring-1 ring-inset ring-danger/30 hover:bg-danger/25 disabled:opacity-40"
          >
            {busy ? t("Deleting…") : t("Delete agent")}
          </button>
        </div>
      }
    >
      {bound ? (
        <p role="alert" className="text-sm text-warn">
          {t("{channels} talks as this agent. Give it another agent under Settings → Channels first.", { channels: agent.channels.map((c) => c.name).join(", ") })}
        </p>
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-fg-muted">
            {tp(agent.chats, "Its one chat is stopped and deleted with it.", "Its {n} chats are stopped and deleted with it.")}{" "}
            {t("The background jobs running in its folder, a dev server for example, are stopped too, whichever you choose below.")}
          </p>
          {choice("keep", t("Keep its folder"), t("Its files and memory stay in {home}. An agent made under the same name picks them up again.", { home: agent.home }))}
          {choice("delete", t("Delete its folder too"), t("Everything in {home} is removed, its memory and its routines with it. This cannot be undone.", { home: agent.home }))}
        </div>
      )}
    </Modal>
  );
}

const ROW =
  "flex w-full items-center gap-3 rounded-xl border border-line bg-raised/40 px-3 py-2.5 text-left transition";

/** What a conversation row shows, whether or not its name is being edited. */
function RowBody({ s, title }: { s: AgentSession; title: ReactNode }) {
  return (
    <>
      <StatusDot status={s.status} />
      <div className="min-w-0 flex-1">
        {title}
        <p className="truncate font-mono text-[10px] text-fg-faint">{s.channel_key}</p>
      </div>
      <LuMessageSquare className="h-3.5 w-3.5 shrink-0 text-fg-faint" />
      <span className="shrink-0 text-[11px] text-fg-faint group-hover:invisible group-focus-within:invisible [@media(hover:none)]:hidden">
        {when(s.updated_at)}
      </span>
    </>
  );
}

/** What a WATCH.md might say, shown in an empty one: the markdown stays, the words are the reader's. */
const watchExample = () =>
  [
    `# ${t("What to keep an eye on")}`,
    "",
    `- ${t("The open pull requests on the project: tell me about one waiting more than three days.")}`,
    `- ${t("The notes in ~/inbox: anything that needs an answer this week.")}`,
    "",
    t("Only tell me what needs me. Stay quiet otherwise."),
  ].join("\n");

/** The files that define the agent, editable in place. */
function AgentFiles({ agent, setup, onSaved }: { agent: string; setup: Setup; onSaved: (s: Setup) => void }) {
  const [open, setOpen] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, flashSaved] = useFlash();
  // When the file was read: the agent writes these files too (MEMORY.md above all), and a save from an older copy must not replace what it wrote since.
  const [readAt, setReadAt] = useState(0);
  const [changed, setChanged] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const file = setup.files.find((f) => f.name === open);
  // Understory holds the memory: the file stays, and is not read.
  const unread = (name: string) => name === "MEMORY.md" && setup.memory === "understory";

  const show = (f: Setup["files"][number]) => {
    setOpen(f.name);
    setDraft(f.content);
    setReadAt(f.mtime);
    setChanged(false);
    setError(null);
  };

  const save = async (overwrite = false) => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const next = await api.saveAgentFile(agent, file.name, draft, overwrite ? undefined : readAt);
      onSaved(next);
      setReadAt(next.files.find((f) => f.name === file.name)?.mtime ?? 0);
      setChanged(false);
      flashSaved();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) setChanged(true);
      else setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const loadNew = async () => {
    if (!file) return;
    try {
      const next = await api.agentSetup(agent);
      onSaved(next);
      const fresh = next.files.find((f) => f.name === file.name);
      if (fresh) show(fresh);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <section className="mt-5">
      <div className="flex flex-wrap items-center gap-1.5">
        {setup.files.map((f) => (
          <button
            key={f.name}
            aria-pressed={open === f.name}
            onClick={() => {
              if (open === f.name) setOpen(null);
              else show(f);
            }}
            className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs transition ${
              open === f.name
                ? "bg-accent/12 text-accent ring-1 ring-inset ring-accent/25"
                : "bg-fg/5 text-fg-muted hover:bg-fg/10"
            }`}
          >
            <LuFileText className="h-3.5 w-3.5" />
            <span className={unread(f.name) ? "line-through decoration-fg-faint" : ""}>{f.name}</span>
          </button>
        ))}
        <span className="ml-auto text-[11px] text-fg-faint">
          {t("loaded as context when a conversation starts")}
        </span>
      </div>

      {file && (
        <div className="mt-2">
          {file.name === "WATCH.md" && (
            <p role="note" className="mb-2 text-xs text-fg-muted">
              {t("Not context: what its heartbeat keeps an eye on. Say what to look at and what counts as worth telling you.")}
            </p>
          )}
          {unread(file.name) && (
            <p role="note" className="mb-2 text-xs text-fg-muted">
              {t("Not read while Understory is the agent's memory (Settings → Add-ons → Memory). It is kept, and read again once Understory is switched off.")}
            </p>
          )}
          {file.link ? (
            <p role="note" className="rounded-lg bg-fg/5 px-3 py-2 text-xs text-fg-muted">
              {t("This file is a link, so it is left alone: it is not shown or written here.")}
            </p>
          ) : (
          <>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            aria-label={file.name}
            rows={14}
            spellCheck={false}
            placeholder={file.name === "WATCH.md" ? watchExample() : undefined}
            className="w-full resize-y rounded-lg border border-line bg-raised/60 px-3 py-2 font-mono text-xs leading-relaxed outline-none focus:border-accent/60"
          />
          {changed && (
            <div role="alert" className="mt-2 flex flex-wrap items-center gap-2 rounded-lg bg-warn/10 px-3 py-1.5 text-xs text-warn">
              <span className="min-w-0 flex-1">{t("This file changed after you opened it.")}</span>
              <button onClick={() => void loadNew()} className="rounded px-1.5 py-0.5 underline hover:text-fg">
                {t("Load the new version")}
              </button>
              <button onClick={() => void save(true)} className="rounded px-1.5 py-0.5 underline hover:text-fg">
                {t("Save mine anyway")}
              </button>
            </div>
          )}
          {error && (
            <p role="alert" className="mt-2 text-xs text-danger">
              {error}
            </p>
          )}
          <button
            onClick={() => void save()}
            disabled={busy || draft === file.content}
            className="mt-2 inline-flex items-center gap-1.5 rounded-lg bg-fg/5 px-3 py-2 text-sm text-fg transition hover:bg-fg/10 disabled:opacity-40"
          >
            {busy ? (
              <LuRefreshCw className="h-4 w-4 animate-spin" />
            ) : saved ? (
              <LuCheck className="h-4 w-4" />
            ) : null}
            {saved ? t("Saved") : t("Save")}
          </button>
          </>
          )}
        </div>
      )}
    </section>
  );
}

/**
 * The agent's own tool switches: exceptions to the portal-wide default for every
 * chat in its home and every run it does on its own. Saved as each switch is
 * flipped, as a project's are.
 */
function AgentTools({ agent }: { agent: string }) {
  return (
    <section className="mt-4 rounded-xl border border-line bg-surface">
      <p className="border-b border-line px-3 py-2 text-xs text-fg-subtle">
        {t("What this agent's chats and its own runs — its heartbeat, the routines that run in its home — start with, against Settings → Tools. A project and a routine can switch tools again for their own, and a chat for itself.")}
      </p>
      <ToolSwitches agent={agent} />
    </section>
  );
}
