/**
 * Where the passage of a comment is in a document, and where it goes when the
 * document changes: no editor, no browser and no server in it, so that what it
 * does can be tried alone (extensions/docs/test/anchor.test.mts). The server half keeps
 * a passage in step with the revisions, the page finds it in the text the
 * editor holds; both go through this one.
 *
 * A passage is a stretch of the document's Markdown: `quote` is
 * `text.slice(start, end)`, and `prefix` and `suffix` are up to CONTEXT
 * characters on either side of it, which tell it from another place that reads
 * the same. Offsets count UTF-16 units, as JavaScript strings do.
 *
 *   locate(text, anchor)         where the passage is in a text, found again by its words
 *   carry(before, after, [...])  where the passages of one text are in the text that came of it
 *
 * `carry` follows the changes between the two texts (the same walk merge.js
 * uses, lines first, and the words inside a line that changed where a
 * passage is). A passage in text nothing touched keeps its words and moves with
 * the text around it. A passage that was edited goes on being the edited text:
 * the one that replaced it is the passage now, which is how a comment stays on
 * the words the agent rewrote for it. Where that does not work (the passage was
 * deleted, or the texts are too different to follow) its words are looked for
 * in the new text, and a passage that is nowhere is gone: nothing is guessed.
 */
import { diff, linesOf } from "./merge.js";

/** How much of the text on each side of a passage is kept to tell it from another place that reads the same. */
export const CONTEXT = 32;
/** The longest passage a comment is made on. */
export const MAX_QUOTE = 5000;
/** The longest a passage can grow to by being edited, past which it is taken to be gone. */
const MAX_PASSAGE = 20000;
/** How many places that read the same are weighed against each other. */
const MOST_PLACES = 200;
/** The most characters of a changed stretch (before and after together) that are followed word by word. */
const MOST_FOLLOWED = 20000;
/** The fewest letters and digits a passage must have to be looked for with the marks left out. */
const MIN_LOOSE = 4;
/** How many letters and digits of the text around a passage a place must match, when its words do not tell it from another place. */
const MIN_CONTEXT = 8;
/** How many letters and digits the words of a passage must have for a place that reads the same, and is the only one, to be taken for it without the text around it being like the old: a sentence, not a word or a phrase. */
const LONG_QUOTE = 30;
/** How much of an edited passage's letters must still be there for it to be the same passage, unless what was replaced lay wholly inside it. */
const MIN_KEPT = 0.5;
/** How alike, by its words, the new text of a passage that was a whole paragraph must be to it. */
const MIN_ALIKE = 0.3;
/** How much of the rest of its sentence can be changed for a passage of which nothing is left to be taken for the words that replaced it. */
const MIN_AROUND = 0.5;

const WORD = /[\p{L}\p{N}]/u;
const WHITE = /\s/;
/** A blank line: where one paragraph ends and the next begins. */
const PARAGRAPHS = /\n[ \t]*\n/;

/** Is `ch` the high half of a pair of UTF-16 units, or the low half. */
const isHigh = (ch) => ch >= "\uD800" && ch <= "\uDBFF";
const isLow = (ch) => ch >= "\uDC00" && ch <= "\uDFFF";

/** Whether `text` is whole characters only: no half of a pair at either end or in the middle. */
export const isWhole = (text) => !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text);

/** `start` and `end` of a stretch of `text`, moved outward off the middle of a character outside the basic plane. */
function whole(text, start, end) {
  if (start > 0 && isLow(text[start]) && isHigh(text[start - 1])) start--;
  if (end < text.length && isHigh(text[end - 1]) && isLow(text[end])) end++;
  return { start, end };
}

/** The stretch with the white space at either end left off, or nothing when there is nothing else. */
export function trimmed(text, start, end) {
  while (start < end && WHITE.test(text[start])) start++;
  while (end > start && WHITE.test(text[end - 1])) end--;
  return end > start ? { start, end } : null;
}

