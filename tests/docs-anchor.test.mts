import { test } from 'node:test';
import assert from 'node:assert/strict';
import { around, carry, CONTEXT, isWhole, locate, passage, squash, trimmed } from '../extensions/docs/web/anchor.js';

/**
 * Where the passage of a comment is in a text, and where it goes when the text changes (extensions/docs/web/anchor.js),
 * with no editor, no server and no clock.
 */

interface Anchor { start: number | null; end: number | null; quote: string; prefix: string; suffix: string }
type Range = { start: number; end: number } | null;

/** The passage `quote` of `text` (its `nth` place) as it is kept. */
function anchorOf(text: string, quote: string, nth = 0): Anchor {
  let start = -1;
  for (let n = 0; n <= nth; n++) start = text.indexOf(quote, start + 1);
  assert.ok(start >= 0, `${quote} is in the text`);
  return passage(text, start, start + quote.length) as Anchor;
}

/** Where `carry` puts the passages, as the words they are on in the new text. */
const words = (before: string, after: string, ...anchors: Anchor[]) => (carry(before, after, anchors) as Range[]).map((r) => (r ? after.slice(r.start, r.end) : null));

const PLAN = '# Plan\n\nShip it on Friday.\n\nThe build is green.\n\nSign-off is on Monday.\n';

test('a passage is kept with its words and what is around them, without white space at its edges', () => {
  const at = PLAN.indexOf('The build is green.');
  const kept = passage(PLAN, at - 2, at + 19 + 1) as Anchor;
  assert.equal(kept.quote, 'The build is green.');
  assert.equal(kept.start, at);
  assert.equal(kept.end, at + 19);
  assert.equal(kept.prefix, '# Plan\n\nShip it on Friday.\n\n');
  assert.equal(kept.suffix, '\n\nSign-off is on Monday.\n');
  assert.equal(passage(PLAN, 1, 2), null, 'white space only is no passage');
  assert.deepEqual(trimmed('  ab \n', 0, 6), { start: 2, end: 4 });
  assert.equal(trimmed('   ', 0, 3), null);
  // The context is no more than CONTEXT characters, and never half of a character outside the basic plane.
  const long = `${'😀'.repeat(40)}target${'😀'.repeat(40)}`;
  const c = around(long, 80, 86);
  assert.ok(c.prefix.length <= CONTEXT && c.suffix.length <= CONTEXT);
  assert.ok(isWhole(c.prefix) && isWhole(c.suffix));
  // The window of context begins and ends in the middle of a character: it is cut short of it.
  const wide = `${'😀'.repeat(20)}atarget`;
  const w = around(wide, wide.indexOf('target'), wide.indexOf('target') + 6);
  assert.ok(isWhole(w.prefix) && w.prefix.length === 31, `a prefix of whole characters, not ${JSON.stringify(w.prefix)}`);
  const tail = `target${'a'}${'😀'.repeat(20)}`;
  const t = around(tail, 0, 6);
  assert.ok(isWhole(t.suffix) && t.suffix.length === 31, `a suffix of whole characters, not ${JSON.stringify(t.suffix)}`);
  // A passage whose ends are in the middle of one is the whole of it.
  assert.equal((passage('a😀b', 2, 3) as Anchor).quote, '😀');
  assert.equal((passage('a😀b', 1, 2) as Anchor).quote, '😀');
  assert.equal(isWhole('a\uD83D'), false);
  assert.equal(isWhole('\uDE00a'), false);
  assert.equal(isWhole('a😀b'), true);
});

