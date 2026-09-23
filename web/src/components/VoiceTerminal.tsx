import { useLayoutEffect } from 'react';
import type { PortalEvent } from '../api';
import { useFollowBottom } from '../use-follow-bottom';

export function terminalRuns(events: PortalEvent[]) {
  const runs: { id: string; command: string; output: string; running: boolean; error: boolean }[] = [];
  for (const event of events) {
    const p = event.payload ?? {};
    if (event.type === 'tool_execution_start' && /^(bash|shell|terminal|exec_command)$/.test(p.toolName ?? p.name ?? '')) {
      const input = p.input ?? p.args ?? p.parameters ?? {};
      runs.push({ id: p.toolCallId ?? String(event.seq), command: input.command ?? input.cmd ?? p.toolName, output: '', running: true, error: false });
    } else if (event.type === 'tool_execution_update' || event.type === 'tool_execution_end') {
      const run = p.toolCallId ? runs.find(r => r.id === p.toolCallId) : [...runs].reverse().find(r => r.running && /^(bash|shell|terminal|exec_command)$/.test(p.toolName ?? p.name ?? ''));
      if (!run) continue;
      const result = p.partialResult ?? p.result;
      const text = result?.content?.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n');
      if (typeof text === 'string') run.output = text.slice(-20000);
      if (event.type === 'tool_execution_end') { run.running = false; run.error = !!p.isError; }
    }
  }
  return runs.slice(-6);
}
export function VoiceTerminal({ events }: { events: PortalEvent[] }) {
  const { ref, onScroll, follow } = useFollowBottom<HTMLDivElement>();
  const runs = terminalRuns(events);
  // Follows new output, but leaves you where you scrolled to read earlier lines.
  // Before paint, so new lines are never shown at the old scroll position.
  useLayoutEffect(() => follow(), [events]);
  return <div ref={ref} onScroll={onScroll} className="voice-terminal-output" aria-label="Agent terminal output">
    {runs.map(run => <div key={run.id} className="voice-terminal-run">
      <div className="voice-terminal-command"><span aria-hidden>$</span><code>{run.command}</code>{run.running && <i aria-label="Command running" />}</div>
      {run.output && <pre className={run.error ? 'is-error' : ''}>{run.output.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')}</pre>}
    </div>)}
  </div>;
}
