import type { PortalEvent } from "./api";
import type { Item } from "./transcript";
import { SHELL_TOOL } from "./tool-activity";

import { msg, t } from "./i18n";
/** What a subagent that gives no name is called: kept as the English, said where it is drawn. */
const UNNAMED = msg("Subagent");

/** A subagent's name as it is shown. */
export const subagentName = (agent: { label: string }): string => (agent.label === UNNAMED ? t(UNNAMED) : agent.label);

/**
 * The agents working beside the main one, as the chat shows them.
 *
 * Two kinds, neither known by name. An extension that speaks the subagent
 * protocol (server/src/subagent-protocol.ts) hands over its child's own
 * events, so the child is drawn like the main conversation and can be spoken
 * to if it said so. Any other tool that keeps reporting while it runs — a
 * research tool, a delegate — is shown by what it reports: its text, and the
 * steps in its details where they look like steps.
 */
export interface Subagent {
  /** The protocol's id, or `tool:<call id>`. */
  id: string;
  kind: "protocol" | "tool";
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
  /** Protocol subagents: the child's events, in the shape the main transcript reads. */
  events: PortalEvent[];
}

type ToolItem = Extract<Item, { kind: "tool" }>;


const textOf = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.filter((c: any) => c?.type === "text").map((c: any) => c.text ?? "").join("")
      : "";

/** A child's event as the main transcript would read it: what was asked of it is a prompt. */
function asPortalEvent(seq: number, at: number | undefined, event: any): PortalEvent | undefined {
  if (event?.type === "message_start" && event.message?.role === "user") return undefined;
  if (event?.type === "message_end" && event.message?.role === "user") {
    return { seq, at, type: "portal_prompt", payload: { message: textOf(event.message.content) } };
  }
  return { seq, at, type: String(event?.type), payload: event };
}

/** A line saying where a tool that reports its own progress has got to. */
function toolDetail(item: ToolItem): string | undefined {
  const d = item.details as any;
  for (const key of ["phase", "status", "stage", "step"]) if (typeof d?.[key] === "string" && d[key]) return d[key];
  const lines = item.output?.trim().split("\n");
  const last = lines?.[lines.length - 1]?.trim();
  return last && last.length <= 160 ? last : undefined;
}

/** A tool whose run is worth a window of its own: it kept reporting, and it is not a shell (that has the terminal). */
const watchable = (item: ToolItem) =>
  !SHELL_TOOL.test(item.name) && ((item.updates ?? 0) > 0 || (item.details !== undefined && item.status === "running"));

/**
 * `ended`: the process that ran the extensions is gone (an error, a restart),
 * so no protocol subagent can still be running, whatever it last said.
 */
export function subagents(events: PortalEvent[], items: Item[], ended = false): Subagent[] {
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
        kind: "protocol",
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
        kind: "protocol",
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
  const tools = new Map(items.flatMap((i) => (i.kind === "tool" && i.callId ? [[i.callId, i] as const] : [])));
  for (const sub of order) {
    if (sub.status !== "running" || sub.detached) continue;
    const tool = sub.toolCallId ? tools.get(sub.toolCallId) : undefined;
    if (ended || (tool && tool.status !== "running")) {
      sub.status = "stopped";
      sub.until ??= tool?.until;
      sub.input = false;
      sub.stop = false;
    }
  }

  // A tool the protocol already covers is not listed twice.
  const covered = new Set(order.map((s) => s.toolCallId).filter(Boolean));
  for (const item of items) {
    if (item.kind !== "tool" || !watchable(item) || (item.callId && covered.has(item.callId))) continue;
    order.push({
      id: `tool:${item.callId ?? item.id}`,
      kind: "tool",
      label: item.name,
      status: item.status,
      detail: toolDetail(item),
      since: item.since,
      until: item.until,
      input: false,
      stop: false,
      toolCallId: item.callId,
      events: [],
    });
  }
  return order.sort((a, b) => (a.since ?? 0) - (b.since ?? 0));
}

/** The steps a tool reports in its details, where they look like steps: `items` or `steps` of text and tool calls. */
export function reportedSteps(details: unknown): { type: "text" | "toolCall"; text?: string; name?: string; args?: unknown }[] {
  const d = details as any;
  const list = Array.isArray(d?.items) ? d.items : Array.isArray(d?.steps) ? d.steps : [];
  return list
    .filter((s: any) => (s?.type === "text" && typeof s.text === "string") || (s?.type === "toolCall" && typeof s.name === "string"))
    .map((s: any) => (s.type === "text" ? { type: "text", text: s.text } : { type: "toolCall", name: s.name, args: s.args }));
}

/**
 * `next`, with each subagent that has not changed since `prev` kept as the
 * object it was: nothing about it differs, nor how many events it has, nor
 * the last of them.
 */
export function stableSubagents(prev: Subagent[], next: Subagent[]): Subagent[] {
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
