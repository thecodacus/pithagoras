import test from 'node:test';
import assert from 'node:assert/strict';
import { activity, buildTranscript } from '../core/web/src/transcript.ts';
import { appendLiveEvent, resetLiveEvents } from '../core/web/src/live-events.ts';
const done = { seq: 12, type: 'message_end', payload: { streamId: 'reply', message: { role: 'assistant', content: [{type: 'thinking', thinking: 'Plan'}, {type: 'text', text: 'Hello world'}] } } };
const update = {seq: -1, type: 'message_update', payload: {streamId: 'reply', assistantMessageEvent: {type: 'text_delta', delta: 'Hello'}}};
test('completed messages replay without saved deltas', () => {
 assert.deepEqual(buildTranscript([done]), [{kind:'assistant', id:'areply', text:'Hello world', thinking:'Plan', done:true, audio:false, final:true}]);
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

// What Chat offers Copy on: the stretch that ends each answer.
const copyable = (events: any[]) => buildTranscript(events).filter((i) => i.kind === 'assistant' && i.final).map((i) => (i as any).text);
const said = (seq: number, text: string, extra = {}) => ({ seq, type: 'message_end', payload: { streamId: `r${seq}`, message: { role: 'assistant', content: [{ type: 'text', text }], ...extra } } });
const tool = (seq: number, id: string) => [
  { seq, type: 'tool_execution_start', payload: { toolCallId: id, toolName: 'read' } },
  { seq: seq + 1, type: 'tool_execution_end', payload: { toolCallId: id, toolName: 'read' } },
];
// A message going in, as pi says it: `role` user for the person's words and a command's, custom for an extension's.
const taken = (seq: number, text: string, role = 'user') => ({ seq, type: 'message_start', payload: { message: { role, content: [{ type: 'text', text }] } } });
// A question asked while nothing runs: the portal's record of it, then pi starting a run with it.
const ask = (seq: number, message: string) => [
  { seq, type: 'portal_prompt', payload: { message } },
  { seq: seq + 1, type: 'agent_start', payload: {} },
  taken(seq + 2, message),
];
const ended = (seq: number) => ({ seq, type: 'agent_end', payload: {} });

test('Copy belongs only on the last stretch of an answer split by a tool call', () => {
  assert.deepEqual(copyable([said(1, 'Checking the file first.'), ...tool(2, 't'), said(4, 'It looks fine.')]), ['It looks fine.']);
});

test('a reply still streaming after the last tool call is not offered yet', () => {
  assert.deepEqual(copyable([
    said(1, 'One.'),
    ...tool(2, 't'),
    { seq: 4, type: 'message_update', payload: { streamId: 'b', assistantMessageEvent: { type: 'text_delta', delta: 'Still going' } } },
  ]), []);
});

test('a paragraph followed by a tool call is not offered Copy', () => {
  assert.deepEqual(copyable([said(1, 'Running the tests now.'), { seq: 2, type: 'tool_execution_start', payload: { toolCallId: 't', toolName: 'bash' } }]), []);
});

test('nor is one that calls a tool, before the call starts or when it never does', () => {
  const calling = said(4, 'Running rm on the build dir now.', { stopReason: 'toolUse' });
  calling.payload.message.content.push({ type: 'toolCall', id: 't', name: 'bash', arguments: {} } as any);
  assert.deepEqual(copyable([...ask(1, 'One?'), calling]), []);
  assert.deepEqual(copyable([
    ...ask(1, 'One?'),
    calling,
    { seq: 5, type: 'portal_status', payload: { status: 'idle', aborted: true } },
    ...ask(6, 'Two?'),
    said(9, 'Second answer.'),
  ]), ['Second answer.']);
});

test('the answer to an earlier question keeps Copy once another is asked', () => {
  assert.deepEqual(copyable([...ask(1, 'One?'), said(4, 'First answer.'), ended(5), ...ask(6, 'Two?'), said(9, 'Second answer.')]), ['First answer.', 'Second answer.']);
});

test('each answer offers Copy on its last stretch only, and none that ended in a tool call', () => {
  assert.deepEqual(copyable([
    ...ask(1, 'One?'),
    said(4, 'Checking the file first.'),
    ...tool(5, 't'),
    said(7, 'It looks fine.'),
    ended(8),
    ...ask(9, 'Two?'),
    said(12, 'Running the tests now.'),
    ...tool(13, 'u'),
    taken(15, 'Stop, three instead?'),
    said(16, 'Third answer.'),
  ]), ['It looks fine.', 'Third answer.']);
});

test('a command queued into a run ends the answer before it where pi takes it in', () => {
  assert.deepEqual(copyable([
    ...ask(1, 'One?'),
    { seq: 4, type: 'portal_command', payload: { text: '/review' } },
    { seq: 5, type: 'portal_command_end', payload: { of: 4, outcome: 'queued' } },
    said(6, 'First answer.'),
    taken(7, 'Review the changes on this branch.'),
    said(8, 'Review answer.'),
  ]), ['First answer.', 'Review answer.']);
});

test('a command that starts a run of its own ends the answer before it', () => {
  assert.deepEqual(copyable([
    ...ask(1, 'One?'),
    said(4, 'First answer.'),
    ended(5),
    { seq: 6, type: 'portal_command', payload: { text: '/review' } },
    { seq: 7, type: 'portal_command_end', payload: { of: 6, outcome: 'started' } },
    { seq: 8, type: 'agent_start', payload: {} },
    taken(9, 'Review the changes on this branch.'),
    said(10, 'Review answer.'),
  ]), ['First answer.', 'Review answer.']);
});

test("an extension's message ends the answer before it, in the same run or a new one", () => {
  const news = (seq: number) => [
    taken(seq, 'Subagent done: X', 'custom'),
    { seq: seq + 1, type: 'message_end', payload: { message: { role: 'custom', display: true, content: 'Subagent done: X' } } },
  ];
  const expected = ['Started it, will report back.', 'The subagent found X.'];
  assert.deepEqual(copyable([...ask(1, 'One?'), said(4, 'Started it, will report back.'), ...news(5), said(7, 'The subagent found X.')]), expected);
  assert.deepEqual(copyable([...ask(1, 'One?'), said(4, 'Started it, will report back.'), ended(5), { seq: 6, type: 'agent_start', payload: {} }, ...news(7), said(9, 'The subagent found X.')]), expected);
});

test('a stretch an error cut off gets no Copy: not while the retry waits, not after it, not once asked again', () => {
  const failed = [...ask(1, 'One?'), said(4, 'The answer is', { stopReason: 'error' }), ended(5), { seq: 6, type: 'auto_retry_start', payload: { attempt: 1 } }];
  assert.deepEqual(copyable(failed), []);
  assert.deepEqual(copyable([...failed, { seq: 7, type: 'agent_start', payload: {} }, said(8, 'The answer is 42.')]), ['The answer is 42.']);
  assert.deepEqual(copyable([...failed, { seq: 7, type: 'auto_retry_end', payload: { success: false } }, ...ask(8, 'Two?'), said(11, 'Second answer.')]), ['Second answer.']);
});

test('one the person stopped keeps its Copy, as what they chose to keep', () => {
  assert.deepEqual(copyable([
    ...ask(1, 'One?'),
    said(4, 'The first half', { stopReason: 'aborted' }),
    { seq: 5, type: 'portal_status', payload: { status: 'idle', aborted: true } },
    ...ask(6, 'Two?'),
  ]), ['The first half']);
});

test('a run that died mid-reply does not have the next one written into its bubble, nor a Copy of its own', () => {
  // The stream's id is the same when pi kept going and the portal's buffer of it was never ended.
  for (const [dead, next, custom] of [['r4', 'r7', true], ['r4', 'r4', true], ['r4', 'r4', false]] as const) {
    const items = buildTranscript([
      ...ask(1, 'One?'),
      { seq: 4, type: 'message_update', payload: { streamId: dead, assistantMessageEvent: { type: 'text_delta', delta: 'Half an answer.' } } },
      { seq: 5, type: 'agent_start', payload: {} },
      ...(custom ? [taken(6, 'Subagent done: X', 'custom')] : []),
      { seq: 7, type: 'message_update', payload: { streamId: next, assistantMessageEvent: { type: 'text_delta', delta: 'The subagent found X.' } } },
      { seq: 8, type: 'message_end', payload: { streamId: next, message: { role: 'assistant', content: [{ type: 'text', text: 'The subagent found X.' }] } } },
    ]);
    assert.deepEqual(items.filter((i) => i.kind === 'assistant').map((i: any) => [i.text, i.done, i.final === true]), [
      ['Half an answer.', true, false],
      ['The subagent found X.', true, true],
    ]);
  }
});

test('a reply that goes on after it was marked keeps writing in its bubble without a Copy under it', () => {
  const items = buildTranscript([
    ...ask(1, 'One?'),
    { seq: 4, type: 'message_update', payload: { streamId: 'r', assistantMessageEvent: { type: 'text_delta', delta: 'Part one' } } },
    { seq: 5, type: 'message_end', payload: { streamId: 'r', message: { role: 'assistant', content: [{ type: 'text', text: 'Part one' }] } } },
    taken(6, 'Subagent done: X', 'custom'),
    { seq: 7, type: 'message_update', payload: { streamId: 'r', assistantMessageEvent: { type: 'text_delta', delta: ' and more' } } },
  ]);
  assert.deepEqual(items.filter((i) => i.kind === 'assistant').map((i: any) => [i.text, i.done, i.final === true]), [['Part one and more', false, false]]);
});

test('what only prints something, and a message that has not gone in or never did, leave the answer the last thing said', () => {
  const answered = [...ask(1, 'One?'), said(4, 'First answer.')];
  for (const after of [
    [{ seq: 5, type: 'portal_notice', payload: { text: 'Session: x' } }],
    [{ seq: 5, type: 'portal_prompt', payload: { message: 'And then?', queued: true } }],
    [{ seq: 5, type: 'portal_prompt', payload: { message: 'Forgotten?', queued: true } }, { seq: 6, type: 'portal_unsent', payload: { seqs: [5], prompts: { 5: { message: 'Forgotten?', queued: true } } } }],
  ]) {
    assert.deepEqual(copyable([...answered, ...after]), ['First answer.']);
  }
});

test('reasoning for the next stretch takes Copy off the one before it until it is said', () => {
  assert.deepEqual(copyable([
    ...ask(1, 'One?'),
    said(4, 'Let me look.'),
    { seq: 5, type: 'message_update', payload: { streamId: 'b', assistantMessageEvent: { type: 'thinking_delta', delta: 'Hmm' } } },
  ]), []);
});

test('nothing to copy before anything has been said', () => {
  assert.deepEqual(copyable([]), []);
});
test('tool calls keep their arguments, output and timing; compaction shows where it happened', () => {
  const items = buildTranscript([
    { seq: 1, at: 1000, type: 'tool_execution_start', payload: { toolCallId: 't', toolName: 'bash', args: { command: 'ls -la' } } },
    { seq: 2, at: 1200, type: 'tool_execution_update', payload: { toolCallId: 't', partialResult: { content: [{ type: 'text', text: 'a' }] } } },
    { seq: 3, at: 1500, type: 'tool_execution_end', payload: { toolCallId: 't', toolName: 'bash', result: { content: [{ type: 'text', text: 'a\nb' }] } } },
    { seq: 4, at: 2000, type: 'compaction_start', payload: {} },
    { seq: 5, at: 3000, type: 'compaction_end', payload: { result: { summary: 'S', tokensBefore: 90000 } } },
  ] as any);
  const tool = items[0] as any;
  assert.deepEqual([tool.args, tool.output, tool.status, tool.until - tool.since], [{ command: 'ls -la' }, 'a\nb', 'done', 500]);
  assert.deepEqual(items[1], { kind: 'compaction', id: 'c4', status: 'done', since: 2000, until: 3000, tokensBefore: 90000, summary: 'S' });
});
test('a finished reply keeps how long it thought, though the deltas that timed it are gone', async () => {
 const { LiveEvents } = await import('../core/server/src/live-events.ts');
 let stored: any;
 const live = new LiveEvents((session, type, payload) => (stored = { seq: 1, session_id: session, type, payload: JSON.stringify(payload), created_at: '' }));
 const t0 = Date.now();
 live.record('s', 'message_update', { assistantMessageEvent: { type: 'thinking_delta', delta: 'Hm' } });
 live.record('s', 'message_end', { message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'Hm' }] } });
 const payload = JSON.parse(stored.payload);
 assert.ok(payload.thinkingSince >= t0 && payload.thinkingUntil >= payload.thinkingSince);
 // As a reload has it: the stored end alone, stamped well after the thinking.
 const [item] = buildTranscript([{ seq: 1, at: 99_000, type: 'message_end', payload: { ...payload, thinkingSince: 1_000, thinkingUntil: 13_000 } }]) as any[];
 assert.equal(item.thinkingSince, 1_000);
 assert.equal(item.thinkingUntil, 13_000);
});

test('a long tool output keeps its end and counts the lines of all of it', () => {
 const text=Array.from({length:50_000},(_,i)=>`line ${i}`).join('\n')+'\n';
 const items=buildTranscript([
  {seq:1,type:'tool_execution_start',payload:{toolCallId:'t',toolName:'bash',args:{command:'yes'}}},
  {seq:2,type:'tool_execution_end',payload:{toolCallId:'t',toolName:'bash',result:{content:[{type:'text',text}]}}},
 ] as any);
 const tool=items.find((i:any)=>i.kind==='tool') as any;
 assert.ok(tool.output.length<text.length);
 assert.equal(tool.outputLines,50_000);
});
