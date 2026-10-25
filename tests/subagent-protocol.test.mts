import {test} from 'node:test';
import assert from 'node:assert/strict';
import {bridgeSubagents} from '../core/server/src/subagent-protocol.ts';
const bus=()=>{const h=new Map<string,((d:unknown)=>void)[]>();return{emit:(c:string,d:unknown)=>h.get(c)?.forEach(f=>f(d)),on:(c:string,f:(d:unknown)=>void)=>{h.set(c,[...(h.get(c)??[]),f]);return()=>h.set(c,(h.get(c)??[]).filter(x=>x!==f));}};};
test('a subagent an extension announces reaches the portal as session events',()=>{
 const b=bus();const out:any[]=[];const off=bridgeSubagents(b,e=>out.push(e));
 b.emit('subagent:v1:event',{id:'x',event:{type:'agent_start'}});
 assert.equal(out.length,0,'nothing about a subagent that was never started');
 b.emit('subagent:v1:start',{id:'r1',label:'Research',input:true});
 b.emit('subagent:v1:event',{id:'r1',event:{type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'Hi',partial:{huge:true}}}});
 b.emit('subagent:v1:event',{id:'r1',event:{type:'tool_execution_end',toolCallId:'t',toolName:'web_search',result:{content:[{type:'text',text:'found'},{type:'image',data:'…'}]}}});
 b.emit('subagent:v1:event',{id:'r1',event:{type:'something_else'}});
 b.emit('subagent:v1:end',{id:'r1',status:'bogus'});
 assert.deepEqual(out.map(e=>[e.type,e.op]),[['portal_subagent','start'],['portal_subagent_live','event'],['portal_subagent','event'],['portal_subagent','end']]);
 assert.deepEqual(out[0],{type:'portal_subagent',op:'start',id:'r1',label:'Research',input:true,stop:false});
 assert.deepEqual(out[1].event,{type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'Hi'}});
 assert.deepEqual(out[2].event.result,{content:[{type:'text',text:'found'}]});
 assert.equal(out[3].status,'done');
 off();b.emit('subagent:v1:start',{id:'r2'});assert.equal(out.length,4);
});
test('a subagent that works in a child chat names that chat on its start, and the portal keeps it',()=>{
 const b=bus();const out:any[]=[];const bridge=bridgeSubagents(b,e=>out.push(e));
 b.emit('subagent:v1:start',{id:'c1',label:'Research',toolCallId:'t1',input:true,stop:true,chat:'c1'});
 b.emit('subagent:v1:start',{id:'c2',label:'Other',chat:''});
 assert.equal(out[0].chat,'c1');
 assert.equal('chat' in out[1],false,'an empty one is none');
 assert.equal(bridge.takes('c1','stop'),true);
 b.emit('subagent:v1:end',{id:'c1',status:'done'});
 assert.deepEqual(out[2],{type:'portal_subagent',op:'end',id:'c1',toolCallId:'t1',status:'done'});
});
test('a subagent\'s finished message says how long it thought',()=>{
 const b=bus();const out:any[]=[];bridgeSubagents(b,e=>out.push(e));
 b.emit('subagent:v1:start',{id:'r',label:'R'});
 b.emit('subagent:v1:event',{id:'r',event:{type:'message_update',assistantMessageEvent:{type:'thinking_delta',delta:'Hm'}}});
 b.emit('subagent:v1:event',{id:'r',event:{type:'message_end',message:{role:'assistant',content:[{type:'thinking',thinking:'Hm'}]}}});
 const end=out.find(e=>e.event?.type==='message_end').event;
 assert.equal(typeof end.thinkingSince,'number');
 assert.ok(end.thinkingUntil>=end.thinkingSince);
});
test('only what is drawn is stored: a tool result again as a message is left out, what says what the child is doing now is live',()=>{
 const b=bus();const out:any[]=[];const bridge=bridgeSubagents(b,e=>out.push(e));
 b.emit('subagent:v1:start',{id:'r',label:'R',input:true});
 for(const type of ['turn_start','message_start','turn_end'])b.emit('subagent:v1:event',{id:'r',event:{type,message:{role:'assistant',content:[]}}});
 b.emit('subagent:v1:event',{id:'r',event:{type:'message_end',message:{role:'toolResult',toolCallId:'t',content:[{type:'text',text:'x'.repeat(60_000)},{type:'image',data:'A'}]}}});
 b.emit('subagent:v1:event',{id:'r',event:{type:'tool_execution_end',toolCallId:'t',toolName:'read',result:{content:[{type:'text',text:'x'.repeat(60_000)}]}}});
 assert.deepEqual(out.slice(1).map(e=>[e.type,e.event.type]),[['portal_subagent_live','turn_start'],['portal_subagent_live','message_start'],['portal_subagent_live','turn_end'],['portal_subagent','tool_execution_end']]);
 // Messages and stops go only to one running here that takes them.
 assert.equal(bridge.takes('r','input'),true);
 assert.equal(bridge.takes('r','stop'),false,'it did not say it could be stopped');
 assert.equal(bridge.takes('gone','input'),false);
 b.emit('subagent:v1:end',{id:'r',status:'done'});
 assert.equal(bridge.takes('r','input'),false,'not once it has ended');
});
test('every event of a subagent says which tool call runs it',()=>{
 const b=bus();const out:any[]=[];bridgeSubagents(b,e=>out.push(e));
 b.emit('subagent:v1:start',{id:'r',label:'R',toolCallId:'call-7'});
 b.emit('subagent:v1:event',{id:'r',event:{type:'message_end',message:{role:'assistant',content:[]}}});
 b.emit('subagent:v1:event',{id:'r',event:{type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'x'}}});
 b.emit('subagent:v1:end',{id:'r',status:'done'});
 assert.deepEqual(out.map(e=>e.toolCallId),['call-7','call-7','call-7','call-7']);
});
test('a subagent in the background says so on every event, and is counted as running until it ends',()=>{
 const b=bus();const out:any[]=[];const bridge=bridgeSubagents(b,e=>out.push(e));
 b.emit('subagent:v1:start',{id:'r',label:'R',toolCallId:'call-7',detached:true});
 b.emit('subagent:v1:start',{id:'q',label:'Q'});
 assert.equal(bridge.running(),2);
 b.emit('subagent:v1:event',{id:'r',event:{type:'message_end',message:{role:'assistant',content:[]}}});
 b.emit('subagent:v1:end',{id:'r',status:'done'});
 assert.deepEqual(out.filter(e=>e.id==='r').map(e=>e.detached),[true,true,true]);
 assert.equal(out.find(e=>e.id==='q').detached,undefined);
 assert.equal(bridge.running(),1);
});
test('a process going ends every subagent it still ran, each once',()=>{
 const b=bus();const out:any[]=[];const bridge=bridgeSubagents(b,e=>out.push(e));
 b.emit('subagent:v1:start',{id:'r',label:'R',toolCallId:'c',detached:true});
 b.emit('subagent:v1:start',{id:'q',label:'Q'});
 bridge.endAll("Its chat's pi was stopped");
 const ends=out.filter(e=>e.op==='end');
 assert.deepEqual(ends.map(e=>[e.id,e.status,e.error,e.detached]),[['r','stopped',"Its chat's pi was stopped",true],['q','stopped',"Its chat's pi was stopped",undefined]]);
 assert.equal(bridge.running(),0);
 // What the extension says after is of subagents already ended: nothing more.
 b.emit('subagent:v1:end',{id:'r',status:'stopped'});
 assert.equal(out.filter(e=>e.op==='end').length,2);
});

