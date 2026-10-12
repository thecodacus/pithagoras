import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inProcessHome } from './helpers.mts';
inProcessHome('pithagoras-canvas-test-');
const {getDb}=await import('../server/src/db.js');
const {CanvasTools,WriteStream,canvasWritePrefix}=await import('../server/src/pi/canvas-tools.js');
const {readCanvas,editCanvas,listCanvases,persistCanvas,restoreCanvas,forgetCanvases,createCanvas,interruptCanvasWrites}=await import('../server/src/canvases.js');
getDb().prepare('INSERT INTO sessions (id,title,workspace) VALUES (?,?,?)').run('s1','test','/tmp');
getDb().prepare('INSERT INTO sessions (id,title,workspace) VALUES (?,?,?)').run('s2','other','/tmp');
function setup(){const controller=new CanvasTools('s1');const tools:Record<string,any>={};controller.extension({registerTool:(t:any)=>tools[t.name]=t} as any);return {controller,tools};}
const value=(r:any)=>{assert.equal(r.content[0].type,'text');return JSON.parse(r.content[0].text)};
function delta(controller:any,id:string,raw:string){controller.observe({type:'message_update',assistantMessageEvent:{type:'toolcall_delta',contentIndex:0,delta:raw,partial:{content:[{type:'toolCall',name:'canvas_write',id}]}}});}
test('partial JSON decoder preserves escapes and does not invent incomplete Unicode',()=>{
 assert.deepEqual(canvasWritePrefix('{"canvas_id":"abc","revision":0,"operation":"replace","content":"hello\\nworld\\u26'),{canvas_id:'abc',revision:0,operation:'replace',content:'hello\nworld'});
 assert.equal(canvasWritePrefix('{"canvas_id":"abc') ,undefined);
 assert.equal(canvasWritePrefix('{"canvas_id":"abc","revision":0,"operation":"append","content":"quote: \\" yes')?.content,'quote: " yes');
});
test('streamed content is retained in memory before execution and survives interruption; appending does not duplicate',async()=>{
 const {controller,tools}=setup();const row=value(await tools.canvas_create.execute('create',{title:'Document'}));
 delta(controller,'write',`{"canvas_id":"${row.id}","revision":0,"operation":"replace","content":"First`);
 assert.equal(readCanvas('s1',row.id).content,'First');assert.equal(readCanvas('s1',row.id).status,'writing');
 delta(controller,'write',' line\\nSecond');controller.interrupt();
 let saved=readCanvas('s1',row.id);assert.equal(saved.content,'First line\nSecond');assert.equal(saved.status,'interrupted');assert.equal(saved.active_call,null);
 saved=value(await tools.canvas_read.execute('read',{canvas_id:row.id}));
 const args={canvas_id:row.id,revision:saved.revision,operation:'append',content:' paragraph.'};
 delta(controller,'append',JSON.stringify(args));value(await tools.canvas_write.execute('append',args));
 assert.equal(readCanvas('s1',row.id).content,'First line\nSecond paragraph.');
});
test('manual edits require a new read, even if the AI guesses the latest revision',async()=>{
 const {controller,tools}=setup();let row=value(await tools.canvas_create.execute('create',{title:'Human edits'}));
 row=editCanvas('s1',row.id,row.revision,row.title,'Human words');assert.equal(row.status,'edited');
 const args={canvas_id:row.id,revision:row.revision,operation:'replace',content:'AI words'};
 await assert.rejects(tools.canvas_write.execute('stale',args),/Read this canvas/);
 assert.equal(readCanvas('s1',row.id).content,'Human words');
 value(await tools.canvas_read.execute('read',{canvas_id:row.id}));value(await tools.canvas_write.execute('fresh',args));assert.equal(readCanvas('s1',row.id).content,'AI words');
 controller.interrupt();
});
test('future revisions recover during streaming and execution without bypassing edit guards',async()=>{
 const {controller,tools}=setup();const row=value(await tools.canvas_create.execute('create',{title:'Future revision'}));
 const args={canvas_id:row.id,revision:100,operation:'replace',content:'First line'};
 delta(controller,'future',`{"canvas_id":"${row.id}","revision":100,"operation":"replace","content":"First`);
 assert.equal(readCanvas('s1',row.id).content,'First');
 value(await tools.canvas_read.execute('read-active',{canvas_id:row.id}));
 await assert.rejects(tools.canvas_write.execute('concurrent',args),/being written/);
 delta(controller,'future',' line"}');
 const result=value(await tools.canvas_write.execute('future',args));
 assert.equal(result.revision,readCanvas('s1',row.id).revision);
 assert.equal(readCanvas('s1',row.id).content,'First line');
 assert.equal(readCanvas('s1',row.id).active_call,null);
 await assert.rejects(tools.canvas_write.execute('stale',{...args,revision:0}),/current revision/);
 value(await tools.canvas_write.execute('direct',{...args,operation:'append',content:' again'}));
 let current=readCanvas('s1',row.id);
 assert.equal(current.content,'First line again');
 current=editCanvas('s1',row.id,current.revision,current.title,'Human edit');
 await assert.rejects(tools.canvas_write.execute('unread',args),/Read this canvas/);
 assert.equal(readCanvas('s1',row.id).content,'Human edit');
});
test('session scope and revision checks protect other documents and active writes',async()=>{
 const {controller,tools}=setup();const row=value(await tools.canvas_create.execute('create',{title:'Scoped'}));
 assert.throws(()=>readCanvas('s2',row.id),/not found/);assert.equal(listCanvases('s2').length,0);
 delta(controller,'write',`{"canvas_id":"${row.id}","revision":0,"operation":"replace","content":"draft`);
 assert.throws(()=>editCanvas('s1',row.id,1,'Scoped','clobber'),/being written/);
 controller.observe({type:'message_end',message:{stopReason:'aborted'}});
 assert.equal(readCanvas('s1',row.id).status,'interrupted');
 const current=readCanvas('s1',row.id);value(await tools.canvas_delete.execute('delete',{canvas_id:row.id,revision:current.revision}));assert.throws(()=>readCanvas('s1',row.id),/not found/);
});
test('AI can continue its own edits without rereading, including in a resumed controller',async()=>{
 const {tools}=setup();const row=value(await tools.canvas_create.execute('create',{title:'Continue'}));
 const first=value(await tools.canvas_write.execute('one',{canvas_id:row.id,revision:0,operation:'replace',content:'One'}));
 const second=value(await tools.canvas_write.execute('two',{canvas_id:row.id,revision:first.revision,operation:'append',content:' two'}));
 const resumed=setup();value(await resumed.tools.canvas_write.execute('three',{canvas_id:row.id,revision:second.revision,operation:'append',content:' three'}));
 assert.equal(readCanvas('s1',row.id).content,'One two three');
});

