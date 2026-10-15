/**
 * The comments of a document on the Documents page: the list of threads beside
 * the editor, a thread with its comments and the boxes to answer it, and the box
 * a new comment is written in. Plain JavaScript like the rest of the browser
 * half, made with the portal's React and building blocks (`portal.ui`).
 *
 * It holds no data of its own: the page (document-editor.js) fetches the
 * threads, tells the editor where their passages are, and hands both over, with
 * what to do when a comment is written, answered, resolved or opened again.
 */

/** The most characters of the text of a passage a card shows. */
const SHOWN_CHARS = 240;

/** `text` cut to what a card shows. */
const short = (text) => (text.length > SHOWN_CHARS ? `${text.slice(0, SHOWN_CHARS)}…` : text);

export function comments(portal, { when }) {
  const { React, ui, t } = portal;
  const { useEffect, useRef, useState } = React;
  const h = React.createElement;

  const WHO = () => ({ user: t("You"), agent: t("The agent") });

  /** A box to write in: Ctrl+Enter (or Cmd+Enter) sends it. */
  function Writing({ value, onChange, onSend, label, placeholder, disabled, autoFocus }) {
    const box = useRef(null);
    useEffect(() => {
      if (autoFocus) box.current?.focus();
    }, [autoFocus]);
    return h("textarea", {
      ref: box,
      className: `${ui.classes.input} pd-write`,
      rows: 3,
      value,
      disabled,
      placeholder,
      "aria-label": label,
      maxLength: 4000,
      onChange: (e) => onChange(e.target.value),
      onKeyDown: (e) => {
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && value.trim()) {
          e.preventDefault();
          onSend();
        }
      },
    });
  }

  /** The words a passage is on: what it reads as in the text, or the Markdown it was kept as. */
  const Passage = ({ text, onClick }) =>
    h(
      onClick ? "button" : "blockquote",
      { type: onClick ? "button" : undefined, className: "pd-quote", onClick, title: onClick ? t("Show in the text") : undefined },
      short(text),
    );

  /** One thread: its passage, its comments in the order they were made, and what can be done with it. */
  function Thread({ thread, text, marked, settled, active, onActivate, onReply, onResolve, onReopen }) {
    const [draft, setDraft] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    const open = thread.status === "open";
    const here = useRef(true);
    useEffect(() => {
      here.current = true;
      return () => void (here.current = false);
    }, []);

    /** Does `work`, and clears the box if it went through; if not, says why and keeps what was written. */
    const run = async (work) => {
      setBusy(true);
      setError(null);
      try {
        await work();
        if (here.current) setDraft("");
      } catch (e) {
        if (here.current) setError(e.message);
      } finally {
        if (here.current) setBusy(false);
      }
    };
    const reply = () => run(() => onReply(thread, draft.trim()));
    const resolve = () => run(() => onResolve(thread, draft.trim()));
    const reopen = () => run(() => onReopen(thread));
    // Where the thread stands with the agent: asked and not answered yet, or answered and not reacted to.
    const asked = thread.answered
      ? t("The agent answered")
      : thread.toAgent
        ? thread.ping?.sent === false
          ? t("Not delivered to the agent")
          : [t("Asked the agent"), thread.ping?.title].filter(Boolean).join(" · ")
        : null;

    return h(
      "article",
      { className: "pd-thread-card", "data-thread": thread.id, "data-status": thread.status, "aria-current": active ? "true" : undefined, "aria-label": t("Comment thread") },
      h(Passage, { text: text ?? thread.quote, onClick: marked ? () => onActivate(thread.id) : undefined }),
      thread.orphaned && h("p", { className: "pd-meta pd-gone" }, t("The passage this comment was on is no longer in the document.")),
      !thread.orphaned && !marked && settled && open && h("p", { className: "pd-meta pd-gone" }, t("The passage could not be marked in the text.")),
      open && asked && h("p", { className: "pd-meta pd-asked", "data-asked": thread.answered ? "answered" : "waiting" }, asked),
      !open && h("p", { className: "pd-meta" }, t("Resolved")),
      h(
        "ol",
        { className: "pd-comments" },
        thread.comments.map((comment) =>
          h(
            "li",
            { key: comment.id, "data-author": comment.author },
            h("div", { className: "pd-comment-head" }, h("strong", null, WHO()[comment.author] ?? comment.author), h("span", { className: "pd-meta" }, when(comment.at))),
            h("div", { className: "pd-comment-body" }, h(ui.Markdown, null, comment.body)),
          ),
        ),
      ),
      error && h(ui.ErrorBanner, { onClose: () => setError(null) }, t("Could not comment: {error}", { error })),
      open
        ? h(
            "div",
            { className: "pd-reply" },
            h(Writing, { value: draft, onChange: setDraft, onSend: reply, label: t("Reply"), placeholder: t("Reply…"), disabled: busy }),
            h(
              "div",
              { className: "pd-actions" },
              h("button", { type: "button", className: ui.classes.primarySmall, disabled: busy || !draft.trim(), onClick: reply }, t("Reply")),
              h("button", { type: "button", className: ui.classes.button, disabled: busy, onClick: resolve }, draft.trim() ? t("Reply and resolve") : t("Resolve")),
            ),
          )
        : h("div", { className: "pd-actions" }, h("button", { type: "button", className: ui.classes.button, disabled: busy, onClick: reopen }, t("Reopen"))),
    );
  }

  /** The box a new comment is written in, with the words it is on. */
  function Compose({ compose, onChange, onSend, onCancel }) {
    return h(
      "section",
      { className: "pd-thread-card pd-compose", "aria-label": t("New comment") },
      h("strong", null, t("New comment")),
      h(Passage, { text: compose.passage.text }),
      h(Writing, { value: compose.body, onChange, onSend, label: t("Write a comment"), placeholder: t("Write a comment…"), disabled: compose.busy, autoFocus: true }),
      compose.error && h(ui.ErrorBanner, null, t("Could not comment: {error}", { error: compose.error })),
      h(
        "div",
        { className: "pd-actions" },
        h("button", { type: "button", className: ui.classes.primarySmall, disabled: compose.busy || !compose.body.trim(), onClick: onSend }, t("Add comment")),
        h("button", { type: "button", className: ui.classes.ghost, disabled: compose.busy, onClick: onCancel }, t("Cancel")),
      ),
    );
  }

  /**
   * The panel: `threads` as the server has them (document order, open ones first), `texts` what the marked passages read as
   * by thread id (`settled`: the editor has been asked to mark these threads, so one that is not marked cannot be), `error` why they could
   * not be fetched. `compose` is the comment being written, if one is.
   */
  return function Comments({ threads, loaded, error, texts, settled, active, compose, onRetry, onActivate, onCompose, onReply, onResolve, onReopen }) {
    const [resolved, setResolved] = useState(false);
    const open = threads.filter((thread) => thread.status === "open");
    const closed = threads.filter((thread) => thread.status !== "open");
    // Asked to see the resolved ones, for as long as there are some: the next one to be resolved is out of the way again.
    useEffect(() => {
      if (!closed.length) setResolved(false);
    }, [closed.length]);
    const list = resolved ? [...open, ...closed] : open;
    const body = (thread) =>
      h(Thread, { key: thread.id, thread, text: texts.get(thread.id), marked: texts.has(thread.id), settled, active: active === thread.id, onActivate, onReply, onResolve, onReopen });
    return h(
      "aside",
      { className: "pd-threads", "aria-label": t("Comments") },
      h("h2", null, t("Comments"), open.length > 0 && h("span", { className: "pd-count" }, open.length)),
      h("p", { className: "pd-hint" }, t("Write @agent in a comment to ask the agent to answer it.")),
      compose && h(Compose, { compose, onChange: (value) => onCompose({ ...compose, body: value }), onSend: () => onCompose(compose, true), onCancel: () => onCompose(null) }),
      error && !loaded
        ? h(ui.LoadFailed, { error: t("Comments could not be loaded: {error}", { error: error.message }), onRetry })
        : !loaded
          ? h(ui.RowsSkeleton, { rows: 2, label: t("Loading…") })
          : h(
              "div",
              { className: "pd-thread-list", "aria-live": "polite" },
              !threads.length && !compose && h("p", { className: "pd-hint" }, t("No comments yet. Select some text, then press Comment.")),
              list.map(body),
              closed.length > 0 &&
                h("button", { type: "button", className: `${ui.classes.ghost} pd-more`, "aria-expanded": resolved, onClick: () => setResolved((on) => !on) }, resolved ? t("Hide resolved") : t("Show resolved ({n})", { n: closed.length })),
            ),
    );
  };
}
