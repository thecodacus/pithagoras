import { createContext, useContext } from "react";
import type { DiffOf, GhState, GitState, GitTarget } from "../git-api";
import type { DiffFile } from "../git-diff";

/** What is running now: `act`'s label and what it names. */
export type Busy = { label: string; vars?: Record<string, string | number> };
/** The repository, and what gh says about it — null while GitHub has not answered. */
export type Repo = Extract<GitState, { repo: true }> & { gh: GhState | null };

/** What the panel shows over its tab, one on top of another: Back goes to the one below. */
export type View =
  | { kind: "diff"; title: string; what: DiffOf; path: string }
  /** A file out of a diff already loaded — a pull request's, which comes whole. */
  | { kind: "parsed"; title: string; file: DiffFile; truncated?: boolean }
  | { kind: "commit"; sha: string }
  | { kind: "compare"; base?: string }
  | { kind: "pull"; n: number };

export interface GitCtx {
  /** The chat and the repository in its folder: what every call of gitApi is made for. */
  id: GitTarget;
  repo: Repo;
  /**
   * Do something to the repository: one thing at a time, named while it runs,
   * what it failed with shown, and the state read again after. True when it
   * worked. `label` is the English, marked with msg(), and `vars` what it
   * names: translated where it is shown, so a check on what is running
   * (`busy?.label === "Refreshing"`) holds in every language.
   */
  act: (label: string, step: () => Promise<unknown>, vars?: Record<string, string | number>) => Promise<boolean>;
  busy: Busy | null;
  show: (view: View) => void;
  /** Open a file (by its path in the repository) in the Files panel. Only one in the chat's folder: see inFolder. */
  openFile?: (path: string) => void;
  /** Whether a file of the repository is in the chat's folder, which is all Files shows. */
  inFolder: (path: string) => boolean;
}

export const Ctx = createContext<GitCtx | null>(null);

export function useGit(): GitCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useGit outside the Git panel");
  return ctx;
}
