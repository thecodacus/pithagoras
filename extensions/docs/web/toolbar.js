/**
 * The editor's toolbar, as a word processor has it: undo and redo, the kind of
 * paragraph, the marks on the text, links, lists, quotes, tables and rules, and
 * a comment on what is selected. Each button says whether what it does is on
 * where the selection is (`format`, from the editor: src/editor.js), and asks
 * the editor to do it (`onCommand`). A button takes no focus from the text: the
 * selection it acts on stays where it is.
 */

/** The icons, as paths in a 24 by 24 box drawn with a stroke. */
export const ICONS = {
  undo: "M3 7v6h6M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13",
  redo: "M21 7v6h-6M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6 2.3l3 2.7",
  strong: "M6 12h9a4 4 0 0 1 0 8H7a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h7a4 4 0 0 1 0 8",
  emphasis: "M19 4h-9M14 20H5M15 4 9 20",
  strike_through: "M16 4H9a3 3 0 0 0-2.83 4M14 12a4 4 0 0 1 0 8H6M4 12h16",
  inlineCode: "m16 18 6-6-6-6M8 6l-6 6 6 6",
  link: "M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71",
  bullet: "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01",
  ordered: "M10 6h11M10 12h11M10 18h11M4 6h1v4M4 10h2M6 18H4c0-1 2-2 2-3s-1-1.5-2-1",
  task: "m3 17 2 2 4-4M3 7l2 2 4-4M13 6h8M13 12h8M13 18h8",
  quote: "M10 11H6a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v6c0 2-1 3-3 4M19 11h-4a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v6c0 2-1 3-3 4",
  table: "M3 3h18v18H3zM3 9h18M3 15h18M9 3v18M15 3v18",
  hr: "M4 12h16",
  comment: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2zM12 7v6M9 10h6",
  comments: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z",
  download: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3",
  upload: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12",
  history: "M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8M3 3v5h5M12 7v5l4 2",
  expand: "M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7",
  printer: "M6 9V2h12v7M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2M6 14h12v8H6z",
  file: "M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5ZM14 3v5h5",
  chevron: "m6 9 6 6 6-6",
  pencil: "M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5zM15 5l4 4",
  trash: "M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M10 11v6M14 11v6",
  more: "M12 12h.01M19 12h.01M5 12h.01",
  visual: "M4 7V4h16v3M9 20h6M12 4v16",
};

