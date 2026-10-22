// Development-only fixture: the chat's pictures — made, being made, not made — without a server, drawn by the Media
// extension's cards (extensions/media), loaded as the app loads it.
// Open /tests/extension.html?page=media/pictures. `window.emit(type, payload)` adds an event as the server would send it, to finish a picture that is being made.
// Pictures are fetched from /api/sessions/preview/picture?path=…, which a test answers.
// The end of a call says what the portal found of the files it gave (`portalFiles`).
import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { Chat } from '../../../../core/web/src/components/Chat';
import type { PortalEvent, Session } from '../../../../core/web/src/api';
import { installMotion } from '../../../../core/web/src/motion';
import { startExtensions } from '../../../../core/web/src/extensions/loader';
import '../../../../core/web/src/styles';
// The page's own switch, as main.tsx has it: the tests turn the animations on and off in storage.
installMotion();
// The installed extensions, loaded as the app loads them: the browser test installs Media (`installed` in tests/browser/portal-mock.ts).
startExtensions();

const now = Date.now();
let seq = 0;
const ev = (type: string, payload: any = {}, ago = 0): PortalEvent => ({ seq: ++seq, type, at: now - ago * 1000, payload });
const made = (id: string, path: string, title: string) => ({ toolCallId: id, toolName: 'generate_image', result: { content: [{ type: 'text', text: `Generated and shown to the user: ${path}` }], details: { files: [{ path, title }] } }, portalFiles: [{ path, kind: 'picture', title }] });
const events: PortalEvent[] = [
  ev('portal_prompt', { message: 'Paint a few pictures.' }, 60),
  ev('turn_start', {}, 59),
  // Made: a size was asked for.
  ev('tool_execution_start', { toolCallId: 'done', toolName: 'generate_image', args: { prompt: 'A lighthouse at dusk, oil painting', title: 'A lighthouse at dusk', size: '1536x1024' } }, 50),
  ev('tool_execution_end', made('done', 'generated-images/lighthouse.png', 'A lighthouse at dusk'), 40),
  // Not made: the endpoint said no.
  ev('tool_execution_start', { toolCallId: 'failed', toolName: 'generate_image', args: { prompt: 'A cat on a sofa' } }, 39),
  ev('tool_execution_end', { toolCallId: 'failed', toolName: 'generate_image', isError: true, result: { content: [{ type: 'text', text: 'The image endpoint answered 401: the key was refused' }] } }, 38),
  // Not made: a run that ended while it was going on, and a new one began.
  ev('tool_execution_start', { toolCallId: 'cut', toolName: 'generate_image', args: { prompt: 'A castle in the clouds' } }, 30),
  ev('agent_start', {}, 20),
  // Being made: one with a size, and an edit of a picture in the folder.
  ev('tool_execution_start', { toolCallId: 'making', toolName: 'generate_image', args: { prompt: 'A foggy harbour at first light', title: 'A foggy harbour', size: '1024x1536' } }, 6),
  ev('tool_execution_start', { toolCallId: 'editing', toolName: 'edit_image', args: { path: 'photos/dog.png', prompt: 'Make it snow', title: 'The dog in the snow' } }, 5),
];

const session = { id: 'preview', title: 'Pictures', workspace: '/workspaces/pithagoras', executor: 'host', status: 'running', created_at: '', updated_at: '', last_error: null, pinned: false, provider: 'llama-server', model: 'Model A', thinking_level: 'medium' } as Session;
const noop = async () => {};

function Fixture() {
  const [shown, setShown] = React.useState(events);
  (window as any).emit = (type: string, payload: any) => setShown((list) => [...list, { seq: ++seq, type, at: Date.now(), payload }]);
  (window as any).madePayload = made;
  (window as any).startPayload = (toolCallId: string, toolName: string, args: any) => ({ toolCallId, toolName, args });
  return <div style={{ height: '100vh' }}><Chat session={session} events={shown} onSend={noop} onEditMessage={noop} onDeleteMessage={noop} onTakeBackQueued={noop} onSendQueuedNow={noop} onAbort={noop} onClientCommand={noop} onRename={noop} onSetMode={noop} loading={false} /></div>;
}
createRoot(document.getElementById('root')!).render(<BrowserRouter><Fixture /></BrowserRouter>);
