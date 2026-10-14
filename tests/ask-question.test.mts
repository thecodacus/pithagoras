import test from 'node:test';
import assert from 'node:assert/strict';
import { readQuestions, readAnswers, describeAnswers, askQuestionTool, ASK_QUESTION_TOOL, MAX_QUESTIONS, asksQuestions } from '../core/server/src/pi/ask-question.ts';
import { isDialog } from '../core/server/src/pi/ui-requests.ts';

/** The tool as pi gets it: registered on a fake pi, run with the context a test gives it. */
function tool() {
  let registered: any;
  askQuestionTool()({ registerTool: (t: any) => (registered = t) });
  return registered;
}

const ask = [
  { question: 'Which database?', options: [{ label: 'SQLite', description: 'one file' }, { label: 'Postgres' }], allowOther: true },
  { id: 'features', question: 'Which features?', kind: 'multiple', options: ['Search', 'Export', 'Sync'] },
  { id: 'why', question: 'Anything else?', kind: 'text', optional: true },
  { id: 'order', question: 'Rank them', kind: 'ranking', options: [{ label: 'Speed' }, { label: 'Cost' }, { label: 'Safety' }] },
];

test('the tool is registered under its name, and a dialog request of the questions kind waits for an answer', () => {
  assert.equal(tool().name, ASK_QUESTION_TOOL);
  assert.equal(isDialog('questions'), true);
  assert.equal(isDialog('setStatus'), false);
});

test('questions are completed: default kind and ids, bare-string options, the flags', () => {
  const qs = readQuestions(ask);
  assert.deepEqual(qs.map((q) => [q.id, q.kind, q.other, q.optional]), [
    ['q1', 'single', true, false],
    ['features', 'multiple', false, false],
    ['why', 'text', false, true],
    ['order', 'ranking', false, false],
  ]);
  assert.deepEqual(qs[0].options, [{ label: 'SQLite', description: 'one file' }, { label: 'Postgres' }]);
  assert.deepEqual(qs[1].options.map((o) => o.label), ['Search', 'Export', 'Sync']);
});

test('questions the dialog could not draw are refused with a reason the model can act on', () => {
  const bad = (raw: unknown, re: RegExp) => assert.throws(() => readQuestions(raw), re);
  bad([], /at least one/);
  bad('nope', /at least one/);
  bad(Array.from({ length: MAX_QUESTIONS + 1 }, () => ({ question: 'q', options: ['a'] })), /at most 8/);
  bad([{ question: '  ' }], /no text/);
  bad([{ question: 'q', kind: 'slider' }], /kind must be/);
  bad([{ question: 'q', kind: 'ranking', options: ['a'] }], /at least two options to put in order, as in "options": \["First", "Second"\]/);
  bad([{ question: 'q', kind: 'ranking' }], /at least two/);
  bad([{ question: 'q', kind: 'text', options: ['a'] }], /takes no options\. Leave "kind" out for a choice/);
  bad([{ question: 'q', options: ['a', 'a'] }], /twice/);
  bad([{ id: 'x', question: 'q', options: ['a'] }, { id: 'x', question: 'r', options: ['a'] }], /used twice/);
});

test('a question without options is answered in words, as the model meant it, whatever kind of choice it named', () => {
  // As a model sent them, again and again while each was turned away for having no options: no kind, or "single".
  const qs = readQuestions([
    { question: 'Which language do you prefer?', id: 'q1-fav-lang' },
    { question: 'Which tools do you use? (several)', kind: 'multiple', id: 'q2-tools' },
    { question: 'What else to test?', kind: 'single' },
    { question: 'Which framework?', options: ['React', 'Vue'] },
  ]);
  assert.deepEqual(qs.map((q) => [q.id, q.kind, q.options, q.other]), [
    ['q1-fav-lang', 'text', [], false],
    ['q2-tools', 'text', [], false],
    ['q3', 'text', [], false],
    ['q4', 'single', [{ label: 'React' }, { label: 'Vue' }], false],
  ]);
  assert.deepEqual(readAnswers(qs, { 'q1-fav-lang': 'Rust', q2_tools: 'x', q3: ['no'] }), { 'q1-fav-lang': 'Rust' });
  // The tool says so, with a call to copy.
  const { description, parameters } = tool();
  assert.match(description, /without, a text answer/);
  assert.match(description, /"options":\["SQLite","Postgres"\]/);
  // And the call is one the tool takes.
  const example = JSON.parse(/Example: (\{.*\})$/.exec(description)![1]);
  assert.deepEqual(readQuestions(example.questions).map((q) => [q.kind, q.optional]), [['single', false], ['text', true]]);
  assert.match(parameters.properties.questions.items.properties.kind.description, /Default: single with options, text without/);
});

test('answers are held to what was asked: strangers, wrong shapes and half rankings are dropped', () => {
  const qs = readQuestions(ask);
  const got = readAnswers(qs, {
    q1: 'MySQL, typed in', // allowed: this one takes other answers
    features: ['Search', 'Search', 'Teleport'], // doubled and not offered
    why: '  because  ',
    order: ['Cost', 'Safety', 'Speed'],
    extra: 'not a question',
  });
  assert.deepEqual(got, { q1: 'MySQL, typed in', features: ['Search'], why: 'because', order: ['Cost', 'Safety', 'Speed'] });

  assert.deepEqual(readAnswers(qs, { features: 'Search', order: ['Cost', 'Speed'], q1: 7, why: '' }), {}, 'a string for several, a short ranking, a number, an empty text');
  assert.deepEqual(readAnswers(qs, { order: ['Cost', 'Cost', 'Speed'] }), {}, 'a ranking that repeats one and leaves one out');
  assert.deepEqual(readAnswers(readQuestions([{ question: 'q', options: ['a', 'b'] }]), { q1: 'c' }), {}, 'not an option, and others not allowed');
  assert.deepEqual(readAnswers(qs, null), {});
  assert.deepEqual(readAnswers(qs, ['q1']), {});
});

