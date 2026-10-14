import { readFile, readdir, readlink, open } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fieldsOf, signalSession, statOf } from "./proc-stat.js";
import { within } from "./paths.js";
import { realPath } from "./within.js";
import { EXECUTOR_KIND } from "./executor-kind.js";

/**
 * What the agent left running in a workspace: background shells, servers,
 * watchers, the jobs an extension started — whatever started them.
 *
 * Nothing here knows an extension. A process counts when the portal started
 * it (it carries MARKER in its environment, which survives it being detached
 * and reparented) and its working directory is in the workspace. Processes
 * are grouped by Unix session: pi starts each command in one of its own, so a
 * session is a job — `npm run dev &` and the node processes under it are one
 * entry. The person's own shells from the terminal panel carry no MARKER, and
 * are not found.
 *
 * Linux only, and only for the host executor: a container's processes are
 * not in this /proc with paths that mean anything here.
 */
export const MARKER = "PITHAGORAS_AGENT=1";

/** Whether this portal can see the agent's processes at all: not a container's, and not off Linux. */
export const BACKGROUND_SUPPORTED = EXECUTOR_KIND !== "container" && process.platform === "linux";

export interface BackgroundJob {
  /**
   * Stable for the life of the job: the session id and when its first leader
   * started, kept when that leader exits and the rest of the job goes on.
   */
  key: string;
  sid: number;
  pids: number[];
  command: string;
  startedAt: number;
  state: "running" | "stopped" | "exited";
  exitedAt?: number;
  /** Whether its output goes to a file that can be followed. */
  hasOutput: boolean;
  /** A tool call pi is running, which the chat shows as it goes: see toolCall. */
  attached: boolean;
}

interface Tracked extends BackgroundJob {
  workspace: string;
  output?: string;
}

/**
 * By workspace, then key. One job can be in two workspaces, one inside the
 * other; kept once, each chat's look moved it to its own, and the other's
 * Stop and output found it gone.
 */
const tracked = new Map<string, Map<string, Tracked>>();
function jobsIn(root: string): Map<string, Tracked> {
  let jobs = tracked.get(root);
  if (!jobs) tracked.set(root, (jobs = new Map()));
  return jobs;
}
/** How long a finished job stays listed. */
const KEEP_EXITED_MS = 30 * 60_000;

let bootMs: number | undefined;
function bootTime(): number {
  if (bootMs === undefined) {
    try {
      const line = readFileSync("/proc/stat", "utf8").split("\n").find((l) => l.startsWith("btime "));
      bootMs = Number(line?.split(/\s+/)[1] ?? 0) * 1000;
    } catch {
      bootMs = 0;
    }
  }
  return bootMs;
}
/** Clock ticks per second; 100 on every Linux the portal runs on. */
const HZ = 100;

/** /proc/uptime in ms: the time since boot, on the clock that counts the time the host slept. */
function uptimeMs(): number | undefined {
  try {
    const ms = Number(readFileSync("/proc/uptime", "utf8").split(" ")[0]) * 1000;
    return Number.isFinite(ms) ? ms : undefined;
  } catch {
    return undefined;
  }
}

/**
 * How far /proc/uptime is from the clock the start times are on. Nothing on a
 * host, but a container that is given an uptime of its own is off by how long its
 * host ran before it began. Read once, as the portal starts, before a sleep can
 * come between the two clocks.
 */
const UPTIME_OFFSET_MS = (() => {
  const started = Number(statOf(process.pid)?.[19]) * (1000 / HZ);
  const up = uptimeMs();
  return Number.isFinite(started) && up !== undefined ? started + process.uptime() * 1000 - up : undefined;
})();

/**
 * When a job began, as `Date.now()` counts: how long ago it did, read off the
 * kernel's clock that the start times are on. That one counts the time the host
 * slept, and `process.uptime()` does not: after a night's sleep every job lay that
 * much after the call that started it. `startedAt` goes through the boot time
 * /proc reports, which cancels out here.
 */
