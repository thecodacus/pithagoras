import test from 'node:test';
import assert from 'node:assert/strict';
import { activity, buildTranscript } from '../web/src/transcript.ts';
import { appendLiveEvent, resetLiveEvents } from '../web/src/live-events.ts';
const done = { seq: 12, type: 'message_end', payload: { streamId: 'reply', message: { role: 'assistant', content: [{type: 'thinking', thinking: 'Plan'}, {type: 'text', text: 'Hello world'}] } } };
const update = {seq: -1, type: 'message_update', payload: {streamId: 'reply', assistantMessageEvent: {type: 'text_delta', delta: 'Hello'}}};
test('completed messages replay without saved deltas', () => {
 assert.deepEqual(buildTranscript([done]), [{kind:'assistant', id:'areply', text:'Hello world', thinking:'Plan', done:true, audio:false}]);
});
test('final message replaces live deltas with a stable id and no duplicate speech', () => {
 const before=buildTranscript([update]);
 const events=appendLiveEvent([update],done);
 assert.equal(events.length,1);
 const after=buildTranscript(events);
 assert.equal(before[0].id,after[0].id);
 assert.equal(after.length,1);
 assert.equal((after[0] as any).text,'Hello world');
});
test('old stored deltas plus completed snapshots are not duplicated', () => {
 assert.equal((buildTranscript([{...update,seq:1},done])[0] as any).text,'Hello world');
});
test('reconnect clears stale live updates and restores one current snapshot', () => {
 const snapshot={seq:-3,type:'message_snapshot',payload:done.payload};
 const events=appendLiveEvent(resetLiveEvents([update]),snapshot);
 assert.equal((buildTranscript(events)[0] as any).text,'Hello world');
 assert.equal((buildTranscript(events)[0] as any).done,false);
});
test('tool updates replace prior snapshots and disappear on completion', () => {
 const a={seq:-1,type:'tool_execution_update',payload:{toolCallId:'t',partialResult:{content:[]}}};
 const b={...a,seq:-2};
 const events=appendLiveEvent([a],b); assert.equal(events.length,1);
 const final={seq:3,type:'tool_execution_end',payload:{toolCallId:'t'}};
 assert.deepEqual(appendLiveEvent(events,final),[final]);
});

test('restored live snapshots show writing activity instead of prefill', () => {
 assert.equal(activity([{seq:-4,type:'message_snapshot',payload:done.payload}]).label,'writing the reply');
});
