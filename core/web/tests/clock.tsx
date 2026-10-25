// Development-only fixture: the places that count a running time, shown with nothing running until "Start".
// Start makes an extension's chip and a job that began three seconds ago, so each must say "3s" the moment it is drawn.
// (The terminal extension's own count of a job is in its tests: extensions/terminal/test/browser/clock.page.tsx; the
// subagent extension's count of a subagent in its panel, in extensions/subagent/test/browser.)
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { RunningTray, TrayChip } from '../src/components/RunningTray';
import type { BackgroundJob } from '../src/api';
import '../src/styles';

function Page() {
  const [began, setBegan] = useState<number | null>(null);
  const job: BackgroundJob = { key: 'j1', sid: 1, pids: [], command: 'sleep 100', startedAt: began ?? 0, state: began ? 'running' : 'exited', exitedAt: began ? undefined : 1, hasOutput: false, attached: false };
  return (
    <>
      <button onClick={() => setBegan(Date.now() - 3000)}>Start</button>
      <RunningTray extensions={began ? <TrayChip label="Helper" since={began} onClick={() => {}} /> : undefined} jobs={[job]} statuses={[]} onJob={() => {}} />
    </>
  );
}

createRoot(document.getElementById('root')!).render(<Page />);
