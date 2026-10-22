import {createRoot} from 'react-dom/client';
import {VoiceModeSettings} from '../src/components/VoiceModeSettings';
import '../src/styles';
const say=(text:string)=>{document.getElementById('error')!.textContent=text;};
createRoot(document.getElementById('root')!).render(<main style={{maxWidth:700,margin:'20px auto'}}><VoiceModeSettings onError={say} onExtensions={()=>say('Opened Extensions')} onSource={name=>say(`Opened the page of ${name}`)}/><p id="error" role="alert"/></main>);
