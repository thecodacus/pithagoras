// Development-only fixture: the portal's markdown, drawn the way a reply is, inside a page that can be drawn again.
// Open /tests/markdown.html?text=<markdown>. `Redraw` draws the page again with what it passes unchanged; `window.drawn` counts the draws of the markdown and of Streamdown in it (see the html).
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Streamdown } from 'streamdown';
import { Markdown } from '../src/components/Markdown';

// A memoised component is its function once it runs.
const inner = (component: any) => component.type ?? component;
(window as any).watched = { markdown: inner(Markdown), streamdown: inner(Streamdown) };
const text = new URLSearchParams(location.search).get('text') ?? '# Title\n\nSome *words* and `code`.';

function Page() {
  const [times, setTimes] = useState(0);
  return (
    <>
      <button onClick={() => setTimes((n) => n + 1)}>Redraw</button>
      <output>{times}</output>
      <Markdown parseIncompleteMarkdown animated isAnimating={false} diagram={null}>{text}</Markdown>
    </>
  );
}

createRoot(document.getElementById('root')!).render(<Page />);
