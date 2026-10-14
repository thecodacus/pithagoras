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
import { defaultValueCtx, Editor, editorViewCtx, parserCtx, remarkStringifyOptionsCtx, rootCtx, serializerCtx } from "@milkdown/core";
import { history } from "@milkdown/plugin-history";
import { listener, listenerCtx } from "@milkdown/plugin-listener";
import { commonmark, imageSchema } from "@milkdown/preset-commonmark";
import { gfm, remarkGFMPlugin } from "@milkdown/preset-gfm";
import { Slice } from "@milkdown/prose/model";
import { Plugin, PluginKey } from "@milkdown/prose/state";
import { Decoration, DecorationSet } from "@milkdown/prose/view";
import { $prose, getMarkdown, replaceAll } from "@milkdown/utils";
import { diff } from "../web/merge.js";
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
 */
function applyChanges(ctx, body, flash) {
  const view = ctx.get(editorViewCtx);
  const doc = ctx.get(parserCtx)(body);
  if (!doc) return;
  const was = view.state.doc;
  const keyed = (parent) => Array.from({ length: parent.childCount }, (_, i) => JSON.stringify(parent.child(i).toJSON()));
  const hunks = diff(keyed(was), keyed(doc));
  if (!hunks.length) return;
  const before = starts(was);
  const after = starts(doc);
  let tr = view.state.tr;
  // The last first: a change does not move what comes before it.
  for (const [a0, a1, b0, b1] of [...hunks].reverse()) tr = tr.replace(before[a0], before[a1], new Slice(doc.content.cut(after[b0], after[b1]), 0, 0));
  tr.setMeta("addToHistory", false);
  const marked = hunks.flatMap(([, , b0, b1]) => Array.from({ length: b1 - b0 }, (_, i) => [after[b0 + i], after[b0 + i + 1]]));
  if (marked.length) tr.setMeta(flashKey, marked);
  view.dispatch(tr);
  if (marked.length) flash();
}

/**
 * An editor in `root`, holding `markdown`. `onChange` is told the Markdown
 * after each change the person makes. Resolves once it is drawn.
 */
export async function createEditor({ root, markdown = "", onChange, editable = true }) {
  let kept = frame(markdown);
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
    .create();
  editor.action((ctx) => ctx.get(editorViewCtx).setProps({ editable: () => editable }));
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
    },
    destroy: () => {
      clearTimeout(unmark);
      return editor.destroy();
    },
  };
}
