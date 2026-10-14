import { spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GIT_CONFIG, environment } from "./git.js";
import { oneAtATime } from "./one-at-a-time.js";
import type { Artifacts } from "./update-files.js";

/**
 * Updating the portal from its own checkout: Settings → About pulls the newest `main`, builds it and restarts.
 *
 * Everything that runs a program goes through `Exec`, so that a test hands in a git and a build of its own and
 * nothing is pulled, built or restarted. Nothing here ever resets, forces or discards: a checkout that is not
 * clean, or cannot move straight to `origin/main`, is left as it is and the reason is told.
 */

/**
 * Where an update can be done: from a git checkout. Not from a container's image, nor from source files that a file
 * watcher runs (`npm run dev:server`), which it would restart in the middle of the update; and not from anything else.
 */
export type Kind = "git" | "container" | "dev" | "none";

export const STEPS = ["fetch", "merge", "install", "build", "restart"] as const;
export type Step = (typeof STEPS)[number];

export interface Commit {
  sha: string;
  subject: string;
  /** When it was committed, ISO. */
  date: string;
}

export interface Ran {
  code: number | null;
  stdout: string;
  /** Everything it printed, stdout and stderr in the order they came, cut to its last part. */
  output: string;
}

export interface ExecOptions {
  timeoutMs?: number;
  /** Changes the checkout (a merge can run hooks and takes the index lock), where the rest only looks. */
  writes?: boolean;
}

/** Runs `git` or `npm` in the portal's folder. */
export type Exec = (command: "git" | "npm", args: string[], options?: ExecOptions) => Promise<Ran>;

/** Said to the caller with an HTTP status, and a code the page words in its own language. */
export class UpdateError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export type ProblemCode = "fetch" | "detached" | "dirty" | "diverged" | "restart";

export interface Inspection {
  branch: string | null;
  current: Commit;
  /** `origin/main`, as the last fetch left it. */
  target: Commit | null;
  /** Commits `origin/main` has that this checkout lacks. */
  behind: number;
  /** Commits this checkout has that `origin/main` lacks. */
  ahead: number;
  /** Files with changes to tracked files; what git ignores and what it does not track are no reason to stop. */
  changed: number;
  /** The build in place was made from another commit than the checked out one: Update builds again, merge or none. */
  rebuild: boolean;
  /** Why an update cannot be made, if it cannot. */
  problem: { code: ProblemCode; message: string } | null;
  /** Chats and runs going right now, which the restart stops. */
  running: number;
}

export interface Notice {
  /** New commits on `origin/main`. */
  count: number;
  target: Commit;
  /** When it was first seen for this target. */
  since: string;
}

export type StepState = "pending" | "running" | "done" | "skipped" | "failed";

export interface RunView {
  state: "running" | "restarting" | "failed";
  steps: { id: Step; state: StepState }[];
  from: Commit;
  to: Commit;
  startedAt: string;
  failed?: {
    step: Step;
    message: string;
    output: string;
    /** The old node_modules and builds are in place: nothing was put aside, or what was has been put back. */
    oldFilesBack: boolean;
  };
}

export interface UpdateStatus {
  kind: Kind;
  branch?: string | null;
  current?: Commit;
  notice?: Notice | null;
  /** When origin/main was last asked, and whether that worked. */
  checkedAt?: string | null;
  /** The build in place was made from another commit than the checked out one (a build failed after the merge): Update builds again. */
  rebuild?: boolean;
  run?: RunView | null;
}

export interface UpdateDeps {
  /** The install's folder. */
  root: string;
  exec: Exec;
  /** Chats and runs going right now. */
  running: () => number;
  /** The files a build is made of: put aside while a step works on them, and put back when it fails. */
  artifacts: Artifacts;
  /** Stops this portal and starts the new one. Throws, with nothing stopped, when it cannot. */
  restart: () => Promise<void>;
  /** A restart is on its way: an update begun now would be cut off in the middle. */
  restartPending?: () => boolean;
  /** Why the portal would not come back after it stops, if it would not. */
  restartProblem?: () => Promise<string | null>;
  /** A portal in a container is rebuilt with its image. */
  inContainer?: () => boolean;
  /** The portal runs from source files under a watcher, which would restart it halfway through the update. */
  fromSource?: () => boolean;
  /** Told when a target commit is seen that the portal has not told about yet. */
  onRaise?: (notice: Notice) => void;
  now?: () => Date;
}

