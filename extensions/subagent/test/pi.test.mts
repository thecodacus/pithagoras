import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import subagentTool, {childModel, describe, waited} from '../src/pi.ts';
import { settingsOf, type Settings } from '../src/settings.ts';
import { scratch } from "../../../tests/helpers.mts";
/**
 * The `subagent` tool in a chat's pi (src/pi.ts), over a stand-in for pi and a stand-in for the child pi, with the
 * settings the server half would hand it: what `mode` says, read as the extension's store reads it.
 */
// A child pi in RPC mode, as far as the extension can tell. `retry`: its first run fails and is retried. `hang`: it works until stopped.
const dir=scratch('subagent-');
const bin=path.join(dir,'pi');
// What the deaf child writes once it has closed its input: the test sends it a message after that, not after a guess.
const deafFlag=path.join(dir,'deaf');
writeFileSync(bin,`#!/usr/bin/env node
const out=e=>process.stdout.write(JSON.stringify(e)+'\\n');
const say=t=>out({type:'message_end',message:{role:'assistant',content:[{type:'text',text:t}]}});
if(process.env.FAKE==='die')process.exit(1);
// Deaf to abort: it only ever ends when killed.
if(process.env.FAKE==='stubborn'){require('node:readline').createInterface({input:process.stdin}).on('line',l=>{if(JSON.parse(l).type==='prompt'){out({type:'agent_start'});say('thinking forever');}});setInterval(()=>{},1000);}
else
// What it was started with, as its answer.
if(process.env.FAKE==='childenv'){require('node:readline').createInterface({input:process.stdin}).on('line',l=>{if(JSON.parse(l).type==='prompt'){out({type:'agent_start'});say('child='+process.env.PI_SUBAGENT_CHILD);out({type:'agent_end'});out({type:'agent_settled'});}});}
else if(process.env.FAKE==='argv'){require('node:readline').createInterface({input:process.stdin}).on('line',l=>{if(JSON.parse(l).type==='prompt'){out({type:'agent_start'});say(process.argv.slice(2).join(' '));out({type:'agent_end'});out({type:'agent_settled'});}});}
else
// Its input closed, still running: what the portal sends it next finds no reader.
if(process.env.FAKE==='deaf'){require('node:fs').closeSync(0);require('node:fs').writeFileSync(${JSON.stringify(deafFlag)},'');setTimeout(()=>process.exit(1),800);}
else
require('node:readline').createInterface({input:process.stdin}).on('line',l=>{const c=JSON.parse(l);
 if(c.type==='prompt'&&process.env.FAKE==='refuse'){out({type:'response',command:'prompt',success:false,error:'No API key for the model'});return;}
 if(c.type==='prompt'&&process.env.FAKE==='noisy'){process.stderr.write('warning: '.repeat(40000));out({type:'agent_start'});say('done despite the noise');out({type:'agent_end'});out({type:'agent_settled'});return;}
 if(c.type==='prompt'){out({type:'agent_start'});
  if(process.env.FAKE==='hang'){say('half of it');return;}
  // A long run, for a second call that waits behind it.
  if(process.env.FAKE==='slow'){setTimeout(()=>{say('the whole answer');out({type:'agent_end'});out({type:'agent_settled'});},1300);return;}
  say('');out({type:'agent_end',willRetry:true});
  setTimeout(()=>{out({type:'agent_start'});say('the whole answer');out({type:'agent_end'});out({type:'agent_settled'});},50);}
 if(c.type==='abort'){out({type:'agent_end'});out({type:'agent_settled'});}
});
`);
chmodSync(bin,0o755);
process.env.PI_SUBAGENT_BIN=bin;
// The extension's settings, as its store hands them over: interrupt unless they say otherwise.
let current:Settings=settingsOf({});
const mode=(m?:string,more:Record<string,unknown>={})=>{current=settingsOf({...(m?{mode:m}:{}),...more});};
const settings=()=>current;
const subagent=(pi:any)=>subagentTool(pi,settings);
mode();
function load(){
 const h=new Map<string,((d:any)=>void)[]>();
 const events={emit:(c:string,d:any)=>h.get(c)?.forEach(f=>f(d)),on:(c:string,f:(d:any)=>void)=>{h.set(c,[...(h.get(c)??[]),f]);return()=>h.set(c,(h.get(c)??[]).filter(x=>x!==f));}};
 const hooks=new Map<string,()=>void>();
 const sent:{message:any,options:any}[]=[];
 let tool:any;subagent({registerTool:(t:any)=>tool=t,events,on:(e:string,f:()=>void)=>hooks.set(e,f),sendMessage:(message:any,options:any)=>sent.push({message,options})});
 const ends:any[]=[];events.on('subagent:v1:end',d=>ends.push(d));
 const seen:string[]=[];
 events.on('subagent:v1:start',d=>seen.push(`start ${d.toolCallId}`));
 events.on('subagent:v1:end',()=>seen.push('end'));
 return {tool,events,ends,sent,seen,hooks};
}
const until=async(ok:()=>boolean)=>{for(let i=0;i<200&&!ok();i++)await new Promise(r=>setTimeout(r,20));assert.ok(ok());};
// The ids of the children that have said something: one that has is running and reading, which is what a stop that wants its words has to wait for.
const spoken=(events:any)=>{const ids:string[]=[];events.on('subagent:v1:event',(d:any)=>d.event?.type==='message_end'&&ids.push(d.id));return ids;};
test('a subagent whose run is retried answers with what it said at the end, not before the retry',async()=>{
 delete process.env.FAKE;
 const {tool,ends}=load();
 const result=await tool.execute('c1',{task:'Look into it'},undefined,undefined,{cwd:dir});
 assert.equal(result.content[0].text,'the whole answer');
 assert.equal(ends[0].status,'done');
});
test('a subagent the person stops in the portal is said to be stopped, not finished',async()=>{
 process.env.FAKE='hang';
 const {tool,events,ends}=load();
 events.on('subagent:v1:event',d=>d.event.type==='message_end'&&events.emit('subagent:v1:stop',{id:d.id}));
 const result=await tool.execute('c2',{task:'Look into it'},undefined,undefined,{cwd:dir});
 assert.equal(ends[0].status,'stopped');
 assert.deepEqual(result.details,{phase:'stopped'});
});
test('a child that dies at once fails the subagent, and what is sent to it after cannot bring down the portal',async()=>{
 process.env.FAKE='die';
 const {tool,events,ends}=load();
 let id='';events.on('subagent:v1:start',d=>id=d.id);
 // It has gone when the call is over.
 await assert.rejects(tool.execute('c3',{task:'Look into it'},undefined,undefined,{cwd:dir}));
 // The person types to it, and stops it, after it has gone.
 events.emit('subagent:v1:input',{id,text:'and also this'});
 events.emit('subagent:v1:stop',{id});
 // What goes wrong with a write to a pipe nobody reads comes some turns of the loop later, and nothing is to come of it: only waiting shows that.
 await new Promise(r=>setTimeout(r,100));
 assert.equal(ends[0].status,'error');
});
test('a child that writes a great deal to stderr is not left blocked on it',{timeout:5000},async()=>{
 process.env.FAKE='noisy';
 const {tool}=load();
 const result=await tool.execute('c4',{task:'Look into it'},undefined,undefined,{cwd:dir});
 assert.equal(result.content[0].text,'done despite the noise');
});
test('a child that refuses the task fails the subagent with its reason, rather than waiting for good',{timeout:5000},async()=>{
 process.env.FAKE='refuse';
 const {tool,ends}=load();
 await assert.rejects(tool.execute('c5',{task:'Look into it'},undefined,undefined,{cwd:dir}),/No API key for the model/);
 assert.deepEqual(ends[0],{id:ends[0].id,status:'error',error:'No API key for the model'});
});
test('a message for a child that no longer reads cannot bring down the portal',{timeout:5000},async()=>{
 process.env.FAKE='deaf';
 rmSync(deafFlag,{force:true});
 const {tool,events,ends}=load();
 let id='';events.on('subagent:v1:start',d=>id=d.id);
 const done=tool.execute('c6',{task:'Look into it'},undefined,undefined,{cwd:dir}).catch(()=>undefined);
 await until(()=>existsSync(deafFlag));
 events.emit('subagent:v1:input',{id,text:'x'.repeat(200_000)});
 events.emit('subagent:v1:stop',{id});
 await done;
 assert.equal(ends[0].status,'stopped');
});
test('in interrupt mode two subagents asked for at once run one after the other',{timeout:5000},async()=>{
 delete process.env.FAKE;mode();
 const {tool,seen}=load();
 assert.match(tool.description,/get its final answer back/);
 const both=await Promise.all([tool.execute('a',{task:'one'},undefined,undefined,{cwd:dir}),tool.execute('b',{task:'two'},undefined,undefined,{cwd:dir})]);
 assert.equal(both[0].content[0].text,'the whole answer');
 // The second waited for the first, and says so.
 assert.match(both[1].content[0].text,/^the whole answer\n\n\(It waited/);
 assert.deepEqual(seen,['start a','end','start b','end']);
});
test('in background mode the call returns at once, and the answer arrives later as a message that starts a turn',{timeout:5000},async()=>{
 delete process.env.FAKE;mode('background');
 const {tool,ends,sent}=load();
 assert.match(tool.description,/runs in the background/);
 const result=await tool.execute('c7',{task:'Look into it',label:'Research'},undefined,undefined,{cwd:dir});
 assert.match(result.content[0].text,/in the background/);
 assert.equal(result.details.phase,'background');
 assert.equal(ends.length,0);
 await until(()=>sent.length===1);
 assert.equal(ends[0].status,'done');
 assert.match(sent[0].message.content,/Subagent "Research" finished:\n\nthe whole answer/);
 assert.equal(sent[0].message.display,true);
 assert.deepEqual(sent[0].options,{deliverAs:'followUp',triggerTurn:true});
 mode();
});
test('a background subagent says it is detached, and stopping it waits for the person rather than starting a turn',{timeout:5000},async()=>{
 process.env.FAKE='hang';mode('background');
 const {tool,events,sent}=load();
 let start:any;events.on('subagent:v1:start',d=>start=d);
 const said=spoken(events);
 await tool.execute('c8',{task:'Look into it'},undefined,undefined,{cwd:dir});
 assert.equal(start.detached,true);
 await until(()=>said.length===1);
 events.emit('subagent:v1:stop',{id:start.id});
 await until(()=>sent.length===1);
 assert.match(sent[0].message.content,/was stopped before it finished\. What it had so far:\n\nhalf of it/);
 assert.deepEqual(sent[0].options,{deliverAs:'nextTurn'});
 mode();
});
test('background subagents end with the session that started them',{timeout:5000},async()=>{
 process.env.FAKE='hang';mode('background');
 const {tool,events,ends,hooks}=load();
 const said=spoken(events);
 await tool.execute('c9',{task:'Look into it'},undefined,undefined,{cwd:dir});
 await until(()=>said.length===1);
 hooks.get('session_shutdown')!();
 await until(()=>ends.length===1);
 assert.equal(ends[0].status,'stopped');
 mode();
});
test('how many subagents may run at once: 1 unless the settings say more, and never past 16',()=>{
 assert.equal(settingsOf({}).maxParallel,1);
 assert.equal(settingsOf({maxParallel:3}).maxParallel,3);
 assert.equal(settingsOf({maxParallel:0}).maxParallel,1);
 assert.equal(settingsOf({maxParallel:'lots'}).maxParallel,1);
 assert.equal(settingsOf({maxParallel:99}).maxParallel,16);
});
test('with two allowed at once, two subagents asked for together run side by side',{timeout:5000},async()=>{
 delete process.env.FAKE;mode(undefined,{maxParallel:2});
 const {tool,seen}=load();
 await Promise.all([tool.execute('a',{task:'one'},undefined,undefined,{cwd:dir}),tool.execute('b',{task:'two'},undefined,undefined,{cwd:dir})]);
 assert.deepEqual(seen,['start a','start b','end','end']);
 mode();
});
test('in the background, one past the limit is queued and starts when the running one has finished',{timeout:5000},async()=>{
 delete process.env.FAKE;mode('background');
 const {tool,seen,sent}=load();
 const first=await tool.execute('a',{task:'one'},undefined,undefined,{cwd:dir});
 const second=await tool.execute('b',{task:'two',label:'Second'},undefined,undefined,{cwd:dir});
 assert.equal(first.details.phase,'background');
 assert.match(first.content[0].text,/Started subagent "Subagent" in the background \(1 of 1 running\)/);
 assert.equal(second.details.phase,'queued');
 assert.match(second.content[0].text,/Queued subagent "Second" in the background \(1 of 1 running, 1 waiting, this one included\)/);
 await until(()=>sent.length===2);
 // B is announced while it waits, and again when it starts: a slot is not taken before A's end.
 assert.deepEqual(seen,['start a','start b','end','start b','end']);
 mode();
});
test('a subagent still waiting for a slot does not start once its session has ended',{timeout:5000},async()=>{
 process.env.FAKE='hang';mode('background');
 const {tool,events,seen,hooks,ends}=load();
 const said=spoken(events);
 await tool.execute('a',{task:'one'},undefined,undefined,{cwd:dir});
 await tool.execute('b',{task:'two'},undefined,undefined,{cwd:dir});
 await until(()=>said.length===1);
 hooks.get('session_shutdown')!();
 await until(()=>ends.length===2);
 // The one that waited is not to start now that both are over, which only waiting shows.
 await new Promise(r=>setTimeout(r,200));
 assert.deepEqual(seen,['start a','start b','end','end'],'announced while waiting, ended without starting');
 assert.deepEqual(ends.map((e:any)=>e.status).sort(),['stopped','stopped']);
 mode();
});
test('a waiting subagent counts as running, and stopping it before it starts tells the parent without a turn',{timeout:5000},async()=>{
 process.env.FAKE='hang';mode('background');
 const {tool,events,sent,ends}=load();
 const running=new Set<string>();
 events.on('subagent:v1:start',(d:any)=>running.add(d.id));
 events.on('subagent:v1:end',(d:any)=>running.delete(d.id));
 let first='';events.on('subagent:v1:start',(d:any)=>first||=d.id);
 await tool.execute('a',{task:'one'},undefined,undefined,{cwd:dir});
 let waiting:any;events.on('subagent:v1:start',(d:any)=>{if(d.id!==first)waiting=d;});
 await tool.execute('b',{task:'two',label:'Later'},undefined,undefined,{cwd:dir});
 assert.equal(waiting.detail,'Waiting for a free slot');
 assert.equal(running.size,2,'both counted: the chat is not reloaded from under the one waiting');
 events.emit('subagent:v1:stop',{id:waiting.id});
 await until(()=>sent.length===1);
 assert.match(sent[0].message.content,/Subagent "Later" was stopped before it started\./);
 assert.deepEqual(sent[0].options,{deliverAs:'nextTurn'});
 events.emit('subagent:v1:stop',{id:first});
 await until(()=>ends.length===2);
 mode();
});
test('a background subagent that cannot start gives its slot back and says so',{timeout:5000},async()=>{
 delete process.env.FAKE;mode('background');
 const {tool,sent}=load();
 // A context that cannot be read: starting it throws.
 const broken={get cwd(){throw new Error('the session is gone');}};
 await tool.execute('a',{task:'one'},undefined,undefined,broken);
 await until(()=>sent.length===1);
 assert.match(sent[0].message.content,/failed: the session is gone/);
 // The slot is free again: the next one starts at once.
 const next=await tool.execute('b',{task:'two'},undefined,undefined,{cwd:dir});
 assert.equal(next.details.phase,'background');
 await until(()=>sent.length===2);
 mode();
});
test('an interrupt subagent waiting for a slot gives up when its parent is stopped',{timeout:5000},async()=>{
 process.env.FAKE='hang';mode();
 const {tool,events,seen}=load();
 let id='';events.on('subagent:v1:start',d=>id=d.id);
 const first=tool.execute('a',{task:'one'},undefined,undefined,{cwd:dir});
 const stop=new AbortController();
 const phases:string[]=[];
 const second=tool.execute('b',{task:'two'},stop.signal,(u:any)=>phases.push(u.details.phase),{cwd:dir});
 // It says it is waiting as it takes its place, with the listener on the signal.
 await until(()=>phases.length===1);
 stop.abort();
 assert.deepEqual((await second).details,{phase:'stopped'});
 assert.deepEqual(phases,['waiting for another subagent to finish']);
 events.emit('subagent:v1:stop',{id});
 await first;
 assert.deepEqual(seen,['start a','end']);
});
test('the limit holds across conversations: two chats share it',{timeout:5000},async()=>{
 delete process.env.FAKE;mode();
 const one=load(),two=load();
 const order:string[]=[];
 one.events.on('subagent:v1:start',()=>order.push('start one'));one.events.on('subagent:v1:end',()=>order.push('end one'));
 two.events.on('subagent:v1:start',()=>order.push('start two'));two.events.on('subagent:v1:end',()=>order.push('end two'));
 await Promise.all([one.tool.execute('a',{task:'x'},undefined,undefined,{cwd:dir}),two.tool.execute('b',{task:'y'},undefined,undefined,{cwd:dir})]);
 assert.deepEqual(order,['start one','end one','start two','end two']);
});
test('a child runs on the model its parent is on, unless the chat or the settings say another',{timeout:5000},async()=>{
 process.env.FAKE='argv';mode();
 const {tool,events}=load();
 const parent={cwd:dir,model:{provider:'llama-swap',id:'model-b'}};
 let started:any;events.on('subagent:v1:start',d=>started=d);
 assert.equal((await tool.execute('a',{task:'x'},undefined,undefined,parent)).content[0].text,'--mode rpc --no-session --provider llama-swap --model model-b');
 assert.equal(started.detail,'Starting on llama-swap/model-b');
 // The chat's own choice, answered on the bus.
 const off=events.on('subagent:v1:config',(d:any)=>d.reply({model:'vllm/model-c'}));
 assert.equal((await tool.execute('b',{task:'x'},undefined,undefined,parent)).content[0].text,'--mode rpc --no-session --provider vllm --model model-c');
 off();
 // The settings' choice, and auto there is the parent's again.
 mode(undefined,{model:'openrouter/deepseek/deepseek-chat'});
 assert.equal((await tool.execute('c',{task:'x'},undefined,undefined,parent)).content[0].text,'--mode rpc --no-session --provider openrouter --model deepseek/deepseek-chat');
 mode(undefined,{model:'auto'});
 assert.match((await tool.execute('d',{task:'x'},undefined,undefined,parent)).content[0].text,/--model model-b$/);
 // No model known at all: pi's own default.
 assert.equal((await tool.execute('e',{task:'x'},undefined,undefined,{cwd:dir})).content[0].text,'--mode rpc --no-session');
 mode();
});
test('what a chat says auto for is the parent\'s model, and a choice with no model in it is none',()=>{
 mode();
 assert.deepEqual(childModel('auto',{provider:'p',id:'m'}),{provider:'p',id:'m'});
 assert.equal(childModel('nonsense',{provider:'p',id:'m'}),undefined);
});
test('a subagent gets no subagent tool of its own: the limit could not reach its children',{timeout:5000},async()=>{
 process.env.FAKE='childenv';mode();
 const {tool}=load();
 assert.equal((await tool.execute('a',{task:'x'},undefined,undefined,{cwd:dir})).content[0].text,'child=1');
 process.env.PI_SUBAGENT_CHILD='1';
 try{
  let registered=false;
  subagent({registerTool:()=>registered=true,events:{on:()=>()=>{},emit:()=>{}},on:()=>{}});
  assert.equal(registered,false);
 }finally{delete process.env.PI_SUBAGENT_CHILD;}
});
test('a background subagent\'s answer names the id it was announced under',{timeout:5000},async()=>{
 delete process.env.FAKE;mode('background');
 const {tool,events,sent}=load();
 let started='';events.on('subagent:v1:start',(d:any)=>started=d.id);
 await tool.execute('a',{task:'x'},undefined,undefined,{cwd:dir});
 await until(()=>sent.length===1);
 assert.equal(sent[0].message.details.id,started);
 mode();
});
test('a background subagent that will not stop is killed when its session ends, and its slot freed',{timeout:10000},async()=>{
 process.env.FAKE='stubborn';process.env.PI_SUBAGENT_GRACE_MS='300';mode('background');
 try{
  const {tool,events,hooks,ends}=load();
  const said=spoken(events);
  await tool.execute('a',{task:'x'},undefined,undefined,{cwd:dir});
  await until(()=>said.length===1);
  hooks.get('session_shutdown')!();
  await until(()=>ends.length===1);
  assert.equal(ends[0].status,'stopped');
  // Its slot is every chat's: the next one starts at once.
  delete process.env.FAKE;
  const next=load();
  const r=await next.tool.execute('b',{task:'y'},undefined,undefined,{cwd:dir});
  assert.equal(r.details.phase,'background');
  // Its slot is held until it is done: the next test finds the slots free.
  await until(()=>next.sent.length===1);
 }finally{delete process.env.PI_SUBAGENT_GRACE_MS;mode();}
});
test('the mode a chat was loaded with is the one it runs in, as its tool says',{timeout:5000},async()=>{
 delete process.env.FAKE;mode();
 const {tool}=load();
 assert.match(tool.description,/get its final answer back/);
 mode('background');
 const r=await tool.execute('a',{task:'x'},undefined,undefined,{cwd:dir});
 assert.equal(r.content[0].text,'the whole answer','interrupt, as it was told: the change reaches it when it is reloaded');
 mode();
});
test('waiting for a slot leaves no listener behind on the parent\'s signal, nor itself in the shared list',{timeout:5000},async()=>{
 process.env.FAKE='hang';mode();
 const {tool,events}=load();
 let first='';events.on('subagent:v1:start',(d:any)=>first||=d.id);
 const said=spoken(events);
 const running=tool.execute('a',{task:'one'},undefined,undefined,{cwd:dir});
 await until(()=>said.length===1);
 const stop=new AbortController();
 let listeners=0;
 const phases:string[]=[];
 const add=stop.signal.addEventListener.bind(stop.signal),remove=stop.signal.removeEventListener.bind(stop.signal);
 (stop.signal as any).addEventListener=(t:string,f:any,o:any)=>{listeners++;add(t,f,o);};
 (stop.signal as any).removeEventListener=(t:string,f:any)=>{listeners--;remove(t,f);};
 const waiting=tool.execute('b',{task:'two'},stop.signal,(u:any)=>phases.push(u.details.phase),{cwd:dir});
 await until(()=>phases.length===1);
 stop.abort();
 await waiting;
 assert.equal(listeners,0);
 assert.equal((globalThis as any)[Symbol.for('pithagoras-subagent:slots')].waiting.length,0);
 events.emit('subagent:v1:stop',{id:first});
 await running;
});

test('the tool tells the model how many subagents run at once, in both modes',()=>{
 for(const m of ['interrupt','background'] as const){
  assert.match(describe(m,1),/One runs at a time: further calls wait for it to finish\./);
  assert.match(describe(m,3),/At most 3 run at once; further calls wait for a free one\./);
 }
 delete process.env.FAKE;
 mode(undefined,{maxParallel:3});
 assert.match(load().tool.description,/At most 3 run at once/);
 mode('background',{maxParallel:1});
 const background=load().tool.description;
 assert.match(background,/runs in the background/);
 assert.match(background,/One runs at a time/);
 // Over the cap it says what is enforced.
 mode(undefined,{maxParallel:99});
 assert.match(load().tool.description,/At most 16 run at once/);
 mode();
});
test('a background call says how many are running and waiting, and a queue says how many are ahead',{timeout:5000},async()=>{
 process.env.FAKE='hang';mode('background',{maxParallel:2});
 const {tool,events,ends}=load();
 const ids:string[]=[];events.on('subagent:v1:start',(d:any)=>ids.push(d.id));
 const results=[];
 for(const label of ['a','b','c','d'])results.push(await tool.execute(label,{task:'x',label},undefined,undefined,{cwd:dir}));
 assert.match(results[0].content[0].text,/Started subagent "a" in the background \(1 of 2 running\)/);
 assert.match(results[1].content[0].text,/Started subagent "b" in the background \(2 of 2 running\)/);
 assert.match(results[2].content[0].text,/Queued subagent "c" in the background \(2 of 2 running, 1 waiting, this one included\)/);
 assert.match(results[3].content[0].text,/Queued subagent "d" in the background \(2 of 2 running, 2 waiting, this one included\)/);
 for(const id of ids)events.emit('subagent:v1:stop',{id});
 await until(()=>ends.length>=4);
 mode();
});
test('an interrupt call that had to wait says how long, and one that did not says nothing',{timeout:8000},async()=>{
 delete process.env.FAKE;mode();
 const {tool,seen}=load();
 const alone=await tool.execute('a',{task:'one'},undefined,undefined,{cwd:dir});
 assert.equal(alone.content[0].text,'the whole answer');
 // The first run takes over a second and the second is quick, so the note has to tell the wait from the second's own run.
 process.env.FAKE='slow';
 const first=tool.execute('b',{task:'one'},undefined,undefined,{cwd:dir});
 await until(()=>seen.includes('start b'));
 delete process.env.FAKE;
 const second=tool.execute('c',{task:'two'},undefined,undefined,{cwd:dir});
 const both=await Promise.all([first,second]);
 assert.equal(both[0].content[0].text,'the whole answer');
 assert.match(both[1].content[0].text,/^the whole answer\n\n\(It waited [12] s for a free subagent slot before it started\.\)$/);
});
test('after the limit is lowered, a background call reports how many really run',{timeout:5000},async()=>{
 process.env.FAKE='hang';mode('background',{maxParallel:3});
 const {tool,events,ends}=load();
 const ids:string[]=[];events.on('subagent:v1:start',(d:any)=>ids.push(d.id));
 for(const label of ['a','b','c'])await tool.execute(label,{task:'x',label},undefined,undefined,{cwd:dir});
 mode('background',{maxParallel:1});
 const d=await tool.execute('d',{task:'x',label:'d'},undefined,undefined,{cwd:dir});
 assert.match(d.content[0].text,/Queued subagent "d" in the background \(3 of 1 running, 1 waiting, this one included\); it starts when a slot is free/);
 for(const id of ids)events.emit('subagent:v1:stop',{id});
 await until(()=>ends.length>=3);
 // The queued one starts once the others are gone; stop it too.
 await until(()=>ids.length>=4);
 events.emit('subagent:v1:stop',{id:ids[3]});
 await until(()=>ends.length>=4);
 mode();
});
test('a wait is said in the units a person uses',()=>{
 assert.equal(waited(400),'under a second');
 assert.equal(waited(12_000),'12 s');
 assert.equal(waited(180_000),'3 min');
 assert.equal(waited(185_000),'3 min 5 s');
});