test('a passage is found again by its words, among places that read the same by what is around it, then by nearness', () => {
  const text = 'Yes, it is.\n\nA\n\nYes, it is.\n\nB\n\nYes, it is.\n';
  const second = anchorOf(text, 'Yes, it is.', 1);
  const found = locate(text, second);
  assert.equal(found?.start, second.start);
  // With the text around it changed (the old surroundings do not read the same anywhere), the nearest of the three wins.
  const hinted = locate(text, { quote: 'Yes, it is.', prefix: 'zzz', suffix: 'zzz', start: text.lastIndexOf('Yes') - 1 });
  assert.equal(hinted?.start, text.lastIndexOf('Yes'));
  // Its surroundings win over its nearness.
  const third = anchorOf(text, 'Yes, it is.', 2);
  assert.equal(locate(text, { ...third, start: 0 })?.start, third.start);
  // Nothing for words that are not there, or none.
  assert.equal(locate(text, { quote: 'No, it is not.' }), null);
  assert.equal(locate(text, { quote: '' }), null);
  assert.equal(locate(text, { quote: undefined } as any), null);
  // Many places are weighed, not all: a text of a single letter is no reason for the work to grow with it.
  const many = 'a'.repeat(100_000);
  assert.ok(locate(many, { quote: 'a', start: 5 }));
});

test('a passage written in another style is found by its letters and digits, with the marks left out', () => {
  const file = '# List\n\n* one **two**\n* three\n\n| a   | b |\n| --- | - |\n| x   | y |\n';
  // The editor writes - for a bullet, and not padded tables.
  const found = locate(file, { quote: 'one **two**\n- three', prefix: '# List\n\n- ', suffix: '\n\n| a | b |' });
  assert.ok(found);
  assert.equal(file.slice(found.start, found.end), 'one **two**\n* three');
  const table = locate('| alpha   | beta |\n| ------- | ---- |\n', { quote: 'alpha | beta' });
  assert.deepEqual(table && [table.start, table.end], [2, 16]);
  // Too little to tell from other text with the marks left out is not looked for so.
  assert.equal(locate(file, { quote: '* a' }), null);
  assert.deepEqual(squash('a-b, c1!'), { s: 'abc1', at: [0, 2, 5, 6], to: [1, 3, 6, 7] });
  // Letters outside the basic plane count as the one character they are.
  const astral = squash('x 𝒜y');
  assert.equal(astral.s, 'x𝒜y');
  assert.deepEqual(astral.at, [0, 2, 2, 4]);
});

test('a passage in text nothing touched keeps its words, wherever the changes before and after it are', () => {
  const green = anchorOf(PLAN, 'The build is green.');
  const cases: Record<string, string> = {
    'a paragraph before': PLAN.replace('# Plan\n', '# Plan\n\nNew first paragraph.\n'),
    'a line after': `${PLAN}Appended.\n`,
    'a word before': PLAN.replace('Friday', 'Thursday'),
    'a word after': PLAN.replace('Monday', 'Tuesday'),
    'the first line': PLAN.replace('# Plan', '# The release plan'),
    'before and after': `Intro.\n\n${PLAN}Outro.\n`,
    'blank lines': PLAN.replace(/\n\n/g, '\n\n\n'),
  };
  for (const [name, after] of Object.entries(cases)) {
    const [kept] = carry(PLAN, after, [green]) as Range[];
    assert.ok(kept, name);
    assert.equal(after.slice(kept.start, kept.end), 'The build is green.', name);
  }
});

