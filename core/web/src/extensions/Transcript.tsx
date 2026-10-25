import { memo, useMemo, type ReactNode } from "react";
import { Markdown } from "../components/Markdown";
import { CompactionMarker, ThinkingBlock, ToolCall } from "../components/ChatActivity";
import { buildTranscript, type Item } from "../transcript";
import type { PortalEvent } from "../api";
import { t, useLanguage } from "../i18n";
import { ToolView } from "./ToolView";
import type { Chat } from "./slots";

/**
 * `ui.Transcript`: a conversation drawn from its events as the chat draws its own, for an extension that shows one
 * beside the chat (a subagent's run, see extensions/subagent). Each row is drawn again only when it changed, not for
 * the second's tick of what holds it, nor for another row being written.
 */
export function Transcript({ events, running = false, chat, empty }: { events: readonly PortalEvent[]; running?: boolean; chat?: Chat; empty?: ReactNode }) {
  const items = useMemo(() => buildTranscript(events as PortalEvent[]), [events]);
  if (!items.length) return <>{empty ?? null}</>;
  return (
    <div className="side-transcript">
      {items.map((item) => (
        <ChildItem key={item.id} item={item} running={running} chat={chat} />
      ))}
    </div>
  );
}

const ChildItem = memo(function ChildItem({ item, running, chat }: { item: Item; running: boolean; chat?: Chat }) {
  useLanguage();
  switch (item.kind) {
    case "user":
      return <div className="side-transcript-prompt">{item.text}</div>;
    case "assistant":
      return (
        <div className="side-transcript-reply">
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
      // An extension's own card for its tool, as in the chat; what is offered on the portal's card is not the chat's,
      // as the call is not its own.
      return (
        <div className="tool-row">
          <ToolView item={item} chat={chat}>
            <ToolCall item={item} />
          </ToolView>
        </div>
      );
    case "compaction":
      return <CompactionMarker item={item} />;
    // Nobody is asked here: only the chat's own agent asks the person.
    case "question":
      return null;
    default:
      return <div className="side-transcript-notice">{item.kind === "notice" && item.portal ? t(item.text) : item.text}</div>;
  }
});
