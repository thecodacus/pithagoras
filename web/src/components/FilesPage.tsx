import { useEffect, useState } from "react";
import {
  LuChevronRight,
  LuCircleAlert,
  LuDownload,
  LuFileText,
  LuFolder,
  LuRefreshCw,
  LuSave,
  LuTrash2,
} from "react-icons/lu";
import { api, type FileEntry, type Workspace } from "../api";

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
 * Browses, views, edits and downloads the files inside a workspace — the same
 * folder pi already reads and writes, just reachable without shelling into
 * the host or the container.
 */
export function FilesPage({ workspaces }: { workspaces: Workspace[] }) {
  const [workspace, setWorkspace] = useState(workspaces[0]?.name ?? "");

  // `workspaces` arrives asynchronously from the parent. On a fresh page load
  // (not just an in-app navigation) this component can mount before it does,
  // seeding `workspace` empty with nothing to ever correct it afterwards.
  useEffect(() => {
    if (!workspace && workspaces.length) setWorkspace(workspaces[0].name);
  }, [workspaces]);
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

  const openEntry = (name: string) => {
    const rel = dirPath ? `${dirPath}/${name}` : name;
    setOpenFile(rel);
    setFileError(null);
    setDirty(false);
    api
      .readFile(workspace, rel)
      .then((r) => {
        setBinary(r.binary);
        setContent(r.content ?? "");
      })
      .catch((e) => setFileError((e as Error).message));
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

  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
      <header className="flex shrink-0 items-center gap-2 border-b border-line px-4 py-3">
        <select
          value={workspace}
          onChange={(e) => {
            setWorkspace(e.target.value);
            setDirPath("");
            setOpenFile(null);
          }}
          className="rounded-lg border border-line bg-raised/60 px-2 py-1.5 text-sm outline-none"
        >
          {workspaces.map((w) => (
            <option key={w.name} value={w.name}>
              {w.name}
            </option>
          ))}
        </select>

        {workspace && (
          <a
            className={btnCls}
            href={api.archiveDownloadUrl(workspace)}
            title="Download the whole workspace as a .tar.gz"
          >
            <LuDownload className="h-3.5 w-3.5" />
            Download project
          </a>
        )}
      </header>

      <div className="flex min-h-0 flex-1">
        <div className="flex w-72 shrink-0 flex-col overflow-hidden border-r border-line">
          <div className="flex shrink-0 items-center gap-1 overflow-x-auto whitespace-nowrap border-b border-line px-3 py-2 text-xs text-fg-subtle">
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

        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          {!openFile ? (
            <div className="flex flex-1 items-center justify-center text-sm text-fg-subtle">
              Select a file to view or edit it.
            </div>
          ) : (
            <>
              <div className="flex shrink-0 items-center gap-2 border-b border-line px-4 py-2">
                <span className="min-w-0 flex-1 truncate font-mono text-xs text-fg-subtle">
                  {openFile}
                </span>
                {dirty && !binary && (
                  <button className={primaryCls} onClick={save} disabled={saving}>
                    <LuSave className="h-3.5 w-3.5" />
                    {saving ? "Saving…" : "Save"}
                  </button>
                )}
                <a className={btnCls} href={api.fileDownloadUrl(workspace, openFile)}>
                  <LuDownload className="h-3.5 w-3.5" />
                  Download
                </a>
                <button
                  className="rounded-lg p-2 text-fg-subtle transition hover:bg-danger/10 hover:text-danger"
                  title="Delete this file"
                  onClick={async () => {
                    const name = openFile.split("/").pop()!;
                    if (!confirm(`Delete the file "${name}"? This cannot be undone.`)) return;
                    await api.deleteFile(workspace, openFile);
                    setOpenFile(null);
                    await refreshList();
                  }}
                >
                  <LuTrash2 className="h-3.5 w-3.5" />
                </button>
              </div>
              <div className="min-h-0 flex-1 overflow-auto p-3">
                {fileError ? (
                  <p className="flex items-start gap-1.5 rounded-lg border border-danger/25 bg-danger/10 px-3 py-2 text-xs text-danger">
                    <LuCircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {fileError}
                  </p>
                ) : binary ? (
                  <p className="text-sm text-fg-subtle">
                    Binary or large file — use Download to view it.
                  </p>
                ) : (
                  <textarea
                    value={content}
                    onChange={(e) => {
                      setContent(e.target.value);
                      setDirty(true);
                    }}
                    spellCheck={false}
                    className="h-full w-full resize-none rounded-lg border border-line bg-raised/40 p-3 font-mono text-xs leading-relaxed outline-none focus:border-accent/60"
                  />
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
