// Development-only fixture: a chat whose agent works on kanban boards, without a portal, drawn with the Kanban
// extension's cards and panel (extensions/kanban), loaded as the app loads it.
// Open /tests/extension.html?page=kanban/chat. `window.emit(type, payload)` adds an event as the server would send it:
// the start and the end of a kanban call, with the board it touched in its details.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { Chat } from '../../../../core/web/src/components/Chat';
import { ConfirmHost } from '../../../../core/web/src/components/ConfirmDialog';
import type { PortalEvent, Session } from '../../../../core/web/src/api';
import { installMotion } from '../../../../core/web/src/motion';
import { startExtensions } from '../../../../core/web/src/extensions/loader';
import '../../../../core/web/src/styles';
installMotion();
// The installed extensions, loaded as the app loads them: the browser test installs Kanban (`installed` in tests/browser/portal-mock.ts).
startExtensions();

const now = Date.now();
let seq = 0;
const ev = (type: string, payload: any = {}, ago = 0): PortalEvent => ({ seq: ++seq, type, at: now - ago * 1000, payload });
const events: PortalEvent[] = [
  ev('portal_prompt', { message: 'Keep the release board up to date while you fix the flaky test.' }, 60),
  ev('message_end', { message: { role: 'assistant', content: [{ type: 'text', text: 'I will move the card as I go.' }] } }, 59),
];

const session = { id: 'preview', title: 'Plan the release', workspace: '/workspaces/pithagoras', executor: 'host', status: 'idle', created_at: '', updated_at: '', last_error: null, pinned: false, provider: 'llama-server', model: 'Model A', thinking_level: 'medium' } as Session;
const noop = async () => {};

function Fixture() {
  const [shown, setShown] = React.useState(events);
  (window as any).emit = (type: string, payload: any) => setShown((list) => [...list, { seq: ++seq, type, at: Date.now(), payload }]);
  return <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}><div style={{ flex: 1, minHeight: 0 }}><Chat session={session} events={shown} onSend={noop} onEditMessage={noop} onDeleteMessage={noop} onTakeBackQueued={noop} onSendQueuedNow={noop} onAbort={noop} onClientCommand={noop} onRename={noop} onSetMode={noop} loading={false} /></div></div>;
}
createRoot(document.getElementById('root')!).render(<BrowserRouter><Fixture /><ConfirmHost /></BrowserRouter>);
