import { useEffect, useState, type ReactNode } from "react";
import { LuExternalLink, LuMinus, LuPlus, LuUndo2 } from "react-icons/lu";
import { gitApi, type DiffOf } from "../../git-api";
import { parseDiff, type DiffFile } from "../../git-diff";
import { confirmDialog } from "../ConfirmDialog";
import { Counts, ErrorNote, Quiet, TextButton } from "./bits";
import { unstagePaths } from "./Changes";
import { useGit, type View } from "./context";
import { DiffView } from "./DiffView";
import { CommitView, CompareView } from "./History";
import { PullView } from "./Pulls";
import { msg, t, tp } from "../../i18n";

/** Whatever was opened over the tab. `onDone` goes back, for a view whose work is finished. */
export function ViewHost({ view, onDone }: { view: View; onDone: () => void }) {
  if (view.kind === "diff") return <LoadedDiff title={view.title} path={view.path} what={view.what} onDone={onDone} />;
  if (view.kind === "parsed") return <FileDiff title={view.title} file={view.file} truncated={view.truncated} />;
  if (view.kind === "commit") return <CommitView sha={view.sha} />;
  if (view.kind === "compare") return <CompareView base={view.base} />;
  return <PullView n={view.n} />;
}

function FileDiff({ title, file, truncated, actions }: { title: string; file: DiffFile; truncated?: boolean; actions?: ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-line px-3 py-1.5">
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-fg" title={file.from ? `${file.from} → ${file.path}` : title}>
          {file.from ? `${file.from} → ` : ""}
          {file.path || title}
        </span>
        <Counts added={file.added} removed={file.removed} binary={file.binary} />
        {actions}
      </div>
      <DiffView file={file} truncated={truncated} />
    </div>
  );
}

/** How many files of a stash are shown at once: each can be thousands of rows. */
const FIRST_FILES = 5;

/** A diff asked of the server: one file's changes, a commit's, a stash's. */
function LoadedDiff({ title, path, what, onDone }: { title: string; path: string; what: DiffOf; onDone: () => void }) {
  const { id, act, busy, openFile, inFolder, repo } = useGit();
  const [files, setFiles] = useState<DiffFile[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [again, setAgain] = useState(0);
  // A stash is many files, and a large one is many thousands of rows: the rest is behind a button.
  const [allFiles, setAllFiles] = useState(false);

  // A diff of what is in the tree is read again when the tree changes under it.
  const live = what.of === "unstaged" || what.of === "staged" || what.of === "untracked";
  const version = live ? repo.files.find((f) => f.path === path) : null;
  useEffect(() => {
    let gone = false;
    gitApi.diff(id, what).then(
      (r) => {
        if (gone) return;
        setFiles(parseDiff(r.diff));
        setTruncated(r.truncated);
        setError(null);
      },
      (e) => !gone && setError((e as Error).message),
    );
    return () => {
      gone = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, JSON.stringify(what), JSON.stringify(version), again]);

  if (error) return <ErrorNote onRetry={() => setAgain((n) => n + 1)}>{error}</ErrorNote>;
  if (!files) return <Quiet>{t("Loading…")}</Quiet>;
  if (live && !version) return <Quiet>{t("No longer changed — it was committed, discarded, or put back as it was.")}</Quiet>;
  if (!files.length) return <Quiet>{what.of === "staged" ? t("Nothing to show: nothing of it is staged.") : t("Nothing to show: no changes in its text.")}</Quiet>;

  const name = path.split("/").pop() ?? path;
  // Its diff is of a file in conflict: there is no side of it to go back to, and git refuses to.
  const conflict = version?.kind === "conflict";
  const actions = (
    <>
      {openFile && path && inFolder(path) && version?.y !== "D" && version?.x !== "D" && live && (
        <TextButton onClick={() => openFile(path)} title={t("Open it in Files")}>
          <LuExternalLink aria-hidden className="h-3 w-3" /> {t("Open")}
        </TextButton>
      )}
      {(what.of === "unstaged" || what.of === "untracked") && (
        <>
          {!conflict && (
            <TextButton
              danger
              disabled={!!busy}
              onClick={async () => {
                const ok = await confirmDialog({
                  title: what.of === "untracked" ? t("Delete {name}?", { name }) : t("Discard the changes to {name}?", { name }),
                  message: t("This cannot be undone."),
                  confirmLabel: what.of === "untracked" ? t("Delete") : t("Discard"),
                  danger: true,
                });
                if (ok && (await act(msg("Discarding"), () => gitApi.discard(id, [path])))) onDone();
              }}
            >
              <LuUndo2 aria-hidden className="h-3 w-3" /> {what.of === "untracked" ? t("Delete") : t("Discard")}
            </TextButton>
          )}
          <TextButton primary disabled={!!busy} onClick={async () => (await act(msg("Staging"), () => gitApi.stage(id, [path]))) && onDone()}>
            <LuPlus aria-hidden className="h-3 w-3" /> {conflict ? t("Mark resolved") : t("Stage")}
          </TextButton>
        </>
      )}
      {what.of === "staged" && (
        <TextButton disabled={!!busy} onClick={async () => (await act(msg("Unstaging"), () => gitApi.unstage(id, unstagePaths({ path, from: what.from })))) && onDone()}>
          <LuMinus aria-hidden className="h-3 w-3" /> {t("Unstage")}
        </TextButton>
      )}
    </>
  );

  if (files.length === 1) return <FileDiff title={title} file={files[0]} truncated={truncated} actions={actions} />;
  // Several files — a stash — one after another.
  const shown = allFiles ? files : files.slice(0, FIRST_FILES);
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      {shown.map((f) => (
        <div key={f.path} className="border-b border-line">
          <FileDiff title={f.path} file={f} />
        </div>
      ))}
      {shown.length < files.length && (
        <button type="button" onClick={() => setAllFiles(true)} className="w-full px-3 py-2 text-left text-xs text-fg-subtle hover:text-fg hover:underline">
          {tp(files.length - shown.length, "Show the other {n} file", "Show the other {n} files")}
        </button>
      )}
      {truncated && <Quiet>{t("Too large to show whole — it stops here.")}</Quiet>}
    </div>
  );
}
