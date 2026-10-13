/**
 * The document editor: Milkdown, writing Markdown. Built into web/editor.js by
 * build.mjs, and loaded by the browser half when it needs it.
 *
 * It needs no React: it is mounted into an element the page hands it, so the
 * page's React and this never meet. Its Markdown is written the way most of
 * it is written by hand (`-` bullets, `---` rules, tables not padded), so a
 * document opened and saved comes back as it was.
 */
import { defaultValueCtx, Editor, editorViewCtx, remarkStringifyOptionsCtx, rootCtx } from "@milkdown/core";
import { history } from "@milkdown/plugin-history";
import { listener, listenerCtx } from "@milkdown/plugin-listener";
import { commonmark } from "@milkdown/preset-commonmark";
import { gfm, remarkGFMPlugin } from "@milkdown/preset-gfm";
import { getMarkdown, replaceAll } from "@milkdown/utils";

/**
 * An editor in `root`, holding `markdown`. `onChange` is told the Markdown
 * after each change the person makes. Resolves once it is drawn.
 */
export async function createEditor({ root, markdown = "", onChange, editable = true }) {
  const editor = await Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, root);
      ctx.set(defaultValueCtx, markdown);
      ctx.update(remarkStringifyOptionsCtx, (options) => ({ ...options, bullet: "-", rule: "-" }));
      ctx.set(remarkGFMPlugin.options.key, { tablePipeAlign: false });
      if (onChange) ctx.get(listenerCtx).markdownUpdated((_ctx, next, before) => next !== before && onChange(next));
    })
    .use(commonmark)
    .use(gfm)
    .use(history)
    .use(listener)
    .create();
  editor.action((ctx) => ctx.get(editorViewCtx).setProps({ editable: () => editable }));
  return {
    /** The document as Markdown, now. */
    markdown: () => editor.action(getMarkdown()),
    /** Replaces the whole document. */
    replace: (next) => editor.action(replaceAll(next)),
    destroy: () => editor.destroy(),
  };
}
