import { nanoid } from 'nanoid';
import type { EventRow } from './db.js';

type Store = (session: string, type: string, payload: unknown) => EventRow;
/** One current snapshot per message/tool, never a growing list of token events. */
export class LiveEvents {
  private messages = new Map<string, { streamId: string; message: any; at: string }>();
  private tools = new Map<string, Map<string, EventRow>>();
  private sequence = -Date.now() * 1000;
  constructor(private store: Store) {}

  private live(session: string, type: string, payload: unknown, at = new Date().toISOString()): EventRow {
    return { seq: --this.sequence, session_id: session, type, payload: JSON.stringify(payload), created_at: at };
  }

  record(session: string, type: string, payload: any): EventRow {
    if (type === 'message_update') {
      let state = this.messages.get(session);
      if (!state) {
        state = { streamId: nanoid(), message: { role: 'assistant', content: [] }, at: new Date().toISOString() };
        this.messages.set(session, state);
      }
      const inner = payload?.assistantMessageEvent;
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
      let tools = this.tools.get(session);
      if (!tools) this.tools.set(session, tools = new Map());
      tools.set(String(payload?.toolCallId ?? payload?.toolName ?? ''), row);
      return row;
    }
    if (type === 'message_end' && payload?.message?.role === 'assistant') {
      const state = this.messages.get(session);
      const row = this.store(session, type, { ...payload, ...(state && { streamId: state.streamId }) });
      this.messages.delete(session);
      return row;
    }
    if (type === 'tool_execution_end') {
      const row = this.store(session, type, payload);
      const tools = this.tools.get(session);
      tools?.delete(String(payload?.toolCallId ?? payload?.toolName ?? ''));
      if (!tools?.size) this.tools.delete(session);
      return row;
    }
    return this.store(session, type, payload);
  }

  snapshot(session: string): EventRow[] {
    const state = this.messages.get(session);
    const rows = state ? [this.live(session, 'message_snapshot', {
      streamId: state.streamId, message: state.message,
    }, state.at)] : [];
    return [...rows, ...(this.tools.get(session)?.values() ?? [])];
  }

  clear(session: string): void {
    this.messages.delete(session);
    this.tools.delete(session);
  }
}
