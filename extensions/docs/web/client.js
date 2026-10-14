/**
 * The Documents extension's half in the portal's page: plain JavaScript,
 * loaded as it is. It puts one page into the sidebar (`nav.page`): every
 * folder chats work in that has documents, and a document read from there,
 * drawn as the portal draws Markdown.
 *
 * What is on the page comes from the server half's routes (server.js): a page
 * outside a chat has no chat's pi to ask. A document is asked for by the id
 * the listing gives it, never by its file's name.
 */
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

  function DocumentView({ folder, id, onBack }) {
    const { body, error, retry } = useAnswer(documentUrl(folder, id));
    return h(
      "article",
      { className: "pd-document" },
      h("button", { type: "button", className: "pd-back", onClick: onBack }, `← ${t("All documents")}`),
      error
        ? h(ui.LoadFailed, { error, onRetry: retry })
        : !body
          ? h(ui.RowsSkeleton, { rows: 4, label: t("Loading…") })
          : h(
              React.Fragment,
              null,
              h("p", { className: "pd-meta" }, `documents/${body.name} · ${t("Changed {date}", { date: when(body.modified) })}`),
              body.markdown.trim() ? h("div", { className: "pd-body" }, h(ui.Markdown, null, body.markdown)) : h(ui.Empty, null, t("This document is empty.")),
            ),
    );
  }

  function DocumentsPage() {
    portal.locale.use();
    // The document open on the page, or the list of them all.
    const [open, setOpen] = useState(null);
    return h(
      "div",
      { className: "pd-page" },
      h(ui.PageHeader, { icon: h(DocumentIcon), title: t("Documents"), description: t("The Markdown files in the documents folder of each folder your chats work in.") }),
      open ? h(DocumentView, { ...open, key: `${open.folder}/${open.id}`, onBack: () => setOpen(null) }) : h(FolderList, { onOpen: setOpen }),
    );
  }

  portal.slots.register("nav.page", { id: "documents", title: "Documents", icon: DocumentIcon, component: DocumentsPage });
}