export function startedWhen(job: BackgroundJob): number {
  const now = uptimeMs();
  if (now === undefined || UPTIME_OFFSET_MS === undefined) return job.startedAt;
  return Date.now() - (now + UPTIME_OFFSET_MS - (job.startedAt - bootTime()));
}

/**
 * A workspace as /proc names a process's folder: its real path. As written, a
 * workspace reached through a link never matched, and nothing ever ran there.
 */
function rootOf(workspace: string): string {
  const resolved = path.resolve(workspace);
  return realPath(resolved) ?? resolved;
}

/**
 * The portal's own Unix session. Everything it starts carries MARKER, its
 * terminal wrapper and an extension's subagents too; left in, they were one
 * job, and stopping it signalled them all. The agent's commands run in
 * sessions of their own.
 */
let ownSid: number | undefined;
function portalSession(): number {
  ownSid ??= Number(statOf(process.pid)?.[3] ?? -1);
  return ownSid;
}

async function fileTarget(pid: number, fd: number): Promise<string | undefined> {
  try {
    const target = await readlink(`/proc/${pid}/fd/${fd}`);
    return target.startsWith("/") && !target.startsWith("/dev/") && !target.endsWith(" (deleted)") ? target : undefined;
  } catch {
    return undefined;
  }
}

interface Proc {
  pid: number;
  cwd: string;
  ppid: number;
  sid: number;
  state: string;
  start: number;
  argv: string[];
}

/** How many processes are read at once: all of them at once filled the pool every file read waits on. */
const BATCH = 64;

async function walk(roots: string[]): Promise<Proc[]> {
  let names: string[];
  try {
    names = (await readdir("/proc")).filter((n) => /^\d+$/.test(n));
  } catch {
    return [];
  }
  const own = portalSession();
  const found: Proc[] = [];
  const read = async (name: string) => {
    const pid = Number(name);
    if (pid === process.pid) return;
    try {
      const cwd = await readlink(`/proc/${pid}/cwd`);
      if (!roots.some((root) => within(root, cwd))) return;
      const env = await readFile(`/proc/${pid}/environ`, "latin1");
      if (!env.split("\0").includes(MARKER)) return;
      const stat = await readFile(`/proc/${pid}/stat`, "utf8");
      const f = fieldsOf(stat);
      const sid = Number(f[3]);
      if (sid === own) return;
      const argv = (await readFile(`/proc/${pid}/cmdline`, "utf8")).split("\0").filter(Boolean);
      found.push({ pid, cwd, ppid: Number(f[1]), sid, state: f[0], start: Number(f[19]), argv });
    } catch {
      // Gone meanwhile, or not ours to read.
    }
  };
  for (let i = 0; i < names.length; i += BATCH) await Promise.all(names.slice(i, i + BATCH).map(read));
  return found;
}

/**
 * One walk of /proc a second, for every workspace asked about lately, however
 * many pages ask: each open chat asks every few seconds, and a walk per
 * workspace read every process on the host once for each.
 */
const SCAN_TTL_MS = 1000;
/** A workspace no page has asked about for this long is left out of the walk. */
const WATCH_MS = 60_000;
const watched = new Map<string, number>();
let cached: { at: number; roots: Set<string>; procs: Promise<Proc[]> } | undefined;

async function scan(root: string, fresh = false): Promise<Proc[]> {
  const now = Date.now();
  watched.set(root, now);
  for (const [r, at] of watched) if (now - at > WATCH_MS) watched.delete(r);
  if (fresh || !cached || now - cached.at > SCAN_TTL_MS || !cached.roots.has(root)) {
    const roots = new Set(watched.keys());
    cached = { at: now, roots, procs: walk([...roots]) };
  }
  return (await cached.procs).filter((p) => within(root, p.cwd));
}

