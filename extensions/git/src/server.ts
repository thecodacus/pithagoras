import { statSync } from "node:fs";
import type { Request, Response } from "express";
import type { ServerPortal } from "@pithagoras/extension-api/server";
import * as g from "./git";

/**
 * The Git panel's server half: the repository a chat's folder is in, and
 * GitHub through gh, at /api/x/pithagoras-git/chats/<chat>/….
 *
 * Keyed by chat, like the Files panel, and for the same reason: "the folder
 * this chat works in" is what is the same for a chat in a project, in the
 * workspace root, or in Home. What git does is in git.ts, run by the portal's
 * own runner; this turns a chat into its repository and a refusal into a
 * status.
 *
 * A folder can hold repositories of its own (a project with a clone in it), so
 * every route takes `?repo=<path from the chat's folder>` to work in one of
 * those; without it, it is the repository the folder itself is in.
 */

/** A chat, or a folder in it, that is not there: what the portal said of it, as a 404. */
class Missing extends Error {}

function fail(res: Response, e: unknown) {
  if (g.isGitError(e)) return res.status(e.status).json({ error: e.message });
  if (e instanceof Missing) return res.status(404).json({ error: e.message });
  console.error("[pithagoras-git]", e);
  res.status(500).json({ error: "Git could not do that" });
}

const flag = (v: unknown) => v === true || v === "1" || v === "true";

