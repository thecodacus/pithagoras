/**
 * The comments of a document on the Documents page: the list of threads beside
 * the editor, a thread with its comments and the box a comment is written in. A
 * comment is saved as it is typed (draft.js), as the document is, with no button
 * to send it: the box is the comment while it is the last of its thread, and the
 * comment is in the list of comments once the box is let go (Ctrl+Enter) or is
 * answered. Plain JavaScript like the rest of the browser half, made with the
 * portal's React and building blocks (`portal.ui`).
 *
 * It holds no data of its own: the page (document-editor.js) fetches the
 * threads, tells the editor where their passages are, and hands both over, with
 * what to do when a comment is saved, taken away, resolved or opened again.
 */
import { createDraft } from "./draft.js";

/** The most characters of the text of a passage a card shows. */
const SHOWN_CHARS = 240;

/** `text` cut to what a card shows. */
const short = (text) => (text.length > SHOWN_CHARS ? `${text.slice(0, SHOWN_CHARS)}…` : text);

export function comments(portal, { when }) {
  const { React, ui, t } = portal;
  const { useEffect, useRef, useState } = React;
  const h = React.createElement;

  const WHO = () => ({ user: t("You"), agent: t("The agent") });

  /** The box a comment is typed in: Ctrl+Enter (or Cmd+Enter) lets it go, and what was typed is saved first. */
  function Writing({ value, onChange, onBlur, onDone, label, placeholder, autoFocus }) {
    const box = useRef(null);
    useEffect(() => {
      if (autoFocus) box.current?.focus();
    }, [autoFocus]);
    return h("textarea", {
      ref: box,
      className: `${ui.classes.input} pd-write`,
      rows: 3,
      value,
      placeholder,
      "aria-label": label,
      maxLength: 4000,
      onChange: (e) => onChange(e.target.value),
      onBlur,
      onKeyDown: (e) => {
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && value.trim()) {
          e.preventDefault();
          onDone();
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

  /** What the box says of the comment it holds: saved, being saved, or why it was not. */
  function Saved({ draft }) {
    if (draft.error) return h("p", { className: "pd-meta pd-gone", role: "alert" }, t("Could not comment: {error}", { error: draft.error.message }));
    if (draft.saving) return h("p", { className: "pd-meta" }, t("Saving…"));
    return draft.id ? h("p", { className: "pd-meta" }, t("Saved")) : null;
  }

  /**
   * One thread: its passage, its comments in the order they were made, and the box to write the next in. `composing` is the
   * card of a comment that is being written on a passage: with no thread yet (`thread.id` is null) until the first thing typed
   * is saved, which makes it, and then it is the thread's card as any other.
   */
  function Thread({ thread, text, marked, settled, active, composing, onActivate, onWrite, onClear, onFinish, onCancel, onResolve, onReopen, onSeen }) {
    const [value, setValue] = useState("");
    const [draft, setDraft] = useState({ id: null, saving: false, error: null });
    const [error, setError] = useState(null);
    const open = thread.status === "open";
    // What the box saves with, as it is now: the box lives on through the thread's being made and changed.
    const now = useRef(null);
    now.current = { thread, onWrite, onClear };
    // The thread the box's first save made. The card has it as a prop only after it is drawn again, which is later than the save that
    // follows the first (text typed meanwhile) or the removal that follows it (Cancel meanwhile): those have to go to this thread.
    const made = useRef(null);
    const here = () => (now.current.thread.id ? now.current.thread : { ...now.current.thread, id: made.current });
    const typed = useRef(null);
    typed.current ??= createDraft({
      save: async (words, id) => {
        const saved = await now.current.onWrite(here(), words, id);
        made.current = saved.thread;
        return saved.comment;
      },
      remove: async (id) => {
        if ((await now.current.onClear(here(), id)) === "thread") made.current = null;
      },
      onState: setDraft,
    });
    // What was typed is saved when the card goes.
    useEffect(() => () => void typed.current.flush(), []);
    const mounted = useRef(true);
    useEffect(() => {
      mounted.current = true;
      return () => void (mounted.current = false);
    }, []);

    /** Does `work`, and says why if it did not go through. */
    const run = async (work) => {
      setError(null);
      try {
        await work();
      } catch (e) {
        if (mounted.current) setError(e.message);
      }
    };
    /** The comment typed is let go: the box is empty for the next one, and this one is in the list. */
    const done = () =>
      run(async () => {
        if (!(await typed.current.settle())) return;
        if (mounted.current) setValue("");
        if (composing) onFinish(here());
      });
    // Somebody else said something after the comment in the box (the agent answered it): it is let go, and the box is for the next.
    useEffect(() => {
      const last = thread.comments.at(-1);
      if (draft.id && last && last.id !== draft.id && last.author !== "user") void done();
    }, [thread.comments.length, draft.id]);
    const resolve = () =>
      run(async () => {
        if (await typed.current.settle()) await onResolve(thread);
      });
    const cancel = () =>
      run(async () => {
        if (await typed.current.discard()) onCancel();
      });
    // Where the thread stands with the agent: asked and not answered yet, or answered and not reacted to.
    const asked = thread.answered
      ? t("The agent answered")
      : thread.toAgent && open
        ? thread.ping?.state === "failed"
          ? [t("Not delivered to the agent"), thread.ping.error].filter(Boolean).join(" · ")
          : [t("Asked the agent"), thread.ping?.title].filter(Boolean).join(" · ")
        : null;

    return h(
      "article",
      {
        className: `pd-thread-card${composing ? " pd-compose" : ""}`,
        "data-thread": thread.id ?? undefined,
        "data-status": thread.status,
        "aria-current": active ? "true" : undefined,
        "aria-label": composing ? t("New comment") : t("Comment thread"),
      },
      composing && !thread.id && h("strong", null, t("New comment")),
      h(Passage, { text: text ?? thread.quote, onClick: marked ? () => onActivate(thread.id) : undefined }),
      thread.orphaned && h("p", { className: "pd-meta pd-gone" }, t("The passage this comment was on is no longer in the document.")),
      !thread.orphaned && !marked && settled && open && thread.id && !composing && h("p", { className: "pd-meta pd-gone" }, t("The passage could not be marked in the text.")),
      asked &&
        h(
          "p",
          { className: "pd-meta pd-asked", "data-asked": thread.answered ? "answered" : "waiting" },
          asked,
          thread.answered && h("button", { type: "button", className: `${ui.classes.ghost} pd-seen`, onClick: () => run(() => onSeen(thread)) }, t("Got it")),
        ),
      !open && h("p", { className: "pd-meta" }, t("Resolved")),
      h(
        "ol",
        { className: "pd-comments" },
        // The comment in the box is not in the list as well.
        thread.comments
          .filter((comment) => comment.id !== draft.id)
          .map((comment) =>
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
            h(Writing, {
              value,
              onChange: (next) => {
                setValue(next);
                typed.current.changed(next);
              },
              onBlur: () => void typed.current.flush(),
              onDone: done,
              label: composing ? t("Write a comment") : t("Reply"),
              placeholder: composing ? t("Write a comment…") : t("Reply…"),
              autoFocus: composing,
            }),
            // The buttons above what is said of the saving, which comes and goes: they do not move under a click.
            h(
              "div",
              { className: "pd-actions" },
              composing
                ? h("button", { type: "button", className: ui.classes.ghost, onClick: cancel }, t("Cancel"))
                : h("button", { type: "button", className: ui.classes.button, onClick: resolve }, t("Resolve")),
            ),
            h(Saved, { draft }),
          )
        : h("div", { className: "pd-actions" }, h("button", { type: "button", className: ui.classes.button, onClick: () => run(() => onReopen(thread)) }, t("Reopen"))),
    );
  }

  /**
   * The panel: `threads` as the server has them (document order, open ones first), `texts` what the marked passages read as
   * by thread id (`settled`: the editor has been asked to mark these threads, so one that is not marked cannot be), `error` why they could
   * not be fetched. `compose` is the comment being written on a passage, if one is: its `threadId` is the thread its first save
   * made, which is its card and not one of the list's.
   */
  return function Comments({ threads, loaded, error, texts, settled, active, compose, onRetry, onActivate, onWrite, onClear, onFinish, onCancel, onResolve, onReopen, onSeen }) {
    const [resolved, setResolved] = useState(false);
    const listed = threads.filter((thread) => thread.id !== compose?.threadId);
    const open = listed.filter((thread) => thread.status === "open");
    // A thread the agent resolved is news until the person has seen it: it is not put away with the others.
    const news = listed.filter((thread) => thread.status !== "open" && thread.answered);
    const closed = listed.filter((thread) => thread.status !== "open" && !thread.answered);
    // Asked to see the resolved ones, for as long as there are some: the next one to be resolved is out of the way again.
    useEffect(() => {
      if (!closed.length) setResolved(false);
    }, [closed.length]);
    const list = resolved ? listed : [...open, ...news];
    const card = (thread) =>
      h(Thread, {
        key: thread.id,
        thread,
        text: texts.get(thread.id),
        marked: texts.has(thread.id),
        settled,
        active: active === thread.id,
        onActivate,
        onWrite,
        onClear,
        onFinish,
        onCancel,
        onResolve,
        onReopen,
        onSeen,
      });
    // The thread its first save made, or one that is not made yet.
    const made = compose && threads.find((thread) => thread.id === compose.threadId);
    const composed = compose && (made ?? { id: null, status: "open", orphaned: false, quote: compose.passage.quote, toAgent: false, answered: false, ping: null, comments: [] });
    const openCount = threads.filter((thread) => thread.status === "open").length;
    return h(
      "aside",
      { className: "pd-threads", "aria-label": t("Comments") },
      h("h2", null, t("Comments"), openCount > 0 && h("span", { className: "pd-count" }, openCount)),
      h("p", { className: "pd-hint" }, t("Write @agent in a comment to ask the agent to answer it.")),
      composed &&
        h(Thread, {
          key: `compose-${compose.key}`,
          thread: composed,
          text: made ? texts.get(made.id) : compose.passage.text,
          marked: Boolean(made) && texts.has(made.id),
          settled,
          active: made ? active === made.id : false,
          composing: true,
          onActivate,
          onWrite: (thread, words, id) => onWrite(thread, words, id, compose),
          onClear: (thread, id) => onClear(thread, id, compose),
          onFinish,
          onCancel: () => onCancel(compose),
          onResolve,
          onReopen,
          onSeen,
        }),
      error && !loaded
        ? h(ui.LoadFailed, { error: t("Comments could not be loaded: {error}", { error: error.message }), onRetry })
        : !loaded
          ? h(ui.RowsSkeleton, { rows: 2, label: t("Loading…") })
          : h(
              "div",
              { className: "pd-thread-list", "aria-live": "polite" },
              !threads.length && !compose && h("p", { className: "pd-hint" }, t("No comments yet. Select some text, then press Comment.")),
              list.map(card),
              closed.length > 0 &&
                h("button", { type: "button", className: `${ui.classes.ghost} pd-more`, "aria-expanded": resolved, onClick: () => setResolved((on) => !on) }, resolved ? t("Hide resolved") : t("Show resolved ({n})", { n: closed.length })),
            ),
    );
  };
}
