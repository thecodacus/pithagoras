import { useEffect, useState, type FormEvent } from "react";
import { LuCheck, LuChevronDown, LuChevronRight, LuGitBranchPlus, LuTrash2 } from "react-icons/lu";
import { gitApi, type Branch } from "../../git-api";
import { confirmDialog } from "../ConfirmDialog";
import { ago, ErrorNote, IconButton, Quiet, SectionHead, TextButton } from "./bits";
import { useGit } from "./context";
import { msg, t } from "../../i18n";

/** The branches here and on the remotes: switched to, made, deleted. */
export function Branches() {
  const { id, repo, act, busy } = useGit();
  const [list, setList] = useState<Branch[] | null>(null);
  // The list could not be read, apart from a delete that was refused: the first is a list that never came.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [again, setAgain] = useState(0);
  const [filter, setFilter] = useState("");
  const [name, setName] = useState("");
  const [remotesOpen, setRemotesOpen] = useState(false);

  useEffect(() => {
    let gone = false;
    gitApi.branches(id).then(
      (r) => {
        if (gone) return;
        setList(r.branches);
        setLoadError(null);
      },
      (e) => !gone && setLoadError((e as Error).message),
    );
    return () => {
      gone = true;
    };
    // Again whenever something moved: a switch, a fetch, a push. A delete takes its row out itself.
  }, [id, repo.head, repo.branch, repo.upstream, repo.ahead, repo.behind, again]);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    const wanted = name.trim();
    if (!wanted) return;
    if (await act(msg("Making {name}"), () => gitApi.createBranch(id, wanted), { name: wanted })) setName("");
  };

  const remove = async (b: Branch) => {
    if (!(await confirmDialog({ title: t("Delete the branch {name}?", { name: b.name }), message: t("Only the branch here — not on the remote."), confirmLabel: t("Delete"), danger: true }))) return;
    const refused = await gitApi.deleteBranch(id, b.name).then(
      () => null,
      (e) => (e as Error).message,
    );
    const gone = () => setList((l) => l?.filter((x) => x.remote || x.name !== b.name) ?? l);
    if (refused === null) return gone();
    // Not merged anywhere: its commits go with it, so that is asked separately.
    if (!/not fully merged/i.test(refused)) return setError(refused);
    const sure = await confirmDialog({
      title: t("{name} is not merged", { name: b.name }),
      message: t("Its commits are on no other branch. Deleting it loses them unless you have their hashes."),
      confirmLabel: t("Delete anyway"),
      danger: true,
    });
    // The reload after it moves none of what the list is read for, so the row goes out here too.
    if (sure && (await act(msg("Deleting {name}"), () => gitApi.deleteBranch(id, b.name, true), { name: b.name }))) gone();
  };

  if (!list) return loadError ? <ErrorNote onRetry={() => setAgain((n) => n + 1)}>{loadError}</ErrorNote> : <Quiet>{t("Loading…")}</Quiet>;
  const match = (b: Branch) => !filter || b.name.toLowerCase().includes(filter.toLowerCase());
  const local = list.filter((b) => !b.remote && match(b));
  const remote = list.filter((b) => b.remote && match(b));

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {loadError && <ErrorNote onRetry={() => setAgain((n) => n + 1)}>{loadError}</ErrorNote>}
      {error && <ErrorNote onClose={() => setError(null)}>{error}</ErrorNote>}
      <form onSubmit={create} className="flex shrink-0 items-center gap-1.5 border-b border-line px-2 py-1.5">
        <LuGitBranchPlus aria-hidden className="h-3.5 w-3.5 shrink-0 text-fg-faint" />
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={repo.branch ? t("New branch from {branch}", { branch: repo.branch }) : t("New branch from here")}
          aria-label={t("Name of the new branch")}
          spellCheck={false}
          className="min-w-0 flex-1 rounded border border-line bg-canvas px-1.5 py-0.5 font-mono text-xs text-fg outline-none focus:border-accent/60"
        />
        <TextButton type="submit" primary disabled={!name.trim() || !!busy}>
          {t("Create")}
        </TextButton>
      </form>
      {list.length > 8 && (
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder={t("Filter")}
          aria-label={t("Filter the branches")}
          className="mx-2 my-1.5 shrink-0 rounded border border-line bg-canvas px-1.5 py-0.5 text-xs text-fg outline-none focus:border-accent/60"
        />
      )}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <SectionHead title={t("Here")} count={local.length} />
        {local.map((b) => (
          <BranchRow key={b.name} branch={b} onSwitch={() => void act(msg("Switching to {name}"), () => gitApi.switch(id, b.name), { name: b.name })} onDelete={() => void remove(b)} />
        ))}
        {remote.length > 0 && (
          <>
            <button
              type="button"
              aria-expanded={remotesOpen || !!filter}
              onClick={() => setRemotesOpen((v) => !v)}
              className="sticky top-0 flex w-full items-center gap-1 border-b border-line/60 bg-surface/95 px-3 py-1 text-left text-[11px] font-medium uppercase tracking-wide text-fg-subtle"
            >
              {remotesOpen || filter ? <LuChevronDown aria-hidden className="h-3 w-3" /> : <LuChevronRight aria-hidden className="h-3 w-3" />}
              {t("On the remote")}
              <span className="rounded-full bg-fg/8 px-1.5 text-[10px] normal-case">{remote.length}</span>
            </button>
            {(remotesOpen || filter) &&
              remote.map((b) => (
                <BranchRow
                  key={b.name}
                  branch={b}
                  onSwitch={() => void act(msg("Checking out {name}"), () => gitApi.switch(id, b.name, true), { name: b.name })}
                />
              ))}
          </>
        )}
      </div>
    </div>
  );
}

