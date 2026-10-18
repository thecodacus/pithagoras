// Development-only fixture: the portal's Menu on its own. One on the rail's side (the pages one: the second is showing),
// one at the right edge of the window with a link among its choices, and one at the bottom of the window.
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Menu } from '../src/components/Menu';
import '../src/styles';

function Page() {
  const [log, setLog] = useState<string[]>([]);
  const say = (what: string) => setLog((was) => [...was, what]);
  return <>
    <div style={{ position: 'fixed', left: 8, top: 40 }}>
      <Menu label="Pages" placement="beside" items={[
        { key: 'a', label: 'Alpha', icon: <i>a</i>, onSelect: () => say('alpha') },
        { key: 'b', label: 'Beta', icon: <i>b</i>, current: true, onSelect: () => say('beta') },
        { key: 'c', label: 'Gamma', icon: <i>c</i>, onSelect: () => say('gamma') },
      ]}>Pages</Menu>
    </div>
    <div style={{ position: 'fixed', right: 8, top: 40 }}>
      <Menu label="Download" items={[
        { key: 'md', label: 'Markdown (.md)', href: '/tests/menu.html?file=md', download: 'note.md' },
        { key: 'x', label: 'Something else', onSelect: () => say('else') },
      ]}>Download</Menu>
    </div>
    <div style={{ position: 'fixed', left: 200, bottom: 8 }}>
      <Menu label="Low" items={[1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({ key: String(n), label: `Choice ${n}`, onSelect: () => say(`choice ${n}`) }))}>Low</Menu>
    </div>
    <button type="button" style={{ position: 'fixed', left: 400, top: 200 }}>Elsewhere</button>
    <output data-testid="log" style={{ position: 'fixed', left: 400, top: 40 }}>{log.join(',')}</output>
  </>;
}

createRoot(document.getElementById('root')!).render(<Page />);