const SHELL = /(^|\/)(ba|z|da)?sh$/;

/**
 * A command pi is running as a tool call, which the chat already shows: the
 * process pi started — often not a shell any more, which hands itself over to
 * a lone command — still there, its output still going back to pi: the portal,
 * or a subagent's pi in the portal's own session. Only while a call is running
 * in the chat: an extension's server, read through a pipe, looks the same. What
 * a call left running when it ended is a job.
 */
async function toolCall(head: Proc | undefined, callsRunning: boolean): Promise<boolean> {
  if (!callsRunning || !head) return false;
  const out = await readlink(`/proc/${head.pid}/fd/1`).catch(() => "");
  if (!out.startsWith("pipe:") && !out.startsWith("socket:")) return false;
  const parent = head.ppid === process.pid ? portalSession() : Number(statOf(head.ppid)?.[3]);
  return parent === portalSession();
}

/** A shell's `-c` script rather than "bash -c …", which says nothing. */
function describe(argv: string[]): string {
  const at = argv.indexOf("-c");
  if (at >= 0 && at < argv.length - 1 && SHELL.test(argv[0] ?? "")) return argv[at + 1];
  return argv.join(" ");
}

/**
 * The jobs in a workspace, running and recently finished, newest first.
 * `callsRunning`: whether a tool call is running in the chat asking.
 * `fresh`: read the processes now, not as they were up to a second ago.
 */
export async function listJobs(workspace: string, callsRunning = false, fresh = false): Promise<BackgroundJob[]> {
  const root = rootOf(workspace);
  const procs = await scan(root, fresh);
  const groups = new Map<number, Proc[]>();
  for (const p of procs) {
    const list = groups.get(p.sid);
    if (list) list.push(p);
    else groups.set(p.sid, [p]);
  }

  const jobs = jobsIn(root);
  const seen = new Set<string>();
  for (const [sid, members] of groups) {
    const head = members.find((m) => m.pid === sid);
    const leader = head ?? [...members].sort((a, b) => a.start - b.start)[0];
    // The same job when its leader has exited — the shell that started `npm
    // run dev &` — and the rest goes on, whichever of its processes are left:
    // a session's id is not given out again while anything is in it. With its
    // leader still there, only the job that leader started.
    const before = [...jobs.values()].find((j) => j.sid === sid && j.state !== "exited" && (!head || j.key === `${sid}-${head.start}`));
    const key = before?.key ?? `${sid}-${leader.start}`;
    seen.add(key);
    const live = members.filter((m) => m.state !== "Z");
    const prior = jobs.get(key);
    let output = prior?.output;
    if (!output) {
      for (const m of [leader, ...members]) {
        output = (await fileTarget(m.pid, 1)) ?? (await fileTarget(m.pid, 2));
        if (output) break;
      }
    }
    const attached = await toolCall(head, callsRunning);
    jobs.set(key, {
      key,
      sid,
      workspace: root,
      pids: live.map((m) => m.pid),
      command: prior?.command ?? describe(leader.argv),
      startedAt: prior?.startedAt ?? bootTime() + (leader.start / HZ) * 1000,
      state: !live.length ? "exited" : live.every((m) => m.state === "T") ? "stopped" : "running",
      hasOutput: !!output,
      output,
      attached,
    });
  }

  const now = Date.now();
  for (const [key, job] of jobs) {
    if (seen.has(key)) continue;
    if (job.state !== "exited") {
      job.state = "exited";
      job.exitedAt = now;
      job.pids = [];
    } else if (now - (job.exitedAt ?? now) > KEEP_EXITED_MS) jobs.delete(key);
  }

  return [...jobs.values()]
    .sort((a, b) => b.startedAt - a.startedAt)
    .map(({ workspace: _w, output: _o, ...job }) => job);
}

/** The finished jobs are forgotten; the running ones stay. */
export function clearFinished(workspace: string): void {
  const jobs = jobsIn(rootOf(workspace));
  for (const [key, job] of jobs) if (job.state === "exited") jobs.delete(key);
}

