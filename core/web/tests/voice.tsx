// Development-only fixture using the actual chat and extension dialog.
import { useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { Chat } from '../src/components/Chat';
import { ExtensionDialog } from '../src/components/ExtensionDialog';
import { KeyboardShortcuts } from '../src/components/KeyboardShortcuts';
import type { PortalEvent, Session } from '../src/api';
import { serverPush } from '../src/extensions/server-feed';
import '../src/styles';
import { register } from '../src/extensions/slots';
import { registerShortcut } from '../src/extensions/shortcuts';
import { registerCommand } from '../src/extensions/commands';
import { panels } from '../src/extensions/panels';
import { ToolLink } from '../src/extensions/ToolView';
import { startExtensions } from '../src/extensions/loader';
// `?brought=1`: with a window an extension brought, as the installed ones register theirs.
if (new URLSearchParams(location.search).has('brought')) {
  register('probe', 'voice.window', {
    id: 'probe',
    title: 'Probe',
    component: ({ chat, close }) => <div data-testid="probe-window" style={{ padding: 16 }}>Probe for {chat.title} <button type="button" onClick={close}>Done</button></div>,
  });
}
// `?hooks=1`: an extension's use of what any extension can hook into: a panel by a name of its own, an action on a
// tool call's card, a voice window that asks for the middle and opens itself and from a card, a voice shortcut, and
// the running tray's jobs. Registered as the loader registers an extension's, under the name "hooks".
const hooks = new URLSearchParams(location.search).has('hooks');
const said = (window as any).hooksSaid = [] as unknown[];
if (hooks) {
  const grows = new Set<() => void>();
  (window as any).hooksGrow = () => { (window as any).hooksCount = ((window as any).hooksCount ?? 0) + 1; grows.forEach((f) => f()); };
  register('hooks', 'chat.panel', {
    id: 'panel', title: 'Hooks', name: 'hooks-panel',
    component: ({ panel }) => <div data-testid="hooks-panel">Opened with {JSON.stringify(panel.params ?? null)}</div>,
  });
  register('hooks', 'chat.header.action', {
    id: 'by-name',
    component: () => <button type="button" onClick={() => panels.open('hooks-panel', { said: 'by name' })}>Open by name</button>,
  });
  register('hooks', 'chat.tool.action', {
    id: 'open', tool: /^bash$/,
    component: ({ call, cut, panels: own }) => <ToolLink onClick={() => own.open('panel', { call: call.callId, cut })}>Open in Hooks</ToolLink>,
  });
  register('hooks', 'voice.window', {
    id: 'pinned', title: 'Pinned', place: 'middle',
    useAutoOpen: () => useSyncExternalStore((f) => (grows.add(f), () => void grows.delete(f)), () => (window as any).hooksCount ?? 0),
    opensFor: (call) => call.name === 'note',
    component: ({ close }) => <div data-testid="pinned-window">Pinned <button type="button" onClick={close}>Done</button></div>,
  });
  registerShortcut('hooks', { id: 'pin', label: 'Show or hide what is pinned', scope: 'voice', default: { code: 'KeyN' }, run: ({ windows }) => (windows.isOpen('pinned') ? windows.close('pinned') : windows.open('pinned')) });
  registerCommand('jobs.show', (asked) => said.push(asked));
} else {
  // The installed extensions, loaded as the app loads them: those the browser test says are installed (`installed`
  // in tests/browser/portal-mock.ts). Not beside the one above, which stands in for them.
  startExtensions();
}
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
  const session: Session = { id: chat, title: 'A little room to think', workspace: '/workspaces/pithagoras', executor: 'host', status: running ? 'running' : 'idle', created_at: '', updated_at: '', last_error: null, pinned: false, provider: 'llama-server', model: 'Model A', thinking_level: 'medium', mode: null };
  return <>
    <main data-testid="workspace" style={{ maxWidth: 980, height: 'calc(100vh - 96px)', minHeight: 540, margin: '16px auto 0' }}>
      <Chat session={session} events={events} onClientCommand={() => {}} onEditMessage={async () => {}} onDeleteMessage={async () => {}} onTakeBackQueued={async () => {}} onSendQueuedNow={async () => {}} onRename={async () => {}} onSetMode={async () => {}} onAbort={async () => { setAborted(n => n + 1); setRunning(false); }} onSend={async (message, options) => {
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
        // A test that switches chats mid-sentence sets `speechSeconds` for a stretch of the clip that outlasts its own slowness.
        source.connect(destination); source.start(0, 0, (window as any).speechSeconds ?? 2.5);
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
      {hooks && <button onClick={() => setEvents(previous => [...previous, { seq: previous.length + 1, type: 'tool_execution_start', payload: { toolName: 'note', toolCallId: 'note-demo', input: { text: 'Keep this' } } }])}>Use note</button>}
      <button onClick={() => setChat('other')}>Switch chat</button>
      <button onClick={() => setEvents(previous => [...previous,
        { seq: previous.length + 1, type: 'tool_execution_start', payload: { toolName: 'show_image', toolCallId: `pic-${previous.length}`, input: { path: 'plots/chart.png', title: 'Sales by month' } } },
        { seq: previous.length + 2, type: 'tool_execution_end', payload: { toolName: 'show_image', toolCallId: `pic-${previous.length}`, result: { content: [{ type: 'text', text: 'Shown to the user: plots/chart.png' }], details: { files: [{ path: 'plots/chart.png', title: 'Sales by month' }] } }, portalFiles: [{ path: 'plots/chart.png', kind: 'picture', title: 'Sales by month' }] } }])}>Show picture</button>
      {/* A call that gives a picture at its end, some time after it started, as a chart's tool would. */}
      <button onClick={() => { setRunning(true); setEvents(previous => [...previous,
        { seq: previous.length + 1, type: 'tool_execution_start', payload: { toolName: 'plot_sales', toolCallId: 'plot-slow', input: { title: 'Sales by month', description: 'A chart of the sales, month by month' } } }]); }}>Start a chart</button>
      <button onClick={() => { setRunning(false); setEvents(previous => [...previous,
        { seq: previous.length + 1, type: 'tool_execution_end', payload: { toolName: 'plot_sales', toolCallId: 'plot-slow', result: { content: [{ type: 'text', text: 'Saved plots/sales.png' }], details: { files: [{ path: 'plots/sales.png', title: 'Sales by month' }] } }, portalFiles: [{ path: 'plots/sales.png', kind: 'picture', title: 'Sales by month' }] } }]); }}>Finish the chart</button>
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
// What an installed extension's server half tells this chat's page, as the app's stream passes it on: see extensions/server-feed.ts.
(window as any).extensionSays = (extension: string, data: unknown) => serverPush('test', extension, data);
createRoot(document.getElementById('root')!).render(<BrowserRouter><Fixture /></BrowserRouter>);
