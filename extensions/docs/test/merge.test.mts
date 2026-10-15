import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diff, merge3 } from '../web/merge.js';

/**
 * Putting two changes to one text together (extensions/docs/web/merge.js), with no editor, no server and no clock.
 */

type Hunk = [number, number, number, number];

/** `a` with the hunks made: it must be `b`. */
function made(a: string[], b: string[], hunks: Hunk[]) {
  const out: string[] = [];
  let at = 0;
  for (const [a0, a1, b0, b1] of hunks) {
    for (const item of [...a.slice(at, a0), ...b.slice(b0, b1)]) out.push(item);
    at = a1;
  }
  for (const item of a.slice(at)) out.push(item);
  return out;
}

/** The length of the longest common subsequence: what a shortest list of changes is measured against. */
function lcs(a: string[], b: string[]) {
  const row = new Array(b.length + 1).fill(0);
  for (const x of a) {
    let diagonal = 0;
    for (let j = 1; j <= b.length; j++) {
      const above = row[j];
      row[j] = x === b[j - 1] ? diagonal + 1 : Math.max(row[j], row[j - 1]);
      diagonal = above;
    }
  }
  return row[b.length];
}

/** A small deterministic generator: the same lists every run, so that a failure can be had again. */
function random(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

test('the changes that make one list of another are those, in order, none touching, and as few as can be', () => {
  const next = random(7);
  for (let round = 0; round < 600; round++) {
    const alphabet = 'abcdefg'.slice(0, 2 + Math.floor(next() * 5));
    const list = (n: number) => Array.from({ length: n }, () => alphabet[Math.floor(next() * alphabet.length)]);
    const a = list(Math.floor(next() * 14));
    const b = list(Math.floor(next() * 14));
    const hunks = diff(a, b) as Hunk[];
    assert.deepEqual(made(a, b, hunks), b, `${a.join('')} to ${b.join('')}`);
    // In order, and each with something changed, and a kept item between any two.
    for (const [i, [a0, a1, b0, b1]] of hunks.entries()) {
      assert.ok(a1 > a0 || b1 > b0, 'an empty change');
      if (i) assert.ok(a0 > hunks[i - 1][1] && b0 > hunks[i - 1][3], 'two changes that touch');
    }
    const deleted = hunks.reduce((n, h) => n + h[1] - h[0], 0);
    const inserted = hunks.reduce((n, h) => n + h[3] - h[2], 0);
    assert.equal(deleted, a.length - lcs(a, b), `${a.join('')} to ${b.join('')}: more deleted than needed`);
    assert.equal(inserted, b.length - lcs(a, b), `${a.join('')} to ${b.join('')}: more inserted than needed`);
  }
});

test('equal lists have no change, and a list and an empty one are each other\'s one change', () => {
  assert.deepEqual(diff([], []), []);
  assert.deepEqual(diff(['a', 'b'], ['a', 'b']), []);
  assert.deepEqual(diff([], ['a', 'b']), [[0, 0, 0, 2]]);
  assert.deepEqual(diff(['a', 'b'], []), [[0, 2, 0, 0]]);
});

test('two lists further apart than the walk follows are one change, which is still right', () => {
  const a = Array.from({ length: 2000 }, (_, i) => `a${i}`);
  const b = Array.from({ length: 2000 }, (_, i) => `b${i}`);
  assert.deepEqual(diff(a, b), [[0, 2000, 0, 2000]]);
  // With the same ends kept, the middle is the one change.
  assert.deepEqual(diff(['x', ...a, 'y'], ['x', ...b, 'y']), [[1, 2001, 1, 2001]]);
});

test('a long text with a few changes is diffed at once', () => {
  const lines = Array.from({ length: 200_000 }, (_, i) => `line ${i}`);
  const changed = [...lines];
  changed[100] = 'changed';
  changed.splice(150_000, 1);
  changed.splice(199_000, 0, 'added');
  const began = Date.now();
  const hunks = diff(lines, changed) as Hunk[];
  assert.deepEqual(made(lines, changed, hunks), changed);
  assert.equal(hunks.length, 3);
  assert.ok(Date.now() - began < 10_000, 'took too long');
});

const BASE = 'One.\n\nTwo.\n\nThree.\n\nFour.\n';

test('changes to lines apart are both made, whichever side made which', () => {
  const mine = 'One, said me.\n\nTwo.\n\nThree.\n\nFour.\n';
  const theirs = 'One.\n\nTwo.\n\nThree.\n\nFour, said them.\n';
  const both = 'One, said me.\n\nTwo.\n\nThree.\n\nFour, said them.\n';
  assert.equal(merge3(BASE, mine, theirs), both);
  assert.equal(merge3(BASE, theirs, mine), both);
});

test('lines added, removed and changed on both sides come together, in their places', () => {
  const mine = 'One.\n\nA new one.\n\nTwo.\n\nThree.\n\nFour.\n';
  const theirs = 'One.\n\nTwo.\n\nFour.\n';
  assert.equal(merge3(BASE, mine, theirs), 'One.\n\nA new one.\n\nTwo.\n\nFour.\n');
  assert.equal(merge3(BASE, theirs, mine), 'One.\n\nA new one.\n\nTwo.\n\nFour.\n');
});

test('a change to the same line is no merge, and so is one to the line next to it', () => {
  assert.equal(merge3(BASE, 'One, said me.\n\nTwo.\n\nThree.\n\nFour.\n', 'One, said them.\n\nTwo.\n\nThree.\n\nFour.\n'), null);
  // Lines that follow each other (a list has no blank line between its items) are one change made twice.
  const list = '- a\n- b\n- c\n';
  assert.equal(merge3(list, '- A\n- b\n- c\n', '- a\n- B\n- c\n'), null);
  assert.equal(merge3(list, '- A\n- b\n- c\n', '- a\n- b\n- C\n'), '- A\n- b\n- C\n');
  // Two texts added at one place, and one added where another was removed.
  assert.equal(merge3(BASE, 'One.\n\nX.\n\nTwo.\n\nThree.\n\nFour.\n', 'One.\n\nY.\n\nTwo.\n\nThree.\n\nFour.\n'), null);
  assert.equal(merge3('a\nb\nc\n', 'a\nX\nb\nc\n', 'a\nc\n'), null);
});

test('a change both made is made once, also next to one only one made', () => {
  const same = 'One.\n\nTwo, together.\n\nThree.\n\nFour.\n';
  assert.equal(merge3(BASE, same, same), same);
  assert.equal(merge3(BASE, same, 'One.\n\nTwo, together.\n\nThree.\n\nFour, said them.\n'), 'One.\n\nTwo, together.\n\nThree.\n\nFour, said them.\n');
  // A line removed on both sides: removed.
  assert.equal(merge3('a\nb\nc\n', 'a\nc\n', 'a\nc\n'), 'a\nc\n');
});

test('a side that changed nothing is the other side, and a text with no break at its end is kept so', () => {
  assert.equal(merge3(BASE, BASE, 'Other.\n'), 'Other.\n');
  assert.equal(merge3(BASE, 'Other.\n', BASE), 'Other.\n');
  assert.equal(merge3('a\nb\n', 'a\nb\nc', 'A\nb\n'), 'A\nb\nc');
  assert.equal(merge3('a\n\nb', 'a\n\nB', 'A\n\nb'), 'A\n\nB');
  // The last line with and without its break are not the same line: a change to one is a change to the other.
  assert.equal(merge3('a\nb', 'a\nb\nc', 'A\nb'), null);
  assert.equal(merge3('a\nb', 'a\nb\n', 'a\nB'), null);
  assert.equal(merge3('', 'new\n', ''), 'new\n');
  assert.equal(merge3('', 'a\n', 'b\n'), null);
});

test('line breaks are part of a line: a text with Windows line breaks is merged as it is', () => {
  const base = 'One.\r\n\r\nTwo.\r\n\r\nThree.\r\n';
  assert.equal(merge3(base, 'One!\r\n\r\nTwo.\r\n\r\nThree.\r\n', 'One.\r\n\r\nTwo.\r\n\r\nThree!\r\n'), 'One!\r\n\r\nTwo.\r\n\r\nThree!\r\n');
  // One side changed all the breaks: every line is changed, and a change of the other's is among them.
  assert.equal(merge3(base, base.replace(/\r\n/g, '\n'), 'One.\r\n\r\nTwo!\r\n\r\nThree.\r\n'), null);
});

test('whatever is merged has what each side changed, and merging either way round is the same', () => {
  const next = random(11);
  for (let round = 0; round < 400; round++) {
    // A base of paragraphs, and each side changes some of them: never two that follow each other, so that nothing is in doubt.
    const base = Array.from({ length: 12 }, (_, i) => `Paragraph ${i}.\n`);
    const text = (paragraphs: string[]) => paragraphs.join('\n');
    const take = () => new Set(Array.from({ length: 12 }, (_, i) => i).filter(() => next() < 0.2));
    const mine = take();
    const theirs = take();
    const expected = [...base];
    const side = (taken: Set<number>, who: string) => base.map((p, i) => (taken.has(i) ? `Paragraph ${i}, ${who}.\n` : p));
    const ours = side(mine, 'mine');
    const others = side(theirs, 'theirs');
    for (let i = 0; i < 12; i++) expected[i] = mine.has(i) ? ours[i] : others[i];
    const clash = [...mine].some((i) => theirs.has(i));
    const merged = merge3(text(base), text(ours), text(others));
    // Paragraphs are apart by a blank line, so only the same paragraph changed twice is in doubt.
    if (clash) assert.equal(merged, null);
    else assert.equal(merged, text(expected));
    assert.equal(merge3(text(base), text(others), text(ours)), merged);
  }
});

test('a text of many lines is merged at once', () => {
  const base = Array.from({ length: 100_000 }, (_, i) => `Line ${i}.\n`).join('');
  const lines = base.split('\n');
  const mine = [...lines];
  mine[10] = 'Mine.';
  const theirs = [...lines];
  theirs[90_000] = 'Theirs.';
  const began = Date.now();
  const merged = merge3(base, mine.join('\n'), theirs.join('\n'));
  assert.ok(merged?.includes('Mine.') && merged.includes('Theirs.'));
  assert.equal(merged?.split('\n').length, lines.length);
  assert.ok(Date.now() - began < 10_000, 'took too long');
});