/** Looking for new commits: at the start and then this often, and when Settings → About opens. */
export const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
const FIRST_CHECK_MS = 5_000;

const FETCH_MS = 120_000;
const MERGE_MS = 60_000;
const INSTALL_MS = 15 * 60_000;
const BUILD_MS = 15 * 60_000;

/** The remote branch an update moves to, named in full so that a clone of one branch only has it too. */
const REMOTE = "refs/remotes/origin/main";

const OUTPUT_KEEP = 16 * 1024;
const OUTPUT_LINES = 30;
const LINE_MAX = 300;

/** The last lines of what a step printed, for the page: where a build says what is wrong. */
export function tail(output: string, lines = OUTPUT_LINES): string {
  return output
    .split("\n")
    .map((l) => l.replace(/\r/g, "").trimEnd())
    .filter(Boolean)
    .slice(-lines)
    .map((l) => (l.length > LINE_MAX ? `${l.slice(0, LINE_MAX)}…` : l))
    .join("\n");
}

/**
 * Whether the portal runs from its source files (`tsx watch src/index.ts`, as `npm run dev:server` has it) or under a
 * watcher of node's own: either one restarts the portal as soon as the update changes a file, with `npm ci` just begun.
 */
export const runsFromSource = (url: string = import.meta.url, execArgv: string[] = process.execArgv): boolean =>
  url.endsWith(".ts") || execArgv.some((a) => a === "--watch" || a === "--watch-path" || a.startsWith("--watch-path="));

/** The install's folder, found as the portal finds its own files: from the compiled (or source) file, two folders up. */
export function installRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

/** A container has its portal in an image; it is rebuilt there, not here. */
export const inContainer = (): boolean => existsSync("/.dockerenv") || existsSync("/run/.containerenv");

/**
 * Runs the command in `root`. git without prompts, an editor or a pager (see git.ts); npm without `NODE_ENV`, which a
 * portal in production carries and which would have `npm ci` leave out the compiler and the bundler the build needs, and
 * without the portal's own password, which nothing in a build has a use for.
 */
export function realExec(root: string): Exec {
  return (command, args, options = {}) =>
    new Promise((resolve) => {
      const env =
        command === "git"
          ? environment(options.writes ?? false)
          : Object.fromEntries(Object.entries(process.env).filter(([name]) => !["NODE_ENV", "PORTAL_PASSWORD", "PORTAL_SECRET"].includes(name)));
      const child = spawn(command, command === "git" ? [...GIT_CONFIG, ...args] : args, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      let output = "";
      let timedOut = false;
      const keep = (chunk: Buffer, own: boolean) => {
        const text = chunk.toString("utf8");
        if (own && out.length < OUTPUT_KEEP * 4) out += text;
        output = (output + text).slice(-OUTPUT_KEEP);
      };
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, options.timeoutMs ?? FETCH_MS);
      child.stdout.on("data", (c: Buffer) => keep(c, true));
      child.stderr.on("data", (c: Buffer) => keep(c, false));
      child.once("error", (e: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        resolve({ code: null, stdout: "", output: e.code === "ENOENT" ? `${command}: command not found` : e.message });
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        resolve({ code: timedOut ? null : code, stdout: out, output: timedOut ? `${output}\n(stopped after ${Math.round((options.timeoutMs ?? FETCH_MS) / 1000)} seconds)` : output });
      });
    });
}

const plural = (n: number, one: string, other: string) => `${n} ${n === 1 ? one : other}`;

export class Updater {
  private detected: Promise<Kind> | undefined;
  /** One look at the remote at a time: two fetches side by side would take each other's lock. */
  private readonly serial = oneAtATime();
  /** An update is being started or is running: a second press is refused. */
  private busy = false;
  private run: RunView | null = null;
  private head: { branch: string | null; current: Commit } | undefined;
  private notice: Notice | null = null;
  private checkedAt: string | null = null;
  /** The target the portal has told about last. */
  private raised: string | undefined;
  /** The old files have been, or are being, thrown away: the new build is the one in place, whatever happens next. */
  private discarded = false;

