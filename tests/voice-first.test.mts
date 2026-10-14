import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AudioRule, VoiceFirstTurn, DEFAULT_SKIP_THINKING_PROVIDERS, listsProvider, AUDIO_SYSTEM_RULE, DEFAULT_VOICE_INSTRUCTIONS, audioSystemRule, voiceInstructions, voiceRulesOn, audioMessage, spokenIn } from '../core/server/src/pi/voice-first.js';
function setup() {
 const turn = new VoiceFirstTurn(), handlers = new Map<string, (...args: any[]) => any>();
 turn.extension({ on: (name: string, fn: any) => handlers.set(name, fn) });
 const payload = { messages: [{ role: 'system', content: AUDIO_SYSTEM_RULE }, { role: 'user', content: audioMessage('Latest request') }], thinking_budget_tokens: 1024, chat_template_kwargs: { existing: true } };
 const request = () => handlers.get('before_provider_request')!({ payload }, { model: { provider: 'llama.cpp' } });
 return { turn, handlers, payload, request };
}
test('audio requests carry a persistent marker and a stable conditional system rule', () => {
 assert.equal(audioMessage('Hello'), '[Audio mode]\nHello');
 assert.match(AUDIO_SYSTEM_RULE, /latest user request only/);
 assert.match(AUDIO_SYSTEM_RULE, /typed requests/);
 assert.match(AUDIO_SYSTEM_RULE, /normal chat formatting/);
 assert.match(AUDIO_SYSTEM_RULE, /plain conversational text/);
 assert.match(AUDIO_SYSTEM_RULE, /what you are going to do/);
 // Short lines of its thinking while it works, not silence and not a line per tool call.
 assert.match(AUDIO_SYSTEM_RULE, /think aloud now and then/);
 assert.match(AUDIO_SYSTEM_RULE, /not one per tool call/);
 assert.doesNotMatch(AUDIO_SYSTEM_RULE, /stay quiet until you have the result/);
 assert.doesNotMatch(AUDIO_SYSTEM_RULE, /Before every tool call/);
 // Not to be read as saying the message in hand has the marker: issue #26.
 assert.match(AUDIO_SYSTEM_RULE, /does not mean any request has it/);
});
test('voice mode never injects or mutates messages', () => {
 const { turn, payload, request, handlers } = setup(); turn.arm();
 const result = request();
 assert.equal(result.messages, payload.messages);
 assert.equal(result.messages.length, 2);
 assert.equal(handlers.has('before_agent_start'), false, 'the rule is in pi\'s own prompt: see AudioRule');
 assert.deepEqual(request(), result);
});
test('a conversation is spoken when a user message on its path has the marker', () => {
 const user = (content: unknown) => ({ type: 'message', message: { role: 'user', content } });
 assert.equal(spokenIn([user('Typed'), { type: 'message', message: { role: 'assistant', content: audioMessage('echo') } }]), false);
 assert.equal(spokenIn([user(audioMessage('Hi'))]), true);
 // With a picture, as pi keeps it.
 assert.equal(spokenIn([user([{ type: 'text', text: audioMessage('Look') }, { type: 'image', data: '', mimeType: 'image/png' }])]), true);
 assert.equal(spokenIn([user([{ type: 'text', text: 'Look [Audio mode]' }])]), false);
});
test('a prompt built elsewhere is made to say what the rule says now', () => {
 const rule = new AudioRule();
 assert.equal(rule.into('Base\n\nAppended', 'Appended'), 'Base\n\nAppended', 'off, and not there: as it is');
 rule.set(true);
 assert.equal(rule.into('Base\n\nAppended\n\nPolicy', 'Appended'), `Base\n\nAppended\n\n${AUDIO_SYSTEM_RULE}\n\nPolicy`, 'after what pi appends');
 assert.equal(rule.into('Own prompt', 'Appended'), `Own prompt\n\n${AUDIO_SYSTEM_RULE}`, 'at the end when that is not there');
 const said = `Base\n\nAppended\n\n${AUDIO_SYSTEM_RULE}`;
 assert.equal(rule.into(said, 'Appended'), said, 'there already');
 rule.set(false);
 assert.equal(rule.into(`${said}\n\nPolicy`, 'Appended'), 'Base\n\nAppended\n\nPolicy', 'out again');
});
test('while voice can speak the rule is in every conversation, spoken in or not, and goes when voice is switched off', () => {
 let speaks = true;
 const rule = new AudioRule(undefined, undefined, () => speaks);
 // A conversation nobody has spoken in has it from the start, and its first spoken message changes nothing.
 assert.equal(rule.set(false), true);
 assert.deepEqual(rule.lines(), [AUDIO_SYSTEM_RULE]);
 assert.equal(rule.set(true), false, 'the prompt is not built again for the first spoken message');
 // Its spoken message edited away: still there, as voice can still speak.
 assert.equal(rule.set(false), false);
 // Voice switched off, or left with recognition alone: as before, only where there was a spoken message.
 speaks = false;
 assert.equal(rule.set(false), true);
 assert.deepEqual(rule.lines(), []);
 assert.equal(rule.set(true), true);
 assert.deepEqual(rule.lines(), [AUDIO_SYSTEM_RULE]);
 // VOICE_RESPONSE_INSTRUCTIONS=false sends no rule at all, whatever voice can do.
 const previous = process.env.VOICE_RESPONSE_INSTRUCTIONS;
 try {
  process.env.VOICE_RESPONSE_INSTRUCTIONS = 'false';
  speaks = true;
  const off = new AudioRule(undefined, undefined, () => speaks);
  off.set(true);
  assert.deepEqual(off.lines(), []);
 } finally {
  if (previous === undefined) delete process.env.VOICE_RESPONSE_INSTRUCTIONS;
  else process.env.VOICE_RESPONSE_INSTRUCTIONS = previous;
 }
});
test('the rule says whether it changed, so the prompt is built again only then', () => {
 const rule = new AudioRule();
 assert.deepEqual(rule.lines(), []);
 assert.equal(rule.set(true), true);
 assert.deepEqual(rule.lines(), [AUDIO_SYSTEM_RULE]);
 assert.equal(rule.set(true), false);
 // Its spoken message edited away.
 assert.equal(rule.set(false), true);
 assert.deepEqual(rule.lines(), []);
});
test('only the first call skips thinking, preserving saved settings', () => {
 const { turn, handlers, payload, request } = setup(); turn.arm();
 assert.equal(request().chat_template_kwargs.enable_thinking, false);
 assert.equal(request().thinking_budget_tokens, undefined);
 assert.equal(payload.thinking_budget_tokens, 1024);
 handlers.get('turn_end')!(); assert.equal(request(), undefined);
 turn.arm(); turn.reset(); assert.equal(request(), undefined);
 turn.arm(false); assert.equal(request(), undefined);
});

