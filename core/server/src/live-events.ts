import { nanoid } from 'nanoid';
import type { EventRow } from './db.js';
import type { Timings } from './llama-progress.js';

type Store = (session: string, type: string, payload: unknown) => EventRow;
/** One current snapshot per message/tool, never a growing list of token events. */
export class LiveEvents {
  /** `thinkingSince`/`thinkingUntil`: epoch ms of the reasoning's first and last token, kept on message_end for "Thought for 12s". */
  private messages = new Map<string, { streamId: string; message: any; at: string; thinkingSince?: number; thinkingUntil?: number }>();
  private tools = new Map<string, Map<string, EventRow>>();
  /** How many updates each running tool call has streamed: kept on its end. See tool_execution_end. */
  private updates = new Map<string, Map<string, number>>();
  /**
   * Each subagent's message so far and its tools' latest output, per session:
   * a page that opens, or reconnects, mid-message gets them in the snapshot.
   */
  private subagents = new Map<string, Map<string, { text: string; thinking: string; tools: Map<string, EventRow> }>>();
  /** What llama.cpp measured for the answer being written, until its message_end takes it. */
  private measured = new Map<string, Timings>();
  private sequence = -Date.now() * 1000;
  constructor(private store: Store) {}

  private live(session: string, type: string, payload: unknown, at = new Date().toISOString()): EventRow {
    return { seq: --this.sequence, session_id: session, type, payload: JSON.stringify(payload), created_at: at };
  }

  /** llama.cpp's figures for the answer being written: see message_end. */
  timings(session: string, timings: Timings): void {
    this.measured.set(session, timings);
  }

  /** An event that is only ever live, never kept: numbered like the rest that are. */
  ephemeral(session: string, type: string, payload: unknown): EventRow {
    return this.live(session, type, payload);
  }

  /** A subagent's stream: live only, and what it has said so far kept for the snapshot. */
  subagentLive(session: string, payload: any): EventRow {
    const row = this.live(session, 'portal_subagent_live', payload);
    const id = String(payload?.id ?? '');
    const inner = payload?.event ?? {};
    let all = this.subagents.get(session);
    if (!all) this.subagents.set(session, all = new Map());
    let state = all.get(id);
    if (!state) all.set(id, state = { text: '', thinking: '', tools: new Map() });
    const delta = inner.assistantMessageEvent;
    if (inner.type === 'message_update' && typeof delta?.delta === 'string') {
      if (delta.type === 'text_delta') state.text += delta.delta;
      if (delta.type === 'thinking_delta') state.thinking += delta.delta;
    }
    if (inner.type === 'tool_execution_update') state.tools.set(String(inner.toolCallId ?? ''), row);
    return row;
  }

  /** What a stored subagent event settles: its message ended, a tool finished, or it did. */
  private subagentSettled(session: string, payload: any): void {
    const all = this.subagents.get(session);
    const id = String(payload?.id ?? '');
    const state = all?.get(id);
    if (!all || !state) return;
    const inner = payload?.event ?? {};
    if (payload?.op === 'end') all.delete(id);
    else if (inner.type === 'message_end') { state.text = ''; state.thinking = ''; }
    else if (inner.type === 'tool_execution_end') state.tools.delete(String(inner.toolCallId ?? ''));
    if (!all.size) this.subagents.delete(session);
  }

