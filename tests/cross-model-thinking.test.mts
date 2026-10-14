import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { closeForeignThinking, crossModelThinkingExtension } from '../core/server/src/pi/cross-model-thinking.ts';

// pi-ai's own request builder for llama.cpp, wherever npm put it: what reaches the model is the test.
const piAi = ['../node_modules/@earendil-works/pi-ai', '../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai']
  .map((p) => new URL(p, import.meta.url)).find((u) => existsSync(u))!;
const { convertMessages } = await import(new URL('dist/api/openai-completions.js', piAi + '/').href);

const modelA = { provider: 'llama-swap', api: 'openai-completions', id: 'model-a-128k' };
const modelB = { provider: 'llama-swap', api: 'openai-completions', id: 'model-b-1gpu' };
const reply = (by: typeof modelA, content: any[]) => ({ role: 'assistant', provider: by.provider, api: by.api, model: by.id, content, stopReason: 'stop', usage: {} });
const user = (text: string) => ({ role: 'user', content: text, timestamp: 0 });
const thought = { type: 'thinking', thinking: 'The user just said "hi". Let me respond briefly.', thinkingSignature: 'reasoning_content' };
const history = [user('hi'), reply(modelA, [thought, { type: 'text', text: 'Hi! What can I help you with?' }]), user('hello')];
const sent = (messages: any[], model: typeof modelA) => convertMessages({ ...model, reasoning: true, input: ['text'] }, { messages }, {}, {}).filter((m: any) => m.role === 'assistant');

test('without the hook, another model\'s reasoning reaches the next one as part of the answer (#60)', () => {
  const [assistant] = sent(history, modelB);
  assert.match(assistant.content, /Let me respond briefly\.Hi! What can I help you with\?|Let me respond briefly\.\s*Hi!/);
});

test('with it, the next model reads the answer alone, as its own template would leave an earlier turn', () => {
  const [assistant] = sent(closeForeignThinking(history, modelB), modelB);
  assert.equal(assistant.content, 'Hi! What can I help you with?');
  assert.equal(assistant.reasoning_content, undefined);
});

test('the model\'s own answers keep their thinking, which goes back as reasoning', () => {
  assert.equal(closeForeignThinking(history, modelA), history, 'nothing changed, nothing copied');
  const [assistant] = sent(history, modelA);
  assert.equal(assistant.content, 'Hi! What can I help you with?');
  assert.match(assistant.reasoning_content, /Let me respond briefly/);
});

test('a reply by another model that ended inside its thinking goes on as closed reasoning, not as an answer', () => {
  const ended = [user('hi'), reply(modelA, [thought]), user('hello')];
  const [assistant] = sent(closeForeignThinking(ended, modelB), modelB);
  assert.equal(assistant.content, '<think>\nThe user just said "hi". Let me respond briefly.\n</think>');
});

test('tool calls and redacted thinking are as pi-ai would have them, and a model ID alone is a different model', () => {
  const call = { type: 'toolCall', id: 'c1', name: 'bash', arguments: { command: 'ls' } };
  const out = closeForeignThinking([reply(modelA, [thought, call]), reply(modelA, [{ type: 'thinking', thinking: '', redacted: true }, { type: 'text', text: 'ok' }])], modelB);
  assert.deepEqual(out[0].content, [call]);
  assert.equal(out[1].content.length, 2, 'redacted thinking is left for pi-ai, which drops it');
  // model-c-flash and model-c-flash-1gpu are two models to pi-ai: the switch between them is a switch.
  const near = { ...modelA, id: 'model-c-flash' };
  assert.notEqual(closeForeignThinking([reply(near, [thought, { type: 'text', text: 'Hi' }])], { ...near, id: 'model-c-flash-1gpu' })[0].content.length, 2);
});

test('the hook gives pi a history only where it changed one', () => {
  let handler: any;
  crossModelThinkingExtension({ on: (name: string, h: any) => { assert.equal(name, 'context'); handler = h; } });
  assert.equal(handler({ messages: history }, { model: modelA }), undefined);
  assert.equal(handler({ messages: history }, { model: undefined }), undefined);
  const changed = handler({ messages: history }, { model: modelB });
  assert.deepEqual(changed.messages[1].content, [{ type: 'text', text: 'Hi! What can I help you with?' }]);
  assert.equal(history[1].content.length, 2, 'the history pi passed in is not changed under it');
});