/** The text just before and just after the stretch, whole characters only. */
export function around(text, start, end) {
  let from = Math.max(0, start - CONTEXT);
  let to = Math.min(text.length, end + CONTEXT);
  if (from < start && isLow(text[from])) from++;
  if (to > end && isHigh(text[to - 1])) to--;
  return { prefix: text.slice(from, start), suffix: text.slice(end, to) };
}

/** A passage of `text` as it is kept: the stretch, its words and what is around them. Nothing for a stretch that is only white space. */
export function passage(text, start, end) {
  const inner = trimmed(text, start, end);
  if (!inner) return null;
  const { start: s, end: e } = whole(text, inner.start, inner.end);
  return { start: s, end: e, quote: text.slice(s, e), ...around(text, s, e) };
}

/**
 * How many letters and digits are in the run of characters that the ends of `a` and `b` have in common: the white space and marks
 * that nearly every paragraph is set off by (a blank line, a full stop) are the same everywhere, and tell no place from another.
 */
function commonSuffix(a, b) {
  let n = 0;
  for (let i = 1; i <= a.length && i <= b.length && a[a.length - i] === b[b.length - i]; i++) if (WORD.test(a[a.length - i])) n++;
  return n;
}

/** The same for the starts of `a` and `b`. */
function commonPrefix(a, b) {
  let n = 0;
  for (let i = 0; i < a.length && i < b.length && a[i] === b[i]; i++) if (WORD.test(a[i])) n++;
  return n;
}

/**
 * `text` with only its letters and digits: what is left of a passage when the
 * marks around and in it are left out (the bullets, emphasis and padding of
 * another way of writing the same Markdown). `at[i]` and `to[i]` are where the
 * i-th unit of it starts and ends in `text`.
 */
export function squash(text) {
  let s = "";
  const at = [];
  const to = [];
  for (let i = 0; i < text.length; ) {
    const ch = String.fromCodePoint(text.codePointAt(i));
    if (WORD.test(ch)) {
      s += ch;
      for (let k = 0; k < ch.length; k++) {
        at.push(i);
        to.push(i + ch.length);
      }
    }
    i += ch.length;
  }
  return { s, at, to };
}

/** `text` with its line breaks all LF. */
const lines = (text) => text.replace(/\r\n?/g, "\n");

/** The places `needle` is in `haystack`, at most MOST_PLACES of them, overlapping ones too. */
function places(haystack, needle) {
  const found = [];
  for (let i = haystack.indexOf(needle); i !== -1 && found.length < MOST_PLACES; i = haystack.indexOf(needle, i + 1)) found.push(i);
  return found;
}

/** The best of the places, the one whose surroundings match most, then the one nearest `hint` (`where` says where in the text a place is), then the first. */
function best(candidates, score, hint, where = (at) => at) {
  let choice = null;
  for (const at of candidates) {
    const got = score(at);
    const near = hint === null ? 0 : -Math.abs(where(at) - hint);
    if (!choice || got > choice.score || (got === choice.score && near > choice.near)) choice = { at, score: got, near };
  }
  return choice;
}

/**
 * Where the passage is in `text`: `{ start, end, score }`, or nothing.
 * Its words are looked for as they were written, then without the marks
 * between them (so that a text written in another style still has it). Where
 * they read the same in several places, the place with the same words around
 * it wins, and then the one nearest `start`. `score` is how many letters and
 * digits of the text around it match. `cache` is kept by the caller for as long as `text` is
 * the same, to look for many.
 */
