import {test} from 'node:test';
import assert from 'node:assert/strict';
import {LiveEvents} from '../core/server/src/live-events.ts';
import {buildTranscript} from '../core/web/src/transcript.ts';
import {stableSubagents, subagents} from '../core/web/src/subagents.ts';
import {markOf, withLiveUi} from '../core/web/src/use-background.ts';
function stream(){let seq=0;const stored:any[]=[];const live=new LiveEvents((session:string,type:string,payload:any)=>{const row={seq:++seq,session_id:session,type,payload:JSON.stringify(payload),created_at:''};stored.push(row);return row;});return {live,stored};}
const delta=(id:string,type:string,text:string)=>({type:'portal_subagent_live',op:'event',id,event:{type:'message_update',assistantMessageEvent:{type,delta:text}}});
test('a page that opens while a subagent is mid-message gets what it has said so far',()=>{
 const {live}=stream();
 live.record('s','portal_subagent',{type:'portal_subagent',op:'start',id:'r',label:'R'});
 live.subagentLive('s',delta('r','thinking_delta','Hm, '));
 live.subagentLive('s',delta('r','text_delta','The answer '));
 live.subagentLive('s',delta('r','text_delta','is 42'));
 live.subagentLive('s',{type:'portal_subagent_live',op:'event',id:'r',event:{type:'tool_execution_update',toolCallId:'t1',partialResult:{content:[{type:'text',text:'searching'}]}}});
 const snap=live.snapshot('s').map(r=>JSON.parse(r.payload));
 assert.deepEqual(snap.map(p=>[p.id,p.event.type,p.event.assistantMessageEvent?.delta??p.event.toolCallId]),[['r','message_update','Hm, '],['r','message_update','The answer is 42'],['r','tool_execution_update','t1']]);
 assert.ok(live.snapshot('s').every(r=>r.seq<0),'live, never stored');
 // Its message and its tool ended: nothing of them is left to catch up on.
 live.record('s','portal_subagent',{type:'portal_subagent',op:'event',id:'r',event:{type:'message_end',message:{role:'assistant',content:[]}}});
 live.record('s','portal_subagent',{type:'portal_subagent',op:'event',id:'r',event:{type:'tool_execution_end',toolCallId:'t1'}});
 assert.deepEqual(live.snapshot('s'),[]);
});
test('a tool that reported as it ran is not a subagent, whether the page is live or loaded again',()=>{
 const {live,stored}=stream();
 live.record('s','tool_execution_start',{toolCallId:'d',toolName:'deep_research',args:{}});
 live.record('s','tool_execution_update',{toolCallId:'d',toolName:'deep_research',partialResult:{details:{phase:'searching'}}});
 live.record('s','tool_execution_update',{toolCallId:'d',toolName:'deep_research',partialResult:{details:{phase:'reading'}}});
 live.record('s','tool_execution_end',{toolCallId:'d',toolName:'deep_research',result:{content:[{type:'text',text:'Found it'}],details:{phase:'done'}}});
 // Loaded again: only what was stored.
 const events=stored.map(r=>({seq:r.seq,type:r.type,at:0,payload:JSON.parse(r.payload)}));
 const items=buildTranscript(events);
 assert.deepEqual(subagents(events,items),[]);
});
test('a subagent whose start is further up than the page has loaded is still shown',()=>{
 const events:any[]=[
  {seq:900,type:'portal_subagent',at:0,payload:{op:'event',id:'long',event:{type:'message_end',message:{role:'assistant',content:[{type:'text',text:'Step 150 done'}]}}}},
  {seq:901,type:'portal_subagent',at:0,payload:{op:'end',id:'long',status:'done'}},
 ];
 const [sub]=subagents(events,buildTranscript(events));
 assert.deepEqual([sub?.id,sub?.status,sub?.events.length],['long','done',1]);
});
test('a subagent whose start is not loaded is listed once, by its tool call, and is over when that call is',()=>{
 const events:any[]=[
  {seq:10,type:'tool_execution_start',at:0,payload:{toolCallId:'call-7',toolName:'subagent',args:{task:'x'}}},
  {seq:11,type:'portal_subagent',at:0,payload:{op:'event',id:'s',toolCallId:'call-7',event:{type:'message_end',message:{role:'assistant',content:[{type:'text',text:'Step'}]}}}},
  {seq:12,type:'tool_execution_end',at:0,payload:{toolCallId:'call-7',toolName:'subagent',updates:4,result:{content:[{type:'text',text:'done'}]}}},
 ];
 const found=subagents(events,buildTranscript(events));
 assert.deepEqual(found.map(s=>[s.id,s.status]),[['s','stopped']]);
});
test('a subagent that has not changed is the same entry, so its panel is not drawn again',()=>{
 const ev=(seq:number,text:string)=>({seq,type:'portal_subagent',at:0,payload:{op:'event',id:'s',event:{type:'message_end',message:{role:'assistant',content:[{type:'text',text}]}}}});
 const start={seq:1,type:'portal_subagent',at:0,payload:{op:'start',id:'s',label:'S'}};
 const first=subagents([start,ev(2,'a')] as any,[]);
 // A word of the main chat: nothing of the subagent's changed.
 const again=stableSubagents(first,subagents([start,ev(2,'a'),{seq:-5,type:'message_update',at:0,payload:{}}] as any,[]));
 assert.equal(again[0],first[0]);
 const more=stableSubagents(again,subagents([start,ev(2,'a'),ev(3,'b')] as any,[]));
 assert.notEqual(more[0],first[0]);
});
test('what extensions say after the portal answered is taken from their events',()=>{
 const state={supported:true,jobs:[],statuses:[{key:'bg',text:'bg 1 running'}],widgets:[]};
 const before=[{seq:4,type:'portal_prompt',at:0,payload:{}},{seq:-100,type:'extension_ui_request',at:0,payload:{method:'setStatus',statusKey:'bg',statusText:'bg 0 running'}}];
 const since=markOf(before as any);
 const events=[...before,
  {seq:-101,type:'extension_ui_request',at:0,payload:{method:'setStatus',statusKey:'bg',statusText:'\x1b[32mbg 2 running\x1b[0m'}},
  {seq:-102,type:'extension_ui_request',at:0,payload:{method:'setWidget',widgetKey:'jobs',widgetContent:['npm run dev']}},
  {seq:5,type:'message_end',at:0,payload:{}},
  {seq:-103,type:'extension_ui_request',at:0,payload:{method:'setStatus',statusKey:'lsp',statusText:'LSP ready'}},
 ];
 const shown=withLiveUi(state as any,events as any,since);
 assert.deepEqual(shown.statuses,[{key:'bg',text:'bg 2 running'},{key:'lsp',text:'LSP ready'}],'the one from before it asked is in its answer already');
 assert.deepEqual(shown.widgets,[{key:'jobs',lines:['npm run dev']}]);
 assert.equal(withLiveUi(state as any,before as any,since),state,'nothing since: its answer as it was');
});
test('a subagent in the background goes on after the tool call that started it has returned',()=>{
 const events:any[]=[
  {seq:10,type:'tool_execution_start',at:0,payload:{toolCallId:'call-8',toolName:'subagent',args:{task:'x'}}},
  {seq:11,type:'portal_subagent',at:0,payload:{op:'start',id:'bg',label:'BG',toolCallId:'call-8',detached:true}},
  {seq:12,type:'tool_execution_end',at:0,payload:{toolCallId:'call-8',toolName:'subagent',result:{content:[{type:'text',text:'started'}]}}},
  // Loaded without its start: its events still say so.
  {seq:13,type:'portal_subagent',at:0,payload:{op:'event',id:'far',toolCallId:'call-8',detached:true,event:{type:'message_end',message:{role:'assistant',content:[]}}}},
 ];
 const found=subagents(events,buildTranscript(events));
 assert.deepEqual(found.map(s=>[s.id,s.status]),[['bg','running'],['far','running']]);
 // A turn of the chat failing is not its pi gone: the portal writes the end of one when that pi goes.
 assert.deepEqual(subagents(events,buildTranscript(events),true).map(s=>s.status),['running','running']);
});
test('a subagent announced while it waited, and again as it starts, is one subagent with its new line',()=>{
 const events:any[]=[
  {seq:1,type:'portal_subagent',at:10,payload:{op:'start',id:'q',label:'Later',detail:'Waiting for a free slot',detached:true,input:true,stop:true}},
  {seq:2,type:'portal_subagent',at:20,payload:{op:'start',id:'q',label:'Later',detail:'Starting on llama-swap/qwen',detached:true,input:true,stop:true}},
  {seq:3,type:'portal_subagent',at:21,payload:{op:'event',id:'q',detached:true,event:{type:'message_end',message:{role:'assistant',content:[{type:'text',text:'hi'}]}}}},
 ];
 const found=subagents(events,[]);
 assert.deepEqual(found.map(s=>[s.id,s.detail,s.since,s.events.length,s.status]),[['q','Starting on llama-swap/qwen',10,1,'running']]);
});
