import { Suspense, useLayoutEffect, useState, type KeyboardEvent } from "react";
import { LuSquareTerminal, LuTerminal } from "react-icons/lu";
import type { ChatProps, PanelHandle, PanelProps, Portal } from "@pithagoras/extension-api";
import { AgentTerminal } from "./AgentTerminal";
import { latestCommand } from "./runs";
import { Jobs } from "./Jobs";
import { msg, portal, setPortal, t } from "./portal";
import { SHELL_TOOL } from "./text";
import { de } from "./de";
import "./client.css";

/**
 * The terminal: what the agent ran in a chat and what came back, the jobs it
 * left running, and a shell of the person's own in the chat's folder. A panel
 * beside the conversation with the three as tabs, a window in voice mode, a
 * way into it from the card of each command in the conversation, a voice
 * shortcut, and the place a background job in the running tray is shown.
 */


type Tab = "agent" | "jobs" | "shell";
const TABS: { id: Tab; label: string }[] = [
  { id: "agent", label: msg("Agent") },
  { id: "jobs", label: msg("Background") },
  { id: "shell", label: msg("Your shell") },
];

/** Which tab is shown and which job in it: shared by the panel and the tabs in its head while it is open. */
type Shown = { tab: Tab; job: string | null };
const shownOf = (panel: PanelHandle): Shown => ({ tab: "agent", job: null, ...(panel.state as Partial<Shown> | undefined) });
const show = (panel: PanelHandle, next: Partial<Shown>) => panel.setState({ ...shownOf(panel), ...next });

/** What the panel may be opened with: a command of the agent's to bring into view, or a background job to follow. */
type Asked = { callId?: unknown; job?: unknown } | undefined;

function TerminalPanel({ chat, panel }: PanelProps) {
  const { tab, job } = shownOf(panel);
  const [focus, setFocus] = useState<{ id: string; at: number } | null>(null);
  // The shell is started only once asked for, and kept while the panel is open.
  const [shellStarted, setShellStarted] = useState(tab === "shell");
  if (tab === "shell" && !shellStarted) setShellStarted(true);
  // Opened on something: its tab, before the panel is shown.
  useLayoutEffect(() => {
    const asked = panel.params as Asked;
    if (typeof asked?.callId === "string") {
      show(panel, { tab: "agent" });
      setFocus({ id: asked.callId, at: Date.now() });
    } else if (typeof asked?.job === "string") {
      show(panel, { tab: "jobs", job: asked.job });
    }
  }, [panel.params]);
  const pane = (id: Tab) => (tab === id ? "terminal-pane" : "terminal-pane is-hidden");
  return (
    <div className="terminal-panel">
      <div className={pane("agent")}>
        <AgentTerminal chatId={chat.id} limit={500} maxOutput={200_000} hidden={tab !== "agent"} focus={focus} onFocused={() => setFocus(null)} />
      </div>
      <div className={pane("jobs")}>{tab === "jobs" && <Jobs chatId={chat.id} selected={job} onSelect={(key) => show(panel, { job: key })} />}</div>
      {shellStarted && (
        <div className={pane("shell")}>
          {/* Its code is fetched when the tab is first opened: a file that is gone must not take the panel with it. */}
          <portal.ui.ErrorBoundary resetKey={chat.id} fallback={(error) => <div className="terminal-failed"><portal.ui.PartFailed error={error} /></div>}>
            <Suspense fallback={null}>
              <Shell chatId={chat.id} />
            </Suspense>
          </portal.ui.ErrorBoundary>
        </div>
      )}
    </div>
  );
}

/** The three tabs, in the panel's head, each with a dot while something in it runs. */
function Tabs({ chat, panel }: PanelProps) {
  portal.locale.use();
  const { tab } = shownOf(panel);
  const live = portal.chats.use(chat.id, (feed) => ({
    agent: feed.running,
    jobs: feed.background.jobs.some((j) => j.state === "running" && !j.attached),
    shell: false,
  }));
  return (
    <div className="terminal-tabs" role="tablist" aria-label={t("Terminals")} onKeyDown={(e: KeyboardEvent<HTMLElement>) => portal.ui.tabKeys(e)}>
      {TABS.map(({ id, label }) => (
        <button key={id} type="button" role="tab" aria-selected={tab === id} tabIndex={tab === id ? 0 : -1} onClick={() => show(panel, { tab: id })}>
          {t(label)}
          {live[id] && <i className="terminal-tab-live" role="img" aria-label={t("Running")} />}
        </button>
      ))}
    </div>
  );
}

/** What the agent ran, in a window of voice mode. */
function VoiceTerminal({ chat }: ChatProps) {
  return (
    <div className="terminal-window">
      <AgentTerminal chatId={chat.id} />
    </div>
  );
}

// The terminal emulator is large, and only a chat whose Shell tab is opened needs it.
let Shell: ReturnType<Portal["ui"]["lazy"]>;

export default function terminal(given: Portal) {
  setPortal(given);
  Shell = portal.ui.lazy(() => import("./Shell"), "Shell");
  portal.locale.add("de", de);

  portal.slots.register("chat.panel", {
    id: "terminal",
    name: "terminal",
    title: "Terminal",
    icon: LuSquareTerminal,
    header: Tabs,
    component: TerminalPanel,
    useButton: () => {
      portal.locale.use();
      return { title: t("The agent's terminal, and a shell of your own in this workspace") };
    },
  });

  portal.slots.register("voice.window", {
    id: "terminal",
    title: "Terminal",
    icon: LuTerminal,
    place: "side",
    // Each command the agent starts brings it up.
    useAutoOpen: ({ chat }) => portal.chats.use(chat.id, (feed) => latestCommand(feed.events)),
    opensFor: (call) => SHELL_TOOL.test(call.name),
    component: VoiceTerminal,
  });

  portal.slots.register("chat.tool.action", {
    id: "show",
    tool: SHELL_TOOL,
    component: ({ call, cut, chat, panels }) => {
      portal.locale.use();
      // Only a command of the chat's own agent is in its terminal: not one a subagent ran, nor one in a memory.
      if (!chat || !call.callId) return null;
      return (
        <portal.ui.ToolLink icon={LuSquareTerminal} onClick={() => panels.open("terminal", { callId: call.callId })}>
          {cut ? t("Show the whole output in the agent terminal") : t("Open in the agent terminal")}
        </portal.ui.ToolLink>
      );
    },
  });

  portal.shortcuts.register({
    id: "terminal",
    // Translated where it is listed, as the extension's own texts are.
    label: msg("Show or hide the terminal"),
    scope: "voice",
    default: { code: "KeyT" },
    run: ({ windows }) => (windows.isOpen("terminal") ? windows.close("terminal") : windows.open("terminal")),
  });

  // A job in the running tray is shown here, on the Background tab.
  portal.commands.register("jobs.show", ({ job }: { chat: string; job: string }) => portal.panels.open(`${portal.extension}/terminal`, { job }));
}