test('a passage that is edited is the text that replaced it: a word for a word, a rewrite for a passage, text added inside it', () => {
  assert.deepEqual(words(PLAN, PLAN.replace('on Friday', 'by Monday'), anchorOf(PLAN, 'Friday')), ['Monday']);
  assert.deepEqual(words(PLAN, PLAN.replace('on Friday', 'by Monday morning'), anchorOf(PLAN, 'Friday')), ['Monday morning']);
  assert.deepEqual(words(PLAN, PLAN.replace('green', 'red and green'), anchorOf(PLAN, 'The build is green.')), ['The build is red and green.']);
  // A sentence of a paragraph rewritten; a whole paragraph rewritten with some of its words; and with none, which is the paragraph gone.
  const paragraph = 'Ship it on Friday. The build is green. Sign-off is on Monday.\n';
  assert.deepEqual(words(paragraph, paragraph.replace('The build is green.', 'Everything passes.'), anchorOf(paragraph, 'The build is green.')), ['Everything passes.']);
  assert.deepEqual(words(PLAN, PLAN.replace('The build is green.', 'The whole build is now green and fast.'), anchorOf(PLAN, 'The build is green.')), ['The whole build is now green and fast.']);
  assert.deepEqual(carry(PLAN, PLAN.replace('The build is green.', 'Everything passes.'), [anchorOf(PLAN, 'The build is green.')]), [null]);
  // A passage of several lines, one of them changed.
  const list = '- one\n- two\n- three\n';
  assert.deepEqual(words(list, list.replace('two', 'second'), anchorOf(list, 'one\n- two\n- three')), ['one\n- second\n- three']);
  // The passage's words are in the document twice and one is edited: it is the one that was edited that the passage follows, not the other.
  const twice = 'The build is green. Ship it.\n\nThe build is green.\n';
  assert.deepEqual(carry(twice, twice.replace(/\n\nThe build is green\./, '\n\nThe build is red and green.'), [anchorOf(twice, 'The build is green.', 1)]).map((r) => r && r.start), [twice.replace(/\n\nThe build is green\./, '\n\nThe build is red and green.').lastIndexOf('The build is red and green.')]);
  // Part of a passage deleted: what is left of it.
  assert.deepEqual(words(PLAN, PLAN.replace('The build is ', ''), anchorOf(PLAN, 'The build is green.')), ['green.']);
  // A passage whose words are cut in two by a new paragraph keeps both halves.
  assert.deepEqual(words(PLAN, PLAN.replace('The build is green.', 'The build\n\nA new paragraph.\n\nis green.'), anchorOf(PLAN, 'The build is green.')), ['The build\n\nA new paragraph.\n\nis green.']);
});

test('text put in at the edge of a passage is not in it, and one put in before and after it neither', () => {
  const text = 'alpha beta gamma\n';
  assert.deepEqual(words(text, 'alpha, new beta, newer gamma\n', anchorOf(text, 'beta')), ['beta']);
  // Glued to a word, it makes another word of it: the words the passage had are still there, and are the passage.
  assert.deepEqual(words(text, 'alpha NEWbeta gamma\n', anchorOf(text, 'beta')), ['beta']);
  assert.deepEqual(words(text, 'alpha beta gamma more\n', anchorOf(text, 'gamma')), ['gamma']);
  // A sentence added after one: the full stop it ends in can be taken as the old one or the new one, and is the old one.
  const sentence = 'The build is green.\n';
  assert.deepEqual(words(sentence, 'The build is green. More.\n', anchorOf(sentence, 'The build is green.')), ['The build is green.']);
  assert.deepEqual(words(sentence, 'The build is green. More words follow here.\n', anchorOf(sentence, 'The build is green.')), ['The build is green.']);
  // The same with a word put in the middle of it in the same change (the changes can be told so that the full stop is the new one).
  assert.deepEqual(words(sentence, 'The build is really green. More.\n', anchorOf(sentence, 'The build is green.')), ['The build is really green.']);
  assert.deepEqual(words(sentence, 'The build is really green.\u00a0More.\n', anchorOf(sentence, 'The build is green.')), ['The build is really green.']);
});

