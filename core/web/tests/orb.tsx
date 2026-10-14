// Development-only fixture: avatars as the app shows them (the canvas overscans its box by 43%): one large, one the size of a thumbnail, and one far below the
// page's first screen (scroll to #away to bring it in). See orb.html for how the frames are counted.
import { useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { VoiceOrb } from '../src/components/VoiceOrb';
import { DEFAULT_ORB } from '../../server/src/orb-style';
import '../src/styles';

function Page() {
  const levels = useRef({ input: 0, output: 0 });
  const orb = (id: string, width: number) => (
    <div id={id} style={{ width }}>
      <div className="voice-avatar">
        <VoiceOrb mode="idle" levels={levels as any} look={DEFAULT_ORB} />
      </div>
    </div>
  );
  return (
    <>
      {orb('big', 300)}
      {orb('thumb', 60)}
      <div style={{ height: 3000 }} />
      {orb('away', 60)}
    </>
  );
}

createRoot(document.getElementById('root')!).render(<Page />);
