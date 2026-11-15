// Development-only fixture: the installed extensions, loaded as the app loads them, with what each failed with, and a
// part that reads the data contract through the `portal` the first of them was given (`window.contractPortal`).
// Open /tests/contract.html.
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Portal } from '@pithagoras/extension-api';
import { startExtensions, useExtensions } from '../src/extensions/loader';
import '../src/styles';

startExtensions();

function Reader({ portal }: { portal: Portal }) {
  const me = portal.me.use();
  const pref = portal.prefs.use('density', 'roomy');
  const viewport = portal.env.useViewport();
  const chats = portal.sessions.use((s) => s.list.length);
  return (
    <>
      <p data-testid="reader">{me.name} · {pref} · {viewport} · {chats} chats · {me.status}</p>
      <button onClick={() => portal.prefs.set('density', 'tight')}>Tighten</button>
      <button onClick={() => portal.prefs.remove('density')}>Forget</button>
    </>
  );
}

function Page() {
  const { failures } = useExtensions();
  const [portal, setPortal] = useState<Portal | null>(null);
  // The reader drawn again, as a part an interface shows and hides.
  const [shown, setShown] = useState(true);
  useEffect(() => {
    const timer = setInterval(() => {
      const given = (window as any).contractPortal as Portal | undefined;
      if (given) setPortal(given);
    }, 30);
    return () => clearInterval(timer);
  }, []);
  return (
    <>
      <ul data-testid="failures">{Object.entries(failures).map(([name, why]) => <li key={name}>{name}: {why}</li>)}</ul>
      <button onClick={() => setShown(!shown)}>{shown ? 'Hide the reader' : 'Show the reader'}</button>
      {portal && shown && <Reader portal={portal} />}
    </>
  );
}

createRoot(document.getElementById('root')!).render(<Page />);
