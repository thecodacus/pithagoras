/**
 * The Documents extension's half in the portal's page: plain JavaScript,
 * loaded as it is. It puts one page into the sidebar (`nav.page`): every
 * folder chats work in that has documents, and a document opened from there
 * in an editor, with its history (document-editor.js). In a chat it draws the
 * agent's calls of its tools for a document (`chat.tool`): which document,
 * and what became of it.
 *
 * What is on the page comes from the server half's routes (server.js): a page
 * outside a chat has no chat's pi to ask. A document is asked for by the id
 * the listing gives it, never by its file's name.
 */
import { documentEditor } from "./document-editor.js";

export default function (portal) {
  const { React, ui, t } = portal;
  const { useEffect, useState } = React;
  const h = React.createElement;

  // Its own texts in another language: English is what the code says.
  portal.locale.add("de", {
    Documents: "Dokumente",
    "The Markdown files in the documents folder of each folder your chats work in.": "Die Markdown-Dateien aus dem Ordner documents in jedem Ordner, in dem deine Chats arbeiten.",
    "No folder has documents yet. A document is a Markdown file in a folder called documents, in the folder a chat works in.":
      "Noch hat kein Ordner Dokumente. Ein Dokument ist eine Markdown-Datei im Unterordner documents des Ordners, in dem ein Chat arbeitet.",
    "The documents in {folder} could not be opened: {error}": "Die Dokumente in {folder} konnten nicht geöffnet werden: {error}",
    "All documents": "Alle Dokumente",
    "Changed {date}": "Geändert {date}",
    "This document is empty.": "Dieses Dokument ist leer.",
    Saved: "Gespeichert",
    "Saving…": "Wird gespeichert…",
    "Unsaved changes": "Nicht gespeicherte Änderungen",
    "Not saved": "Nicht gespeichert",
    History: "Verlauf",
    "Hide history": "Verlauf ausblenden",
    "This document changed while you were editing it, and is now at revision {n}. Your text is kept here and has not been saved.":
      "Dieses Dokument wurde geändert, während du es bearbeitet hast, und steht jetzt bei Revision {n}. Dein Text bleibt hier erhalten und ist nicht gespeichert.",
    "Keep mine as a new revision": "Meinen Text als neue Revision behalten",
    "Take theirs": "Die andere Version übernehmen",
    "Show the other version": "Die andere Version anzeigen",
    "Take the other version?": "Die andere Version übernehmen?",
    "The text you have not saved is discarded, and the version that was saved meanwhile is shown instead.":
      "Der nicht gespeicherte Text wird verworfen, stattdessen wird die Version gezeigt, die in der Zwischenzeit gespeichert wurde.",
    "Could not save: {error}": "Speichern fehlgeschlagen: {error}",
    "Try again": "Erneut versuchen",
    "Could not restore: {error}": "Wiederherstellen fehlgeschlagen: {error}",
    "The editor could not be loaded: {error}": "Der Editor konnte nicht geladen werden: {error}",
    "Text you had not saved was brought back.": "Text, den du nicht gespeichert hattest, wurde zurückgeholt.",
    "Revision {from} is back, as revision {to}.": "Revision {from} ist wiederhergestellt, als Revision {to}.",
    "The document changed in the meantime and is now at revision {n}. Restore revision {from} again if you still want it.":
      "Das Dokument hat sich in der Zwischenzeit geändert und steht jetzt bei Revision {n}. Stelle Revision {from} noch einmal wieder her, falls du sie weiterhin möchtest.",
    "The agent changed this document. It is now at revision {n}.": "Der Agent hat dieses Dokument geändert. Es steht jetzt bei Revision {n}.",
    "This document was changed from elsewhere. It is now at revision {n}.": "Dieses Dokument wurde anderswo geändert. Es steht jetzt bei Revision {n}.",
    "The document changed meanwhile and is now at revision {n}. Its changes were merged into your text.":
      "Das Dokument hat sich in der Zwischenzeit geändert und steht jetzt bei Revision {n}. Die Änderungen wurden in deinen Text eingearbeitet.",
    "This document's file had been deleted or renamed. It was made again from your text, and is now at revision {n}.":
      "Die Datei dieses Dokuments war gelöscht oder umbenannt worden. Sie wurde aus deinem Text neu angelegt, und das Dokument steht jetzt bei Revision {n}.",
    "This document looks like it holds a secret (a private key or a token). Its history keeps every revision: take it out, and see the guide on how to remove it from the history.":
      "Dieses Dokument enthält offenbar Zugangsdaten (einen privaten Schlüssel oder ein Token). Der Verlauf behält jede Revision: Nimm sie heraus und lies in der Anleitung nach, wie du sie auch aus dem Verlauf entfernst.",
    Close: "Schließen",
    Current: "Aktuell",
    "This is the current revision.": "Das ist die aktuelle Revision.",
    "Restore this revision": "Diese Revision wiederherstellen",
    "Show older revisions": "Ältere Revisionen anzeigen",
    You: "Du",
    "The agent": "Der Agent",
    "Outside the page": "Von außerhalb",
    "Restored from revision {n}": "Wiederhergestellt aus Revision {n}",
    Created: "Erstellt",
    "Existing file": "Vorhandene Datei",
    "Created a document": "Dokument erstellt",
    "Edited a document": "Dokument bearbeitet",
    "Read a document": "Dokument gelesen",
    "Revision {n}": "Revision {n}",
    "Revision {from} to {to}": "Revision {from} auf {to}",
    "{n} edits": "{n} Änderungen",
    "1 edit": "1 Änderung",
    "No change": "Keine Änderung",
    "an earlier revision, the document is at {n}": "eine frühere Revision, das Dokument steht bei {n}",
    "Open in Documents": "In Dokumenten öffnen",
    Comments: "Kommentare",
    Comment: "Kommentieren",
    "Select the text you want to comment on.": "Wähle den Text aus, den du kommentieren willst.",
    "Select less text: a comment can be on at most {n} characters.": "Wähle weniger Text aus: Ein Kommentar kann sich auf höchstens {n} Zeichen beziehen.",
    "No comments yet. Select some text, then press Comment.": "Noch keine Kommentare. Wähle Text aus und drücke Kommentieren.",
    "Comments could not be loaded: {error}": "Kommentare konnten nicht geladen werden: {error}",
    "Could not comment: {error}": "Kommentar fehlgeschlagen: {error}",
    "New comment": "Neuer Kommentar",
    "Write a comment": "Kommentar schreiben",
    "Write a comment…": "Kommentar schreiben…",
    Cancel: "Abbrechen",
    Reply: "Antworten",
    "Reply…": "Antworten…",
    Resolve: "Erledigen",
    Resolved: "Erledigt",
    Reopen: "Wieder öffnen",
    "Show resolved ({n})": "Erledigte anzeigen ({n})",
    "Hide resolved": "Erledigte ausblenden",
    "Show in the text": "Im Text zeigen",
    "Comment thread": "Kommentarthread",
    "The passage this comment was on is no longer in the document.": "Die Textstelle, auf die sich dieser Kommentar bezog, steht nicht mehr im Dokument.",
    "The passage could not be marked in the text.": "Die Textstelle konnte im Text nicht markiert werden.",
    "1 open comment": "1 offener Kommentar",
    "{n} open comments": "{n} offene Kommentare",
    "Commented on a document": "Dokument kommentiert",
    "Replied to a comment": "Auf einen Kommentar geantwortet",
    "Resolved a comment": "Kommentar erledigt",
    "answers a comment": "beantwortet einen Kommentar",
    "Write @agent in a comment to ask the agent to answer it.": "Schreibe @agent in einen Kommentar, damit der Agent ihn beantwortet.",
    "Asked the agent": "Den Agenten gefragt",
    "Not delivered to the agent": "Nicht beim Agenten angekommen",
    "The agent answered": "Der Agent hat geantwortet",
    "{n} answered by the agent": "{n} vom Agenten beantwortet",
    "Got it": "Verstanden",
    "Comments on {title}": "Kommentare zu {title}",
    "Could not open a chat to ask the agent in: {error}": "Es konnte kein Chat geöffnet werden, in dem der Agent gefragt wird: {error}",
  });

  const icon = (path) => () =>
    h("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true }, h("path", { d: path }));
  const DocumentIcon = icon("M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5ZM14 3v5h5M9 13h6M9 17h6M9 9h1");

  const when = (iso) => new Intl.DateTimeFormat(document.documentElement.lang || undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));
  const documentUrl = (folder, id) => portal.api.url(`/folders/${encodeURIComponent(folder)}/documents/${encodeURIComponent(id)}`);

  /** Asks a route of the server half, again on `retry`: what it answered, or why it could not. */
  function useAnswer(url) {
    const [state, setState] = useState({ body: null, error: null });
    const [asked, setAsked] = useState(0);
    useEffect(() => {
      let here = true;
      setState({ body: null, error: null });
      portal.api.json(url).then(
        (body) => here && setState({ body, error: null }),
        (error) => here && setState({ body: null, error }),
      );
      return () => void (here = false);
    }, [url, asked]);
    return { ...state, retry: () => setAsked((n) => n + 1) };
  }

  function FolderList({ onOpen }) {
    const { body, error, retry } = useAnswer(portal.api.url("/folders"));
    if (error) return h(ui.LoadFailed, { error, onRetry: retry });
    if (!body) return h(ui.RowsSkeleton, { rows: 3, label: t("Loading…") });
    // A folder whose documents could not be opened is said, with the reason: left out without a word it reads as one with none.
    const problems = (body.problems ?? []).map((problem) => h(ui.ErrorBanner, { key: `problem-${problem.id}` }, t("The documents in {folder} could not be opened: {error}", { folder: problem.path, error: problem.error })));
    if (!body.folders.length) return problems.length ? problems : h(ui.Empty, null, t("No folder has documents yet. A document is a Markdown file in a folder called documents, in the folder a chat works in."));
    const section = (folder) =>
      h(
        "section",
        { key: folder.id, className: "pd-folder", "aria-labelledby": `pd-folder-${folder.id}` },
        h("h2", { id: `pd-folder-${folder.id}` }, folder.name),
        h("p", { className: "pd-path" }, folder.path),
        h(
          "ul",
          { className: "pd-list" },
          folder.documents.map((doc) =>
            h(
              "li",
              { key: doc.id },
              h(
                "button",
                { type: "button", onClick: () => onOpen({ folder: folder.id, id: doc.id }) },
                h("span", { className: "pd-title" }, doc.title),
                h("span", { className: "pd-meta" }, [doc.name, t("Changed {date}", { date: when(doc.modified) }), doc.openThreads > 0 && (doc.openThreads === 1 ? t("1 open comment") : t("{n} open comments", { n: doc.openThreads })), doc.answeredThreads > 0 && t("{n} answered by the agent", { n: doc.answeredThreads })].filter(Boolean).join(" · ")),
              ),
            ),
          ),
        ),
      );
    return [...problems, ...body.folders.map(section)];
  }

  // The Documents page is not in a chat, so it cannot tell which chat the person is in. The chat that was on screen last, in this window,
  // is the nearest it can know: this entry is there for as long as a chat is on screen, and keeps its id for the page that follows.
  const WHERE = "pithagoras-docs/chat";
  let lastChat = null;
  const remember = (chat) => {
    lastChat = chat;
    ui.storage.session.set(WHERE, chat);
  };
  const activeChat = () => lastChat ?? ui.storage.session.get(WHERE) ?? null;
  portal.slots.register("chat.background", {
    id: "where",
    component: ({ chat }) => {
      useEffect(() => remember(chat.id), [chat.id]);
      return null;
    },
  });

  const DocumentEditor = documentEditor(portal, { documentUrl, when, useAnswer, activeChat, remember });

  /**
   * A call of one of the agent's tools that names a document, in place of the
   * portal's card: what was done to it, where it stands, and a way to read it
   * on the page. The portal's own card says it best while the call runs, when
   * it failed, and for a list.
   */
  function DocumentCall({ call, card }) {
    portal.locale.use();
    const d = call.details;
    if (call.status !== "done" || typeof d?.id !== "string" || typeof d.folder !== "string") return card;
    const heading = { create: t("Created a document"), edit: t("Edited a document"), read: t("Read a document"), comment: t("Commented on a document"), reply: t("Replied to a comment"), resolve: t("Resolved a comment") }[d.action];
    if (!heading) return card;
    const facts = [`documents/${d.name}`];
    if (d.action === "edit") {
      facts.push(d.changed ? t("Revision {from} to {to}", { from: d.from, to: d.revision }) : t("No change"), d.edits === 1 ? t("1 edit") : t("{n} edits", { n: d.edits }));
      if (d.thread) facts.push(t("answers a comment"));
    } else if (d.action === "comment" || d.action === "reply" || d.action === "resolve") {
      facts.push(t("Revision {n}", { n: d.revision }));
    } else {
      facts.push(t("Revision {n}", { n: d.revision }));
      if (d.current !== undefined && d.current !== d.revision) facts.push(t("an earlier revision, the document is at {n}", { n: d.current }));
    }
    return h(
      "div",
      { className: "pd-call" },
      h(DocumentIcon),
      h("div", null, h("span", { className: "pd-by" }, heading), h("p", { className: "pd-call-title" }, d.title), h("p", { className: "pd-meta" }, facts.join(" · "))),
      h("button", { type: "button", onClick: () => portal.navigate(`/x/${portal.extension}/documents?${new URLSearchParams({ folder: d.folder, doc: d.id })}`) }, t("Open in Documents")),
    );
  }

  /** The document a link to the page names (`?folder=<id>&doc=<id>`), as the page opens it. */
  function linked() {
    const query = new URLSearchParams(window.location.search);
    const folder = query.get("folder");
    const doc = query.get("doc");
    return folder && doc ? { folder, id: doc } : null;
  }

  function DocumentsPage() {
    portal.locale.use();
    // The document open on the page, or the list of them all.
    const [open, setOpen] = useState(linked);
    return h(
      "div",
      { className: "pd-page" },
      h(ui.PageHeader, { icon: h(DocumentIcon), title: t("Documents"), description: t("The Markdown files in the documents folder of each folder your chats work in.") }),
      open ? h(DocumentEditor, { ...open, key: `${open.folder}/${open.id}`, onBack: () => setOpen(null) }) : h(FolderList, { onOpen: setOpen }),
    );
  }

  portal.slots.register("nav.page", { id: "documents", title: "Documents", icon: DocumentIcon, component: DocumentsPage });
  for (const tool of ["doc_create", "doc_read", "doc_edit", "doc_comment", "doc_reply", "doc_resolve"]) portal.slots.register("chat.tool", { id: tool, tool, component: DocumentCall });
}
