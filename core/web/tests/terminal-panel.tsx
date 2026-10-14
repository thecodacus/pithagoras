// For a fixture: the panel the installed extensions named "terminal" (`chat.panel`), drawn as the chat draws it, on a tab of its own.
import { useSlot } from '../src/extensions/slots';
import { channelFor } from '../src/extensions/channel';
import { panelsFor } from '../src/extensions/panels';

export function TerminalPanel({ chat, tab }: { chat: string; tab: string }) {
  const entry = useSlot('chat.panel').find((e) => e.name === 'terminal');
  if (!entry) return null;
  const Panel = entry.component;
  const handle = { params: undefined, state: { tab }, setState: () => {}, keep: () => {}, guardClose: () => {} };
  return (
    <div style={{ position: 'relative', flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <Panel chat={{ id: chat, title: chat, workspace: '/w' }} channel={channelFor(chat, entry.extension)} panels={panelsFor(entry.extension)} close={() => {}} panel={handle} />
    </div>
  );
}
