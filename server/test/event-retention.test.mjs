import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
const dataDir=mkdtempSync(join(tmpdir(),'pithagoras-event-retention-'));
process.env.DATA_DIR=dataDir;
const {appendEvent,eventsSince,getDb}=await import('../dist/db.js');
const {LiveEvents}=await import('../dist/live-events.js');
test.after(()=>{getDb().close();rmSync(dataDir,{recursive:true,force:true});});

test('400 streaming deltas stay out of SQLite; completion saves one full message',()=>{
 const stream=new LiveEvents(appendEvent);let text='';const seen=new Set();let id;
 for(let i=0;i<400;i++){
  const delta=`chunk-${i};`;text+=delta;
  const message={role:'assistant',content:[{type:'text',text}]};
  const row=stream.record('long','message_update',{message,assistantMessageEvent:{type:'text_delta',delta,contentIndex:0,partial:message}});
  assert.ok(row.seq<0);assert.ok(!seen.has(row.seq));seen.add(row.seq);
  const payload=JSON.parse(row.payload);id??=payload.streamId;assert.equal(payload.streamId,id);
  assert.equal(payload.assistantMessageEvent.partial,undefined);
  assert.equal(payload.message,undefined);
 }
 assert.equal(eventsSince('long').length,0);
 const snapshots=stream.snapshot('long');assert.equal(snapshots.length,1);
 assert.equal(JSON.parse(snapshots[0].payload).message.content[0].text,text);
 const message={role:'assistant',content:[{type:'text',text}],stopReason:'stop'};
 stream.record('long','message_end',{type:'message_end',message});
 const rows=eventsSince('long');assert.equal(rows.length,1);assert.equal(rows[0].type,'message_end');
 assert.deepEqual(JSON.parse(rows[0].payload).message,message);
 assert.equal(JSON.parse(rows[0].payload).streamId,id);
 assert.deepEqual(stream.snapshot('long'),[]);
});

test('parallel tool updates keep only the latest per call, and results persist separately',()=>{
 const stream=new LiveEvents(appendEvent);
 for(let i=0;i<40;i++)for(const toolCallId of ['a','b'])stream.record('tools','tool_execution_update',{toolCallId,partialResult:{content:[{type:'text',text:String(i)}]}});
 assert.equal(eventsSince('tools').length,0);assert.equal(stream.snapshot('tools').length,2);
 assert.equal(JSON.parse(stream.snapshot('tools')[0].payload).partialResult.content[0].text,'39');
 stream.record('tools','tool_execution_end',{toolCallId:'b',result:{content:[{type:'text',text:'done'}]}});
 assert.equal(eventsSince('tools').length,1);
 assert.equal(stream.snapshot('tools').length,1);
 assert.equal(JSON.parse(stream.snapshot('tools')[0].payload).toolCallId,'a');
});

test('aborted assistant messages keep their partial content at the message boundary',()=>{
 const stream=new LiveEvents(appendEvent);
 const message={role:'assistant',content:[{type:'thinking',thinking:'Working'}],stopReason:'aborted'};
 stream.record('abort','message_update',{assistantMessageEvent:{type:'thinking_delta',delta:'Working',contentIndex:0,partial:message}});
 stream.record('abort','message_end',{message});
 assert.deepEqual(JSON.parse(eventsSince('abort')[0].payload).message,message);
 assert.equal(stream.snapshot('abort').length,0);
});

test('messages in another session and unknown lifecycle events remain intact',()=>{
 const stream=new LiveEvents(appendEvent);
 const payload={extensionData:{future:true}};
 stream.record('unknown','future_event',payload);
 assert.deepEqual(JSON.parse(eventsSince('unknown')[0].payload),payload);
 stream.record('active','message_update',{assistantMessageEvent:{type:'text_delta',contentIndex:0,delta:'Hi'}});
 assert.equal(stream.snapshot('unknown').length,0);
 assert.equal(JSON.parse(stream.snapshot('active')[0].payload).message.content[0].text,'Hi');
 stream.clear('active');assert.equal(stream.snapshot('active').length,0);
});
