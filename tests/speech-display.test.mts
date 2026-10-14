import { test } from 'node:test';
import assert from 'node:assert/strict';
import { displaySpeechText, speechChunks } from '../core/web/src/voice.js';
import { buildTranscript } from '../core/web/src/transcript.js';
test('speech cues stay in TTS input but disappear from display including partial streamed tags', () => {
 const text = '(laugh) Hello. (cough) Excuse me. (clears throat) Ready. (sigh) Yes.';
 assert.equal(displaySpeechText(text, true), 'Hello. Excuse me. Ready. Yes.');
 assert.ok(speechChunks(text)[0].includes('(laugh)'));
 assert.equal(displaySpeechText('Hello. (cle', false), 'Hello.');
 assert.equal(displaySpeechText('Hello (for now)', true), 'Hello (for now)');
});
test('only responses to audio-marked requests get display filtering', () => {
 const events = [
  {seq:1,type:'portal_prompt',payload:{message:'Hello',voice:true}},
  {seq:2,type:'message_update',payload:{assistantMessageEvent:{type:'text_delta',delta:'(laugh) Hi.'}}},
  {seq:3,type:'portal_prompt',payload:{message:'Explain the tag'}},
  {seq:4,type:'message_update',payload:{assistantMessageEvent:{type:'text_delta',delta:'Use (laugh).'}}},
 ] as any;
 const items = buildTranscript(events);
 assert.equal(items[1].audio, true); assert.equal(items[3].audio, false);
 assert.equal(items[1].text, '(laugh) Hi.');
});
