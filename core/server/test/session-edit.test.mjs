import assert from 'node:assert/strict';
import test from 'node:test';
const { dropMessage, SessionEditError } = await import('../dist/pi/session-edit.js');

const user = (id, parentId, text) => ({ type: 'message', id, parentId, message: { role: 'user', content: [{ type: 'text', text }] } });
const asst = (id, parentId, text = 'ok') => ({ type: 'message', id, parentId, message: { role: 'assistant', content: [{ type: 'text', text }] } });
const tool = (id, parentId) => ({ type: 'message', id, parentId, message: { role: 'toolResult', content: [{ type: 'text', text: 'out' }] } });
const file = (...entries) => [{ type: 'session', version: 3, id: 'hdr' }, ...entries].map((e) => JSON.stringify(e)).join('\n') + '\n';
const parse = (raw) => raw.split('\n').filter(Boolean).map((l) => JSON.parse(l));
const ids = (raw) => parse(raw).filter((e) => e.type !== 'session').map((e) => e.id);
/** What pi would open: the last entry, walked back to the root. */
const conversation = (raw) => {
  const body = parse(raw).filter((e) => e.type !== 'session');
  const byId = new Map(body.map((e) => [e.id, e]));
  const out = [];
  for (let id = body.at(-1)?.id; id; id = byId.get(id).parentId) out.unshift(id);
  return out;
};

const three = file(
  user('u1', null, 'first'), asst('a1', 'u1'),
  user('u2', 'a1', 'second'), asst('t2', 'u2'), tool('r2', 't2'), asst('a2', 'r2'),
  user('u3', 'a2', 'third'), asst('a3', 'u3'),
);

test('deleting a middle turn removes its answer and joins the neighbours', () => {
  const out = dropMessage(three, ['first', 'second'], 1, 'turn');
  assert.deepEqual(conversation(out), ['u1', 'a1', 'u3', 'a3']);
  assert.equal(parse(out).find((e) => e.id === 'u3').parentId, 'a1');
  // The header is untouched and the untouched lines are byte-for-byte the same.
  assert.equal(parse(out)[0].type, 'session');
  assert.ok(out.includes(JSON.stringify(user('u1', null, 'first'))));
});

test('deleting the last turn leaves the earlier conversation as it was', () => {
  const out = dropMessage(three, ['first', 'second', 'third'], 2, 'turn');
  assert.deepEqual(conversation(out), ['u1', 'a1', 'u2', 't2', 'r2', 'a2']);
});

test('deleting the first turn makes the second the root', () => {
  const out = dropMessage(three, ['first'], 0, 'turn');
  assert.deepEqual(conversation(out), ['u2', 't2', 'r2', 'a2', 'u3', 'a3']);
  assert.equal(parse(out).find((e) => e.id === 'u2').parentId, null);
});

test('editing drops the message and everything after it', () => {
  const out = dropMessage(three, ['first', 'second'], 1, 'tail');
  assert.deepEqual(conversation(out), ['u1', 'a1']);
  assert.deepEqual(ids(out), ['u1', 'a1']);
});

test('editing the first message empties the conversation', () => {
  const out = dropMessage(three, ['first'], 0, 'tail');
  assert.deepEqual(ids(out), []);
  assert.equal(parse(out).length, 1);
});

test('the same words sent twice are told apart by order', () => {
  const twice = file(user('u1', null, 'again'), asst('a1', 'u1'), user('u2', 'a1', 'again'), asst('a2', 'u2'));
  assert.deepEqual(conversation(dropMessage(twice, ['again', 'again'], 1, 'turn')), ['u1', 'a1']);
  assert.deepEqual(conversation(dropMessage(twice, ['again', 'again'], 0, 'turn')), ['u2', 'a2']);
});

test('a message pi never received does not throw the count off', () => {
  // "lost" failed before reaching pi, so it has a portal event and no entry.
  const out = dropMessage(three, ['first', 'lost', 'second'], 2, 'turn');
  assert.deepEqual(conversation(out), ['u1', 'a1', 'u3', 'a3']);
});

