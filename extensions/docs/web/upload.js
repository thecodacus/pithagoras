/**
 * Markdown files the person brings in: picked with a button or dropped on a
 * list of documents, each sent to the server half, which keeps it in the
 * folder's documents folder as it is (POST …/documents/upload). What is not a
 * Markdown file, or is too big to be a document, is said and not sent.
 */

/** A document is read whole, so a file bigger than this is not one (files.js on the server says the same). */
const MAX_BYTES = 1024 * 1024;
/** What the file picker offers. */
export const ACCEPT = ".md,.markdown,text/markdown";

export const isMarkdownName = (name) => /\.(md|markdown)$/i.test(name);

/** Whether a drag carries files: text or a link dragged over the list is not an upload. */
const carriesFiles = (event) => Array.from(event.dataTransfer?.types ?? []).includes("Files");

export function uploads(portal) {
  const { React, t } = portal;
  const { useRef, useState } = React;
  const h = React.createElement;

  /**
   * Uploading into one folder (`folder`, its id): `pick` opens the file picker, `zone` is spread on the element files are dropped
   * on (it is `data-dropping` while they are over it), `input` is drawn somewhere in it. `onMade` is told the documents that
   * were made, and what could not be taken. `busy` while files are on their way, `problems` what could not be taken.
   */
  function useUpload(folder, onMade) {
    const [busy, setBusy] = useState(0);
    const [problems, setProblems] = useState([]);
    const [dropping, setDropping] = useState(false);
    const picker = useRef(null);
    // Entering a child of the zone is a leave of the zone itself: counted, so that the mark does not flicker.
    const depth = useRef(0);

    const send = async (files) => {
      if (!folder || !files.length) return;
      const said = [];
      const made = [];
      setBusy((n) => n + files.length);
      for (const file of files) {
        try {
          if (!isMarkdownName(file.name)) {
            said.push(t("{name} is not a Markdown file (.md).", { name: file.name }));
            continue;
          }
          if (file.size > MAX_BYTES) {
            said.push(t("{name} is bigger than 1 MB.", { name: file.name }));
            continue;
          }
          // Read as UTF-8 exactly, with a byte order mark kept: a file in another encoding is said, not stored with its umlauts turned into �.
          let markdown;
          try {
            markdown = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await file.arrayBuffer());
          } catch {
            said.push(t("{name} is not UTF-8 text, so it is not sent. Save it as UTF-8 first.", { name: file.name }));
            continue;
          }
          made.push(await portal.api.json(portal.api.url(`/folders/${encodeURIComponent(folder)}/documents/upload`), { method: "POST", body: JSON.stringify({ name: file.name, markdown }) }));
        } catch (e) {
          said.push(t("{name} could not be uploaded: {error}", { name: file.name, error: e.message }));
        } finally {
          setBusy((n) => n - 1);
        }
      }
      setProblems(said);
      if (made.length) onMade?.(made, said);
    };

    const zone = {
      "data-dropping": dropping ? "true" : undefined,
      onDragEnter: (e) => {
        if (!carriesFiles(e)) return;
        e.preventDefault();
        depth.current++;
        setDropping(true);
      },
      onDragOver: (e) => {
        if (!carriesFiles(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
      },
      onDragLeave: (e) => {
        if (!carriesFiles(e)) return;
        if (--depth.current <= 0) {
          depth.current = 0;
          setDropping(false);
        }
      },
      onDrop: (e) => {
        if (!carriesFiles(e)) return;
        e.preventDefault();
        depth.current = 0;
        setDropping(false);
        void send(Array.from(e.dataTransfer.files));
      },
    };
    const input = h("input", {
      ref: picker,
      type: "file",
      accept: ACCEPT,
      multiple: true,
      hidden: true,
      "aria-hidden": true,
      tabIndex: -1,
      onChange: (e) => {
        const files = Array.from(e.target.files ?? []);
        // The same file again is a change next time too.
        e.target.value = "";
        void send(files);
      },
    });
    return { busy, problems, clear: () => setProblems([]), pick: () => picker.current?.click(), zone, input, dropping };
  }

  return { useUpload };
}
