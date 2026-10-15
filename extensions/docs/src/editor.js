/**
 * The document editor: Milkdown, writing Markdown. Built into web/editor.js by
 * build.mjs, and loaded by the browser half when it needs it.
 *
 * It needs no React: it is mounted into an element the page hands it, so the
 * page's React and this never meet. Its Markdown is written the way most of
 * it is written by hand (`-` bullets, `---` rules, tables not padded), so a
 * document opened and saved comes back as it was. What it cannot hold (a front
 * matter block, the line ending) is kept apart and put back (frame.js).
 */
import { defaultValueCtx, Editor, editorViewCtx, parserCtx, remarkStringifyOptionsCtx, rootCtx, schemaCtx, serializerCtx } from "@milkdown/core";
import { history } from "@milkdown/plugin-history";
import { listener, listenerCtx } from "@milkdown/plugin-listener";
import { commonmark, imageSchema } from "@milkdown/preset-commonmark";
import { gfm, remarkGFMPlugin } from "@milkdown/preset-gfm";
import { Slice } from "@milkdown/prose/model";
import { Plugin, PluginKey } from "@milkdown/prose/state";
import { Decoration, DecorationSet } from "@milkdown/prose/view";
import { $prose, getMarkdown, replaceAll } from "@milkdown/utils";
import { diff } from "../web/merge.js";
import { place, selected } from "./anchors.js";
import { frame, unframe } from "./frame.js";

/**
 * A picture is drawn as its text, as the portal draws one it will not load: an
 * address on another site would have the person's browser fetch it as soon as
 * the document is opened, and a path in the folder is not one the page serves.
 * Parsed and written as before, so the Markdown comes back as it was.
 */
const pictureAsText = imageSchema.extendSchema((prev) => (ctx) => ({
  ...prev(ctx),
  toDOM: (node) => ["span", { class: "pd-picture", title: node.attrs.title || node.attrs.src }, node.attrs.alt || node.attrs.src],
}));

/** How long a block that changed from outside is marked as changed. */
const FLASH_MS = 2000;

/**
 * Blocks marked as changed for a moment: a decoration, not a class set on the
 * block's element, which the editor would take for an edit of its DOM.
 */
const flashKey = new PluginKey("pd-flash");
const flashing = $prose(
  () =>
    new Plugin({
      key: flashKey,
      state: {
        init: () => DecorationSet.empty,
        apply(tr, marks) {
          const told = tr.getMeta(flashKey);
          if (told === "clear") return DecorationSet.empty;
          if (told) return DecorationSet.create(tr.doc, told.map(([from, to]) => Decoration.node(from, to, { class: "pd-changed" })));
          return marks.map(tr.mapping, tr.doc);
        },
      },
      props: { decorations: (state) => flashKey.getState(state) },
    }),
);

/**
 * The passages of comments, marked in the text: a decoration for each, which the editor moves with the text as it is
 * edited, so that a mark stays on its words while they are typed in. The page says where they are; a click on one is
 * told (`click`), and so is a change of what is selected.
 */
const threadKey = new PluginKey("pd-threads");
const threads = ({ click, select, texts }) =>
  $prose(
    () =>
      new Plugin({
        key: threadKey,
        state: {
          init: () => ({ ranges: [] }),
          apply(tr, value) {
            const told = tr.getMeta(threadKey);
            if (told) return told;
            if (!tr.docChanged) return value;
            // A start moves right of what is put in at it, and an end left of it: text typed at an edge is not in the passage.
            return { ...value, ranges: value.ranges.map((r) => ({ ...r, from: tr.mapping.map(r.from, 1), to: tr.mapping.map(r.to, -1) })).filter((r) => r.to > r.from) };
          },
        },
        props: {
          decorations(state) {
            const { ranges } = threadKey.getState(state);
            return DecorationSet.create(
              state.doc,
              ranges.map((r) => Decoration.inline(r.from, r.to, { class: `pd-thread${r.pending ? " pd-thread-pending" : ""}`, "data-pd-thread": r.id })),
            );
          },
          handleClick(view, pos) {
            const { ranges } = threadKey.getState(view.state);
            // The narrowest of the passages the click is in.
            const hit = ranges.filter((r) => !r.pending && r.from <= pos && pos <= r.to).sort((a, b) => a.to - a.from - (b.to - b.from))[0];
            if (hit) click(hit.id);
            return false;
          },
        },
        view: () => {
          let timer = null;
          return {
            update(view, before) {
              if (!before.selection.eq(view.state.selection)) select(!view.state.selection.empty);
              // What the passages read as is kept up with what is typed in them, after a moment.
              if (before.doc !== view.state.doc) {
                clearTimeout(timer);
                timer = setTimeout(() => !view.isDestroyed && texts(), 250);
              }
            },
            destroy: () => clearTimeout(timer),
          };
        },
      }),
  );

