// Development-only fixture: the chat's clips — made, being made, not made, shown — without a server.
// Open /tests/videos.html. `window.emit(type, payload)` adds an event as the server would send it, to finish a clip that is being made.
// Clips are fetched from /api/sessions/preview/video?path=…, which a test answers.
// The portal's own generate_video says so when it starts (`portalVideo`), as its server passes it on; a tool of the same name from an extension does not.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { Chat } from '../src/components/Chat';
import type { PortalEvent, Session } from '../src/api';
import { installMotion } from '../src/motion';
import '../src/styles';
// The page's own switch, as main.tsx has it: the tests turn the animations on and off in storage.
installMotion();

const now = Date.now();
let seq = 0;
const ev = (type: string, payload: any = {}, ago = 0): PortalEvent => ({ seq: ++seq, type, at: now - ago * 1000, payload });
const own = { portalVideo: true };
const made = (id: string, path: string, title: string) => ({ toolCallId: id, toolName: 'generate_video', result: { content: [{ type: 'text', text: `Generated and shown to the user: ${path}` }], details: { path, title, portalVideo: true } } });
const events: PortalEvent[] = [
  ev('portal_prompt', { message: 'Make a few videos.' }, 60),
  ev('turn_start', {}, 59),
  // Made: a size was asked for.
  ev('tool_execution_start', { toolCallId: 'done', toolName: 'generate_video', ...own, args: { prompt: 'A fox in the snow', title: 'A fox in the snow', size: '832x480', seconds: 2 } }, 50),
  ev('tool_execution_end', made('done', 'generated-videos/fox.webm', 'A fox in the snow'), 40),
  // Not made: the endpoint said no.
  ev('tool_execution_start', { toolCallId: 'failed', toolName: 'generate_video', ...own, args: { prompt: 'A cat on a sofa' } }, 39),
  ev('tool_execution_end', { toolCallId: 'failed', toolName: 'generate_video', isError: true, result: { content: [{ type: 'text', text: 'The video endpoint answered 400: invalid generation parameters' }] } }, 38),
  // Not made: a run that ended while it was going on, and a new one began.
  ev('tool_execution_start', { toolCallId: 'cut', toolName: 'generate_video', ...own, args: { prompt: 'A castle in the clouds' } }, 30),
  ev('agent_start', {}, 20),
  // Another extension's tool of the name, which pi may keep in the portal's place: a plain tool card, running and failed.
  ev('tool_execution_start', { toolCallId: 'theirs', toolName: 'generate_video', args: { prompt: 'A dragon over the sea' } }, 8),
  ev('tool_execution_start', { toolCallId: 'theirs-failed', toolName: 'generate_video', args: { prompt: 'A robot in a garden' } }, 8),
  ev('tool_execution_end', { toolCallId: 'theirs-failed', toolName: 'generate_video', isError: true, result: { content: [{ type: 'text', text: 'No key set for the video service' }] } }, 7),
  // A clip shown that was not made here.
  ev('tool_execution_start', { toolCallId: 'shown', toolName: 'show_video', args: { path: 'clips/harbour.mp4', title: 'The harbour' } }, 7),
  ev('tool_execution_end', { toolCallId: 'shown', toolName: 'show_video', result: { content: [{ type: 'text', text: 'Shown to the user: clips/harbour.mp4' }], details: { path: 'clips/harbour.mp4', title: 'The harbour' } } }, 6),
  // Being made.
  ev('tool_execution_start', { toolCallId: 'making', toolName: 'generate_video', ...own, args: { prompt: 'A foggy harbour at first light', title: 'A foggy harbour', size: '832x480' } }, 6),
];

const session = { id: 'preview', title: 'Videos', workspace: '/workspaces/pithagoras', executor: 'host', status: 'running', created_at: '', updated_at: '', last_error: null, pinned: false, provider: 'llama-server', model: 'Model A', thinking_level: 'medium' } as Session;
const noop = async () => {};

function Fixture() {
  const [shown, setShown] = React.useState(events);
  (window as any).emit = (type: string, payload: any) => setShown((list) => [...list, { seq: ++seq, type, at: Date.now(), payload }]);
  (window as any).madePayload = made;
  return <div style={{ height: '100vh' }}><Chat session={session} events={shown} onSend={noop} onEditMessage={noop} onDeleteMessage={noop} onTakeBackQueued={noop} onSendQueuedNow={noop} onAbort={noop} onClientCommand={noop} onRename={noop} loading={false} /></div>;
}
createRoot(document.getElementById('root')!).render(<BrowserRouter><Fixture /></BrowserRouter>);
