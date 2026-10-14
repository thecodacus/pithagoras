import type { PortalEvent } from './api';

export function resetLiveEvents(events: PortalEvent[]): PortalEvent[] {
  return events.filter(e => !(e.seq < 0 && ['message_update', 'message_snapshot', 'tool_execution_update', 'portal_subagent_live'].includes(e.type)));
}

/** The events that can end or replace a live entry: with all others there is nothing to look at. */
const SETTLES = new Set(['message_end', 'tool_execution_end', 'tool_execution_update', 'portal_subagent', 'portal_subagent_live']);

/** Whether `event` ends the live entry `e`, or says again what it said. */
function settles(e: PortalEvent, event: PortalEvent): boolean {
  const p = event.payload ?? {};
  if (event.type === 'message_end' && p.streamId && e.payload?.streamId === p.streamId) return true;
  if (event.type === 'tool_execution_end' && e.type === 'tool_execution_update' && p.toolCallId && e.payload?.toolCallId === p.toolCallId) return true;
  if (event.type === 'tool_execution_update' && e.type === 'tool_execution_update' && p.toolCallId && e.payload?.toolCallId === p.toolCallId) return true;
  // A subagent's stream, the same way: its message ends, its tool's newest output replaces the last.
  if (e.type === 'portal_subagent_live' && (event.type === 'portal_subagent' || event.type === 'portal_subagent_live') && e.payload?.id === p.id) {
    const inner = p.event ?? {}, was = e.payload?.event ?? {};
    if (p.op === 'end') return true;
    if (inner.type === 'message_end' && was.type === 'message_update') return true;
    if ((inner.type === 'tool_execution_end' || inner.type === 'tool_execution_update') && was.type === 'tool_execution_update' && was.toolCallId === inner.toolCallId) return true;
  }
  return false;
}

/**
 * The answer being written, as one entry: what it was, and what the token adds.
 *
 * Each token used to be an event of its own, kept until the message ended, so a
 * long reply was thousands of entries that each one after it copied, and the
 * whole transcript was read through again for it. This is the shape the server
 * sends a page that opens mid-message (`message_snapshot`), and the transcript
 * reads it the same. A block goes last when it is added to, which is how
 * `activity` knows what was written last; a tool call's arguments, which the
 * page does not show, are one block saying that.
 *
 * Null for an update that adds nothing: a block starting or ending.
 */
function writing(into: PortalEvent | undefined, event: PortalEvent): PortalEvent | null {
  const p = event.payload ?? {};
  const inner = p.assistantMessageEvent ?? {};
  const delta = typeof inner.delta === 'string' ? inner.delta : '';
  if (!delta) return null;
  const kind = inner.type === 'thinking_delta' ? 'thinking' : inner.type === 'text_delta' ? 'text' : 'toolCall';
  const was = into?.payload ?? {};
  const content: any[] = Array.isArray(was.message?.content) ? [...was.message.content] : [];
  if (kind === 'toolCall') {
    if (content[content.length - 1]?.type !== 'toolCall') content.push({ type: 'toolCall' });
  } else {
    const at = content.map(c => c?.type).lastIndexOf(kind);
    const block = at >= 0 ? content.splice(at, 1)[0] : { type: kind, [kind]: '' };
    content.push({ ...block, [kind]: (block[kind] ?? '') + delta });
  }
  // When the reasoning ran, from its first token to its last.
  const times = kind === 'thinking' && event.at !== undefined
    ? { thinkingSince: was.thinkingSince ?? event.at, thinkingUntil: event.at }
    : was.thinkingSince !== undefined ? { thinkingSince: was.thinkingSince, thinkingUntil: was.thinkingUntil } : {};
  return { seq: event.seq, type: 'message_snapshot', ...(event.at !== undefined ? { at: event.at } : {}), payload: { streamId: p.streamId, message: { role: 'assistant', content }, ...times } };
}

/**
 * Live events added to the list, in order: a message ending takes its stream
 * with it, and a tool's newer output replaces its older. The list is copied
 * once for all of them: a page sent a long conversation at once, or a burst of
 * tokens, copied it per event.
 */
export function appendLiveEvents(events: PortalEvent[], batch: readonly PortalEvent[]): PortalEvent[] {
  if (!batch.length) return events;
  const out: (PortalEvent | null)[] = events.slice();
  // Where the live entries are: the only ones an event can end, and few, wherever they sit.
  let live: number[] = [];
  for (let i = 0; i < out.length; i++) if (out[i]!.seq < 0) live.push(i);
  let gaps = false;
  for (const event of batch) {
    const p = event.payload ?? {};
    if (event.type === 'message_update' && event.seq < 0 && p.streamId) {
      let at = -1;
      for (let j = live.length - 1; j >= 0; j--) {
        const e = out[live[j]]!;
        if (e.type === 'message_snapshot' && e.payload?.streamId === p.streamId) {
          at = live[j];
          break;
        }
      }
      const next = writing(at >= 0 ? out[at]! : undefined, event);
      if (!next) continue;
      if (at >= 0) out[at] = next;
      else live.push(out.push(next) - 1);
      continue;
    }
    if (live.length && SETTLES.has(event.type)) {
      live = live.filter(i => {
        if (!settles(out[i]!, event)) return true;
        out[i] = null;
        gaps = true;
        return false;
      });
    }
    out.push(event);
    if (event.seq < 0) live.push(out.length - 1);
  }
  return gaps ? out.filter((e): e is PortalEvent => e !== null) : (out as PortalEvent[]);
}

/** Replace completed live streams with their durable result, keeping the stable message id. */
export function appendLiveEvent(events: PortalEvent[], event: PortalEvent): PortalEvent[] {
  return appendLiveEvents(events, [event]);
}
