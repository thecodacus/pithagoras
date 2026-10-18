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
import { lift, setBlockType, toggleMark, wrapIn } from "@milkdown/prose/commands";
import { redo, redoDepth, undo, undoDepth } from "@milkdown/prose/history";
import { Slice } from "@milkdown/prose/model";
import { liftListItem, wrapInList } from "@milkdown/prose/schema-list";
import { Plugin, PluginKey, TextSelection } from "@milkdown/prose/state";
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
 * edited, so that a mark stays on its words while they are typed in. The page says where they are; a click is told
 * (`click`, with the id of the passage it was in, or null where it was in none).
 */
const threadKey = new PluginKey("pd-threads");
/** The narrowest of `ranges` that `pos` is in (its two ends count), or nothing. */
const narrowest = (ranges, pos) => ranges.filter((r) => r.from <= pos && pos <= r.to).sort((a, b) => a.to - a.from - (b.to - b.from))[0];
const threads = ({ click, texts }) =>
  $prose(() => {
    /** A click on the text, told with the narrowest of the passages it is in; none where it is in no passage (what was open is closed). */
    const clicked = (view, pos) => {
      click(narrowest(threadKey.getState(view.state).ranges, pos)?.id ?? null);
      return false;
    };
    return new Plugin({
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
        // A second or third click in a moment is another kind of click for the editor, and is as much a click on the passage.
        handleClick: clicked,
        handleDoubleClick: clicked,
        handleTripleClick: clicked,
      },
      view: () => {
        let timer = null;
        return {
          update(view, before) {
            // What the passages read as is kept up with what is typed in them, after a moment.
            if (before.doc !== view.state.doc) {
              clearTimeout(timer);
              timer = setTimeout(() => !view.isDestroyed && texts(), 250);
            }
          },
          destroy: () => clearTimeout(timer),
        };
      },
    });
  });

/** The marks the toolbar shows, by their names in the editor's schema. */
const MARKS = ["strong", "emphasis", "strike_through", "inlineCode", "link"];

/**
 * What the toolbar shows of where the selection is: the marks on it, the kind of block (`paragraph`, `h1`…`h6`, `code`), the list
 * it is in (`bullet`, `ordered`, `task`, or null), whether it is in a quote or a table, and whether there is something to undo or redo.
 */
function formatOf(state) {
  const { schema, selection } = state;
  const { $from, from, to, empty } = selection;
  const marks = {};
  for (const name of MARKS) {
    const type = schema.marks[name];
    if (type) marks[name] = empty ? Boolean(type.isInSet(state.storedMarks || $from.marks())) : state.doc.rangeHasMark(from, to, type);
  }
  const parent = $from.parent;
  const block = parent.type.name === "heading" ? `h${parent.attrs.level}` : parent.type.name === "code_block" ? "code" : "paragraph";
  let list = null;
  let quote = false;
  let table = false;
  // From the innermost out: the item a task's box is on is inside its list.
  for (let depth = $from.depth; depth > 0; depth--) {
    const node = $from.node(depth);
    const name = node.type.name;
    if (!list && name === "list_item" && node.attrs.checked != null) list = "task";
    else if (!list && name === "bullet_list") list = "bullet";
    else if (!list && name === "ordered_list") list = "ordered";
    if (name === "blockquote") quote = true;
    if (name === "table") table = true;
  }
  return { marks, block, list, quote, table, undo: undoDepth(state) > 0, redo: redoDepth(state) > 0, selected: !empty };
}

/** The depth of the innermost list the selection is in, or nothing. */
function listDepth($from) {
  for (let depth = $from.depth; depth > 0; depth--) if (["bullet_list", "ordered_list"].includes($from.node(depth).type.name)) return depth;
  return null;
}

/** The items of the list at `pos` given a box (`checked` false) or none (`checked` null): a task list is a bullet list whose items have one. */
function boxItems(tr, pos, task) {
  const list = tr.doc.nodeAt(pos);
  if (!list) return tr;
  list.forEach((item, offset) => {
    if (!("checked" in item.attrs)) return;
    tr.setNodeMarkup(pos + 1 + offset, null, { ...item.attrs, checked: task ? (item.attrs.checked ?? false) : null });
  });
  return tr;
}