/** Output from `from` on, or the last `tail` bytes when `from` is not given. */
export async function readOutput(
  workspace: string,
  key: string,
  from?: number,
  tail = 200_000,
): Promise<{ text: string; from: number; size: number } | undefined> {
  const job = tracked.get(rootOf(workspace))?.get(key);
  if (!job?.output) return undefined;
  const handle = await open(job.output, "r").catch(() => undefined);
  if (!handle) return { text: "", from: 0, size: 0 };
  try {
    const { size } = await handle.stat();
    const start = from === undefined ? Math.max(0, size - tail) : Math.min(Math.max(0, from), size);
    const length = Math.min(size - start, 1_000_000);
    const buf = Buffer.alloc(length);
    if (length) await handle.read(buf, 0, length, start);
    // Cut between characters, not inside one: a tail that began, or a read
    // that ended, halfway through `➜` showed it as garbage. What is left of
    // one at the end is read with the rest of it next time.
    const { skip, keep } = whole(buf);
    return { text: buf.subarray(skip, keep).toString("utf8"), from: start + skip, size: start + keep };
  } finally {
    await handle.close();
  }
}

/** Where the whole characters in `buf` begin and end: past a partial one at the start, before one at the end. */
function whole(buf: Buffer): { skip: number; keep: number } {
  let skip = 0;
  while (skip < Math.min(3, buf.length) && (buf[skip] & 0xc0) === 0x80) skip++;
  let keep = buf.length;
  // The last lead byte, and whether all it needs came after it.
  for (let i = buf.length - 1; i >= Math.max(skip, buf.length - 4); i--) {
    const b = buf[i];
    if ((b & 0xc0) === 0x80) continue;
    const needs = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1;
    if (buf.length - i < needs) keep = i;
    break;
  }
  return { skip, keep };
}

/**
 * Stops a job: a hangup and a terminate to every process in its session, a
 * kill for whatever is still there a moment later. The whole session, not the
 * processes the list found: one that moved out of the workspace, or dropped
 * its environment, is still the job's. Only while the session is still the
 * job's — something of it still marked as the agent's, in the workspace: its
 * id is not given out again while anything is in it.
 */
export async function stopJob(workspace: string, key: string): Promise<boolean> {
  const job = tracked.get(rootOf(workspace))?.get(key);
  if (!job || job.state === "exited") return false;
  // Read now, not from the last second's.
  const current = (await scan(job.workspace, true)).filter((p) => p.sid === job.sid);
  if (!current.length || job.sid === portalSession()) return false;
  // What the list says next is after the stop, not the scan from before it.
  cached = undefined;
  await signalSession(job.sid, "SIGHUP");
  const members = await signalSession(job.sid, "SIGTERM");
  setTimeout(() => {
    for (const pid of members) {
      try {
        if (Number(statOf(pid)?.[3]) === job.sid) process.kill(pid, "SIGKILL");
      } catch {
        // Gone, as asked.
      }
    }
  }, 3000).unref();
  return true;
}

/**
 * Stops the jobs that are running in a folder that is being deleted, with the chats that started them: with the
 * chats gone nothing would list them or stop them, and they would keep their ports and memory in a folder that is
 * no more. How many were stopped. Never fails: a job that cannot be read is left, as it would be by any stop.
 */
export async function stopJobsIn(workspace: string): Promise<number> {
  if (!BACKGROUND_SUPPORTED) return 0;
  let stopped = 0;
  try {
    // Read now: a job started in the second after somebody's last look (a jobs panel asks every few seconds) would be left running.
    for (const job of await listJobs(workspace, false, true)) {
      if (job.state !== "exited" && (await stopJob(workspace, job.key))) stopped++;
    }
  } catch {
    // What could not be read is not stopped.
  }
  return stopped;
}
