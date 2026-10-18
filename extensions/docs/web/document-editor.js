/**
 * A document on the Documents page, edited: the editor (editor.js, loaded when
 * a document is first opened), saved as it is edited (saver.js), kept up to
 * date with what the agent and others change meanwhile (live.js), the
 * document's history with a way back to an earlier revision, and the comments
 * on its passages (comments.js). The same text can be written as Markdown in
 * a plain box instead of in the editor (source.js): the editor stays what the
 * saving, the changes from outside and the comments are done on, and the box
 * takes its place for as long as it is chosen.
 *
 * It is laid out as a word processor is: a bar with the document's name, where
 * it stands and what can be done with it (the list of its comments, its history,
 * a download, the page of its own), the toolbar (toolbar.js), and the text on a
 * sheet. A comment is a card that floats over the sheet at its passage, opened
 * by a click on the passage (comments.js).
 *
 * Plain JavaScript like the rest of the browser half, made with the portal's
 * React and building blocks (`portal.ui`).
 */
import { MAX_QUOTE } from "./anchor.js";
import { comments, PENDING } from "./comments.js";
import { createLive } from "./live.js";
import { asksAgent } from "./mention.js";
import { createSaver } from "./saver.js";
import { fit, keepMode, readMode, replaceText } from "./source.js";
import { ICONS, toolbar } from "./toolbar.js";
import { drafted, shownOf } from "./writing.js";

/** What the person's text was, kept while it is not saved (a conflict, a save that failed, a page that went away): per document, for the tab. */
const DRAFT = "pithagoras-docs/draft";
/** What a request that goes on after the page is gone may carry: the browsers allow 64 KiB, and it is kept well under. */
const KEEPALIVE_BYTES = 60 * 1024;
/** How wide the document has to be for the list of comments to stand beside the page; narrower, it comes in over the page from the right. */
const LIST_BESIDE = 900;
/** The markers of comments in the right margin: how high one is, and how wide the page has to be for it to have a margin to stand in (as a card beside a passage). */
const MARKER_HEIGHT = 22;
const MARGIN_MIN = 720;

/** How a printed copy of a document looks: plain, black on white, as a page. */
const PRINT_CSS = `
@page { margin: 2cm; }
body { margin: 0; color: #111; font: 11pt/1.55 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
h1, h2, h3, h4, h5, h6 { line-height: 1.25; margin: 1.2em 0 .4em; break-after: avoid; }
h1 { font-size: 1.9em; } h2 { font-size: 1.45em; } h3 { font-size: 1.2em; }
p { margin: 0 0 .6em; } ul, ol { padding-left: 1.6em; }
li[data-item-type="task"] { list-style: none; position: relative; }
li[data-item-type="task"]::before { position: absolute; left: -1.4em; content: "\\2610"; }
li[data-item-type="task"][data-checked="true"]::before { content: "\\2611"; }
blockquote { margin: .6em 0; border-left: 3px solid #ccc; padding-left: 1em; color: #444; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .9em; background: #f2f2f2; padding: 0 .2em; border-radius: 3px; }
pre { background: #f6f6f6; padding: .7em 1em; border-radius: 4px; white-space: pre-wrap; }
pre code { background: none; padding: 0; }
table { border-collapse: collapse; margin: .6em 0; } th, td { border: 1px solid #bbb; padding: 4px 8px; text-align: left; } th { background: #f2f2f2; }
hr { border: 0; border-top: 1px solid #ccc; }
a { color: inherit; }
.pd-thread, .pd-changed { background: none !important; box-shadow: none !important; }
`;

/** Prints `html` (the text as the editor draws it) on its own, as `title`: the browser's print, where it can be saved as a PDF. */
function printDocument(title, html) {
  const frame = document.createElement("iframe");
  // Nothing in it runs: it is the text and its look, and the browser's print.
  frame.setAttribute("sandbox", "allow-same-origin allow-modals");
  frame.setAttribute("aria-hidden", "true");
  frame.tabIndex = -1;
  frame.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0";
  document.body.append(frame);
  const page = frame.contentDocument;
  page.open();
  page.write("<!doctype html><html><head><meta charset=\"utf-8\"><title></title><style></style></head><body><article></article></body></html>");
  page.close();
  page.title = title;
  page.querySelector("style").textContent = PRINT_CSS;
  page.querySelector("article").innerHTML = html;
  const gone = () => setTimeout(() => frame.remove(), 1000);
  frame.contentWindow.addEventListener("afterprint", gone, { once: true });
  frame.contentWindow.focus();
  frame.contentWindow.print();
  // A browser that tells nothing after printing: the frame goes after a while all the same.
  setTimeout(() => frame.isConnected && frame.remove(), 60_000);
}