test('comparison instance preserves model thinking on the first voice request', () => {
 const previous = process.env.VOICE_SKIP_FIRST_THINKING;
 try {
  process.env.VOICE_SKIP_FIRST_THINKING = 'false';
  const {turn,payload,request} = setup();turn.arm();
  assert.equal(request(), undefined);
  assert.equal(payload.thinking_budget_tokens,1024);
  assert.deepEqual(payload.chat_template_kwargs,{existing:true});
 } finally {
  if(previous === undefined)delete process.env.VOICE_SKIP_FIRST_THINKING;
  else process.env.VOICE_SKIP_FIRST_THINKING=previous;
 }
});

test('the first call skips thinking for the providers listed: by default every way a llama.cpp server shows up, llama-swap included', () => {
 const call = (turn: VoiceFirstTurn, provider: string) => {
  const handlers = new Map<string, (...args: any[]) => any>();
  turn.extension({ on: (name: string, fn: any) => handlers.set(name, fn) }); turn.arm();
  return handlers.get('before_provider_request')!({ payload: { messages: [], chat_template_kwargs: {} } }, { model: { provider } })?.chat_template_kwargs?.enable_thinking;
 };
 for (const provider of ['llama.cpp', 'llama-server=http://127.0.0.1:8080', 'llama-swap']) assert.equal(call(new VoiceFirstTurn(), provider), false, provider);
 assert.equal(call(new VoiceFirstTurn(), 'anthropic'), undefined, 'not listed');
 assert.equal(call(new VoiceFirstTurn(() => ['llama-swap']), 'llama-swapper'), undefined, 'a listed name is matched whole, not as a prefix');
 // A saved list replaces the default one, read at the call.
 let saved: string[] | undefined = ['my-gateway'];
 const turn = () => new VoiceFirstTurn(() => saved);
 assert.equal(call(turn(), 'my-gateway'), false);
 assert.equal(call(turn(), 'my-gateway=http://10.0.0.2:8080'), false);
 assert.equal(call(turn(), 'llama-swap'), undefined);
 saved = [];
 assert.equal(call(turn(), 'llama-swap'), undefined, 'an empty list keeps thinking on everywhere');
 assert.deepEqual([...DEFAULT_SKIP_THINKING_PROVIDERS], ['llama.cpp', 'llama-server', 'llama-swap']);
 assert.equal(listsProvider(['a'], undefined), false);
});

