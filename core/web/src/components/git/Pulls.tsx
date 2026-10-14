import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { LuCircleCheck, LuCircleDot, LuCircleX, LuExternalLink, LuGitCompareArrows, LuGitMerge, LuGitPullRequest, LuLoader } from "react-icons/lu";
import { Markdown } from "../Markdown";
import { Select } from "../Select";
import { webLink } from "../../package-names";
import { gitApi, type Check, type Comparison, type PullDetail, type PullSummary } from "../../git-api";
import { parseDiff, type DiffFile } from "../../git-diff";
import { confirmDialog } from "../ConfirmDialog";
import { Counts, ErrorNote, Quiet, SectionHead, TextButton } from "./bits";
import { ChangeList } from "./History";
import { useGit } from "./context";
import { useGitDraft } from "./draft";
import { when } from "../../time";
import { labelOf, msg, t, tc, tp, tx } from "../../i18n";


/** Where a pull request is: open, draft, merged or closed. */
function StateBadge({ pull }: { pull: Pick<PullSummary, "state" | "isDraft"> }) {
  const state = pull.isDraft && pull.state === "OPEN" ? "DRAFT" : pull.state;
  const look: Record<string, string> = {
    OPEN: "text-ok ring-ok/30",
    DRAFT: "text-fg-subtle ring-line",
    MERGED: "text-accent ring-accent/30",
    CLOSED: "text-danger ring-danger/30",
  };
  const named: Record<string, string> = {
    OPEN: tc("open", "pull request state"),
    DRAFT: tc("draft", "pull request state"),
    MERGED: tc("merged", "pull request state"),
    CLOSED: tc("closed", "pull request state"),
  };
  return <span className={`shrink-0 rounded px-1 text-[10px] ring-1 ring-inset ${look[state] ?? "text-fg-subtle ring-line"}`}>{named[state] ?? state.toLowerCase()}</span>;
}

/** What reviewers decided, as GitHub names it, in words. */
const DECISION: Record<string, string> = {
  APPROVED: msg("approved"),
  CHANGES_REQUESTED: msg("changes requested"),
  REVIEW_REQUIRED: msg("review required"),
};
const decision = (d: string) => labelOf(DECISION, d, (other) => other.toLowerCase().replace(/_/g, " "));

/**
 * Pull requests, through gh: the one for the branch checked out (or a way to
 * open it), and the repository's list. Without gh, or signed out, it says so —
 * and the branch can still be compared with its base, which is most of what a
 * pull request is for before anybody else looks at it.
 */