export function locate(text, { quote, prefix = "", suffix = "", start = null }, cache = {}) {
  if (typeof quote !== "string" || !quote) return null;
  // Where it was is a place in the text, or nothing: a number outside it would pick words by where they are not.
  const hint = Number.isInteger(start) && start >= 0 && start <= text.length ? start : null;
  const found = places(text, quote);
  // The place it was, when it still reads the same, is weighed with the others even past the limit.
  if (hint !== null && !found.includes(hint) && text.startsWith(quote, hint)) found.push(hint);
  if (found.length) {
    // The text round it is compared with its line breaks the same (a document written with CRLF and again with LF is the same text), so
    // a longer stretch of it is taken, to have as many characters as the context has.
    const [before, after] = [lines(prefix), lines(suffix)];
    const reach = (n) => 2 * n + 2;
    const choice = best(found, (at) => commonSuffix(before, lines(text.slice(Math.max(0, at - reach(prefix.length)), at))) + commonPrefix(after, lines(text.slice(at + quote.length, at + quote.length + reach(suffix.length)))), hint);
    return { start: choice.at, end: choice.at + quote.length, score: choice.score };
  }
  const wanted = squash(quote).s;
  if (wanted.length < MIN_LOOSE) return null;
  if (cache.text !== text) {
    cache.text = text;
    cache.squashed = squash(text);
  }
  const { s, at, to } = cache.squashed;
  const before = squash(prefix).s;
  const after = squash(suffix).s;
  const loose = places(s, wanted);
  if (!loose.length) return null;
  const choice = best(loose, (k) => commonSuffix(before, s.slice(Math.max(0, k - before.length), k)) + commonPrefix(after, s.slice(k + wanted.length, k + wanted.length + after.length)), hint, (k) => at[k]);
  const range = whole(text, at[choice.at], to[choice.at + wanted.length - 1]);
  return { ...range, score: choice.score };
}

/**
 * The changes from `before` to `after` by lines, as hunks `[b0, b1, a0, a1]` of
 * characters: `before.slice(b0, b1)` is `after.slice(a0, a1)` in its place.
 */
function lineHunks(before, after) {
  const a = linesOf(before);
  const b = linesOf(after);
  const ids = new Map();
  const numbered = (lines) => lines.map((line) => ids.get(line) ?? (ids.set(line, ids.size), ids.size - 1));
  const offsets = (lines) => lines.reduce((starts, line) => (starts.push(starts[starts.length - 1] + line.length), starts), [0]);
  const [fa, fb] = [offsets(a), offsets(b)];
  return diff(numbered(a), numbered(b)).map(([a0, a1, b0, b1]) => [fa[a0], fa[a1], fb[b0], fb[b1]]);
}

/** A text as its words, its runs of white space and each mark on its own: what a change is followed by, so that a word replaced is one change. */
const tokens = (text) => text.match(/[\p{L}\p{N}_]+|\s+|[^]/gu) ?? [];

/**
 * The pure insertions and deletions among `hunks` (of the lists `x` and `y`) moved as far right as they go while the
 * lists stay the same: where the same words can be put in or taken out at more than one place (a `.` that is put in
 * after another `.` or before it), they are at the last, which is where a person who types at the end of a sentence has put them.
 */
function slid(hunks, x, y) {
  return hunks.map(([i0, i1, j0, j1], k) => {
    const limit = hunks[k + 1]?.[0] ?? Infinity;
    // The item after the change is the first of it: so the change is the same one place on, and not touching the next.
    const room = () => (i0 === i1 ? i0 + 1 < limit && i0 < x.length && j1 < y.length : i1 + 1 < limit && i1 < x.length && j0 < y.length);
    while ((i0 === i1 || j0 === j1) && room() && x[i0] === y[j0]) {
      i0++;
      i1++;
      j0++;
      j1++;
    }
    return [i0, i1, j0, j1];
  });
}

/** A hunk made finer: the words inside it that differ, as hunks of the whole texts. Nothing where it is too big to follow. */
function finer(before, after, [b0, b1, a0, a1]) {
  if (b1 - b0 + (a1 - a0) > MOST_FOLLOWED) return null;
  const [x, y] = [tokens(before.slice(b0, b1)), tokens(after.slice(a0, a1))];
  const offsets = (list) => list.reduce((at, token) => (at.push(at[at.length - 1] + token.length), at), [0]);
  const [ox, oy] = [offsets(x), offsets(y)];
  return slid(diff(x, y), x, y).map(([i0, i1, j0, j1]) => [b0 + ox[i0], b0 + ox[i1], a0 + oy[j0], a0 + oy[j1]]);
}

