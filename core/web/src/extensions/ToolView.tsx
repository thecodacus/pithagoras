import { useMemo, type ComponentType, type ReactNode } from "react";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { unwrapCall } from "../tool-activity";
import type { Item } from "../transcript";
import { channelFor } from "./channel";
import { panelsFor } from "./panels";
import { useSlot, type Chat, type ToolCallView } from "./slots";

/**
 * A tool call's row in the conversation: an extension's own drawing of it,
 * where one registered for the tool (`chat.tool`), with the portal's card
 * handed to it; the portal's card as it is otherwise, and when the
 * extension's fails to draw.
 */
export function ToolView({ item, chat, children }: { item: ToolItem; chat?: Chat; children: ReactNode }) {
  const entries = useSlot("chat.tool");
  const call = useCallView(item);
  const entry = entries.find((e) => e.tool === call.name);
  if (!entry || !chat) return <>{children}</>;
  return (
    <ErrorBoundary resetKey={`${entry.key}:${item.id}`} fallback={() => <>{children}</>}>
      <entry.component chat={chat} channel={channelFor(chat.id, entry.extension)} panels={panelsFor(entry.extension)} call={call} card={children} />
    </ErrorBoundary>
  );
}

type ToolItem = Extract<Item, { kind: "tool" }>;

/** A call as an extension is told of it: the tool inside the one that reached it, with what that was given. */
function useCallView(item: ToolItem): ToolCallView {
  const { name, input } = useMemo(() => unwrapCall(item.name, item.args), [item.name, item.args]);
  return useMemo<ToolCallView>(
    () => ({ name, callId: item.callId, status: item.status, input, output: item.output, details: item.details }),
    [name, input, item.callId, item.status, item.output, item.details],
  );
}

/** A link on a tool call's card, as the portal draws its own: `ui.ToolLink`, for `chat.tool.action`. */
export function ToolLink({ icon: Icon, onClick, children }: { icon?: ComponentType<{ "aria-hidden"?: boolean }>; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" className="chat-tool-link" onClick={onClick}>
      {Icon && <Icon aria-hidden />}
      {children}
    </button>
  );
}

const forTool = (tool: string | RegExp | undefined, name: string) => {
  if (tool === undefined) return true;
  if (typeof tool === "string") return tool === name;
  tool.lastIndex = 0;
  return tool.test(name);
};

/**
 * What the installed extensions offer to do with a call (`chat.tool.action`),
 * under what it returned on the portal's card. `cut` is whether the card shows
 * only the end of the output. One that fails to draw is left out, alone.
 */
export function ToolActions({ item, cut }: { item: ToolItem; cut: boolean }) {
  const entries = useSlot("chat.tool.action");
  const call = useCallView(item);
  const offered = entries.filter((entry) => forTool(entry.tool, call.name));
  if (!offered.length) return null;
  return (
    <>
      {offered.map((entry) => (
        <ErrorBoundary key={entry.key} resetKey={`${entry.key}:${item.id}`} fallback={() => null}>
          <entry.component call={call} cut={cut} panels={panelsFor(entry.extension)} />
        </ErrorBoundary>
      ))}
    </>
  );
}
