/**
 * The small form a document's file name is changed in, on the list (a row) and on the page of a document (under its bar), and what the
 * two share of renaming and deleting: what the person writes is the name without `.md` (which is added, as the file has it: `.MD` stays `.MD`, so
 * that a form that was not changed is not a rename to another name), the server says if it is not one
 * (a name that is taken, or not a document's), and the form stays open with the reason under the field.
 *
 * What a document is called has two parts that are not the same thing: its title, which is its first heading (changed in the text), and
 * the name of its file, documents/<name>.md, which this changes. The form says so under the field.
 */

/** The file name `name` as it is written in the field: without its `.md`. */
export const stemOf = (name) => String(name ?? "").replace(/\.md$/i, "");

/** The extension `name` has, as it is written (`.md`, or `.MD` for an uploaded file that has it so): a rename keeps it, so that the field can be left as it is. */
export const extOf = (name) => /\.md$/i.exec(String(name ?? ""))?.[0] ?? ".md";

/**
 * Whether a failed request says that the document is gone: the answer of the server half to a document it has no more (`code: "deleted"`), which
 * a 404 alone is not: the portal answers 404 too for a route of a server half that is not running (it starts after the portal, and again after an
 * update), and for a folder no chat works in. Taking those for a deletion would stop a page from saving a document that is there.
 */
export const wasDeleted = (error) => error?.status === 404 && error?.body?.code === "deleted";

export function renaming(portal) {
  const { React, ui, t } = portal;
  const { useEffect, useRef, useState } = React;
  const h = React.createElement;

  /**
   * `name`: the file's name now. `onSubmit(name)` is given the whole new file name (`x.md`) and resolves once it is done, or rejects with why
   * not (its message is said under the field). `onCancel`: Escape, or the button. `compact`: in a row of a list, not under the bar.
   */
  function RenameForm({ name, onSubmit, onCancel, compact = false }) {
    const [value, setValue] = useState(stemOf(name));
    const ext = extOf(name);
    const [busy, setBusy] = useState(false);
    const [problem, setProblem] = useState(null);
    const input = useRef(null);
    useEffect(() => {
      // The name without its extension is what is meant to change: it is selected, and the extension is not in the field.
      input.current?.focus();
      input.current?.select();
    }, []);
    // What the person wrote, as it is kept: trimmed, and without an `.md` of their own (the one that is added is the file's own, whatever case it is in).
    // One `.md` only, and none from a field that was not changed: `plan.md.md` is opened as `plan.md` and a form left alone is not a rename to `plan.md`.
    const written = value.trim();
    const stem = written === stemOf(name) ? written : written.replace(/\.md$/i, "").trim();
    const submit = async (e) => {
      e.preventDefault();
      if (!stem || busy) return;
      // The same name asks for nothing: the field as it was opened (a name with `.MD` is not another name for being written with `.md`).
      if (stem === stemOf(name)) return onCancel();
      setBusy(true);
      setProblem(null);
      try {
        await onSubmit(`${stem}${ext}`);
      } catch (error) {
        setProblem(error?.message || String(error));
        setBusy(false);
      }
    };
    // The field has the focus again once it can (a field that is off has none): with the reason under it, to be changed.
    useEffect(() => {
      if (problem) input.current?.focus();
    }, [problem]);
    return h(
      "form",
      {
        className: `pd-rename${compact ? " pd-rename-row" : ""}`,
        "aria-label": t("Rename {name}", { name }),
        onSubmit: submit,
        // Escape closes the form and nothing around it (a menu, the page).
        onKeyDown: (e) => {
          if (e.key !== "Escape") return;
          e.preventDefault();
          e.stopPropagation();
          onCancel();
        },
      },
      h(
        "div",
        { className: "pd-rename-field" },
        h("span", { className: "pd-meta", "aria-hidden": true }, "documents/"),
        h("input", {
          ref: input,
          className: `${ui.classes.inputSmall} pd-rename-input`,
          value,
          maxLength: 251,
          spellCheck: false,
          autoComplete: "off",
          disabled: busy,
          "aria-label": t("New file name for {name}", { name }),
          "aria-invalid": problem ? true : undefined,
          onChange: (e) => {
            setValue(e.target.value);
            setProblem(null);
          },
        }),
        h("span", { className: "pd-meta", "aria-hidden": true }, ext),
        h("button", { type: "submit", className: ui.classes.primarySmall, disabled: busy || !stem }, t("Rename")),
        h("button", { type: "button", className: ui.classes.button, disabled: busy, onClick: onCancel }, t("Cancel")),
      ),
      h("p", { className: "pd-meta pd-rename-hint" }, t("This renames the file. The title is the document's first heading: change it in the text.")),
      problem && h("p", { className: "pd-rename-problem", role: "alert" }, problem),
    );
  }

  return { RenameForm };
}
