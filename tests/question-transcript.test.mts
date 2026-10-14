import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTranscript } from '../core/web/src/transcript.ts';

/** The agent's ask_question questions in the transcript (issue #114): open until their end comes, then their record. */
const questions = [{ id: 'db', question: 'Which database?', kind: 'single', options: [{ label: 'SQLite' }], other: false, optional: false }];
const asked = { seq: 5, type: 'portal_question', payload: { id: 'q1', title: 'Setup', questions } };

test('a question is open until its end comes, and then keeps how it ended and the answers', () => {
  assert.deepEqual(buildTranscript([asked]), [{ kind: 'question', id: 'qq1', questionId: 'q1', title: 'Setup', questions, state: 'open' }]);
  const answered = buildTranscript([asked, { seq: 6, type: 'portal_question_end', payload: { of: 'q1', outcome: 'answered', answers: { db: 'SQLite' } } }]);
  assert.deepEqual(answered, [{ kind: 'question', id: 'qq1', questionId: 'q1', title: 'Setup', questions, state: 'answered', answers: { db: 'SQLite' } }]);
  for (const outcome of ['cancelled', 'expired', 'stopped']) {
    const [item] = buildTranscript([asked, { seq: 6, type: 'portal_question_end', payload: { of: 'q1', outcome } }]) as any[];
    assert.equal(item.state, outcome);
    assert.equal(item.answers, undefined);
  }
});

test('a question sent again with the stream is drawn once, where it was asked', () => {
  const prompt = { seq: 4, type: 'portal_prompt', payload: { message: 'Go' } };
  const copy = { ...asked, seq: -1 };
  const items = buildTranscript([prompt, asked, copy]);
  assert.deepEqual(items.map((i) => i.id), ['u4', 'qq1']);
  // A page whose loaded end does not reach back to it has only the copy, and draws that.
  assert.deepEqual(buildTranscript([copy]).map((i) => i.id), ['qq1']);
});

test('a run that ends leaves an open question open: it is answered after a restart too', () => {
  const [item] = buildTranscript([asked, { seq: 7, type: 'portal_status', payload: { status: 'interrupted', restarted: true } }], { ended: true }) as any[];
  assert.equal(item.state, 'open');
});