test('a voice message is found under its audio prefix', () => {
  const voiced = file(user('u1', null, '[Audio mode]\nhello'), asst('a1', 'u1'));
  assert.deepEqual(ids(dropMessage(voiced, ['hello'], 0, 'turn')), []);
});

test('a model change between turns survives the delete', () => {
  const changed = file(
    user('u1', null, 'first'), asst('a1', 'u1'), { type: 'model_change', id: 'm1', parentId: 'a1' },
    user('u2', 'm1', 'second'), asst('a2', 'u2'),
  );
  const out = dropMessage(changed, ['first', 'second'], 0, 'turn');
  assert.deepEqual(conversation(out), ['m1', 'u2', 'a2']);
});

test('a label on a removed message goes with it', () => {
  const labelled = file(user('u1', null, 'first'), asst('a1', 'u1'), { type: 'label', id: 'l1', parentId: 'a1', targetId: 'u1' }, user('u2', 'l1', 'second'));
  const out = dropMessage(labelled, ['first', 'second'], 0, 'turn');
  assert.ok(!ids(out).includes('l1'));
  assert.deepEqual(conversation(out), ['u2']);
});

test('a message under a later compaction cannot be deleted alone, but can be edited away', () => {
  const compacted = file(
    user('u1', null, 'first'), asst('a1', 'u1'),
    user('u2', 'a1', 'second'), asst('a2', 'u2'),
    { type: 'compaction', id: 'c1', parentId: 'a2', firstKeptEntryId: 'u2', summary: 's' },
    user('u3', 'c1', 'third'),
  );
  assert.throws(() => dropMessage(compacted, ['first', 'second', 'third'], 1, 'turn'), (e) => e instanceof SessionEditError && e.code === 'compacted');
  assert.deepEqual(conversation(dropMessage(compacted, ['first', 'second'], 1, 'tail')), ['u1', 'a1']);
  // Before the compaction is another matter: nothing summarises what came after.
  assert.deepEqual(conversation(dropMessage(compacted, ['first', 'second', 'third'], 2, 'turn')), ['u1', 'a1', 'u2', 'a2', 'c1']);
});

test('a message that is not in the history is refused, not guessed at', () => {
  assert.throws(() => dropMessage(three, ['first', 'never sent'], 1, 'turn'), (e) => e.code === 'unmatched');
});

test('a side branch makes the last entry ambiguous, so nothing is changed', () => {
  const branched = file(
    user('u1', null, 'first'), asst('a1', 'u1'),
    user('u2', 'a1', 'second'), asst('a2', 'u2'),
    asst('side', 'u1'), // a branch off the first turn, written last
  );
  // The conversation pi opens is u1 → side; asking about 'second' finds nothing on it.
  assert.throws(() => dropMessage(branched, ['first', 'second'], 1, 'turn'), SessionEditError);
});

test('a dead branch hanging off a removed message is removed with it', () => {
  const dead = file(
    user('u1', null, 'first'), asst('dead', 'u1'), asst('a1', 'u1'),
    user('u2', 'a1', 'second'), asst('a2', 'u2'),
  );
  // 'dead' is written before the live answer, so the path is u1 → a1 → u2 → a2.
  const out = dropMessage(dead, ['first', 'second'], 0, 'turn');
  assert.ok(!ids(out).includes('a1'));
  assert.ok(!ids(out).includes('dead'));
  assert.deepEqual(conversation(out), ['u2', 'a2']);
});

test('a later message that merely contains the words is not taken for a message pi never got', () => {
  // "foo" failed before reaching pi; "foobar" is a different message that happens to contain it.
  const partial = file(user('u1', null, 'first'), asst('a1', 'u1'), user('u2', 'a1', 'foobar'), asst('a2', 'u2'));
  assert.throws(() => dropMessage(partial, ['first', 'foo'], 1, 'turn'), (e) => e instanceof SessionEditError && e.code === 'unmatched');
  assert.throws(() => dropMessage(partial, ['first', 'foo'], 1, 'tail'), (e) => e.code === 'unmatched');
});
