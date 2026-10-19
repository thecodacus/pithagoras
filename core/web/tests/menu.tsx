// Development-only fixture: the portal's Menu on its own. One on the rail's side (the pages one: the second is showing),
// one at the right edge of the window with a link among its choices, and one at the bottom of the window. Two popovers
// that close on a press outside them, each holding a menu: one with the portal's own hook, one as an extension does it.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { Menu } from '../src/components/Menu';
import { inOverlay } from '../src/overlay';
import { useDismiss } from '../src/use-dismiss';
import '../src/styles';

function Popover({ name, how, top, children }: { name: string; how: 'hook' | 'extension'; top: number; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useDismiss(how === 'hook' && open, [box, trigger], () => setOpen(false), trigger);
  useEffect(() => {
    if (how !== 'extension' || !open) return;
    const onDown = (e: MouseEvent) => {
      if (box.current?.contains(e.target as Node) || trigger.current?.contains(e.target as Node) || inOverlay(e.target)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);
  return <div style={{ position: 'fixed', left: 400, top }}>
    <button ref={trigger} type="button" aria-expanded={open} onClick={() => setOpen((was) => !was)}>{name}</button>
    {open && <div ref={box} role="group" aria-label={`${name} popover`} style={{ border: '1px solid gray', padding: 8 }}>{children}</div>}
  </div>;
}

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
    {(['hook', 'extension'] as const).map((how, i) => (
      <Popover key={how} name={`Popover ${how}`} how={how} top={260 + i * 140}>
        <Menu label={`More ${how}`} items={[{ key: 'archive', label: `Archive ${how}`, onSelect: () => say(`archive ${how}`) }]}>More {how}</Menu>
      </Popover>
    ))}
    <output data-testid="log" style={{ position: 'fixed', left: 400, top: 40 }}>{log.join(',')}</output>
  </>;
}

createRoot(document.getElementById('root')!).render(<Page />);