  record(session: string, type: string, payload: any): EventRow {
    if (type === 'portal_subagent') this.subagentSettled(session, payload);
    // A new answer: figures left from one that never ended are not its.
    if (type === 'message_start' && payload?.message?.role === 'assistant') this.measured.delete(session);
    if (type === 'message_update') {
      let state = this.messages.get(session);
      if (!state) {
        state = { streamId: nanoid(), message: { role: 'assistant', content: [] }, at: new Date().toISOString() };
        this.messages.set(session, state);
      }
      const inner = payload?.assistantMessageEvent;
      if (typeof inner?.type === 'string' && inner.type.startsWith('thinking_')) {
        const now = Date.now();
        state.thinkingSince ??= now;
        state.thinkingUntil = now;
      }
      const message = inner?.partial ?? payload?.message;
      if (message) state.message = message;
      else if (typeof inner?.delta === 'string' && ['text_delta', 'thinking_delta'].includes(inner.type)) {
        const index = Number.isInteger(inner.contentIndex) ? inner.contentIndex : 0;
        const kind = inner.type === 'text_delta' ? 'text' : 'thinking';
        const block = state.message.content[index] ??= { type: kind, [kind]: '' };
        block[kind] += inner.delta;
      }
      // The SDK's full snapshot stays in this buffer; clients receive only the delta.
      const { partial: _partial, ...update } = inner ?? {};
      return this.live(session, type, { type, streamId: state.streamId, assistantMessageEvent: update });
    }
    if (type === 'tool_execution_update') {
      const row = this.live(session, type, payload);
      const call = String(payload?.toolCallId ?? payload?.toolName ?? '');
      let tools = this.tools.get(session);
      if (!tools) this.tools.set(session, tools = new Map());
      tools.set(call, row);
      let counts = this.updates.get(session);
      if (!counts) this.updates.set(session, counts = new Map());
      counts.set(call, (counts.get(call) ?? 0) + 1);
      return row;
    }
    if (type === 'message_end' && payload?.message?.role === 'assistant') {
      const state = this.messages.get(session);
      // Kept on the message for the figures under it: llama.cpp's own where the model is served by it, and
      // otherwise when its first token came, for how fast the rest followed.
      const timings = this.measured.get(session);
      this.measured.delete(session);
      const row = this.store(session, type, {
        ...payload,
        ...(state && { streamId: state.streamId, ...thinkingTimes(state), firstTokenAt: Date.parse(state.at) }),
        ...(timings && { timings }),
      });
      this.messages.delete(session);
      return row;
    }
    if (type === 'tool_execution_end') {
      const call = String(payload?.toolCallId ?? payload?.toolName ?? '');
      // Its updates are never stored: that it reported as it went is, so a page
      // loaded later still knows it was one worth watching.
      const counts = this.updates.get(session);
      const updates = counts?.get(call);
      counts?.delete(call);
      if (!counts?.size) this.updates.delete(session);
      const row = this.store(session, type, updates ? { ...payload, updates } : payload);
      const tools = this.tools.get(session);
      tools?.delete(call);
      if (!tools?.size) this.tools.delete(session);
      return row;
    }
    return this.store(session, type, payload);
  }

  snapshot(session: string): EventRow[] {
    const state = this.messages.get(session);
    const rows = state ? [this.live(session, 'message_snapshot', {
      streamId: state.streamId, message: state.message, ...thinkingTimes(state),
    }, state.at)] : [];
    const subagents: EventRow[] = [];
    for (const [id, state] of this.subagents.get(session) ?? []) {
      // Each as one delta: a page adds deltas up, so the whole so far is one.
      for (const [kind, delta] of [['thinking_delta', state.thinking], ['text_delta', state.text]] as const) {
        if (delta) subagents.push(this.live(session, 'portal_subagent_live', { type: 'portal_subagent_live', op: 'event', id, event: { type: 'message_update', assistantMessageEvent: { type: kind, delta } } }));
      }
      subagents.push(...state.tools.values());
    }
    return [...rows, ...(this.tools.get(session)?.values() ?? []), ...subagents];
  }

  clear(session: string): void {
    this.messages.delete(session);
    this.measured.delete(session);
    this.tools.delete(session);
    this.updates.delete(session);
    this.subagents.delete(session);
  }
}

function thinkingTimes(state: { thinkingSince?: number; thinkingUntil?: number }) {
  return state.thinkingSince === undefined ? {} : { thinkingSince: state.thinkingSince, thinkingUntil: state.thinkingUntil };
}
