/** Browser-clock latency trace. Contains timing metadata only, never speech/text. */
import { msg } from "./i18n";
export type VoiceMark = { name:string; at:number; detail?:Record<string,number|string|boolean> };
export type VoiceTrace = { id:number; started:number; marks:VoiceMark[]; status:string };
/** How a trace ended, as the panel says it; the report keeps the raw value. */
export const TRACE_STATUS:Record<string,string>={recording:msg('recording'),complete:msg('complete'),interrupted:msg('interrupted'),stopped:msg('stopped'),muted:msg('muted'),error:msg('error'),vad_misfire:msg('voice detection misfired'),disabled:msg('profiling switched off')};
/**
 * The first things a model gives back that an event shows: its first token of any
 * kind, of the reply's text, of its reasoning. A token of its own, or the reply
 * written so far as one entry that grows (see live-events.ts), which is what the
 * page holds a reply being written as.
 */
export function replyMarks(event:{type:string;payload?:any}):string[]{
 const p=event.payload;
 if(event.type==='message_update'){
  const inner=p?.assistantMessageEvent;
  return [...(inner?.delta&&['text_delta','thinking_delta','toolcall_delta'].includes(inner.type)?['first_model_token']:[]),...(inner?.delta&&inner.type==='text_delta'?['first_text']:[]),...(inner?.type==='thinking_delta'?['first_thinking_token']:[])];
 }
 if(event.type==='message_snapshot'){
  const blocks:any[]=Array.isArray(p?.message?.content)?p.message.content:[];
  return [...(blocks.length?['first_model_token']:[]),...(blocks.some(b=>b?.type==='text'&&b.text)?['first_text']:[]),...(blocks.some(b=>b?.type==='thinking')?['first_thinking_token']:[])];
 }
 return [];
}
export class VoiceProfiler {
  traces:VoiceTrace[]=[];
  current?:VoiceTrace;
  private next=0;
  constructor(private changed:()=>void=()=>{},private clock:()=>number=()=>performance.now()){}
  begin(){
    if(this.current?.status==='recording'&&!this.current.marks.some(m=>m.name==='send')) return this.current;
    if(this.current?.status==='recording')this.current.status='interrupted';
    const trace={id:++this.next,started:this.clock(),marks:[],status:'recording'};
    this.current=trace;this.traces=[...this.traces.slice(-19),trace];this.mark('speech_start',undefined,trace);return trace;
  }
  mark(name:string,detail?:VoiceMark['detail'],trace=this.current,at=this.clock()){
    if(!trace||trace.status!=='recording'||trace.marks.length>=2000)return;
    if(name.startsWith('first_')&&trace.marks.some(m=>m.name===name))return;
    trace.marks.push({name,at,detail});
    if(name==='reply_playback_estimate')trace.status='complete';
    this.changed();
  }
  lastSpeech(){const t=this.current;if(!t||t.status!=='recording'||t.marks.some(m=>m.name==='send'))return;const m=t.marks.find(m=>m.name==='last_speech');if(m)m.at=this.clock();else this.mark('last_speech');}
  close(status:string){if(this.current?.status==='recording'){this.current.status=status;this.changed();}}
}
export function voiceProfileSummary(trace:VoiceTrace){
 const first=(name:string)=>trace.marks.find(m=>m.name===name)?.at;
 const last=(name:string)=>trace.marks.filter(m=>m.name===name).at(-1)?.at;
 const start=last('last_speech'),end=first('reply_playback_estimate');
 if(start===undefined||end===undefined||end<=start)return null;
 const checkpoints:[string,number|undefined][]=[[msg('Turn detection'),last('endpoint')],[msg('Remaining transcription'),last('transcript_ready')],[msg('Dispatch / pending abort'),first('send')],[msg('Request setup / prefill → first token'),first('first_model_token')],[msg('Thinking / tools → first reply text'),first('first_text')],[msg('Sentence accumulation'),first('reply_chunk')],[msg('TTS queue'),first('reply_tts_request')],[msg('TTS request → first audio bytes'),first('reply_first_bytes')],[msg('Audio buffering / decoding'),first('reply_audio_ready')],[msg('Playback queue / output estimate'),end]];
 let cursor=start;const stages=[];
 for(const [label,at] of checkpoints){if(at===undefined)continue;const stop=Math.max(cursor,Math.min(end,at));stages.push({label,ms:stop-cursor,percent:(stop-cursor)/(end-start)*100});cursor=stop;}
 return {totalMs:end-start,speechToAudioMs:end-trace.started,stages};
}