export default function git(portal: ServerPortal) {
  g.useGit(portal.git.at);
  const router = portal.router;
  // As the portal's own routes took them: a pull request's body can be long.
  const json = portal.http.json({ limit: "2mb" });

  /** The chat's folder, on this disk; a chat or a folder that is gone is a Missing. */
  const chatFolder = (id: string) => {
    try {
      return portal.chats.folder(id);
    } catch (e) {
      throw new Missing((e as Error).message || "Not found");
    }
  };


  /** The chat's folder, or the clone in it that `?repo=` names; answered for when there is none. */
  const folderOf = async (req: Request, res: Response): Promise<string | undefined> => {
    try {
      const base = chatFolder(String(req.params.id));
      const rel = typeof req.query.repo === "string" ? req.query.repo : "";
      if (!rel) return base;
      let dir: string;
      try {
        dir = portal.files.inside(base, rel);
      } catch {
        throw new Missing("There is no such repository in this chat's folder");
      }
      if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) throw new Missing("There is no such repository in this chat's folder");
      // A folder git works around (an empty .git, a plain folder in the repository around it) is not a repository
      // of its own: acting on it would act on the one around.
      if (!(await g.isRepoRoot(dir))) throw new Missing("There is no such repository in this chat's folder");
      return dir;
    } catch (e) {
      fail(res, e);
      return undefined;
    }
  };

  /** The repository the chat's folder is in; answered for when it is in none. */
  const repoOf = async (req: Request, res: Response): Promise<g.Repo | undefined> => {
    const folder = await folderOf(req, res);
    if (!folder) return undefined;
    const repo = await g.findRepo(folder);
    if (!repo) {
      res.status(404).json({ error: "This chat's folder is not in a git repository" });
      return undefined;
    }
    return repo;
  };

  /** A route that needs the repository: `step` gets it, and whatever it throws is answered. */
  const withRepo = (step: (repo: g.Repo, req: Request) => Promise<unknown>) => async (req: Request, res: Response) => {
    try {
      const repo = await repoOf(req, res);
      if (!repo) return;
      const answer = await step(repo, req);
      res.json(answer ?? { ok: true });
    } catch (e) {
      fail(res, e);
    }
  };

  /** The repositories in the chat's folder: the one around it and the clones below it. */
  router.get("/chats/:id/repos", async (req, res) => {
    try {
      res.json(await g.findRepos(chatFolder(String(req.params.id))));
    } catch (e) {
      fail(res, e);
    }
  });

  /**
   * Where things stand: whether there is a repository at all, and if so its
   * branch and what changed. No repository is an answer here, not an error:
   * the panel offers to make one.
   *
   * Not whether gh can be had: that asks GitHub, and a slow network held every
   * refresh of what is on this disk behind it. The panel asks /gh apart.
   */
  router.get("/chats/:id", async (req, res) => {
    try {
      const folder = await folderOf(req, res);
      if (!folder) return;
      const repo = await g.findRepo(folder);
      if (!repo) return res.json({ repo: false, folder });
      res.json({ repo: true, root: repo.root, prefix: repo.prefix, ...(await g.status(repo)) });
    } catch (e) {
      fail(res, e);
    }
  });

  /** Whether pull requests can be had here through gh, and for which repository on GitHub. */
  router.get("/chats/:id/gh", withRepo((repo, req) => g.ghState(repo, flag(req.query.fresh))));

  router.post("/chats/:id/init", json, async (req, res) => {
    try {
      const folder = await folderOf(req, res);
      if (!folder) return;
      if (await g.findRepo(folder)) return res.status(409).json({ error: "This folder is already in a repository" });
      await g.initRepo(folder);
      res.json({ ok: true });
    } catch (e) {
      fail(res, e);
    }
  });

  router.get("/chats/:id/diff",
    withRepo((repo, req) => {
      const q = req.query as Record<string, string | undefined>;
      const of = q.of;
      if (of === "unstaged" || of === "staged") return g.diff(repo, { of, path: q.path ?? "", from: q.from });
      if (of === "untracked") return g.diff(repo, { of, path: q.path ?? "" });
      if (of === "commit") return g.diff(repo, { of, sha: q.sha ?? "", path: q.path, from: q.from });
      if (of === "range") return g.diff(repo, { of, base: q.base ?? "", path: q.path, from: q.from });
      if (of === "stash") return g.diff(repo, { of, stash: q.stash ?? "" });
      throw new g.GitError(400, "A diff of what?");
    }),
  );

  router.post("/chats/:id/stage", json, withRepo((repo, req) => g.stage(repo, req.body?.paths, flag(req.body?.all))));
  router.post("/chats/:id/unstage", json, withRepo((repo, req) => g.unstage(repo, req.body?.paths, flag(req.body?.all))));
  router.post("/chats/:id/discard", json, withRepo((repo, req) => g.discard(repo, req.body?.paths)));
  router.post("/chats/:id/commit", json, withRepo((repo, req) => g.commit(repo, req.body?.message, flag(req.body?.amend))));
  router.post("/chats/:id/abort", json, withRepo((repo) => g.abortOperation(repo)));
  router.post("/chats/:id/continue", json, withRepo((repo) => g.continueOperation(repo)));

  router.get("/chats/:id/log",
    withRepo(async (repo, req) => ({
      commits: await g.log(repo, {
        ref: req.query.ref || undefined,
        skip: Number(req.query.skip) || 0,
        limit: Number(req.query.limit) || 100,
        path: req.query.path || undefined,
      }),
    })),
  );
  router.get("/chats/:id/commits/:sha", withRepo((repo, req) => g.commitDetail(repo, req.params.sha)));

  router.get("/chats/:id/branches", withRepo(async (repo) => ({ branches: await g.branches(repo) })));
  router.post("/chats/:id/switch", json, withRepo((repo, req) => g.switchBranch(repo, req.body?.name, flag(req.body?.remote))));
  router.post("/chats/:id/branches", json, withRepo((repo, req) => g.createBranch(repo, req.body?.name, req.body?.from || undefined)));
  router.post("/chats/:id/branches/delete", json, withRepo((repo, req) => g.deleteBranch(repo, req.body?.name, flag(req.body?.force))));

  router.post("/chats/:id/fetch", json, withRepo(async (repo) => ({ said: await g.fetch(repo) })));
  router.post("/chats/:id/pull", json, withRepo(async (repo) => ({ said: await g.pull(repo) })));
  router.post("/chats/:id/push", json, withRepo(async (repo) => ({ said: await g.push(repo) })));

  router.get("/chats/:id/stashes", withRepo(async (repo) => ({ stashes: await g.stashes(repo) })));
  router.post("/chats/:id/stashes", json, withRepo((repo, req) => g.stashPush(repo, req.body?.message)));
  router.post("/chats/:id/stashes/:action", json,
    withRepo((repo, req) => {
      const action = req.params.action;
      if (action !== "apply" && action !== "pop" && action !== "drop") throw new g.GitError(400, "Apply, pop or drop");
      return g.stashDo(repo, action, req.body?.ref, req.body?.sha);
    }),
  );

  router.get("/chats/:id/compare", withRepo(async (repo, req) => ({ comparison: await g.compare(repo, req.query.base || undefined) })));

  router.get("/chats/:id/pulls", withRepo(async (repo, req) => ({ pulls: await g.pulls(repo, req.query.state) })));
  router.get("/chats/:id/pulls/current", withRepo(async (repo) => ({ pull: await g.pullRequest(repo) })));
  router.get("/chats/:id/pulls/:n", withRepo(async (repo, req) => ({ pull: await g.pullRequest(repo, req.params.n) })));
  router.get("/chats/:id/pulls/:n/diff", withRepo((repo, req) => g.pullDiff(repo, req.params.n)));
  router.post("/chats/:id/pulls", json,
    withRepo((repo, req) => g.createPull(repo, { title: req.body?.title, body: req.body?.body, base: req.body?.base || undefined, draft: flag(req.body?.draft) })),
  );
  router.post("/chats/:id/pulls/:n/checkout", json, withRepo((repo, req) => g.checkoutPull(repo, req.params.n)));
  router.post("/chats/:id/pulls/:n/merge", json,
    withRepo(async (repo, req) => ({ said: await g.mergePull(repo, req.params.n, req.body?.method, flag(req.body?.deleteBranch)) })),
  );
  router.post("/chats/:id/pulls/:n/comment", json, withRepo((repo, req) => g.commentPull(repo, req.params.n, req.body?.body)));
  router.post("/chats/:id/pulls/:n/review", json, withRepo((repo, req) => g.reviewPull(repo, req.params.n, req.body?.action, req.body?.body)));
}
