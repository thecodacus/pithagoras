import { useCallback, useEffect, useRef, useState } from "react";
import { LuBlocks, LuBot, LuFileText, LuFolderGit2, LuFolderKanban, LuPlus, LuTrash2 } from "react-icons/lu";
import { PageHeader } from "./PageHeader";
import { RowsSkeleton } from "./Skeleton";
import { api, ApiError, type Project, type ProjectAgent, type ProjectContents, type Session } from "../api";
import { useCached } from "../settings-cache";
import { deleteAsking, unsavedNotes } from "../unsaved";
import { bytesLabel, slugify } from "../projects";
import { within } from "../paths";
import { when } from "../time";
import { confirmDialog } from "./ConfirmDialog";
import { Modal } from "./Modal";
import { Select } from "./Select";
import { Field, LoadFailed, SwitchRow, inputCls, primarySmCls } from "./SettingsUi";
import { ToolSwitches } from "./ToolSwitches";
import { isEnter } from "../shortcuts";
import { t, tp, tx } from "../i18n";
import { splitSubChats } from "../sub-chats";

/**
 * The folders chats work in.
 *
 * Projects are folders made on purpose, each with instructions of its own that
 * end up as the folder's AGENTS.md, and tools of its own: which of them its
 * chats start with, and optionally an agent of its own: one with an agent carries
 * its soul, user and memory into the project's chats, one without is a blank
 * slate with only the instructions. Opening one opens its latest chat, or starts one. Home,
 * where "New" starts a chat unless another agent is picked for it, is not a project and is not listed.
 */
