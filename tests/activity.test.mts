import {test} from 'node:test';
import assert from 'node:assert/strict';
import {activity,shownFrom} from '../core/web/src/transcript.ts';
const event=(type:string,at:number,payload:any={})=>({type,at,payload,seq:at});
test('empty assistant events retain prefill percentage and stable elapsed start',()=>{
 const events=[event('portal_prompt',100),event('message_start',110,{message:{role:'assistant'}}),event('portal_prefill',120,{total:10000,processed:3000,cache:1000}),event('message_update',130,{assistantMessageEvent:{type:'start'}})];
 assert.deepEqual(activity(events),{label:'processing the prompt',since:110,prefill:{total:10000,processed:3000,cache:1000}});
 events.push(event('message_update',140,{assistantMessageEvent:{type:'thinking_delta',delta:'Considering'}}));
 assert.equal(activity(events).label,'thinking');
});
test('compaction stays identified through model events and ends cleanly',()=>{
 const events=[event('compaction_start',100),event('message_start',110,{message:{role:'assistant'}}),event('portal_prefill',120,{total:1000,processed:500}),event('message_update',130,{assistantMessageEvent:{type:'text_delta',delta:'Summary'}})];
 assert.deepEqual(activity(events),{label:'compacting the conversation',since:100});
 events.push(event('compaction_end',140));assert.equal(activity(events).label,'thinking');
 events.push(event('portal_prompt',150));assert.deepEqual(activity(events),{label:'processing the prompt',since:150,prefill:undefined});
});
test('a model being loaded is said before the prompt is read, and gives way to prefill',()=>{
 const events:any[]=[event('portal_prompt',100),event('agent_start',105),event('portal_model',110,{model:'qwen',state:'loading'})];
 assert.deepEqual(activity(events),{label:'loading the model',since:110,model:'qwen'});
 events.push(event('portal_model',150,{model:'qwen',state:'ready'}));
 assert.equal(activity(events).label,'processing the prompt');
 events.push(event('portal_prefill',160,{total:100,processed:50}));
 assert.equal(activity(events).prefill?.processed,50);
});
test('a provider that reports no progress and no loading still shows the prompt being read, without a measure',()=>{
 // A cloud model, or a llama-server that does not send prompt_progress: none of the portal_* events.
 const events:any[]=[event('portal_prompt',100),event('agent_start',101),event('turn_start',102)];
 assert.deepEqual(activity(events),{label:'processing the prompt',since:102,prefill:undefined});
 events.push(event('message_start',110,{message:{role:'assistant'}}));
 assert.deepEqual(activity(events),{label:'processing the prompt',since:110,prefill:undefined});
 events.push(event('message_update',120,{assistantMessageEvent:{type:'text_delta',delta:'Hi'}}));
 assert.equal(activity(events).label,'writing the reply');
});
test('the last turn\'s progress is not carried into the next one',()=>{
 const events:any[]=[event('portal_prompt',100),event('message_start',110,{message:{role:'assistant'}}),event('portal_prefill',120,{total:100,processed:100}),
  event('message_update',130,{assistantMessageEvent:{type:'text_delta',delta:'Hi'}}),event('message_end',140),event('agent_end',150),
  event('portal_prompt',200),event('agent_start',201),event('message_start',210,{message:{role:'assistant'}})];
 assert.equal(activity(events).prefill,undefined);
});
test('the end of the reasoning shown starts where it did while the text is short, and moves only to a line break',()=>{
 const line='a line of reasoning that goes on a while. ';
 const text=(n:number)=>Array.from({length:n},()=>line.repeat(5)).join('\n');
 // Growing a token at a time, the start stays until the text from it passes 6000 characters.
 let from=0;
 for(let n=1;n<40;n++){const next=shownFrom(text(n),from);if(text(n).length<=6000)assert.equal(next,0);from=next}
 // Then it moves on to just after a line break, leaving far more than a window shows.
 assert.ok(from>0&&text(39)[from-1]==='\n'&&text(39).length-from>=600);
 // Not a letter at a time after that: it holds until the text from it is long again.
 const held=shownFrom(text(39)+'more',from);
 assert.equal(held,from);
 // A text with no line break holds its start far longer, and is then cut at a word, once, leaving little.
 const flat=(n:number)=>line.repeat(n);
 assert.equal(shownFrom(flat(700),0),0);
 const cut=shownFrom(flat(800),0);
 assert.ok(cut>0&&flat(800)[cut-1]===' '&&flat(800).length-cut>=500&&flat(800).length-cut<=700);
 // A shorter text than the start (a new reasoning) starts over.
 assert.equal(shownFrom('short',cut),0);
});
