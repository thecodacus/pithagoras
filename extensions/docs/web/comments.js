/**
 * The comments of a document on the Documents page, as a word processor shows them: a passage that is commented on is marked in
 * the text, and a click on it opens its thread as a card (`Popover`) that floats on the sheet, just under the passage (above it where
 * there is no room below), so that the words stay readable. A thread is a card of its comments, the box a comment is
 * written in and the buttons to resolve it. What is typed in the box stays in the page until it is sent, with Send or
 * Ctrl+Enter: only then is it saved, seen by anyone else, and, with @agent in it, asked of the agent. A comment half written is
 * nobody's but the person's, and it is kept when the card is closed and opened again. Plain JavaScript like the rest of
 * the browser half, made with the portal's React and building blocks (`portal.ui`).
 *
 * Nothing else of the comments is drawn unless it is asked for: the bar's **Comments** shows the list (`Comments`, in the side panel of side.js) of all the
 * threads, a way to a thread that is out of reach in the text (its passage is gone, or it is resolved) and to the others, which
 * are chosen there and open in their card.
 *
 * A comment of the person's, once it is sent, can be changed or deleted with the buttons beside it, and a thread they
 * started, while the agent has not commented in it, can be deleted as a whole. The agent's comments are only read.
 *
 * It holds no data of its own: the page (document-editor.js) fetches the threads, tells the editor where their passages are, and
 * hands both over, with what to do when a comment is saved, changed, taken away, resolved or opened again.
 */
import { sidePanel } from "./side.js";

/** The most characters of the text of a passage a card shows. */
const SHOWN_CHARS = 240;
/** The most characters of a comment the list shows of it. */
const SUMMARY_CHARS = 100;

/** The id the passage of a comment that is being written is marked by in the editor: no thread has it. */
export const PENDING = "pending";

/** How wide a card is at most, in pixels, and how far from the passage and from the sheet's edge it is kept. */
const CARD_WIDTH = 352;
const GAP = 6;
const EDGE = 8;
/** Beside the passage, at the right edge of the page: how wide the card is, how wide the page has to be for that, and how far it keeps from the words. */
const SIDE_WIDTH = 320;
const SIDE_MIN = 720;
const SIDE_GAP = 16;
/**
 * How much room the margin right of the text column has to have (measured, not guessed from the window's width: the side panel takes
 * from it) for the markers of the comments to stand in it without touching a word, and for a card to be beside its passage. Where it
 * has less, the words are the way to a comment, and its card is under them.
 */
export const MARGIN_ROOM = 76;

/** `text` cut to what a card shows. */
const short = (text) => (text.length > SHOWN_CHARS ? `${text.slice(0, SHOWN_CHARS)}…` : text);

