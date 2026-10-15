/**
 * Putting two changes to one text together, by lines: no editor, no browser and
 * no server in it. The page uses it to take the agent's change into the text
 * that is open, and the server half to save a text that started from an earlier
 * revision; both go through this one, so what one can merge the other can.
 *
 * `merge3(base, mine, theirs)` is the text that has the changes of `mine` and of
 * `theirs` to `base`, or `null` when they cannot both be made: two changes that
 * touch the same line, or lines that follow each other, are one change made twice
 * differently. A change both made in the same way is made once. Nothing is
 * guessed: where there is a doubt there is no merge, and the caller keeps
 * both texts for the person to choose.
 *
 * `diff` is the same walk on any two lists, for the editor to find what of its
 * blocks changed.
 */

/** How many changed items `diff` follows before it gives up and calls all of what is left one change. It keeps the work, and its memory, bounded. */
const MOST_CHANGES = 1500;

/**
 * The changes that make `b` of `a`, as hunks `[a0, a1, b0, b1]`: the items
 * `a[a0..a1)` are `b[b0..b1)` in its place. Items are compared with `===`. A
 * shortest list of changes (Myers' algorithm), in order, and none that touch.
 */
export function diff(a, b) {
  let start = 0;
  const most = Math.min(a.length, b.length);
  while (start < most && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  if (start === endA && start === endB) return [];
  const gone = new Uint8Array(endA - start);
  const added = new Uint8Array(endB - start);
  if (!changes(a, b, start, endA, endB, gone, added)) return [[start, endA, start, endB]];
  const hunks = [];
  let i = 0;
  let j = 0;
  while (i < gone.length || j < added.length) {
    if (i < gone.length && j < added.length && !gone[i] && !added[j]) {
      i++;
      j++;
      continue;
    }
    const from = [i, j];
    while (i < gone.length && gone[i]) i++;
    while (j < added.length && added[j]) j++;
    // Items that are neither changed nor in a pair cannot be: it would be a walk that goes nowhere.
    if (i === from[0] && j === from[1]) throw new Error("The two lists could not be lined up");
    hunks.push([start + from[0], start + i, start + from[1], start + j]);
  }
  return hunks;
}

/**
 * Marks what `a[start..endA)` has that `b[start..endB)` has not in `gone`, and
 * what `b` has that `a` has not in `added` (both from `start`). False when the
 * two are further apart than MOST_CHANGES.
 */
function changes(a, b, start, endA, endB, gone, added) {
  const n = endA - start;
  const m = endB - start;
  const max = Math.min(n + m, MOST_CHANGES);
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  // What `v` held when each round began, the part of it that round can reach.
  const trace = [];
  let last = -1;
  for (let d = 0; d <= max && last < 0; d++) {
    trace.push(v.slice(offset - d, offset + d + 1));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[start + x] === b[start + y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        last = d;
        break;
      }
    }
  }
  if (last < 0) return false;
  let x = n;
  let y = m;
  for (let d = last; d > 0; d--) {
    const before = trace[d];
    const k = x - y;
    // The round's path came from the diagonal above (an insertion) or the one below (a deletion).
    const down = k === -d || (k !== d && before[k - 1 + d] < before[k + 1 + d]);
    const prevK = down ? k + 1 : k - 1;
    const prevX = before[prevK + d];
    const prevY = prevX - prevK;
    if (down) added[prevY] = 1;
    else gone[prevX] = 1;
    x = prevX;
    y = prevY;
  }
  return true;
}

/** A text as its lines, each with its line break: the last one has none when the text does not end in one. */
export const linesOf = (text) => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];

/** `lines` replaced by each hunk's own, from `from` to `to` of the base: what that stretch of the base is on one side. */
function region(base, hunks, side, from, to) {
  const out = [];
  let at = from;
  for (const [a0, a1, b0, b1] of hunks) {
    for (let i = at; i < a0; i++) out.push(base[i]);
    for (let i = b0; i < b1; i++) out.push(side[i]);
    at = a1;
  }
  for (let i = at; i < to; i++) out.push(base[i]);
  return out;
}

const sameLines = (a, b) => a.length === b.length && a.every((line, i) => line === b[i]);

export function merge3(base, mine, theirs) {
  if (mine === theirs) return mine;
  if (base === mine) return theirs;
  if (base === theirs) return mine;
  const baseLines = linesOf(base);
  const mineLines = linesOf(mine);
  const theirLines = linesOf(theirs);
  // Lines as numbers: comparing them is the cost of the walk.
  const ids = new Map();
  const numbered = (lines) => lines.map((line) => ids.get(line) ?? (ids.set(line, ids.size), ids.size - 1));
  const keys = numbered(baseLines);
  const ours = diff(keys, numbered(mineLines));
  const others = diff(keys, numbered(theirLines));
  const out = [];
  let at = 0;
  let i = 0;
  let j = 0;
  while (i < ours.length || j < others.length) {
    const from = Math.min(ours[i]?.[0] ?? Infinity, others[j]?.[0] ?? Infinity);
    // The changes that touch each other, whoever made them: one stretch of the base.
    let to = from;
    const mineHere = [];
    const theirsHere = [];
    for (;;) {
      if (i < ours.length && ours[i][0] <= to) {
        to = Math.max(to, ours[i][1]);
        mineHere.push(ours[i++]);
      } else if (j < others.length && others[j][0] <= to) {
        to = Math.max(to, others[j][1]);
        theirsHere.push(others[j++]);
      } else break;
    }
    for (let line = at; line < from; line++) out.push(baseLines[line]);
    const mineText = mineHere.length ? region(baseLines, mineHere, mineLines, from, to) : null;
    const theirText = theirsHere.length ? region(baseLines, theirsHere, theirLines, from, to) : null;
    if (mineText && theirText && !sameLines(mineText, theirText)) return null;
    // A loop, not a spread: a stretch can be the whole text.
    for (const line of mineText ?? theirText) out.push(line);
    at = to;
  }
  for (let line = at; line < baseLines.length; line++) out.push(baseLines[line]);
  return out.join("");
}