  constructor(private readonly deps: UpdateDeps) {}

  private now = (): Date => (this.deps.now ?? (() => new Date()))();

  /** An update is going on, from its start to its end or its failure; the restart waits for it. */
  get working(): boolean {
    return this.busy;
  }

  kind(): Promise<Kind> {
    return (this.detected ??= this.detect());
  }

  private async detect(): Promise<Kind> {
    if ((this.deps.inContainer ?? inContainer)()) return "container";
    if ((this.deps.fromSource ?? runsFromSource)()) return "dev";
    const { root } = this.deps;
    try {
      const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { name?: string };
      if (pkg.name !== "pithagoras" || !existsSync(path.join(root, "server", "package.json"))) return "none";
    } catch {
      return "none";
    }
    // The folder has to be the top of a repository itself, not a place inside another one.
    const top = await this.deps.exec("git", ["rev-parse", "--show-toplevel"]);
    if (top.code !== 0) return "none";
    try {
      return realpathSync(top.stdout.trim()) === realpathSync(root) ? "git" : "none";
    } catch {
      return "none";
    }
  }

  private async needGit(): Promise<void> {
    const kind = await this.kind();
    if (kind === "dev") throw new UpdateError(404, "unavailable", "This portal runs from its source files under a file watcher, which would restart it halfway through the update. Run the built portal (npm start) to update it from here.");
    if (kind !== "git") throw new UpdateError(404, "unavailable", "This portal does not run from a git checkout, so it cannot update itself.");
  }

  /** The build in place was made from another commit than the one checked out: written down with it, so that a restart keeps it. */
  private async needsBuild(current: Commit): Promise<boolean> {
    const built = await this.deps.artifacts.builtFrom();
    return built !== undefined && built !== current.sha;
  }

  private async git(args: string[], options?: ExecOptions): Promise<Ran> {
    return this.deps.exec("git", args, options);
  }

  private async commit(rev: string): Promise<Commit | null> {
    const r = await this.git(["log", "-1", "--format=%H%x1f%s%x1f%cI", rev, "--"]);
    if (r.code !== 0) return null;
    const [sha, subject, date] = r.stdout.trim().split("\x1f");
    return sha ? { sha, subject: subject ?? "", date: date ?? "" } : null;
  }

  private async readHead(): Promise<{ branch: string | null; current: Commit }> {
    const branch = await this.git(["symbolic-ref", "--quiet", "--short", "HEAD"]);
    const current = await this.commit("HEAD");
    if (!current) throw new UpdateError(500, "git", "The checkout's current commit could not be read.");
    return (this.head = { branch: branch.code === 0 ? branch.stdout.trim() || null : null, current });
  }

  /**
   * What the checkout and `origin/main` look like. `fetch` asks the remote first; a fetch that fails is a problem
   * to tell, not an error to throw, since the numbers from the last one are still there to read.
   */
  private async look(fetch: boolean): Promise<Inspection> {
    const { branch, current } = await this.readHead();
    const status = await this.git(["status", "--porcelain", "--untracked-files=no"]);
    if (status.code !== 0) throw new UpdateError(500, "git", `git status failed: ${tail(status.output, 3)}`);
    const changed = status.stdout.split("\n").filter(Boolean).length;

    let fetchError: string | null = null;
    if (fetch) {
      const f = await this.git(["fetch", "origin", `+refs/heads/main:${REMOTE}`], { timeoutMs: FETCH_MS, writes: true });
      if (f.code !== 0) fetchError = tail(f.output, 3) || "git fetch failed";
    }
    const target = await this.commit(REMOTE);
    let ahead = 0;
    let behind = 0;
    if (target) {
      const counts = await this.git(["rev-list", "--left-right", "--count", `HEAD...${REMOTE}`]);
      if (counts.code === 0) [ahead, behind] = counts.stdout.trim().split(/\s+/).map(Number);
    }

    let problem: Inspection["problem"] = null;
    if (fetchError) problem = { code: "fetch", message: `Could not fetch origin/main: ${fetchError}` };
    else if (!target) problem = { code: "fetch", message: "origin/main is not known here: fetch it first." };
    else if (!branch) problem = { code: "detached", message: "The checkout is not on a branch. Check out a branch on the host first." };
    else if (changed > 0) problem = { code: "dirty", message: `The checkout has local changes (${plural(changed, "file", "files")}). Commit or discard them on the host first.` };
    else if (ahead > 0 && behind > 0) {
      problem = { code: "diverged", message: `The checkout has ${plural(ahead, "commit", "commits")} that origin/main lacks and origin/main has ${plural(behind, "new commit", "new commits")}, so it cannot move straight to it. Rebase or merge on the host first.` };
    } else {
      const restart = await this.deps.restartProblem?.();
      if (restart) problem = { code: "restart", message: restart };
    }

    const seen: Inspection = { branch, current, target, behind, ahead, changed, rebuild: await this.needsBuild(current), problem, running: this.deps.running() };
    if (!fetchError) {
      this.checkedAt = this.now().toISOString();
      this.noteTarget(seen);
    }
    return seen;
  }