function BranchRow({ branch: b, onSwitch, onDelete }: { branch: Branch; onSwitch: () => void; onDelete?: () => void }) {
  const { busy } = useGit();
  return (
    <div className="group flex items-center gap-1 px-2 transition hover:bg-fg/5 focus-within:bg-fg/5">
      <button
        type="button"
        onClick={onSwitch}
        disabled={b.current || !!busy}
        title={b.current ? t("Checked out") : b.remote ? t("Check out {name}, as a local branch following it", { name: b.name }) : t("Switch to {name}", { name: b.name })}
        className="flex min-w-0 flex-1 flex-col gap-0.5 py-1 text-left disabled:cursor-default"
      >
        <span className="flex min-w-0 items-center gap-1">
          {b.current ? <LuCheck aria-label={t("Checked out")} className="h-3 w-3 shrink-0 text-accent" /> : <span className="w-3 shrink-0" />}
          <span className={`min-w-0 truncate font-mono text-xs ${b.current ? "font-semibold text-fg" : "text-fg"}`}>{b.name}</span>
          {(b.ahead > 0 || b.behind > 0) && (
            <span className="shrink-0 font-mono text-[10px]">
              {b.ahead > 0 && <span className="text-accent">↑{b.ahead}</span>}
              {b.behind > 0 && <span className="text-warn">↓{b.behind}</span>}
            </span>
          )}
          {b.gone && (
            <span className="shrink-0 rounded px-1 text-[10px] text-warn ring-1 ring-inset ring-warn/30" title={t("Its branch on the remote was deleted")}>
              {t("gone")}
            </span>
          )}
        </span>
        <span className="flex min-w-0 items-center gap-1.5 pl-4 text-[10.5px] text-fg-faint">
          <span className="min-w-0 flex-1 truncate">{b.subject}</span>
          <span className="shrink-0">{ago(b.date)}</span>
        </span>
      </button>
      {onDelete && !b.current && (
        <div className="shrink-0 opacity-0 transition focus-within:opacity-100 group-hover:opacity-100 [@media(pointer:coarse)]:opacity-100">
          <IconButton label={t("Delete {name}", { name: b.name })} danger disabled={!!busy} onClick={onDelete}>
            <LuTrash2 aria-hidden className="h-3.5 w-3.5" />
          </IconButton>
        </div>
      )}
    </div>
  );
}
