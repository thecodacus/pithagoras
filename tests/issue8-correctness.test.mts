import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const temp=mkdtempSync(join(tmpdir(),'pitha-correctness-'));process.env.DATA_DIR=temp;process.env.SESSION_DIR=join(temp,'sessions');
const {SdkPiClient}=await import('../server/src/pi/sdk-client.ts');
const {sessions}=await import('../server/src/session-manager.ts');
const {getDb,pendingNotes,consumeNotes}=await import('../server/src/db.ts');
const {buildTranscript}=await import('../web/src/transcript.ts');
test.after(()=>{getDb().close();rmSync(temp,{recursive:true,force:true});});

test('answered dialog clears its timer and cannot cancel a later dialog',async(t)=>{
 t.mock.timers.enable({apis:['setTimeout']});
 const client=new (SdkPiClient as any)({}, {},()=>{});const events:any[]=[];client.on('event',(e:any)=>events.push(e));
 const ui=client.buildUiContext();const first=ui.confirm('first','?',{timeout:100});
 client.respondUi(events[0].id,{value:true});assert.equal(await first,true);
 const second=ui.confirm('second','?',{timeout:1000});t.mock.timers.tick(100);
 assert.equal(events.filter(e=>e.type==='extension_ui_cancel').length,0);
 client.respondUi(events[1].id,{value:true});assert.equal(await second,true);t.mock.timers.tick(2000);
 assert.equal(events.filter(e=>e.type==='extension_ui_cancel').length,0);
});

test('parallel same-name tools settle by call id, not completion order',()=>{
 const events=[{seq:1,type:'tool_execution_start',payload:{toolName:'bash',toolCallId:'a'}},{seq:2,type:'tool_execution_start',payload:{toolName:'bash',toolCallId:'b'}},{seq:3,type:'tool_execution_end',payload:{toolName:'bash',toolCallId:'a',isError:true}}];
 const items=buildTranscript(events) as any[];assert.equal(items[0].status,'error');assert.equal(items[1].status,'running');
});

test('queued preparation waits for an active turn and notes consume only on acceptance',async()=>{
 const db=getDb();db.prepare('INSERT INTO sessions (id,title,workspace,status) VALUES (?,?,?,?)').run('queue','test','/tmp','running');
 db.prepare('INSERT INTO notes (session_id,text) VALUES (?,?)').run('queue','report');
 const manager=new (sessions.constructor as any)();
 db.prepare("UPDATE sessions SET status='running' WHERE id='queue'").run();
 manager.ensureClient=async()=>({});let prepared=false,accepted=false;
 manager.prompt=async()=>{accepted=true;db.prepare("UPDATE sessions SET status='idle' WHERE id='queue'").run();manager.emit('session:queue',{type:'portal_status',payload:JSON.stringify({status:'idle'})});};
 const ask=manager.ask('queue',()=>{const notes=pendingNotes('queue');return {message:notes.map(n=>n.text).join(''),onAccepted:()=>consumeNotes('queue',notes.map(n=>n.id))};},{beforeTurn:()=>{prepared=true;},timeoutMs:1000});
 await new Promise(r=>setImmediate(r));assert.equal(prepared,false);assert.equal(pendingNotes('queue').length,1);
 db.prepare("UPDATE sessions SET status='idle' WHERE id='queue'").run();manager.emit('session:queue',{type:'portal_status',payload:'{"status":"idle"}'});
 await ask;assert.equal(prepared,true);assert.equal(accepted,true);assert.equal(pendingNotes('queue').length,0);
});

test('failed startup leaves queued notes unread',async()=>{
 getDb().prepare('INSERT INTO sessions (id,title,workspace) VALUES (?,?,?)').run('fail','test','/tmp');
 getDb().prepare('INSERT INTO notes (session_id,text) VALUES (?,?)').run('fail','keep');
 const manager=new (sessions.constructor as any)();manager.ensureClient=async()=>{throw new Error('launch failed');};
 await assert.rejects(manager.ask('fail',()=>{const notes=pendingNotes('fail');return {message:'test',onAccepted:()=>consumeNotes('fail',notes.map(n=>n.id))};}),/launch failed/);
 assert.equal(pendingNotes('fail').length,1);
});