/** The positions at which a document's blocks start, and where the last ends. */
function starts(doc) {
  const at = [0];
  doc.forEach((block) => at.push(at[at.length - 1] + block.nodeSize));
  return at;
}

/**
 * Puts the document `body` (Markdown) in the place of what the editor holds:
 * the blocks that differ are replaced, each on its own, and the others are not
 * touched. So the caret and the selection stay where they are unless their own
 * block was changed, and what the person typed can still be undone, while the
 * change that came from outside cannot (it is not theirs to take back). The
 * blocks that changed are marked for a moment.
 *
 * Blocks are told apart by the Markdown they are written as, not by their nodes:
 * what the person is typing is often not the node its own Markdown parses to (a
 * space at the end of a line, which Markdown does not keep; a list made by
 * typing `- `), and a block replaced for that would take the caret out of the
 * text being typed and into the next block. A block of the editor that is not
 * written as any new block is written once more as what its own Markdown
 * parses to, before it is taken to differ.
 */
function applyChanges(ctx, body, flash) {
  const view = ctx.get(editorViewCtx);
  const parse = ctx.get(parserCtx);
  const doc = parse(body);
  if (!doc) return;
  const was = view.state.doc;
  const serialize = ctx.get(serializerCtx);
  const top = ctx.get(schemaCtx).topNodeType;
  const written = (block) => serialize(top.create(null, block));
  const wanted = Array.from({ length: doc.childCount }, (_, i) => written(doc.child(i)));
  const known = new Set(wanted);
  const held = Array.from({ length: was.childCount }, (_, i) => {
    const text = written(was.child(i));
    return known.has(text) ? text : serialize(parse(text));
  });
  const hunks = diff(held, wanted);
  if (!hunks.length) return;
  const before = starts(was);
  const after = starts(doc);
  let tr = view.state.tr;
  // The last first: a change does not move what comes before it.
  for (const [a0, a1, b0, b1] of [...hunks].reverse()) tr = tr.replace(before[a0], before[a1], new Slice(doc.content.cut(after[b0], after[b1]), 0, 0));
  tr.setMeta("addToHistory", false);
  // Where the new blocks are in the document that results, which keeps the blocks that were left as they were (and their sizes).
  const now = starts(tr.doc);
  const marked = hunks.flatMap(([, , b0, b1]) => Array.from({ length: b1 - b0 }, (_, i) => [now[b0 + i], now[b0 + i + 1]]));
  if (marked.length) tr.setMeta(flashKey, marked);
  view.dispatch(tr);
  if (marked.length) flash();
}

/**
 * An editor in `root`, holding `markdown`. `onChange` is told the Markdown
 * after each change the person makes. Resolves once it is drawn.
 *
 * The passages of comments: `onSelect(selected)` is told when something is
 * selected or not, `onThread(id)` when a marked passage is clicked, and
 * `onPlaced(map)` which passages are marked, by thread, with what they read as.
 */
