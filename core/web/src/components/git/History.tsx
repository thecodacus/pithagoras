import { useEffect, useRef, useState } from "react";
import { LuCopy, LuGitCompareArrows } from "react-icons/lu";
import { copyText } from "../../clipboard";
import { gitApi, type Branch, type Commit, type CommitDetail, type Comparison, type FileChange } from "../../git-api";
import { ago, Counts, ErrorNote, IconButton, Letter, LETTER_NAME, Quiet, RefBadge, SectionHead, splitPath } from "./bits";
import { useGit } from "./context";
import { Select } from "../Select";
import { formatDateTime, t } from "../../i18n";

const PAGE = 100;

/** The commits on the branch, newest first; one opened shows what it changed. */
export function History() {
  const { id, repo, show } = useGit();
  const [commits, setCommits] = useState<Commit[] | null>(null);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [again, setAgain] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  // Which read of the first page an older page was asked against: one asked
  // before HEAD moved would be put after a list it does not belong to.
  const generation = useRef(0);

  // Read again when HEAD moves: a commit, a checkout, a pull.
  useEffect(() => {
    let gone = false;
    generation.current++;
    setLoadingMore(false);
    // What went wrong last time is not what is shown this time.
    setError(null);
    gitApi
      .log(id, { limit: PAGE })
      .then((r) => {
        if (gone) return;
        setCommits(r.commits);
        setMore(r.commits.length === PAGE);
      })
      .catch((e) => !gone && setError((e as Error).message));
    return () => {
      gone = true;
    };
  }, [id, repo.head, repo.branch, again]);

  const loadMore = async () => {
    // A second click while the first page is on its way would ask for the same one.
    if (loadingMore) return;
    const asked = generation.current;
    setLoadingMore(true);
    try {
      const r = await gitApi.log(id, { limit: PAGE, skip: commits?.length ?? 0 });
      if (asked !== generation.current) return;
      setCommits((c) => {
        const have = new Set((c ?? []).map((x) => x.sha));
        return [...(c ?? []), ...r.commits.filter((x) => !have.has(x.sha))];
      });
      setMore(r.commits.length === PAGE);
    } catch (e) {
      if (asked === generation.current) setError((e as Error).message);
    } finally {
      if (asked === generation.current) setLoadingMore(false);
    }
  };

  if (error && !commits) return <ErrorNote onRetry={() => setAgain((n) => n + 1)}>{error}</ErrorNote>;
  if (!commits) return <Quiet>{t("Loading…")}</Quiet>;
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      {error && <ErrorNote onClose={() => setError(null)}>{error}</ErrorNote>}
      {repo.head && (
        <button
          type="button"
          onClick={() => show({ kind: "compare" })}
          className="flex w-full items-center gap-1.5 border-b border-line px-3 py-1.5 text-left text-[11px] text-fg-subtle transition hover:bg-fg/5 hover:text-fg"
        >
          <LuGitCompareArrows aria-hidden className="h-3.5 w-3.5" />
          {t("Compare this branch with its base — what a pull request would show")}
        </button>
      )}
      {!commits.length && <Quiet>{t("No commits yet.")}</Quiet>}
      <CommitList commits={commits} />
      {more && (
        <button type="button" disabled={loadingMore} onClick={() => void loadMore()} className="w-full px-3 py-2 text-left text-xs text-fg-subtle hover:text-fg hover:underline disabled:opacity-40">
          {t("Older commits…")}
        </button>
      )}
    </div>
  );
}