/** A list of this kind (`bullet`, `ordered`, `task`) where the selection is: taken away where it is one already, changed where it is another. */
const toggleList = (kind) => (state, dispatch) => {
  const { schema } = state;
  const now = formatOf(state).list;
  if (now === kind) return liftListItem(schema.nodes.list_item)(state, dispatch);
  const type = kind === "ordered" ? schema.nodes.ordered_list : schema.nodes.bullet_list;
  const depth = listDepth(state.selection.$from);
  if (depth !== null) {
    if (!dispatch) return true;
    const pos = state.selection.$from.before(depth);
    const tr = state.tr;
    if (tr.doc.nodeAt(pos).type !== type) tr.setNodeMarkup(pos, type);
    dispatch(boxItems(tr, pos, kind === "task"));
    return true;
  }
  return wrapInList(type)(state, dispatch && ((tr) => {
    const at = listDepth(tr.selection.$from);
    dispatch(kind === "task" && at !== null ? boxItems(tr, tr.selection.$from.before(at), true) : tr);
  }));
};

/** A block of this kind (`paragraph`, `h1`…`h3`, `code`): the same again makes it a paragraph. */
const toggleBlock = (kind) => (state, dispatch) => {
  const { schema } = state;
  const now = formatOf(state).block;
  if (kind === "paragraph" || now === kind) return setBlockType(schema.nodes.paragraph)(state, dispatch);
  if (kind === "code") return setBlockType(schema.nodes.code_block)(state, dispatch);
  return setBlockType(schema.nodes.heading, { level: Number(kind.slice(1)) })(state, dispatch);
};

/** A link to `href` on what is selected (its address as its text where nothing is), or the link taken off where there is one. */
const toggleLink = (href) => (state, dispatch) => {
  const type = state.schema.marks.link;
  const { from, to, empty } = state.selection;
  if (formatOf(state).marks.link) {
    if (!dispatch) return true;
    // The whole link around the caret, not only what is selected of it.
    const $from = state.doc.resolve(from);
    let start = from;
    let end = to;
    if (empty) {
      const parent = $from.parent;
      const offset = $from.parentOffset;
      let pos = $from.start();
      parent.forEach((child, at) => {
        if (at <= offset && offset <= at + child.nodeSize && type.isInSet(child.marks)) {
          start = Math.min(start, pos + at);
          end = Math.max(end, pos + at + child.nodeSize);
        }
      });
    }
    dispatch(state.tr.removeMark(start, end, type));
    return true;
  }
  if (!href) return false;
  if (!dispatch) return true;
  const mark = type.create({ href });
  dispatch(empty ? state.tr.insert(from, state.schema.text(href, [mark])) : state.tr.addMark(from, to, mark));
  return true;
};

/**
 * A block (a rule, a table) put after the block the caret is in, or in the place of an empty paragraph it is in, with a paragraph
 * after it where nothing follows to write in. The caret goes `inside` it (a table's first cell) or to what follows it.
 */
const insertBlock = (node, inside = false) => (state, dispatch) => {
  if (!dispatch) return true;
  const { $from } = state.selection;
  const tr = state.tr;
  let at;
  if ($from.depth === 1 && $from.parent.isTextblock && $from.parent.content.size === 0) {
    at = $from.before(1);
    tr.replaceWith(at, $from.after(1), node);
  } else {
    at = $from.depth > 0 ? $from.after(1) : state.selection.to;
    tr.insert(at, node);
  }
  const after = at + node.nodeSize;
  if (!tr.doc.resolve(after).nodeAfter?.isTextblock) tr.insert(after, state.schema.nodes.paragraph.create());
  tr.setSelection(TextSelection.near(tr.doc.resolve(inside ? at + 1 : after + 1)));
  dispatch(tr.scrollIntoView());
  return true;
};

/** A table of three columns and three rows, the first its head, after the block the caret is in. */
function insertTable(state, dispatch) {
  const { nodes } = state.schema;
  if (!nodes.table) return false;
  const row = (type, cell) => type.create(null, [0, 1, 2].map(() => cell.createAndFill()));
  const table = nodes.table.create(null, [row(nodes.table_header_row, nodes.table_header), row(nodes.table_row, nodes.table_cell), row(nodes.table_row, nodes.table_cell)]);
  return insertBlock(table, true)(state, dispatch);
}

/** What the toolbar can ask of the editor, by name: each a ProseMirror command. */
const COMMANDS = {
  undo: () => undo,
  redo: () => redo,
  strong: () => (state, dispatch) => toggleMark(state.schema.marks.strong)(state, dispatch),
  emphasis: () => (state, dispatch) => toggleMark(state.schema.marks.emphasis)(state, dispatch),
  strike_through: () => (state, dispatch) => toggleMark(state.schema.marks.strike_through)(state, dispatch),
  inlineCode: () => (state, dispatch) => toggleMark(state.schema.marks.inlineCode)(state, dispatch),
  link: (href) => toggleLink(href),
  block: (kind) => toggleBlock(kind),
  list: (kind) => toggleList(kind),
  quote: () => (state, dispatch) => (formatOf(state).quote ? lift(state, dispatch) : wrapIn(state.schema.nodes.blockquote)(state, dispatch)),
  hr: () => (state, dispatch) => insertBlock(state.schema.nodes.hr.create())(state, dispatch),
  table: () => insertTable,
};

