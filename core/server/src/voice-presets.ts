import { randomUUID } from 'node:crypto';
import { getDb, getSetting, putSetting } from './db.js';
type Row={id:string;name:string;kind:'design'|'clone';instruction:string;transcript:string;audio:Buffer|null};
export function listVoices(){return getDb().prepare('SELECT id,name,kind,instruction,transcript FROM voice_presets ORDER BY name').all();}
/** A voice id that names no saved voice: a 404 for the routes, not a rejected value. */
export class VoiceNotFound extends Error{constructor(){super('Voice not found');}}
export function readVoice(id:string){const row=getDb().prepare('SELECT * FROM voice_presets WHERE id=?').get(id) as Row|undefined;if(!row)throw new VoiceNotFound();return row;}
function cleanInstruction(value:unknown){
 const instruction=typeof value==='string'?value.trim():'';
 if(!instruction||instruction.length>1000)throw new Error('Describe the voice in 1–1000 characters');
 return instruction;
}
export function addVoice(value:any){
 const name=typeof value.name==='string'?value.name.trim():'';
 const transcript=typeof value.transcript==='string'?value.transcript.trim():'';
 if(!name||name.length>100)throw new Error('Enter a voice name of 1–100 characters');
 if(!['design','clone'].includes(value.kind))throw new Error('Choose a designed voice or reference clone');
 const instruction=cleanInstruction(value.instruction);
 let audio:Buffer|null=null;
 if(value.kind==='clone'){
  if(!transcript||transcript.length>4000)throw new Error('Enter the exact words spoken in the reference (up to 4,000 characters)');
  if(typeof value.audio!=='string'||value.audio.length>1300000)throw new Error('Upload a reference recording of 1–30 seconds');
  audio=Buffer.from(value.audio,'base64');
  if(audio.length<32044||audio.length>960044||audio.toString('ascii',0,4)!=='RIFF'||audio.toString('ascii',8,16)!=='WAVEfmt '||audio.readUInt32LE(16)!==16||audio.readUInt16LE(20)!==1||audio.readUInt16LE(22)!==1||audio.readUInt32LE(24)!==16000||audio.readUInt16LE(34)!==16||audio.toString('ascii',36,40)!=='data'||audio.readUInt32LE(40)!==audio.length-44||audio.length%2)throw new Error('Invalid reference WAV; upload a 1–30 second audio clip using Settings');
 }
 const id='voice-'+randomUUID();getDb().prepare('INSERT INTO voice_presets VALUES (?,?,?,?,?,?)').run(id,name,value.kind,instruction,transcript,audio);
 return {id,name,kind:value.kind,instruction,transcript};
}
/**
 * Change what a saved voice is told to sound like. Nothing is derived from the
 * description: the speech route reads it again for every phrase, and the
 * engines' reference caches are keyed by the recording (Chatterbox's also by
 * language and exaggeration), so the next phrase already uses the new text.
 */
export function updateVoice(id:string,value:any){
 const instruction=cleanInstruction(value?.instruction);
 if(!getDb().prepare('UPDATE voice_presets SET instruction=? WHERE id=?').run(instruction,id).changes)throw new VoiceNotFound();
 return getDb().prepare('SELECT id,name,kind,instruction,transcript FROM voice_presets WHERE id=?').get(id);
}
export function deleteVoice(id:string){readVoice(id);getDb().transaction(()=>{
 // A voice setting that does not parse names no voice: it stays as it is, and the voice is deleted all the same.
 let config:any;
 try{config=JSON.parse(getSetting('voice')??'null');}catch{}
 if(config?.voice===id){config.voice='design';putSetting('voice',JSON.stringify(config));}
 // An agent that spoke with it goes back to the voice in the settings.
 getDb().prepare('UPDATE agents SET voice=NULL WHERE voice=?').run(id);
 getDb().prepare('DELETE FROM voice_presets WHERE id=?').run(id);
})();}
