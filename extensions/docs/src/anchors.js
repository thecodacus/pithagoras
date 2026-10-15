/**
 * Where the passages of comments are in the editor's document, and which
 * passage a selection is: the two ways between the Markdown a passage is kept
 * in (web/anchor.js) and the editor's positions.
 *
 * The editor holds a tree, and the Markdown is what it writes of it, so a
 * position in one is not a number in the other. The way across is to ask the
 * editor to write the Markdown with a mark of ours put in the tree at the
 * position, and to see where the mark stands in what it wrote. Nothing is
 * guessed from the look of the Markdown: whatever the editor writes is the
 * text the offsets are in, and a mapping that does not hold up against the
 * text the editor writes without the marks (an escape that the mark changed, a
 * block whose Markdown depends on where it stands) is not used. A passage that
 * cannot be put exactly is put on the blocks it is in, and one that cannot be
 * found is not put at all. A block whose Markdown the marks change (a paragraph
 * that starts with a character the editor escapes at the start of a line) is
 * left out, and only passages in it are not put.
 *
 *   selected(ctx, kept)       the passage the editor's selection is, in the text it writes
 *   place(ctx, kept, threads) where the threads' passages are, as editor positions
 *
 * The text is the one the page works with (`unframe(kept, ...)`), with its
 * front matter and line endings.
 */
import { serializerCtx, schemaCtx, editorViewCtx } from "@milkdown/core";
import { Fragment } from "@milkdown/prose/model";
import { Selection } from "@milkdown/prose/state";
import { Transform } from "@milkdown/prose/transform";
import { locate, passage } from "../web/anchor.js";
import { unframe } from "./frame.js";

/** A character that is in no document: put in the text where a position is, and taken out again. */
const MARK = "";

/**
 * The Markdown of `doc` with a mark at each of `points` (positions in the
 * document, inside text, in order), and where in the Markdown without the marks
 * each of them stands. A mark takes the emphasis, link and code marks of the
 * text it is in (`inside`: one flag for each point) or none, which puts it
 * outside them where a point is at the edge of such a mark. Nothing when the
 * marks changed what was written.
 */
function marked(ctx, kept, doc, points, inside = points.map(() => false)) {
  const schema = ctx.get(schemaCtx);
  const write = ctx.get(serializerCtx);
  const plain = unframe(kept, write(doc));
  if (plain.includes(MARK)) return null;
  const tr = new Transform(doc);
  // The last first: a mark does not move the positions before it.
  for (let i = points.length - 1; i >= 0; i--) tr.insert(points[i], schema.text(MARK, inside[i] ? doc.resolve(points[i]).marks() : []));
  const written = unframe(kept, write(tr.doc));
  const offsets = [];
  let out = "";
  for (const ch of written) {
    if (ch === MARK) offsets.push(out.length);
    else out += ch;
  }
  return out === plain && offsets.length === points.length ? { text: plain, offsets } : null;
}

/** The passage the selection is, as the Markdown holds it: `{ start, end, quote, prefix, suffix, text }`, or nothing for a selection that holds no text. `text` is what the selection reads as. */
export function selected(ctx, kept) {
  const view = ctx.get(editorViewCtx);
  const { doc, selection } = view.state;
  if (selection.empty) return null;
  // A selection of whole blocks (select all, a node) is taken to the text inside them.
  const from = Selection.near(doc.resolve(selection.from), 1).from;
  const to = Selection.near(doc.resolve(selection.to), -1).to;
  if (to <= from) return null;
  const text = doc.textBetween(from, to, "\n", " ");
  if (!text.trim()) return null;
  // Outside the marks that begin or end at the edge of the selection, where that can be (the whole of a bold word is `**word**`, not
  // `**word`), else inside them.
  for (const inside of [[false, false], [true, false], [false, true], [true, true]]) {
    const found = marked(ctx, kept, doc, [from, to], inside);
    const got = found && passage(found.text, found.offsets[0], found.offsets[1]);
    if (got) return { ...got, text };
  }
  // The editor could not say where: what it shows is the words, and the page finds them in the Markdown without its marks.
  return { start: null, end: null, quote: text.trim(), prefix: "", suffix: "", text };
}

