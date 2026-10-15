import { useEffect, useRef, useState } from "react";
import { LuCheck, LuCopy, LuDownload, LuEye, LuFileText, LuPencil, LuPlus, LuSave, LuTrash2, LuUndo2 } from "react-icons/lu";
import { hear, known, useAsked, useCanvases, type Canvas } from "./feed";
import { canvasPictures, pictureUrl } from "./pictures";
import { Markdown, portal, Select, t } from "./portal";

/**
 * A chat's canvases: the one picked, as the agent writes it or as the person
 * edits it, with the others a pick away. The same beside the conversation and
 * in voice mode. A document the agent makes, reads or begins writing is
 * brought up, unless the person is editing.
 */
export function Canvases({ chat, folder }: { chat: string; folder: string }) {
  portal.locale.use();
  const rows = useCanvases(chat);
  const asked = useAsked(chat);
  const [selected, setSelected] = useState("");
  const [editing, setEditing] = useState(false), [draft, setDraft] = useState(""), [title, setTitle] = useState(""), [base, setBase] = useState(0);
  const [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  /** The draft of a document that was deleted while it was being edited, kept to be copied. */
  const [lost, setLost] = useState<string | null>(null), [copied, setCopied] = useState(false);
  const viewport = useRef<HTMLDivElement>(null), follow = useRef(true);
  const canvas = rows.find((row) => row.id === selected);
  const route = (rest = "") => portal.api.url(`/chats/${encodeURIComponent(chat)}/canvases${rest}`);
  const request = <T,>(rest: string, method: string, body?: unknown) => portal.api.json<T>(route(rest), { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

  // Told when the page opened the chat; asked for here only when that has not come.
  useEffect(() => {
    if (known(chat)) return;
    let gone = false;
    request<Canvas[]>("", "GET").then(
      (canvases) => !gone && !known(chat) && hear(chat, { type: "snapshot", canvases }),
      (e) => !gone && setError((e as Error).message),
    );
    return () => {
      gone = true;
    };
  }, [chat]);
  // The agent's document, brought up.
  useEffect(() => {
    if (asked.count && !editing) {
      setSelected(asked.id);
      follow.current = true;
    }
  }, [asked.count]);
  // The document being edited was deleted, by the agent or from another tab: the editor has nothing left to save to.
  // What was typed is kept.
  useEffect(() => {
    if (!editing || canvas) return;
    setEditing(false);
    setCopied(false);
    setLost(draft.trim() ? draft : null);
    setError(t("This document was deleted while you were editing it."));
  }, [editing, canvas]);
  useEffect(() => {
    if (!editing && !rows.some((row) => row.id === selected)) setSelected(rows[0]?.id ?? "");
  }, [rows, selected, editing]);
  useEffect(() => {
    if (canvas?.active_call && follow.current && viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight;
  }, [canvas?.content, canvas?.active_call]);

  const act = async (run: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await run();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const took = (row: Canvas) => hear(chat, { type: "update", canvas: row });
  const beginEdit = () => {
    if (!canvas) return;
    setDraft(canvas.content);
    setTitle(canvas.title);
    setBase(canvas.revision);
    setEditing(true);
    setError("");
  };
  const save = () =>
    act(async () => {
      took(await request<Canvas>(`/${canvas!.id}`, "PUT", { revision: base, title, content: draft }));
      setEditing(false);
    });
  const create = () =>
    act(async () => {
      const row = await request<Canvas>("", "POST", { title: t("Untitled document") });
      hear(chat, { type: "create", canvas: row });
      setSelected(row.id);
      setDraft("");
      setTitle(row.title);
      setBase(row.revision);
      setEditing(true);
    });
  const remove = () =>
    act(async () => {
      await request(`/${canvas!.id}`, "DELETE", { revision: canvas!.revision });
      hear(chat, { type: "delete", id: canvas!.id });
      setSelected("");
      setConfirmDelete(false);
    });
  const store = () => act(async () => took(await request<Canvas>(`/${canvas!.id}/persist`, "POST")));
  const restore = () => act(async () => took(await request<Canvas>(`/${canvas!.id}/restore`, "POST", { revision: canvas!.revision })));
  const download = () => {
    if (!canvas) return;
    const url = URL.createObjectURL(new Blob([editing ? draft : canvas.content], { type: "text/markdown;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = ((editing ? title : canvas.title).replace(/[\\/:*?"<>|]/g, "_") || "canvas") + ".md";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const state = (row: Canvas) =>
    row.active_call ? t("Writing live") : row.status === "edited" ? t("Edited by you") : row.status === "interrupted" ? t("Partial draft retained") : row.persisted ? t("Auto-saved") : t("Temporary");

  return (
    <section className="canvas-panel" aria-label={t("Session canvas workspace")}>
      <div className="canvas-picker">
        <Select
          aria-label={t("Select canvas")}
          className="canvas-select"
          size="sm"
          value={selected}
          disabled={editing}
          placeholder={t("Choose a document")}
          onChange={(v) => {
            setSelected(v);
            setConfirmDelete(false);
            setError("");
            follow.current = true;
          }}
          options={rows.map((row) => ({ value: row.id, label: row.title, text: row.title, hint: row.persisted ? undefined : t("Temporary — not stored") }))}
        />
        <button type="button" disabled={editing || busy} aria-label={t("New canvas")} title={t("New canvas")} onClick={() => void create()}>
          <LuPlus />
        </button>
        <button type="button" aria-label={canvas?.persisted ? t("Canvas stored") : t("Store canvas")} title={canvas?.persisted ? t("Stored — edits auto-save") : t("Store canvas permanently")} disabled={!canvas || canvas.persisted || busy || editing} onClick={() => void store()}>
          {canvas?.persisted ? <LuCheck /> : <LuSave />}
        </button>
        <button type="button" aria-label={t("Download canvas")} title={t("Download Markdown")} disabled={!canvas} onClick={download}>
          <LuDownload />
        </button>
      </div>
      {error && <p role="alert" className="canvas-error">{error}</p>}
      {lost !== null && (
        <>
          <textarea className="canvas-editor" readOnly aria-label={t("Your draft")} value={lost} />
          <footer>
            <button type="button" onClick={() => void portal.ui.copyText(lost).then((ok) => ok && setCopied(true))}>
              {copied ? <LuCheck /> : <LuCopy />}
              {copied ? t("Copied") : t("Copy draft")}
            </button>
            <button type="button" onClick={() => setLost(null)}>{t("Dismiss")}</button>
          </footer>
        </>
      )}
      {canvas ? (
        <>
          <div className="canvas-document-heading">
            {editing ? <input aria-label={t("Canvas title")} maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} /> : <h3>{canvas.title}</h3>}
            <span>
              {state(canvas)} · {canvas.persisted ? t("Stored") : t("Not stored — lost on server restart")} · r{canvas.revision}
            </span>
          </div>
          {editing && canvas.revision !== base && <p className="canvas-error">{t("This document changed. Your draft is preserved here; copy it before cancelling to read the latest version.")}</p>}
          {editing ? (
            <textarea className="canvas-editor" aria-label={t("Edit canvas content")} value={draft} onChange={(e) => setDraft(e.target.value)} spellCheck />
          ) : (
            <div
              ref={viewport}
              className="canvas-document"
              onScroll={(e) => {
                const el = e.currentTarget;
                follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
              }}
            >
              {canvas.content ? <Markdown>{canvasPictures(canvas.content, folder, (path) => pictureUrl(chat, path))}</Markdown> : <p className="canvas-empty">{t("A blank page. Ask the agent to write here, or start editing.")}</p>}
            </div>
          )}
          <footer>
            {editing ? (
              <>
                <button type="button" disabled={busy || !title.trim() || canvas.revision !== base || !!canvas.active_call} onClick={() => void save()}>
                  <LuCheck />
                  {canvas.persisted ? t("Save changes") : t("Apply changes")}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setEditing(false);
                    setError("");
                  }}
                >
                  <LuEye />
                  {t("Cancel edit")}
                </button>
              </>
            ) : (
              <>
                <button type="button" disabled={!!canvas.active_call || busy} onClick={beginEdit}>
                  <LuPencil />
                  {t("Edit inline")}
                </button>
                <button type="button" disabled={!!canvas.active_call || busy} aria-label={t("Delete canvas")} onClick={() => (portal.ui.asksBeforeDeleting() ? setConfirmDelete(true) : void remove())}>
                  <LuTrash2 />
                </button>
                {canvas.restorable && !canvas.active_call && (
                  <button type="button" disabled={busy} onClick={() => void restore()}>
                    <LuUndo2 />
                    {t("Restore the version before the interrupted write")}
                  </button>
                )}
              </>
            )}
            {confirmDelete && !editing && (
              <span className="canvas-delete-confirm">
                {t("Delete this document?")}{" "}
                <button type="button" disabled={busy} onClick={() => void remove()}>
                  {t("Delete")}
                </button>
                <button type="button" onClick={() => setConfirmDelete(false)}>{t("Keep")}</button>
              </span>
            )}
          </footer>
        </>
      ) : (
        <div className="canvas-empty">
          <LuFileText />
          <h3>{t("A place for your documents")}</h3>
          <p>{t("Ask the agent to create a canvas, or start a document here.")}</p>
          <button type="button" disabled={busy} onClick={() => void create()}>
            {t("Create canvas")}
          </button>
        </div>
      )}
    </section>
  );
}