/**
 * Where the point `p` of the old text is in the new one, through `hunks`. A
 * passage's start is put before what replaced the text it starts in, and its
 * end after it, so that a passage that was rewritten is the rewrite; text put
 * in at its edge is not in it.
 */
function through(hunks, p, side) {
  let shift = 0;
  for (const [b0, b1, a0, a1] of hunks) {
    if (p < b0) break;
    if (p > b1) {
      shift += a1 - a0 - (b1 - b0);
      continue;
    }
    if (side === "start") return p < b1 ? a0 : a1;
    return p > b0 ? a1 : a0;
  }
  return p + shift;
}

/** How many letters and digits `text` has. */
const letters = (text) => (text.match(/[\p{L}\p{N}]/gu) ?? []).length;

/** A text as its words, lower case. */
const wordsOf = (text) => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

/** How alike two texts are by the words they are made of, from 0 to 1 (twice the words they share over all their words). */
function alike(a, b) {
  const [x, y] = [wordsOf(a), wordsOf(b)];
  if (!x.length || !y.length) return 0;
  const counts = new Map();
  for (const word of x) counts.set(word, (counts.get(word) ?? 0) + 1);
  let shared = 0;
  for (const word of y) {
    if (counts.get(word) > 0) {
      counts.set(word, counts.get(word) - 1);
      shared++;
    }
  }
  return (2 * shared) / (x.length + y.length);
}

/** The sentence `[start, end)` of `text` is in, within the line `[lineStart, lineEnd)`: as far as the full stops (and question and exclamation marks) go. */
function sentence(text, start, end, lineStart, lineEnd) {
  let from = lineStart;
  for (const m of text.slice(lineStart, start).matchAll(/[.!?]\s+/g)) from = lineStart + m.index + m[0].length;
  const stop = /[.!?](?=\s|$)/.exec(text.slice(end, lineEnd));
  const to = /[.!?]$/.test(text.slice(start, end)) ? end : stop ? end + stop.index + 1 : lineEnd;
  return [Math.min(from, start), Math.max(to, end)];
}

/**
 * Whether the passage `[start, end)` of `before`, which reads `now` in the new text, was edited, as opposed to taken
 * out and something else put in the place of the line it was in (which is all a walk by lines can say of a deleted
 * paragraph that its neighbour moved up into): most of its letters are still there, or what was replaced lay wholly
 * inside it (a word for a word, a sentence in a paragraph rewritten). A passage that is a whole paragraph and is
 * replaced by words that have next to nothing in common with it is gone: there is nothing to tell the rewrite of it
 * from the deletion of it and the writing of another.
 */
function edited(before, steps, start, end, now) {
  let changed = 0;
  let inside = true;
  for (const [b0, b1] of steps) {
    if (b1 <= start || b0 >= end) continue;
    changed += letters(before.slice(Math.max(b0, start), Math.min(b1, end)));
    const replaced = trimmed(before, b0, b1);
    if (replaced && (replaced.start < start || replaced.end > end)) inside = false;
  }
  const total = letters(before.slice(start, end));
  const lineStart = before.lastIndexOf("\n", start - 1) + 1;
  const lineEnd = before.indexOf("\n", end) < 0 ? before.length : before.indexOf("\n", end);
  const paragraph = !before.slice(lineStart, start).trim() && !before.slice(end, lineEnd).trim();
  if (paragraph && changed > 0 && alike(before.slice(start, end), now) < MIN_ALIKE) return false;
  // A passage that nothing of is left is the new words only where the rest of its sentence is mostly still there: where the whole
  // sentence was written again, a word of it paired with a word of the new one by the walk is no more than a pairing.
  if (total > 0 && (total - changed) / total < MIN_KEPT) {
    const [from, to] = sentence(before, start, end, lineStart, lineEnd);
    const rest = letters(before.slice(from, start)) + letters(before.slice(end, to));
    let gone = 0;
    for (const [b0, b1] of steps) {
      const [lo, hi] = [Math.max(b0, from), Math.min(b1, to)];
      if (hi > lo) gone += letters(before.slice(lo, Math.min(hi, start))) + letters(before.slice(Math.max(lo, end), hi));
    }
    if (rest > 0 && gone / rest >= MIN_AROUND) return false;
  }
  return inside || total === 0 || (total - changed) / total >= MIN_KEPT;
}

