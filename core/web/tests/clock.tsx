// Development-only fixture: the places that count a running time, shown with nothing running until "Start".
// Start makes an agent and a job that began three seconds ago, so each must say "3s" the moment it is drawn.
// (The terminal extension's own count of a job is in its tests: extensions/terminal/test/browser/clock.page.tsx.)
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { RunningTray } from '../src/components/RunningTray';
import { SubagentPanel } from '../src/components/SubagentPanel';
import type { BackgroundJob } from '../src/api';
import type { Subagent } from '../src/subagents';
import '../src/styles';

function Page() {
  const [began, setBegan] = useState<number | null>(null);
  const agent: Subagent = { id: 'a1', label: 'Helper', status: began ? 'running' : 'done', since: began ?? undefined, until: began ? undefined : 1, input: false, stop: false, events: [] };
  const job: BackgroundJob = { key: 'j1', sid: 1, pids: [], command: 'sleep 100', startedAt: began ?? 0, state: began ? 'running' : 'exited', exitedAt: began ? undefined : 1, hasOutput: false, attached: false };
  return (
    <>
      <button onClick={() => setBegan(Date.now() - 3000)}>Start</button>
      <RunningTray agents={[agent]} jobs={[job]} statuses={[]} onAgent={() => {}} onJob={() => {}} />
      <SubagentPanel sessionId="clock" agents={[agent]} selected="a1" onSelect={() => {}} />
    </>
  );
}

createRoot(document.getElementById('root')!).render(<Page />);
