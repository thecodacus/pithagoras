// Development-only fixture: the installed extensions, loaded as the app loads them, with what each failed with, and a
// part that reads the data contract through the `portal` the first of them was given (`window.contractPortal`).
// Open /tests/contract.html.
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Portal } from '@pithagoras/extension-api';
import { startExtensions, useExtensions } from '../src/extensions/loader';
import { useReloadAfterSettings } from '../src/kernel/use';
import { forget } from '../src/settings-cache';
import '../src/styles';

startExtensions();

function Reader({ portal }: { portal: Portal }) {
  const me = portal.me.use();
  const pref = portal.prefs.use('density', 'roomy');
  const viewport = portal.env.useViewport();
  const chats = portal.sessions.use((s) => s.list.length);
  const models = portal.models.use();
  const settings = portal.settings.use();
  return (
    <>
      <p data-testid="reader">{me.name} · {pref} · {viewport} · {chats} chats · {me.status}</p>
      <p data-testid="settings">{models.models.map((m) => m.id).join(',')} · {settings.values.model}</p>
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
  // Settings open over the page, as the app has it: what it changes is read again once it is closed.
  const [inSettings, setInSettings] = useState(false);
  useReloadAfterSettings(inSettings);
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
      <button onClick={() => setInSettings(true)}>Open Settings</button>
      {/* Settings itself brings its own copy of the models up to date when a provider is added. */}
      <button onClick={() => { forget('models'); setInSettings(false); }}>Close Settings</button>
      {portal && shown && <Reader portal={portal} />}
    </>
  );
}

createRoot(document.getElementById('root')!).render(<Page />);