export function Pulls() {
  const { id, repo, show } = useGit();
  const gh = repo.gh;
  const [state, setState] = useState("open");
  const [list, setList] = useState<PullSummary[] | null>(null);
  // undefined: not known yet, or GitHub could not say (`currentError`); null: the branch has no pull request.
  const [current, setCurrent] = useState<PullDetail | null | undefined>(undefined);
  const [currentError, setCurrentError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Bumped to ask GitHub again after it failed to answer.
  const [again, setAgain] = useState(0);
  // Bumped when a pull request is opened here: nothing on this disk moved, and
  // both lists would go on offering to open it.
  const [opened, setOpened] = useState(0);

  useEffect(() => {
    if (!gh?.repo) return;
    let gone = false;
    setList(null);
    setError(null);
    gitApi.pulls(id, state).then(
      (r) => !gone && setList(r.pulls),
      (e) => !gone && setError((e as Error).message),
    );
    return () => {
      gone = true;
    };
  }, [id, gh?.repo, state, repo.head, opened, again]);

  useEffect(() => {
    if (!gh?.repo) return;
    let gone = false;
    setCurrentError(null);
    gitApi.currentPull(id).then(
      (r) => {
        if (gone) return;
        setCurrent(r.pull);
      },
      // Not "no pull request": the branch may have one, and the form to open a second would fail on it.
      (e) => {
        if (gone) return;
        setCurrent(undefined);
        setCurrentError((e as Error).message);
      },
    );
    return () => {
      gone = true;
    };
  }, [id, gh?.repo, repo.branch, repo.head, opened, again]);

  const onDefault = !repo.branch || repo.branch === gh?.defaultBranch;
  const web = repo.remotes.find((r) => r.name === "origin")?.web ?? repo.remotes[0]?.web;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <button
        type="button"
        onClick={() => show({ kind: "compare" })}
        className="flex w-full items-center gap-1.5 border-b border-line px-3 py-1.5 text-left text-[11px] text-fg-subtle transition hover:bg-fg/5 hover:text-fg"
      >
        <LuGitCompareArrows aria-hidden className="h-3.5 w-3.5" />
        {t("Compare {branch} with its base", { branch: repo.branch ?? "HEAD" })}
      </button>
      {!gh ? (
        <Quiet>{t("Asking GitHub…")}</Quiet>
      ) : !gh.repo ? (
        <div className="px-3 py-3 text-xs text-fg-subtle">
          <p>{gh.note ?? t("Pull requests need gh and a repository on GitHub.")}</p>
          {web && (
            <a href={web} target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-1 text-accent hover:underline">
              {t("Open the repository on the web")} <LuExternalLink aria-hidden className="h-3 w-3" />
            </a>
          )}
        </div>
      ) : (
        <>
          <SectionHead title={t("This branch")} />
          {currentError ? (
            <ErrorNote onRetry={() => setAgain((n) => n + 1)}>{t("Could not ask GitHub about this branch: {error}", { error: currentError })}</ErrorNote>
          ) : current === undefined ? (
            <Quiet>{t("Loading…")}</Quiet>
          ) : current ? (
            <PullRow pull={current} />
          ) : onDefault ? (
            <Quiet>{t("On {branch} — switch to a branch of your own to open a pull request from it.", { branch: repo.branch ?? t("no branch") })}</Quiet>
          ) : (
            <OpenPull
              onOpened={(n) => {
                setOpened((k) => k + 1);
                if (n) show({ kind: "pull", n });
              }}
            />
          )}
          <SectionHead title={t("Pull requests")}>
            <Select
              size="sm"
              value={state}
              onChange={setState}
              aria-label={t("Which pull requests")}
              options={[
                { value: "open", label: tc("Open", "pull request state") },
                { value: "merged", label: t("Merged") },
                { value: "closed", label: t("Closed") },
                { value: "all", label: t("All") },
              ]}
            />
          </SectionHead>
          {/* Not dismissable: dismissed, the list would be neither there nor failed, and read "Loading…" for good. */}
          {error && <ErrorNote onRetry={() => setAgain((n) => n + 1)}>{error}</ErrorNote>}
          {!list && !error && <Quiet>{t("Loading…")}</Quiet>}
          {list && !list.length && <Quiet>{t("None.")}</Quiet>}
          {list?.map((p) => <PullRow key={p.number} pull={p} />)}
        </>
      )}
    </div>
  );
}

function PullRow({ pull: p }: { pull: PullSummary }) {
  const { show } = useGit();
  return (
    <button type="button" onClick={() => show({ kind: "pull", n: p.number })} className="flex w-full flex-col gap-0.5 border-b border-line/50 px-3 py-1.5 text-left transition hover:bg-fg/5">
      <span className="flex min-w-0 items-center gap-1.5">
        <LuGitPullRequest aria-hidden className="h-3.5 w-3.5 shrink-0 text-fg-faint" />
        <span className="min-w-0 flex-1 truncate text-xs text-fg">{p.title}</span>
        <StateBadge pull={p} />
      </span>
      <span className="flex min-w-0 items-center gap-1.5 pl-5 text-[10.5px] text-fg-faint">
        <span className="shrink-0">#{p.number}</span>
        <span className="min-w-0 truncate font-mono">
          {p.headRefName} → {p.baseRefName}
        </span>
        {p.author && <span className="shrink-0">{p.author.login}</span>}
        {p.reviewDecision && <span className="shrink-0">{decision(p.reviewDecision)}</span>}
        <span className="ml-auto shrink-0">{when(p.updatedAt)}</span>
      </span>
    </button>
  );
}

/** What is typed into the form that opens a pull request. */
interface PullForm {
  title: string;
  body: string;
  base: string;
  draft: boolean;
}

/** The form as it was left, or null where there is none: kept as text, in the Git panel's drafts. */
function readForm(text: string): PullForm | null {
  try {
    const f = JSON.parse(text) as Partial<PullForm> | null;
    return f && typeof f === "object" ? { title: String(f.title ?? ""), body: String(f.body ?? ""), base: String(f.base ?? ""), draft: f.draft === true } : null;
  } catch {
    return null;
  }
}

