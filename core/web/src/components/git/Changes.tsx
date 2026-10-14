import { useEffect, useState } from "react";
import { LuArchive, LuArchiveRestore, LuExternalLink, LuMinus, LuPlus, LuTrash2, LuUndo2 } from "react-icons/lu";
import { gitApi, type ChangedFile, type Stash } from "../../git-api";
import { isEnter } from "../../shortcuts";
import { confirmDialog } from "../ConfirmDialog";
import { ago, Counts, ErrorNote, IconButton, Letter, LETTER_NAME, Quiet, SectionHead, splitPath, TextButton } from "./bits";
import { useGit } from "./context";
import { useGitDraft } from "./draft";
import { msg, t, tp } from "../../i18n";

type Side = "staged" | "unstaged" | "conflict";

/** What changed since the last commit: staged, not staged, in conflict — and the commit box. */
export function Changes() {
  const { id, repo, act, busy } = useGit();
  // Kept while a diff is open over the tab, and across a reload: both unmount the box.
  const [message, setMessage] = useGitDraft(`${id}:commit`);
  const [amended, setAmended] = useGitDraft(`${id}:amend`);
  const amend = amended === "1";
  const setAmend = (on: boolean) => setAmended(on ? "1" : "");

  const conflicts = repo.files.filter((f) => f.kind === "conflict");
  const staged = repo.files.filter((f) => f.kind !== "conflict" && f.kind !== "untracked" && f.x !== ".");
  const unstaged = repo.files.filter((f) => f.kind === "untracked" || (f.kind !== "conflict" && f.y !== "."));
  const nothing = !repo.files.length;
  // With nothing staged, the button commits everything: the usual case, one
  // click. Not when amending: that is mostly to put a message right, and the
  // agent's unstaged work does not belong in the last commit unasked.
  const all = !staged.length && !amend;
  const canCommit = !busy && !conflicts.length && (amend || (!!message.trim() && !nothing));

  const commit = async () => {
    if (!canCommit) return;
    const ok = await act(amend ? msg("Amending the last commit") : all ? msg("Committing everything") : msg("Committing"), async () => {
      if (all && !nothing) await gitApi.stage(id, "all");
      return gitApi.commit(id, message, amend);
    });
    if (ok) {
      setMessage("");
      setAmend(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b border-line p-2">
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if (isEnter(e) && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void commit();
            }
          }}
          rows={Math.min(6, Math.max(2, message.split("\n").length))}
          placeholder={amend ? t("New message — leave empty to keep the last one") : t("Commit message (Ctrl+Enter to commit)")}
          aria-label={t("Commit message")}
          className="w-full resize-none rounded-lg border border-line bg-canvas px-2 py-1.5 text-xs text-fg outline-none placeholder:text-fg-faint focus:border-accent/60"
        />
        <div className="mt-1.5 flex items-center gap-2">
          <label className="flex cursor-pointer items-center gap-1 text-[11px] text-fg-subtle" title={t("Change the last commit instead of making a new one")}>
            <input type="checkbox" checked={amend} onChange={(e) => setAmend(e.target.checked)} className="h-3 w-3 accent-accent" disabled={!repo.head} />
            {t("Amend")}
          </label>
          <span className="ml-auto" />
          <TextButton primary disabled={!canCommit} onClick={() => void commit()} title={conflicts.length ? t("Resolve the conflicts first") : undefined}>
            {amend ? (staged.length ? t("Amend with {n} staged", { n: staged.length }) : t("Amend")) : all ? (nothing ? t("Commit") : t("Commit all {n}", { n: unstaged.length })) : t("Commit {n} staged", { n: staged.length })}
          </TextButton>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {nothing && <Quiet>{t("Nothing has changed since the last commit.")}</Quiet>}
        {conflicts.length > 0 && (
          <>
            <SectionHead title={t("Conflicts")} count={conflicts.length} />
            {conflicts.map((f) => (
              <FileRow key={`c:${f.path}`} file={f} side="conflict" />
            ))}
          </>
        )}
        {staged.length > 0 && (
          <>
            <SectionHead title={t("Staged")} count={staged.length}>
              <IconButton label={t("Unstage everything")} disabled={!!busy} onClick={() => void act(msg("Unstaging"), () => gitApi.unstage(id, "all"))}>
                <LuMinus aria-hidden className="h-3.5 w-3.5" />
              </IconButton>
            </SectionHead>
            {staged.map((f) => (
              <FileRow key={`s:${f.path}`} file={f} side="staged" />
            ))}
          </>
        )}
        {unstaged.length > 0 && (
          <>
            <SectionHead title={t("Changes")} count={unstaged.length}>
              <IconButton label={t("Stash everything — put it away for later")} disabled={!!busy} onClick={() => void act(msg("Stashing"), () => gitApi.stash(id))}>
                <LuArchive aria-hidden className="h-3.5 w-3.5" />
              </IconButton>
              <IconButton
                label={t("Discard every change not staged")}
                danger
                disabled={!!busy}
                onClick={async () => {
                  const ok = await confirmDialog({
                    title: tp(unstaged.length, "Discard {n} change?", "Discard {n} changes?"),
                    message: t("Changed files go back to how they were, and new files are deleted. This cannot be undone."),
                    confirmLabel: t("Discard"),
                    danger: true,
                  });
                  if (ok) await act(msg("Discarding"), () => gitApi.discard(id, unstaged.map((f) => f.path)));
                }}
              >
                <LuUndo2 aria-hidden className="h-3.5 w-3.5" />
              </IconButton>
              <IconButton label={t("Stage everything")} disabled={!!busy} onClick={() => void act(msg("Staging"), () => gitApi.stage(id, "all"))}>
                <LuPlus aria-hidden className="h-3.5 w-3.5" />
              </IconButton>
            </SectionHead>
            {unstaged.map((f) => (
              <FileRow key={`u:${f.path}`} file={f} side="unstaged" />
            ))}
          </>
        )}
        {repo.truncated && <Quiet>{t("More files changed than are listed here.")}</Quiet>}
        {repo.stashes > 0 && <Stashes count={repo.stashes} />}
      </div>
    </div>
  );
}