test('the protocol is the same in the portal, in the typed API and in the subagent extension: each channel, and what is sent on it',async()=>{
 const fs=await import('node:fs');
 const ts=(await import('typescript')).default;
 const core=await import('../core/server/src/subagent-protocol.ts');
 // The typed API: each channel of SubagentProtocol, with the fields of the interface it names, `?` on those it may leave out.
 const file='packages/extension-api/server.d.ts';
 const api=ts.createSourceFile(file,fs.readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true);
 const interfaces=new Map<string,ts.InterfaceDeclaration>();
 api.forEachChild(n=>{if(ts.isInterfaceDeclaration(n))interfaces.set(n.name.text,n);});
 const fields=(name:string)=>interfaces.get(name)!.members.map(m=>`${(m.name as ts.Identifier).text}${m.questionToken?'?':''}`);
 const typed=Object.fromEntries(interfaces.get('SubagentProtocol')!.members.map(m=>[(m.name as ts.StringLiteral).text,fields(((m as ts.PropertySignature).type as ts.TypeReferenceNode).typeName.getText(api))]));
 // The portal's: its constants, and the payloads its header says, as `{ id, label, toolCallId?, … }`.
 const constants=Object.entries(core).filter(([k])=>k.startsWith('SUBAGENT_')).map(([,v])=>v as string).sort();
 assert.deepEqual(constants,Object.keys(typed).sort(),'the portal\'s channels');
 const header=fs.readFileSync('core/server/src/subagent-protocol.ts','utf8');
 for(const [channel,want] of Object.entries(typed)){
  const said=new RegExp(`\\* +${channel} +\\{ ([^}]*) \\}`).exec(header);
  assert.ok(said,`${channel} is in the portal's header`);
  assert.deepEqual(said![1].split(',').map(f=>f.trim().replace(/:.*$/,'').replace(/\(.*$/,'')),want,channel);
 }
 // The extension's: the channels it speaks on, by their names. All but the config, which it does not ask: it keeps
 // each chat's model itself, and the portal answers nothing there; and but the events, which its subagents' chats
 // have in their own transcripts.
 const ext=fs.readFileSync('extensions/subagent/src/pi.ts','utf8');
 assert.deepEqual([...ext.matchAll(/"(subagent:v1:\w+)" satisfies keyof SubagentProtocol/g)].map(m=>m[1]).sort(),Object.keys(typed).filter(c=>c!=='subagent:v1:config'&&c!=='subagent:v1:event').sort(),'the extension\'s channels');
});
