// Development-only fixture: one running background job whose output is read over the network, so that a test can answer it as it likes.
import { createRoot } from 'react-dom/client';
import { BackgroundJobs } from '../src/components/BackgroundJobs';
import type { BackgroundJob } from '../src/api';
import '../src/styles';

const job: BackgroundJob = { key: 'j1', sid: 1, pids: [], command: 'npm run dev', startedAt: 1, state: 'running', hasOutput: true, attached: false };

createRoot(document.getElementById('root')!).render(
  <div style={{ height: 400, display: 'flex', flexDirection: 'column' }}>
    <BackgroundJobs sessionId="jobs" state={{ supported: true, jobs: [job], statuses: [], widgets: [] }} selected="j1" onSelect={() => {}} onChanged={() => {}} />
  </div>,
);