test('what was changed right before a passage is not in it, and nothing of a passage that was cut out of the middle of a longer change is guessed at', () => {
  // The change ends where the passage starts: the mark put in its place is before the passage.
  assert.deepEqual(words('foo,bar baz\n', 'foo;bar baz\n', anchorOf('foo,bar baz\n', 'bar')), ['bar']);
  assert.deepEqual(words('foo,bar baz\n', 'foo,bar;baz\n', anchorOf('foo,bar baz\n', 'bar')), ['bar']);
  // A passage in a line of which a longer stretch than the passage was replaced, and nothing of it is left, is not what stands there now.
  const line = 'Alpha beta gamma delta epsilon zeta eta.\n';
  assert.deepEqual(carry(line, 'Alpha beta KAPPA eta.\n', [anchorOf(line, 'delta epsilon')]), [null]);
  // The same with the stretch inside the passage: the passage is what replaced it.
  assert.deepEqual(words(line, 'Alpha beta KAPPA LAMBDA MU zeta eta.\n', anchorOf(line, 'gamma delta epsilon')), ['KAPPA LAMBDA MU']);
  // A paragraph of the same words by chance, and the lines lined up so that it is taken for the paragraph that moved into its place.
  const before = 'eta beta delta.\n\ngamma zeta eps eta eta.\n\ngamma delta alpha.\n';
  const after = 'eta beta delta.\n\nbeta eta eta beta. theta alpha.\n\ndelta zeta delta eta. gamma alpha.\n\ngamma delta alpha.\n';
  assert.deepEqual(carry(before, after, [anchorOf(before, 'gamma zeta eps eta eta.')]), [null]);
  // A passage that grows past what a passage can be by what is put into it is gone: here 100 lines, every other one made much longer.
  const lines = Array.from({ length: 100 }, (_, i) => `line number ${String(i).padStart(2, '0')} is ok${' filler'.repeat(12)}`);
  const long = `${lines.join('\n')}\n`;
  const [whole, grown] = [anchorOf(long, long.trim()), (extra: string) => `${lines.map((l, i) => (i % 2 ? l : `${l}${extra}`)).join('\n')}\n`];
  assert.deepEqual(carry(long, grown(' lorem'.repeat(50)), [whole]), [null]);
  const smaller = carry(long, grown(' lorem'.repeat(5)), [whole])[0] as Range;
  assert.ok(smaller);
  assert.equal(smaller.end - smaller.start, grown(' lorem'.repeat(5)).trim().length);
});

test('a passage that is deleted is gone, and one that is moved is found by its words where they are one place only', () => {
  const green = anchorOf(PLAN, 'The build is green.');
  assert.deepEqual(carry(PLAN, PLAN.replace('The build is green.\n\n', ''), [green]), [null]);
  const moved = '# Plan\n\nThe build is green.\n\nShip it on Friday.\n\nSign-off is on Monday.\n';
  assert.deepEqual(words(PLAN, moved, green), ['The build is green.']);
  // Words that read the same in two places are not told apart by the text around them if that is gone: the deleted one is gone.
  const twice = 'Yes.\n\nOne.\n\nYes.\n\nTwo.\n';
  const afterFirst = 'One.\n\nYes.\n\nTwo.\n';
  assert.deepEqual(carry(twice, afterFirst, [anchorOf(twice, 'Yes.', 0)]), [null]);
  assert.deepEqual(words(twice, afterFirst, anchorOf(twice, 'Yes.', 1)), ['Yes.']);
  // Their surroundings, when they are still there, are enough.
  const rest = 'Intro.\n\nOne.\n\nYes.\n\nTwo.\n';
  assert.deepEqual(words(twice, rest, anchorOf(twice, 'Yes.', 1)), ['Yes.']);
});

test('a walk by lines that pairs a passage\'s line with another one does not drag the passage along: it keeps its words where they are, or is gone', () => {
  // The lines can be lined up in more than one way, as when a paragraph is added before it and the one after is deleted:
  // the line the passage is in may then be taken as replaced by the new paragraph, and that is not what became of it.
  const before = 'One.\n\nTwo.\n\nThe build is green today.\n\nFour.\n\nFive.\n';
  const after = 'One.\n\nTwo.\n\nAdded paragraph about nothing.\n\nThe build is green today.\n\nFive.\n';
  assert.deepEqual(words(before, after, anchorOf(before, 'green today')), ['green today']);
  // The same with a paragraph added above, the paragraph above the passage's changed, and the passage's own rewritten: the lines can be
  // lined up so that the passage's line is the one that became three lines, and the passage is not all of them.
  const plan = '# The plan\n\nShip it on Friday.\n\nThe build is green.\n\nSign-off is on Monday.\n';
  const now = '# The plan\n\nA new first paragraph.\n\nShip it on Friday. Early.\n\nEverything passes now. More.\n\nSign-off is on Monday.\n';
  assert.deepEqual(carry(plan, now, [anchorOf(plan, 'The build is green.')]), [null]);
  // A paragraph deleted, with the one under it changed: the passage is not on what moved up into its place.
  const gone = 'Alpha one.\n\nBeta two three four.\n\nGamma five.\n';
  assert.deepEqual(carry(gone, 'Alpha one.\n\nGamma five more.\n', [anchorOf(gone, 'two three four')]), [null]);
});

