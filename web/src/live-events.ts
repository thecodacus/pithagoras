import type { PortalEvent } from './api';

export function resetLiveEvents(events: PortalEvent[]): PortalEvent[] {
  return events.filter(e => !(e.seq < 0 && ['message_update', 'message_snapshot', 'tool_execution_update'].includes(e.type)));
}

/** Replace completed live streams with their durable result, keeping the stable message id. */
export function appendLiveEvent(events: PortalEvent[], event: PortalEvent): PortalEvent[] {
  const p = event.payload ?? {};
  const kept = events.filter(e => {
    if (e.seq >= 0) return true;
    if (event.type === 'message_end' && p.streamId && e.payload?.streamId === p.streamId) return false;
    if (event.type === 'tool_execution_end' && e.type === 'tool_execution_update' && p.toolCallId && e.payload?.toolCallId === p.toolCallId) return false;
    if (event.type === 'tool_execution_update' && e.type === 'tool_execution_update' && p.toolCallId && e.payload?.toolCallId === p.toolCallId) return false;
    return true;
  });
  return [...kept, event];
}
