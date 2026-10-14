import {useEffect,useState} from 'react';
import { Select } from "./Select";
import { inputSmCls } from "./SettingsUi";
import {LuPlus,LuTrash2} from 'react-icons/lu';
import {samplesWav} from '../voice';
import {json} from '../api';
import {micError} from '../mic-error';
import {blobBase64} from '../attachments';
import {confirmDialog} from './ConfirmDialog';
import {useUnsavedDraft} from './Modal';
import { languageName, t } from "../i18n";
import { KOKORO_VOICES } from "../../../server/src/kokoro-voices";
export type Preset={id:string;name:string;kind:'design'|'clone';instruction:string;transcript:string};
/** Kokoro's own voices, as a voice menu lists them: Kokoro reads the text in the voice's language. */
export const kokoroVoiceOptions=()=>KOKORO_VOICES.map(v=>({value:v.id,label:v.name,text:v.name,hint:`${languageName(v.locale,v.language)} · ${v.female?t('female'):t('male')}`}));
/** The voices in the library. */
export const voicePresets=():Promise<Preset[]>=>request();
const request=(path='',method='GET',body?:unknown)=>json<any>('/api/voice/presets'+path,{method,...(body===undefined?{}:{body:JSON.stringify(body)})});
async function reference(file:File){
 if(file.size>20*1024*1024)throw Error(t('Choose an audio file smaller than 20 MB'));
 const decoder=new OfflineAudioContext(1,16000,16000);
 // A file that is not audio the browser reads: its own words for that are no help.
 const decoded=await decoder.decodeAudioData(await file.arrayBuffer()).catch(e=>{throw Error(micError(e));});
 if(decoded.duration<1||decoded.duration>30)throw Error(t('Choose a recording between 1 and 30 seconds'));
 const renderer=new OfflineAudioContext(1,Math.round(decoded.duration*16000),16000);
 const source=renderer.createBufferSource();source.buffer=decoded;source.connect(renderer.destination);source.start();
 const rendered=await renderer.startRendering();const blob=samplesWav(rendered.getChannelData(0));
 return blobBase64(blob).catch(()=>{throw Error(t('Could not read the recording'));});
}
/**
 * `onPending` hands the page a function that saves the descriptions edited and not yet saved, or null
 * when there are none, so that the page's own save button cannot report "Saved" over them.
 */
export function VoiceLibrary({value,onChange,onError,onPending}:{value:string;onChange:(id:string)=>void;onError:(message:string)=>void;onPending:(save:(()=>Promise<void>)|null)=>void}){
 const [voices,setVoices]=useState<Preset[]>([]),[adding,setAdding]=useState(false),[busy,setBusy]=useState(false);
 // Edited descriptions by voice id, kept while another voice is selected; a voice's description is saved on its own, not with the settings.
 const [drafts,setDrafts]=useState<Record<string,string>>({});
 useEffect(()=>{void request().then(setVoices).catch(e=>onError(e.message));},[]);
 const selected=voices.find(v=>v.id===value);
 // The draft goes only if it is still what was sent: more may have been typed while the request was out.
 const saveDescription=async(id:string,instruction:string)=>{const row=await request('/'+id,'PATCH',{instruction});setVoices(v=>v.map(p=>p.id===row.id?row:p));setDrafts(d=>d[id]===instruction?(({[id]:_,...rest})=>rest)(d):d);};
 const edited=voices.filter(v=>v.id in drafts&&drafts[v.id].trim()!==v.instruction);
 // What the page's save button stores along with the settings. A voice that is not selected and was emptied is
 // an edit given up, not one to be refused with an error about a field that is not on screen.
 const toSave=edited.filter(v=>v.id===value||drafts[v.id].trim());
 // Where it is typed, in the render of the keystroke: through the page, which learns of it a render later, a dialog closed at once would not ask.
 useUnsavedDraft(toSave.length>0&&!busy);
 useEffect(()=>{onPending(toSave.length?async()=>{for(const v of toSave)await saveDescription(v.id,drafts[v.id]);}:null);return()=>onPending(null);},[voices,drafts,value]);
 const field=`mt-1 ${inputSmCls}`;
 return <div className="space-y-2">
  <div className="block text-xs text-fg-muted">{t("Speaking voice")}<Select aria-label={t("Speaking voice")} className="mt-1.5 w-full" value={value} onChange={onChange} options={[{value:'design',label:t('Designed voice')},...voices.map(v=>({value:v.id,label:v.name,text:v.name,hint:v.kind==='clone'?t('Reference clone'):t('Designed')}))]}/></div>
  {selected&&<div className="rounded-lg border border-line p-3 space-y-2"><div className="space-y-2"><label className="block text-xs text-fg-muted">{t("Voice description")}<textarea className={field} value={drafts[selected.id]??selected.instruction} maxLength={1000} onChange={e=>setDrafts(d=>({...d,[selected.id]:e.target.value}))}/></label><button type="button" disabled={busy||!(drafts[selected.id]??'').trim()||!edited.includes(selected)} className="rounded-lg bg-accent/12 px-3 py-1.5 text-xs text-accent disabled:opacity-40" onClick={async()=>{setBusy(true);try{await saveDescription(selected.id,drafts[selected.id]);}catch(e){onError((e as Error).message);}finally{setBusy(false);}}}>{busy?t("Saving voice…"):t("Save description")}</button></div>{selected.kind==='clone'&&<><audio aria-label={t("Voice reference preview")} controls preload="none" className="w-full h-9" src={`/api/voice/presets/${selected.id}/audio`}/><p className="text-xs text-fg-faint">{selected.transcript}</p></>}<button type="button" disabled={busy} className="inline-flex items-center gap-1 text-xs text-danger" onClick={async()=>{if(!await confirmDialog({title:t('Delete voice “{name}”?',{name:selected.name}),confirmLabel:t('Delete'),danger:true,deletes:true}))return;setBusy(true);try{await request('/'+selected.id,'DELETE');setVoices(v=>v.filter(p=>p.id!==selected.id));onChange('design');window.dispatchEvent(new Event('voice-config-changed'));}catch(e){onError((e as Error).message);}finally{setBusy(false);}}}><LuTrash2/>{t("Delete voice")}</button></div>}
  <button type="button" className="inline-flex items-center gap-1.5 rounded-lg bg-accent/12 px-3 py-1.5 text-xs text-accent" onClick={()=>setAdding(v=>!v)}><LuPlus/>{adding?t("Close new voice"):t("Add voice")}</button>
  {adding&&<div className="rounded-lg border border-line bg-surface p-3 space-y-3">
   <AddVoiceForm onAdded={row=>{setVoices(v=>[...v,row]);onChange(row.id);setAdding(false);}} onError={onError}/>
   <p className="text-xs text-fg-faint">{t("The voice is saved in your portal. Click Save voice settings below to use it for spoken responses.")}</p>
  </div>}
 </div>;
}

