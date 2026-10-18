/**
 * The comments of a document on the Documents page: the list of threads beside
 * the editor, a thread with its comments and the box a comment is written in.
 * What is typed in the box stays in the page until it is sent, with Send or
 * Ctrl+Enter: only then is it saved, seen by anyone else, and, with
 * @agent in it, asked of the agent. A comment half written is nobody's but the
 * person's. Plain JavaScript like the rest of the browser half, made with the
 * portal's React and building blocks (`portal.ui`).
 *
 * A comment of the person's, once it is in the list, can be changed or deleted with
 * the buttons beside it, and a thread they started, while the agent has not commented
 * in it, can be deleted as a whole. The agent's comments are only read.
 *
 * Where the page is wide enough the threads float in the margin beside the
 * text, as a word processor draws them: each card level with its passage, the
 * one looked at where its passage is and the others moved up or down out of
 * its way, and the box to answer in only on the one looked at. Where it is not,
 * they are a list under the text.
 *
 * It holds no data of its own: the page (document-editor.js) fetches the
 * threads, tells the editor where their passages are, and hands both over, with
 * what to do when a comment is saved, changed, taken away, resolved or opened again.
 */
/** The most characters of the text of a passage a card shows. */
const SHOWN_CHARS = 240;

/** The room between two cards in the margin, in pixels. */
const GAP = 8;

/**
 * Where the cards of the margin go (`top` for each, in their order): each at its passage (`want`, null for one that has none, which
 * comes after the one before it), none over another, and the one looked at (`active`, an index) at its passage where the ones before it
 * can move up to make room.
 */
export function floatCards(cards, active = -1) {
  const tops = [];
  let bottom = 0;
  for (const [i, card] of cards.entries()) {
    tops[i] = Math.max(card.want ?? bottom, bottom);
    bottom = tops[i] + card.height + GAP;
  }
  const wanted = cards[active]?.want;
  if (wanted == null || tops[active] <= wanted) return tops;
  tops[active] = Math.max(0, wanted);
  for (let i = active - 1; i >= 0; i--) tops[i] = Math.min(tops[i], tops[i + 1] - cards[i].height - GAP);
  // Moved up as far as the top: what does not fit above it goes down again, the one looked at with it.
  bottom = 0;
  for (const [i, card] of cards.entries()) {
    tops[i] = Math.max(tops[i], bottom);
    bottom = tops[i] + card.height + GAP;
  }
  return tops;
}

/** `text` cut to what a card shows. */
const short = (text) => (text.length > SHOWN_CHARS ? `${text.slice(0, SHOWN_CHARS)}…` : text);

