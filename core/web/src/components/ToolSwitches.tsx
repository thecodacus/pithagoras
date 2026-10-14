import { useEffect, useState } from "react";
import { api, ApiError, type PortalTool } from "../api";
import { LoadFailed } from "./SettingsUi";
import { ToolGroupList } from "./ToolGroupList";
import { nextOff } from "../tool-groups";
import { t, tp } from "../i18n";

/**
 * Which tools this conversation may use.
 *
 * Whether it may reach for the web search, the todo list, the browser, or
 * anything else a package brought. Per conversation, because "look this up for
 * me" and "do not go online, just read the repo" are both reasonable in the
 * same week.
 *
 * Grouped by what installed them, because that is how somebody thinks about
 * it — "turn the web search one off" means four tools that arrived together.
 * An MCP server is a group of its own rather than a share of the adapter, for
 * the same reason: nobody thinks "the adapter", they think "the browser one".
 * The browser is one of those servers and nothing more — having its tools is
 * having the browser, which is why the switch it used to have of its own is
 * gone. Nothing here knows what any of them are.
 *
 * The same list is a project's, from the Projects page: what its chats start
 * with, between the portal-wide default and what one chat switches for itself.
 * The two answer in the same shape, so only where they ask and write differs.
 *
 * And a project's that does not exist yet, in the dialog that makes it: there is
 * nothing to ask or to save, so it starts from the portal-wide default and hands
 * each choice to the dialog, which sends them along with the project.
 *
 * And an agent's, on its page, for every chat in its home and every run it does
 * on its own; and a routine's, on its page, for every run of it. Those are the
 * same kind of list as a project's, each between the layers under it and what a
 * chat switches for itself.
 */
export function ToolSwitches(
  props: { sessionId: string } | { project: string } | { agent: string } | { routine: string } | { onDraft: (off: string[]) => void },
) {
  const project = "project" in props ? props.project : undefined;
  const agent = "agent" in props ? props.agent : undefined;
  const routine = "routine" in props ? props.routine : undefined;
  // A layer under the chats rather than a chat: answered and saved the same way, by a different address.
  const layer: { get: () => ReturnType<typeof api.projectTools>; set: (off: string[]) => ReturnType<typeof api.setProjectTools> } | undefined =
    project !== undefined
      ? { get: () => api.projectTools(project), set: (off) => api.setProjectTools(project, off) }
      : agent !== undefined
        ? { get: () => api.agentTools(agent), set: (off) => api.setAgentTools(agent, off) }
        : routine !== undefined
          ? { get: () => api.routineTools(routine), set: (off) => api.setRoutineTools(routine, off) }
          : undefined;
  const sessionId = "sessionId" in props ? props.sessionId : "";
  const onDraft = "onDraft" in props ? props.onDraft : undefined;
  const drafting = onDraft !== undefined;
  // What the chats of a project, made or about to be, start with.
  const forProject = project !== undefined || drafting;
  const [tools, setTools] = useState<PortalTool[] | null>(null);
  const [off, setOff] = useState<string[]>([]);
  const [live, setLive] = useState(true);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState("");
  // Any other failure of the first read, which is no statement about the deployment: it is tried again, by the button or by a change of chat.
  const [failed, setFailed] = useState<string | null>(null);
  const [tries, setTries] = useState(0);
  // Why the last switch did not take, which the page put back.
  const [flipError, setFlipError] = useState("");
  const [names, setNames] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    (drafting
      ? api.toolDefaults().then((r) => ({
          ...r,
          live: false,
          tools: r.tools.map((tool) => ({ ...tool, enabled: !r.off.includes(tool.name) })),
        }))
      : layer
        ? layer.get()
        : api.tools(sessionId)
    )
      .then((r) => {
        if (cancelled) return;
        setFailed(null);
        setTools(r.tools);
        setOff(r.off);
        setLive(r.live);
        setNames(r.names ?? {});
      })
      .catch((e) => {
        if (cancelled) return;
        // A deployment where this cannot work says so — a switch that silently
        // does nothing is worse than one that is not there. Only that answer:
        // a portal that could not be reached is not a deployment without switches.
        if (e instanceof ApiError && e.body.code === "tools-unsupported") {
          setRefusal(e.message);
          setTools([]);
        } else setFailed((e as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [project, agent, routine, sessionId, drafting, tries]);

  const flip = async (names: string[], enabled: boolean) => {
    const wanted = nextOff(off, names, enabled);
    const before = { off, tools };
    setOff(wanted);
    setTools((prev) =>
      prev?.map((t) => (names.includes(t.name) ? { ...t, enabled } : t)) ?? prev
    );
    // Nothing to save yet: the dialog keeps it until the project is made.
    if (onDraft) return onDraft(wanted);
    setBusy(true);
    setFlipError("");
    try {
      const r = await (layer ? layer.set(wanted) : api.setTools(sessionId, wanted));
      setOff(r.off);
    } catch (e) {
      // Put it back rather than showing a switch that did not take, and say why.
      setOff(before.off);
      setTools(before.tools);
      setFlipError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!tools && failed) {
    return (
      <div className="p-2">
        <LoadFailed
          error={failed}
          onRetry={() => {
            setFailed(null);
            setTries((n) => n + 1);
          }}
        />
      </div>
    );
  }
  if (!tools) return <p className="px-3 py-2 text-xs text-fg-subtle">{t("Loading…")}</p>;

  if (refusal) {
    return <p className="px-3 py-2 text-xs text-fg-subtle">{refusal}</p>;
  }

  if (!tools.length) {
    return (
      <p className="px-3 py-2 text-xs text-fg-subtle">
        {live
          ? t("No tools registered.")
          : off.length
            ? tp(off.length, "{n} switched off. The rest are listed once a conversation has run.", "{n} switched off. The rest are listed once a conversation has run.")
            : t("No tools seen yet — they are listed once a conversation has run.")}
      </p>
    );
  }

  return (
    <div className="max-h-80 overflow-y-auto">
      {flipError && (
        <p role="alert" className="px-3 pt-2 text-[11px] text-danger">
          {t("That switch was not saved: {error}", { error: flipError })}
        </p>
      )}
      {/* Before the first message pi has no registry to ask: the list is what
          earlier chats registered, and what is switched here is this chat's
          from its start — the default is not touched. */}
      {!live && (
        <p className="px-3 pb-1.5 pt-2 text-[10px] text-fg-faint">
          {forProject
            ? t("These are the tools earlier chats had. What you switch here is what every chat in this project starts with; the portal-wide defaults stay as they are.")
            : agent !== undefined
              ? t("These are the tools earlier chats had. What you switch here is what every chat in this agent's home starts with, and every run it does on its own; the portal-wide defaults stay as they are.")
              : routine !== undefined
                ? t("These are the tools earlier chats had. What you switch here is what every run of this routine starts with, against what its agent and project leave.")
                : t("Not started yet — these are the tools earlier chats had. What you switch here holds for this chat from its first message; the defaults stay as they are.")}
        </p>
      )}
      <ToolGroupList tools={tools} names={names} busy={busy} onFlip={flip} />
      {live && (
        <p className="px-3 py-1.5 text-[10px] text-fg-faint">
          {t("Applies from the next message, for this conversation. Settings → Tools sets what every conversation starts with.")}
        </p>
      )}
      {(project !== undefined || agent !== undefined || routine !== undefined) && (
        <p className="px-3 py-1.5 text-[10px] text-fg-faint">
          {t("Chats already running here have it from their next message. A chat that switched a tool for itself keeps its own choice.")}
        </p>
      )}
    </div>
  );
}