test('a passage that has no place is looked for by its words alone, and found when they are one place only', () => {
  const orphan: Anchor = { ...anchorOf(PLAN, 'The build is green.'), start: null, end: null };
  assert.deepEqual(words(PLAN, PLAN, orphan), ['The build is green.']);
  assert.deepEqual(words(PLAN, 'Nothing here.\n', orphan), [null]);
  // A passage with a place that is not in the text (a stale one): its words are looked for all the same.
  const stale: Anchor = { ...anchorOf(PLAN, 'The build is green.'), start: 900, end: 919 };
  assert.deepEqual(words(PLAN, PLAN, stale), ['The build is green.']);
});

test('a text that is rewritten past what can be followed leaves a passage whose words are there where they were, and no other', () => {
  const lines = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `${tag} line ${i} of the document, with some words in it.`).join('\n') + '\n';
  const before = `${lines(2500, 'old')}Keep this exact passage.\n${lines(10, 'old')}`;
  const after = `${lines(2500, 'new')}Keep this exact passage.\n${lines(10, 'new')}`;
  const kept = anchorOf(before, 'Keep this exact passage.');
  assert.deepEqual(words(before, after, kept), ['Keep this exact passage.']);
  // An edit of the passage in such a text cannot be followed: its words are not there, and the passage is gone, not guessed at.
  assert.deepEqual(words(before, after.replace('exact', 'inexact'), kept), [null]);
});

test('a passage is never a stretch that cuts a character outside the basic plane in two', () => {
  const text = 'a 😀 b\n';
  const emoji = anchorOf(text, '😀');
  assert.deepEqual(words(text, 'a 😁 b\n', emoji), ['😁']);
  for (const after of ['a 😀😀 b\n', 'a b\n', 'a 😁 b\n']) {
    for (const r of carry(text, after, [emoji]) as Range[]) if (r) assert.ok(isWhole(after.slice(r.start, r.end)), after);
  }
});

/** A small deterministic generator: the same texts every run, so that a failure can be had again. */
function random(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

test('passages in text the changes do not touch keep their words, and the others never come out as nothing in particular', () => {
  const next = random(11);
  const vocabulary = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta', 'iota', 'kappa'];
  const sentence = () => `${Array.from({ length: 4 + Math.floor(next() * 5) }, () => vocabulary[Math.floor(next() * vocabulary.length)]).join(' ')}.`;
  for (let round = 0; round < 150; round++) {
    const paragraphs = Array.from({ length: 4 + Math.floor(next() * 6) }, () => `P${round}${Math.floor(next() * 1e6)}: ${sentence()}`);
    const before = `${paragraphs.join('\n\n')}\n`;
    const picked = paragraphs.map((p, i) => ({ i, anchor: anchorOf(before, p.slice(p.indexOf(':') + 2)) })).filter(() => next() < 0.5);
    // Change the paragraphs that no passage is in (whole ones: added, removed and rewritten), and the text between them.
    const keep = new Set(picked.map((p) => p.i));
    const out: string[] = [];
    paragraphs.forEach((p, i) => {
      if (!keep.has(i) && next() < 0.3) return;
      out.push(keep.has(i) ? p : next() < 0.4 ? `${p} ${sentence()}` : p);
      if (next() < 0.25) out.push(`Added ${sentence()}`);
    });
    const after = `${out.join('\n\n')}\n`;
    const moved = carry(before, after, picked.map((p) => p.anchor)) as Range[];
    picked.forEach((p, k) => {
      const r = moved[k];
      assert.ok(r, `round ${round}: a passage nothing touched is not lost`);
      assert.equal(after.slice(r.start, r.end), p.anchor.quote, `round ${round}`);
    });
  }
});
