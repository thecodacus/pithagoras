// Development-only fixture: a chat that goes into voice mode, with buttons for the agent's generate_image calls, whose
// cards are the Media extension's (extensions/media), loaded as the app loads it.
// Open /tests/extension.html?page=media/voice. Pictures are fetched from /api/sessions/test/picture?path=…, which a test answers.
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { Chat } from '../../../../core/web/src/components/Chat';
import type { PortalEvent, Session } from '../../../../core/web/src/api';
import { startExtensions } from '../../../../core/web/src/extensions/loader';
import '../../../../core/web/src/styles';
// The installed extensions, loaded as the app loads them: the browser test installs Media (`installed` in tests/browser/portal-mock.ts).
startExtensions();
// A microphone that hears nothing, for voice mode to listen to.
const microphone = new AudioContext();
let destination = microphone.createMediaStreamDestination();
Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { value: async () => {
  if (destination.stream.getTracks().every(t => t.readyState === 'ended')) destination = microphone.createMediaStreamDestination();
  return destination.stream;
} });

/** A generate_image call that has ended with its picture, as the server sends it. */
const made = (id: string, path: string, title: string) => ({ toolName: 'generate_image', toolCallId: id, result: { content: [{ type: 'text', text: `Generated and shown to the user: ${path}` }], details: { files: [{ path, title }] } }, portalFiles: [{ path, kind: 'picture', title }] });

function Fixture() {
  const [events, setEvents] = useState<PortalEvent[]>([
    { seq: 1, type: 'portal_prompt', payload: { message: 'Help me plan the next step.' } },
    { seq: 2, type: 'message_update', payload: { assistantMessageEvent: { type: 'text_delta', delta: 'We can work through it together.' } } },
    { seq: 3, type: 'message_end', payload: {} },
  ]);
  const [running, setRunning] = useState(false);
  const session: Session = { id: 'test', title: 'A little room to think', workspace: '/workspaces/pithagoras', executor: 'host', status: running ? 'running' : 'idle', created_at: '', updated_at: '', last_error: null, pinned: false, provider: 'llama-server', model: 'Model A', thinking_level: 'medium', mode: null };
  return <>
    <main data-testid="workspace" style={{ maxWidth: 980, height: 'calc(100vh - 96px)', minHeight: 540, margin: '16px auto 0' }}>
      <Chat session={session} events={events} onClientCommand={() => {}} onEditMessage={async () => {}} onDeleteMessage={async () => {}} onTakeBackQueued={async () => {}} onSendQueuedNow={async () => {}} onRename={async () => {}} onSetMode={async () => {}} onAbort={async () => setRunning(false)} onSend={async () => {}} />
    </main>
    <aside style={{ display: 'flex', flexWrap: 'wrap', gap: 10, fontSize: 10, padding: 8 }}>
      <button onClick={() => setEvents(previous => [...previous,
        { seq: previous.length + 1, type: 'tool_execution_start', payload: { toolName: 'show_image', toolCallId: `pic-${previous.length}`, input: { path: 'plots/chart.png', title: 'Sales by month' } } },
        { seq: previous.length + 2, type: 'tool_execution_end', payload: { toolName: 'show_image', toolCallId: `pic-${previous.length}`, result: { content: [{ type: 'text', text: 'Shown to the user: plots/chart.png' }], details: { files: [{ path: 'plots/chart.png', title: 'Sales by month' }] } }, portalFiles: [{ path: 'plots/chart.png', kind: 'picture', title: 'Sales by month' }] } }])}>Show picture</button>
      <button onClick={() => setEvents(previous => [...previous,
        { seq: previous.length + 1, type: 'tool_execution_start', payload: { toolName: 'generate_image', toolCallId: `gen-${previous.length}`, input: { prompt: 'A lighthouse at dusk, oil painting' } } },
        { seq: previous.length + 2, type: 'tool_execution_end', payload: made(`gen-${previous.length}`, 'generated-images/image-20261001-101500-a1b2c3.png', 'A lighthouse at dusk') }])}>Generate picture</button>
      {/* A call that gives its picture some time after it started, as the endpoint takes its time. */}
      <button onClick={() => { setRunning(true); setEvents(previous => [...previous,
        { seq: previous.length + 1, type: 'tool_execution_start', payload: { toolName: 'generate_image', toolCallId: 'gen-slow', input: { prompt: 'A foggy harbour at first light' } } }]); }}>Start generating a picture</button>
      <button onClick={() => { setRunning(false); setEvents(previous => [...previous,
        { seq: previous.length + 1, type: 'tool_execution_end', payload: made('gen-slow', 'generated-images/image-20261001-101600-d4e5f6.png', 'A foggy harbour') }]); }}>Finish generating the picture</button>
      <button onClick={() => { setRunning(false); setEvents(previous => [...previous,
        { seq: previous.length + 1, type: 'tool_execution_start', payload: { toolName: 'generate_image', toolCallId: 'gen-failed', input: { prompt: 'A castle in the clouds' } } },
        { seq: previous.length + 2, type: 'tool_execution_end', payload: { toolName: 'generate_image', toolCallId: 'gen-failed', isError: true, result: { content: [{ type: 'text', text: 'The image endpoint answered 401: the key was refused' }] } } }]); }}>Fail generating a picture</button>
    </aside>
  </>;
}
// Inside a router, as in the app: the chat's links go through it.
createRoot(document.getElementById('root')!).render(<BrowserRouter><Fixture /></BrowserRouter>);