/**
 * Open a pull request for the branch checked out: pushed first if it is not on GitHub yet.
 * `onOpened` is told of every pull request opened, with its number where gh's answer gave one.
 */
function OpenPull({ onOpened }: { onOpened: (n?: number) => void }) {
  const { id, repo, act, busy } = useGit();
  const defaultBranch = repo.gh?.defaultBranch ?? null;
  // Where the default branch is in this clone: on the remote that is the
  // repository — in a fork's clone not origin, which is the fork.
  const baseRef = repo.gh?.baseRef ?? null;
  // The form is kept while a comparison or a pull request is looked at over it, and
  // across a reload; it is open for as long as there is something kept of it.
  const [kept, setKept] = useGitDraft(`${id}:pull-request:${repo.branch ?? ""}`);
  const form = readForm(kept);
  const open = form !== null;
  const { title, body, base, draft } = form ?? { title: "", body: "", base: defaultBranch ?? "", draft: false };
  // What is shown now, for a change made from an answer that comes later.
  const current = useRef(form);
  current.current = form;
  const change = (patch: Partial<PullForm>) => {
    const next = { title: "", body: "", base: defaultBranch ?? "", draft: false, ...current.current, ...patch };
    current.current = next;
    setKept(JSON.stringify(next));
  };
  const [unfilled, setUnfilled] = useState<string | null>(null);
  const [comparison, setComparison] = useState<Comparison | null>(null);

  // Filled in from what the branch adds: one commit is its own title; several are listed.
  useEffect(() => {
    if (!open) return;
    let gone = false;
    setUnfilled(null);
    gitApi.compare(id, baseRef ?? undefined).then(
      (r) => {
        if (gone) return;
        const c = r.comparison;
        setComparison(c);
        if (!c) return setUnfilled(t("Nothing to compare the branch with, so nothing is filled in."));
        const was = current.current;
        // What was typed is left as it is.
        change({
          title: was?.title || (c.commits.length === 1 ? c.commits[0].subject : (repo.branch ?? "").replace(/^[^/]+\//, "").replace(/[-_]/g, " ")),
          body: was?.body || (c.commits.length > 1 ? c.commits.map((x) => `- ${x.subject}`).reverse().join("\n") : ""),
        });
      },
      (e) => !gone && setUnfilled(t("Not filled in: {error}", { error: (e as Error).message })),
    );
    return () => {
      gone = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, id, baseRef, repo.branch]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    let url = "";
    const ok = await act(repo.upstream ? msg("Opening the pull request") : msg("Pushing, and opening the pull request"), async () => {
      url = (await gitApi.createPull(id, { title, body, base: base || undefined, draft })).url;
    });
    const n = Number(/\/pull\/(\d+)/.exec(url)?.[1]);
    if (ok) {
      setKept("");
      onOpened(n || undefined);
    }
  };

  if (!open) {
    return (
      <div className="px-3 py-2">
        <TextButton primary onClick={() => change({})}>
          <LuGitPullRequest aria-hidden className="h-3.5 w-3.5" /> {t("Open a pull request for {branch}", { branch: repo.branch ?? "" })}
        </TextButton>
      </div>
    );
  }
  return (
    <form onSubmit={submit} className="flex flex-col gap-1.5 border-b border-line px-3 py-2">
      <input
        value={title}
        onChange={(e) => change({ title: e.target.value })}
        placeholder={t("Title")}
        aria-label={t("Title of the pull request")}
        className="rounded border border-line bg-canvas px-2 py-1 text-xs text-fg outline-none focus:border-accent/60"
      />
      <textarea
        value={body}
        onChange={(e) => change({ body: e.target.value })}
        rows={5}
        placeholder={t("What it does, and why (Markdown)")}
        aria-label={t("Description of the pull request")}
        className="resize-y rounded border border-line bg-canvas px-2 py-1 text-xs text-fg outline-none focus:border-accent/60"
      />
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-fg-subtle">
        <label className="flex items-center gap-1">
          {t("into")}
          <input value={base} onChange={(e) => change({ base: e.target.value })} aria-label={t("Base branch")} spellCheck={false} className="w-28 rounded border border-line bg-canvas px-1 py-0.5 font-mono text-[11px] text-fg" />
        </label>
        <label className="flex cursor-pointer items-center gap-1">
          <input type="checkbox" checked={draft} onChange={(e) => change({ draft: e.target.checked })} className="h-3 w-3 accent-accent" />
          {t("Draft")}
        </label>
        {comparison && (
          <span className="text-fg-faint">
            {tp(comparison.commits.length, "{n} commit", "{n} commits")}, {tp(comparison.files.length, "{n} file", "{n} files")}
          </span>
        )}
        <span className="ml-auto" />
        <TextButton onClick={() => setKept("")}>{t("Cancel")}</TextButton>
        <TextButton type="submit" primary disabled={!title.trim() || !!busy}>
          {repo.upstream ? t("Open") : t("Push and open")}
        </TextButton>
      </div>
      {unfilled && <p className="text-[10.5px] text-fg-faint">{unfilled}</p>}
      {repo.files.length > 0 && <p className="text-[10.5px] text-warn">{tp(repo.files.length, "{n} changed file is not committed — it is not part of it.", "{n} changed files are not committed — they are not part of it.")}</p>}
    </form>
  );
}

function CheckIcon({ check }: { check: Check }) {
  const result = (check.conclusion || check.state || check.status || "").toUpperCase();
  if (["SUCCESS", "NEUTRAL", "SKIPPED"].includes(result)) return <LuCircleCheck aria-label={t("Passed")} className="h-3.5 w-3.5 shrink-0 text-ok" />;
  if (["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"].includes(result)) return <LuCircleX aria-label={t("Failed")} className="h-3.5 w-3.5 shrink-0 text-danger" />;
  if (["IN_PROGRESS", "QUEUED", "PENDING", "EXPECTED", "WAITING", "REQUESTED"].includes(result)) return <LuLoader aria-label={t("Running")} className="h-3.5 w-3.5 shrink-0 animate-spin text-warn" />;
  return <LuCircleDot aria-label={result.toLowerCase()} className="h-3.5 w-3.5 shrink-0 text-fg-faint" />;
}

const PullMarkdown = ({ children }: { children: string }) => (
  <div className="md text-xs leading-relaxed text-fg [&_h1]:text-sm [&_h2]:text-sm [&_h3]:text-xs [&_h1]:font-semibold [&_h2]:font-semibold">
    <Markdown>{children}</Markdown>
  </div>
);

/** The letter a changed file is listed under, as the commit's and a comparison's lists write it. */
const STATUS_LETTER = { added: "A", deleted: "D", renamed: "R", modified: "M" } as const;

/** One pull request: what it is, its checks, its files, what was said — and what can be done with it. */
export function PullView({ n }: { n: number }) {
  const { id, repo, act, busy, show } = useGit();
  const [pull, setPull] = useState<PullDetail | null>(null);
  const [files, setFiles] = useState<{ files: DiffFile[]; truncated: boolean } | null>(null);
  // The diff failing is not "no files": the pull request has some, and the list said none.
  const [filesError, setFilesError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [method, setMethod] = useState<"merge" | "squash" | "rebase">("squash");
  const [deleteBranch, setDeleteBranch] = useState(true);
  // Kept while one of its files is looked at over it, and across a reload.
  const [reply, setReply] = useGitDraft(`${id}:pull-reply:${n}`);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let gone = false;
    setFilesError(null);
    gitApi.pullDetail(id, n).then(
      (r) => !gone && setPull(r.pull),
      (e) => !gone && setError((e as Error).message),
    );
    gitApi.pullDiff(id, n).then(
      (r) => !gone && setFiles({ files: parseDiff(r.diff), truncated: r.truncated }),
      (e) => !gone && setFilesError((e as Error).message),
    );
    return () => {
      gone = true;
    };
  }, [id, n, tick]);

  const conversation = useMemo(() => {
    if (!pull) return [];
    const said = [
      ...(pull.comments ?? []).map((c) => ({ who: c.author?.login ?? "someone", body: c.body, at: c.createdAt, state: "" })),
      ...(pull.reviews ?? []).filter((r) => r.body || r.state !== "COMMENTED").map((r) => ({ who: r.author?.login ?? "someone", body: r.body, at: r.submittedAt, state: r.state })),
    ];
    return said.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  }, [pull]);

  if (error) return <ErrorNote onRetry={() => (setError(null), setTick((k) => k + 1))}>{error}</ErrorNote>;
  if (!pull) return <Quiet>{t("Loading…")}</Quiet>;
  const open = pull.state === "OPEN";
  const checks = pull.statusCheckRollup ?? [];
  // A fork's branch of the same name is not this one: only a branch of this repository is.
  const here = !pull.isCrossRepository && repo.branch === pull.headRefName;
  const after = () => setTick((t) => t + 1);

  const merge = async () => {
    const ok = await confirmDialog({
      title: t("Merge #{n}?", { n: pull.number }),
      message: `${method === "squash" ? t("Squashed into one commit on {base}, on GitHub.", { base: pull.baseRefName }) : method === "rebase" ? t("Rebased on {base}, on GitHub.", { base: pull.baseRefName }) : t("With a merge commit on {base}, on GitHub.", { base: pull.baseRefName })}${deleteBranch ? ` ${t("{branch} is deleted afterwards.", { branch: pull.headRefName })}` : ""}`,
      confirmLabel: t("Merge"),
    });
    if (ok && (await act(msg("Merging #{n}"), () => gitApi.mergePull(id, pull.number, method, deleteBranch), { n: pull.number }))) after();
  };

  const review = async (action: "approve" | "request-changes" | "comment") => {
    const label = action === "approve" ? msg("Approving") : action === "request-changes" ? msg("Asking for changes") : msg("Commenting");
    if (await act(label, () => (action === "comment" ? gitApi.commentPull(id, pull.number, reply) : gitApi.reviewPull(id, pull.number, action, reply)))) {
      setReply("");
      after();
    }
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="border-b border-line px-3 py-2">
        <div className="flex items-start gap-2">
          <p className="min-w-0 flex-1 text-sm font-medium text-fg">
            {pull.title} <span className="font-normal text-fg-faint">#{pull.number}</span>
          </p>
          <StateBadge pull={pull} />
          {webLink(pull.url) && (
            <a href={webLink(pull.url)} target="_blank" rel="noreferrer" title={t("Open on GitHub")} aria-label={t("Open on GitHub")} className="shrink-0 rounded p-0.5 text-fg-faint hover:text-fg">
              <LuExternalLink className="h-3.5 w-3.5" />
            </a>
          )}
        </div>
        <p className="mt-1 text-[10.5px] text-fg-faint">
          {tx("{author} wants {head} in {base}", { author: pull.author?.login ?? "", head: <span className="font-mono">{pull.headRefName}</span>, base: <span className="font-mono">{pull.baseRefName}</span> })}
          {pull.additions !== undefined && (
            <>
              {" · "}
              <Counts added={pull.additions} removed={pull.deletions ?? 0} />
            </>
          )}
          {pull.reviewDecision && ` · ${decision(pull.reviewDecision)}`}
          {pull.mergeable === "CONFLICTING" && <span className="text-danger"> · {t("has conflicts")}</span>}
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {!here && open && (
            <TextButton disabled={!!busy} onClick={() => void act(msg("Checking out #{n}"), () => gitApi.checkoutPull(id, pull.number), { n: pull.number })} title={t("Check its branch out here, to try it or work on it")}>
              {t("Check out")}
            </TextButton>
          )}
          {open && (
            <>
              <Select
                size="sm"
                value={method}
                onChange={setMethod}
                aria-label={t("How to merge")}
                options={[
                  { value: "squash", label: t("Squash") },
                  { value: "merge", label: t("Merge commit") },
                  { value: "rebase", label: t("Rebase") },
                ]}
              />
              <label className="flex cursor-pointer items-center gap-1 text-[11px] text-fg-subtle">
                <input type="checkbox" checked={deleteBranch} onChange={(e) => setDeleteBranch(e.target.checked)} className="h-3 w-3 accent-accent" />
                {t("delete branch")}
              </label>
              <TextButton primary disabled={!!busy || pull.isDraft} onClick={() => void merge()} title={pull.isDraft ? t("A draft is not merged — mark it ready on GitHub first") : undefined}>
                <LuGitMerge aria-hidden className="h-3.5 w-3.5" /> {t("Merge")}
              </TextButton>
            </>
          )}
        </div>
      </div>

      {checks.length > 0 && (
        <>
          <SectionHead title={t("Checks")} count={checks.length} />
          <ul className="py-0.5">
            {checks.map((c, i) => (
              <li key={i} className="flex items-center gap-1.5 px-3 py-0.5 text-xs">
                <CheckIcon check={c} />
                <span className="min-w-0 flex-1 truncate text-fg-muted">{c.name ?? c.context}</span>
                {webLink(c.detailsUrl || c.targetUrl) && (
                  <a href={webLink(c.detailsUrl || c.targetUrl)} target="_blank" rel="noreferrer" className="shrink-0 text-[10.5px] text-fg-faint hover:text-fg hover:underline">
                    {t("details")}
                  </a>
                )}
              </li>
            ))}
          </ul>
        </>
      )}

      {pull.body?.trim() && (
        <div className="border-b border-line px-3 py-2">
          <PullMarkdown>{pull.body}</PullMarkdown>
        </div>
      )}

      <SectionHead title={t("Files")} count={files?.files.length ?? pull.changedFiles} />
      {filesError ? (
        <ErrorNote onRetry={() => setTick((k) => k + 1)}>{filesError}</ErrorNote>
      ) : !files ? (
        <Quiet>{t("Loading…")}</Quiet>
      ) : (
        <>
          <ChangeList
            files={files.files.map(({ path, from, status, added, removed, binary }) => ({ path, from, status: STATUS_LETTER[status], added, removed, binary }))}
            open={(f) => {
              const file = files.files.find((d) => d.path === f.path)!;
              show({ kind: "parsed", title: file.path, file, truncated: files.truncated && file === files.files[files.files.length - 1] });
            }}
          />
          {files.truncated && <Quiet>{t("Too large to show whole — the last files are missing.")}</Quiet>}
        </>
      )}

      {(pull.commits?.length ?? 0) > 0 && (
        <>
          <SectionHead title={t("Commits")} count={pull.commits!.length} />
          <ul>
            {pull.commits!.map((c) => (
              <li key={c.oid} className="flex items-baseline gap-1.5 px-3 py-0.5 text-xs">
                <span className="shrink-0 font-mono text-[10.5px] text-fg-faint">{c.oid.slice(0, 7)}</span>
                <span className="min-w-0 truncate text-fg-muted">{c.messageHeadline}</span>
              </li>
            ))}
          </ul>
        </>
      )}

      <SectionHead title={t("Conversation")} count={conversation.length} />
      {conversation.map((c, i) => (
        <div key={i} className="border-b border-line/50 px-3 py-2">
          <p className="mb-1 text-[10.5px] text-fg-faint">
            <span className="font-medium text-fg-subtle">{c.who}</span>
            {c.state === "APPROVED" && <span className="text-ok"> {t("approved")}</span>}
            {c.state === "CHANGES_REQUESTED" && <span className="text-danger"> {t("asked for changes")}</span>}
            {" · "}
            {when(c.at)}
          </p>
          {c.body && <PullMarkdown>{c.body}</PullMarkdown>}
        </div>
      ))}
      <div className="px-3 py-2">
        <textarea
          value={reply}
          onChange={(e) => setReply(e.target.value)}
          rows={3}
          placeholder={t("Write a comment (Markdown)")}
          aria-label={t("Comment on the pull request")}
          className="w-full resize-y rounded border border-line bg-canvas px-2 py-1 text-xs text-fg outline-none focus:border-accent/60"
        />
        <div className="mt-1 flex flex-wrap items-center justify-end gap-1.5">
          {open && (
            <>
              <TextButton disabled={!!busy || !reply.trim()} onClick={() => void review("request-changes")}>
                {t("Request changes")}
              </TextButton>
              <TextButton disabled={!!busy} onClick={() => void review("approve")}>
                {t("Approve")}
              </TextButton>
            </>
          )}
          <TextButton primary disabled={!!busy || !reply.trim()} onClick={() => void review("comment")}>
            {t("Comment")}
          </TextButton>
        </div>
      </div>
    </div>
  );
}