export function documentEditor(portal, { documentUrl, when, useAnswer, activeChat, remember }) {
  const { React, ui, t } = portal;
  const { useEffect, useRef, useState } = React;
  const h = React.createElement;
  const { Comments, Popover, SidePanel } = comments(portal, { when });
  const Toolbar = toolbar(portal);

  const Icon = ({ name }) =>
    h("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true, className: "pd-icon" }, h("path", { d: ICONS[name] }));

  /** A button of the document's bar: an icon, and its words where there is room for them. */
  const BarButton = ({ icon, label, pressed, expanded, disabled, badge, onClick, children, buttonRef }) =>
    h(
      "button",
      { type: "button", ref: buttonRef, className: "pd-barbutton", title: label, "aria-label": badge ? `${label} ${badge}` : undefined, "aria-pressed": pressed, "aria-expanded": expanded, disabled, onClick },
      h(Icon, { name: icon }),
      h("span", { className: "pd-barlabel" }, children ?? label),
      badge ? h("span", { className: "pd-count", "aria-hidden": true }, badge) : null,
    );

  /** A menu that opens from a button of the bar, and closes with a choice, Escape or a click elsewhere. */
  function Menu({ icon, label, items, disabled }) {
    const [open, setOpen] = useState(false);
    const box = useRef(null);
    useEffect(() => {
      if (!open) return;
      const away = (e) => !box.current?.contains(e.target) && setOpen(false);
      const key = (e) => e.key === "Escape" && setOpen(false);
      document.addEventListener("mousedown", away);
      document.addEventListener("keydown", key);
      return () => {
        document.removeEventListener("mousedown", away);
        document.removeEventListener("keydown", key);
      };
    }, [open]);
    return h(
      "div",
      { className: "pd-menu", ref: box },
      h(BarButton, { icon, label, expanded: open, disabled, onClick: () => setOpen((on) => !on) }),
      open &&
        h(
          "div",
          { className: "pd-menu-list", role: "menu" },
          items.map((item) =>
            item.href
              ? h("a", { key: item.key, role: "menuitem", href: item.href, download: item.download ?? "", className: "pd-menu-item", onClick: () => setOpen(false) }, h(Icon, { name: item.icon }), item.label)
              : h(
                  "button",
                  {
                    key: item.key,
                    type: "button",
                    role: "menuitem",
                    className: "pd-menu-item",
                    onClick: () => {
                      setOpen(false);
                      item.onClick();
                    },
                  },
                  h(Icon, { name: item.icon }),
                  item.label,
                ),
          ),
        ),
    );
  }

  /** The editor's module, loaded once and when first wanted. */
  let bundle = null;
  const loadEditor = () => (bundle ??= import("./editor.js"));

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
  /** What the server half warns of with a save, in the person's language where it names the warning by a code; as it came where not. */
  const warningText = (warning) => (warning === "secret" ? t("This document looks like it holds a secret (a private key or a token). Its history keeps every revision: take it out, and see the guide on how to remove it from the history.") : warning);
  /** What a revision was besides who made it: a save is nothing more. */
  function whatOf(revision) {
    if (revision.kind === "restore") return t("Restored from revision {n}", { n: revision.restoredFrom });
    if (revision.kind === "create") return t("Created");
    if (revision.kind === "adopted") return t("Existing file");
    return "";
  }

  /**
   * The revisions of a document, newest first, in the side panel: any of them can be looked at (`shown`: the one chosen, which the
   * page draws in the text's place, read-only, `onLook`) and brought back. The panel is the list and what can be done with the revision
   * chosen; the text of it is on the page.
   */
  function History({ folder, id, current, busy, shown, onLook, onRestore, onClose }) {
    const url = documentUrl(folder, id);
    const [list, setList] = useState({ items: [], more: false });
    const [error, setError] = useState(null);
    const [loaded, setLoaded] = useState(false);
    const [asked, setAsked] = useState(0);
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

    /**
     * Asks first: the text on the page is replaced. It is not lost (what was typed is saved as a revision before, and the replaced text
     * is one), so the question is not drawn as a danger, but it is the portal's question before something is replaced or removed, which
     * Settings → This browser can switch off. Cancel leaves the focus on the button that asked, and a restore ends in the text.
     */
    const restoreAsked = async (revision) => {
      const ok = await ui.confirm({
        title: t("Restore revision {n}?", { n: revision.revision }),
        message: t("The current text is replaced by revision {n}. The current version stays in the history, so you can go back to it.", { n: revision.revision }),
        confirmLabel: t("Restore"),
        deletes: true,
      });
      if (ok && (await onRestore(revision))) onLook(null);
    };

    return h(
      SidePanel,
      { kind: "history", title: t("History"), onClose },
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
                      // The one looked at is chosen again to be let go of.
                      { type: "button", "aria-pressed": shown?.revision === revision.revision, onClick: () => onLook(shown?.revision === revision.revision ? null : revision.revision) },
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
              : h("button", { type: "button", className: ui.classes.primarySmall, disabled: busy || shown.markdown === undefined, onClick: () => void restoreAsked(shown) }, t("Restore this revision")),
          ),
          shown.error && h(ui.ErrorBanner, null, shown.error),
        ),
    );
  }

  /**
   * The document in the editor: saved as it is edited, with what to do when it was changed meanwhile. `draft`: an edit the agent
   * is writing in it now (`{ call, edits }`, web/writing.js), drawn on the document as it is stored, in the editor's place, as it
   * comes. Not over a person who is working in the text when the call begins (it has the focus, or something unsaved): they keep
   * their text, and the agent's change comes in when it is done, as any change from elsewhere does.
   */
  function Editing({ folder, id, doc, edit, onBack, onExpand, draft }) {
    const host = useRef(null);
    // The editor and its saver, once the editor is drawn.
    const parts = useRef(null);
    const [view, setView] = useState({ status: "saved", base: doc.revision, error: null, conflict: null, warning: null });
    const [ready, setReady] = useState(false);
    // How the text is written: in the editor, or as Markdown in a box. The ref is what the editor's callbacks see; the state draws.
    const modeNow = useRef(readMode());
    const [mode, setMode] = useState(modeNow.current);
    const plain = mode === "markdown";
    // The box, the text it held last (for when the page is gone), the text the file had when it was last known (what the box starts with, if it is the editor's text in the file's own style), and where the page was scrolled to when the mode changed.
    const sourceBox = useRef(null);
    const typed = useRef("");
    const filed = useRef(doc.markdown);
    const scrolled = useRef(null);
    // The thread chosen in the list while the text was Markdown: its card opens once the editor is shown.
    const [toOpen, setToOpen] = useState(null);
    const [broken, setBroken] = useState(null);
    const [notice, setNotice] = useState(null);
    const [problem, setProblem] = useState(null);
    const [busy, setBusy] = useState(false);
    // The call whose draft the person chose not to watch, or that began while they were working in the text: the text is shown.
    const [unwatched, setUnwatched] = useState(null);
    // The document as it is stored, read when the agent's edit begins: what its quotes are found in, as the tool finds them.
    const [stored, setStored] = useState(null);
    // The comments: the threads as the server has them, what their marked passages read as, the comment being written, and the card that is open (a thread's id, or PENDING for the comment being written).
    const [threads, setThreads] = useState({ items: [], loaded: false, error: null });
    const [texts, setTexts] = useState(() => new Map());
    // Which threads (by their words) the editor was last asked to mark: until it has been asked about these, a thread that is not marked is not one that cannot be.
    const [asked, setAsked] = useState(null);
    const [compose, setCompose] = useState(null);
    const [active, setActive] = useState(null);
    const [commentProblem, setCommentProblem] = useState(null);
    // Why no chat could be opened to ask the agent in, for a comment that was saved all the same.
    const [askProblem, setAskProblem] = useState(null);
    // Where a comment that asks the agent can go, as the server said with the threads; the chats this page opened; the one being opened.
    const asking = useRef(null);
    const opened = useRef(new Set());
    const opening = useRef(null);
    const composed = useRef(0);
    // Comments typed and not sent, by the card they are in (comments.js): they outlive the cards, which are drawn again each time they
    // are opened, in the list or on the sheet. A comment typed and not sent is lost with the page: the browser asks first, as it does
    // for a document not saved.
    const drafts = useRef(new Map());
    useEffect(() => {
      const warn = (e) => {
        if (![...drafts.current.values()].some((words) => words.trim())) return;
        e.preventDefault();
        e.returnValue = "";
      };
      window.addEventListener("beforeunload", warn);
      return () => window.removeEventListener("beforeunload", warn);
    }, []);
    // A change begun to a comment that is no longer there is nothing to warn of.
    useEffect(() => {
      if (!threads.loaded) return;
      const ids = new Set(threads.items.flatMap((x) => x.comments.map((c) => c.id)));
      for (const key of [...drafts.current.keys()]) if (key.startsWith("edit-") && !ids.has(key.slice(5))) drafts.current.delete(key);
    }, [threads]);
    const workspace = useRef(null);
    const sheet = useRef(null);
    // The whole of it, measured for whether the list of comments fits beside the sheet.
    const root = useRef(null);
    const [wide, setWide] = useState(false);
    // Where the selection is, for the toolbar; which panel is open at the side (the comments, the history, or none); the card that is to have the focus when
    // it opens (a click leaves the focus in the text); a count that draws the open card again, which places it again, when the text moved.
    const [format, setFormat] = useState(null);
    const [side, setSide] = useState(null);
    // The earlier revision looked at in the History panel (`{ revision, markdown }`, or `error`), which is drawn in the text's place.
    const [looking, setLooking] = useState(null);
    // Set by a restore that is done: the focus goes to the text (see the effect after `old`).
    const toText = useRef(false);
    const looked = useRef(0);
    const commentsButton = useRef(null);
    const historyButton = useRef(null);
    const listed = side === "comments";
    const history = side === "history";
    const [takeFocus, setTakeFocus] = useState(null);
    const [, setRelayout] = useState(0);
    // What the editor's callbacks, which are made once, need of what the page is now.
    const now = useRef({});
    // Asks the server for the threads again: set once the page has a document to ask about.
    const refresh = useRef(() => {});
    // Whether there are any, which is when a save is followed by asking after them (see `send`).
    const commented = useRef(false);
    commented.current = threads.items.length > 0;
    const url = documentUrl(folder, id);

    useEffect(() => {
      const mount = document.createElement("div");
      host.current.append(mount);
      let editor = null;
      let gone = false;
      // The text once the editor is gone: what a save that is still on its way sends.
      let frozen = null;
      // The page is being closed: a save then has to outlive it.
      let leaving = false;
      // What changed meanwhile, taken into the editor, and the stream that tells of it: once the editor is drawn.
      let live = null;
      let stream = null;
      let retry = null;
      let failed = 0;
      let connected = false;
      // Which answer to a request for the threads is the newest: an older one that comes late is not taken.
      let latest = 0;
      refresh.current = async () => {
        const mine = ++latest;
        try {
          const body = await portal.api.json(`${url}/threads`);
          asking.current = body.ask;
          // The same threads as before are left as they are, so that a save every second does not draw them again.
          if (!gone && mine === latest) setThreads((now) => (now.loaded && !now.error && JSON.stringify(now.items) === JSON.stringify(body.threads) ? now : { items: body.threads, loaded: true, error: null }));
        } catch (error) {
          // The threads that were shown stay; only a page that has none yet says why.
          if (!gone && mine === latest) setThreads((now) => ({ ...now, error }));
        }
      };
      // The editor, or what takes its place for the saver and for what changes from outside: the box, while the text is written as Markdown.
      let proxy = null;
      const read = () => frozen ?? proxy.markdown();
      const saver = createSaver({
        read,
        send: (markdown, base) =>
          portal.api.json(url, { method: "PUT", body: JSON.stringify({ markdown, base }), keepalive: leaving }).then((answer) => {
            // The server puts the passages of the comments in step with each revision when it is asked for them: after each save, so that each
            // step is a small one and a passage is not lost in a big one.
            if (commented.current) void refresh.current();
            filed.current = markdown;
            // The file was gone (deleted, or renamed) and the save made it again: the person is told, since the document is not where it was.
            if (answer.recreated) setNotice({ kind: "recreated", revision: answer.revision });
            return answer;
          }),
        onMerged: (answer, sent) => live?.merged(answer, sent),
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
      // Closing the page asks first when the text cannot be saved (a conflict, an error) or cannot be sent on the way out
      // (a request that outlives the page is small); text that autosave is on its way with, and that fits, does not.
      const ask = (e) => {
        const { status, base } = saver.state();
        if (status === "conflict" || status === "error" || (editor && saver.unsaved() && new TextEncoder().encode(JSON.stringify({ markdown: read(), base })).length > KEEPALIVE_BYTES)) e.preventDefault();
      };
      const key = (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
          e.preventDefault();
          save();
        } else if (e.altKey && e.code === "KeyM" && (e.metaKey || (e.ctrlKey && /^m$/i.test(e.key))) && !e.getModifierState?.("AltGraph")) {
          // As in a word processor: comment on what is selected, or open the comment at the cursor. Not AltGr+M (reported as Ctrl+Alt on
          // Windows), which types a character on some layouts (µ on a German one): there it is a letter of the text, and is left to it.
          e.preventDefault();
          now.current.comment();
        } else if (e.key === "Escape" && now.current.active !== null) {
          // A card opened by a click has no focus in it: Escape in the text closes it too. With none open, Escape is left alone.
          e.preventDefault();
          now.current.close();
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
          editor = await edit.createEditor({
            root: mount,
            markdown: doc.markdown,
            onChange: () => saver.changed(),
            onThread: (thread) => now.current.clicked(thread),
            onPlaced: (placed) => {
              setTexts(placed);
              setRelayout((n) => n + 1);
            },
            onFormat: (now) => setFormat(now),
          });
        } catch (e) {
          if (!gone) setBroken(e);
          return;
        }
        if (gone) return void editor.destroy();
        /** Puts a text in the box, keeping the caret where it is. */
        const put = (next) => {
          if (sourceBox.current) replaceText(sourceBox.current, next);
          typed.current = sourceBox.current ? sourceBox.current.value : next;
        };
        // What the box says the text is: the text as it was saved where it is only written in another style (the editor writes Markdown in its own, and
        // the same words are not a change), else as it is typed.
        let seenText = { raw: null, base: null, out: null };
        const boxText = () => {
          const raw = sourceBox.current ? sourceBox.current.value : typed.current;
          const base = saver.baseline();
          if (seenText.raw !== raw || seenText.base !== base) seenText = { raw, base, out: raw === base ? raw : editor.normalize(raw) === base ? base : raw };
          return seenText.out;
        };
        const inSource = () => modeNow.current === "markdown";
        proxy = {
          ...editor,
          markdown: () => (inSource() ? boxText() : editor.markdown()),
          apply: (next) => (inSource() ? put(next) : editor.apply(next)),
          replace: (next) => (inSource() ? put(next) : editor.replace(next)),
          focus: () => (inSource() ? sourceBox.current?.focus({ preventScroll: true }) : editor.focus()),
          focusEnd: () => {
            if (!inSource()) return editor.focusEnd();
            sourceBox.current?.focus({ preventScroll: true });
            sourceBox.current?.setSelectionRange(sourceBox.current.value.length, sourceBox.current.value.length);
          },
        };
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
        parts.current = {
          editor: proxy,
          visual: editor,
          saver,
          url,
          // The box is given the text: the file's, where that is the editor's text in the file's own style, else the editor's.
          seed: () => {
            const text = editor.markdown();
            put(editor.normalize(filed.current) === text ? filed.current : text);
          },
          // The editor is given the text of the box, where it differs from its own.
          toVisual: () => {
            const text = sourceBox.current ? sourceBox.current.value : typed.current;
            if (editor.normalize(text) !== editor.markdown()) editor.replace(text);
          },
        };
        if (inSource()) parts.current.seed();
        live = createLive({
          editor: proxy,
          saver,
          revision: doc.revision,
          load: () =>
            portal.api.json(url).then((body) => {
              filed.current = body.markdown;
              return body;
            }),
          notify: ({ kind, revision, author }) => {
            if (kind === "conflict") return;
            setNotice({ kind, revision, author });
            // What changed meanwhile may have moved the passages of the comments.
            void refresh.current();
          },
        });
        // Told where the document stands as it opens, which is how a change between its load and now is found, and after each revision.
        const listen = () => {
          const source = new EventSource(`${url}/events`);
          stream = source;
          source.addEventListener("revision", (e) => {
            failed = 0;
            try {
              void live.seen(JSON.parse(e.data));
            } catch {
              // A message that is not one of ours: nothing to take from it.
            }
          });
          // The comments changed (the agent wrote one, or another window did): asked for again.
          source.addEventListener("threads", () => void refresh.current());
          // A stream that is back may have missed such a message.
          source.onopen = () => {
            if (connected) void refresh.current();
            connected = true;
          };
          // One that dropped is asked for again after a while, longer each time, as the chat's own stream is: the first message of a new one
          // says where the document stands, so nothing that happened meanwhile is missed. (The browser would not ask again for one a proxy refused.)
          source.addEventListener("error", () => {
            source.close();
            if (!gone) retry = setTimeout(listen, Math.min(2000 * 2 ** failed++, 30_000));
          });
        };
        if (typeof EventSource !== "undefined") listen();
        void refresh.current();
        setReady(true);
      })();

      return () => {
        gone = true;
        clearTimeout(retry);
        stream?.close();
        live?.close();
        window.removeEventListener("pagehide", hide);
        window.removeEventListener("pageshow", returned);
        window.removeEventListener("beforeunload", ask);
        document.removeEventListener("visibilitychange", hidden);
        if (editor) {
          frozen = proxy.markdown();
          // Leaving the page is not a reason to lose text: it is saved now, and kept until it is. Kept here too, not only when
          // the saver's state changes: text typed after a conflict changed no state, and has no other way to be kept.
          if (saver.unsaved()) keepDraft(folder, id, { base: saver.state().base, markdown: frozen });
          void saver.flush();
          void editor.destroy();
        } else saver.dispose();
        parts.current = null;
        mount.remove();
      };
    }, [folder, id]);

    // Decided once, as the agent's call begins, and before it is drawn: whether the person is working in the text then.
    React.useLayoutEffect(() => {
      if (draft?.call && (host.current?.contains(document.activeElement) || sourceBox.current === document.activeElement || parts.current?.saver.unsaved())) setUnwatched(draft.call);
    }, [draft?.call]);
    useEffect(() => {
      if (!draft?.call) return;
      let here = true;
      portal.api.json(url).then(
        (body) => here && setStored({ call: draft.call, markdown: body.markdown }),
        () => {},
      );
      return () => void (here = false);
    }, [draft?.call]);
    const edited = React.useMemo(() => (draft && stored?.call === draft.call ? drafted(stored.markdown, draft.edits) : null), [draft?.call, draft?.edits, stored]);

    // Wide enough for the list of comments beside the sheet: as the page or the panel is now.
    useEffect(() => {
      const box = root.current;
      if (!box || typeof ResizeObserver === "undefined") return;
      const watch = new ResizeObserver(() => setWide(box.clientWidth >= LIST_BESIDE));
      watch.observe(box);
      setWide(box.clientWidth >= LIST_BESIDE);
      return () => watch.disconnect();
    }, []);
    // The sheet changes its height as the text is typed: the card of a comment is placed again at its passage.
    useEffect(() => {
      const sheet = host.current;
      if (!sheet || typeof ResizeObserver === "undefined") return;
      const watch = new ResizeObserver(() => setRelayout((n) => n + 1));
      watch.observe(sheet);
      return () => watch.disconnect();
    }, []);
    // The markers of the comments in the right margin, level with their passages: one for each thread that is marked in the text and whose
    // card is not open, stacked where passages share a line. Measured after each drawing; drawn again only when one moved.
    const [markers, setMarkers] = useState([]);
    React.useLayoutEffect(() => {
      const frame = sheet.current?.getBoundingClientRect();
      let found = [];
      if (ready && !watching && !old && !plain && frame && frame.width >= MARGIN_MIN) {
        for (const thread of threads.items) {
          if (thread.status !== "open" || thread.orphaned || thread.id === active || !texts.has(thread.id)) continue;
          const line = rectsOf(thread.id)[0];
          if (line) found.push({ id: thread.id, count: thread.comments.length, text: texts.get(thread.id), top: line.top - frame.top - sheet.current.clientTop + (line.height - MARKER_HEIGHT) / 2 });
        }
        found.sort((a, b) => a.top - b.top);
        let low = -Infinity;
        for (const marker of found) {
          marker.top = Math.round(Math.max(marker.top, low));
          low = marker.top + MARKER_HEIGHT + 2;
        }
      }
      setMarkers((now) => (now.length === found.length && now.every((m, i) => m.id === found[i].id && m.top === found[i].top && m.count === found[i].count && m.text === found[i].text) ? now : found));
    });
    /** Where on the screen the passage of thread `thread` is, a rectangle for each line of it (none where it is not marked). */
    const rectsOf = (thread) => [...(host.current?.querySelectorAll(`[data-pd-thread="${CSS.escape(thread)}"]`) ?? [])].flatMap((el) => [...el.getClientRects()]).filter((r) => r.width > 0 || r.height > 0);

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
          filed.current = markdown;
          editor.replace(markdown);
          saver.adopt(done.revision, editor.markdown());
          setNotice({ kind: "restored", from: revision, to: done.revision });
          // The button that asked is disabled meanwhile and the preview with it goes: the person goes on in the text.
          toText.current = true;
          return true;
        } catch (e) {
          if (e.status !== 409 || !Number.isInteger(e.body?.revision)) throw e;
          // Changed since the page last saved or loaded it: shown as it is now, and the person asks again if it is still wanted.
          editor.replace(e.body.markdown ?? "");
          saver.adopt(e.body.revision, editor.markdown());
          setNotice({ kind: "moved", revision: e.body.revision, from: revision });
          // The page is the document as it is now, not the old text beside a note that says it moved on.
          look(null);
          toText.current = true;
          return false;
        }
      } catch (e) {
        setProblem(e.message);
        return false;
      } finally {
        setBusy(false);
      }
    };

    // The passages of the comments that are open (and of the one being written) are marked in the text. Marked again when their words
    // change, not when only the places they are at do: the editor moves a mark with the text as it is typed.
    const open = threads.items.filter((x) => x.status === "open" && !x.orphaned);
    const wanted = JSON.stringify(open.map((x) => [x.id, x.quote, x.prefix, x.suffix]));
    useEffect(() => {
      if (!ready) return;
      const list = [...open];
      // Marked as a comment's own once its first save has made the thread.
      if (compose && !compose.threadId) list.push({ id: PENDING, pending: true, quote: compose.passage.quote, prefix: compose.passage.prefix, suffix: compose.passage.suffix, start: compose.passage.start });
      parts.current?.editor.threads(list);
      setAsked(wanted);
    }, [ready, wanted, compose?.passage, compose?.threadId]);
    // The passage of the open card is drawn as the one looked at (the one being written has its own look).
    useEffect(() => {
      if (ready) parts.current?.editor.activate(active === PENDING ? null : active);
    }, [ready, active]);
    // A thread that is looked at is brought into view in the list.
    useEffect(() => {
      if (active && listed) workspace.current?.querySelector(`.pd-side [data-thread="${CSS.escape(active)}"]`)?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
    }, [active, listed]);

    /** The passage selected is commented on: the text is saved first, so that the passage is in a revision the server has. */
    const startComment = async () => {
      // There is nothing to select a passage in, in the Markdown: the comment is on the text as it is drawn.
      if (modeNow.current === "markdown") return;
      const { editor, saver } = parts.current;
      setCommentProblem(null);
      if (!(await saver.flush())) return;
      const passage = editor.selection();
      if (!passage) return;
      if (passage.quote.length > MAX_QUOTE) return setCommentProblem(t("Select less text: a comment can be on at most {n} characters.", { n: MAX_QUOTE }));
      // A comment that was being written on another passage, and kept (its card closed with words in it), is not thrown away unasked: it is
      // given up with the person's say so, and else its card is opened again.
      const kept = now.current.compose;
      if (kept && !kept.threadId && drafts.current.get(`compose-${kept.key}`)?.trim()) {
        const ok = await ui.confirm({ title: t("Discard the comment you started?"), message: t("What you wrote in it is lost."), confirmLabel: t("Discard"), danger: true });
        if (!ok) {
          setTakeFocus(PENDING);
          setActive(PENDING);
          return;
        }
      }
      for (const key of drafts.current.keys()) if (key.startsWith("compose-")) drafts.current.delete(key);
      setTakeFocus(null);
      setActive(PENDING);
      // A list over the bottom of the page would cover the card.
      if (!wide) setSide(null);
      setCompose({ key: ++composed.current, passage, base: saver.state().base, threadId: null });
    };

    /** A thread the server changed is taken in its place. */
    const taken = (made) => setThreads((now) => ({ ...now, items: now.items.map((x) => (x.id === made.id ? made : x)) }));
    const post = (path, body) => portal.api.json(`${url}/threads/${path}`, { method: "POST", body: JSON.stringify(body) });

    /**
     * The chat a comment that asks the agent is sent to: the one the person is in, if it works in this folder (the page knows it from
     * the chat that was on screen last, client.js); one opened for the folder when they are in none, which is the one from then on.
     * A chat's own document is answered by that chat. Null where there is none, and the thread says it was not delivered.
     */
    const chatFor = async (words) => {
      if (!asksAgent(words)) return undefined;
      const { chats = [], own = false, workspace } = asking.current ?? {};
      if (own) return chats[0]?.id ?? null;
      const here = activeChat();
      if (here && (opened.current.has(here) || chats.some((chat) => chat.id === here))) return here;
      if (!workspace) return null;
      try {
        opening.current ??= portal.api
          .json("/api/sessions", { method: "POST", body: JSON.stringify({ title: t("Comments on {title}", { title: doc.title }), workspace }) })
          .then((chat) => {
            opened.current.add(chat.id);
            remember(chat.id);
            return chat.id;
          })
          .finally(() => void (opening.current = null));
        return await opening.current;
      } catch (e) {
        setAskProblem(e.message);
        return null;
      }
    };

    /**
     * Sends a comment of the person's, once they send it: the thread with it, when it is the first comment of a passage
     * (`thread.id` is null), or the next comment of one. Only now is a chat looked for (or opened) to ask, for one with @agent in
     * it. Returns the comment's id and the thread's.
     */
    const write = async (thread, words, _id, writing) => {
      const text = words.trim();
      const chat = await chatFor(text);
      const body = { body: text, ...(chat === undefined ? {} : { chat }) };
      if (!thread.id) {
        const { passage, base, key } = writing;
        const made = await portal.api.json(`${url}/threads`, { method: "POST", body: JSON.stringify({ ...body, base, quote: passage.quote, prefix: passage.prefix, suffix: passage.suffix, start: passage.start }), keepalive: true });
        setThreads((now) => ({ ...now, items: [...now.items.filter((x) => x.id !== made.id), made] }));
        setCompose((now) => (now?.key === key ? { ...now, threadId: made.id } : now));
        setActive(made.id);
        return { comment: made.comments.at(-1).id, thread: made.id };
      }
      const added = await portal.api.json(`${url}/threads/${thread.id}/comments`, { method: "POST", body: JSON.stringify(body), keepalive: true });
      taken(added);
      return { comment: added.comments.at(-1).id, thread: thread.id };
    };

    /** The comment that was being written is let go: it is a thread in the list like the others. */
    const finish = (thread) => {
      setCompose(null);
      setActive(thread.id);
      // The card the comment was written in is the thread's from now on: the box of the next one has the focus, where this one had it.
      setTakeFocus(thread.id);
    };
    const cancel = (writing) => {
      drafts.current.delete(`compose-${writing.key}`);
      setCompose((now) => (now?.key === writing.key ? null : now));
    };
    /** A thread that is gone, from the server or from another window, is gone from the list and from the text. */
    const dropped = (id) => {
      drafts.current.delete(id);
      setThreads((now) => ({ ...now, items: now.items.filter((x) => x.id !== id) }));
      // Its card was the one open: the text has the focus the card had.
      if (now.current.active === id) {
        setActive(null);
        parts.current?.editor.focus();
      }
    };
    /**
     * Changes a comment that is in the list (not the one in the box). The comment asks the agent again only if it is the last of an
     * open thread, as the server decides; the chat to ask is looked for only then, so that a change to an older one opens none.
     */
    const changeComment = async (thread, comment, words) => {
      const text = words.trim();
      // A comment whose ask a chat has taken asks nobody again: no chat is looked for, or opened, for it.
      const asks = thread.status === "open" && thread.comments.at(-1)?.id === comment.id && !(thread.ping?.comment === comment.id && thread.ping.sent);
      const chat = asks ? await chatFor(text) : undefined;
      taken(await portal.api.json(`${url}/threads/${thread.id}/comments/${comment.id}`, { method: "PUT", body: JSON.stringify({ body: text, ...(chat === undefined ? {} : { chat }) }) }));
    };
    const removeComment = async (thread, comment) => {
      const gone = await portal.api.json(`${url}/threads/${thread.id}/comments/${comment.id}`, { method: "DELETE" });
      if (gone.removed === "comment") taken(gone.thread);
      else dropped(thread.id);
    };
    const removeThread = async (thread) => {
      try {
        await portal.api.json(`${url}/threads/${thread.id}`, { method: "DELETE" });
      } catch (e) {
        // Gone already (another window, or the comment the box had saved was its only one): that is what was asked.
        if (e.body?.code !== "thread_not_found") throw e;
      }
      dropped(thread.id);
    };
    // A resolved thread is not marked in the text any more: its card is closed, and the text has the focus again.
    const resolve = async (thread) => {
      taken(await post(`${thread.id}/resolve`, {}));
      if (now.current.active === thread.id) {
        setActive(null);
        parts.current?.editor.focus();
      }
    };
    const reopen = async (thread) => taken(await post(`${thread.id}/reopen`, {}));
    const seen = async (thread) => taken(await post(`${thread.id}/seen`, {}));
    /** The thread chosen in the list: its passage is brought into view and its card opened there, with the focus in it. */
    const show = (thread) => {
      // The comment being written is a card of its own, which is there only while there is one.
      if (thread === PENDING && !now.current.compose) return;
      // The card is on the text as it is drawn: from the Markdown, the editor comes first, and the card opens once it is there.
      if (modeNow.current === "markdown") {
        setToOpen(thread);
        void switchTo("visual");
        return;
      }
      setTakeFocus(thread);
      setActive(thread);
      parts.current?.editor.reveal(thread);
      // A list over the bottom of the page would cover the card.
      if (!wide) setSide(null);
    };
    /**
     * The card that is open is closed. A comment being written with nothing typed in it is given up with it; with words in it, it is
     * kept (its passage stays marked and a click on it opens the card again), as what is typed in a thread's box is.
     */
    const closeCard = ({ focus = false } = {}) => {
      const { active, compose } = now.current;
      if (compose && (active === PENDING || (compose.threadId && active === compose.threadId))) {
        if (compose.threadId) setCompose(null);
        else if (!drafts.current.get(`compose-${compose.key}`)?.trim()) cancel(compose);
      }
      setTakeFocus(null);
      setActive(null);
      if (focus) parts.current?.editor.focus();
    };
    /** The text was clicked: in a marked passage (`id`) that opens the card of its comment, anywhere else it closes the open one. */
    const clicked = (id) => {
      if (id === null || id === now.current.active) {
        if (id === null) closeCard();
        return;
      }
      if (id === PENDING && !now.current.compose) return;
      setTakeFocus(null);
      setActive(id);
    };
    /** Comment on what is selected, or open the comment the cursor is in. */
    const comment = () => {
      // Something selected in the text, as the browser has it.
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed && host.current?.contains(selection.anchorNode)) void startComment();
      else {
        const id = parts.current?.editor.threadAtCaret();
        if (id) show(id);
      }
    };
    now.current = { active, compose, clicked, comment, close: closeCard };
    // In the order of the text, those that have no place last.
    const ordered = [...threads.items].sort((a, b) => (a.start ?? Infinity) - (b.start ?? Infinity) || a.createdAt.localeCompare(b.createdAt));

    const { status, base, conflict, error, warning } = view;
    // What the agent is writing is shown as it comes while the person has nothing unsaved, unless they chose the saved text.
    const watching = edited !== null && status === "saved" && unwatched !== draft.call;
    const label = { saved: t("Saved"), dirty: t("Unsaved changes"), saving: t("Saving…"), conflict: t("Not saved"), error: t("Not saved") }[status];
    const openCount = threads.items.filter((x) => x.status === "open").length;
    /**
     * The text is written in the other way: in the editor, or as Markdown in a box. What is in the one goes to the other (nothing is lost, and
     * what is not saved yet stays unsaved); going to the editor saves first where it can, so that the text it takes is a revision's.
     */
    const switchTo = async (next) => {
      const p = parts.current;
      if (!p || modeNow.current === next) return;
      const area = workspace.current?.querySelector(".pd-scroll");
      scrolled.current = area && area.scrollHeight > area.clientHeight ? area.scrollTop / (area.scrollHeight - area.clientHeight) : 0;
      if (next === "markdown") {
        p.seed();
        modeNow.current = next;
      } else {
        await p.saver.flush();
        // Another switch came while it was saved.
        if (modeNow.current !== "markdown") return;
        p.toVisual();
        // What the box held was saved as it was typed, which the editor writes in its own style: that is not a change to save.
        const clean = p.saver.state().status === "saved" && !p.saver.unsaved();
        modeNow.current = next;
        if (clean) p.saver.adopt(p.saver.state().base, p.visual.markdown());
        else p.saver.changed();
        // The editor was not told of what changed in the box: the passages of the comments are asked for again.
        void refresh.current();
      }
      keepMode(next);
      setMode(next);
    };
    // The box is as high as its text, also when the page is as wide as it was not when it was drawn; the page is where it was in the text.
    React.useLayoutEffect(() => {
      const box = sourceBox.current;
      if (plain && box) fit(box);
      const area = workspace.current?.querySelector(".pd-scroll");
      if (area && scrolled.current !== null) area.scrollTop = scrolled.current * Math.max(0, area.scrollHeight - area.clientHeight);
      scrolled.current = null;
    }, [plain, ready]);
    useEffect(() => {
      const box = sourceBox.current;
      if (!box || typeof ResizeObserver === "undefined") return;
      const watch = new ResizeObserver(() => fit(box));
      watch.observe(box);
      return () => watch.disconnect();
    }, []);
    // The thread chosen in the list from the Markdown: its card opens now that the editor is shown.
    useEffect(() => {
      if (toOpen && !plain && ready) {
        const thread = toOpen;
        setToOpen(null);
        show(thread);
      }
    }, [toOpen, plain, ready]);
    // The side panel: one at a time, the other's place taken. Closed from within (Close, Escape), the button it was opened from has the focus again.
    const openers = { comments: commentsButton, history: historyButton };
    const closeSide = ({ focus = false } = {}) => {
      if (focus && side) openers[side].current?.focus({ preventScroll: true });
      setSide(null);
    };
    const toggleSide = (which) => setSide((now) => (now === which ? null : which));
    /** An earlier revision read, to be drawn in the text's place; null goes back to the text. */
    const look = (revision) => {
      const mine = ++looked.current;
      if (revision === null) return setLooking(null);
      setLooking({ revision });
      portal.api.json(`${url}/revisions/${revision}`).then(
        (body) => mine === looked.current && setLooking({ revision, markdown: body.markdown }),
        (e) => mine === looked.current && setLooking({ revision, error: e.message }),
      );
    };
    // The revision is let go of with the panel it was chosen in.
    useEffect(() => {
      if (side !== "history") {
        looked.current++;
        setLooking(null);
      }
    }, [side]);
    // An earlier revision is on the page in the text's place (the current one is the text itself); one that cannot be read is said in the panel.
    const old = history && looking && looking.revision !== base && !looking.error ? looking : null;
    // A restore ends in the text, once the earlier revision is off the page (the editor is not there to take the focus before).
    useEffect(() => {
      if (!toText.current || old) return;
      toText.current = false;
      parts.current?.editor.focus();
    });
    const print = () => {
      const editor = parts.current?.editor;
      // The editor draws the page that is printed: it has the text of the box first.
      if (modeNow.current === "markdown") parts.current?.toVisual();
      if (editor) printDocument(doc.title, editor.html());
    };
    // The card that is open, on the sheet: the comment being written, or the thread whose passage is marked in the text (one that is not
    // cannot be anchored: it is in the list). A thread just made has no mark until the editor has been asked for it.
    const written = compose && (active === PENDING || (compose.threadId !== null && active === compose.threadId));
    const madeOf = compose && threads.items.find((x) => x.id === compose.threadId);
    // A thread whose passage is gone while its card is open (the agent rewrote the text) keeps the card, at the place it had, with the note that
    // says so: what is typed in it is not taken from under the person's hands.
    const shown = !written && active ? threads.items.find((x) => x.id === active) : null;
    const card =
      ready && !watching && !old && !plain
        ? written
          ? { key: `compose-${compose.key}`, compose, mark: compose.threadId ?? PENDING, thread: madeOf ?? { id: null, status: "open", orphaned: false, quote: compose.passage.quote, toAgent: false, answered: false, ping: null, comments: [] } }
          : shown && { key: shown.id, thread: shown, mark: shown.id }
        : null;
    // What is open at the side: the list of all the comments, or the history.
    const list =
      history && ready
        ? h(History, { folder, id, current: base, busy, shown: looking, onLook: look, onRestore: restore, onClose: closeSide })
        : listed && ready
        ? h(Comments, {
            threads: ordered,
            loaded: threads.loaded,
            error: threads.error,
            texts,
            settled: asked === wanted,
            active,
            compose,
            drafts: drafts.current,
            onClose: closeSide,
            onRetry: () => void refresh.current(),
            onActivate: show,
            onWrite: write,
            onFinish: finish,
            onCancel: cancel,
            onResolve: resolve,
            onReopen: reopen,
            onSeen: seen,
            onEdit: changeComment,
            onDelete: removeComment,
            onDeleteThread: removeThread,
          })
        : null;
    return h(
      "div",
      { className: "pd-doc", ref: root, "data-layout": wide ? "wide" : "narrow" },
      h(
        "div",
        { className: "pd-titlebar" },
        h("button", { type: "button", className: "pd-back", onClick: leave }, `← ${t("All documents")}`),
        h(
          "div",
          { className: "pd-docname" },
          h(Icon, { name: "file" }),
          h("div", null, h("strong", { className: "pd-doctitle" }, doc.title), h("span", { className: "pd-meta" }, `documents/${doc.name}`)),
        ),
        h("span", { className: "pd-state", "data-status": status, "aria-live": "polite" }, `${label} · ${t("Revision {n}", { n: base })}`),
        h(
          "div",
          { className: "pd-bar-end" },
          // How the text is written: the editor, or Markdown. The browser keeps the choice.
          h(
            "div",
            { className: "pd-modes", role: "group", "aria-label": t("Editing mode") },
            ["visual", "markdown"].map((way) => h("button", { key: way, type: "button", "aria-pressed": mode === way, disabled: !ready, onClick: () => void switchTo(way) }, way === "visual" ? t("Visual") : t("Markdown"))),
          ),
          h(BarButton, { icon: "comments", label: t("Comments"), expanded: listed, badge: openCount || null, buttonRef: commentsButton, onClick: () => toggleSide("comments") }),
          h(BarButton, { icon: "history", label: t("History"), expanded: history, disabled: !ready, buttonRef: historyButton, onClick: () => toggleSide("history") }),
          h(Menu, {
            icon: "download",
            label: t("Download"),
            disabled: !ready,
            items: [
              { key: "md", icon: "file", label: t("Markdown (.md)"), href: `${url}/download`, download: doc.name },
              { key: "pdf", icon: "printer", label: t("PDF (print)"), onClick: print },
            ],
          }),
          onExpand && h(BarButton, { icon: "expand", label: t("Open on its own page"), onClick: async () => (!parts.current || (await parts.current.saver.flush())) && onExpand() }, t("Full page")),
        ),
      ),
      // Nothing of the formatting is of use in the Markdown, where it is written out: the toolbar is not there.
      !plain && h(Toolbar, { format, disabled: !ready || watching || Boolean(old), onCommand: (name, arg) => parts.current?.editor.command(name, arg), onComment: () => void startComment(), onFocusText: () => parts.current?.editor.focus() }),
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
      commentProblem && h(ui.ErrorBanner, { onClose: () => setCommentProblem(null) }, t("Could not comment: {error}", { error: commentProblem })),
      askProblem && h(ui.WarnBanner, { onClose: () => setAskProblem(null) }, t("Could not open a chat to ask the agent in: {error}", { error: askProblem })),
      warning && h(ui.WarnBanner, { onClose: () => parts.current?.saver.dismissWarning() }, warningText(warning)),
      draft &&
        h(
          "div",
          { className: "pd-note pd-writing", role: "status" },
          h("span", null, watching ? t("The agent is writing in this document…") : t("The agent is writing in this document. What it writes comes in when it is done.")),
          watching && h("button", { type: "button", className: ui.classes.ghost, onClick: () => setUnwatched(draft.call) }, t("Show the saved text")),
        ),
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
              updated: () => (notice.author === "agent" ? t("The agent changed this document. It is now at revision {n}.", { n: notice.revision }) : t("This document was changed from elsewhere. It is now at revision {n}.", { n: notice.revision })),
              merged: () => t("The document changed meanwhile and is now at revision {n}. Its changes were merged into your text.", { n: notice.revision }),
              recreated: () => t("This document's file had been deleted or renamed. It was made again from your text, and is now at revision {n}.", { n: notice.revision }),
            }[notice.kind](),
          ),
          h("button", { type: "button", className: ui.classes.ghost, onClick: () => setNotice(null) }, t("Close")),
        ),
      old &&
        h(
          "div",
          { className: "pd-note pd-old-note", role: "status" },
          h("span", null, t("You are reading revision {n}, an earlier text. It cannot be edited here; the document itself has not changed.", { n: old.revision })),
          h("button", { type: "button", className: ui.classes.ghost, onClick: () => look(null) }, t("Back to the current text")),
        ),
      broken && h(ui.ErrorBanner, null, t("The editor could not be loaded: {error}", { error: broken.message })),
      h(
        "div",
        { ref: workspace, className: "pd-desk pd-workspace" },
        h(
          "div",
          { className: "pd-scroll" },
          h(
            "div",
            {
              className: "pd-sheet",
              ref: sheet,
              // A click on the page under the text, or beside it, is a click in the text: the caret goes to its end, as on a word processor's page.
              onClick: (e) => {
                if (!e.target.closest(".ProseMirror, .pd-popover, .pd-draft, button, a, input, textarea") && parts.current && !watching && !old) parts.current.editor.focusEnd();
              },
            },
            !ready && !broken && h(ui.RowsSkeleton, { rows: 4, label: t("Loading…") }),
            watching && h("div", { className: "pd-editor pd-draft" }, h(ui.Markdown, null, shownOf(edited))),
            old &&
              h(
                "div",
                { className: "pd-editor pd-draft pd-old" },
                old.markdown === undefined ? h(ui.RowsSkeleton, { rows: 4, label: t("Loading…") }) : old.markdown.trim() ? h(ui.Markdown, null, old.markdown) : h(ui.Empty, null, t("This document is empty.")),
              ),
            h("div", { ref: host, className: "pd-editor", hidden: !ready || watching || plain || Boolean(old) }),
            h("textarea", {
              ref: sourceBox,
              className: "pd-source",
              hidden: !ready || watching || !plain || Boolean(old),
              spellCheck: false,
              wrap: "soft",
              "aria-label": t("Markdown source"),
              onInput: (e) => {
                typed.current = e.target.value;
                fit(e.target);
                parts.current?.saver.changed();
              },
              // As in the editor: the focus leaving the text saves it, and so does Ctrl+S.
              onBlur: () => void parts.current?.saver.flush(),
              onKeyDown: (e) => {
                if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
                  e.preventDefault();
                  void parts.current?.saver.flush();
                }
              },
            }),
            card &&
              h(Popover, {
                key: card.key,
                thread: card.thread,
                compose: card.compose,
                settled: asked === wanted,
                drafts: drafts.current,
                sheet: sheet.current,
                editor: host.current,
                anchor: () => {
                  const here = rectsOf(card.mark);
                  return here.length ? here : rectsOf(PENDING);
                },
                takeFocus: Boolean(card.compose) || (takeFocus !== null && takeFocus === active),
                onClose: closeCard,
                onActivate: show,
                onWrite: write,
                onFinish: finish,
                onCancel: cancel,
                onResolve: resolve,
                onReopen: reopen,
                onSeen: seen,
                onEdit: changeComment,
                onDelete: removeComment,
                onDeleteThread: removeThread,
              }),
            // After the card in the order of the page, so that Tab goes from the text to the card first.
            markers.length > 0 &&
              h(
                "div",
                { className: "pd-markers" },
                markers.map((marker) =>
                  h(
                    "button",
                    {
                      key: marker.id,
                      type: "button",
                      className: "pd-marker",
                      style: { top: `${marker.top}px` },
                      "aria-label": t("Comments on “{passage}”: {n}", { passage: marker.text.length > 30 ? `${marker.text.slice(0, 30)}…` : marker.text, n: marker.count }),
                      // A click opens the card as a click on the words does; with the keyboard (no pointer: detail 0) the box has the focus too.
                      onClick: (e) => (e.detail === 0 ? show(marker.id) : now.current.clicked(marker.id)),
                    },
                    h(Icon, { name: "comments" }),
                    h("span", null, marker.count),
                  ),
                ),
              ),
          ),
        ),
        list,
      ),
    );
  }

  /** A document of a folder, for reading and writing. Without the editor (it could not be loaded) it is read as the portal draws Markdown. */
  return function DocumentEditor({ folder, id, onBack, onExpand, draft = null }) {
    const { body, error, retry } = useAnswer(documentUrl(folder, id));
    const [edit, setEdit] = useState(null);
    const [failed, setFailed] = useState(null);
    useEffect(() => {
      let here = true;
      loadEditor().then(
        (module) => here && setEdit(module),
        (e) => here && setFailed(e),
      );
      return () => void (here = false);
    }, []);

    const back = h("button", { type: "button", className: "pd-back", onClick: onBack }, `← ${t("All documents")}`);
    if (error) return h("article", { className: "pd-document" }, back, h(ui.LoadFailed, { error, onRetry: retry }));
    if (!body || (!edit && !failed)) return h("article", { className: "pd-document" }, back, h(ui.RowsSkeleton, { rows: 4, label: t("Loading…") }));
    if (failed) {
      return h(
        "article",
        { className: "pd-document" },
        back,
        // A module that failed to load fails again when it is asked for again (the browser keeps the failure): only a new page can load it.
        h(ui.ErrorBanner, null, h("span", null, t("The editor could not be loaded: {error}", { error: failed.message })), " ", h("button", { type: "button", className: ui.classes.ghost, onClick: () => window.location.reload() }, t("Reload the page"))),
        h("p", { className: "pd-meta" }, `documents/${body.name} · ${t("Changed {date}", { date: when(body.modified) })} · `, h("a", { href: `${documentUrl(folder, id)}/download`, download: body.name }, t("Download"))),
        body.markdown.trim() ? h("div", { className: "pd-body" }, h(ui.Markdown, null, body.markdown)) : h(ui.Empty, null, t("This document is empty.")),
      );
    }
    return h("article", { className: "pd-document" }, h(Editing, { folder, id, doc: body, edit, onBack, onExpand, draft }));
  };
}
