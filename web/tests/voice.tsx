// Development-only fixture using the actual chat and extension dialog.
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { Chat } from '../src/components/Chat';
import { ExtensionDialog } from '../src/components/ExtensionDialog';
import { KeyboardShortcuts } from '../src/components/KeyboardShortcuts';
import type { PortalEvent, Session } from '../src/api';
import { canvasConnection, canvasMessage, type CanvasMessage } from '../src/canvas-feed';
import '../src/styles';
const microphone = new AudioContext();
let destination = microphone.createMediaStreamDestination();
Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { value: async () => {
  // A test sets the name of what the browser refuses with: the words of it are the browser's, in English.
  if ((window as any).micFails) throw Object.assign(new Error('Permission denied'), { name: (window as any).micFails });
  if (destination.stream.getTracks().every(t => t.readyState === 'ended')) destination = microphone.createMediaStreamDestination();
  return destination.stream;
} });
function Fixture() {
  const [events, setEvents] = useState<PortalEvent[]>([
    { seq: 1, type: 'portal_prompt', payload: { message: 'Help me plan the next step.' } },
    { seq: 2, type: 'message_update', payload: { assistantMessageEvent: { type: 'text_delta', delta: 'We can work through it together.' } } },
    { seq: 3, type: 'message_end', payload: {} },
  ]);
  const [running, setRunning] = useState(false);
  const [sent, setSent] = useState(0);
  const [voiceSend, setVoiceSend] = useState(false);
  const [lastSend, setLastSend] = useState('');
  const [aborted, setAborted] = useState(0);
  const [options, setOptions] = useState(false);
  const [selected, setSelected] = useState(0);
  const [shortcuts, setShortcuts] = useState(false);
  // The chat open: another one is the same page shown for another session, as the portal's own switches.
  const [chat, setChat] = useState('test');
  const session: Session = { id: chat, title: 'A little room to think', workspace: '/workspaces/pithagoras', executor: 'host', status: running ? 'running' : 'idle', created_at: '', updated_at: '', last_error: null, pinned: false, provider: 'llama-server', model: 'Model A', thinking_level: 'medium' };
  return <>
    <main data-testid="workspace" style={{ maxWidth: 980, height: 'calc(100vh - 96px)', minHeight: 540, margin: '16px auto 0' }}>
      <Chat session={session} events={events} onClientCommand={() => {}} onEditMessage={async () => {}} onDeleteMessage={async () => {}} onTakeBackQueued={async () => {}} onSendQueuedNow={async () => {}} onRename={async () => {}} onAbort={async () => { setAborted(n => n + 1); setRunning(false); }} onSend={async (message, options) => {
        setVoiceSend(options?.voice === true);
        setLastSend(JSON.stringify({ message, images: options?.images?.length ?? 0, steer: options?.steer === true }));
        setSent(n => n + 1); setRunning(true);
        setEvents(previous => [...previous,
          { seq: previous.length + 1, type: 'portal_prompt', payload: { message } },
          { seq: previous.length + 2, type: 'message_update', payload: { assistantMessageEvent: { type: 'text_delta', delta: 'Here is the spoken response.' } } },
          { seq: previous.length + 3, type: 'message_end', payload: {} },
        ]);
      }} />
    </main>
    {shortcuts && <section aria-label="Shortcut settings" style={{ maxWidth: 700, margin: '8px auto' }}><KeyboardShortcuts /></section>}
    {options && <ExtensionDialog sessionId="test" request={{ id: 'choice', method: 'select', title: 'Choose the next step', options: ['Review changes', 'Run tests'] }} onDone={() => { setSelected(n => n + 1); setOptions(false); }} />}
    <aside style={{ display: 'flex', flexWrap: 'wrap', gap: 10, fontSize: 10, padding: 8 }}>
      <button onClick={async () => {
        await microphone.resume();
        const source = microphone.createBufferSource();
        source.buffer = await microphone.decodeAudioData(await (await fetch('/test-speech.wav')).arrayBuffer());
        source.connect(destination); source.start(0, 0, 2.5);
      }}>Inject speech</button>
      <button onClick={() => { setRunning(true); setEvents(previous => [...previous, { seq: previous.length + 1, type: 'message_update', payload: { assistantMessageEvent: { type: 'text_delta', delta: 'Here is the first sentence. More' } } }]); }}>Stream reply</button>
      <button onClick={() => { setRunning(true); setEvents(previous => [...previous, { seq: previous.length + 1, type: 'message_update', payload: { assistantMessageEvent: { type: 'text_delta', delta: 'Try this:\n\n- first **bold** step\n- see [the docs](https://example.com/docs)\n\n```ts\nconst answer = 4' } } }]); }}>Stream markdown</button>
      <button onClick={() => { setRunning(false); setEvents(previous => [...previous, { seq: previous.length + 1, type: 'message_update', payload: { assistantMessageEvent: { type: 'text_delta', delta: '2;\n```\n' } } }, { seq: previous.length + 2, type: 'message_end', payload: {} }]); }}>Finish markdown</button>
      <button onClick={() => setEvents(previous => [...previous, { seq: previous.length + 1, type: 'portal_notice', payload: { text: 'Model error: the provider is down', error: true } }])}>Fail the model</button>
      {/* An error from before voice mode began, coming in late as a chat's history does after a reload. */}
      <button onClick={() => setEvents(previous => [...previous, { seq: 2, type: 'portal_notice', payload: { text: 'Model error: from yesterday', error: true } }])}>Replay an old error</button>
      <button onClick={() => { setRunning(false); setEvents(previous => [...previous, { seq: previous.length + 1, type: 'message_update', payload: { assistantMessageEvent: { type: 'text_delta', delta: ' text follows.' } } }, { seq: previous.length + 2, type: 'message_end', payload: {} }]); }}>Finish reply</button>
      <button onClick={() => setEvents(previous => [...previous, { seq: previous.length + 1, type: 'tool_execution_start', payload: { toolName: 'mcp', toolCallId: 'browser-demo', input: { tool: 'browser_navigate', args: { url: 'https://example.com' } } } }])}>Use browser</button>
      <button onClick={() => setEvents(previous => [...previous, { seq: previous.length + 1, type: 'tool_execution_start', payload: { toolName: 'bash', toolCallId: 'terminal-demo', input: { command: 'npm run build' } } }, { seq: previous.length + 2, type: 'tool_execution_update', payload: { toolCallId: 'terminal-demo', partialResult: { content: [{ type: 'text', text: 'Building application…\n✓ 42 modules transformed.' }] } } }])}>Use terminal</button>
      <button onClick={() => setEvents(previous => [...previous, { seq: previous.length + 1, type: 'tool_execution_end', payload: { toolName: 'bash', toolCallId: 'terminal-demo', result: { content: [{ type: 'text', text: 'Building application…\n✓ 42 modules transformed.\nBuild completed successfully.' }] } } }])}>Finish terminal</button>
      <button onClick={() => { setRunning(true); const at=Date.now(); setEvents(previous=>[...previous,{seq:previous.length+1,type:'portal_prompt',at,payload:{message:'Process a long conversation'}},{seq:previous.length+2,type:'message_start',at,payload:{message:{role:'assistant'}}},{seq:previous.length+3,type:'portal_prefill',at:Date.now(),payload:{total:40000,processed:16000,cache:8000}}]); }}>Show prefill</button>
      <button onClick={() => { setRunning(true); setEvents(previous=>[...previous,{seq:previous.length+1,type:'compaction_start',at:Date.now()-15000,payload:{}}]); }}>Start compaction</button>
      <button onClick={() => { setRunning(false); setEvents(previous=>[...previous,{seq:previous.length+1,type:'compaction_end',at:Date.now(),payload:{}}]); }}>End compaction</button>
      <button onClick={() => setOptions(true)}>Show options</button>
      <button onClick={() => setShortcuts(v => !v)}>Toggle shortcuts</button>
      <button onClick={() => setChat('other')}>Switch chat</button>
      <button onClick={() => setEvents(previous => [...previous,
        { seq: previous.length + 1, type: 'tool_execution_start', payload: { toolName: 'show_image', toolCallId: `pic-${previous.length}`, input: { path: 'plots/chart.png', title: 'Sales by month' } } },
        { seq: previous.length + 2, type: 'tool_execution_end', payload: { toolName: 'show_image', toolCallId: `pic-${previous.length}`, result: { content: [{ type: 'text', text: 'Shown to the user: plots/chart.png' }], details: { path: 'plots/chart.png', title: 'Sales by month' } } } }])}>Show picture</button>
      <button onClick={() => setEvents(previous => [...previous,
        { seq: previous.length + 1, type: 'tool_execution_start', payload: { toolName: 'generate_image', toolCallId: `gen-${previous.length}`, portalImage: true, input: { prompt: 'A lighthouse at dusk, oil painting' } } },
        { seq: previous.length + 2, type: 'tool_execution_end', payload: { toolName: 'generate_image', toolCallId: `gen-${previous.length}`, result: { content: [{ type: 'text', text: 'Generated and shown to the user: generated-images/image-20261001-101500-a1b2c3.png' }], details: { path: 'generated-images/image-20261001-101500-a1b2c3.png', title: 'A lighthouse at dusk', portalImage: true } } } }])}>Generate picture</button>
      <button onClick={() => { setRunning(true); setEvents(previous => [...previous,
        { seq: previous.length + 1, type: 'tool_execution_start', payload: { toolName: 'generate_image', toolCallId: 'gen-slow', portalImage: true, input: { prompt: 'A foggy harbour at first light' } } }]); }}>Start generating a picture</button>
      <button onClick={() => { setRunning(false); setEvents(previous => [...previous,
        { seq: previous.length + 1, type: 'tool_execution_end', payload: { toolName: 'generate_image', toolCallId: 'gen-slow', result: { content: [{ type: 'text', text: 'Generated and shown to the user: generated-images/image-20261001-101600-d4e5f6.png' }], details: { path: 'generated-images/image-20261001-101600-d4e5f6.png', title: 'A foggy harbour', portalImage: true } } } }]); }}>Finish generating the picture</button>
      <button onClick={() => { setRunning(false); setEvents(previous => [...previous,
        { seq: previous.length + 1, type: 'tool_execution_start', payload: { toolName: 'generate_image', toolCallId: 'gen-failed', portalImage: true, input: { prompt: 'A castle in the clouds' } } },
        { seq: previous.length + 2, type: 'tool_execution_end', payload: { toolName: 'generate_image', toolCallId: 'gen-failed', isError: true, result: { content: [{ type: 'text', text: 'The image endpoint answered 401: the key was refused' }] } } }]); }}>Fail generating a picture</button>
      <button onClick={() => setEvents(previous => [...previous,
        { seq: previous.length + 1, type: 'tool_execution_start', payload: { toolName: 'generate_image', toolCallId: `other-${previous.length}`, input: { prompt: 'A cat on a sofa' } } },
        { seq: previous.length + 2, type: 'tool_execution_end', payload: { toolName: 'generate_image', toolCallId: `other-${previous.length}`, result: { content: [{ type: 'text', text: 'Saved /workspaces/pithagoras/out/cat.png' }], details: { path: '/workspaces/pithagoras/out/cat.png' } } } }])}>Call an extension's generate_image</button>
      <button onClick={() => setEvents(previous => [...previous,
        { seq: previous.length + 1, type: 'tool_execution_start', payload: { toolName: 'edit', toolCallId: `edit-${previous.length}`, input: { path: '/workspaces/pithagoras/src/app.ts' } } },
        { seq: previous.length + 2, type: 'tool_execution_end', payload: { toolName: 'edit', toolCallId: `edit-${previous.length}`, result: { content: [{ type: 'text', text: 'ok' }], details: { diff: ' 1 a\n-2 b\n+2 c\n+3 d' } } } }])}>Edit file</button>
      <button onClick={() => { setRunning(true); setEvents(previous => [...previous, { seq: previous.length + 1, type: 'tool_execution_start', payload: { toolName: 'grep', toolCallId: `grep-${previous.length}`, input: { pattern: 'retry', glob: '*.ts' } } }]); }}>Start search</button>
      <button onClick={() => setEvents(previous => [...previous, { seq: previous.length + 1, type: 'message_update', payload: { assistantMessageEvent: { type: 'thinking_delta', delta: 'Checking the latest build results and comparing the browser state. The next step is to verify the page layout.' } } }])}>Stream thinking</button>
      <span data-testid="voice-send">{String(voiceSend)}</span><span data-testid="last-send">{lastSend}</span><span data-testid="sent">{sent}</span><span data-testid="aborted">{aborted}</span><span data-testid="selected">{selected}</span>
      <button onClick={() => { document.querySelector('[data-testid=tracks]')!.textContent = destination.stream.getTracks().map(t => `${t.readyState}:${t.enabled}`).join(','); }}>Check mic tracks</button>
      <span data-testid="tracks" />
    </aside>
  </>;
}
// Inside a router, as in the app: the chat's links go through it.
// What the app's stream would pass on for this chat's canvases.
(window as any).canvasFeed = { message: (m: CanvasMessage) => canvasMessage('test', m), connected: (on: boolean) => canvasConnection('test', on ? 'up' : 'down') };
createRoot(document.getElementById('root')!).render(<BrowserRouter><Fixture /></BrowserRouter>);