export function comments(portal, { when }) {
  const { React, ui, t } = portal;
  const { useEffect, useRef, useState } = React;
  const h = React.createElement;
  const SidePanel = sidePanel(portal);

  const WHO = () => ({ user: t("You"), agent: t("The agent") });
  const HINT = () => t("Write @agent in a comment to ask the agent to answer it.");

  /** The box a comment is typed in: Ctrl+Enter (or Cmd+Enter) sends it, or saves an edit. Escape gives up, where that means something. */
  function Writing({ value, onChange, onBlur, onDone, onCancel, label, placeholder, autoFocus, rows = 3 }) {
    const box = useRef(null);
    useEffect(() => {
      if (autoFocus) box.current?.focus({ preventScroll: true });
    }, [autoFocus]);
    return h("textarea", {
      ref: box,
      className: `${ui.classes.input} pd-write`,
      rows,
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
  function Comment({ comment, only, drafts, tools, onEdit, onDelete, run }) {
    // The words of a change that is not saved are kept in `drafts` as well, as a reply's are: the card is drawn from nothing each time it
    // is opened, and a change begun is not lost with it (the page warns of it before it is left). Words that are the comment's own are none.
    const draftKey = `edit-${comment.id}`;
    const [editing, setEditingNow] = useState(() => drafts.get(draftKey) ?? null);
    const setEditing = (words) => {
      if (words === null || words.trim() === comment.body) drafts.delete(draftKey);
      else drafts.set(draftKey, words);
      setEditingNow(words);
    };
    // Only a change the person has just begun takes the focus: one that was kept does not, when the card is opened again.
    const [begun, setBegun] = useState(false);
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
            h("button", { type: "button", className: `${ui.classes.ghost} pd-act`, onClick: () => (setBegun(true), setEditing(comment.body)) }, t("Edit")),
            !only && h("button", { type: "button", className: `${ui.classes.ghost} pd-act`, onClick: () => void remove() }, t("Delete")),
          ),
        tools,
      ),
      editing === null
        ? h("div", { className: "pd-comment-body" }, h(ui.Markdown, null, comment.body))
        : h(
            "div",
            { className: "pd-reply" },
            h(Writing, { value: editing, onChange: setEditing, onDone: save, onCancel: () => setEditing(null), label: t("Edit the comment"), autoFocus: begun }),
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
   * One thread: its comments in the order they were made, and the box to write the next in. In its card on the sheet (`floating`)
   * it is the passage's own and shows no quote; in the list it says which passage it is on. `composing` is the card of a comment that
   * is being written on a passage: with no thread yet (`thread.id` is null) until it is sent, which makes the thread, and the card is
   * the thread's from then on.
   */
  function Thread({ thread, text, marked, settled, floating, composing, drafts, draftKey, onActivate, onWrite, onFinish, onCancel, onResolve, onReopen, onSeen, onEdit, onDelete, onDeleteThread }) {
    // What is typed is kept in `drafts` as well: the card is drawn again from nothing each time it is opened, and the words are not
    // lost with it. The page warns of them before it is left (document-editor.js).
    const [value, setValueNow] = useState(() => drafts.get(draftKey) ?? "");
    const setValue = (words) => {
      if (words) drafts.set(draftKey, words);
      else drafts.delete(draftKey);
      setValueNow(words);
    };
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

    // The comments of the thread, in the order they were made; the first has the thread's own tool, to resolve it.
    const [replied, setReplied] = useState(false);
    const resolveTool =
      open && thread.id && !composing
        ? h(
            "button",
            { type: "button", className: "pd-iconbtn", "aria-label": t("Resolve"), title: t("Resolve"), disabled: sending, onClick: () => void resolve() },
            h("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true, className: "pd-icon" }, h("path", { d: "M20 6 9 17l-5-5" })),
          )
        : null;
    const list = (comments, first = false) =>
      h(
        "ol",
        { className: "pd-comments", key: comments[0]?.id },
        comments.map((comment) => h(Comment, { key: comment.id, comment, drafts, tools: first && comment === thread.comments[0] ? resolveTool : null, only: thread.comments.length === 1 && deletable, onEdit: (c, words) => onEdit(thread, c, words), onDelete: (c) => onDelete(thread, c), run })),
      );
    const foldButton = h(
      "button",
      { type: "button", key: "fold", className: `${ui.classes.ghost} pd-fold`, "aria-expanded": replied, onClick: () => setReplied((on) => !on) },
      replied ? t("Hide replies") : t("Show {n} replies", { n: thread.comments.length - 2 }),
    );
    return h(
      "article",
      {
        className: `pd-thread-card${composing ? " pd-compose" : ""}`,
        "data-thread": thread.id ?? undefined,
        "data-status": thread.status,
        "aria-label": composing ? t("New comment") : t("Comment thread"),
        role: floating ? "dialog" : undefined,
      },
      composing && !thread.id && h("strong", null, t("New comment")),
      !floating && h(Passage, { text: text ?? thread.quote, onClick: marked ? () => onActivate(thread.id) : undefined }),
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
      // What was said before the last reply is folded away when there is a lot of it, as a conversation is on a page.
      ...(thread.comments.length >= 4 ? [list(thread.comments.slice(0, 1), true), foldButton, list(replied ? thread.comments.slice(1) : thread.comments.slice(-1))] : [list(thread.comments, true)]),
      error && h(ui.ErrorBanner, { onClose: () => setError(null) }, t("Could not comment: {error}", { error })),
      open
        ? h(
              "div",
              { className: "pd-reply" },
              h(Writing, {
                value,
                onChange: setValue,
                onDone: send,
                label: composing ? t("Write a comment") : t("Reply"),
                placeholder: composing ? t("Write a comment… (@agent asks the agent)") : t("Reply… (@agent asks the agent)"),
                rows: floating ? 1 : 2,
              }),
              h(
                "div",
                { className: "pd-actions" },
                h("button", { type: "button", className: ui.classes.primarySmall, disabled: sending || !value.trim(), title: t("Ctrl+Enter"), onClick: () => void send() }, t("Send")),
                composing && h("button", { type: "button", className: ui.classes.ghost, disabled: sending, onClick: onCancel }, t("Cancel")),
                deletable && h("button", { type: "button", className: ui.classes.ghost, disabled: sending, onClick: () => void removeThread() }, t("Delete thread")),
              ),
            )
          : h(
              "div",
              { className: "pd-actions" },
              h("button", { type: "button", className: ui.classes.button, onClick: () => run(() => onReopen(thread)) }, t("Reopen")),
              deletable && h("button", { type: "button", className: ui.classes.ghost, onClick: () => void removeThread() }, t("Delete thread")),
            ),
    );
  }

  /**
   * A thread's card on the sheet, floating next to its passage. `thread` is the one to show, or the comment being written (`compose`, with
   * the thread its first save made once it has): `anchor()` gives the rectangles of the passage on the screen (one for each line of it),
   * `sheet` is the element the card is placed in. Where the page is wide it is beside the passage, level with it, at the right edge;
   * else it is just under the passage, above it where it does not fit under, and kept inside the page sideways. Escape or a click outside closes it (`onClose`, told whether the text is to have the focus back), and so does
   * nothing else: the card follows its passage as the document scrolls and is placed again when the text, the card or the window change size.
   */
  function Popover({ thread, settled, compose, drafts, sheet, editor, anchor, takeFocus, onClose, onActivate, onWrite, onFinish, onCancel, onResolve, onReopen, onSeen, onEdit, onDelete, onDeleteThread }) {
    const box = useRef(null);
    const [at, setAt] = useState(null);
    const place = () => {
      const card = box.current;
      const rects = anchor();
      if (!card || !sheet || !rects?.length) return;
      const frame = sheet.getBoundingClientRect();
      const margin = editor ? frame.right - sheet.clientLeft - editor.getBoundingClientRect().right : 0;
      const first = rects[0];
      const last = rects.at(-1);
      const width = Math.min(CARD_WIDTH, frame.width - 2 * EDGE);
      const height = card.offsetHeight;
      // What of the screen is the person's to look at: the page, which scrolls in itself, under the toolbar.
      const scroller = sheet.closest(".pd-scroll");
      const view = scroller ? scroller.getBoundingClientRect() : { top: 0, bottom: window.innerHeight };
      const top = view.top;
      // Where the page is wide enough: level with the passage, at the right edge, clear of every word of it (the text under the card goes
      // behind it). Where it is not, or the card would be over the passage: under it, above where there is no room under.
      if (frame.width >= SIDE_MIN && margin >= MARGIN_ROOM) {
        const x = frame.width - SIDE_WIDTH - EDGE;
        // As high as the passage, so that it goes with it when the page scrolls. Where the passage is in view the card is kept in view too
        // (moved up, still clear of the passage, where it would run past the end); one whose passage is out of it goes off with it. Never
        // past the sheet's own ends.
        const bottom = Math.min(view.bottom, window.innerHeight);
        const seen = first.bottom > top && first.top < bottom;
        let y = first.top;
        if (seen) y = Math.max(top + EDGE, Math.min(y, bottom - height - EDGE));
        y = Math.max(frame.top + EDGE, Math.min(y, frame.bottom - height - EDGE));
        const clear = rects.every((r) => r.right + SIDE_GAP <= frame.left + x || r.bottom <= y || r.top >= y + height);
        if (clear) {
          const side = { top: Math.round(y - frame.top - sheet.clientTop), left: Math.round(x - sheet.clientLeft), width: SIDE_WIDTH, above: false, side: true };
          return setAt((now) => (now && now.top === side.top && now.left === side.left && now.width === side.width && now.side ? now : side));
        }
      }
      const under = last.bottom + GAP;
      const over = first.top - GAP - height;
      const above = under + height > Math.min(view.bottom, window.innerHeight) && over >= top;
      const left = Math.min(Math.max((above ? first.left : last.left) - frame.left, EDGE), Math.max(EDGE, frame.width - width - EDGE));
      const next = { top: Math.round((above ? over : under) - frame.top - sheet.clientTop), left: Math.round(left - sheet.clientLeft), width: Math.round(width), above, side: false };
      setAt((now) => (now && now.top === next.top && now.left === next.left && now.width === next.width && now.above === next.above && !now.side ? now : next));
    };
    // After every drawing (the card's contents change its height, and the page draws it again when the text moved), and by the
    // listeners below, which are set up once and so ask for the latest `place`.
    const placing = useRef(place);
    placing.current = place;
    React.useLayoutEffect(place);
    useEffect(() => {
      let timer = null;
      // Scrolled: placed again once it stops, where it is above or under the passage depending on what is in view then.
      const later = () => {
        clearTimeout(timer);
        timer = setTimeout(() => placing.current(), 120);
      };
      const resized = () => placing.current();
      window.addEventListener("resize", resized);
      document.addEventListener("scroll", later, { capture: true, passive: true });
      const watch = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(resized);
      if (box.current) watch?.observe(box.current);
      return () => {
        clearTimeout(timer);
        window.removeEventListener("resize", resized);
        document.removeEventListener("scroll", later, { capture: true });
        watch?.disconnect();
      };
    }, []);
    // A click outside closes it; one in the text is the text's to tell (a click on another passage opens that one), and one in a
    // question the card asked is not outside.
    useEffect(() => {
      const away = (e) => {
        if (box.current?.contains(e.target) || editor?.contains(e.target) || e.target.closest?.('[role="alertdialog"]')) return;
        onClose({ focus: false });
      };
      document.addEventListener("mousedown", away);
      return () => document.removeEventListener("mousedown", away);
    }, [onClose]);
    // Opened with the keyboard (or from the list), or to write a comment, the box to write in has the focus: once the card is where it goes,
    // and without scrolling to it. Focused earlier it would sit at the top of the sheet, and the page would scroll there.
    const placed = at !== null;
    useEffect(() => {
      if (!takeFocus || !placed) return;
      const field = box.current?.querySelector("textarea") ?? box.current?.querySelector("button");
      field?.focus({ preventScroll: true });
    }, [takeFocus, placed]);

    const composing = Boolean(compose);
    return h(
      "div",
      {
        ref: box,
        className: "pd-popover",
        "data-above": at?.above ? "true" : undefined,
        "data-side": at?.side ? "true" : undefined,
        style: at ? { top: `${at.top}px`, left: `${at.left}px`, width: `${at.width}px` } : { top: 0, left: 0, width: `${CARD_WIDTH}px`, opacity: 0, pointerEvents: "none" },
        onKeyDown: (e) => {
          if (e.key !== "Escape" || e.defaultPrevented) return;
          e.preventDefault();
          onClose({ focus: true });
        },
      },
      h(Thread, {
        key: composing ? `compose-${compose.key}` : thread.id,
        thread,
        marked: true,
        settled,
        floating: true,
        composing,
        drafts,
        draftKey: composing ? `compose-${compose.key}` : thread.id,
        onActivate,
        onWrite: composing ? (th, words, id) => onWrite(th, words, id, compose) : onWrite,
        onFinish,
        onCancel: () => onCancel(compose),
        onResolve,
        onReopen,
        onSeen,
        onEdit,
        onDelete,
        onDeleteThread,
      }),
    );
  }

  /** A thread in the list that is on a passage in the text: what it is on and what was said last; a click opens its card there. */
  function Summary({ thread, text, active, onActivate }) {
    const last = thread.comments.at(-1);
    const words = last ? last.body.replace(/\s+/g, " ").trim() : "";
    return h(
      "button",
      { type: "button", className: "pd-item", "data-thread": thread.id, "aria-current": active ? "true" : undefined, title: t("Show in the text"), onClick: () => onActivate(thread.id) },
      h("span", { className: "pd-quote" }, short(text ?? thread.quote)),
      last && h("span", { className: "pd-said" }, h("strong", null, WHO()[last.author] ?? last.author), ": ", words.length > SUMMARY_CHARS ? `${words.slice(0, SUMMARY_CHARS)}…` : words),
    );
  }

  /**
   * The list of all the threads, shown when it is asked for: `threads` as the server has them (document order, open ones first),
   * `texts` what the marked passages read as by thread id (`settled`: the editor has been asked to mark these threads, so one that is
   * not marked cannot be), `error` why they could not be fetched, `active` the thread whose card is open. A thread on a passage in the
   * text is a line that opens its card; one that is not (its passage is gone, or it is resolved) is a card of its own here, with its box
   * and its buttons. `compose` is the comment being written, which is a card on the sheet and not in the list.
   */
  function Comments({ threads, loaded, error, texts, settled, active, compose, drafts = new Map(), onClose, onRetry, onActivate, onWrite, onFinish, onCancel, onResolve, onReopen, onSeen, onEdit, onDelete, onDeleteThread }) {
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
    const openCount = threads.filter((thread) => thread.status === "open").length;
    // On a passage: open and found in the text (or not looked for yet).
    const onPassage = (thread) => thread.status === "open" && !thread.orphaned && (texts.has(thread.id) || !settled);
    // The comment being written, whose card is closed (it has words, or its card is open now): a line like a thread's, which opens it.
    const typed = compose && !compose.threadId ? (drafts.get(`compose-${compose.key}`) ?? "").replace(/\s+/g, " ").trim() : null;
    const kept =
      typed !== null &&
      h(
        "button",
        { type: "button", className: "pd-item", "data-thread": PENDING, "aria-current": active === PENDING ? "true" : undefined, title: t("Show in the text"), onClick: () => onActivate(PENDING) },
        h("span", { className: "pd-quote" }, short(compose.passage.text ?? compose.passage.quote)),
        h("span", { className: "pd-said" }, h("strong", null, t("New comment")), typed && ": ", typed.length > SUMMARY_CHARS ? `${typed.slice(0, SUMMARY_CHARS)}…` : typed),
      );
    const card = (thread) =>
      onPassage(thread)
        ? h(Summary, { key: thread.id, thread, text: texts.get(thread.id), active: active === thread.id, onActivate })
        : h(Thread, {
            key: thread.id,
            thread,
            drafts,
            draftKey: thread.id,
            text: texts.get(thread.id),
            marked: texts.has(thread.id),
            settled,
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
    return h(
      SidePanel,
      { kind: "comments", title: t("Comments"), count: openCount, onClose },
      h("p", { className: "pd-hint" }, HINT()),
      error && !loaded
        ? h(ui.LoadFailed, { error: t("Comments could not be loaded: {error}", { error: error.message }), onRetry })
        : !loaded
          ? h(ui.RowsSkeleton, { rows: 2, label: t("Loading…") })
          : h(
              "div",
              { className: "pd-thread-list", "aria-live": "polite" },
              !threads.length && !compose && h("p", { className: "pd-hint" }, t("No comments yet. Select some text, then press Comment.")),
              kept,
              list.map(card),
              closed.length > 0 &&
                h("button", { type: "button", className: `${ui.classes.ghost} pd-more`, "aria-expanded": resolved, onClick: () => setResolved((on) => !on) }, resolved ? t("Hide resolved") : t("Show resolved ({n})", { n: closed.length })),
            ),
    );
  }

  return { Comments, Popover, SidePanel };
}
