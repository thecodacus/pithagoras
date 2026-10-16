import { parse as parsePartial } from "partial-json";
import type { ToolCallView } from "@pithagoras/extension-api";
import type { PortalEvent } from "./api";
import { unwrapCall } from "./tool-activity";
import type { Item } from "./transcript";

/**
 * The tool calls of a chat that have not ended, for what the extensions drew
 * there (`ChatFeed.calls`): the ones the model is writing now, with what it
 * has written of their arguments so far (`status: "writing"`), and the ones it
 * has written that are running. A call is the tool inside the one that reached
 * it, as the chat's cards show it (a lazy tool's, not the `tools` tool's).
 *
 * The arguments of a call being written come as JSON text, a piece with each
 * token (live-events.ts keeps it, `partialJson`). They are read as far as they
 * have come, strings cut where they are, at most every READ_EVERY_MS for each
 * call: reading the whole text again for each token of a long document would
 * cost more with every token. Once the model has written the call they are the
 * object it wrote.
 */

/** How often the arguments of a call being written are read again, at most. */
export const READ_EVERY_MS = 150;

type Block = { type?: string; id?: unknown; name?: unknown; partialJson?: unknown; arguments?: unknown };

/** What each chat's calls being written were last read as: by chat, by call. Only the calls still being written are kept. */
const read = new Map<string, Map<string, { text: string; at: number; value: unknown }>>();

/** The arguments of a call being written, as far as they have come: read again only when they changed and the last read is old enough. */
function argumentsOf(kept: Map<string, { text: string; at: number; value: unknown }>, block: Block, id: string, now: number): unknown {
  if (block.arguments !== undefined) return block.arguments;
  const text = typeof block.partialJson === "string" ? block.partialJson : "";
  const last = kept.get(id);
  if (last && (last.text === text || now - last.at < READ_EVERY_MS)) return last.value;
  let value: unknown = last?.value ?? {};
  try {
    value = text ? parsePartial(text) : {};
  } catch {
    // Not JSON as far as it has come (a model writing something else): what was read last stands.
  }
  kept.set(id, { text, at: now, value });
  return value;
}

/** The calls being written in the message being written: the live snapshot of each stream that has not ended. */
function beingWritten(chat: string, events: readonly PortalEvent[], now: number): ToolCallView[] {
  let kept = read.get(chat);
  if (!kept) read.set(chat, (kept = new Map()));
  const seen = new Set<string>();
  const calls: ToolCallView[] = [];
  for (const event of events) {
    if (event.seq >= 0 || event.type !== "message_snapshot") continue;
    const content = event.payload?.message?.content;
    for (const block of Array.isArray(content) ? (content as Block[]) : []) {
      if (block?.type !== "toolCall" || typeof block.id !== "string" || typeof block.name !== "string" || !block.name) continue;
      seen.add(block.id);
      const { name, input } = unwrapCall(block.name, argumentsOf(kept, block, block.id, now));
      calls.push({ name, callId: block.id, status: "writing", input });
    }
  }
  for (const id of [...kept.keys()]) if (!seen.has(id)) kept.delete(id);
  if (!kept.size) read.delete(chat);
  return calls;
}

type ToolItem = Extract<Item, { kind: "tool" }>;

/** A call of the conversation as an extension is told of it. */
const viewOf = (item: ToolItem): ToolCallView => {
  const { name, input } = unwrapCall(item.name, item.args);
  // A call the run ended without never said how it came out: it is over, and did not succeed.
  const status = item.interrupted ? "error" : item.status;
  return { name, callId: item.callId, status, input, ...(item.output !== undefined ? { output: item.output } : {}), ...(item.details !== undefined ? { details: item.details } : {}) };
};

/** The calls of a chat being written and running, oldest first, and a way to find any call of it by its id, ended or not. */
export function openCalls(chat: string, events: readonly PortalEvent[], items: readonly Item[], now = Date.now()): { calls: ToolCallView[]; call: (callId: string) => ToolCallView | undefined } {
  const writing = beingWritten(chat, events, now);
  const tools = items.filter((item): item is ToolItem => item.kind === "tool" && typeof item.callId === "string");
  const running = tools.filter((item) => item.status === "running" && !item.interrupted).map(viewOf);
  const started = new Set(running.map((call) => call.callId));
  const calls = [...running, ...writing.filter((call) => !started.has(call.callId))];
  return {
    calls,
    call: (callId) => {
      const open = calls.find((call) => call.callId === callId);
      if (open) return open;
      for (let i = tools.length - 1; i >= 0; i--) if (tools[i].callId === callId) return viewOf(tools[i]);
      return undefined;
    },
  };
}

/** The chat left the screen: what was read of its calls goes. */
export function forgetOpenCalls(chat: string): void {
  read.delete(chat);
}
