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
    "The Markdown files in the documents folder of each folder your chats work in.": "Die Markdown-Dateien im Ordner documents jedes Ordners, in dem deine Chats arbeiten.",
    "No folder has documents yet. A document is a Markdown file in a folder called documents, in the folder a chat works in.":
      "Noch hat kein Ordner Dokumente. Ein Dokument ist eine Markdown-Datei in einem Ordner namens documents, in dem Ordner, in dem ein Chat arbeitet.",
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
    "Keep mine as a new revision": "Meine als neue Revision behalten",
    "Take theirs": "Die andere übernehmen",
    "Show the other version": "Die andere Version anzeigen",
    "Take the other version?": "Die andere Version übernehmen?",
    "The text you have not saved is discarded, and the version that was saved meanwhile is shown instead.":
      "Der nicht gespeicherte Text wird verworfen, stattdessen wird die Version gezeigt, die in der Zwischenzeit gespeichert wurde.",
    "Could not save: {error}": "Speichern fehlgeschlagen: {error}",
    "Try again": "Erneut versuchen",
    "Could not restore: {error}": "Wiederherstellen fehlgeschlagen: {error}",
    "The editor could not be loaded: {error}": "Der Editor konnte nicht geladen werden: {error}",
    "Text you had not saved was brought back.": "Text, den du nicht gespeichert hattest, wurde zurückgeholt.",
    "Revision {from} is back, as revision {to}.": "Revision {from} ist zurück, als Revision {to}.",
    "The document changed in the meantime and is now at revision {n}. Restore revision {from} again if you still want it.":
      "Das Dokument hat sich in der Zwischenzeit geändert und steht jetzt bei Revision {n}. Stelle Revision {from} noch einmal wieder her, wenn du sie noch willst.",
    Close: "Schließen",
    Current: "Aktuell",
    "This is the current revision.": "Das ist die aktuelle Revision.",
    "Restore this revision": "Diese Revision wiederherstellen",
    "Show older revisions": "Ältere Revisionen anzeigen",
    You: "Du",
    "The agent": "Der Agent",
    "Outside the page": "Außerhalb der Seite",
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
    if (!body.folders.length) return h(ui.Empty, null, t("No folder has documents yet. A document is a Markdown file in a folder called documents, in the folder a chat works in."));
    return body.folders.map((folder) =>
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
                h("span", { className: "pd-meta" }, `${doc.name} · ${t("Changed {date}", { date: when(doc.modified) })}`),
              ),
            ),
          ),
        ),
      ),
    );
  }

  const DocumentEditor = documentEditor(portal, { documentUrl, when, useAnswer });

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
    const heading = { create: t("Created a document"), edit: t("Edited a document"), read: t("Read a document") }[d.action];
    if (!heading) return card;
    const facts = [`documents/${d.name}`];
    if (d.action === "edit") {
      facts.push(d.changed ? t("Revision {from} to {to}", { from: d.from, to: d.revision }) : t("No change"), d.edits === 1 ? t("1 edit") : t("{n} edits", { n: d.edits }));
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
  for (const tool of ["doc_create", "doc_read", "doc_edit"]) portal.slots.register("chat.tool", { id: tool, tool, component: DocumentCall });
}
