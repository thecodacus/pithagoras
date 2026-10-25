import { memo, useLayoutEffect, useState, type KeyboardEvent } from "react";
import type { ChatFeed, PanelHandle, PanelProps } from "@pithagoras/extension-api";
import { AgentIcon, SendIcon, StopIcon } from "./icons";
import { portal, t } from "./portal";
import { agentsOf, UNNAMED, type Subagent } from "./subagents";

/** A subagent's name as it is shown. */
export const nameOf = (agent: { label: string }): string => (agent.label === UNNAMED ? t("Subagent") : agent.label);

/** Which subagent the panel shows: kept while it is open (`panel.state`), and set by what it is opened with. */
const selectedOf = (panel: PanelHandle): string | null => {
  const id = (panel.state as { selected?: unknown } | undefined)?.selected;
  return typeof id === "string" ? id : null;
};

/** A chat's subagents, for a part that draws them all: drawn again only when one of them changed. */
export const useAgents = (chatId: string) => portal.chats.use(chatId, (feed: ChatFeed) => agentsOf(chatId, feed));

/**
 * The subagents of a chat, one at a time, in the panel beside it: what it is doing, drawn like the conversation
 * itself, and — where its extension takes messages — a box to tell it something. Every subagent of the protocol is
 * here, this extension's and any other's.
 */
export function SubagentPanel({ chat, panel }: PanelProps) {
  portal.locale.use();
  const agents = useAgents(chat.id);
  // Opened on one (the tray, a call's Watch): that one, before the panel is shown.
  useLayoutEffect(() => {
    const asked = (panel.params as { id?: unknown } | undefined)?.id;
    if (typeof asked === "string") panel.setState({ selected: asked });
  }, [panel.params]);
  const selected = selectedOf(panel);
  const agent = agents.find((a) => a.id === selected) ?? agents[agents.length - 1];
  if (!agents.length || !agent) {
    return (
      <div className="sub-panel">
        <p className="sub-empty">
          {t("No subagents in this chat yet. An extension's agent shows up here while it works, if the extension speaks the subagent protocol.")}
        </p>
      </div>
    );
  }
  return (
    <div className="sub-panel">
      {agents.length > 1 && (
        <div className="sub-tabs" role="tablist" aria-label={t("Subagents")} onKeyDown={(e: KeyboardEvent<HTMLElement>) => portal.ui.tabKeys(e)}>
          {agents.map((a) => (
            <button key={a.id} type="button" role="tab" aria-selected={a.id === agent.id} tabIndex={a.id === agent.id ? 0 : -1} onClick={() => panel.setState({ selected: a.id })} className={`sub-tab is-${a.status}`}>
              {a.status === "running" ? <portal.ui.Ring /> : <i className="sub-dot" aria-hidden />}
              {nameOf(a)}
            </button>
          ))}
        </div>
      )}
      <AgentView key={agent.id} chat={chat} agent={agent} />
    </div>
  );
}

const AgentView = memo(function AgentView({ chat, agent }: { chat: PanelProps["chat"]; agent: Subagent }) {
  portal.locale.use();
  const running = agent.status === "running";
  const now = portal.ui.useNow(running);
  const { attach, onScroll, follow } = portal.ui.useFollowBottom<HTMLDivElement>();
  useLayoutEffect(() => follow(), [agent.events]);
  const seconds = agent.since ? Math.max(0, Math.floor(((running ? now : agent.until ?? now) - agent.since) / 1000)) : undefined;

  return (
    <>
      <div className="sub-head">
        <span className="sub-head-icon">{running ? <portal.ui.Ring /> : <AgentIcon />}</span>
        <div className="min-w-0 flex-1">
          <div className="sub-head-title">{nameOf(agent)}</div>
          <div className="sub-head-detail">
            {running ? <portal.ui.Shimmer>{agent.detail ?? t("Working")}</portal.ui.Shimmer> : agent.status === "done" ? t("Finished") : agent.status === "stopped" ? t("Stopped") : agent.error ?? t("Failed")}
            {seconds !== undefined && ` · ${portal.format.elapsed(seconds)}`}
          </div>
        </div>
        {agent.stop && running && (
          <button type="button" className="sub-stop" onClick={() => void stopAgent(chat.id, agent.id).catch(() => undefined)}>
            <StopIcon /> {t("Stop")}
          </button>
        )}
      </div>
      <div ref={attach} onScroll={onScroll} className="sub-body">
        <portal.ui.Transcript events={agent.events} running={running} chat={chat} empty={<p className="sub-empty"><portal.ui.Shimmer>{t("Starting…")}</portal.ui.Shimmer></p>} />
      </div>
      <AgentInput chatId={chat.id} agent={agent} />
    </>
  );
});

// The portal's routes for the person's side of the protocol: a message for a subagent that takes them, and a stop.
const agentUrl = (chatId: string, id: string, what: "input" | "stop") => `/api/sessions/${encodeURIComponent(chatId)}/subagents/${encodeURIComponent(id)}/${what}`;
const stopAgent = (chatId: string, id: string) => portal.api.json(agentUrl(chatId, id, "stop"), { method: "POST" });
const tellAgent = (chatId: string, id: string, text: string) => portal.api.json(agentUrl(chatId, id, "input"), { method: "POST", body: JSON.stringify({ text }) });

type KeyEvent = { key: string; keyCode?: number; nativeEvent?: { isComposing?: boolean } };
/**
 * Enter that means "send", not Enter that confirms what an input method composes: that keydown reaches the page too,
 * and Safari reports it after the composing has ended, as keyCode 229. As the portal's own message box reads it.
 */
const isEnter = (e: KeyEvent): boolean => e.key === "Enter" && !(e.nativeEvent?.isComposing || e.keyCode === 229);

function AgentInput({ chatId, agent }: { chatId: string; agent: Subagent }) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastSent, setLastSent] = useState<string | null>(null);
  if (agent.status !== "running") return null;
  if (!agent.input) return <p className="sub-input-note">{t("This subagent does not take messages.")}</p>;
  const send = async () => {
    const message = text.trim();
    if (!message || sending) return;
    setSending(true);
    setError(null);
    try {
      await tellAgent(chatId, agent.id, message);
      setLastSent(message);
      setText("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  };
  return (
    <div className="sub-input">
      {lastSent !== null && <div className="sub-input-sent">{t("Sent: “{text}”", { text: lastSent })}</div>}
      {error && <p className="sub-error">{error}</p>}
      <div className="sub-input-box">
        <textarea
          value={text}
          rows={2}
          placeholder={t("Tell {name} something…", { name: nameOf(agent) })}
          aria-label={t("Message for {name}", { name: nameOf(agent) })}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // Enter sends, as in the chat's own box; Shift+Enter does not, nor an input method's Enter.
            if (isEnter(e) && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <button type="button" className="sub-send" aria-label={t("Send to the subagent")} disabled={!text.trim() || sending} onClick={() => void send()}>
          <SendIcon />
        </button>
      </div>
    </div>
  );
}