/** Whether `anchor` has a stretch of `text` to follow. */
const placed = (anchor, length) => Number.isInteger(anchor.start) && Number.isInteger(anchor.end) && anchor.start >= 0 && anchor.end > anchor.start && anchor.end <= length;

/**
 * Where each of `anchors` (`{ start, end, quote, prefix, suffix }`, in `before`)
 * is in `after`: `{ start, end }` in the same order, or nothing for a passage
 * that is gone. A passage that has no place in `before` (it was gone already)
 * is looked for by its words. See the top of this file.
 */
export function carry(before, after, anchors) {
  const cache = {};
  const looked = (anchor, hint, lost = false, around = null) => {
    const found = locate(after, { ...anchor, start: hint }, cache);
    if (!found) return null;
    if (found.score < MIN_CONTEXT) {
      // Words that read the same in several places, or are a short phrase, are not told from other words by the text round them unless
      // it is like the old: else a passage deleted, and the same words written in a later change (and any number of changes are
      // one step here, when the threads were not looked at between), would be taken for a passage that moved. A long passage that
      // is in one place only is that passage wherever it stands. A passage with no place to have moved from is looked for in the new text only.
      // Words that stand within what the passage became (the walk put it there, and the words are still in it) are where it is.
      const there = around && found.start >= around.start && found.end <= around.end;
      if (!there && (letters(anchor.quote) < LONG_QUOTE || places(lost ? after : before, anchor.quote).length !== 1)) return null;
    }
    return trimmed(after, found.start, found.end);
  };
  const hunks = before === after ? [] : lineHunks(before, after);
  // A hunk made finer once, for whichever passages are in it.
  const fine = new Map();
  const followed = (hunk) => {
    if (!fine.has(hunk)) fine.set(hunk, finer(before, after, hunk));
    return fine.get(hunk);
  };
  return anchors.map((anchor) => {
    if (!placed(anchor, before.length)) return looked(anchor, null, true);
    const { start, end } = anchor;
    // A change the passage is in or at the edge of is followed word by word: only those can change where it is.
    const steps = [];
    let followable = true;
    for (const hunk of hunks) {
      if (hunk[0] <= end && hunk[1] >= start) {
        const sub = followed(hunk);
        if (sub === null) followable = false;
        else steps.push(...sub);
      } else steps.push(hunk);
    }
    let moved = null;
    let hint = start;
    let range = null;
    if (followable) {
      const s = through(steps, start, "start");
      const e = through(steps, end, "end");
      hint = s;
      range = e > s && e - s <= MAX_PASSAGE ? trimmed(after, s, e) : null;
      if (range) {
        const text = after.slice(range.start, range.end);
        // Where nothing touched it, it reads the same. One that was edited is the edit, unless its words are still as many in the text
        // as they were (then the walk paired it with the wrong line, and they are the words that moved) or what stands there is not an
        // edit of it. One that was replaced at its edge by what has become several paragraphs is the lines around it that moved up, not
        // the same words rewritten.
        const stretched = PARAGRAPHS.test(text) && !PARAGRAPHS.test(before.slice(start, end)) && steps.some(([b0, b1]) => b1 > b0 && ((b0 <= start && start < b1) || (b0 < end && end <= b1)));
        if (text === anchor.quote || (places(after, anchor.quote).length < places(before, anchor.quote).length && edited(before, steps, start, end, text) && !stretched)) moved = whole(after, range.start, range.end);
      }
    }
    return moved ?? looked(anchor, hint, false, range);
  });
}
