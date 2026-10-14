/**
 * A document on the Documents page, edited: the editor (editor.js, loaded when
 * a document is first opened), saved as it is edited (saver.js), and the
 * document's history with a way back to an earlier revision.
 *
 * Plain JavaScript like the rest of the browser half, made with the portal's
 * React and building blocks (`portal.ui`).
 */
import { createSaver } from "./saver.js";

/** What the person's text was, kept while it is not saved (a conflict, a save that failed, a page that went away): per document, for the tab. */
const DRAFT = "pithagoras-docs/draft";

export function documentEditor(portal, { documentUrl, when, useAnswer }) {
  const { React, ui, t } = portal;
  const { useEffect, useRef, useState } = React;
  const h = React.createElement;

  /** The editor's module, loaded once and when first wanted; one that failed to load is asked for again. */
  let bundle = null;
  const loadEditor = () =>
    (bundle ??= import("./editor.js").catch((e) => {
      bundle = null;
      throw e;
    }));

  const draftKey = (folder, id) => `${DRAFT}/${folder}/${id}`;
  function readDraft(folder, id) {
    try {
      const draft = JSON.parse(ui.storage.session.get(draftKey(folder, id)) || "null");
      return draft && typeof draft.markdown === "string" && Number.isInteger(draft.base) ? draft : null;
    } catch {
      return null;
    }
  }
  const keepDraft = (folder, id, draft) => ui.storage.session.set(draftKey(folder, id), JSON.stringify(draft));
  const dropDraft = (folder, id) => ui.storage.session.remove(draftKey(folder, id));

  const WHO = () => ({ user: t("You"), agent: t("The agent"), external: t("Outside the page") });
  /** What a revision was besides who made it: a save is nothing more. */
  function whatOf(revision) {
    if (revision.kind === "restore") return t("Restored from revision {n}", { n: revision.restoredFrom });
    if (revision.kind === "create") return t("Created");
    if (revision.kind === "adopted") return t("Existing file");
    return "";
  }

  /** The revisions of a document, newest first, and any of them read and brought back. */
  function History({ folder, id, current, busy, onRestore }) {
    const url = documentUrl(folder, id);
    const [list, setList] = useState({ items: [], more: false });
    const [error, setError] = useState(null);
    const [loaded, setLoaded] = useState(false);
    const [asked, setAsked] = useState(0);
    // The revision looked at: its number, and its text once it is there.
    const [shown, setShown] = useState(null);
    const here = useRef(true);
    useEffect(() => {
      here.current = true;
      return () => void (here.current = false);
    }, []);

    // Again whenever the document moves on (a save, a restore): the first page, which is where the new revision is.
    useEffect(() => {
      let fresh = true;
      setError(null);
      portal.api.json(`${url}/history?limit=50`).then(
        (body) => fresh && (setList({ items: body.revisions, more: body.more }), setLoaded(true)),
        (e) => fresh && (setError(e), setLoaded(true)),
      );
      return () => void (fresh = false);
    }, [url, current, asked]);

    const older = () => {
      const before = list.items.at(-1)?.revision;
      portal.api.json(`${url}/history?limit=50&before=${before}`).then(
        (body) => here.current && setList((now) => ({ items: [...now.items, ...body.revisions], more: body.more })),
        (e) => here.current && setError(e),
      );
    };

    const look = (revision) => {
      setShown({ revision });
      portal.api.json(`${url}/revisions/${revision}`).then(
        (body) => here.current && setShown((now) => (now?.revision === revision ? { revision, markdown: body.markdown } : now)),
        (e) => here.current && setShown((now) => (now?.revision === revision ? { revision, error: e.message } : now)),
      );
    };

    return h(
      "section",
      { className: "pd-history", "aria-label": t("History") },
      error && !list.items.length
        ? h(ui.LoadFailed, { error, onRetry: () => setAsked((n) => n + 1) })
        : !loaded
          ? h(ui.RowsSkeleton, { rows: 3, label: t("Loading…") })
          : h(
              React.Fragment,
              null,
              h(
                "ul",
                { className: "pd-revisions" },
                list.items.map((revision) =>
                  h(
                    "li",
                    { key: revision.revision },
                    h(
                      "button",
                      { type: "button", "aria-pressed": shown?.revision === revision.revision, onClick: () => look(revision.revision) },
                      h("span", { className: "pd-title" }, t("Revision {n}", { n: revision.revision }), revision.revision === current && h("span", { className: "pd-current" }, t("Current"))),
                      h("span", { className: "pd-meta" }, [WHO()[revision.author] ?? revision.author, whatOf(revision), when(revision.at)].filter(Boolean).join(" · ")),
                    ),
                  ),
                ),
              ),
              list.more && h("button", { type: "button", className: ui.classes.ghost, onClick: older }, t("Show older revisions")),
            ),
      shown &&
        h(
          "div",
          { className: "pd-preview" },
          h(
            "div",
            { className: "pd-preview-bar" },
            h("strong", null, t("Revision {n}", { n: shown.revision })),
            shown.revision === current
              ? h("span", { className: "pd-meta" }, t("This is the current revision."))
              : h("button", { type: "button", className: ui.classes.primarySmall, disabled: busy || shown.markdown === undefined, onClick: async () => (await onRestore(shown)) && here.current && setShown(null) }, t("Restore this revision")),
            h("button", { type: "button", className: ui.classes.ghost, onClick: () => setShown(null) }, t("Close")),
          ),
          shown.error
            ? h(ui.ErrorBanner, null, shown.error)
            : shown.markdown === undefined
              ? h(ui.RowsSkeleton, { rows: 3, label: t("Loading…") })
              : shown.markdown.trim()
                ? h("div", { className: "pd-body" }, h(ui.Markdown, null, shown.markdown))
                : h(ui.Empty, null, t("This document is empty.")),
        ),
    );
  }

  /** The document in the editor: saved as it is edited, with what to do when it was changed meanwhile. */
  function Editing({ folder, id, doc, edit, onBack }) {
    const host = useRef(null);
    // The editor and its saver, once the editor is drawn.
    const parts = useRef(null);
    const [view, setView] = useState({ status: "saved", base: doc.revision, error: null, conflict: null, warning: null });
    const [ready, setReady] = useState(false);
    const [broken, setBroken] = useState(null);
    const [notice, setNotice] = useState(null);
    const [problem, setProblem] = useState(null);
    const [history, setHistory] = useState(false);
    const [busy, setBusy] = useState(false);

    useEffect(() => {
      const mount = document.createElement("div");
      host.current.append(mount);
      const url = documentUrl(folder, id);
      let editor = null;
      let gone = false;
      // The text once the editor is gone: what a save that is still on its way sends.
      let frozen = null;
      // The page is being closed: a save then has to outlive it.
      let leaving = false;
      const read = () => frozen ?? editor.markdown();
      const saver = createSaver({
        read,
        send: (markdown, base) => portal.api.json(url, { method: "PUT", body: JSON.stringify({ markdown, base }), keepalive: leaving }),
        onState: (state) => {
          // Kept while it cannot be saved, and let go once it is, also when the page is gone by then.
          if (state.status === "conflict" || state.status === "error") keepDraft(folder, id, { base: state.base, markdown: read() });
          else if (state.status === "saved") dropDraft(folder, id);
          setView(state);
        },
      });
      const save = () => void saver.flush();
      const hide = () => {
        leaving = true;
        if (!editor) return;
        if (saver.unsaved()) keepDraft(folder, id, { base: saver.state().base, markdown: read() });
        save();
      };
      const returned = () => void (leaving = false);
      const hidden = () => document.visibilityState === "hidden" && editor && save();
      // Closing the page with text that cannot be saved asks first; text that autosave is on its way with does not.
      const ask = (e) => {
        const { status } = saver.state();
        if (status === "conflict" || status === "error") e.preventDefault();
      };
      const key = (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
          e.preventDefault();
          save();
        }
      };
      window.addEventListener("pagehide", hide);
      window.addEventListener("pageshow", returned);
      window.addEventListener("beforeunload", ask);
      document.addEventListener("visibilitychange", hidden);
      mount.addEventListener("focusout", save);
      mount.addEventListener("keydown", key);

      (async () => {
        try {
          editor = await edit.createEditor({ root: mount, markdown: doc.markdown, onChange: () => saver.changed() });
        } catch (e) {
          if (!gone) setBroken(e);
          return;
        }
        if (gone) return void editor.destroy();
        // What an earlier visit left unsaved, read before the document is taken as it stands (that forgets it).
        const kept = readDraft(folder, id);
        saver.adopt(doc.revision, editor.markdown());
        if (kept && kept.markdown !== editor.markdown()) {
          editor.replace(kept.markdown);
          keepDraft(folder, id, kept);
          // Written on the revision the document is at: saved as it is. On another one: the document was changed since, and the person chooses.
          if (kept.base === doc.revision) saver.changed();
          else saver.conflicted({ revision: doc.revision, markdown: doc.markdown }, kept.base);
          setNotice({ kind: "draft" });
        }
        parts.current = { editor, saver, url };
        setReady(true);
      })();

      return () => {
        gone = true;
        window.removeEventListener("pagehide", hide);
        window.removeEventListener("pageshow", returned);
        window.removeEventListener("beforeunload", ask);
        document.removeEventListener("visibilitychange", hidden);
        if (editor) {
          frozen = editor.markdown();
          // Leaving the page is not a reason to lose text: it is saved now, and if it cannot be, kept (the saver's state says so).
          void saver.flush();
          void editor.destroy();
        } else saver.dispose();
        parts.current = null;
        mount.remove();
      };
    }, [folder, id]);

    /** Back to the list, once what was typed is saved: with text that cannot be, the page stays and says why. */
    const leave = async () => {
      if (!parts.current || (await parts.current.saver.flush())) onBack();
    };

    const takeTheirs = async () => {
      const ok = await ui.confirm({
        title: t("Take the other version?"),
        message: t("The text you have not saved is discarded, and the version that was saved meanwhile is shown instead."),
        confirmLabel: t("Take theirs"),
        danger: true,
      });
      const { editor, saver } = parts.current;
      const { conflict } = saver.state();
      if (!ok || !conflict) return;
      editor.replace(conflict.markdown);
      saver.adopt(conflict.revision, editor.markdown());
      setNotice(null);
    };

    /** Brings an earlier revision back as a new one. True once it is. */
    const restore = async ({ revision, markdown }) => {
      const { editor, saver, url } = parts.current;
      setBusy(true);
      setProblem(null);
      try {
        // Text not saved yet is saved first: it becomes a revision of its own, to go back to. A conflict or a failure is dealt with before this.
        if (!(await saver.flush())) return false;
        try {
          const done = await portal.api.json(`${url}/restore`, { method: "POST", body: JSON.stringify({ revision, base: saver.state().base }) });
          editor.replace(markdown);
          saver.adopt(done.revision, editor.markdown());
          setNotice({ kind: "restored", from: revision, to: done.revision });
          return true;
        } catch (e) {
          if (e.status !== 409 || !Number.isInteger(e.body?.revision)) throw e;
          // Changed since the page last saved or loaded it: shown as it is now, and the person asks again if it is still wanted.
          editor.replace(e.body.markdown ?? "");
          saver.adopt(e.body.revision, editor.markdown());
          setNotice({ kind: "moved", revision: e.body.revision, from: revision });
          return false;
        }
      } catch (e) {
        setProblem(e.message);
        return false;
      } finally {
        setBusy(false);
      }
    };

    const { status, base, conflict, error, warning } = view;
    const label = { saved: t("Saved"), dirty: t("Unsaved changes"), saving: t("Saving…"), conflict: t("Not saved"), error: t("Not saved") }[status];
    return h(
      React.Fragment,
      null,
      h(
        "div",
        { className: "pd-bar" },
        h("button", { type: "button", className: "pd-back", onClick: leave }, `← ${t("All documents")}`),
        h(
          "div",
          { className: "pd-bar-end" },
          h("span", { className: "pd-state", "data-status": status, "aria-live": "polite" }, `${label} · ${t("Revision {n}", { n: base })}`),
          h("button", { type: "button", className: ui.classes.ghost, "aria-expanded": history, disabled: !ready, onClick: () => setHistory((on) => !on) }, history ? t("Hide history") : t("History")),
        ),
      ),
      // Where it is, not when it changed: that was when the page opened it, and the history has the times.
      h("p", { className: "pd-meta" }, `documents/${doc.name}`),
      conflict &&
        h(
          "div",
          { className: "pd-conflict", role: "alert" },
          h("p", null, t("This document changed while you were editing it, and is now at revision {n}. Your text is kept here and has not been saved.", { n: conflict.revision })),
          h(
            "div",
            { className: "pd-actions" },
            h("button", { type: "button", className: ui.classes.primarySmall, onClick: () => void parts.current.saver.keepMine() }, t("Keep mine as a new revision")),
            h("button", { type: "button", className: ui.classes.button, onClick: takeTheirs }, t("Take theirs")),
          ),
          h("details", null, h("summary", null, t("Show the other version")), conflict.markdown.trim() ? h("div", { className: "pd-body" }, h(ui.Markdown, null, conflict.markdown)) : h("p", { className: "pd-meta" }, t("This document is empty."))),
        ),
      status === "error" && h(ui.ErrorBanner, null, h("span", null, t("Could not save: {error}", { error })), " ", h("button", { type: "button", className: ui.classes.ghost, onClick: () => void parts.current.saver.flush() }, t("Try again"))),
      problem && h(ui.ErrorBanner, { onClose: () => setProblem(null) }, t("Could not restore: {error}", { error: problem })),
      warning && h(ui.WarnBanner, { onClose: () => parts.current?.saver.dismissWarning() }, warning),
      notice &&
        h(
          "div",
          { className: "pd-note", role: "status" },
          h(
            "span",
            null,
            {
              draft: () => t("Text you had not saved was brought back."),
              restored: () => t("Revision {from} is back, as revision {to}.", { from: notice.from, to: notice.to }),
              moved: () => t("The document changed in the meantime and is now at revision {n}. Restore revision {from} again if you still want it.", { n: notice.revision, from: notice.from }),
            }[notice.kind](),
          ),
          h("button", { type: "button", className: ui.classes.ghost, onClick: () => setNotice(null) }, t("Close")),
        ),
      history && ready && h(History, { folder, id, current: base, busy, onRestore: restore }),
      broken && h(ui.ErrorBanner, null, t("The editor could not be loaded: {error}", { error: broken.message })),
      !ready && !broken && h(ui.RowsSkeleton, { rows: 4, label: t("Loading…") }),
      h("div", { ref: host, className: "pd-editor", hidden: !ready }),
    );
  }

  /** A document of a folder, for reading and writing. Without the editor (it could not be loaded) it is read as the portal draws Markdown. */
  return function DocumentEditor({ folder, id, onBack }) {
    const { body, error, retry } = useAnswer(documentUrl(folder, id));
    const [edit, setEdit] = useState(null);
    const [failed, setFailed] = useState(null);
    const [attempt, setAttempt] = useState(0);
    useEffect(() => {
      let here = true;
      setFailed(null);
      loadEditor().then(
        (module) => here && setEdit(module),
        (e) => here && setFailed(e),
      );
      return () => void (here = false);
    }, [attempt]);

    const back = h("button", { type: "button", className: "pd-back", onClick: onBack }, `← ${t("All documents")}`);
    if (error) return h("article", { className: "pd-document" }, back, h(ui.LoadFailed, { error, onRetry: retry }));
    if (!body || (!edit && !failed)) return h("article", { className: "pd-document" }, back, h(ui.RowsSkeleton, { rows: 4, label: t("Loading…") }));
    if (failed) {
      return h(
        "article",
        { className: "pd-document" },
        back,
        h(ui.LoadFailed, { error: t("The editor could not be loaded: {error}", { error: failed.message }), onRetry: () => setAttempt((n) => n + 1) }),
        h("p", { className: "pd-meta" }, `documents/${body.name} · ${t("Changed {date}", { date: when(body.modified) })}`),
        body.markdown.trim() ? h("div", { className: "pd-body" }, h(ui.Markdown, null, body.markdown)) : h(ui.Empty, null, t("This document is empty.")),
      );
    }
    return h("article", { className: "pd-document" }, h(Editing, { folder, id, doc: body, edit, onBack }));
  };
}