export function comments(portal, { when }) {
  const { React, ui, t } = portal;
  const { useEffect, useRef, useState } = React;
  const h = React.createElement;

  const WHO = () => ({ user: t("You"), agent: t("The agent") });

  /** The box a comment is typed in: Ctrl+Enter (or Cmd+Enter) sends it, or saves an edit. Escape gives up, where that means something. */
  function Writing({ value, onChange, onBlur, onDone, onCancel, label, placeholder, autoFocus }) {
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
        } else if (e.key === "Escape" && onCancel) {
          e.preventDefault();
          onCancel();
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

  /**
   * One comment of a thread, in the list. The person's own has **Edit** (the comment becomes a box with Save and Cancel; it is
   * kept as it is until Save) and **Delete** (after a question). A thread's only comment is taken away with the thread, by its own button.
   */
  function Comment({ comment, only, onEdit, onDelete, run }) {
    const [editing, setEditing] = useState(null);
    const [busy, setBusy] = useState(false);
    const mine = comment.author === "user";
    const mounted = useRef(true);
    useEffect(() => {
      mounted.current = true;
      return () => void (mounted.current = false);
    }, []);
    const save = () => {
      // The same words are no change: the box is just closed, and nothing is sent.
      if (editing.trim() === comment.body) return setEditing(null);
      return run(async () => {
        setBusy(true);
        try {
          await onEdit(comment, editing);
          if (mounted.current) setEditing(null);
        } finally {
          if (mounted.current) setBusy(false);
        }
      });
    };
    const remove = async () => {
      const ok = await ui.confirm({ title: t("Delete this comment?"), message: t("The comment is deleted for good."), confirmLabel: t("Delete"), danger: true, deletes: true });
      if (ok) await run(() => onDelete(comment));
    };
    return h(
      "li",
      { "data-author": comment.author },
      h(
        "div",
        { className: "pd-comment-head" },
        h("strong", null, WHO()[comment.author] ?? comment.author),
        h("span", { className: "pd-meta" }, when(comment.at)),
        comment.edited && h("span", { className: "pd-meta", title: t("Edited {date}", { date: when(comment.edited) }) }, t("edited")),
        mine &&
          editing === null &&
          h(
            "span",
            { className: "pd-comment-actions" },
            h("button", { type: "button", className: `${ui.classes.ghost} pd-act`, onClick: () => setEditing(comment.body) }, t("Edit")),
            !only && h("button", { type: "button", className: `${ui.classes.ghost} pd-act`, onClick: () => void remove() }, t("Delete")),
          ),
      ),
      editing === null
        ? h("div", { className: "pd-comment-body" }, h(ui.Markdown, null, comment.body))
        : h(
            "div",
            { className: "pd-reply" },
            h(Writing, { value: editing, onChange: setEditing, onDone: save, onCancel: () => setEditing(null), label: t("Edit the comment"), autoFocus: true }),
            h(
              "div",
              { className: "pd-actions" },
              h("button", { type: "button", className: ui.classes.primarySmall, disabled: busy || !editing.trim() || editing.trim() === comment.body, onClick: save }, t("Save")),
              h("button", { type: "button", className: ui.classes.ghost, disabled: busy, onClick: () => setEditing(null) }, t("Cancel")),
            ),
          ),
    );
  }

  /**
   * One thread: its passage, its comments in the order they were made, and the box to write the next in. `composing` is the
   * card of a comment that is being written on a passage: with no thread yet (`thread.id` is null) until it is sent, which
   * makes the thread, and the card is the thread's in the list from then on.
   */
  function Thread({ thread, text, marked, settled, active, composing, float, onPick, onActivate, onWrite, onFinish, onCancel, onResolve, onReopen, onSeen, onEdit, onDelete, onDeleteThread }) {
    const [value, setValue] = useState("");
    const [sending, setSending] = useState(false);
    const [error, setError] = useState(null);
    const open = thread.status === "open";
    // What it sends with, as it is now: the card lives on through the thread's being made and changed.
    const now = useRef(null);
    now.current = { thread, onWrite };
    const mounted = useRef(true);
    useEffect(() => {
      mounted.current = true;
      return () => void (mounted.current = false);
    }, []);
    // A comment typed and not sent is lost with the page: the browser asks first, as it does for a document not saved.
    const unsent = Boolean(value.trim());
    useEffect(() => {
      if (!unsent) return;
      const warn = (e) => {
        e.preventDefault();
        e.returnValue = "";
      };
      window.addEventListener("beforeunload", warn);
      return () => window.removeEventListener("beforeunload", warn);
    }, [unsent]);

    /** Does `work`, and says why if it did not go through. */
    const run = async (work) => {
      setError(null);
      try {
        await work();
      } catch (e) {
        if (mounted.current) setError(e.message);
      }
    };
    /** Sends what was typed: a comment of the thread's (and the thread, for the first on a passage). The box is empty for the next. */
    const sent = async () => {
      setSending(true);
      try {
        const saved = await now.current.onWrite(now.current.thread, value, null);
        if (!mounted.current) return;
        setValue("");
        if (composing) onFinish({ ...now.current.thread, id: saved.thread });
      } finally {
        if (mounted.current) setSending(false);
      }
    };
    const send = () => run(async () => value.trim() && !sending && (await sent()));
    // What was typed goes with the thread's being resolved, as the last word in it.
    const resolve = () =>
      run(async () => {
        if (value.trim()) await sent();
        await onResolve(now.current.thread);
      });
    // A thread the person started, while the agent has not commented in it, is theirs to delete as a whole.
    const deletable = !composing && Boolean(thread.id) && thread.comments[0]?.author === "user" && !thread.comments.some((comment) => comment.author === "agent");
    const removeThread = async () => {
      const ok = await ui.confirm({ title: t("Delete this thread?"), message: t("The thread and all its comments are deleted for good."), confirmLabel: t("Delete thread"), danger: true, deletes: true });
      if (!ok) return;
      await run(() => onDeleteThread(thread));
    };
    // Where the thread stands with the agent: asked and not answered yet, or answered and not reacted to.
    const asked = thread.answered
      ? t("The agent answered")
      : thread.toAgent && open
        ? thread.ping?.state === "failed"
          ? [t("Not delivered to the agent"), thread.ping.error].filter(Boolean).join(" · ")
          : [t("Asked the agent"), thread.ping?.title].filter(Boolean).join(" · ")
        : null;

    // In the margin only the card looked at (or one being written, or one with something typed in it) has the box to answer in.
    const answering = !float || active || composing || unsent;
    return h(
      "article",
      {
        className: `pd-thread-card${composing ? " pd-compose" : ""}`,
        "data-thread": thread.id ?? undefined,
        "data-status": thread.status,
        "aria-current": active ? "true" : undefined,
        "aria-label": composing ? t("New comment") : t("Comment thread"),
        onClick: float && !active && thread.id ? () => onPick?.(thread.id) : undefined,
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
        thread.comments.map((comment) => h(Comment, { key: comment.id, comment, only: thread.comments.length === 1 && deletable, onEdit: (c, words) => onEdit(thread, c, words), onDelete: (c) => onDelete(thread, c), run })),
      ),
      error && h(ui.ErrorBanner, { onClose: () => setError(null) }, t("Could not comment: {error}", { error })),
      answering &&
        (open
          ? h(
              "div",
              { className: "pd-reply" },
              h(Writing, {
                value,
                onChange: setValue,
                onDone: send,
                label: composing ? t("Write a comment") : t("Reply"),
                placeholder: composing ? t("Write a comment…") : t("Reply…"),
                autoFocus: composing,
              }),
              h(
                "div",
                { className: "pd-actions" },
                h("button", { type: "button", className: ui.classes.primarySmall, disabled: sending || !value.trim(), title: t("Ctrl+Enter"), onClick: () => void send() }, t("Send")),
                composing
                  ? h("button", { type: "button", className: ui.classes.ghost, disabled: sending, onClick: onCancel }, t("Cancel"))
                  : h("button", { type: "button", className: ui.classes.button, disabled: sending, onClick: () => void resolve() }, t("Resolve")),
                deletable && h("button", { type: "button", className: ui.classes.ghost, disabled: sending, onClick: () => void removeThread() }, t("Delete thread")),
              ),
            )
          : h(
              "div",
              { className: "pd-actions" },
              h("button", { type: "button", className: ui.classes.button, onClick: () => run(() => onReopen(thread)) }, t("Reopen")),
              deletable && h("button", { type: "button", className: ui.classes.ghost, onClick: () => void removeThread() }, t("Delete thread")),
            )),
    );
  }

  /**
   * The panel: `threads` as the server has them (document order, open ones first), `texts` what the marked passages read as
   * by thread id (`settled`: the editor has been asked to mark these threads, so one that is not marked cannot be), `error` why they could
   * not be fetched. `compose` is the comment being written on a passage, if one is: its `threadId` is the thread sending it made,
   * which is its card and not one of the list's until the card is let go.
   */
  return function Comments({ threads, loaded, error, texts, settled, active, compose, float = false, anchor, relayout, onPick, onRetry, onActivate, onWrite, onFinish, onCancel, onResolve, onReopen, onSeen, onEdit, onDelete, onDeleteThread }) {
    const [resolved, setResolved] = useState(false);
    // In the margin: the tops of the cards, by their keys, once they have been measured, and the elements they are measured by.
    const [tops, setTops] = useState(() => new Map());
    const slots = useRef(new Map());
    const margin = useRef(null);
    const listBox = useRef(null);
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
        float,
        onPick,
        thread,
        text: texts.get(thread.id),
        marked: texts.has(thread.id),
        settled,
        active: active === thread.id,
        onActivate,
        onWrite,
        onFinish,
        onCancel,
        onResolve,
        onReopen,
        onSeen,
        onEdit,
        onDelete,
        onDeleteThread,
      });
    // The thread its first save made, or one that is not made yet.
    const made = compose && threads.find((thread) => thread.id === compose.threadId);
    const composed = compose && (made ?? { id: null, status: "open", orphaned: false, quote: compose.passage.quote, toAgent: false, answered: false, ping: null, comments: [] });
    const openCount = threads.filter((thread) => thread.status === "open").length;
    const hint = t("Write @agent in a comment to ask the agent to answer it.");
    const composeCard =
      composed &&
      h(Thread, {
        key: `compose-${compose.key}`,
        thread: composed,
        text: made ? texts.get(made.id) : compose.passage.text,
        marked: Boolean(made) && texts.has(made.id),
        settled,
        active: made ? active === made.id : false,
        composing: true,
        float,
        onPick,
        onActivate,
        onWrite: (thread, words, id) => onWrite(thread, words, id, compose),
        onFinish,
        onCancel: () => onCancel(compose),
        onResolve,
        onReopen,
        onSeen,
        onEdit,
        onDelete,
        onDeleteThread,
      });

    // The cards of the margin, in the order of the text: the one being written is at the passage it is on (marked as pending until it is a thread).
    const floating = float && loaded ? [...(composeCard ? [{ key: `compose-${compose.key}`, anchor: made?.id ?? "pending", node: composeCard, id: made?.id ?? null }] : []), ...list.map((thread) => ({ key: thread.id, anchor: thread.id, node: card(thread), id: thread.id }))] : [];
    const order = floating.map((c) => c.key).join("\n");
    // Measured after each drawing: where each passage is and how tall each card is, and the cards put where they go. Drawn again only
    // when that moved them, which it does not the second time.
    React.useLayoutEffect(() => {
      if (!float) return;
      // Where the passages are is told from the top of the page; the cards are put from the top of their list.
      const top = listBox.current?.getBoundingClientRect().top ?? 0;
      const measured = floating.map((c) => {
        const at = anchor?.(c.anchor);
        const want = at == null ? null : at - top;
        return { key: c.key, want: want == null ? null : Math.round(want), height: Math.round(slots.current.get(c.key)?.offsetHeight ?? 0), id: c.id };
      });
      // Those that have a passage in the order of the text; those that have none after them, as they are listed.
      const placed = measured.filter((c) => c.want !== null).sort((a, b) => a.want - b.want);
      const cards = [...placed, ...measured.filter((c) => c.want === null)];
      const at = floatCards(cards, cards.findIndex((c) => c.id !== null && c.id === active));
      const next = new Map(cards.map((c, i) => [c.key, at[i]]));
      setTops((now) => (now.size === next.size && [...next].every(([key, top]) => now.get(key) === top) ? now : next));
    });
    // Moved again when the text moves under them (`relayout`) or the margin changes its width.
    useEffect(() => {
      if (!float || typeof ResizeObserver === "undefined" || !margin.current) return;
      const watch = new ResizeObserver(() => setTops((now) => new Map(now)));
      watch.observe(margin.current);
      return () => watch.disconnect();
    }, [float]);
    useEffect(() => {
      if (float) setTops((now) => new Map(now));
    }, [relayout]);

    if (float) {
      const bottom = Math.max(0, ...floating.map((c) => (tops.get(c.key) ?? 0) + (slots.current.get(c.key)?.offsetHeight ?? 0)));
      return h(
        "aside",
        { className: "pd-threads pd-margin", "aria-label": t("Comments"), ref: margin },
        h(
          "div",
          { className: "pd-margin-head" },
          h("h2", null, t("Comments"), openCount > 0 && h("span", { className: "pd-count" }, openCount)),
          closed.length > 0 && h("button", { type: "button", className: `${ui.classes.ghost} pd-more`, "aria-expanded": resolved, onClick: () => setResolved((on) => !on) }, resolved ? t("Hide resolved") : t("Show resolved ({n})", { n: closed.length })),
        ),
        h("p", { className: "pd-hint" }, hint),
        error && !loaded
          ? h(ui.LoadFailed, { error: t("Comments could not be loaded: {error}", { error: error.message }), onRetry })
          : !loaded
            ? h(ui.RowsSkeleton, { rows: 2, label: t("Loading…") })
            : h(
                React.Fragment,
                null,
                !threads.length && !compose && h("p", { className: "pd-hint" }, t("No comments yet. Select some text, then press Comment.")),
                h(
                  "div",
                  { className: "pd-thread-list", ref: listBox, "aria-live": "polite", "data-order": order, style: { minHeight: `${bottom + 48}px` } },
                  floating.map((c) =>
                    h(
                      "div",
                      {
                        key: c.key,
                        className: "pd-slot",
                        "data-placed": tops.has(c.key) ? "true" : undefined,
                        style: { top: `${tops.get(c.key) ?? 0}px` },
                        ref: (el) => (el ? slots.current.set(c.key, el) : slots.current.delete(c.key)),
                      },
                      c.node,
                    ),
                  ),
                ),
              ),
      );
    }
    return h(
      "aside",
      { className: "pd-threads", "aria-label": t("Comments") },
      h("h2", null, t("Comments"), openCount > 0 && h("span", { className: "pd-count" }, openCount)),
      h("p", { className: "pd-hint" }, hint),
      composeCard,
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