/**
 * Tells the page where the selection is, as the toolbar shows it (`formatOf`), whenever that may have changed; and ticks a
 * task's box when it is clicked, which is drawn before the item (client.css).
 */
const formatting = (told) =>
  $prose(
    () =>
      new Plugin({
        view: (view) => {
          told(formatOf(view.state));
          return {
            update(view, before) {
              if (before.doc !== view.state.doc || !before.selection.eq(view.state.selection) || before.storedMarks !== view.state.storedMarks) told(formatOf(view.state));
            },
          };
        },
        props: {
          handleDOMEvents: {
            mousedown(view, event) {
              const item = event.target instanceof Element ? event.target.closest('li[data-item-type="task"]') : null;
              if (!item || !view.editable) return false;
              // The box is the space before the item's text.
              if (event.clientX >= item.getBoundingClientRect().left) return false;
              const pos = view.posAtDOM(item, 0) - 1;
              const node = view.state.doc.nodeAt(pos);
              if (!node || node.attrs.checked == null) return false;
              event.preventDefault();
              view.dispatch(view.state.tr.setNodeMarkup(pos, null, { ...node.attrs, checked: !node.attrs.checked }));
              return true;
            },
          },
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
 * The passages of comments: `onThread(id)` when the text is clicked (the id of the marked passage it was in, or null), and
 * `onPlaced(map)` which passages are marked, by thread, with what they read as.
 */
export async function createEditor({ root, markdown = "", onChange, editable = true, onThread, onPlaced, onFormat }) {
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
    .use(threads({ click: (id) => onThread?.(id), texts: () => report() }))
    .use(formatting((format) => onFormat?.(format)))
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
    /**
     * Does what the toolbar asks (`COMMANDS`: `strong`, `block` with `h1`, `list` with `task`, `link` with an address…), and
     * gives the text the focus back. False where it could not be done there.
     */
    command: (name, arg) =>
      editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const make = COMMANDS[name];
        if (!make || view.isDestroyed) return false;
        const done = make(arg)(view.state, view.dispatch, view);
        view.focus();
        return done;
      }),
    /** Where the selection is, as the toolbar shows it. */
    format: () => editor.action((ctx) => formatOf(ctx.get(editorViewCtx).state)),
    /** The text as it is drawn, for a printed copy. */
    html: () => editor.action((ctx) => ctx.get(editorViewCtx).dom.innerHTML),
    /** Gives the text the focus. */
    focus: () => editor.action((ctx) => ctx.get(editorViewCtx).focus()),
    /** Puts the caret at the end of the document and gives the text the focus: a click on the page below the text. */
    focusEnd: () =>
      editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        if (view.isDestroyed) return;
        view.dispatch(view.state.tr.setSelection(TextSelection.atEnd(view.state.doc)).scrollIntoView());
        view.focus();
      }),
    /**
     * Puts the caret at the place nearest to a point of the screen and gives the text the focus: a click on the page beside the text.
     * The point is taken into the column sideways, so that a click beside a line is a click on that line, as on a word processor's page.
     * The page does not scroll: the person clicked where they were looking.
     */
    focusAt: (x, y) =>
      editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        if (view.isDestroyed) return;
        const column = view.dom.getBoundingClientRect();
        const hit = view.posAtCoords({ left: Math.min(Math.max(x, column.left + 1), column.right - 1), top: Math.min(Math.max(y, column.top + 1), column.bottom - 1) });
        if (hit) view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(hit.pos))));
        view.focus();
      }),
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
    /**
     * The thread whose passage the caret is in (the narrowest; "pending" for the comment being written), or null: the keyboard's way to a comment. Read from where the caret is
     * drawn, in the marks of the text, which is what the person sees (the editor's own state follows the browser's a moment later).
     */
    threadAtCaret: () => {
      const selection = root.ownerDocument.getSelection();
      let node = selection?.focusNode;
      // The caret may be between a paragraph's children, not in a text: the child it is before (or the last one) is where it is.
      if (node?.nodeType === 1) node = node.childNodes[selection.focusOffset] ?? node.lastChild ?? node;
      const hit = (node?.nodeType === 1 ? node : node?.parentElement)?.closest?.("[data-pd-thread]");
      const id = hit && root.contains(hit) ? hit.dataset.pdThread : null;
      return id || null;
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
