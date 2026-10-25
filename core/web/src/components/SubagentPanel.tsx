import { memo, useLayoutEffect, useMemo, useState } from "react";
import { useNow } from "../use-now";
import { Markdown } from "./Markdown";
import { LuArrowUp, LuBot, LuSquare } from "react-icons/lu";
import { api } from "../api";
import { buildTranscript, formatElapsed, type Item } from "../transcript";
import { subagentName, type Subagent } from "../subagents";
import { useFollowBottom } from "../use-follow-bottom";
import { CompactionMarker, Ring, Shimmer, ThinkingBlock, ToolCall } from "./ChatActivity";
import { isEnter } from "../shortcuts";
import { t, useLanguage } from "../i18n";
import { tabKeys } from "../tab-keys";

/**
 * The subagents of a chat, one at a time: what it is doing, drawn like the
 * conversation itself, and — where its extension takes messages — a box to
 * tell it something.
 */
export function SubagentPanel({
  sessionId,
  agents,
  selected,
  onSelect,
}: {
  sessionId: string;
  agents: Subagent[];
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  const agent = agents.find((a) => a.id === selected) ?? agents[agents.length - 1];
  if (!agents.length || !agent) {
    return (
      <div className="sub-panel">
        <p className="bg-jobs-empty">
          {t("No subagents in this chat yet. An extension's agent shows up here while it works, if the extension speaks the subagent protocol.")}
        </p>
      </div>
    );
  }
  return (
    <div className="sub-panel">
      {agents.length > 1 && (
        <div className="sub-tabs" role="tablist" aria-label={t("Subagents")} onKeyDown={tabKeys}>
          {agents.map((a) => (
            <button key={a.id} type="button" role="tab" aria-selected={a.id === agent.id} tabIndex={a.id === agent.id ? 0 : -1} onClick={() => onSelect(a.id)} className={`sub-tab is-${a.status}`}>
              {a.status === "running" ? <Ring /> : <i className="bg-job-dot" aria-hidden />}
              {subagentName(a)}
            </button>
          ))}
        </div>
      )}
      <AgentView key={agent.id} sessionId={sessionId} agent={agent} />
    </div>
  );
}

const AgentView = memo(function AgentView({ sessionId, agent }: { sessionId: string; agent: Subagent }) {
  useLanguage();
  const running = agent.status === "running";
  const now = useNow(running);
  const { attach, onScroll, follow } = useFollowBottom<HTMLDivElement>();
  const childItems = useMemo(() => buildTranscript(agent.events), [agent]);
  useLayoutEffect(() => follow(), [childItems]);
  const seconds = agent.since ? Math.max(0, Math.floor(((running ? now : agent.until ?? now) - agent.since) / 1000)) : undefined;

  return (
    <>
      <div className="sub-head">
        <span className="sub-head-icon">{running ? <Ring /> : <LuBot aria-hidden />}</span>
        <div className="min-w-0 flex-1">
          <div className="sub-head-title">{subagentName(agent)}</div>
          <div className="sub-head-detail">
            {running ? <Shimmer>{agent.detail ?? t("Working")}</Shimmer> : agent.status === "done" ? t("Finished") : agent.status === "stopped" ? t("Stopped") : agent.error ?? t("Failed")}
            {seconds !== undefined && ` · ${formatElapsed(seconds)}`}
          </div>
        </div>
        {agent.stop && running && (
          <button type="button" className="bg-job-stop" onClick={() => void api.subagentStop(sessionId, agent.id).catch(() => undefined)}>
            <LuSquare aria-hidden fill="currentColor" /> {t("Stop")}
          </button>
        )}
      </div>
      <div ref={attach} onScroll={onScroll} className="sub-body">
        {childItems.length ? childItems.map((item) => <ChildItem key={item.id} item={item} running={running} />) : <p className="bg-jobs-empty"><Shimmer>{t("Starting…")}</Shimmer></p>}
      </div>
      <AgentInput sessionId={sessionId} agent={agent} />
    </>
  );
});

/** Not drawn again for the second's tick of the panel, nor for another entry being written. */
const ChildItem = memo(function ChildItem({ item, running }: { item: Item; running: boolean }) {
  useLanguage();
  switch (item.kind) {
    case "user":
      return <div className="sub-prompt">{item.text}</div>;
    case "assistant":
      return (
        <div className="sub-reply">
          {item.thinking && <ThinkingBlock thinking={item.thinking} streaming={running && !item.done && !item.text} since={item.thinkingSince} until={item.thinkingUntil} />}
          {item.text && (
            <div className="md text-[13px] leading-relaxed text-fg">
              <Markdown parseIncompleteMarkdown animated isAnimating={running && !item.done}>
                {item.text}
              </Markdown>
            </div>
          )}
        </div>
      );
    case "tool":
      return <div className="tool-row"><ToolCall item={item} /></div>;
    case "compaction":
      return <CompactionMarker item={item} />;
    // A subagent has nobody to ask: only the chat's own agent asks the person.
    case "question":
      return null;
    default:
      return <div className="sub-notice">{item.kind === "notice" && item.portal ? t(item.text) : item.text}</div>;
  }
});

function AgentInput({ sessionId, agent }: { sessionId: string; agent: Subagent }) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastSent, setLastSent] = useState<string | null>(null);
  if (agent.status !== "running") return null;
  if (!agent.input) {
    return (
      <p className="sub-input-note">{t("This subagent does not take messages.")}</p>
    );
  }
  const send = async () => {
    const message = text.trim();
    if (!message || sending) return;
    setSending(true);
    setError(null);
    try {
      await api.subagentInput(sessionId, agent.id, message);
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
      {error && <p className="bg-jobs-error">{error}</p>}
      <div className="sub-input-box">
        <textarea
          value={text}
          rows={2}
          placeholder={t("Tell {name} something…", { name: subagentName(agent) })}
          aria-label={t("Message for {name}", { name: subagentName(agent) })}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (isEnter(e) && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <button type="button" className="prompt-action prompt-send" aria-label={t("Send to the subagent")} disabled={!text.trim() || sending} onClick={() => void send()}>
          <LuArrowUp aria-hidden className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
