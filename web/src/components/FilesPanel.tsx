import { useEffect, useRef, useState } from "react";
import {
  LuChevronRight,
  LuCircleAlert,
  LuDownload,
  LuFileText,
  LuFolder,
  LuRefreshCw,
  LuSave,
  LuTrash2,
  LuX,
} from "react-icons/lu";
import { api, type FileEntry } from "../api";

const btnCls =
  "inline-flex items-center gap-1.5 rounded-lg bg-fg/5 px-3 py-2 text-sm text-fg transition hover:bg-fg/10 disabled:opacity-40";
const primaryCls =
  "inline-flex items-center gap-1.5 rounded-lg bg-accent/12 px-3 py-2 text-sm text-accent ring-1 ring-inset ring-accent/25 transition hover:bg-accent/20 disabled:opacity-40";

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * The workspace files a session already reads and writes to, as a side panel on
 * the session page — the same folder pi works in, reachable without shelling
 * into the host.
 */
export function FilesPanel({ workspace }: { workspace: string }) {
  const [dirPath, setDirPath] = useState("");
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [openFile, setOpenFile] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [binary, setBinary] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);

  const base = workspace.split("/").pop() || "workspace";

  const refreshList = () => {
    if (!workspace) return;
    setLoading(true);
    setError(null);
    return api
      .listFiles(workspace, dirPath)
      .then((r) => setEntries(r.entries))
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    refreshList();
  }, [workspace, dirPath]);

  const fileRequestId = useRef(0);

  const openEntry = (name: string) => {
    if (dirty && !confirm("Discard unsaved changes?")) return;
    const rel = dirPath ? `${dirPath}/${name}` : name;
    const requestId = ++fileRequestId.current;
    setOpenFile(rel);
    setFileError(null);
    setDirty(false);
    setBinary(false);
    setContent("");
    api
      .readFile(workspace, rel)
      .then((r) => {
        if (requestId !== fileRequestId.current) return;
        setBinary(r.binary);
        setContent(r.content ?? "");
      })
      .catch((e) => {
        if (requestId === fileRequestId.current) {
          setFileError((e as Error).message);
        }
      });
  };

  const closeFile = () => {
    if (dirty && !confirm("Discard unsaved changes?")) return;
    setOpenFile(null);
    setFileError(null);
  };

  const save = async () => {
    if (!openFile) return;
    setSaving(true);
    setFileError(null);
    try {
      await api.saveFile(workspace, openFile, content);
      setDirty(false);
    } catch (e) {
      setFileError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const deleteEntry = async (e: FileEntry) => {
    const rel = dirPath ? `${dirPath}/${e.name}` : e.name;
    const kind = e.type === "dir" ? "folder (and everything in it)" : "file";
    if (!confirm(`Delete the ${kind} "${e.name}"? This cannot be undone.`)) return;
    try {
      await api.deleteFile(workspace, rel);
      if (openFile === rel || (e.type === "dir" && openFile?.startsWith(`${rel}/`))) {
        setOpenFile(null);
      }
      await refreshList();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const crumbs = dirPath ? dirPath.split("/") : [];
  const openFileName = openFile?.split("/").pop() ?? "";

  return (
    <div
      className={`flex h-full shrink-0 border-l border-line ${
        openFile ? "w-[44rem]" : "w-80"
      }`}
    >
      <div
        className={`flex h-full flex-col ${
          openFile ? "w-72 shrink-0 border-r border-line" : "w-full"
        }`}
      >
      <div className="shrink-0 border-b border-line px-3 py-2.5">
        <div className="flex items-center gap-2">
          <span className="min-w-0 truncate text-xs text-fg-subtle">{workspace}</span>
          {workspace && (
            <a
              className={btnCls}
              href={api.archiveDownloadUrl(workspace)}
              title="Download the whole workspace as a .tar.gz"
            >
              <LuDownload className="h-3.5 w-3.5" />
              <span>Project</span>
            </a>
          )}
        </div>
      </div>

      <div className="shrink-0 border-b border-line px-3 py-2 text-xs text-fg-subtle">
        <button className="hover:text-fg" onClick={() => setDirPath("")}>
          {workspace || "workspace"}
        </button>
        {crumbs.map((c, i) => (
          <span key={i} className="flex items-center gap-1">
            <LuChevronRight className="h-3 w-3 shrink-0 text-fg-faint" />
            <button
              className="hover:text-fg"
              onClick={() => setDirPath(crumbs.slice(0, i + 1).join("/"))}
            >
              {c}
            </button>
          </span>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto p-1.5">
        {loading && (
          <p className="flex items-center gap-1.5 px-2 py-3 text-xs text-fg-subtle">
            <LuRefreshCw className="h-3 w-3 animate-spin" /> Loading…
          </p>
        )}
        {error && (
          <p className="flex items-start gap-1.5 rounded-lg border border-danger/25 bg-danger/10 px-2 py-2 text-xs text-danger">
            <LuCircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {error}
          </p>
        )}
        {!loading && !error && entries.length === 0 && (
          <p className="px-2 py-3 text-xs text-fg-subtle">Empty folder.</p>
        )}
        {entries.map((e) => {
          const rel = dirPath ? `${dirPath}/${e.name}` : e.name;
          const active = e.type === "file" && openFile === rel;
          return (
            <div
              key={e.name}
              className={`group flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-sm transition hover:bg-fg/5 ${
                active ? "bg-accent/10 text-accent" : "text-fg"
              }`}
            >
              <button
                onClick={() => (e.type === "dir" ? setDirPath(rel) : openEntry(e.name))}
                className="flex min-w-0 flex-1 items-center gap-2 text-left"
              >
                {e.type === "dir" ? (
                  <LuFolder className="h-4 w-4 shrink-0 text-fg-faint" />
                ) : (
                  <LuFileText className="h-4 w-4 shrink-0 text-fg-faint" />
                )}
                <span className="min-w-0 flex-1 truncate">{e.name}</span>
                {e.type === "file" && (
                  <span className="shrink-0 text-[10px] text-fg-faint">
                    {formatSize(e.size)}
                  </span>
                )}
              </button>
              <button
                onClick={() => deleteEntry(e)}
                title={`Delete ${e.name}`}
                className="shrink-0 rounded p-1 text-fg-faint opacity-0 transition hover:bg-danger/10 hover:text-danger group-hover:opacity-100"
              >
                <LuTrash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          );
        })}
      </div>
      </div>

      {openFile && (
        <div className="flex h-full min-w-0 flex-1 flex-col">
          <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2.5">
            <LuFileText className="h-3.5 w-3.5 shrink-0 text-fg-faint" />
            <span className="min-w-0 flex-1 truncate text-xs text-fg-subtle" title={openFile}>
              {openFileName}
              {dirty && <span className="ml-1 text-accent">•</span>}
            </span>
            <a
              className={btnCls}
              href={api.fileDownloadUrl(workspace, openFile)}
              title="Download this file"
            >
              <LuDownload className="h-3.5 w-3.5" />
            </a>
            {!binary && (
              <button onClick={save} disabled={!dirty || saving} className={primaryCls} title="Save">
                <LuSave className="h-3.5 w-3.5" />
                <span>{saving ? "Saving…" : "Save"}</span>
              </button>
            )}
            <button
              onClick={closeFile}
              title="Close"
              className="shrink-0 rounded p-1 text-fg-faint transition hover:bg-fg/10 hover:text-fg"
            >
              <LuX className="h-3.5 w-3.5" />
            </button>
          </div>

          {fileError && (
            <p className="m-2 flex items-start gap-1.5 rounded-lg border border-danger/25 bg-danger/10 px-2 py-2 text-xs text-danger">
              <LuCircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {fileError}
            </p>
          )}

          {binary ? (
            <div className="flex flex-1 items-center justify-center p-6 text-center text-xs text-fg-subtle">
              Binary or large file — use Download to view it.
            </div>
          ) : (
            <textarea
              value={content}
              onChange={(ev) => {
                setContent(ev.target.value);
                setDirty(true);
              }}
              spellCheck={false}
              className="flex-1 resize-none bg-transparent p-3 font-mono text-xs text-fg outline-none"
            />
          )}
        </div>
      )}
    </div>
  );
}