/**
 * What unstaging a file takes back: a rename is a new file and the old one's
 * deletion, and taking back only the first left the deletion staged, to go
 * into the next commit. (Staging is by the new name alone: the old one is not
 * in the tree to add, and naming it failed the whole add.)
 */
export const unstagePaths = (file: { path: string; from?: string }) => (file.from ? [file.path, file.from] : [file.path]);

function FileRow({ file, side }: { file: ChangedFile; side: Side }) {
  const { id, act, busy, show, openFile, inFolder } = useGit();
  const letter = side === "conflict" ? "!" : side === "staged" ? file.x : file.kind === "untracked" ? "U" : file.y;
  const counts = side === "staged" ? file.staged : side === "unstaged" ? file.unstaged : undefined;
  const { dir, name } = splitPath(file.path);
  const deleted = letter === "D";
  const open = () =>
    show({
      kind: "diff",
      title: file.path,
      path: file.path,
      what:
        side === "staged"
          ? { of: "staged", path: file.path, from: file.from }
          : file.kind === "untracked"
            ? { of: "untracked", path: file.path }
            : { of: "unstaged", path: file.path, from: file.from },
    });
  return (
    <div className="group flex items-center gap-1.5 px-2 transition hover:bg-fg/5 focus-within:bg-fg/5">
      <button type="button" onClick={open} title={t("{file} — show the changes", { file: `${file.from ? `${file.from} → ` : ""}${file.path}` })} className="flex min-w-0 flex-1 items-center gap-1.5 py-1 text-left">
        <Letter letter={letter} title={LETTER_NAME[letter]} />
        <span className={`min-w-0 truncate text-xs ${deleted ? "text-fg-subtle line-through" : "text-fg"}`}>{name}</span>
        {dir && <span className="min-w-0 flex-1 truncate text-[10.5px] text-fg-faint">{dir}</span>}
        {!dir && <span className="flex-1" />}
        {counts && <Counts {...counts} />}
      </button>
      <div className="flex shrink-0 items-center opacity-0 transition focus-within:opacity-100 group-hover:opacity-100 [@media(pointer:coarse)]:opacity-100">
        {openFile && inFolder(file.path) && !deleted && (
          <IconButton label={t("Open {name} in Files", { name })} onClick={() => openFile(file.path)}>
            <LuExternalLink aria-hidden className="h-3.5 w-3.5" />
          </IconButton>
        )}
        {side === "unstaged" && (
          <IconButton
            label={file.kind === "untracked" ? t("Delete {name}", { name }) : t("Discard the changes to {name}", { name })}
            danger
            disabled={!!busy}
            onClick={async () => {
              const ok = await confirmDialog({
                title: file.kind === "untracked" ? t("Delete {name}?", { name }) : t("Discard the changes to {name}?", { name }),
                message: file.kind === "untracked" ? t("It is new and not in any commit, so nothing brings it back.") : t("It goes back to how it was staged or last committed. This cannot be undone."),
                confirmLabel: file.kind === "untracked" ? t("Delete") : t("Discard"),
                danger: true,
              });
              if (ok) await act(msg("Discarding"), () => gitApi.discard(id, [file.path]));
            }}
          >
            {file.kind === "untracked" ? <LuTrash2 aria-hidden className="h-3.5 w-3.5" /> : <LuUndo2 aria-hidden className="h-3.5 w-3.5" />}
          </IconButton>
        )}
        {side === "staged" ? (
          <IconButton label={t("Unstage {name}", { name })} disabled={!!busy} onClick={() => void act(msg("Unstaging"), () => gitApi.unstage(id, unstagePaths(file)))}>
            <LuMinus aria-hidden className="h-3.5 w-3.5" />
          </IconButton>
        ) : (
          <IconButton
            label={side === "conflict" ? t("Mark {name} resolved", { name }) : t("Stage {name}", { name })}
            disabled={!!busy}
            onClick={() => void act(msg("Staging"), () => gitApi.stage(id, [file.path]))}
          >
            <LuPlus aria-hidden className="h-3.5 w-3.5" />
          </IconButton>
        )}
      </div>
    </div>
  );
}