/** The blocks a block of text can be in and have its text start at the start of a line. */
const LINE_CONTAINERS = ["blockquote", "bullet_list", "ordered_list", "list_item"];

/** The most runs of the whole document made to put marks at the blocks' edges. */
const MOST_RUNS = 32;

/**
 * Whether marks at the two edges of the block `block` change what the editor writes of it on its own: a paragraph that starts
 * with a character the editor escapes at the start of a line (`15\. März`, `\#hashtag`). A block on its own is written the way
 * its text is written at the start of a line in the document, so this is found without a run of the whole document. That is
 * the start of a paragraph and of a list item's or a quote's text alike (`- 15\. März`, `> 15\. März`, tasks and numbered
 * items too), and not of a cell of a table, which has a bar in front of it.
 */
function changesWithMarks(ctx, block) {
  if (!block.line || block.node.type.spec.code) return false;
  try {
    const schema = ctx.get(schemaCtx);
    const write = ctx.get(serializerCtx);
    const { node } = block;
    const alone = (content) => write(schema.topNodeType.create(null, node.type.create(node.attrs, content)));
    const mark = Fragment.from(schema.text(MARK));
    return alone(mark.append(node.content).append(mark)).replaceAll(MARK, "") !== alone(node.content);
  } catch {
    // A block that cannot be written on its own: left to the run of the document to say.
    return false;
  }
}

/**
 * Where the inline text of each of `blocks` starts and ends in the Markdown (`at`, by block, and the Markdown as `text`),
 * found with a mark at each block's edges in one run. A block whose Markdown the marks change spoils a run it is in. Those
 * are found one by one on their own (`changesWithMarks`) and left out, and the rest are put in one run: a document with a
 * paragraph, or a bullet, for each date has as many of them as it likes. A block that only changes where it stands is looked
 * for by halving the rest, which has a limit; a block with nothing is left without a place, and so are the passages in it.
 */
function blockTable(ctx, kept, doc, blocks) {
  const at = blocks.map(() => null);
  let text = null;
  let runs = 0;
  const run = (which) => {
    if (runs++ >= MOST_RUNS) return false;
    const got = marked(ctx, kept, doc, which.flatMap((i) => [blocks[i].from, blocks[i].to]));
    if (!got) return false;
    text = got.text;
    which.forEach((i, k) => (at[i] = [got.offsets[2 * k], got.offsets[2 * k + 1]]));
    return true;
  };
  // A set that did not hold up is halved, and each half halved in turn if it does not hold up either.
  const halve = (which) => {
    if (which.length < 2) return;
    const half = which.length >> 1;
    for (const part of [which.slice(0, half), which.slice(half)]) if (!run(part)) halve(part);
  };
  const all = blocks.map((_, i) => i);
  if (run(all)) return { at, text };
  const suspects = all.filter((i) => changesWithMarks(ctx, blocks[i]));
  const clean = all.filter((i) => !suspects.includes(i));
  if (clean.length && suspects.length && run(clean)) return { at, text };
  halve(clean);
  return text === null ? null : { at, text };
}

/** The blocks of text of `doc`: where the text in each is. */
function textblocks(doc) {
  const found = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    const $pos = doc.resolve(pos);
    const inside = Array.from({ length: $pos.depth }, (_, d) => $pos.node(d + 1).type.name);
    // `line`: the block's text starts at the start of a line (in the document, or after a list's or a quote's mark), not in a table.
    found.push({ node, from: pos + 1, to: pos + 1 + node.content.size, line: inside.every((name) => LINE_CONTAINERS.includes(name)) });
    return false;
  });
  return found;
}

/** Where in the document `block`'s text stands for the offset `local` of its own Markdown, or nothing: found by asking where a mark put at a position would stand, and taking the one just before or just after. */
function within(ctx, block, local, side, memo) {
  try {
    return exactly(ctx, block, local, side, memo);
  } catch {
    // A block the editor will not write on its own (content its paragraph cannot hold): the block it is.
    return null;
  }
}

