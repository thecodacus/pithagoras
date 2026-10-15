/**
 * A stand-in for the portal's own specs: an extension with what an app like
 * the terminal brings, through the hooks any extension has, so that a spec of
 * the portal's own tests the portal with it and needs none of the extensions
 * the portal ships, any of which can be removed.
 *
 *   chat.panel         "Console" (named "console"), with its tabs in its head
 *   voice.window       "Console" at the side, with what each command said, opening on each shell command and
 *                      from a shell call's card
 *   chat.tool.action   "Open in the console" on a shell call's card
 *   shortcut           T in voice mode shows or hides it
 *   jobs.show          a job in the running tray opens the panel on it
 *
 * Plain JavaScript with the portal's React, as the Notes example is: nothing
 * to build.
 */
const SHELL = /^(bash|shell)$/;

export default function (portal) {
  const { React, ui } = portal;
  const h = React.createElement;

  const Icon = (props) => h("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, ...props }, h("path", { d: "M4 17l6-6-6-6M12 19h8" }));

  /** The commands the chat's agent started, in order. */
  const commandsOf = (events) => events.filter((e) => e.type === "tool_execution_start" && SHELL.test(e.payload?.toolName ?? "")).map((e) => String((e.payload?.args ?? e.payload?.input)?.command ?? ""));
  /** Each command with what it has said so far: the last update, or what it ended with. */
  const runsOf = (events) => {
    const runs = new Map();
    const text = (result) => (result?.content ?? []).map((part) => part.text ?? "").join("");
    for (const e of events) {
      const p = e.payload ?? {};
      if (e.type === "tool_execution_start" && SHELL.test(p.toolName ?? "")) runs.set(p.toolCallId, { command: String((p.args ?? p.input)?.command ?? ""), said: "" });
      else if (e.type === "tool_execution_update" && runs.has(p.toolCallId)) runs.get(p.toolCallId).said = text(p.partialResult);
      else if (e.type === "tool_execution_end" && runs.has(p.toolCallId)) runs.get(p.toolCallId).said = text(p.result);
    }
    return [...runs.values()].map((run) => `$ ${run.command}\n${run.said}`).join("\n");
  };

  const TABS = ["Agent", "Jobs"];
  const tabOf = (panel) => panel.state?.tab ?? (panel.params?.job ? "Jobs" : "Agent");

  function Tabs({ panel }) {
    const tab = tabOf(panel);
    return h(
      "div",
      { className: "console-tabs", role: "tablist", "aria-label": "Consoles", onKeyDown: (e) => ui.tabKeys(e) },
      TABS.map((name) => h("button", { key: name, type: "button", role: "tab", "aria-selected": tab === name, tabIndex: tab === name ? 0 : -1, onClick: () => panel.setState({ tab: name }) }, name)),
    );
  }

  function ConsolePanel({ chat, panel }) {
    const commands = portal.chats.use(chat.id, (feed) => commandsOf(feed.events).join("\n"));
    const tab = tabOf(panel);
    const job = panel.params?.job;
    const callId = panel.params?.callId;
    return h(
      "div",
      { className: "console-pane", "data-console-tab": tab },
      tab === "Jobs" ? (job ? `Job ${job}` : "No job") : [commands || "No commands yet", callId ? h("div", { key: "call" }, `Call ${callId}`) : null],
    );
  }

  portal.slots.register("chat.panel", {
    id: "console",
    name: "console",
    title: "Console",
    icon: Icon,
    header: Tabs,
    component: ConsolePanel,
    useButton: () => ({ title: "The agent's commands" }),
  });

  portal.slots.register("voice.window", {
    id: "console",
    title: "Console",
    icon: Icon,
    place: "side",
    // Each command the agent starts brings it up.
    useAutoOpen: ({ chat }) => portal.chats.use(chat.id, (feed) => commandsOf(feed.events).length),
    opensFor: (call) => SHELL.test(call.name),
    component: ({ chat }) => {
      const runs = portal.chats.use(chat.id, (feed) => runsOf(feed.events));
      return h("div", { className: "console-pane", role: "log", "aria-label": "Console output", style: { whiteSpace: "pre-wrap" } }, runs || "No commands yet");
    },
  });

  portal.slots.register("chat.tool.action", {
    id: "show",
    tool: SHELL,
    component: ({ call, chat, panels }) =>
      chat && call.callId ? h(ui.ToolLink, { icon: Icon, onClick: () => panels.open("console", { callId: call.callId }) }, "Open in the console") : null,
  });

  portal.shortcuts.register({
    id: "console",
    label: "Show or hide the console",
    scope: "voice",
    default: { code: "KeyT" },
    run: ({ windows }) => (windows.isOpen("console") ? windows.close("console") : windows.open("console")),
  });

  portal.commands.register("jobs.show", ({ job }) => portal.panels.open(`${portal.extension}/console`, { job }));
}
