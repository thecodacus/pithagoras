// Development-only fixture: the places that count a running time, shown with nothing running until "Start".
// Start makes an agent and a job that began three seconds ago, so each must say "3s" the moment it is drawn.
import { useLayoutEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { RunningTray } from '../src/components/RunningTray';
import { SubagentPanel } from '../src/components/SubagentPanel';
import { publishChat } from '../src/extensions/chat-feed';
import { startExtensions } from '../src/extensions/loader';
import { TerminalPanel } from './terminal-panel';
import type { BackgroundJob } from '../src/api';
import type { Subagent } from '../src/subagents';
import '../src/styles';

// The job is shown where a fresh portal shows it: the terminal extension's panel, loaded as the app loads it.
startExtensions();

function Page() {
  const [began, setBegan] = useState<number | null>(null);
  const agent: Subagent = { id: 'a1', kind: 'protocol', label: 'Helper', status: began ? 'running' : 'done', since: began ?? undefined, until: began ? undefined : 1, input: false, stop: false, events: [] };
  const job: BackgroundJob = { key: 'j1', sid: 1, pids: [], command: 'sleep 100', startedAt: began ?? 0, state: began ? 'running' : 'exited', exitedAt: began ? undefined : 1, hasOutput: false, attached: false };
  // The chat as the page has it, for the terminal: before the first frame that shows the job.
  useLayoutEffect(() => publishChat('clock', { events: [], items: [], running: false, status: 'idle', loading: false, background: { supported: true, jobs: [job], statuses: [], widgets: [] }, refreshBackground: () => {} }), [began]);
  return (
    <>
      <button onClick={() => setBegan(Date.now() - 3000)}>Start</button>
      <RunningTray agents={[agent]} jobs={[job]} statuses={[]} onAgent={() => {}} onJob={() => {}} />
      <SubagentPanel sessionId="clock" agents={[agent]} items={[]} selected="a1" onSelect={() => {}} />
      <div style={{ height: 300, display: 'flex', flexDirection: 'column' }}>
        <TerminalPanel chat="clock" tab="jobs" />
      </div>
    </>
  );
}

createRoot(document.getElementById('root')!).render(<Page />);
