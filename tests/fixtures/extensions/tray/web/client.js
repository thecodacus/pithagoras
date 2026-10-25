/**
 * A stand-in for the portal's own specs: an extension that draws where an app
 * like the subagents' does, so that no spec of the portal's own needs the one
 * the portal ships.
 *
 *   chat.tray          a chip "Following" while a shell command of the chat's runs, counting from its start
 *   chat.model.menu    a row in the model menu that says the chat and how many models the menu lists
 *   chat.tool.action   "Follow" beside the head of a shell call's card (`head`)
 *   chat.panel         "Replay": the chat's own conversation drawn again with `ui.Transcript`, given the chat; "Bare replay":
 *                      the same without it
 *   chat.tool          a marker around the card of a shell call, where the conversation is given its chat
 *
 * Plain JavaScript with the portal's React, as the Notes example is: nothing
 * to build.
 */
const SHELL = /^(bash|shell)$/;

export default function (portal) {
  const { React, ui } = portal;
  const h = React.createElement;

  const Icon = (props) => h("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, ...props }, h("circle", { cx: 12, cy: 12, r: 8 }));

  /** The shell command running now in the chat, with when it started: the newest, as the conversation has it. */
  const runningOf = (feed) => {
    const call = [...feed.items].reverse().find((item) => item.kind === "tool" && item.status === "running" && SHELL.test(String(item.name)));
    return call ? { command: String(call.args?.command ?? ""), since: call.since } : null;
  };

  portal.slots.register("chat.tray", {
    id: "following",
    component: ({ chat, panels }) => {
      const run = portal.chats.use(chat.id, runningOf);
      return run ? h(ui.TrayChip, { icon: Icon, label: "Following", detail: run.command, since: run.since, onClick: () => panels.open("replay") }) : null;
    },
  });

  portal.slots.register("chat.model.menu", {
    id: "row",
    component: ({ chat, models }) => h("p", { "data-testid": "menu-row", className: "px-3 py-1.5 text-xs" }, `Replays of ${chat.id} run on one of ${models.length} models`),
  });

  portal.slots.register("chat.tool.action", {
    id: "follow",
    tool: SHELL,
    head: true,
    component: ({ call, chat, panels }) => (chat && call.callId ? h(ui.ToolLink, { icon: Icon, onClick: () => panels.open("replay", { callId: call.callId }) }, "Follow") : null),
  });

  portal.slots.register("chat.panel", {
    id: "replay",
    name: "replay",
    title: "Replay",
    icon: Icon,
    component: ({ chat }) => {
      const feed = portal.chats.use(chat.id, (f) => ({ events: f.events, running: f.running }));
      return h("div", { "data-testid": "replay", style: { padding: 12, overflow: "auto", height: "100%" } }, h(ui.Transcript, { events: feed.events, running: feed.running, chat, empty: h("p", null, "Nothing yet") }));
    },
  });

  // Only where the card is drawn for a chat: the chat's own conversation, and a Transcript that is given the chat.
  portal.slots.register("chat.tool", {
    id: "marked",
    tool: "bash",
    component: ({ card }) => h("div", { "data-testid": "tool-card" }, card),
  });

  portal.slots.register("chat.panel", {
    id: "bare",
    name: "bare",
    title: "Bare replay",
    icon: Icon,
    component: ({ chat }) => {
      const feed = portal.chats.use(chat.id, (f) => ({ events: f.events, running: f.running }));
      return h("div", { "data-testid": "bare", style: { padding: 12, overflow: "auto", height: "100%" } }, h(ui.Transcript, { events: feed.events, running: feed.running }));
    },
  });
}