test('the model is told each answer, what was typed in, and what was left', () => {
  const qs = readQuestions(ask);
  const text = describeAnswers(qs, { q1: 'MySQL', features: ['Search', 'Sync'], order: ['Cost', 'Safety', 'Speed'] });
  assert.match(text, /1\. Which database\?\n\s+Chosen: "MySQL" \(typed in, not one of the options\)/);
  assert.match(text, /Chosen: Search; Sync/);
  assert.match(text, /No answer \(it was optional\)/);
  assert.match(text, /1\) Cost {2}2\) Safety {2}3\) Speed/);
});

test('ids that are keys every object has are ids like any other, and an unanswered one has no answer', () => {
  const qs = readQuestions([
    { id: 'constructor', question: 'a', options: ['x', 'y'], optional: true },
    { id: '__proto__', question: 'b', options: ['x', 'y'], optional: true },
    { id: 'toString', question: 'c', kind: 'text', optional: true },
  ]);
  assert.deepEqual(Object.keys(readAnswers(qs, {})), [], 'nothing given, nothing answered');
  assert.deepEqual(Object.keys(readAnswers(qs, JSON.parse('{"__proto__":"y","constructor":"x"}'))).sort(), ['__proto__', 'constructor'], 'given, kept under its own id');
  const text = describeAnswers(qs, readAnswers(qs, {}));
  assert.doesNotMatch(text, /native code|Object/);
  assert.equal(text.match(/No answer \(it was optional\)/g)?.length, 3);
});

test('the schema takes plain strings as options, as the questions do, so pi does not turn the call away', async () => {
  const { Value } = await import('typebox/value');
  const params = tool().parameters;
  assert.equal(Value.Check(params, { questions: [{ question: 'q', options: ['a', 'b'] }] }), true);
  assert.equal(Value.Check(params, { questions: [{ question: 'q', options: [{ label: 'a' }] }] }), true);
});

test('the tool is for the chats where a person answers in the web UI: a task and an Agent-page chat, not a routine, a heartbeat, a channel chat or a lower role', () => {
  assert.equal(asksQuestions({ kind: 'task' }, false), true);
  assert.equal(asksQuestions({ kind: 'task', role: 'primary' }, false), true);
  assert.equal(asksQuestions({ kind: 'agent', role: 'primary' }, false), true, 'a conversation on the Agent page');
  assert.equal(asksQuestions({ kind: 'agent' }, true), false, 'a chat reached through a channel');
  assert.equal(asksQuestions({ kind: 'routine' }, false), false, 'routine');
  assert.equal(asksQuestions({ kind: 'heartbeat' }, false), false, 'heartbeat');
  assert.equal(asksQuestions({ kind: 'task', role: 'guest' }, false), false);
  assert.equal(asksQuestions({ kind: 'agent', role: 'colleague' }, false), false);
});

test('running the tool asks the context, with a wait of its own, and reports what came back', async () => {
  const seen: any[] = [];
  const ctx = { ui: { questions: async (payload: any, opts: any) => (seen.push([payload, opts]), { q1: 'SQLite', features: ['Export'], order: ['Speed', 'Cost', 'Safety'] }) } };
  const signal = new AbortController().signal;
  const out = await tool().execute('id', { title: 'Setup', questions: ask }, signal, undefined, ctx);
  assert.equal(seen[0][0].title, 'Setup');
  assert.equal(seen[0][0].questions.length, 4);
  assert.equal(seen[0][1].signal, signal);
  assert.equal(seen[0][1].timeout, 0, 'no wait limit by default');
  assert.match(out.content[0].text, /Chosen: SQLite/);
  assert.match(out.content[0].text, /Chosen: Export/);
});

test('the wait is read each time a question is asked', async () => {
  let minutes = 0;
  const seen: number[] = [];
  let registered: any;
  askQuestionTool(() => minutes * 60_000)({ registerTool: (t: any) => (registered = t) });
  const ctx = { ui: { questions: async (_p: any, opts: any) => (seen.push(opts.timeout), {}) } };
  await registered.execute('id', { questions: ask }, undefined, undefined, ctx);
  minutes = 30;
  await registered.execute('id', { questions: ask }, undefined, undefined, ctx);
  assert.deepEqual(seen, [0, 30 * 60_000]);
});

test('questions cancelled without answers are a result, not an error; a context with no screen is an error', async () => {
  const closed = await tool().execute('id', { questions: ask }, undefined, undefined, { ui: { questions: async () => undefined } });
  assert.match(closed.content[0].text, /cancelled the questions without answering/);
  assert.equal(closed.details.outcome, 'cancelled');
  await assert.rejects(tool().execute('id', { questions: ask }, undefined, undefined, { ui: {} }), /no screen/);
  await assert.rejects(tool().execute('id', { questions: [] }, undefined, undefined, { ui: { questions: async () => ({}) } }), /at least one/);
});

test('a run stopped before the answers came is told so, and that the questions may still be answered, not that they were cancelled', async () => {
  const run = new AbortController();
  // As the portal's context does on a stop: the dialog closes, with no value.
  const ctx = { ui: { questions: async () => (run.abort(), undefined) } };
  const out = await tool().execute('id', { questions: ask }, run.signal, undefined, ctx);
  assert.equal(out.details.outcome, 'stopped');
  assert.match(out.content[0].text, /stopped before the person answered/);
  assert.match(out.content[0].text, /still open in the chat/);
  assert.doesNotMatch(out.content[0].text, /cancelled|best judgement/);
});
