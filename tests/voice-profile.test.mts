import test from 'node:test';
import assert from 'node:assert/strict';
import {VoiceProfiler,replyMarks,voiceProfileSummary} from '../core/web/src/voice-profile.ts';
test('latency percentages partition wall time and exclude speculative STT and filler',()=>{
 let now=0;const p=new VoiceProfiler(()=>{},()=>now);const t=p.begin();
 now=100;p.mark('stt_request');now=200;p.lastSpeech();now=800;p.mark('stt_result');
 now=1200;p.mark('endpoint');p.mark('transcript_ready');p.mark('send');
 now=1400;p.mark('status_playback_estimate');assert.equal(t.status,'recording');
 now=2200;p.mark('first_model_token');now=2300;p.mark('first_text');
 now=2400;p.mark('reply_chunk');p.mark('reply_tts_request');now=2800;p.mark('reply_first_bytes');
 now=3000;p.mark('reply_audio_ready');now=3100;p.mark('reply_playback_estimate');
 const summary=voiceProfileSummary(t)!;assert.equal(summary.totalMs,2900);assert.equal(summary.speechToAudioMs,3100);
 assert.equal(summary.stages.reduce((n,s)=>n+s.ms,0),2900);assert.ok(Math.abs(summary.stages.reduce((n,s)=>n+s.percent,0)-100)<1e-8);
 assert.equal(summary.stages[1].ms,0);assert.equal(t.status,'complete');
});
test('interrupted turns do not receive callbacks from older TTS requests',()=>{
 let now=0;const p=new VoiceProfiler(()=>{},()=>now);const old=p.begin();p.mark('send');now=100;const next=p.begin();
 p.mark('reply_playback_estimate',undefined,old);assert.equal(old.status,'interrupted');assert.equal(next.status,'recording');assert.equal(voiceProfileSummary(old),null);
 p.mark('first_text');p.mark('first_text');assert.equal(next.marks.filter(m=>m.name==='first_text').length,1);
});
test('speech segments merge before dispatch and measurements stay bounded',()=>{
 const p=new VoiceProfiler();const t=p.begin();assert.equal(p.begin(),t);
 for(let i=0;i<2050;i++)p.mark('prefill_progress');assert.equal(t.marks.length,2000);
 p.close('stopped');assert.equal(t.status,'stopped');assert.notEqual(p.begin(),t);
});
test('the first tokens of a reply are seen in a token, and in the reply written so far as one entry',()=>{
 const token=(type:string,delta:string)=>({type:'message_update',payload:{assistantMessageEvent:{type,delta}}});
 assert.deepEqual(replyMarks(token('text_delta','Hi')),['first_model_token','first_text']);
 assert.deepEqual(replyMarks(token('thinking_delta','hm')),['first_model_token','first_thinking_token']);
 const written=(...content:object[])=>({type:'message_snapshot',payload:{message:{role:'assistant',content}}});
 assert.deepEqual(replyMarks(written({type:'text',text:'Hi'})),['first_model_token','first_text']);
 assert.deepEqual(replyMarks(written({type:'thinking',thinking:'hm'})),['first_model_token','first_thinking_token']);
 assert.deepEqual(replyMarks(written({type:'toolCall'})),['first_model_token']);
 assert.deepEqual(replyMarks(written()),[]);
 assert.deepEqual(replyMarks({type:'agent_end',payload:{}}),[]);
});