export function toolbar(portal) {
  const { React, ui, t } = portal;
  const { useEffect, useRef, useState } = React;
  const h = React.createElement;

  const Icon = ({ name }) =>
    h("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true, className: "pd-icon" }, h("path", { d: ICONS[name] }));

  /** A button of the toolbar: an icon, its name for a screen reader and a tooltip, pressed where it is on. Keeps the focus in the text. */
  const Tool = ({ icon, label, keys, pressed, disabled, onClick, children }) =>
    h(
      "button",
      {
        type: "button",
        className: `pd-tool${children ? " pd-tool-wide" : ""}`,
        "aria-label": label,
        title: keys ? `${label} (${keys})` : label,
        "aria-pressed": pressed === undefined ? undefined : Boolean(pressed),
        disabled,
        onMouseDown: (e) => e.preventDefault(),
        onClick,
      },
      h(Icon, { name: icon }),
      children,
    );

  const Divider = () => h("span", { className: "pd-tool-divider", "aria-hidden": true });

  const mod = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl";

  /** The address of a link, asked for in the toolbar itself: Enter puts it on the selection, Escape gives up. */
  function LinkBox({ onDone, onCancel }) {
    const [href, setHref] = useState("https://");
    const box = useRef(null);
    useEffect(() => {
      box.current?.focus();
      box.current?.select();
    }, []);
    const done = () => {
      const value = href.trim();
      if (value && value !== "https://") onDone(value);
      else onCancel();
    };
    return h(
      "div",
      { className: "pd-linkbox", role: "group", "aria-label": t("Link") },
      h("input", {
        ref: box,
        className: ui.classes.inputSmall,
        value: href,
        "aria-label": t("Address of the link"),
        onChange: (e) => setHref(e.target.value),
        onKeyDown: (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            done();
          } else if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        },
      }),
      h("button", { type: "button", className: ui.classes.primarySmall, onClick: done }, t("Insert")),
      h("button", { type: "button", className: ui.classes.ghost, onClick: onCancel }, t("Cancel")),
    );
  }

  /**
   * The toolbar. `format` is where the selection is (null until the editor is there), `disabled` while the text cannot be
   * edited (it loads, or the agent's draft is shown in its place). `onComment` starts a comment on what is selected.
   */
  return function Toolbar({ format, disabled, onCommand, onComment, onFocusText }) {
    portal.locale.use();
    const [linking, setLinking] = useState(false);
    const off = disabled || !format;
    const f = format ?? { marks: {}, block: "paragraph", list: null, quote: false, table: false, undo: false, redo: false, selected: false };
    const run = (name, arg) => () => onCommand(name, arg);
    const styles = [
      ["paragraph", t("Normal text")],
      ["h1", t("Heading 1")],
      ["h2", t("Heading 2")],
      ["h3", t("Heading 3")],
      ["code", t("Code block")],
    ];
    return h(
      "div",
      { className: "pd-toolbar", role: "toolbar", "aria-label": t("Formatting") },
      h(Tool, { icon: "undo", label: t("Undo"), keys: `${mod}+Z`, disabled: off || !f.undo, onClick: run("undo") }),
      h(Tool, { icon: "redo", label: t("Redo"), keys: `${mod}+Shift+Z`, disabled: off || !f.redo, onClick: run("redo") }),
      h(Divider),
      h(ui.Select, {
        className: "pd-style",
        size: "sm",
        "aria-label": t("Text style"),
        disabled: off,
        value: styles.some(([value]) => value === f.block) ? f.block : "paragraph",
        options: styles.map(([value, label]) => ({ value, label })),
        // The list gives the focus back to its button as it closes, after this: the text has it once that is done.
        onChange: (value) => {
          onCommand("block", value);
          queueMicrotask(() => onFocusText?.());
        },
      }),
      h(Divider),
      h(Tool, { icon: "strong", label: t("Bold"), keys: `${mod}+B`, pressed: f.marks.strong, disabled: off, onClick: run("strong") }),
      h(Tool, { icon: "emphasis", label: t("Italic"), keys: `${mod}+I`, pressed: f.marks.emphasis, disabled: off, onClick: run("emphasis") }),
      h(Tool, { icon: "strike_through", label: t("Strikethrough"), pressed: f.marks.strike_through, disabled: off, onClick: run("strike_through") }),
      h(Tool, { icon: "inlineCode", label: t("Code"), keys: `${mod}+E`, pressed: f.marks.inlineCode, disabled: off, onClick: run("inlineCode") }),
      h(Tool, { icon: "link", label: f.marks.link ? t("Remove link") : t("Link"), pressed: f.marks.link, disabled: off, onClick: () => (f.marks.link ? onCommand("link") : setLinking(true)) }),
      h(Divider),
      h(Tool, { icon: "bullet", label: t("Bulleted list"), pressed: f.list === "bullet", disabled: off, onClick: run("list", "bullet") }),
      h(Tool, { icon: "ordered", label: t("Numbered list"), pressed: f.list === "ordered", disabled: off, onClick: run("list", "ordered") }),
      h(Tool, { icon: "task", label: t("Checklist"), pressed: f.list === "task", disabled: off, onClick: run("list", "task") }),
      h(Divider),
      h(Tool, { icon: "quote", label: t("Quote"), pressed: f.quote, disabled: off, onClick: run("quote") }),
      h(Tool, { icon: "table", label: t("Insert table"), disabled: off || f.table, onClick: run("table") }),
      h(Tool, { icon: "hr", label: t("Horizontal line"), disabled: off, onClick: run("hr") }),
      h(Divider),
      h(Tool, { icon: "comment", label: t("Comment"), keys: `${mod}+Alt+M`, disabled: off || !f.selected, onClick: onComment }, h("span", null, t("Comment"))),
      linking &&
        h(LinkBox, {
          onDone: (href) => {
            setLinking(false);
            onCommand("link", href);
          },
          onCancel: () => {
            setLinking(false);
            onFocusText?.();
          },
        }),
    );
  };
}
