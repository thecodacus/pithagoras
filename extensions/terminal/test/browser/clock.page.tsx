// Development-only fixture: the terminal's Background tab with a job that is not running until "Start". Start makes it
// one that began three seconds ago, so its time must say "3s" the moment it is drawn, however long the page sat before.
import { useLayoutEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { BackgroundJob } from '../../../../core/web/src/api';
import { publishChat } from '../../../../core/web/src/extensions/chat-feed';
import { startExtensions } from '../../../../core/web/src/extensions/loader';
import { TerminalPanel } from './terminal-panel';
import '../../../../core/web/src/styles';

startExtensions();

function Page() {
  const [began, setBegan] = useState<number | null>(null);
  const job: BackgroundJob = { key: 'j1', sid: 1, pids: [], command: 'sleep 100', startedAt: began ?? 0, state: began ? 'running' : 'exited', exitedAt: began ? undefined : 1, hasOutput: false, attached: false };
  // The chat as the page has it, for the terminal: before the first frame that shows the job.
  useLayoutEffect(() => publishChat('clock', { events: [], items: [], calls: [], call: () => undefined, running: false, status: 'idle', loading: false, background: { supported: true, jobs: [job], statuses: [], widgets: [] }, refreshBackground: () => {} }), [began]);
  return (
    <>
      <button onClick={() => setBegan(Date.now() - 3000)}>Start</button>
      <div style={{ height: 300, display: 'flex', flexDirection: 'column' }}>
        <TerminalPanel chat="clock" tab="jobs" />
      </div>
    </>
  );
}

createRoot(document.getElementById('root')!).render(<Page />);