export function ProjectsPage({
  sessions,
  onOpenChat,
  onNewChat,
  onChanged,
}: {
  sessions: Session[];
  onOpenChat: (id: string) => void;
  /** Starts a chat in the folder and opens it. */
  onNewChat: (workspace: string) => Promise<void>;
  /** After something the chat list depends on changed, such as a project's chats going. */
  onChanged: () => void;
}) {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [root, setRoot] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Project | null>(null);
  const [toolsOf, setToolsOf] = useState<Project | null>(null);
  const [agentOf, setAgentOf] = useState<Project | null>(null);
  /** The agents a project can work with, from the same read as the list. */
  const [agents, setAgents] = useState<AgentOption[]>([]);

  /** Why the first read failed: until there is a list, that is said where the list would be. */
  const [failed, setFailed] = useState<string | null>(null);
  const had = useRef(false);

  const load = useCallback(
    () =>
      api
        .projects()
        .then((r) => {
          had.current = true;
          setFailed(null);
          setProjects(r.projects);
          setAgents((r.agents ?? []).map((a) => ({ id: a.id, name: a.name })));
          setRoot(r.root);
        })
        .catch((e) => (had.current ? setError((e as Error).message) : setFailed((e as Error).message))),
    [],
  );
  // Also when the chats change: the counts and the "last active" are theirs.
  // The list is a new array on every poll, and a running chat changes its
  // timestamp on every one. What the server counts is only which chats there
  // are and where, so that is what is compared; "last active" is worked out
  // here from the list itself.
  const chats = sessions.map((s) => `${s.id}:${s.workspace}`).join("|");
  useEffect(() => {
    void load();
  }, [load, chats]);

  const attempt = async (fn: () => Promise<void>) => {
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  /** The project's newest chat, counting ones started in a subfolder: a chat of its own, not a sub-chat (see sub-chats.ts). */
  const latestChat = (p: Project) =>
    splitSubChats(sessions)
      .top.filter((s) => within(p.path, s.workspace))
      .reduce<Session | null>((best, s) => (!best || s.updated_at > best.updated_at ? s : best), null);

  const lastActive = (p: Project) => latestChat(p)?.updated_at ?? p.lastActive;

  const open = (p: Project) =>
    attempt(async () => {
      const latest = latestChat(p);
      if (latest) onOpenChat(latest.id);
      else await onNewChat(p.path);
    });

  const remove = (p: Project) =>
    attempt(async () => {
      const contents = await api.projectContents(p.name);
      const gone = await deleteAsking(
        contents.unsaved,
        (unsaved) => askToRemove(p, { ...contents, unsaved }),
        (discard) => api.deleteProject(p.name, discard),
      );
      if (!gone) return;
      onChanged();
      load();
    });

  /** Whether to delete, and whether unsaved work goes with it: null for "no". */
  const askToRemove = async (p: Project, contents: ProjectContents): Promise<boolean | null> => {
    const parts = [
      contents.sessions ? tp(contents.sessions, "{n} chat", "{n} chats") : "",
      contents.files
        ? contents.complete
          ? tp(contents.files, "{n} file ({size}) in its folder", "{n} files ({size}) in its folder", { size: bytesLabel(contents.bytes) })
          : tp(contents.files, "over {n} file ({size}) in its folder", "over {n} files ({size}) in its folder", { size: bytesLabel(contents.bytes) })
        : "",
    ].filter(Boolean);
    const routines = contents.routines ?? [];
    // They stay, with their history, but have nowhere left to run.
    const names = routines.map((r) => `"${r}"`).join(", ");
    const stranded =
      routines.length === 0
        ? ""
        : routines.length === 1
          ? ` ${t("The routine {names} runs here: it is switched off until it is given another place, and keeps its history.", { names })}`
          : ` ${t("The routines {names} run here: they are switched off until they are given another place, and keep their history.", { names })}`;
    const going = parts.length === 2
      ? t("{first} and {second} go with it.", { first: parts[0], second: parts[1] })
      : parts.length === 1
        // The verb agrees with what goes: "1 chat goes", "3 chats go", "over 1,000 files go".
        ? tp(contents.sessions || (contents.complete ? contents.files : Math.max(2, contents.files)), "{what} goes with it.", "{what} go with it.", { what: parts[0] })
        : t("It is empty.");
    // A repository's own history, changes and stashes are in the folder and nowhere else.
    const { lost, risky, sentences: git } = unsavedNotes(contents.unsaved);
    const ok = await confirmDialog({
      title: lost
        ? t("Delete the project \"{name}\" and its unsaved work?", { name: p.name })
        : t("Delete the project \"{name}\"?", { name: p.name }),
      // The jobs go whether or not there are any: how many is not asked, and what is running is not the chats' alone.
      message: [...git, going, t("The background jobs running in its folder, a dev server for example, are stopped too."), t("This cannot be undone.")].join(" ") + stranded,
      confirmLabel: risky ? t("Delete anyway") : t("Delete project"),
      danger: true,
      // Asked whatever Settings says: the server refuses without it, and what is lost has no copy.
      deletes: !risky,
    });
    return ok ? risky : null;
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-y-auto px-4 py-6">
        <div className="mx-auto w-full max-w-3xl">
          <PageHeader
            icon={<LuFolderKanban />}
            title={t("Projects")}
            description={
              <>
                {t("New starts chats in Home, or with the agent you picked for it. A project is a folder of its own with instructions for the agent — saved as its AGENTS.md — for work that should stay together.")}
              </>
            }
            action={
              <button
                onClick={() => setCreating(true)}
                className={primarySmCls}
              >
                <LuPlus className="h-4 w-4" /> {t("New project")}
              </button>
            }
          />

          {error && <p role="alert" className="mt-3 rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger">{error}</p>}

          {projects === null ? (
            failed ? (
              <div className="mt-4">
                <LoadFailed error={failed} onRetry={load} />
              </div>
            ) : (
              <RowsSkeleton />
            )
          ) : (
            <ul className="stagger-in mt-4 space-y-1">
              {projects.length === 0 && (
                <li className="py-12 text-center text-sm text-fg-subtle">
                  {t("No projects yet. New starts chats in Home, or with the agent you picked for it; make a project for work that should stay together.")}
                </li>
              )}
              {projects.map((p) => (
                <li
                  key={p.path}
                  onClick={() => open(p)}
                  className="group flex cursor-pointer items-center gap-3 rounded-xl border border-line bg-raised/40 px-3 py-2.5 transition hover:bg-fg/5"
                >
                  <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-canvas text-fg-muted">
                    {p.isGit ? <LuFolderGit2 className="h-4 w-4" /> : <LuFolderKanban className="h-4 w-4" />}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <p className="truncate text-sm text-fg">{p.name}</p>
                      {p.hasInstructions && (
                        <span className="rounded bg-accent/10 px-1.5 py-0.5 text-[10px] text-accent">{t("instructions")}</span>
                      )}
                      {p.agent && agents.some((a) => a.id === p.agent) && (
                        <span className="rounded bg-accent/10 px-1.5 py-0.5 text-[10px] text-accent" title={t("Chats here start with the SOUL.md, PrimaryUser.md and memory of {agent}", { agent: agents.find((a) => a.id === p.agent)!.name })}>
                          {t("with {agent}", { agent: agents.find((a) => a.id === p.agent)!.name })}
                        </span>
                      )}
                      {p.hasTools && (
                        <span className="rounded bg-accent/10 px-1.5 py-0.5 text-[10px] text-accent" title={t("Switches tools differently from the portal-wide default")}>
                          {t("tools")}
                        </span>
                      )}
                    </div>
                    <p className="truncate text-[11px] text-fg-faint">
                      {tp(p.sessions, "{n} chat", "{n} chats")}
                      {lastActive(p) ? ` · ${t("last {when}", { when: when(lastActive(p)!) })}` : ""}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        attempt(() => onNewChat(p.path));
                      }}
                      className="rounded p-1.5 text-fg-subtle hover:text-accent"
                      title={t("New chat here")}
                      aria-label={t("New chat in {name}", { name: p.name })}
                    >
                      <LuPlus className="h-3.5 w-3.5" />
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setEditing(p);
                      }}
                      className="rounded p-1.5 text-fg-subtle hover:text-accent"
                      title={t("Instructions (AGENTS.md)")}
                      aria-label={t("Instructions for {name}", { name: p.name })}
                    >
                      <LuFileText className="h-3.5 w-3.5" />
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setAgentOf(p);
                      }}
                      className="rounded p-1.5 text-fg-subtle hover:text-accent"
                      title={t("Agent and memory for this project's chats")}
                      aria-label={t("Agent for {name}", { name: p.name })}
                    >
                      <LuBot className="h-3.5 w-3.5" />
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setToolsOf(p);
                      }}
                      className="rounded p-1.5 text-fg-subtle hover:text-accent"
                      title={t("Tools for this project's chats")}
                      aria-label={t("Tools for {name}", { name: p.name })}
                    >
                      <LuBlocks className="h-3.5 w-3.5" />
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        remove(p);
                      }}
                      className="rounded p-1.5 text-fg-subtle hover:text-danger"
                      title={t("Delete project")}
                      aria-label={t("Delete {name}", { name: p.name })}
                    >
                      <LuTrash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {creating && (
        <NewProject
          root={root}
          agents={agents}
          onClose={() => setCreating(false)}
          onCreate={async (name, instructions, toolsOff, link) => {
            const project = await api.createProject(name, instructions, toolsOff, link);
            setCreating(false);
            load();
            // The chats' folders have one more, even if its chat does not open.
            onChanged();
            // The project is there, without the tools that were chosen. Said on the
            // page, which stays: opening its chat would take the message away, and
            // the Tools button on its row is where to choose them again.
            if (project.toolsError) {
              setError(t("\"{name}\" was created, but its tools could not be set: {error}", { name: project.name, error: project.toolsError }));
              return;
            }
            // The dialog is gone by now, so a failure here is shown on the page:
            // the project exists, only its first chat did not open.
            try {
              await onNewChat(project.path);
            } catch (e) {
              setError(t("\"{name}\" was created, but its chat did not open: {error}", { name: project.name, error: (e as Error).message }));
            }
          }}
        />
      )}
      {editing && (
        <Instructions
          project={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            load();
          }}
        />
      )}
      {agentOf && (
        <ProjectAgentChoice
          project={agentOf}
          agents={agents}
          onClose={() => {
            setAgentOf(null);
            // The "with" mark on the row, and the sidebar's, are what was chosen here.
            load();
            onChanged();
          }}
        />
      )}
      {toolsOf && (
        <ProjectTools
          project={toolsOf}
          onClose={() => {
            setToolsOf(null);
            // The "tools" mark on the row is what these switches decided.
            load();
          }}
        />
      )}
    </div>
  );
}

