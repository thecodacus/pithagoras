import { Suspense, useEffect } from "react";
import type { ChatFeed, ChatProps, Portal, SlotMap } from "@pithagoras/extension-api";
import { fetchChoice } from "./chat-model";
import { AgentIcon, AgentsIcon } from "./icons";
import { ModelRow } from "./ModelRow";
import { nameOf, SubagentPanel, useAgents } from "./Panel";
import { msg, portal, setPortal, t } from "./portal";
import { useAsking } from "./asking";
import { agentsOf, type Subagent } from "./subagents";
import { de } from "./de";
import "./client.css";

/**
 * The subagent extension's browser half. Beside a chat: the panel of its subagents, with its button in the chat's
 * header while it has any; a chip in the running tray for each one at work; Watch on the call that started one; and
 * the row in the chat's model menu that says what its subagents run on. Every subagent of the protocol is drawn, this
 * extension's and any other's. In Settings, its page, where how a subagent runs against the agent, the model it runs
 * on and how many run at once are set (web/SubagentSettings.tsx). Its texts in German are in de.ts.
 */
export default function subagent(given: Portal) {
  setPortal(given);
  portal.locale.add("de", de);

  // The panel goes by "agents" for anything in the page to open it by (`portal.panels.open("agents", { id })`).
  portal.slots.register("chat.panel", {
    id: "agents",
    name: "agents",
    title: msg("Subagents"),
    icon: AgentsIcon,
    component: SubagentPanel,
    useButton: ({ chat }) => {
      portal.locale.use();
      const shown = portal.chats.use(chat.id, (feed: ChatFeed) => {
        const agents = agentsOf(chat.id, feed);
        return { any: agents.length > 0, live: agents.some((a) => a.status === "running") };
      });
      // A chat that never had one has no button for it.
      return { hidden: !shown.any, live: shown.live, title: t("The agents working beside this one") };
    },
  });

  portal.slots.register("chat.tray", { id: "running", component: Running });

  // Beside the card's head, so it is there without opening the card: on any call that started a subagent.
  portal.slots.register("chat.tool.action", { id: "watch", head: true, component: Watch });

  portal.slots.register("chat.model.menu", { id: "model", component: ModelRow });
  // What the chat's subagents run on, fetched with the chat: the model menu opens with it already there.
  portal.slots.register("chat.background", { id: "model", component: FetchChoice });

  // Only fetched once it is opened.
  const Settings = portal.ui.lazy(() => import("./web/SubagentSettings"), "SubagentSettings");
  portal.slots.register("settings.page", {
    id: "subagent",
    title: msg("Subagents"),
    icon: AgentsIcon,
    // Each leads to its part of the page, which is named for it (web/SubagentSettings.tsx).
    search: [
      { title: msg("Subagents"), section: msg("How a subagent runs against the agent"), words: "subagent subagents mode background interrupt teilagenten modus hintergrund unterbrechen" },
      { title: msg("Subagents at once"), section: msg("Subagents at once"), words: "subagent parallel limit slots at once teilagenten gleichzeitig" },
      { title: msg("Subagent model"), section: msg("Subagent model"), words: "subagent model llm teilagenten modell" },
      { title: msg("Keep subagent chats"), section: msg("Keep subagent chats"), words: "subagent keep chats sub-chats continue persistent teilagenten behalten unterchats fortsetzen" },
      { title: msg("Subagents work in the chat's mode"), section: msg("Subagents work in the chat's mode"), words: "subagent mode code custom standard inherit teilagenten modus erben" },
    ],
    component: () => (
      <Suspense fallback={<p className="text-sm text-fg-subtle">{t("Loading…")}</p>}>
        <Settings />
      </Suspense>
    ),
  });
}

/** A chip in the running tray for each subagent at work, which opens it in the panel. */
function Running({ chat, panels }: ChatProps) {
  portal.locale.use();
  const running = useAgents(chat.id).filter((a) => a.status === "running");
  return (
    <>
      {running.map((a) => (
        <RunningChip key={a.id} agent={a} onClick={() => panels.open("agents", { id: a.id })} />
      ))}
    </>
  );
}

/** One subagent at work in the tray: what it is doing, or that it waits for the person in its chat. */
function RunningChip({ agent, onClick }: { agent: Subagent; onClick: () => void }) {
  const asking = useAsking(agent.chat, true);
  return <portal.ui.TrayChip icon={AgentIcon} label={nameOf(agent)} detail={asking ? t("waiting for you") : agent.detail} since={agent.since} onClick={onClick} />;
}

/** Watch, or Open once it is over: the subagent a call started, in the panel. Nothing on any other call. */
function Watch({ call, chat, panels }: SlotMap["chat.tool.action"]["props"]) {
  portal.locale.use();
  // Any call that started it: one whose chat is kept is given more by later calls, each of which opens it.
  const id = portal.chats.use(chat?.id ?? "", (feed: ChatFeed) => (chat && call.callId ? agentsOf(chat.id, feed).find((a) => a.calls.includes(call.callId!))?.id : undefined));
  if (!id) return null;
  return (
    <portal.ui.ToolLink icon={AgentIcon} onClick={() => panels.open("agents", { id })}>
      {call.status === "running" ? t("Watch") : t("Open")}
    </portal.ui.ToolLink>
  );
}

function FetchChoice({ chat }: ChatProps) {
  useEffect(() => fetchChoice(chat.id), [chat.id]);
  return null;
}
