import type { ChatFeed, PortalEvent } from "@pithagoras/extension-api";

/** What a subagent that gives no name is called: kept as the English, said where it is drawn. */
export const UNNAMED = "Subagent";

/**
 * The agents working beside a chat's own, as the chat's events say them: every one an extension announced over the
 * subagent protocol, this extension's and any other's. The portal stores what the protocol says as `portal_subagent`
 * events (its finished messages, and the start and end) and passes the rest on live as `portal_subagent_live`: the
 * child's own events, which are drawn as the chat draws its own (`ui.Transcript`).
 *
 * No other tool is listed here, however long it keeps reporting while it runs (code mode, a search, a research tool):
 * its output is on its own tool card in the conversation.
 */
export interface Subagent {
  /** The id the extension gave it. */
  id: string;
  label: string;
  status: "running" | "done" | "error" | "stopped";
  /** A line on what it is doing: the extension's own words where it gave some. */
  detail?: string;
  since?: number;
  until?: number;
  /** Takes messages / can be stopped — only ever what the extension said. */
  input: boolean;
  stop: boolean;
  toolCallId?: string;
  /** Runs on after its tool call has returned: a subagent in the background. */
  detached?: boolean;
  error?: string;
  /** The child's events, in the shape the chat's own conversation is drawn from. */
  events: PortalEvent[];
}

/** A row of the chat's conversation, as far as this reads one: a tool call, with how it stands. */
type Row = { kind: string; callId?: unknown; status?: unknown; until?: unknown };

const textOf = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.filter((c: any) => c?.type === "text").map((c: any) => c.text ?? "").join("")
      : "";

/** A child's event as the chat's conversation would read it: what was asked of it is a prompt. */
function asPortalEvent(seq: number, at: number | undefined, event: any): PortalEvent | undefined {
  if (event?.type === "message_start" && event.message?.role === "user") return undefined;
  if (event?.type === "message_end" && event.message?.role === "user") {
    return { seq, at, type: "portal_prompt", payload: { message: textOf(event.message.content) } };
  }
  return { seq, at, type: String(event?.type), payload: event };
}

/**
 * `items` are the chat's conversation (`ChatFeed.items`), for how the tool calls that started them stand. `ended`: the
 * process that ran the extensions is gone (an error, a restart), so no protocol subagent can still be running,
 * whatever it last said.
 */
export function subagents(events: readonly PortalEvent[], items: readonly Row[], ended = false): Subagent[] {
  const byId = new Map<string, Subagent>();
  const order: Subagent[] = [];
  for (const ev of events) {
    if (ev.type !== "portal_subagent" && ev.type !== "portal_subagent_live") continue;
    const p = ev.payload ?? {};
    const id = typeof p.id === "string" ? p.id : undefined;
    if (!id) continue;
    let sub = byId.get(id);
    if (p.op === "start") {
      const had = sub;
      sub = {
        id,
        label: String(p.label ?? UNNAMED),
        status: "running",
        ...(typeof p.detail === "string" ? { detail: p.detail } : {}),
        ...(ev.at !== undefined ? { since: ev.at } : {}),
        input: p.input === true,
        stop: p.stop === true,
        ...(typeof p.toolCallId === "string" ? { toolCallId: p.toolCallId } : {}),
        ...(p.detached === true ? { detached: true } : {}),
        events: [],
      };
      // Said again — one that waited for a slot, now starting: the same
      // subagent, told anew what it is doing, and where it began.
      if (had) {
        Object.assign(had, { ...sub, events: had.events, since: had.since ?? sub.since });
        continue;
      }
      byId.set(id, sub);
      order.push(sub);
      continue;
    }
    // Its start is further up than the page has loaded — a long subagent's
    // steps fill what a reload reads. Still shown, from what came after.
    if (!sub) {
      sub = {
        id,
        label: UNNAMED,
        status: "running",
        input: false,
        stop: false,
        // Tied to its tool call all the same: listed once, and over when it is.
        ...(typeof p.toolCallId === "string" ? { toolCallId: p.toolCallId } : {}),
        ...(p.detached === true ? { detached: true } : {}),
        events: [],
      };
      byId.set(id, sub);
      order.push(sub);
    }
    if (p.op === "event") {
      const mapped = asPortalEvent(ev.seq, ev.at, p.event);
      if (mapped) sub.events.push(mapped);
    } else if (p.op === "end") {
      sub.status = ["done", "error", "stopped"].includes(p.status) ? p.status : "done";
      if (typeof p.error === "string") sub.error = p.error;
      if (ev.at !== undefined) sub.until = ev.at;
      sub.input = false;
      sub.stop = false;
    }
  }

  // One whose end never came is over once its process is, or once the tool
  // call that ran it has ended: nothing is left to run it. Not one that runs
  // on in the background: its call returns at once, and the chat going into
  // error is a turn that failed, not its pi gone — the portal writes its end
  // when that pi goes.
  const tools = new Map(items.flatMap((i) => (i.kind === "tool" && typeof i.callId === "string" ? [[i.callId, i] as const] : [])));
  for (const sub of order) {
    if (sub.status !== "running" || sub.detached) continue;
    const tool = sub.toolCallId ? tools.get(sub.toolCallId) : undefined;
    if (ended || (tool && tool.status !== "running")) {
      sub.status = "stopped";
      sub.until ??= typeof tool?.until === "number" ? tool.until : undefined;
      sub.input = false;
      sub.stop = false;
    }
  }

  return order.sort((a, b) => (a.since ?? 0) - (b.since ?? 0));
}

/**
 * `next`, with each subagent that has not changed since `prev` kept as the
 * object it was: nothing about it differs, nor how many events it has, nor
 * the last of them.
 */
export function stableSubagents(prev: readonly Subagent[], next: Subagent[]): Subagent[] {
  const before = new Map(prev.map((s) => [s.id, s]));
  const same = (a: Subagent, b: Subagent) => {
    if (a.events.length !== b.events.length || a.events.at(-1)?.seq !== b.events.at(-1)?.seq) return false;
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) if (k !== "events" && (a as any)[k] !== (b as any)[k]) return false;
    return true;
  };
  return next.map((s) => {
    const was = before.get(s.id);
    return was && same(was, s) ? was : s;
  });
}

// Worked out once for each state of a chat however many parts ask (the panel, its button, the tray, a card for each
// call): the chat changes with every token of a reply, and its events are read through each time.
const worked = new WeakMap<ChatFeed, Subagent[]>();
const lastOf = new Map<string, Subagent[]>();

/**
 * A chat's subagents as its feed has them now, each that has not changed the object it was: an open panel draws a
 * subagent's run again only when there is more of it, not on every word of the chat's own reply.
 */
export function agentsOf(chatId: string, feed: ChatFeed): Subagent[] {
  let agents = worked.get(feed);
  if (!agents) {
    const ended = feed.status === "interrupted" || feed.status === "error";
    agents = stableSubagents(lastOf.get(chatId) ?? [], subagents(feed.events, feed.items, ended));
    worked.set(feed, agents);
    // Only the chat on screen has a feed: another's last list is not kept.
    for (const other of lastOf.keys()) if (other !== chatId) lastOf.delete(other);
    lastOf.set(chatId, agents);
  }
  return agents;
}