  /** The notice follows what was seen: a new target is told about once, however often it is looked at again. */
  private noteTarget(seen: Inspection): void {
    if (!seen.target || seen.behind === 0) {
      this.notice = null;
      return;
    }
    const same = this.notice && this.notice.target.sha === seen.target.sha;
    this.notice = { count: seen.behind, target: seen.target, since: same ? this.notice!.since : this.now().toISOString() };
    if (this.raised !== seen.target.sha) {
      this.raised = seen.target.sha;
      this.deps.onRaise?.(this.notice);
    }
  }

  /** What Settings and the notice show: from memory, the remote is not asked. */
  async status(): Promise<UpdateStatus> {
    const kind = await this.kind();
    if (kind !== "git") return { kind };
    const head = this.head ?? (await this.readHead());
    return { kind, branch: head.branch, current: head.current, notice: this.notice, checkedAt: this.checkedAt, rebuild: await this.needsBuild(head.current), run: this.run };
  }

  /** Asks the remote what is new, for the page that is about to ask whether to update. */
  async check(): Promise<Inspection> {
    await this.needGit();
    // Not while an update is changing the checkout: what it reads then is half-way.
    return this.serial(() => this.look(!this.busy));
  }

  /** The same for the schedule: a failure is logged and tried again at the next time, and says nothing to anyone. */
  async refresh(): Promise<void> {
    try {
      if ((await this.kind()) !== "git" || this.busy) return;
      const seen = await this.serial(() => this.look(true));
      if (seen.problem?.code === "fetch") console.warn(`[update] could not check origin/main: ${seen.problem.message}`);
    } catch (e) {
      console.warn(`[update] could not check origin/main: ${(e as Error).message}`);
    }
  }

  /** Checks at the start and every six hours, quietly. Returns what stops it. */
  async begin(every = CHECK_EVERY_MS, first = FIRST_CHECK_MS): Promise<() => void> {
    if ((await this.kind()) !== "git") return () => {};
    const timers = [setTimeout(() => void this.refresh(), first), setInterval(() => void this.refresh(), every)];
    for (const t of timers) t.unref();
    return () => timers.forEach((t) => (clearTimeout(t), clearInterval(t)));
  }

  /**
   * Begins an update, if it may: answers once the checks are made and the steps are on their way, and refuses with
   * the reason when they are not. `expect` is the commit the person was shown, and is required: the confirmation is
   * the server's to ask for, not only the page's. A remote that has moved on since is a new question, not a thing
   * to do unasked.
   */
  async start(expect: string): Promise<RunView> {
    await this.needGit();
    if (typeof expect !== "string" || !expect) throw new UpdateError(400, "invalid", "The commit that was confirmed is needed: send it as expect.");
    if (this.deps.restartPending?.()) throw new UpdateError(409, "restarting", "The portal is restarting.");
    // Taken before the first wait, or two presses side by side would both pass.
    if (this.busy) throw new UpdateError(409, "busy", "An update is already running.");
    this.busy = true;
    let seen: Inspection;
    try {
      seen = await this.serial(() => this.look(true));
      if (seen.problem) throw new UpdateError(409, seen.problem.code, seen.problem.message);
      const target = seen.target!;
      if (expect !== target.sha) throw new UpdateError(409, "moved", "origin/main has moved on since it was looked at. Check again.");
      if (seen.behind === 0 && !seen.rebuild) throw new UpdateError(409, "current", "Already up to date.");
    } catch (e) {
      this.busy = false;
      throw e;
    }
    const run: RunView = {
      state: "running",
      steps: STEPS.map((id) => ({ id, state: "pending" })),
      from: seen.current,
      to: seen.target!,
      startedAt: this.now().toISOString(),
    };
    this.run = run;
    // Behind: there is something to merge, a failed build before it or not. Not behind: the build is what is left.
    void this.execute(run, seen.behind > 0);
    return run;
  }

