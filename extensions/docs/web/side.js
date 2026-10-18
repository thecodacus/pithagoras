/**
 * The panel at the right edge of a document that the bar's Comments and History open: one shell for both, so that they look, sit
 * and behave alike. It has a heading (with a count where there is one) and Close, and holds what the panel is about. Only one is
 * open at a time (document-editor.js). Escape closes it from within, and the bar button it was opened from has the focus then.
 * Its place (beside the text where the page is wide, over it where it is not) is in client.css.
 */
export function sidePanel(portal) {
  const { React, ui, t } = portal;
  const h = React.createElement;

  /** `kind` names the panel for the page's styles and tests; `onClose` is told whether the opener is to have the focus back. */
  return function SidePanel({ kind, title, count, onClose, children }) {
    return h(
      "aside",
      {
        className: `pd-side pd-side-${kind}`,
        "aria-label": title,
        "data-panel": kind,
        onKeyDown: (e) => {
          // A key of something inside that already used the Escape (a box giving up what was typed) is not a request to close.
          if (e.key !== "Escape" || e.defaultPrevented) return;
          e.preventDefault();
          onClose({ focus: true });
        },
      },
      h(
        "div",
        { className: "pd-list-head" },
        h("h2", null, title, count > 0 && h("span", { className: "pd-count" }, count)),
        h("button", { type: "button", className: `${ui.classes.ghost} pd-act`, onClick: () => onClose({ focus: true }) }, t("Close")),
      ),
      children,
    );
  };
}
