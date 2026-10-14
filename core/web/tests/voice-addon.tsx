import {createRoot} from 'react-dom/client';
import {VoiceAddon} from '../src/components/VoiceAddon';
import {ConfirmHost} from '../src/components/ConfirmDialog';
import '../src/styles';
createRoot(document.getElementById('root')!).render(<main style={{maxWidth:700,margin:'20px auto'}}><VoiceAddon onError={message=>{document.getElementById('error')!.textContent=message;}}/><p id="error" role="alert"/><ConfirmHost/></main>);
