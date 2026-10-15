import { portal } from "./portal";

/**
 * The Git panel's routes: the repository a chat's folder is in, and GitHub
 * through gh. The shapes are the server half's (git.ts), at
 * /api/x/pithagoras-git/chats/<chat>/….
 */

const json = <T>(url: string, init?: RequestInit) => portal.api.json<T>(url, init);

export interface Counts {
  added: number;
  removed: number;
  binary: boolean;
}

export interface ChangedFile {
  path: string;
  from?: string;
  /** The index against HEAD, and the working tree against the index: "." for unchanged, "?" for new. */
  x: string;
  y: string;
  kind: "changed" | "renamed" | "conflict" | "untracked";
  staged?: Counts;
  unstaged?: Counts;
}

export interface Remote {
  name: string;
  address: string;
  web?: string;
}

export interface GhState {
  installed: boolean;
  authed: boolean;
  repo: string | null;
  url: string | null;
  defaultBranch: string | null;
  /** The default branch on the remote that is that repository, e.g. "upstream/main" in a fork's clone. */
  baseRef?: string | null;
  note?: string;
}

export type GitState =
  | { repo: false; folder: string }
  | {
      repo: true;
      root: string;
      /** The chat's folder inside the repository, "" at its top. */
      prefix: string;
      branch: string | null;
      head: string | null;
      upstream: string | null;
      ahead: number;
      behind: number;
      stashes: number;
      operation: "merge" | "rebase" | "am" | "cherry-pick" | "revert" | null;
      files: ChangedFile[];
      truncated: boolean;
      remotes: Remote[];
    };

export interface Commit {
  sha: string;
  short: string;
  parents: string[];
  author: string;
  email: string;
  date: number;
  refs: string[];
  subject: string;
}

export interface FileChange {
  path: string;
  from?: string;
  status: string;
  added: number;
  removed: number;
  binary: boolean;
}

export interface CommitDetail extends Commit {
  message: string;
  committer: string;
  files: FileChange[];
}

export interface Branch {
  name: string;
  remote: boolean;
  sha: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  gone: boolean;
  current: boolean;
  date: number;
  subject: string;
}

export interface Stash {
  ref: string;
  sha: string;
  date: number;
  message: string;
}

export interface Comparison {
  base: string;
  head: string;
  mergeBase: string;
  commits: Commit[];
  files: FileChange[];
}

/** A pull request in a list, as gh gives it. */
export interface PullSummary {
  number: number;
  title: string;
  author?: { login: string };
  headRefName: string;
  baseRefName: string;
  isDraft: boolean;
  state: string;
  updatedAt: string;
  url: string;
  reviewDecision?: string;
  additions?: number;
  deletions?: number;
}

export interface Check {
  name?: string;
  context?: string;
  status?: string;
  conclusion?: string;
  state?: string;
  detailsUrl?: string;
  targetUrl?: string;
}

export interface PullDetail extends PullSummary {
  body: string;
  /** Whether its branch is in another repository, a fork: then `headRefName` is a name there, not here. */
  isCrossRepository?: boolean;
  headRepositoryOwner?: { login: string };
  mergeable?: string;
  mergeStateStatus?: string;
  statusCheckRollup?: Check[];
  changedFiles?: number;
  files?: { path: string; additions: number; deletions: number }[];
  commits?: { oid: string; messageHeadline: string; authors?: { login?: string; name?: string }[] }[];
  comments?: { author?: { login: string }; body: string; createdAt: string }[];
  reviews?: { author?: { login: string }; body: string; state: string; submittedAt: string }[];
  createdAt?: string;
}

export interface Diff {
  diff: string;
  truncated: boolean;
}

export type DiffOf =
  | { of: "unstaged" | "staged"; path: string; from?: string }
  | { of: "untracked"; path: string }
  | { of: "commit"; sha: string; path?: string; from?: string }
  | { of: "range"; base: string; path?: string; from?: string }
  | { of: "stash"; stash: string };

/** Which repository: the chat's, and the clone in its folder that is meant ("" for the one the folder is in). */
export interface GitTarget {
  session: string;
  repo: string;
}

/** A repository the chat's folder has, as the server found it. */
export interface RepoChoice {
  /** From the chat's folder; "" for the repository the folder itself is in. */
  path: string;
  name: string;
}

const query = (params: Record<string, string | number | undefined>) =>
  Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join("&");
