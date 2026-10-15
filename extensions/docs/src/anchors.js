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
 * found is not put at all. (A paragraph that starts with a character the editor
 * escapes at the start of a line is one the marks change: a document with one
 * has none of its passages put, which is not worked around.)
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

/** The blocks of text of `doc`: where the text in each is. */
function textblocks(doc) {
  const found = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    found.push({ node, from: pos + 1, to: pos + 1 + node.content.size });
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
  const table = marked(ctx, kept, doc, blocks.flatMap((b) => [b.from, b.to]));
  if (!table) return out;
  // Each block's own Markdown, and where it stands in the whole.
  blocks.forEach((block, i) => {
    const [from, to] = [table.offsets[2 * i], table.offsets[2 * i + 1]];
    block.src = { from, to, text: table.text.slice(from, to) };
  });
  const memo = {};
  /** The editor position for the offset `o` of the text: a start is at or after the block it is in or before, an end at or before it. */
  const position = (o, side) => {
    if (side === "start") {
      const block = blocks.find((b) => b.src.to >= o);
      if (!block) return null;
      if (o <= block.src.from) return block.from;
      return within(ctx, block, o - block.src.from, side, memo) ?? block.from;
    }
    const block = [...blocks].reverse().find((b) => b.src.from <= o);
    if (!block) return null;
    if (o >= block.src.to) return block.to;
    return within(ctx, block, o - block.src.from, side, memo) ?? block.to;
  };
  for (const { id, start, end } of wanted) {
    const from = position(start, "start");
    const to = position(end, "end");
    if (from !== null && to !== null && to > from) out.set(id, { from, to, text: doc.textBetween(from, to, "\n", " ") });
  }
  return out;
}