const FIRST_INSTRUCTION='Speak clearly and naturally.';
/** A new voice for the library: a clone from a recording, or one designed from a description. */
export function AddVoiceForm({onAdded,onError}:{onAdded:(voice:Preset)=>void;onError:(message:string)=>void}){
 const [busy,setBusy]=useState(false);
 const [name,setName]=useState(''),[kind,setKind]=useState<'design'|'clone'>('clone'),[instruction,setInstruction]=useState(FIRST_INSTRUCTION),[transcript,setTranscript]=useState(''),[file,setFile]=useState<File|null>(null);
 // The words of a recording, a name and a chosen file are in no other place: the dialog this is in (Settings, or the avatar's) asks before it closes over them.
 useUnsavedDraft(!busy&&(!!name.trim()||!!transcript.trim()||!!file||instruction!==FIRST_INSTRUCTION));
 const field=`mt-1 ${inputSmCls}`;
 return <div className="space-y-3">
  <label className="block text-xs">{t("Voice name")}<input className={field} value={name} maxLength={100} onChange={e=>setName(e.target.value)}/></label>
  <div className="block text-xs">{t("Voice type")}<Select aria-label={t("Voice type")} className="mt-1.5 w-full" value={kind} onChange={v=>setKind(v as 'clone'|'design')} options={[{value:'clone',label:t('Clone from a recording')},{value:'design',label:t('Design from a description')}]}/></div>
  <label className="block text-xs">{t("Voice description")}<textarea className={field} value={instruction} maxLength={1000} onChange={e=>setInstruction(e.target.value)}/></label>
  {kind==='clone'&&<><label className="block text-xs">{t("Reference recording")}<input type="file" accept="audio/*" className={field} onChange={e=>setFile(e.target.files?.[0]??null)}/></label><p className="text-xs text-fg-faint">{t("Use a clean 1–30 second clip with one speaker and no background music. Browser-supported audio formats are converted automatically.")}</p><label className="block text-xs">{t("Exact words in the recording")}<textarea className={field} value={transcript} maxLength={4000} onChange={e=>setTranscript(e.target.value)}/></label></>}
  <button type="button" disabled={busy||!name.trim()||!instruction.trim()||(kind==='clone'&&(!file||!transcript.trim()))} className="rounded-lg bg-accent/12 px-3 py-1.5 text-xs text-accent disabled:opacity-40" onClick={async()=>{setBusy(true);try{const audio=kind==='clone'?await reference(file!):undefined;const row=await request('','POST',{name,kind,instruction,transcript,audio});setName('');setTranscript('');setFile(null);onAdded(row);}catch(e){onError((e as Error).message);}finally{setBusy(false);}}}>{busy?t("Saving voice…"):t("Save new voice")}</button>
 </div>;
}
