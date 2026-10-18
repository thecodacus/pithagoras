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
import { renaming, wasDeleted } from "./rename.js";
import { ICONS } from "./toolbar.js";
import { uploads } from "./upload.js";
import { WRITING_TOOLS, isDocumentId, sameCall, sameCalls, shownNew } from "./writing.js";

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
    "Title of a new document": "Titel eines neuen Dokuments",
    "New document": "Neues Dokument",
    "The document could not be made: {error}": "Das Dokument konnte nicht angelegt werden: {error}",
    "The documents of this chat's folder, to read, edit and comment on": "Die Dokumente im Ordner dieses Chats, zum Lesen, Bearbeiten und Kommentieren",
    "Changed {date}": "Geändert {date}",
    "This document is empty.": "Dieses Dokument ist leer.",
    Saved: "Gespeichert",
    "Saving…": "Wird gespeichert…",
    "Unsaved changes": "Nicht gespeicherte Änderungen",
    "Not saved": "Nicht gespeichert",
    History: "Verlauf",
    "You are reading revision {n}, an earlier text. It cannot be edited here; the document itself has not changed.":
      "Du liest Revision {n}, einen früheren Text. Er lässt sich hier nicht bearbeiten; das Dokument selbst ist unverändert.",
    "Back to the current text": "Zurück zum aktuellen Text",
    "Editing mode": "Bearbeitungsmodus",
    Visual: "Visuell",
    Markdown: "Markdown",
    "Markdown source": "Markdown-Quelltext",
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
    "Restore revision {n}?": "Revision {n} wiederherstellen?",
    "The current text is replaced by revision {n}. The current version stays in the history, so you can go back to it.":
      "Der aktuelle Text wird durch Revision {n} ersetzt. Die aktuelle Version bleibt im Verlauf, du kannst also zu ihr zurückkehren.",
    Restore: "Wiederherstellen",
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
    "Select less text: a comment can be on at most {n} characters.": "Wähle weniger Text aus: Ein Kommentar kann sich auf höchstens {n} Zeichen beziehen.",
    "No comments yet. Select some text, then press Comment.": "Noch keine Kommentare. Wähle Text aus und drücke Kommentieren.",
    "Comments could not be loaded: {error}": "Kommentare konnten nicht geladen werden: {error}",
    "Could not comment: {error}": "Kommentar fehlgeschlagen: {error}",
    "New comment": "Neuer Kommentar",
    "Write a comment": "Kommentar schreiben",
    "Write a comment… (@agent asks the agent)": "Kommentar schreiben… (@agent fragt den Agenten)",
    Cancel: "Abbrechen",
    Send: "Senden",
    "Ctrl+Enter": "Strg+Eingabe",
    Reply: "Antworten",
    "Reply… (@agent asks the agent)": "Antworten… (@agent fragt den Agenten)",
    "Show {n} replies": "{n} Antworten anzeigen",
    "Hide replies": "Antworten ausblenden",
    "Comments on “{passage}”: {n}": "Kommentare zu „{passage}“: {n}",
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
    Edit: "Bearbeiten",
    Delete: "Löschen",
    Save: "Speichern",
    "Edit the comment": "Kommentar bearbeiten",
    edited: "bearbeitet",
    "Edited {date}": "Bearbeitet {date}",
    "Delete this comment?": "Diesen Kommentar löschen?",
    "The comment is deleted for good.": "Der Kommentar wird endgültig gelöscht.",
    "Delete this thread?": "Diesen Kommentarthread löschen?",
    "The thread and all its comments are deleted for good.": "Der Kommentarthread und alle seine Kommentare werden endgültig gelöscht.",
    "Delete thread": "Kommentarthread löschen",
    "Changed a comment": "Kommentar geändert",
    "Deleted a comment": "Kommentar gelöscht",
    "Comments on {title}": "Kommentare zu {title}",
    "Could not open a chat to ask the agent in: {error}": "Es konnte kein Chat geöffnet werden, in dem der Agent gefragt wird: {error}",
    "The agent is writing a new document…": "Der Agent schreibt ein neues Dokument…",
    "The agent's new document was not made.": "Das neue Dokument des Agenten wurde nicht angelegt.",
    "The agent is writing in this document…": "Der Agent schreibt in diesem Dokument…",
    "The agent is writing in this document. What it writes comes in when it is done.": "Der Agent schreibt in diesem Dokument. Was er schreibt, kommt hinzu, sobald er fertig ist.",
    "Show the saved text": "Den gespeicherten Text zeigen",
    "No documents in {folder} yet. Make one here, upload a Markdown file, or ask the agent to.": "Noch keine Dokumente in {folder}. Lege hier eines an, lade eine Markdown-Datei hoch, oder bitte den Agenten darum.",
    "From the chat {chat}": "Aus dem Chat {chat}",
    "From another chat": "Aus einem anderen Chat",
    Upload: "Hochladen",
    "Uploading…": "Wird hochgeladen…",
    "Upload Markdown files (.md) — or drop them on the list": "Markdown-Dateien (.md) hochladen — oder auf der Liste ablegen",
    "Drop Markdown files here to add them as documents": "Markdown-Dateien hier ablegen, um sie als Dokumente hinzuzufügen",
    "{name} is not a Markdown file (.md).": "{name} ist keine Markdown-Datei (.md).",
    "{name} is bigger than 1 MB.": "{name} ist größer als 1 MB.",
    "{name} is not UTF-8 text, so it is not sent. Save it as UTF-8 first.": "{name} ist kein UTF-8-Text und wird deshalb nicht gesendet. Speichere die Datei zuerst als UTF-8.",
    "{name} could not be uploaded: {error}": "{name} konnte nicht hochgeladen werden: {error}",
    Download: "Herunterladen",
    "Markdown (.md)": "Markdown (.md)",
    "PDF (print)": "PDF (Drucken)",
    "Full page": "Vollbild",
    "Reload the page": "Seite neu laden",
    "Discard the comment you started?": "Den begonnenen Kommentar verwerfen?",
    "What you wrote in it is lost.": "Was du darin geschrieben hast, geht verloren.",
    Discard: "Verwerfen",
    "Open on its own page": "Auf einer eigenen Seite öffnen",
    Formatting: "Formatierung",
    Undo: "Rückgängig",
    Redo: "Wiederholen",
    "Text style": "Formatvorlage",
    "Normal text": "Standardtext",
    "Heading 1": "Überschrift 1",
    "Heading 2": "Überschrift 2",
    "Heading 3": "Überschrift 3",
    "Code block": "Codeblock",
    Bold: "Fett",
    Italic: "Kursiv",
    Strikethrough: "Durchgestrichen",
    Code: "Code",
    Link: "Link",
    "Remove link": "Link entfernen",
    "Address of the link": "Adresse des Links",
    Insert: "Einfügen",
    "Bulleted list": "Aufzählung",
    "Numbered list": "Nummerierte Liste",
    Checklist: "Checkliste",
    Quote: "Zitat",
    "Insert table": "Tabelle einfügen",
    "Horizontal line": "Horizontale Linie",
    Rename: "Umbenennen",
    "Rename {name}": "{name} umbenennen",
    "Delete {name}": "{name} löschen",
    "New file name for {name}": "Neuer Dateiname für {name}",
    "This renames the file. The title is the document's first heading: change it in the text.": "Das benennt die Datei um. Der Titel ist die erste Überschrift des Dokuments: Ändere ihn im Text.",
    "The document could not be deleted: {error}": "Das Dokument konnte nicht gelöscht werden: {error}",
    "Delete “{title}”?": "„{title}“ löschen?",
    "This deletes the file {name}, the comments on it and its history. It cannot be undone.": "Das löscht die Datei {name}, die Kommentare dazu und den Verlauf. Das lässt sich nicht rückgängig machen.",
    "Document actions": "Aktionen für das Dokument",
    "Your changes could not be saved, so the document was not renamed.": "Deine Änderungen konnten nicht gespeichert werden, deshalb wurde das Dokument nicht umbenannt.",
    "This document was renamed to {name}.": "Dieses Dokument wurde in {name} umbenannt.",
    "Renamed from {name}": "Umbenannt von {name}",
    "This document was deleted. Your text is kept here and is not saved.": "Dieses Dokument wurde gelöscht. Dein Text bleibt hier erhalten und ist nicht gespeichert.",
    "Save as a new document": "Als neues Dokument speichern",
    "The text could not be saved as a new document: {error}": "Der Text konnte nicht als neues Dokument gespeichert werden: {error}",
  });

  // What the agent is writing in a document, from the chat's calls as this page has them (writing.js): drawn in the panel as it
  // comes, drawn again only when a call changes (its arguments are read again a few times a second, not with each token).
  const useWriting = (chat) => portal.chats.use(chat, (feed) => feed.calls.filter((call) => WRITING_TOOLS.has(call.name)), sameCalls);
  const useCall = (chat, callId) => portal.chats.use(chat, (feed) => (callId ? feed.call(callId) : undefined), sameCall);

  const icon = (path) => () =>
    h("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true }, h("path", { d: path }));
  const DocumentIcon = icon("M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5ZM14 3v5h5M9 13h6M9 17h6M9 9h1");
  const UploadIcon = icon(ICONS.upload);
  const { useUpload } = uploads(portal);

  /**
   * Where Markdown files are brought into folder `folder`: the button that picks them, what is said of those that could not be
   * taken, and the mark of the list they are dropped on (the `zone` of `upload`, spread on it).
   */
  function UploadButton({ upload }) {
    return h(
      React.Fragment,
      null,
      upload.input,
      h(
        "button",
        { type: "button", className: `${ui.classes.button} pd-upload`, title: t("Upload Markdown files (.md) — or drop them on the list"), disabled: upload.busy > 0, onClick: upload.pick },
        h(UploadIcon),
        upload.busy > 0 ? t("Uploading…") : t("Upload"),
      ),
    );
  }
  const UploadProblems = ({ upload }) => upload.problems.length > 0 && h(ui.ErrorBanner, { onClose: upload.clear }, upload.problems.join(" "));
  const DropHint = ({ upload }) => upload.dropping && h("div", { className: "pd-drop-hint", "aria-hidden": true }, t("Drop Markdown files here to add them as documents"));

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

  /**
   * A list of documents (`path`, a route of the server half's), kept up to date while it is on the page: the server half's stream says the
   * list's version whenever it changes (and as its first message), and the list is asked for again when that is not the version the page
   * holds (a list without a version, one chat's, is asked for again whenever the stream says anything). So what changed while there was no
   * stream (the first request, a dropped connection) is found out at once, and a list that is current is not asked for again. What is shown
   * stays while a request for it again fails, which is made again after a while; only a page that has no list yet says why.
   */
  function useListed(path) {
    const [state, setState] = useState({ body: null, error: null });
    const [asked, setAsked] = useState(0);
    // Asks for the list again where it is, with what is shown staying until the answer comes: after the person changed something in it.
    const reloading = React.useRef(() => {});
    useEffect(() => {
      let gone = false;
      let stream = null;
      let reconnect = null;
      let failed = 0;
      // The version of the list the page holds, the newest one the stream said, and whether the list is being asked for.
      let held = null;
      let told = null;
      let loading = false;
      // A request that failed is made again after a wait, longer each time: the stream says nothing more until the list changes again.
      let wait = null;
      let failures = 0;
      const load = async () => {
        if (loading) return;
        clearTimeout(wait);
        loading = true;
        const before = told;
        try {
          const body = await portal.api.json(portal.api.url(path));
          if (gone) return;
          failures = 0;
          held = body.version ?? null;
          // The same list as before is left as it is, so that it is not drawn again.
          setState((now) => (now.body && JSON.stringify(now.body) === JSON.stringify(body) ? now : { body, error: null }));
        } catch (error) {
          if (gone) return;
          setState((now) => (now.body ? now : { body: null, error }));
          // The list that is shown is not the one the stream said, and the stream says nothing again until the list changes once more.
          if (told !== null && told !== held) wait = setTimeout(() => void load(), Math.min(2000 * 2 ** failures++, 30_000));
          return;
        } finally {
          loading = false;
        }
        // The stream said something newer while it was asked for.
        if (!gone && told !== before && told !== held) void load();
      };
      setState({ body: null, error: null });
      void load();
      reloading.current = () => void load();
      const listen = () => {
        const source = new EventSource(portal.api.url("/folders/events"));
        stream = source;
        source.addEventListener("documents", (e) => {
          failed = 0;
          try {
            told = JSON.parse(e.data).version;
          } catch {
            // A message that is not one of ours: nothing to take from it.
            return;
          }
          if (told !== held) void load();
        });
        // One that dropped is asked for again after a while, longer each time, as the document's own stream is: the first message of a new
        // one says where the list stands, so nothing that happened meanwhile is missed.
        source.addEventListener("error", () => {
          source.close();
          if (!gone) reconnect = setTimeout(listen, Math.min(2000 * 2 ** failed++, 30_000));
        });
      };
      if (typeof EventSource !== "undefined") listen();
      return () => {
        gone = true;
        clearTimeout(reconnect);
        clearTimeout(wait);
        stream?.close();
      };
    }, [path, asked]);
    return { ...state, retry: () => setAsked((n) => n + 1), reload: () => reloading.current() };
  }

  const Svg = ({ name }) => h("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true }, h("path", { d: ICONS[name] }));
  const { RenameForm } = renaming(portal);

  /** A document in a list: its title, and its file, when it changed and what its comments wait for. */
  const DocumentButton = ({ doc, onOpen }) =>
    h(
      "button",
      { type: "button", className: "pd-open", onClick: onOpen },
      h("span", { className: "pd-title" }, doc.title),
      h("span", { className: "pd-meta" }, [doc.name, doc.otherChat && (doc.chatTitle ? t("From the chat {chat}", { chat: doc.chatTitle }) : t("From another chat")), t("Changed {date}", { date: when(doc.modified) }), doc.openThreads > 0 && (doc.openThreads === 1 ? t("1 open comment") : t("{n} open comments", { n: doc.openThreads })), doc.answeredThreads > 0 && t("{n} answered by the agent", { n: doc.answeredThreads })].filter(Boolean).join(" · ")),
    );

  /**
   * A document in a list, with what can be done with it: renamed (a form takes the row's place) and deleted (after the portal's question,
   * which Settings → This browser can switch off). The two buttons are out of the way until the row is pointed at or has the focus, and are
   * always there where there is nothing to point with. `folder` is the folder's id, `changed()` asks for the list again, and `gone()` says
   * that this row was deleted (the list puts the focus where it was).
   */
  function DocumentRow({ folder, doc, onOpen, changed, gone }) {
    const [renaming, setRenaming] = useState(false);
    const [busy, setBusy] = useState(false);
    const [problem, setProblem] = useState(null);
    const renameButton = React.useRef(null);
    // Where the form was closed, the focus goes back to the button that opened it.
    const refocus = React.useRef(false);
    useEffect(() => {
      if (renaming || !refocus.current) return;
      refocus.current = false;
      renameButton.current?.focus();
    }, [renaming]);
    const url = documentUrl(folder, doc.id);
    const close = () => {
      refocus.current = true;
      setRenaming(false);
    };
    const rename = async (name) => {
      setProblem(null);
      await portal.api.json(`${url}/rename`, { method: "POST", body: JSON.stringify({ name }) });
      close();
      changed();
    };
    const remove = async () => {
      if (busy) return;
      const ok = await ui.confirm({
        title: t("Delete “{title}”?", { title: doc.title }),
        message: t("This deletes the file {name}, the comments on it and its history. It cannot be undone.", { name: doc.name }),
        confirmLabel: t("Delete"),
        danger: true,
        deletes: true,
      });
      if (!ok) return;
      setBusy(true);
      setProblem(null);
      try {
        await portal.api.json(url, { method: "DELETE" });
        gone();
        changed();
      } catch (e) {
        // Deleted already (another window): it is gone from the list too.
        if (wasDeleted(e)) changed();
        else setProblem(e.message);
      } finally {
        setBusy(false);
      }
    };
    return h(
      "li",
      { className: "pd-row" },
      renaming
        ? h(RenameForm, { name: doc.name, compact: true, onSubmit: rename, onCancel: close })
        : h(
            React.Fragment,
            null,
            h(DocumentButton, { doc, onOpen }),
            h(
              "div",
              { className: "pd-row-actions" },
              h("button", { type: "button", ref: renameButton, className: "pd-row-action", title: t("Rename {name}", { name: doc.name }), "aria-label": t("Rename {name}", { name: doc.name }), onClick: () => setRenaming(true) }, h(Svg, { name: "pencil" })),
              // Off by aria-disabled, not disabled: while the question is open the focus goes back to this button, and a disabled one keeps none.
              h("button", { type: "button", className: "pd-row-action pd-row-danger", "aria-disabled": busy, "aria-busy": busy, title: t("Delete {name}", { name: doc.name }), "aria-label": t("Delete {name}", { name: doc.name }), onClick: () => void remove() }, h(Svg, { name: "trash" })),
            ),
          ),
      problem && h(ui.ErrorBanner, { onClose: () => setProblem(null) }, t("The document could not be deleted: {error}", { error: problem })),
    );
  }

  /** The list's `ul`, and where the focus goes when one of its documents is deleted: to the one that took its place, or the last. */
  function useKeepFocus(count) {
    const list = React.useRef(null);
    const at = React.useRef(null);
    useEffect(() => {
      if (at.current === null) return;
      const rows = list.current?.querySelectorAll(".pd-open");
      const next = rows?.[Math.min(at.current, rows.length - 1)];
      at.current = null;
      next?.focus();
    }, [count]);
    return { list, gone: (index) => () => void (at.current = index) };
  }

  function FolderList({ onOpen }) {
    const { body, error, retry, reload } = useListed("/folders");
    if (error) return h(ui.LoadFailed, { error, onRetry: retry });
    if (!body) return h(ui.RowsSkeleton, { rows: 3, label: t("Loading…") });
    // A folder whose documents could not be opened is said, with the reason: left out without a word it reads as one with none.
    const problems = (body.problems ?? []).map((problem) => h(ui.ErrorBanner, { key: `problem-${problem.id}` }, t("The documents in {folder} could not be opened: {error}", { folder: problem.path, error: problem.error })));
    if (!body.folders.length) return problems.length ? problems : h(ui.Empty, null, t("No folder has documents yet. A document is a Markdown file in a folder called documents, in the folder a chat works in."));
    return [...problems, ...body.folders.map((folder) => h(FolderSection, { key: folder.id, folder, onOpen, reload }))];
  }

  /**
   * One folder's documents on the page, with Markdown files to be uploaded into it (the button, or dropped on it). One file
   * uploaded on its own is opened; with others, or with what could not be taken, the list stays to say so.
   */
  function FolderSection({ folder, onOpen, reload }) {
    const upload = useUpload(folder.id, (made, problems) => made.length === 1 && !problems.length && onOpen({ folder: folder.id, id: made[0].id }));
    const keep = useKeepFocus(folder.documents.length);
    return h(
      "section",
      { className: "pd-folder pd-dropzone", "aria-labelledby": `pd-folder-${folder.id}`, ...upload.zone },
      h("div", { className: "pd-folder-head" }, h("div", null, h("h2", { id: `pd-folder-${folder.id}` }, folder.name), h("p", { className: "pd-path" }, folder.path)), h(UploadButton, { upload })),
      h(UploadProblems, { upload }),
      h(
        "ul",
        { className: "pd-list", ref: keep.list },
        folder.documents.map((doc, index) => h(DocumentRow, { key: doc.id, folder: folder.id, doc, onOpen: () => onOpen({ folder: folder.id, id: doc.id }), changed: reload, gone: keep.gone(index) })),
      ),
      h(DropHint, { upload }),
    );
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

  // The document editor's half (document-editor.js, with what it brings: the comments, the saver, the editor itself) is loaded when a
  // document is first opened, so that this module, which registers the page's entry in the sidebar, does not wait for it.
  let editorHalf = null;
  const loadEditorHalf = () =>
    (editorHalf ??= import("./document-editor.js").then((module) => module.documentEditor(portal, { documentUrl, when, useAnswer, activeChat, remember })));

  /** A document of a folder, for reading and writing: the editor's half is loaded first, with the page's loading state in its place. */
  function DocumentEditor(props) {
    const [Editor, setEditor] = useState(null);
    const [failed, setFailed] = useState(null);
    useEffect(() => {
      let here = true;
      loadEditorHalf().then(
        // A component is held in the state by a function that returns it.
        (component) => here && setEditor(() => component),
        (e) => here && setFailed(e),
      );
      return () => void (here = false);
    }, []);
    if (Editor) return h(Editor, props);
    const back = h("button", { type: "button", className: "pd-back", onClick: props.onBack }, `← ${t("All documents")}`);
    return h(
      "article",
      { className: "pd-document" },
      back,
      // A module that failed to load fails again when it is asked for again (the browser keeps the failure): only a new page can load it.
      failed
        ? h(ui.ErrorBanner, null, h("span", null, t("The editor could not be loaded: {error}", { error: failed.message })), " ", h("button", { type: "button", className: ui.classes.ghost, onClick: () => window.location.reload() }, t("Reload the page")))
        : h(ui.RowsSkeleton, { rows: 4, label: t("Loading…") }),
    );
  }

  /**
   * A call of one of the agent's tools that names a document, in place of the
   * portal's card: what was done to it, where it stands, and a way to read it
   * on the page. The portal's own card says it best while the call runs, when
   * it failed, and for a list.
   */
  function DocumentCall({ call, card, panels }) {
    portal.locale.use();
    const d = call.details;
    if (call.status !== "done" || typeof d?.id !== "string" || typeof d.folder !== "string") return card;
    const heading = { create: t("Created a document"), edit: t("Edited a document"), read: t("Read a document"), comment: t("Commented on a document"), reply: t("Replied to a comment"), resolve: t("Resolved a comment"), edit_comment: t("Changed a comment"), delete_comment: t("Deleted a comment") }[d.action];
    if (!heading) return card;
    const facts = [`documents/${d.name}`];
    if (d.action === "edit") {
      facts.push(d.changed ? t("Revision {from} to {to}", { from: d.from, to: d.revision }) : t("No change"), d.edits === 1 ? t("1 edit") : t("{n} edits", { n: d.edits }));
      if (d.thread) facts.push(t("answers a comment"));
    } else if (["comment", "reply", "resolve", "edit_comment", "delete_comment"].includes(d.action)) {
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
      // Beside the chat, in its panel: the chat stays on screen.
      h("button", { type: "button", onClick: () => panels.open("documents", { folder: d.folder, doc: d.id }) }, t("Open in Documents")),
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
    // A document open is the whole page, as a word processor's is: its sheet on the desk, and nothing of the list above it.
    if (open) return h("div", { className: "pd-page pd-full" }, h(DocumentEditor, { ...open, key: `${open.folder}/${open.id}`, onBack: () => setOpen(null), onOpen: setOpen }));
    return h(
      "div",
      { className: "pd-page" },
      h(ui.PageHeader, { icon: h(DocumentIcon), title: t("Documents"), description: t("The Markdown files in the documents folder of each folder your chats work in.") }),
      h(FolderList, { onOpen: setOpen }),
    );
  }

  /**
   * The documents of one chat, beside it: the project's and the chat's own, as its agent sees them. Made here with a title (the
   * project's, as the agent's are unless it says otherwise), and opened in the same editor as on the page, with the comments and the
   * history. What is beside it is kept current as the page's list is.
   */
  function ChatDocuments({ chat, onOpen }) {
    const { body, error, retry, reload } = useListed(`/chats/${encodeURIComponent(chat.id)}/documents`);
    const [title, setTitle] = useState("");
    const [making, setMaking] = useState(false);
    const [problem, setProblem] = useState(null);
    const upload = useUpload(body?.folder.id, (made, problems) => made.length === 1 && !problems.length && onOpen({ folder: body.folder.id, id: made[0].id }));
    const keep = useKeepFocus(body?.documents.length ?? 0);
    if (error) return h(ui.LoadFailed, { error, onRetry: retry });
    if (!body) return h(ui.RowsSkeleton, { rows: 3, label: t("Loading…") });
    const create = async () => {
      setMaking(true);
      setProblem(null);
      try {
        const made = await portal.api.json(portal.api.url(`/folders/${body.folder.id}/documents`), { method: "POST", body: JSON.stringify({ title: title.trim() }) });
        setTitle("");
        onOpen({ folder: body.folder.id, id: made.id });
      } catch (e) {
        setProblem(e.message);
      } finally {
        setMaking(false);
      }
    };
    return h(
      "div",
      { className: "pd-dropzone pd-chat-documents", ...upload.zone },
      h(
        "form",
        { className: "pd-new", onSubmit: (e) => (e.preventDefault(), void create()) },
        h("input", { className: ui.classes.input, value: title, maxLength: 200, placeholder: t("Title of a new document"), "aria-label": t("Title of a new document"), onChange: (e) => setTitle(e.target.value) }),
        h("button", { type: "submit", className: ui.classes.primarySmall, disabled: making || !title.trim() }, t("New document")),
        h(UploadButton, { upload }),
      ),
      problem && h(ui.ErrorBanner, { onClose: () => setProblem(null) }, t("The document could not be made: {error}", { error: problem })),
      h(UploadProblems, { upload }),
      body.documents.length
        ? h("ul", { className: "pd-list", ref: keep.list }, body.documents.map((doc, index) => h(DocumentRow, { key: doc.id, folder: body.folder.id, doc, onOpen: () => onOpen({ folder: body.folder.id, id: doc.id }), changed: reload, gone: keep.gone(index) })))
        : h(ui.Empty, null, t("No documents in {folder} yet. Make one here, upload a Markdown file, or ask the agent to.", { folder: body.folder.name })),
      h(DropHint, { upload }),
    );
  }

  /** Follows the end of a text that grows, in the panel that scrolls around `inside`, for as long as the person has not scrolled up from it. */
  function useFollowEnd(inside, text) {
    const atEnd = React.useRef(true);
    useEffect(() => {
      const scroller = inside.current?.closest(".pd-panel");
      if (!scroller) return;
      const look = () => void (atEnd.current = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 48);
      scroller.addEventListener("scroll", look, { passive: true });
      return () => scroller.removeEventListener("scroll", look);
    }, []);
    React.useLayoutEffect(() => {
      const scroller = inside.current?.closest(".pd-panel");
      if (scroller && atEnd.current) scroller.scrollTop = scroller.scrollHeight;
    }, [text]);
  }

  /** A new document the agent is writing, as far as it has come, drawn as the portal draws Markdown until it is made and opens in the editor. */
  function Drafting({ call, onBack }) {
    portal.locale.use();
    const box = React.useRef(null);
    const shown = shownNew(call.input.title, call.input.markdown);
    useFollowEnd(box, shown);
    const failed = call.status === "error";
    return h(
      "article",
      { className: "pd-document", ref: box },
      h("button", { type: "button", className: "pd-back", onClick: onBack }, `← ${t("All documents")}`),
      h("div", { className: `pd-note pd-writing${failed ? " is-failed" : ""}`, role: "status" }, h("span", null, failed ? t("The agent's new document was not made.") : t("The agent is writing a new document…"))),
      shown.trim() && h("div", { className: "pd-editor pd-draft" }, h(ui.Markdown, null, shown)),
    );
  }

  /** What a panel is asked to show: a document; the same, with what the agent is writing in it (`writing`, its call); or a new one the agent is writing. */
  const openOf = (asked) => (asked?.doc ? { folder: asked.folder, id: asked.doc, ...(asked.writing ? { writing: asked.writing } : {}) } : asked?.writing ? { writing: asked.writing } : null);

  /** The id of the chat's folder, asked for when `needed`: a document the agent edits is named by its own id alone. */
  function useChatFolder(chat, needed) {
    const [folder, setFolder] = useState({ id: null, failed: false });
    useEffect(() => {
      if (!needed || folder.id) return;
      let here = true;
      portal.api.json(portal.api.url(`/chats/${encodeURIComponent(chat)}/documents`)).then(
        (body) => here && setFolder({ id: body.folder.id, failed: false }),
        () => here && setFolder({ id: null, failed: true }),
      );
      return () => void (here = false);
    }, [chat, needed, folder.id]);
    return folder;
  }

  function DocumentsPanel({ chat, panel }) {
    portal.locale.use();
    // A tool card asked for one (`open("documents", { folder, doc })`), or the agent began to write one (`writing`): each ask anew, also for the same document.
    const asked = panel.params;
    const [open, setOpen] = useState(() => openOf(asked));
    useEffect(() => {
      const next = openOf(asked);
      if (next) setOpen(next);
    }, [asked]);
    // Between the end of the message that wrote it and its start, a call is for a moment neither being written nor running: what it was stands.
    const now = useCall(chat.id, open?.writing);
    const last = React.useRef(undefined);
    if (now) last.current = now;
    const call = now ?? (last.current?.callId === open?.writing ? last.current : undefined);
    // A new document the agent was writing opens in the editor once it is made.
    useEffect(() => {
      if (open && !open.id && call?.status === "done" && typeof call.details?.id === "string") setOpen({ folder: call.details.folder, id: call.details.id });
    }, [open, call]);
    const chatFolder = useChatFolder(chat.id, Boolean(open?.id && !open.folder));
    const folder = open?.folder ?? chatFolder.id;
    const back = () => setOpen(null);
    // An edit of this document that the model is writing, or that is running: drawn until it has ended, when the document's stream has what it saved.
    const draft = open?.id && call?.name === "doc_edit" && (call.status === "writing" || call.status === "running") && call.input.id === open.id ? { call: call.callId, edits: call.input.edits } : null;
    return h(
      "div",
      { className: "pd-page pd-panel" },
      open?.id && folder
        ? h(DocumentEditor, { folder, id: open.id, key: `${folder}/${open.id}`, draft, onBack: back, onOpen: (next) => setOpen(next), onExpand: () => portal.navigate(`/x/${portal.extension}/documents?${new URLSearchParams({ folder, doc: open.id })}`) })
        : open?.id && !chatFolder.failed
          ? h(ui.RowsSkeleton, { rows: 4, label: t("Loading…") })
          : call && open?.writing && !open.id
            ? h(Drafting, { call, onBack: back })
            : h(ChatDocuments, { chat, onOpen: setOpen }),
    );
  }

  /** Opens the panel when the agent begins to write in a document in this chat: on the new one it is writing, or on the one it edits once its id has come. Once for each call. */
  function Follow({ chat, panels }) {
    const calls = useWriting(chat.id);
    const opened = React.useRef(new Set());
    useEffect(() => {
      for (const call of calls) {
        if (opened.current.has(call.callId)) continue;
        if (call.name === "doc_create") {
          opened.current.add(call.callId);
          panels.open("documents", { writing: call.callId });
        } else if (isDocumentId(call.input.id)) {
          opened.current.add(call.callId);
          panels.open("documents", { doc: call.input.id, writing: call.callId });
        }
      }
    }, [calls]);
    return null;
  }

  portal.slots.register("nav.page", { id: "documents", title: "Documents", icon: DocumentIcon, component: DocumentsPage });
  portal.slots.register("chat.background", { id: "follow", component: Follow });
  portal.slots.register("chat.panel", {
    id: "documents",
    name: "documents",
    title: "Documents",
    icon: DocumentIcon,
    component: DocumentsPanel,
    useButton: () => {
      portal.locale.use();
      return { title: t("The documents of this chat's folder, to read, edit and comment on") };
    },
  });
  for (const tool of ["doc_create", "doc_read", "doc_edit", "doc_comment", "doc_reply", "doc_edit_comment", "doc_delete_comment", "doc_resolve"]) portal.slots.register("chat.tool", { id: tool, tool, component: DocumentCall });
}
