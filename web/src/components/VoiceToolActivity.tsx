import { useEffect, useRef, useState } from 'react';
import { LuCheck, LuSparkles } from 'react-icons/lu';
import type { PortalEvent } from '../api';
import { toolKind } from '../tool-kind';

type Action = { id: number; callId: string; label: string; detail: string; done: boolean; failed: boolean; side?: 'left' | 'right'; lane?: number };
function action(event: PortalEvent): Action {
  const p = event.payload ?? {}, input = p.input ?? p.args ?? p.parameters ?? {};
  const name = String(p.toolName ?? p.name ?? 'tool');
  const label = { command: 'Running a command', browser: 'Using the browser', search: 'Searching', read: 'Reading a file', edit: 'Updating a file', tool: `Using ${name.replace(/[_\.]+/g, ' ')}` }[toolKind(p)];
  const detail = [input.description, input.command, input.cmd, input.url, input.path, input.file_path, input.query, input.tool].find(v => typeof v === 'string') ?? '';
  return { id: event.seq, callId: String(p.toolCallId ?? ''), label, detail: detail.replace(/\s+/g, ' ').slice(0, 100), done: false, failed: false };
}

export function VoiceToolActivity({ events }: { events: PortalEvent[] }) {
  const seen = useRef(Math.max(0, ...events.map(e => e.seq)));
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  const sequence = useRef(0);
  const [actions, setActions] = useState<Action[]>([]);
  useEffect(() => {
    const fresh = events.filter(e => e.seq > seen.current);
    if (!fresh.length) return;
    seen.current = Math.max(seen.current, ...fresh.map(e => e.seq));
    const added = fresh.filter(e => e.type === 'tool_execution_start').map(event => {
      const index = sequence.current++;
      return { ...action(event), side: index % 2 ? 'right' as const : 'left' as const, lane: Math.floor(index / 2) % 2 };
    });
    const ended = fresh.filter(e => e.type === 'tool_execution_end');
    if (added.length || ended.length) setActions(current => [...current, ...added].slice(-4).map(item => {
      const end = ended.find(e => item.callId && e.payload?.toolCallId === item.callId);
      return end ? { ...item, done: true, failed: !!end.payload?.isError } : item;
    }));
    for (const item of added) {
      const timer = setTimeout(() => { timers.current.delete(timer); setActions(current => current.filter(a => a.id !== item.id)); }, 8000);
      timers.current.add(timer);
    }
  }, [events]);
  useEffect(() => () => { for (const timer of timers.current) clearTimeout(timer); }, []);
  return <div className="voice-tool-activity" aria-label="Tool activity" aria-live="polite" aria-relevant="additions">
    {actions.map(item => <div key={item.id} className={`voice-tool-float flies-${item.side} flight-lane-${item.lane}`}>
      {item.done && !item.failed ? <LuCheck aria-hidden="true" /> : <LuSparkles aria-hidden="true" />}
      <div><span>{item.failed ? 'Action failed' : item.label}</span>{item.detail && <p>{item.detail}</p>}</div>
    </div>)}
  </div>;
}