function CommitList({ commits }: { commits: Commit[] }) {
  const { show } = useGit();
  return (
    <ul>
      {commits.map((c) => (
        <li key={c.sha}>
          <button
            type="button"
            onClick={() => show({ kind: "commit", sha: c.sha })}
            title={`${c.subject}\n${c.short} · ${c.author} · ${formatDateTime(c.date * 1000)}`}
            className="flex w-full flex-col gap-0.5 border-b border-line/50 px-3 py-1.5 text-left transition hover:bg-fg/5"
          >
            <span className="flex min-w-0 items-center gap-1">
              {c.parents.length > 1 && <span className="shrink-0 text-[10px] text-fg-faint">{t("merge")}</span>}
              <span className="min-w-0 flex-1 truncate text-xs text-fg">{c.subject}</span>
            </span>
            <span className="flex min-w-0 items-center gap-1.5 text-[10.5px] text-fg-faint">
              <span className="shrink-0 font-mono">{c.short}</span>
              <span className="min-w-0 truncate">{c.author}</span>
              <span className="shrink-0">{ago(c.date)}</span>
              {c.refs.length > 0 && (
                <span className="flex min-w-0 flex-1 justify-end gap-1 overflow-hidden">
                  {c.refs.slice(0, 3).map((r) => (
                    <RefBadge key={r} name={r} />
                  ))}
                </span>
              )}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Files a commit or a comparison changed; one opened shows its diff. */
export function ChangeList({ files, open }: { files: FileChange[]; open: (f: FileChange) => void }) {
  return (
    <ul>
      {files.map((f) => {
        const { dir, name } = splitPath(f.path);
        return (
          <li key={f.path}>
            <button
              type="button"
              onClick={() => open(f)}
              title={`${f.from ? `${f.from} → ` : ""}${f.path}`}
              className="flex w-full items-center gap-1.5 px-2 py-1 text-left transition hover:bg-fg/5"
            >
              <Letter letter={f.status} title={LETTER_NAME[f.status]} />
              <span className={`min-w-0 truncate text-xs ${f.status === "D" ? "text-fg-subtle line-through" : "text-fg"}`}>{name}</span>
              <span className="min-w-0 flex-1 truncate text-[10.5px] text-fg-faint">{dir}</span>
              <Counts added={f.added} removed={f.removed} binary={f.binary} />
            </button>
          </li>
        );
      })}
    </ul>
  );
}

export function CommitView({ sha }: { sha: string }) {
  const { id, show } = useGit();
  const [detail, setDetail] = useState<CommitDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [again, setAgain] = useState(0);
  useEffect(() => {
    setError(null);
    gitApi.commitDetail(id, sha).then(setDetail, (e) => setError((e as Error).message));
  }, [id, sha, again]);
  if (error) return <ErrorNote onRetry={() => setAgain((n) => n + 1)}>{error}</ErrorNote>;
  if (!detail) return <Quiet>{t("Loading…")}</Quiet>;
  const [subject, ...body] = detail.message.split("\n");
  const added = detail.files.reduce((n, f) => n + f.added, 0);
  const removed = detail.files.reduce((n, f) => n + f.removed, 0);
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="border-b border-line px-3 py-2">
        <p className="text-sm font-medium text-fg">{subject}</p>
        {body.join("\n").trim() && <p className="mt-1 whitespace-pre-wrap text-xs text-fg-muted">{body.join("\n").trim()}</p>}
        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10.5px] text-fg-faint">
          <span className="font-mono">{detail.sha.slice(0, 12)}</span>
          <IconButton label={t("Copy the commit's hash")} onClick={() => void copyText(detail.sha)}>
            <LuCopy aria-hidden className="h-3 w-3" />
          </IconButton>
          <span>
            {detail.author} &lt;{detail.email}&gt;
          </span>
          <span>{formatDateTime(detail.date * 1000)}</span>
          {detail.parents.length > 1 && <span>{t("merge — shown against its first parent")}</span>}
          {detail.refs.map((r) => (
            <RefBadge key={r} name={r} />
          ))}
        </div>
      </div>
      <SectionHead title={t("Files")} count={detail.files.length}>
        <Counts added={added} removed={removed} />
      </SectionHead>
      <ChangeList files={detail.files} open={(f) => show({ kind: "diff", title: f.path, path: f.path, what: { of: "commit", sha: detail.sha, path: f.path, from: f.from } })} />
    </div>
  );
}

/**
 * The branch against where it came from, as a pull request would show it:
 * the commits it adds, and every file they change taken together.
 */
export function CompareView({ base: asked }: { base?: string }) {
  const { id, repo, show } = useGit();
  // What was picked, and what the answer was against: the default is only known once answered, and
  // taking it as the pick asked the same question twice.
  const [chosen, setChosen] = useState(asked ?? "");
  // The answer is kept with the pick it answers: one for another base, or from before
  // a failure, is not shown, or its files would open diffs against a base that is not the one named.
  const [answer, setAnswer] = useState<{ chosen: string; comparison: Comparison | null } | undefined>(undefined);
  const result = answer?.chosen === chosen ? answer.comparison : undefined;
  const [error, setError] = useState<string | null>(null);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [again, setAgain] = useState(0);
  useEffect(() => {
    gitApi.branches(id).then((r) => setBranches(r.branches), () => {});
  }, [id]);
  useEffect(() => {
    let gone = false;
    setError(null);
    gitApi.compare(id, chosen || undefined).then(
      (r) => {
        if (gone) return;
        setAnswer({ chosen, comparison: r.comparison });
      },
      (e) => {
        if (gone) return;
        setAnswer(undefined);
        setError((e as Error).message);
      },
    );
    return () => {
      gone = true;
    };
  }, [id, chosen, repo.head, again]);
  const base = chosen || result?.base || "";

  const choices = branches.filter((b) => !b.current).map((b) => b.name);
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="flex items-center gap-2 border-b border-line px-3 py-1.5 text-xs text-fg-subtle">
        <span className="shrink-0 font-mono text-fg">{repo.branch ?? "HEAD"}</span>
        <span className="shrink-0">{t("compared with")}</span>
        <Select
          size="sm"
          value={base}
          onChange={setChosen}
          aria-label={t("Compare with")}
          className="min-w-0 flex-1 font-mono"
          options={[...(!choices.includes(base) && base ? [base] : []), ...(!base ? [""] : []), ...choices].map((name) => ({ value: name, label: name || "—" }))}
        />
      </div>
      {error && <ErrorNote onRetry={() => setAgain((n) => n + 1)}>{error}</ErrorNote>}
      {result === undefined && !error && <Quiet>{t("Loading…")}</Quiet>}
      {result === null && <Quiet>{t("There is nothing to compare with — no main or master branch here. Pick one above.")}</Quiet>}
      {result && (
        <>
          <SectionHead title={t("Commits")} count={result.commits.length} />
          {!result.commits.length && <Quiet>{t("Nothing on this branch that {base} does not have.", { base: result.base })}</Quiet>}
          <CommitList commits={result.commits} />
          <SectionHead title={t("Files")} count={result.files.length}>
            <Counts added={result.files.reduce((n, f) => n + f.added, 0)} removed={result.files.reduce((n, f) => n + f.removed, 0)} />
          </SectionHead>
          <ChangeList files={result.files} open={(f) => show({ kind: "diff", title: f.path, path: f.path, what: { of: "range", base: result.base, path: f.path, from: f.from } })} />
        </>
      )}
    </div>
  );
}
