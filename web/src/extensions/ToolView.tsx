import { useMemo, type ReactNode } from "react";
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
export function ToolView({ item, chat, children }: { item: Extract<Item, { kind: "tool" }>; chat?: Chat; children: ReactNode }) {
  const entries = useSlot("chat.tool");
  const { name, input } = useMemo(() => unwrapCall(item.name, item.args), [item.name, item.args]);
  const call = useMemo<ToolCallView>(
    () => ({ name, callId: item.callId, status: item.status, input, output: item.output, details: item.details }),
    [name, input, item.callId, item.status, item.output, item.details],
  );
  const entry = entries.find((e) => e.tool === name);
  if (!entry || !chat) return <>{children}</>;
  return (
    <ErrorBoundary resetKey={`${entry.key}:${item.id}`} fallback={() => <>{children}</>}>
      <entry.component chat={chat} channel={channelFor(chat.id, entry.extension)} panels={panelsFor(entry.extension)} call={call} card={children} />
    </ErrorBoundary>
  );
}
