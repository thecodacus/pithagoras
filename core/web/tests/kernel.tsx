// Development-only fixture: the chat view and two other parts reading the same chat from the kernel's stores.
// Open /tests/kernel.html. `window.say(text)` puts a message into the chat's store as its stream would; what each part
// saw is in `window.seen`. The box of the chat view and `Probe`'s are the same draft.
import { BrowserRouter } from 'react-router-dom';
import { createRoot } from 'react-dom/client';
import { Chat } from '../src/components/Chat';
import type { PortalEvent, Session } from '../src/api';
import { useChat, useComposer } from '../src/kernel/use';
import { useKernel } from '../src/kernel/context';
import '../src/styles';
import { createFakeKernel, WithKernel } from './fake-kernel';

const session = { id: 'one', title: 'One', workspace: '/workspaces/one', executor: 'host', status: 'idle', created_at: '', updated_at: '', last_error: null, pinned: false, provider: null, model: null, thinking_level: null, mode: null } as Session;
const fake = createFakeKernel({ controller: () => ({ send: async (message: string) => { (window as any).sent = [...((window as any).sent ?? []), message]; } }) });
let seq = 0;
const first: PortalEvent[] = [{ seq: ++seq, type: 'portal_prompt', at: Date.now(), payload: { message: 'Hello from before' } }];
fake.set('one', { events: first, loaded: true });
(window as any).seen = {};
(window as any).say = (text: string) => fake.append('one', { seq: ++seq, type: 'portal_prompt', at: Date.now(), payload: { message: text } });
(window as any).drafts = () => fake.kernel.composer.get('one').draft;
(window as any).type = (text: string) => fake.kernel.composer.setDraft('one', text);

/** Reads the chat as any other part of an interface would, and says what it holds, and which array it holds. */
function Probe({ name }: { name: string }) {
  const chat = useChat('one');
  const composer = useComposer('one');
  const arrays: unknown[] = ((window as any).arrays ??= {});
  arrays[name === 'a' ? 0 : 1] = chat.events;
  (window as any).seen[name] = chat.events.length;
  // Same array, not only the same numbers.
  (window as any).same = arrays[0] === arrays[1];
  return <p data-testid={`probe-${name}`}>{name}: {chat.events.length} events; draft “{composer.draft}”</p>;
}

function Page() {
  // The same thing the app does for the chat on screen: `useKernel` is what `Chat` reads its stores through.
  const { chats } = useKernel();
  (window as any).kernelHasChats = typeof chats.controller === 'function';
  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      <Probe name="a" />
      <Probe name="b" />
      <div style={{ flex: 1, minHeight: 0 }}><Chat session={session} onClientCommand={async () => {}} /></div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<BrowserRouter><WithKernel fake={fake}><Page /></WithKernel></BrowserRouter>);
