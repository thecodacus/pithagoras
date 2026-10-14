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
import { defaultValueCtx, Editor, editorViewCtx, remarkStringifyOptionsCtx, rootCtx } from "@milkdown/core";
import { history } from "@milkdown/plugin-history";
import { listener, listenerCtx } from "@milkdown/plugin-listener";
import { commonmark, imageSchema } from "@milkdown/preset-commonmark";
import { gfm, remarkGFMPlugin } from "@milkdown/preset-gfm";
import { getMarkdown, replaceAll } from "@milkdown/utils";
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
    .create();
  editor.action((ctx) => ctx.get(editorViewCtx).setProps({ editable: () => editable }));
  return {
    /** The document as Markdown, now. */
    markdown: () => unframe(kept, editor.action(getMarkdown())),
    /** Replaces the whole document, and what can be undone with it: what was there is another document now. */
    replace: (next) => {
      kept = frame(next);
      editor.action(replaceAll(kept.body, true));
    },
    destroy: () => editor.destroy(),
  };
}