/** The URL of `rest` for a repository, with what it is asked in `params`. */
const at = (t: GitTarget, rest = "", params: Record<string, string | number | undefined> = {}) => {
  const q = query({ ...params, repo: t.repo });
  return portal.api.url(`/chats/${encodeURIComponent(t.session)}${rest}${q ? `?${q}` : ""}`);
};
const post = <T = { ok: true }>(url: string, body: unknown = {}) => json<T>(url, { method: "POST", body: JSON.stringify(body) });

export const gitApi = {
  /** The repositories in the chat's folder: the one around it, and the clones below. */
  repos: (session: string) => json<{ repos: RepoChoice[]; truncated: boolean }>(at({ session, repo: "" }, "/repos")),
  state: (id: GitTarget) => json<GitState>(at(id)),
  init: (id: GitTarget) => post(at(id, "/init")),
  /** Asked apart from the state: it asks GitHub, and the state is what is on this disk. */
  gh: (id: GitTarget, fresh = false) => json<GhState>(at(id, "/gh", { fresh: fresh ? 1 : undefined })),
  diff: (id: GitTarget, what: DiffOf) => json<Diff>(at(id, "/diff", what as Record<string, string>)),
  stage: (id: GitTarget, paths: string[] | "all") => post(at(id, "/stage"), paths === "all" ? { all: true } : { paths }),
  unstage: (id: GitTarget, paths: string[] | "all") => post(at(id, "/unstage"), paths === "all" ? { all: true } : { paths }),
  discard: (id: GitTarget, paths: string[]) => post(at(id, "/discard"), { paths }),
  commit: (id: GitTarget, message: string, amend = false) => post<{ sha: string }>(at(id, "/commit"), { message, amend }),
  abort: (id: GitTarget) => post(at(id, "/abort")),
  continue: (id: GitTarget) => post(at(id, "/continue")),
  log: (id: GitTarget, opts: { ref?: string; skip?: number; limit?: number; path?: string } = {}) => json<{ commits: Commit[] }>(at(id, "/log", opts)),
  commitDetail: (id: GitTarget, sha: string) => json<CommitDetail>(at(id, `/commits/${encodeURIComponent(sha)}`)),
  branches: (id: GitTarget) => json<{ branches: Branch[] }>(at(id, "/branches")),
  switch: (id: GitTarget, name: string, remote = false) => post(at(id, "/switch"), { name, remote }),
  createBranch: (id: GitTarget, name: string, from?: string) => post(at(id, "/branches"), { name, from }),
  deleteBranch: (id: GitTarget, name: string, force = false) => post(at(id, "/branches/delete"), { name, force }),
  fetch: (id: GitTarget) => post<{ said: string }>(at(id, "/fetch")),
  pull: (id: GitTarget) => post<{ said: string }>(at(id, "/pull")),
  push: (id: GitTarget) => post<{ said: string }>(at(id, "/push")),
  stashes: (id: GitTarget) => json<{ stashes: Stash[] }>(at(id, "/stashes")),
  stash: (id: GitTarget, message?: string) => post(at(id, "/stashes"), { message }),
  /** `sha` is the stash meant: nothing is done when `ref` has come to be another. */
  stashDo: (id: GitTarget, action: "apply" | "pop" | "drop", ref: string, sha: string) => post(at(id, `/stashes/${action}`), { ref, sha }),
  compare: (id: GitTarget, baseRef?: string) => json<{ comparison: Comparison | null }>(at(id, "/compare", { base: baseRef })),
  pulls: (id: GitTarget, state = "open") => json<{ pulls: PullSummary[] }>(at(id, "/pulls", { state })),
  currentPull: (id: GitTarget) => json<{ pull: PullDetail | null }>(at(id, "/pulls/current")),
  pullDetail: (id: GitTarget, n: number) => json<{ pull: PullDetail }>(at(id, `/pulls/${n}`)),
  pullDiff: (id: GitTarget, n: number) => json<Diff>(at(id, `/pulls/${n}/diff`)),
  createPull: (id: GitTarget, opts: { title: string; body: string; base?: string; draft?: boolean }) => post<{ url: string }>(at(id, "/pulls"), opts),
  checkoutPull: (id: GitTarget, n: number) => post(at(id, `/pulls/${n}/checkout`)),
  mergePull: (id: GitTarget, n: number, method: "merge" | "squash" | "rebase", deleteBranch: boolean) =>
    post<{ said: string }>(at(id, `/pulls/${n}/merge`), { method, deleteBranch }),
  commentPull: (id: GitTarget, n: number, body: string) => post(at(id, `/pulls/${n}/comment`), { body }),
  reviewPull: (id: GitTarget, n: number, action: "approve" | "request-changes" | "comment", body: string) =>
    post(at(id, `/pulls/${n}/review`), { action, body }),
};