  private mark(run: RunView, id: Step, state: StepState): void {
    run.steps.find((s) => s.id === id)!.state = state;
  }

  /** Says where it failed, puts the old files back, and only then lets another update begin. */
  private async fail(run: RunView, step: Step, message: string, output: string): Promise<void> {
    const failed = { step, message, output: tail(output), oldFilesBack: false };
    console.error(`[update] failed at ${step}: ${message}${failed.output ? `\n${failed.output}` : ""}`);
    try {
      await this.deps.artifacts.restore();
      // Back where they were put aside, or never put aside: not once they have been thrown away for the new build.
      failed.oldFilesBack = !this.discarded;
    } catch (e) {
      console.error(`[update] the old files could not be put back: ${(e as Error).message}`);
      failed.message += `. The old files could not be put back: ${(e as Error).message}`;
    }
    // Said only now: a page that is told the update failed finds the old files where it says they are.
    this.mark(run, step, "failed");
    run.failed = failed;
    run.state = "failed";
    this.busy = false;
  }

  /** One program as a step; false when it failed, and the run says where. */
  private async step(run: RunView, id: Step, label: string, command: "git" | "npm", args: string[], timeoutMs: number): Promise<boolean> {
    this.mark(run, id, "running");
    console.log(`[update] ${label}`);
    const r = await this.deps.exec(command, args, { timeoutMs, writes: true });
    if (r.code !== 0) {
      await this.fail(run, id, `${label} failed${r.code === null ? "" : ` (exit ${r.code})`}`, r.output);
      return false;
    }
    this.mark(run, id, "done");
    return true;
  }

  private async execute(run: RunView, merge: boolean): Promise<void> {
    const files = this.deps.artifacts;
    let at: Step = "fetch";
    this.discarded = false;
    try {
      console.log(`[update] ${run.from.sha.slice(0, 7)} -> ${run.to.sha.slice(0, 7)}`);
      this.mark(run, "fetch", "done");
      // The build in place is of the commit that is checked out now, unless a record that is still true says
      // otherwise: what a failure after the merge leaves behind is told from this.
      await files.markBuilt(run.from.sha, true);
      if (!merge) this.mark(run, "merge", "skipped");
      else {
        at = "merge";
        // Only moves forward: where it cannot, git stops without changing a file.
        if (!(await this.step(run, "merge", "git merge --ff-only origin/main", "git", ["merge", "--ff-only", REMOTE], MERGE_MS))) return;
        // What was new is in; the notice goes with it.
        this.notice = null;
        await this.readHead();
      }
      at = "install";
      await files.keepModules();
      if (!(await this.step(run, "install", "npm ci", "npm", ["ci", "--prefer-offline", "--no-audit", "--no-fund"], INSTALL_MS))) return;
      at = "build";
      await files.keepBuild();
      if (!(await this.step(run, "build", "npm run build", "npm", ["run", "build"], BUILD_MS))) return;
      await files.markBuilt((await this.readHead()).current.sha);
      // From here on the new files are the ones in place: what fails after this does not find the old ones.
      this.discarded = true;
      await files.discard();
      at = "restart";
      this.mark(run, "restart", "running");
      run.state = "restarting";
      console.log("[update] restarting");
      await this.deps.restart();
    } catch (e) {
      await this.fail(run, at, (e as Error).message, "");
    }
  }
}