function NewProject({
  root,
  agents,
  onClose,
  onCreate,
}: {
  /** Where the folder will be made, so the preview is the whole path. */
  root: string;
  agents: AgentOption[];
  onClose: () => void;
  onCreate: (name: string, instructions: string, toolsOff?: string[], link?: { agent?: string; memory?: boolean }) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [instructions, setInstructions] = useState("");
  /** The agent it works with: "" for a blank slate, which is what a project was before there was a choice. */
  const [agent, setAgent] = useState("");
  const [memory, setMemory] = useState(true);
  const features = useCached("feature-flags", api.featureFlags, { freshMs: 30_000 });
  /** The tools wanted off, once somebody has switched any; untouched, the project says nothing about tools. */
  const [toolsOff, setToolsOff] = useState<string[] | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const slug = slugify(name);

  const submit = async () => {
    if (!slug || busy) return;
    setBusy(true);
    setError(null);
    try {
      // Only what was chosen: a project made with the defaults says nothing of an agent or of its memory.
      await onCreate(name.trim(), instructions, toolsOff, { ...(agent ? { agent } : {}), ...(memory ? {} : { memory: false }) });
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <Modal
      title={t("New project")}
      subtitle={t("A folder of its own, with instructions the agent follows in it")}
      onClose={onClose}
      unsaved={!busy && (!!name.trim() || !!instructions.trim() || toolsOff !== undefined || !!agent || !memory)}
      footer={
        <div className="flex items-center justify-end gap-2">
          {error && <p role="alert" className="mr-auto text-xs text-danger">{error}</p>}
          <button onClick={onClose} className="rounded-lg px-3 py-1.5 text-sm text-fg-muted hover:bg-fg/5">
            {t("Cancel")}
          </button>
          <button
            onClick={submit}
            disabled={!slug || busy}
            className={primarySmCls}
          >
            {busy ? t("Creating…") : t("Create and open")}
          </button>
        </div>
      }
    >
      <label className="block text-xs text-fg-muted">
        {t("Name")}
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => isEnter(e) && submit()}
          placeholder={t("Cool Project")}
          className={`${inputCls} mt-1`}
        />
      </label>
      {name.trim() && (
        <p className="mt-1 truncate font-mono text-[11px] text-fg-subtle">
          {slug ? `→ ${root ? `${root}/` : ""}${slug}` : t("needs at least one letter or digit")}
        </p>
      )}
      <label className="mt-4 block text-xs text-fg-muted">
        {t("Instructions")} <span className="text-fg-faint">{t("(optional — saved as AGENTS.md)")}</span>
        <textarea
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          rows={8}
          placeholder={t("What this project is, and how the agent should work in it.")}
          className={`${inputCls} mt-1 resize-y font-mono text-xs`}
        />
      </label>
      <div className="mt-4">
        <AgentChoice
          agents={agents}
          agent={agent}
          onAgent={setAgent}
          memory={memory}
          onMemory={setMemory}
          holder={features.value?.memory.by ?? null}
        />
      </div>
      {/* Shut, like the sections of the voice settings: most projects start with
          the default, and sixty checkboxes would push the dialog off the screen.
          Mounted all the same, so what was loaded and switched is kept. */}
      <details className="mt-4 rounded-xl border border-line p-4">
        <summary className="cursor-pointer text-sm font-medium">
          {t("Tools")}
          <span className="mt-1 block text-xs font-normal text-fg-muted">{t("What chats in this project start with — a chat can still switch tools for itself")}</span>
        </summary>
        <div className="mt-4">
          <ToolSwitches onDraft={setToolsOff} />
        </div>
      </details>
    </Modal>
  );
}

/** An agent a project can work with. */
type AgentOption = { id: string; name: string };

/**
 * Who a project's chats are with: an agent, whose soul, user and memory go into
 * them beside the project's own instructions, or nobody, a blank slate with
 * only the instructions. And, where an extension holds the agent's memory,
 * whether it is the project's memory: without it the agent's MEMORY.md is read
 * instead.
 */
function AgentChoice({
  agents,
  agent,
  onAgent,
  memory,
  onMemory,
  holder,
  disabled,
}: {
  agents: AgentOption[];
  /** The agent's id, "" for none. */
  agent: string;
  onAgent: (id: string) => void;
  memory: boolean;
  onMemory: (on: boolean) => void;
  /** What holds the agent's memory, by its label; null where nothing does. */
  holder: string | null;
  disabled?: boolean;
}) {
  return (
    <div className="space-y-3">
      <Field
        label={t("Agent")}
        hint={
          agent
            ? t("Its SOUL.md, PrimaryUser.md and memory go into this project's chats, next to the instructions. Its skills, voice and avatar are used too.")
            : t("A blank slate: the chats have only the instructions, none of an agent's SOUL.md, PrimaryUser.md or memory.")
        }
      >
        <Select
          aria-label={t("Agent")}
          value={agent}
          onChange={onAgent}
          disabled={disabled}
          options={[{ value: "", label: t("None — a blank slate") }, ...agents.map((a) => ({ value: a.id, label: a.name, text: a.name }))]}
        />
      </Field>
      {/* A blank slate has no agent whose memory it would be: it never has the holder's, so there is nothing to switch. */}
      {holder && agent && (
        <SwitchRow
          title={t("{by} as memory", { by: holder })}
          detail={t("Off: the chats do not get the memory instructions of {by}, and the agent's MEMORY.md is read instead.", { by: holder })}
          on={memory}
          onChange={onMemory}
          disabled={disabled}
        />
      )}
    </div>
  );
}

function Instructions({
  project,
  onClose,
  onSaved,
}: {
  project: Project;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [text, setText] = useState<string | null>(null);
  const [saved, setSaved] = useState("");
  // When the file was read: the agent writes AGENTS.md too, and a save from an older copy must not replace what it wrote since.
  const [readAt, setReadAt] = useState(0);
  const [changed, setChanged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    return api
      .projectInstructions(project.name)
      .then((r) => {
        setText(r.text);
        setSaved(r.text);
        setReadAt(r.mtime);
        setChanged(false);
        setError(null);
      })
      .catch((e) => setError((e as Error).message));
  }, [project.name]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (overwrite = false) => {
    if (text === null || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.setProjectInstructions(project.name, text, overwrite ? undefined : readAt);
      onSaved();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) setChanged(true);
      else setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <Modal
      title={t("Instructions · {name}", { name: project.name })}
      subtitle={t("Saved as AGENTS.md in the folder — edit it there too if you like")}
      onClose={onClose}
      unsaved={text !== null && text !== saved && !busy}
      footer={
        <div className="flex items-center justify-end gap-2">
          {error && <p role="alert" className="mr-auto text-xs text-danger">{error}</p>}
          <button onClick={onClose} className="rounded-lg px-3 py-1.5 text-sm text-fg-muted hover:bg-fg/5">
            {t("Cancel")}
          </button>
          <button
            onClick={() => void save()}
            disabled={text === null || text === saved || busy}
            className={primarySmCls}
          >
            {busy ? t("Saving…") : t("Save")}
          </button>
        </div>
      }
    >
      {text === null ? (
        <p className="py-8 text-center text-sm text-fg-subtle">{error ? "" : t("Loading…")}</p>
      ) : (
        <>
          {changed && (
            <div role="alert" className="mb-2 flex flex-wrap items-center gap-2 rounded-lg bg-warn/10 px-3 py-1.5 text-xs text-warn">
              <span className="min-w-0 flex-1">{t("This file changed after you opened it.")}</span>
              <button onClick={() => void load()} className="rounded px-1.5 py-0.5 underline hover:text-fg">
                {t("Load the new version")}
              </button>
              <button onClick={() => void save(true)} className="rounded px-1.5 py-0.5 underline hover:text-fg">
                {t("Save mine anyway")}
              </button>
            </div>
          )}
          <textarea
            autoFocus
            aria-label={t("Project instructions")}
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={14}
            placeholder={t("What this project is, and how the agent should work in it.")}
            className={`${inputCls} resize-y font-mono text-xs`}
          />
          <p className="mt-2 text-[11px] text-fg-subtle">
            {tx("Chats started after saving pick this up. One already open does after {command}. Leave it empty to remove the file.", { command: <code>/reload</code> })}
          </p>
        </>
      )}
    </Modal>
  );
}

/**
 * Who the chats of a project are with. Saved as each choice is made, as the
 * tools are, so there is nothing to confirm and no button to save. A chat that
 * is open picks the change up after /reload.
 */
function ProjectAgentChoice({ project, agents, onClose }: { project: Project; agents: AgentOption[]; onClose: () => void }) {
  const [now, setNow] = useState<ProjectAgent | null>(null);
  // What holds the agent's memory is named by its label.
  const features = useCached("feature-flags", api.featureFlags, { freshMs: 30_000 });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api.projectAgent(project.name).then(
      (r) => live && setNow(r),
      (e) => live && setError((e as Error).message),
    );
    return () => {
      live = false;
    };
  }, [project.name]);

  const change = async (what: { agent?: string | null; memory?: boolean }) => {
    setError(null);
    try {
      setNow(await api.setProjectAgent(project.name, what));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <Modal
      title={t("Agent · {name}", { name: project.name })}
      subtitle={t("Whose SOUL.md, PrimaryUser.md and memory the chats in this project start with")}
      onClose={onClose}
    >
      {error && <p role="alert" className="mb-3 rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger">{error}</p>}
      {now === null ? (
        <p className="py-8 text-center text-sm text-fg-subtle">{error ? "" : t("Loading…")}</p>
      ) : (
        <>
          <AgentChoice
            agents={agents}
            agent={now.agent ?? ""}
            onAgent={(id) => void change({ agent: id || null })}
            memory={now.memory}
            onMemory={(on) => void change({ memory: on })}
            holder={now.memoryAvailable ? (features.value?.memory.by ?? null) : null}
          />
          <p className="mt-3 text-[11px] text-fg-subtle">
            {tx("Chats started after this pick it up. One already open does after {command}.", { command: <code>/reload</code> })}
          </p>
        </>
      )}
    </Modal>
  );
}

/**
 * Which tools the chats of a project start with. Saved as each switch is flipped,
 * as in a chat, so there is nothing to confirm and no button to save.
 */
function ProjectTools({ project, onClose }: { project: Project; onClose: () => void }) {
  return (
    <Modal
      title={t("Tools · {name}", { name: project.name })}
      subtitle={t("What chats in this project start with — a chat can still switch tools for itself")}
      onClose={onClose}
    >
      <ToolSwitches project={project.name} />
    </Modal>
  );
}
