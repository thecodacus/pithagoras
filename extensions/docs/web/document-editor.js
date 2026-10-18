/**
 * A document on the Documents page, edited: the editor (editor.js, loaded when
 * a document is first opened), saved as it is edited (saver.js), kept up to
 * date with what the agent and others change meanwhile (live.js), the
 * document's history with a way back to an earlier revision, and the comments
 * on its passages (comments.js).
 *
 * It is laid out as a word processor is: a bar with the document's name, where
 * it stands and what can be done with it (its history, a download, the page of
 * its own), the toolbar (toolbar.js), and the text on a sheet, with the
 * comments in the margin beside it where there is room for them.
 *
 * Plain JavaScript like the rest of the browser half, made with the portal's
 * React and building blocks (`portal.ui`).
 */
import { MAX_QUOTE } from "./anchor.js";
import { comments } from "./comments.js";
import { createLive } from "./live.js";
import { asksAgent } from "./mention.js";
import { createSaver } from "./saver.js";
import { ICONS, toolbar } from "./toolbar.js";
import { drafted, shownOf } from "./writing.js";

/** What the person's text was, kept while it is not saved (a conflict, a save that failed, a page that went away): per document, for the tab. */
const DRAFT = "pithagoras-docs/draft";
/** What a request that goes on after the page is gone may carry: the browsers allow 64 KiB, and it is kept well under. */
const KEEPALIVE_BYTES = 60 * 1024;
/** The id the passage of a comment that is being written is marked by in the editor: no thread has it. */
const PENDING = "pending";
/** How wide the document has to be for the comments to be in a margin beside the sheet, not under it. */
const FLOAT_WIDTH = 900;

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
  const Comments = comments(portal, { when });
  const Toolbar = toolbar(portal);

  const Icon = ({ name }) =>
    h("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true, className: "pd-icon" }, h("path", { d: ICONS[name] }));

  /** A button of the document's bar: an icon, and its words where there is room for them. */
  const BarButton = ({ icon, label, pressed, expanded, disabled, onClick, children }) =>
    h(
      "button",
      { type: "button", className: "pd-barbutton", title: label, "aria-pressed": pressed, "aria-expanded": expanded, disabled, onClick },
      h(Icon, { name: icon }),
      h("span", { className: "pd-barlabel" }, children ?? label),
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
  /** What the server half warns of with a save, in the person's language where it names the warning by a code; as it came where not. */
  const warningText = (warning) => (warning === "secret" ? t("This document looks like it holds a secret (a private key or a token). Its history keeps every revision: take it out, and see the guide on how to remove it from the history.") : warning);
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
    const [broken, setBroken] = useState(null);
    const [notice, setNotice] = useState(null);
    const [problem, setProblem] = useState(null);
    const [history, setHistory] = useState(false);
    const [busy, setBusy] = useState(false);
    // The call whose draft the person chose not to watch, or that began while they were working in the text: the text is shown.
    const [unwatched, setUnwatched] = useState(null);
    // The document as it is stored, read when the agent's edit begins: what its quotes are found in, as the tool finds them.
    const [stored, setStored] = useState(null);
    // The comments: the threads as the server has them, what their marked passages read as, whether something is selected to
    // comment on, the comment being written, and the thread looked at.
    const [threads, setThreads] = useState({ items: [], loaded: false, error: null });
    const [texts, setTexts] = useState(() => new Map());
    // Which threads (by their words) the editor was last asked to mark: until it has been asked about these, a thread that is not marked is not one that cannot be.
    const [asked, setAsked] = useState(null);
    const [selected, setSelected] = useState(false);
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
    const workspace = useRef(null);
    // The whole of it, measured for whether the comments fit beside the sheet.
    const root = useRef(null);
    const [float, setFloat] = useState(false);
    // Where the selection is, for the toolbar; whether the margin is shown; a count that moves the comments again when the text moved.
    const [format, setFormat] = useState(null);
    const [showComments, setShowComments] = useState(true);
    const [relayout, setRelayout] = useState(0);
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
      const read = () => frozen ?? editor.markdown();
      const saver = createSaver({
        read,
        send: (markdown, base) =>
          portal.api.json(url, { method: "PUT", body: JSON.stringify({ markdown, base }), keepalive: leaving }).then((answer) => {
            // The server puts the passages of the comments in step with each revision when it is asked for them: after each save, so that each
            // step is a small one and a passage is not lost in a big one.
            if (commented.current) void refresh.current();
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
            onSelect: (on) => setSelected(on),
            onThread: (thread) => setActive(thread),
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
        live = createLive({
          editor,
          saver,
          revision: doc.revision,
          load: () => portal.api.json(url),
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
          frozen = editor.markdown();
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
      if (draft?.call && (host.current?.contains(document.activeElement) || parts.current?.saver.unsaved())) setUnwatched(draft.call);
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

    // Wide enough for the comments beside the sheet: as the page or the panel is now.
    useEffect(() => {
      const box = root.current;
      if (!box || typeof ResizeObserver === "undefined") return;
      const watch = new ResizeObserver(() => setFloat(box.clientWidth >= FLOAT_WIDTH));
      watch.observe(box);
      setFloat(box.clientWidth >= FLOAT_WIDTH);
      return () => watch.disconnect();
    }, []);
    // The sheet changes its height as the text is typed: the comments beside it are moved with their passages.
    useEffect(() => {
      const sheet = host.current;
      if (!sheet || typeof ResizeObserver === "undefined") return;
      const watch = new ResizeObserver(() => setRelayout((n) => n + 1));
      watch.observe(sheet);
      return () => watch.disconnect();
    }, []);
    /** Where on the screen the passage of thread `thread` begins (its top), or nothing where it is not marked. */
    const anchor = (thread) => host.current?.querySelector(`[data-pd-thread="${CSS.escape(thread)}"]`)?.getBoundingClientRect().top ?? null;

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
    useEffect(() => {
      if (ready) parts.current?.editor.activate(active);
    }, [ready, active]);
    // A thread that is looked at is brought into view in the list.
    useEffect(() => {
      if (active) workspace.current?.querySelector(`.pd-thread-card[data-thread="${active}"]`)?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
    }, [active]);

    /** The passage selected is commented on: the text is saved first, so that the passage is in a revision the server has. */
    const startComment = async () => {
      const { editor, saver } = parts.current;
      setCommentProblem(null);
      if (!(await saver.flush())) return;
      const passage = editor.selection();
      if (!passage) return;
      if (passage.quote.length > MAX_QUOTE) return setCommentProblem(t("Select less text: a comment can be on at most {n} characters.", { n: MAX_QUOTE }));
      setActive(null);
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
    };
    const cancel = (writing) => setCompose((now) => (now?.key === writing.key ? null : now));
    /** A thread that is gone, from the server or from another window, is gone from the list and from the text. */
    const dropped = (id) => {
      setThreads((now) => ({ ...now, items: now.items.filter((x) => x.id !== id) }));
      setActive((now) => (now === id ? null : now));
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
    const resolve = async (thread) => taken(await post(`${thread.id}/resolve`, {}));
    const reopen = async (thread) => taken(await post(`${thread.id}/reopen`, {}));
    const seen = async (thread) => taken(await post(`${thread.id}/seen`, {}));
    const show = (thread) => {
      setActive(thread);
      parts.current?.editor.reveal(thread);
    };
    // In the order of the text, those that have no place last.
    const ordered = [...threads.items].sort((a, b) => (a.start ?? Infinity) - (b.start ?? Infinity) || a.createdAt.localeCompare(b.createdAt));

    const { status, base, conflict, error, warning } = view;
    // What the agent is writing is shown as it comes while the person has nothing unsaved, unless they chose the saved text.
    const watching = edited !== null && status === "saved" && unwatched !== draft.call;
    const label = { saved: t("Saved"), dirty: t("Unsaved changes"), saving: t("Saving…"), conflict: t("Not saved"), error: t("Not saved") }[status];
    const openCount = threads.items.filter((x) => x.status === "open").length;
    // In the margin while it is shown; under the sheet where there is no room beside it.
    const margin = float && showComments;
    const print = () => {
      const editor = parts.current?.editor;
      if (editor) printDocument(doc.title, editor.html());
    };
    const comment = () => {
      if (float) setShowComments(true);
      void startComment();
    };
    return h(
      "div",
      { className: "pd-doc", ref: root, "data-layout": float ? "float" : "list" },
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
          float && h(BarButton, { icon: "comments", label: showComments ? t("Hide comments") : t("Show comments"), pressed: showComments, onClick: () => setShowComments((on) => !on) }, [t("Comments"), openCount > 0 && h("span", { key: "n", className: "pd-count" }, openCount)]),
          h(BarButton, { icon: "history", label: history ? t("Hide history") : t("History"), expanded: history, disabled: !ready, onClick: () => setHistory((on) => !on) }),
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
      h(Toolbar, { format, disabled: !ready || watching, onCommand: (name, arg) => parts.current?.editor.command(name, arg), onComment: comment, onFocusText: () => parts.current?.editor.focus() }),
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
      history && ready && h(History, { folder, id, current: base, busy, onRestore: restore }),
      broken && h(ui.ErrorBanner, null, t("The editor could not be loaded: {error}", { error: broken.message })),
      h(
        "div",
        { ref: workspace, className: "pd-desk pd-workspace" },
        h(
          "div",
          { className: `pd-row${margin ? " has-margin" : ""}` },
          h(
            "div",
            { className: "pd-sheet" },
            !ready && !broken && h(ui.RowsSkeleton, { rows: 4, label: t("Loading…") }),
            watching && h("div", { className: "pd-editor pd-draft" }, h(ui.Markdown, null, shownOf(edited))),
            h("div", { ref: host, className: "pd-editor", hidden: !ready || watching, onClick: (e) => e.target === host.current && parts.current?.editor.focus() }),
          ),
          ready &&
            (!float || showComments) &&
            h(Comments, {
              threads: ordered,
              loaded: threads.loaded,
              error: threads.error,
              texts,
              settled: asked === wanted,
              active,
              compose,
              float: margin,
              anchor,
              relayout: `${relayout}/${active}/${float}`,
              onPick: setActive,
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
            }),
        ),
      ),
    );
  }

  /** A document of a folder, for reading and writing. Without the editor (it could not be loaded) it is read as the portal draws Markdown. */
  return function DocumentEditor({ folder, id, onBack, onExpand, draft = null }) {
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
        h("p", { className: "pd-meta" }, `documents/${body.name} · ${t("Changed {date}", { date: when(body.modified) })} · `, h("a", { href: `${documentUrl(folder, id)}/download`, download: body.name }, t("Download"))),
        body.markdown.trim() ? h("div", { className: "pd-body" }, h(ui.Markdown, null, body.markdown)) : h(ui.Empty, null, t("This document is empty.")),
      );
    }
    return h("article", { className: "pd-document" }, h(Editing, { folder, id, doc: body, edit, onBack, onExpand, draft }));
  };
}