test('installed agent runtime forwards canvas data and errors to the next model request',async()=>{
 // pi's own agent core, wherever npm put it: beside pi, or inside it.
 const core=createRequire(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'))).resolve('@earendil-works/pi-agent-core/package.json');
 const {runAgentLoop}=await import(pathToFileURL(join(dirname(core),'dist','agent-loop.js')).href);
 const {tools}=setup();const created=value(await tools.canvas_create.execute('create',{title:'Visible to model'}));
 let calls=0;
 const stream=async(_model:any,context:any)=>{
  calls++;
  if(calls===2){
   const results=context.messages.filter((m:any)=>m.role==='toolResult');
   const listed=results.find((m:any)=>m.toolName==='canvas_list');assert.equal(listed.isError,false);
   assert.ok(JSON.parse(listed.content[0].text).some((row:any)=>row.id===created.id&&row.title==='Visible to model'));
   const missing=results.find((m:any)=>m.toolName==='canvas_read');assert.equal(missing.isError,true);assert.match(missing.content[0].text,/Canvas not found/);
  }
  assert.ok(calls<=2);
  const message={role:'assistant',api:'openai-completions',provider:'test',model:'test',timestamp:Date.now(),usage:{input:0,output:0,totalTokens:0,cost:{input:0,output:0,total:0}},stopReason:calls===1?'toolUse':'stop',content:calls===1?[{type:'toolCall',id:'list',name:'canvas_list',arguments:{}},{type:'toolCall',id:'missing',name:'canvas_read',arguments:{canvas_id:'not-a-real-id'}}]:[{type:'text',text:'I can see the canvas.'}]};
  return {async *[Symbol.asyncIterator](){yield {type:'done',message};},result:async()=>message};
 };
 await runAgentLoop([{role:'user',content:'List canvases',timestamp:Date.now()}],{systemPrompt:'',messages:[],tools:Object.values(tools)},{model:{id:'test',provider:'test',api:'openai-completions'},convertToLlm:(messages:any)=>messages},()=>{},undefined,stream);
 assert.equal(calls,2);
});


test('temporary canvases never reach SQLite until stored, including mid-stream; future edits auto-save',async()=>{
 const {controller,tools}=setup();const row=value(await tools.canvas_create.execute('temp',{title:'Temporary'}));
 const stored=()=>getDb().prepare('SELECT * FROM canvases WHERE id=?').get(row.id) as any;
 assert.equal(row.persisted,false);assert.equal(stored(),undefined);
 delta(controller,'live',`{"canvas_id":"${row.id}","revision":0,"operation":"replace","content":"Draft`);
 assert.equal(stored(),undefined);
 assert.throws(()=>persistCanvas('s2',row.id),/not found/);
 const saved=persistCanvas('s1',row.id);assert.equal(saved.persisted,true);assert.equal(stored().content,'Draft');
 assert.equal(persistCanvas('s1',row.id).id,row.id);assert.equal(listCanvases('s1').filter(r=>r.id===row.id).length,1);
 delta(controller,'live',' continues');controller.interrupt();
 assert.equal(stored().content,'Draft continues');assert.equal(stored().active_call,null);
 const current=readCanvas('s1',row.id);editCanvas('s1',row.id,current.revision,'Stored','Human edit');
 assert.equal(stored().content,'Human edit');
 const fresh=value(await tools.canvas_read.execute('read',{canvas_id:row.id}));
 const result=value(await tools.canvas_write.execute('later',{canvas_id:row.id,revision:fresh.revision,operation:'append',content:' and AI'}));
 assert.equal(result.persisted,true);assert.equal(stored().content,'Human edit and AI');
});
test('a streamed write is one revision however many pieces it arrives in',async()=>{
 const {controller,tools}=setup();const row=value(await tools.canvas_create.execute('create',{title:'Streamed'}));
 const args={canvas_id:row.id,revision:0,operation:'replace',content:''};
 const raw=JSON.stringify({...args,content:'word '.repeat(200)});
 const head=raw.slice(0,raw.indexOf('"content":"')+11);
 delta(controller,'draft',head);
 for(const piece of raw.slice(head.length).match(/.{1,5}/g)!)delta(controller,'draft',piece);
 assert.equal(readCanvas('s1',row.id).revision,1);
 const first=value(await tools.canvas_write.execute('draft',{...args,content:'word '.repeat(200)}));
 assert.equal(first.revision,1);
 const next={canvas_id:row.id,revision:1,operation:'append',content:'more words '.repeat(50)};
 const raw2=JSON.stringify(next);
 for(const piece of raw2.match(/.{1,7}/g)!)delta(controller,'second',piece);
 assert.equal(value(await tools.canvas_write.execute('second',next)).revision,2);
});

// A long document streams in as thousands of pieces: each is decoded once, and the table is written now and then.
test('a streamed argument is decoded the same however it is cut up, and nothing half-finished is kept',()=>{
 const text='Ünï "quoted" \\ slash\nline\ttab \u{1F600} end \u2603 done';
 const raw=JSON.stringify({canvas_id:'abc',revision:3,operation:'replace',content:text})+'\n';
 for(const size of [1,2,3,5,7,64]){
  const stream=new WriteStream();let last:any;
  for(let i=0;i<raw.length;i+=size)last=stream.push(raw.slice(i,i+size))??last;
  assert.deepEqual(last,{canvas_id:'abc',revision:3,operation:'replace',content:text},`in pieces of ${size}`);
 }
 // Cut anywhere: what has come is a start of the text, never a character that is not there yet.
 for(let cut=0;cut<=raw.length;cut++){
  const content=new WriteStream().push(raw.slice(0,cut))?.content;
  if(content!==undefined)assert.ok(text.startsWith(content),`cut at ${cut}: ${JSON.stringify(content)}`);
 }
 const pair=new WriteStream();pair.push('{"canvas_id":"a","revision":0,"operation":"append","content":"x\\ud83d');
 assert.equal(pair.push('')?.content,'x');
 assert.equal(pair.push('\\ude00 y"}')?.content,'x\u{1F600} y');
 const bad=new WriteStream();bad.push('{"canvas_id":"a","revision":0,"operation":"append","content":"ab\\qcd');
 assert.equal(bad.push('more')?.content,'ab');
 const wrongOrder=new WriteStream().push('{"content":"text","canvas_id":"a"}');
 assert.deepEqual(wrongOrder,{content:'text'});
});
test('a long write costs the same for each piece however much has come before',async()=>{
 const {controller,tools}=setup();const row=value(await tools.canvas_create.execute('create',{title:'Long document'}));
 delta(controller,'long',`{"canvas_id":"${row.id}","revision":0,"operation":"replace","content":"`);
 const started=performance.now();
 for(let i=0;i<40_000;i++)delta(controller,'long',i%80===79?'\\n':'w');
 const took=performance.now()-started;
 assert.equal(readCanvas('s1',row.id).content.length,40_000);
 // Decoding the whole argument again for each piece took half a minute for a hundred thousand characters.
 assert.ok(took<3000,`forty thousand pieces took ${Math.round(took)} ms`);
 controller.interrupt();
});
async function storedCanvas(tools:any,text:string,title='Stored'){
 const row=value(await tools.canvas_create.execute('create-'+title,{title}));
 value(await tools.canvas_write.execute('first-'+title,{canvas_id:row.id,revision:0,operation:'replace',content:text}));
 persistCanvas('s1',row.id);return row.id as string;
}
const inTable=(id:string)=>getDb().prepare('SELECT content, previous_content, active_call, status FROM canvases WHERE id=?').get(id) as any;
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
test('a stored canvas that is being written reaches the table every so often and when the write ends',async()=>{
 const {controller,tools}=setup();const before='x'.repeat(5000);const id=await storedCanvas(tools,before,'Throttled');
 const fresh=value(await tools.canvas_read.execute('read',{canvas_id:id}));
 const db=getDb() as any;const prepare=db.prepare.bind(db);const selects:string[]=[];let writes=0;
 db.prepare=(sql:string)=>{if(/^UPDATE canvases SET title/.test(sql))writes++;if(/^SELECT/.test(sql))selects.push(sql);return prepare(sql)};
 try{
  delta(controller,'w',`{"canvas_id":"${id}","revision":${fresh.revision},"operation":"replace","content":"`);
  delta(controller,'w','y');selects.length=0;
  for(let i=1;i<300;i++)delta(controller,'w','y');
  assert.equal(readCanvas('s1',id).content,'y'.repeat(300),'what is read is the text so far');
  assert.ok(writes<=1,`${writes} writes of the whole document for 300 pieces`);
  assert.deepEqual(selects.filter(sql=>/FROM canvases/.test(sql)),[],'the text so far is not read back from the table');
  assert.equal(inTable(id).content,before,'the table has the text from before, not every piece');
  // Held and not forgotten: it is written once the pieces stop.
  await sleep(900);
  assert.equal(inTable(id).content,'y'.repeat(300));
  for(let i=0;i<100;i++)delta(controller,'w','z');
  assert.equal(inTable(id).content,'y'.repeat(300));
  controller.interrupt();
  assert.equal(inTable(id).content,'y'.repeat(300)+'z'.repeat(100));
  assert.equal(inTable(id).active_call,null);
 }finally{delete db.prepare}
});
test('a replace that is cut off leaves the document it was rewriting to go back to',async()=>{
 const {controller,tools}=setup();
 const original='First paragraph.\n\nSecond paragraph.\n\nThird paragraph.';const id=await storedCanvas(tools,original,'Cut off');
 const fresh=value(await tools.canvas_read.execute('read',{canvas_id:id}));
 assert.equal(fresh.restorable,false);
 delta(controller,'cut',`{"canvas_id":"${id}","revision":${fresh.revision},"operation":"replace","content":"First para`);
 assert.equal(inTable(id).previous_content,original,'kept while the write goes on');
 assert.equal(readCanvas('s1',id).restorable,true);
 assert.equal('previous_content' in readCanvas('s1',id),false,'the old text is not sent along with every row');
 controller.interrupt();
 const cut=readCanvas('s1',id);
 assert.equal(cut.content,'First para');assert.equal(cut.status,'interrupted');assert.equal(cut.restorable,true);
 assert.equal(listCanvases('s1').find(row=>row.id===id)!.restorable,true);
 assert.throws(()=>restoreCanvas('s1',id,cut.revision-1),/Reload/);
 const back=restoreCanvas('s1',id,cut.revision);
 assert.equal(back.content,original);assert.equal(back.status,'edited');assert.equal(back.revision,cut.revision+1);assert.equal(back.restorable,false);
 assert.equal(inTable(id).content,original);assert.equal(inTable(id).previous_content,null);
 assert.throws(()=>restoreCanvas('s1',id,back.revision),/no earlier version/);
 await assert.rejects(tools.canvas_write.execute('stale',{canvas_id:id,revision:back.revision,operation:'append',content:'!'}),/Read this canvas/);
});
test('the text from before a write is let go when the write goes through, or the person edits',async()=>{
 const {controller,tools}=setup();
 const original='The whole of the document, as it was.';const id=await storedCanvas(tools,original,'Let go');
 let row=value(await tools.canvas_read.execute('read',{canvas_id:id}));
 const done={canvas_id:id,revision:row.revision,operation:'replace',content:'A new text'};
 delta(controller,'ok',JSON.stringify(done));
 assert.equal(inTable(id).previous_content,original);
 value(await tools.canvas_write.execute('ok',done));
 assert.equal(inTable(id).previous_content,null);assert.equal(readCanvas('s1',id).restorable,false);assert.equal(readCanvas('s1',id).content,'A new text');
 // A cut-off write that is tried again keeps the text from before the first one, until one goes through.
 row=readCanvas('s1',id);
 delta(controller,'one',`{"canvas_id":"${id}","revision":${row.revision},"operation":"replace","content":"Tr`);controller.interrupt();
 row=value(await tools.canvas_read.execute('read',{canvas_id:id}));
 delta(controller,'two',`{"canvas_id":"${id}","revision":${row.revision},"operation":"replace","content":"Tried again, and`);controller.interrupt();
 assert.equal(readCanvas('s1',id).content,'Tried again, and');
 assert.equal(restoreCanvas('s1',id,readCanvas('s1',id).revision).content,'A new text');
 // The person takes the text over: there is nothing to go back to.
 row=value(await tools.canvas_read.execute('read',{canvas_id:id}));
 delta(controller,'three',`{"canvas_id":"${id}","revision":${row.revision},"operation":"replace","content":"Cut`);controller.interrupt();
 row=readCanvas('s1',id);assert.equal(row.restorable,true);
 editCanvas('s1',id,row.revision,row.title,'My own words');
 assert.equal(readCanvas('s1',id).restorable,false);assert.equal(inTable(id).previous_content,null);
 // A document that was empty has nothing to go back to.
 const empty=value(await tools.canvas_create.execute('empty',{title:'Empty'}));persistCanvas('s1',empty.id);
 delta(controller,'e',`{"canvas_id":"${empty.id}","revision":0,"operation":"replace","content":"Some`);controller.interrupt();
 assert.equal(readCanvas('s1',empty.id).restorable,false);assert.equal(inTable(empty.id).previous_content,null);
});
test('a temporary canvas can go back too, and takes the old text along when it is stored',async()=>{
 const {controller,tools}=setup();
 const row=value(await tools.canvas_create.execute('create',{title:'Temporary cut'}));
 value(await tools.canvas_write.execute('first',{canvas_id:row.id,revision:0,operation:'replace',content:'Kept text'}));
 const current=readCanvas('s1',row.id);
 delta(controller,'cut',`{"canvas_id":"${row.id}","revision":${current.revision},"operation":"replace","content":"Ke`);controller.interrupt();
 assert.equal(readCanvas('s1',row.id).restorable,true);assert.equal(readCanvas('s1',row.id).persisted,false);
 const stored=persistCanvas('s1',row.id);
 assert.equal(stored.restorable,true);assert.equal(inTable(row.id).previous_content,'Kept text');
 assert.equal(restoreCanvas('s1',row.id,stored.revision).content,'Kept text');
 const other=value(await tools.canvas_create.execute('create',{title:'Never stored'}));
 value(await tools.canvas_write.execute('o1',{canvas_id:other.id,revision:0,operation:'replace',content:'Kept as well'}));
 delta(controller,'cut2',`{"canvas_id":"${other.id}","revision":${readCanvas('s1',other.id).revision},"operation":"replace","content":"K`);controller.interrupt();
 assert.equal(restoreCanvas('s1',other.id,readCanvas('s1',other.id).revision).content,'Kept as well');
 assert.equal(readCanvas('s1',other.id).persisted,false);
});
test('a write cut off by a restart can be gone back from; what was held back is the loss',async()=>{
 const {controller,tools}=setup();
 const original='A document the restart should not cost.';const id=await storedCanvas(tools,original,'Restart');
 const row=value(await tools.canvas_read.execute('read',{canvas_id:id}));
 const calm=await storedCanvas(tools,'Nobody is writing to this one.','Calm');
 const calmBefore=inTable(calm);
 delta(controller,'r',`{"canvas_id":"${id}","revision":${row.revision},"operation":"replace","content":"A doc`);
 // The server stops here: nothing held in memory is left, and what it does at start is this.
 forgetCanvases('s1');
 // What the write had moved on in the table is not what the agent had read.
 getDb().prepare('UPDATE canvases SET agent_read_revision = NULL WHERE id = ?').run(id);
 interruptCanvasWrites();
 // A canvas no write was going on in is left as it was.
 assert.deepEqual(inTable(calm),calmBefore);
 const after=readCanvas('s1',id);
 assert.equal(after.restorable,true);
 // No call is running any more, the canvas says it was cut off, and it counts as read: the agent may write to it again.
 assert.deepEqual([after.status,after.active_call,after.agent_read_revision],['interrupted',null,after.revision]);
 assert.equal(restoreCanvas('s1',id,after.revision).content,original);
});
test('temporary canvases of a chat that is gone are let go, and nothing else is',async()=>{
 const {controller,tools}=setup();
 const keep=value(await tools.canvas_create.execute('keep',{title:'Stays'}));
 const gone=createCanvas('s2','Unsaved').id;
 forgetCanvases('s2');
 assert.deepEqual(listCanvases('s2'),[]);assert.throws(()=>readCanvas('s2',gone),/not found/);
 assert.equal(readCanvas('s1',keep.id).title,'Stays');
 controller.interrupt();
});
test('the restore route puts the text from before the cut-off write back',async()=>{
 const express=(await import('express')).default;const {canvasesRouter}=await import('../server/src/api/canvases.js');
 const portal=express().use(express.json()).use('/api',canvasesRouter()).listen(0,'127.0.0.1');
 await new Promise(resolve=>portal.once('listening',resolve));
 const at=`http://127.0.0.1:${(portal.address() as {port:number}).port}/api/sessions/s1/canvases`;
 try{
  const {controller,tools}=setup();const original='The text the route brings back.';const id=await storedCanvas(tools,original,'Route');
  const row=value(await tools.canvas_read.execute('read',{canvas_id:id}));
  const post=(body:any)=>fetch(`${at}/${id}/restore`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  assert.equal((await post({revision:row.revision})).status,409,'nothing to go back to yet');
  delta(controller,'cut',`{"canvas_id":"${id}","revision":${row.revision},"operation":"replace","content":"The te`);controller.interrupt();
  const listed=await (await fetch(at)).json() as any[];
  assert.equal(listed.find(c=>c.id===id).restorable,true);
  assert.equal((await post({})).status,409,'a revision is needed');
  const cut=readCanvas('s1',id);
  assert.equal((await post({revision:cut.revision-1})).status,409,'an older revision is refused');
  const back=await post({revision:cut.revision});
  assert.equal(back.status,200);
  const body=await back.json() as any;
  assert.equal(body.content,original);assert.equal(body.restorable,false);assert.equal(readCanvas('s1',id).content,original);
 }finally{portal.close()}
});
// A call whose arguments come in one piece (a provider that does not stream them token by token) hands the new text
// to a canvas that still holds the old document: text of the same length is a different text all the same.
test('a replace with text as long as the old document is written, whole or in one piece',async()=>{
 const {controller,tools}=setup();
 const temporary=value(await tools.canvas_create.execute('create',{title:'Same length'}));
 value(await tools.canvas_write.execute('first',{canvas_id:temporary.id,revision:0,operation:'replace',content:'Meet at 10:00 on Monday'}));
 const before=value(await tools.canvas_read.execute('read',{canvas_id:temporary.id}));
 const whole={canvas_id:temporary.id,revision:before.revision,operation:'replace',content:'Meet at 09:15 on Friday'};
 value(await tools.canvas_write.execute('same',whole));
 assert.equal(readCanvas('s1',temporary.id).content,'Meet at 09:15 on Friday','execute alone');
 const id=await storedCanvas(tools,'Budget: 4000 EUR','Same length stored');
 const fresh=value(await tools.canvas_read.execute('read-stored',{canvas_id:id}));
 const args={canvas_id:id,revision:fresh.revision,operation:'replace',content:'Budget: 9500 EUR'};
 delta(controller,'one-piece',JSON.stringify(args));
 value(await tools.canvas_write.execute('one-piece',args));
 assert.equal(readCanvas('s1',id).content,'Budget: 9500 EUR','one toolcall_delta with the whole arguments');
 assert.equal(inTable(id).content,'Budget: 9500 EUR');
 // The same text again is still not written twice.
 const again=value(await tools.canvas_read.execute('read-again',{canvas_id:id}));
 const revision=again.revision;
 value(await tools.canvas_write.execute('same-text',{...args,revision}));
 assert.equal(readCanvas('s1',id).content,'Budget: 9500 EUR');
});
