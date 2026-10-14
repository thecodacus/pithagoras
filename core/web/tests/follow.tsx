// Development-only fixture: a box kept at its end by useFollowBottom, on its own. Its entries are its own
// children, as the terminal's runs are, not a list inside it; `window.redraw()` draws the box again as another
// element, as a component that shows something else for a while does, and `window.grow(px)` adds to its end.
import { useLayoutEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useFollowBottom } from '../src/use-follow-bottom';

function Entry({ n }: { n: number }) {
  const [open, setOpen] = useState(false);
  // Its button low in it, so that it is in view with the box at its end.
  return <div className="entry" style={{ padding: '40px 4px 4px' }}>
    <div className="entry-head"><button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)}>Entry {n}</button></div>
    {open && <div style={{ height: 400, background: '#223' }}>What it opens</div>}
  </div>;
}

function Box() {
  const followed = useFollowBottom<HTMLDivElement>();
  const { onScroll, hold, follow, attach } = followed;
  const [drawn, setDrawn] = useState(0);
  (window as any).redraw = () => setDrawn((n) => n + 1);
  (window as any).grow = (px: number) => {
    const extra = document.createElement('div');
    extra.style.height = `${px}px`;
    document.querySelector('[data-testid=box]')!.appendChild(extra);
  };
  useLayoutEffect(() => follow(true), [drawn]);
  return <div key={drawn} data-testid="box" ref={attach} onScroll={onScroll} onPointerDown={hold} style={{ height: 300, overflowY: 'auto', border: '1px solid #444' }}>
    <Entry n={1} />
    <div style={{ height: 260 }}>The rest</div>
  </div>;
}

createRoot(document.getElementById('root')!).render(<Box />);