test('unoptimized voice baseline omits voice instructions and the audio marker', () => {
 const previous = process.env.VOICE_RESPONSE_INSTRUCTIONS;
 try {
  process.env.VOICE_RESPONSE_INSTRUCTIONS = 'false';
  assert.equal(voiceRulesOn(), false);
  assert.equal(audioMessage('Write a detailed report'), 'Write a detailed report');
  const rule = new AudioRule();
  assert.equal(rule.set(true), false);
  assert.deepEqual(rule.lines(), []);
  delete process.env.VOICE_RESPONSE_INSTRUCTIONS;
  assert.equal(voiceRulesOn(), true);
  assert.equal(audioMessage('Hello'), '[Audio mode]\nHello');
 } finally {
  if(previous === undefined)delete process.env.VOICE_RESPONSE_INSTRUCTIONS;
  else process.env.VOICE_RESPONSE_INSTRUCTIONS=previous;
 }
});

test('saved speaking instructions replace the built-in ones, and blank means the built-in ones', () => {
 assert.equal(voiceInstructions(undefined), DEFAULT_VOICE_INSTRUCTIONS);
 assert.equal(voiceInstructions(''), DEFAULT_VOICE_INSTRUCTIONS);
 assert.equal(voiceInstructions(' \n '), DEFAULT_VOICE_INSTRUCTIONS);
 assert.equal(voiceInstructions(42), DEFAULT_VOICE_INSTRUCTIONS);
 assert.equal(voiceInstructions('  Answer in one word.\n'), 'Answer in one word.');
 assert.equal(audioSystemRule(), AUDIO_SYSTEM_RULE, 'built in unless told otherwise');
 const custom = audioSystemRule('Answer in one word.');
 assert.ok(custom.includes(' Answer in one word. Do not read the marker aloud.'));
 assert.ok(!custom.includes(DEFAULT_VOICE_INSTRUCTIONS));
 // What the marker means, and what to do without it, is not the instructions' to change.
 for (const kept of [/latest user request only/, /does not mean any request has it/, /normal chat formatting/]) assert.match(custom, kept);
});
test('the rule is made from the saved instructions when a spoken message turns it on', () => {
 let saved = '';
 const rule = new AudioRule(() => saved);
 assert.equal(rule.set(true), true);
 assert.deepEqual(rule.lines(), [AUDIO_SYSTEM_RULE], 'nothing saved: the built-in instructions');
 assert.equal(rule.set(true), false, 'same instructions: not a change');
 saved = 'Answer in one word.';
 assert.deepEqual(rule.lines(), [AUDIO_SYSTEM_RULE], 'not before a spoken message asks');
 assert.equal(rule.set(true), true, 'other instructions: the prompt is built again');
 assert.deepEqual(rule.lines(), [audioSystemRule('Answer in one word.')]);
 assert.equal(rule.set(true), false);
 assert.equal(rule.set(false), true);
 assert.deepEqual(rule.lines(), []);
});
test('a prompt that still has the earlier instructions gets the new ones where they stood', () => {
 let saved = 'First wording.';
 const rule = new AudioRule(() => saved);
 rule.set(true);
 const first = audioSystemRule('First wording.');
 const before = `Base\n\nAppended\n\n${first}\n\nPolicy`;
 saved = 'Second wording.';
 rule.set(true);
 const second = audioSystemRule('Second wording.');
 assert.equal(rule.into(before, 'Appended'), `Base\n\nAppended\n\n${second}\n\nPolicy`);
 assert.equal(rule.into(`Base\n\nAppended\n\n${second}`, 'Appended'), `Base\n\nAppended\n\n${second}`, 'the new ones there already');
 rule.set(false);
 assert.equal(rule.into(before, 'Appended'), 'Base\n\nAppended\n\nPolicy', 'out again, whichever it had');
});
test('VOICE_RESPONSE_INSTRUCTIONS=false switches the rule off whatever is saved', () => {
 const previous = process.env.VOICE_RESPONSE_INSTRUCTIONS;
 try {
  process.env.VOICE_RESPONSE_INSTRUCTIONS = 'false';
  const rule = new AudioRule(() => 'Answer in one word.');
  assert.equal(rule.set(true), false);
  assert.deepEqual(rule.lines(), []);
  // Any other value leaves them on, and saved instructions are then used.
  process.env.VOICE_RESPONSE_INSTRUCTIONS = 'true';
  assert.equal(rule.set(true), true);
  assert.deepEqual(rule.lines(), [audioSystemRule('Answer in one word.')]);
 } finally {
  if(previous === undefined)delete process.env.VOICE_RESPONSE_INSTRUCTIONS;
  else process.env.VOICE_RESPONSE_INSTRUCTIONS=previous;
 }
});
test('a change the prompt could not be built with goes back to what the rule said, not to off', () => {
 let saved = 'First wording.';
 const rule = new AudioRule(() => saved);
 rule.set(true);
 const first = audioSystemRule('First wording.');
 saved = 'Second wording.';
 assert.equal(rule.set(true), true);
 rule.undo();
 assert.deepEqual(rule.lines(), [first], 'pi\'s prompt still has the first wording');
 assert.equal(rule.into(`Base\n\nAppended\n\n${first}`, 'Appended'), `Base\n\nAppended\n\n${first}`);
 assert.equal(rule.set(true), true, 'the next spoken message tries again');
 assert.deepEqual(rule.lines(), [audioSystemRule('Second wording.')]);
 // Turned on for the first time, it goes back to off.
 const fresh = new AudioRule();
 fresh.set(true);
 fresh.undo();
 assert.deepEqual(fresh.lines(), []);
 assert.equal(fresh.set(true), true);
});
test('what a tool says of itself follows the instructions, whatever they are, and only while the tool is there', () => {
 const line = 'Call generate_image to make a picture.';
 assert.equal(audioSystemRule(undefined, ''), AUDIO_SYSTEM_RULE, 'nothing to add: as it was');
 const custom = audioSystemRule('Answer in one word.', line);
 assert.ok(custom.includes(` Answer in one word. ${line} Do not read the marker aloud.`));
 assert.ok(audioSystemRule(undefined, line).includes(`${DEFAULT_VOICE_INSTRUCTIONS} ${line} Do not read the marker aloud.`));
 let there = false;
 const rule = new AudioRule(() => 'Answer in one word.', () => (there ? line : ''));
 rule.set(true);
 assert.deepEqual(rule.lines(), [audioSystemRule('Answer in one word.')], 'no tool: no line');
 there = true;
 assert.equal(rule.set(true), true, 'the tool came with a reload: the prompt is built again');
 assert.deepEqual(rule.lines(), [custom]);
 assert.equal(rule.into('Base', 'Base'), `Base\n\n${custom}`);
 there = false;
 assert.equal(rule.set(true), true, 'and went again');
 assert.deepEqual(rule.lines(), [audioSystemRule('Answer in one word.')]);
});
