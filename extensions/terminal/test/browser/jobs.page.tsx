// Development-only fixture: one running background job whose output is read over the network, so that a test can answer it as it likes.
// Shown where a fresh portal shows it: the terminal extension's panel, on its Background tab, loaded as the app loads it.
import { createRoot } from 'react-dom/client';
import type { BackgroundJob } from '../../../../core/web/src/api';
import { publishChat } from '../../../../core/web/src/extensions/chat-feed';
import { startExtensions } from '../../../../core/web/src/extensions/loader';
import { TerminalPanel } from './terminal-panel';
import '../../../../core/web/src/styles';

const job: BackgroundJob = { key: 'j1', sid: 1, pids: [], command: 'npm run dev', startedAt: 1, state: 'running', hasOutput: true, attached: false };
publishChat('jobs', { events: [], items: [], calls: [], call: () => undefined, running: false, status: 'idle', loading: false, background: { supported: true, jobs: [job], statuses: [], widgets: [] }, refreshBackground: () => {} });
startExtensions();

createRoot(document.getElementById('root')!).render(
  <div style={{ height: 400, display: 'flex', flexDirection: 'column' }}>
    <TerminalPanel chat="jobs" tab="jobs" />
  </div>,
);