/** What was put away with Stash: shown, brought back, or thrown away. */
function Stashes({ count }: { count: number }) {
  const { id, repo, act, busy, show } = useGit();
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<Stash[] | null>(null);
  // Not an empty list: "no stashes" is a fact, and a failed read is not one.
  const [error, setError] = useState<string | null>(null);
  const [again, setAgain] = useState(0);
  useEffect(() => {
    if (!open) return;
    let gone = false;
    gitApi
      .stashes(id)
      .then((r) => {
        if (gone) return;
        setList(r.stashes);
        setError(null);
      })
      .catch((e) => !gone && setError((e as Error).message));
    return () => {
      gone = true;
    };
    // Again whenever the tree may have moved: the stashes can change without their count doing so.
  }, [open, id, count, repo.head, repo.files.length, again]);
  return (
    <div className="mt-2 border-t border-line">
      <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)} className="flex w-full items-center gap-1 px-3 py-1.5 text-left text-[11px] text-fg-subtle hover:text-fg">
        <LuArchiveRestore aria-hidden className="h-3.5 w-3.5" />
        {tp(count, "{n} stash", "{n} stashes")}
        <span className="ml-auto text-fg-faint">{open ? t("hide") : t("show")}</span>
      </button>
      {open && error && <ErrorNote onRetry={() => setAgain((n) => n + 1)}>{error}</ErrorNote>}
      {open &&
        (list ?? []).map((s) => (
          <div key={s.ref} className="group flex items-center gap-1 px-2 transition hover:bg-fg/5">
            <button type="button" onClick={() => show({ kind: "diff", title: s.message, path: "", what: { of: "stash", stash: s.ref } })} className="flex min-w-0 flex-1 items-baseline gap-1.5 py-1 text-left">
              <span className="min-w-0 flex-1 truncate text-xs text-fg">{s.message}</span>
              <span className="shrink-0 text-[10px] text-fg-faint">{ago(s.date)}</span>
            </button>
            <TextButton disabled={!!busy} onClick={() => void act(msg("Applying the stash"), () => gitApi.stashDo(id, "apply", s.ref, s.sha))} title={t("Bring it back and keep the stash")}>
              {t("Apply")}
            </TextButton>
            <TextButton disabled={!!busy} onClick={() => void act(msg("Popping the stash"), () => gitApi.stashDo(id, "pop", s.ref, s.sha))} title={t("Bring it back and drop the stash")}>
              {t("Pop")}
            </TextButton>
            <IconButton
              label={t("Drop this stash")}
              danger
              disabled={!!busy}
              onClick={async () => {
                if (await confirmDialog({ title: t("Drop this stash?"), message: s.message, confirmLabel: t("Drop"), danger: true })) await act(msg("Dropping the stash"), () => gitApi.stashDo(id, "drop", s.ref, s.sha));
              }}
            >
              <LuTrash2 aria-hidden className="h-3.5 w-3.5" />
            </IconButton>
          </div>
        ))}
    </div>
  );
}