function exactly(ctx, block, local, side, memo) {
  const schema = ctx.get(schemaCtx);
  const write = ctx.get(serializerCtx);
  const { node } = block;
  const size = node.content.size;
  if (node.type.spec.code) return block.from + Math.max(0, Math.min(local, size));
  const top = schema.topNodeType;
  const sourceOf = (content) => write(top.create(null, schema.nodes.paragraph.create(null, content))).replace(/\n$/, "");
  memo.source ??= new Map();
  if (!memo.source.has(block)) memo.source.set(block, sourceOf(node.content));
  const standalone = memo.source.get(block);
  if (standalone !== block.src.text) return null;
  const at = (rel) => {
    // Outside the emphasis, link and code marks that begin or end at the position, where it can be (`**word**` has a place before its
    // first mark and one after its last, and not only inside them); else in the text it is in, with its marks.
    for (const inside of [false, true]) {
      const here = Fragment.from(schema.text(MARK, inside ? node.resolve(rel).marks() : []));
      const out = sourceOf(node.content.cut(0, rel).append(here).append(node.content.cut(rel)));
      const i = out.indexOf(MARK);
      if (i >= 0 && out.slice(0, i) + out.slice(i + 1) === standalone) return i;
    }
    return -1;
  };
  let low = 0;
  let high = size;
  while (low < high) {
    // A start is the last position at or before the offset, an end the first at or after it.
    const mid = side === "start" ? Math.ceil((low + high) / 2) : Math.floor((low + high) / 2);
    const where = at(mid);
    if (where < 0) return null;
    if (side === "start") {
      if (where <= local) low = mid;
      else high = mid - 1;
    } else if (where >= local) high = mid;
    else low = mid + 1;
  }
  return block.from + low;
}

/**
 * Where the passage of each of `threads` (`{ id, quote, prefix, suffix, start }`) is in the editor's document:
 * a map from the thread's id to `{ from, to, text }` (positions, and what the passage reads as). Left out are
 * the threads whose words are not in the text the editor writes.
 */
export function place(ctx, kept, threads) {
  const view = ctx.get(editorViewCtx);
  const { doc } = view.state;
  const text = unframe(kept, ctx.get(serializerCtx)(doc));
  const cache = {};
  const wanted = [];
  for (const thread of threads) {
    const found = locate(text, thread, cache);
    if (found) wanted.push({ id: thread.id, start: found.start, end: found.end });
  }
  const out = new Map();
  if (!wanted.length) return out;
  const blocks = textblocks(doc);
  if (!blocks.length) return out;
  const table = blockTable(ctx, kept, doc, blocks);
  if (!table) return out;
  // Each block's own Markdown, and where it stands in the whole: nothing for a block whose Markdown the marks change.
  blocks.forEach((block, i) => {
    const at = table.at[i];
    block.src = at && { from: at[0], to: at[1], text: table.text.slice(at[0], at[1]) };
  });
  const memo = {};
  /**
   * The editor position for the offset `o` of the text: a start is at or after the block it is in or before, an end at or before it.
   * Nothing where `o` may be in a block that is not known (it is in the Markdown between the known ones, or in that block).
   */
  const position = (o, side) => {
    if (side === "start") {
      const i = blocks.findIndex((b) => b.src && b.src.to >= o);
      if (i < 0) return null;
      const block = blocks[i];
      if (o > block.src.from) return within(ctx, block, o - block.src.from, side, memo) ?? block.from;
      // Before the block's text: in its markup, or in a block before it that is not known.
      return o < block.src.from && i > 0 && !blocks[i - 1].src ? null : block.from;
    }
    let i = -1;
    blocks.forEach((b, k) => b.src && b.src.from <= o && (i = k));
    if (i < 0) return null;
    const block = blocks[i];
    if (o < block.src.to) return within(ctx, block, o - block.src.from, side, memo) ?? block.to;
    // After the block's text: in its markup, or in a block after it that is not known.
    return o > block.src.to && i + 1 < blocks.length && !blocks[i + 1].src ? null : block.to;
  };
  for (const { id, start, end } of wanted) {
    const from = position(start, "start");
    const to = position(end, "end");
    if (from !== null && to !== null && to > from) out.set(id, { from, to, text: doc.textBetween(from, to, "\n", " ") });
  }
  return out;
}