export async function createEditor({ root, markdown = "", onChange, editable = true, onSelect, onThread, onPlaced }) {
  let kept = frame(markdown);
  // The threads last given (`mark`), to be put again where they are when the document is replaced.
  let marked = [];
  let report = () => {};
  const editor = await Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, root);
      ctx.set(defaultValueCtx, kept.body);
      ctx.update(remarkStringifyOptionsCtx, (options) => ({ ...options, bullet: "-", rule: "-" }));
      ctx.set(remarkGFMPlugin.options.key, { tablePipeAlign: false });
      if (onChange) ctx.get(listenerCtx).markdownUpdated((_ctx, next, before) => next !== before && onChange(unframe(kept, next)));
    })
    .use(commonmark)
    .use(pictureAsText)
    .use(gfm)
    .use(history)
    .use(listener)
    .use(flashing)
    .use(threads({ click: (id) => onThread?.(id), select: (on) => onSelect?.(on), texts: () => report() }))
    .create();
  editor.action((ctx) => ctx.get(editorViewCtx).setProps({ editable: () => editable }));
  /** What each marked passage reads as now, told to the page. */
  report = () =>
    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      if (view.isDestroyed) return;
      const { ranges } = threadKey.getState(view.state);
      onPlaced?.(new Map(ranges.map((r) => [r.id, view.state.doc.textBetween(r.from, r.to, "\n", " ")])));
    });
  /**
   * Marks the passages of `list` (threads: `{ id, quote, prefix, suffix, start }`, `pending` for the one being written) where
   * their words are in the text. One that is not found keeps the place it had, which is moved with the text as it is typed.
   */
  const mark = (list) =>
    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const found = place(ctx, kept, list);
      const before = new Map(threadKey.getState(view.state).ranges.map((r) => [r.id, r]));
      const ranges = [];
      for (const thread of list) {
        const at = found.get(thread.id) ?? before.get(thread.id);
        if (at) ranges.push({ id: thread.id, from: at.from, to: at.to, pending: Boolean(thread.pending) });
      }
      view.dispatch(view.state.tr.setMeta(threadKey, { ranges }).setMeta("addToHistory", false));
    });
  let looked = null;
  let unmark = null;
  /** The marks come off again after a while. */
  const flash = () => {
    clearTimeout(unmark);
    unmark = setTimeout(() => {
      unmark = null;
      editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        if (!view.isDestroyed) view.dispatch(view.state.tr.setMeta(flashKey, "clear"));
      });
    }, FLASH_MS);
  };
  return {
    /** The document as Markdown, now. */
    markdown: () => unframe(kept, editor.action(getMarkdown())),
    /** Replaces the whole document, and what can be undone with it: what was there is another document now. */
    replace: (next) => {
      kept = frame(next);
      editor.action(replaceAll(kept.body, true));
      if (marked.length) mark(marked);
      report();
    },
    /**
     * The Markdown as this editor would write it, for any Markdown: what `markdown()` says once it holds that text. Nothing
     * in the editor changes. Texts are compared like this, so that a style of writing is not a difference.
     */
    normalize: (next) => {
      const framed = frame(next);
      return unframe(framed, editor.action((ctx) => ctx.get(serializerCtx)(ctx.get(parserCtx)(framed.body))));
    },
    /** Puts a text in the place of the document by changing the blocks that differ, and no others (see applyChanges). */
    apply: (next) => {
      kept = frame(next);
      editor.action((ctx) => applyChanges(ctx, kept.body, flash));
      if (marked.length) mark(marked);
      report();
    },
    /** The passage the selection is (see anchors.js), or nothing. */
    selection: () => editor.action((ctx) => selected(ctx, kept)),
    /** Marks these threads' passages (see `mark`): the ones that are to be shown. */
    threads: (list) => {
      marked = list;
      mark(list);
      report();
    },
    /**
     * The passage that is looked at is drawn as such. Not by a change to the editor's state: a click on a marked passage is what
     * makes it the one looked at, and a change to the editor in the middle of a click would put the caret back where it was.
     */
    activate: (id) => {
      root.dataset.activeThread = id ?? "";
      if (!looked) {
        looked = document.createElement("style");
        document.head.append(looked);
      }
      looked.textContent = id ? `.pd-editor .ProseMirror [data-pd-thread="${CSS.escape(id)}"] { background: rgb(var(--warn) / .4); }` : "";
    },
    /** Scrolls a passage into view, without moving the selection. */
    reveal: (id) =>
      editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const at = threadKey.getState(view.state).ranges.find((r) => r.id === id);
        if (!at) return;
        const { node } = view.domAtPos(at.from);
        (node.nodeType === 1 ? node : node.parentElement)?.scrollIntoView({ block: "center", behavior: "smooth" });
      }),
    destroy: () => {
      clearTimeout(unmark);
      looked?.remove();
      return editor.destroy();
    },
  };
}
