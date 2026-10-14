import { execFile, spawn, type SpawnOptions } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dockerAvailable, request } from "./extensions/docker.js";

/**
 * How this portal was started, and starting it again.
 *
 * The entry loads this module before it points `process.argv[1]` at pi (see index.ts), so what is kept here is the
 * command line the portal was really started with: the one to run again after an update.
 */
export interface Launch {
  execPath: string;
  execArgv: string[];
  /** The script, as it was started; undefined when node was not given a file. */
  script: string | undefined;
  args: string[];
  cwd: string;
}

export const LAUNCH: Launch = {
  execPath: process.execPath,
  execArgv: [...process.execArgv],
  script: process.argv[1],
  args: process.argv.slice(2),
  cwd: process.cwd(),
};

/**
 * The status the portal ends with. 0, as ever, unless an update left the start to whatever runs the portal: a status
 * that is not 0 is what `Restart=on-failure`, a container's `on-failure` policy and pm2 all start again from.
 */
export const RESTART_EXIT = 75;
let exitStatus = 0;
export const requestedExit = (): number => exitStatus;

/**
 * A restart has been asked for and is on its way. An update begun now would be cut off by the stop in the middle of its
 * merge or install, and leave the portal without the files it starts from, so the update refuses while this is set.
 */
let held = false;
export const restartPending = (): boolean => held;
export const holdRestart = (on: boolean): void => {
  held = on;
};

/**
 * Waits until the old portal is gone (its port and its data are free then), and runs the command in its place. A
 * minute at most: a portal that is still there after that has the new one turned away by its lock, as any second
 * start would be.
 */
const WAIT_THEN_START = 'n=0; while kill -0 "$1" 2>/dev/null && [ "$n" -lt 300 ]; do sleep 0.2; n=$((n+1)); done; shift; exec "$@"';

/** The systemd service this process runs in, if it does: the last service in its control group's path. */
export function serviceOf(cgroup: string | undefined): { unit: string; user: boolean } | undefined {
  if (!cgroup) return undefined;
  // cgroup v2 is one line, `0::/path`; v1 has one per controller, and systemd's own is `name=systemd`.
  const line = cgroup.split("\n").find((l) => l.startsWith("0::") || l.includes(":name=systemd:"));
  const where = line?.split(":").slice(2).join(":") ?? "";
  const unit = where.split("/").reverse().find((part) => /\.service$/.test(part) && !/^user@\d+\.service$/.test(part));
  return unit ? { unit, user: where.includes("/user@") } : undefined;
}

const readCgroup = (): string | undefined => {
  try {
    return readFileSync("/proc/self/cgroup", "utf8");
  } catch {
    return undefined;
  }
};

/**
 * `exit`: the portal only stops, with a status that makes whatever runs it start it again. `self`: it starts its
 * replacement itself. `both`: it starts its replacement and stops with that status.
 */
export type RestartMode = "self" | "exit" | "both";

/** This process and the one that started it: `npm start` is the unit's main process, and runs the portal as its child. */
export const ownPids = (): number[] => [process.pid, process.ppid];

/**
 * The systemd service this portal is the main process of, with its restart policy, or nothing.
 *
 * Being in a service's control group is not that: a cron job is in `cron.service`, whose main process is the cron
 * daemon, and nothing starts the job again when it exits. So the unit's `MainPID` has to be this process or its parent.
 * Where that cannot be read (no systemctl), nothing is claimed.
 */
export async function ownService(
  cgroup: string | undefined,
  show: (args: string[]) => Promise<string | undefined> = systemctl,
  pids: number[] = ownPids(),
): Promise<{ unit: string; user: boolean; restart: string | undefined } | undefined> {
  const found = await serviceInfo(cgroup, show);
  if (!found || !found.main || !pids.includes(found.main)) return undefined;
  return { unit: found.unit, user: found.user, restart: found.restart };
}

/** The systemd service this process is in the control group of, with its main process and restart policy, whoever its main process is. */
async function serviceInfo(
  cgroup: string | undefined,
  show: (args: string[]) => Promise<string | undefined>,
): Promise<{ unit: string; user: boolean; main: number; restart: string | undefined } | undefined> {
  const service = serviceOf(cgroup);
  if (!service) return undefined;
  const out = await show([...(service.user ? ["--user"] : []), "show", "--property=MainPID,Restart", service.unit]);
  return { ...service, main: Number(/^MainPID=(\d+)$/m.exec(out ?? "")?.[1]), restart: /^Restart=(.*)$/m.exec(out ?? "")?.[1]?.trim() };
}

export interface RestartPlan {
  mode: RestartMode;
  /** The service the portal is the main process of, where it is. */
  service?: { unit: string; user: boolean; restart: string | undefined };
  /** The service the portal only runs in the control group of (`both`), whose main process is something else. */
  group?: { unit: string; user: boolean; restart: string | undefined };
}

/**
 * How the portal restarts, by where it runs. `PORTAL_UPDATE_RESTART` (`self`, `exit`) says outright. Unset:
 * - in a systemd service's control group, as the unit's main process or its child (`ExecStart=node …`, or an `npm
 *   start` whose shell execs the command): `exit`. What the portal started itself would be in the service's control
 *   group and be ended with it, so the unit has to start it.
 * - in a service's control group otherwise (`npm start` under dash, which does not exec; a wrapper script; a job of
 *   cron): `both`. The portal cannot be told apart from cron's job by who its parents are, and has to work for
 *   both. Under cron the status is not looked at and its copy lives on, since cron.service is not stopped. Under a
 *   unit whose process is the shell or npm, the status travels up through them to the unit, which starts the portal
 *   again and ends the copy with the old control group; the instance lock settles a race between them.
 * - anywhere else: `self`.
 */
export async function restartPlan(
  env: NodeJS.ProcessEnv = process.env,
  cgroup: string | undefined = readCgroup(),
  show?: (args: string[]) => Promise<string | undefined>,
  pids?: number[],
): Promise<RestartPlan> {
  if (env.PORTAL_UPDATE_RESTART === "self") return { mode: "self" };
  // One question to systemd answers both: is the portal the unit's own process, and what the unit's policy is.
  const info = await serviceInfo(cgroup, show ?? systemctl);
  const own = info && info.main && (pids ?? ownPids()).includes(info.main);
  const service = own ? { unit: info.unit, user: info.user, restart: info.restart } : undefined;
  if (env.PORTAL_UPDATE_RESTART === "exit" || service) return { mode: "exit", service };
  if (!serviceOf(cgroup)) return { mode: "self" };
  return { mode: "both", group: info && { unit: info.unit, user: info.user, restart: info.restart } };
}

/** Restart policies that start a program again that ended with a status other than 0. */
const RESTARTS_ON_FAILURE = new Set(["always", "on-failure"]);

const systemctl = (args: string[]): Promise<string | undefined> =>
  new Promise((resolve) => execFile("systemctl", args, { timeout: 5000 }, (error, stdout) => resolve(error ? undefined : stdout)));

/**
 * Why the portal would not come back after it stops, when it would not: the systemd service it is the main process of
 * is not set to start it again. Looked at before an update is begun, so that it is not found out afterwards. Nothing
 * is claimed where it cannot be read, or for a portal that something else started.
 */
export async function restartProblem(
  env: NodeJS.ProcessEnv = process.env,
  cgroup: string | undefined = readCgroup(),
  show?: (args: string[]) => Promise<string | undefined>,
  pids?: number[],
): Promise<string | null> {
  const { mode, service } = await restartPlan(env, cgroup, show, pids);
  if (mode !== "exit" || !service?.restart || RESTARTS_ON_FAILURE.has(service.restart)) return null;
  return `The portal runs as the systemd service ${service.unit}, which is set to Restart=${service.restart}, so it would not be started again after the update. Set Restart=on-failure (or Restart=always) in the unit, then update again.`;
}

/** What a restart needs of the system, so that a test can look at what it would do. */
export interface RestartDeps {
  spawn: (command: string, args: string[], options: SpawnOptions) => ReturnType<typeof spawn>;
  /** Ends this process the way the system's own stop does. */
  stop: () => void;
  pid: number;
  env: NodeJS.ProcessEnv;
  /** This process's control groups, as `/proc/self/cgroup` has them. */
  cgroup: string | undefined;
  /** What systemctl says; and this process's own pid and its parent's. */
  show?: (args: string[]) => Promise<string | undefined>;
  pids?: number[];
  /** How long the stop waits, so that a page asking in the meantime is told the portal is restarting. */
  delayMs: number;
}

const real = (): RestartDeps => ({
  spawn,
  stop: () => process.kill(process.pid, "SIGTERM"),
  pid: process.pid,
  env: process.env,
  cgroup: readCgroup(),
  delayMs: 1500,
});

/**
 * Restarts the portal: stops it as a SIGTERM does (running chats are wound down, channels closed), after starting
 * the replacement first, detached, so that it outlives this process, or with the status `RESTART_EXIT` and nothing
 * started, or both (see `restartPlan`).
 *
 * `forced` is the mode to use instead of the one `restartPlan` finds, for a caller that has decided already (see
 * `restartSupport`).
 *
 * Throws, before anything is stopped, when the replacement cannot be started: the old portal stays up.
 */
export async function restartPortal(launch: Launch = LAUNCH, deps: RestartDeps = real(), forced?: RestartMode): Promise<void> {
  const mode = forced ?? (await restartPlan(deps.env, deps.cgroup ?? "", deps.show, deps.pids)).mode;
  if (mode !== "exit") {
    if (!launch.script) throw new Error("The portal was not started from a file, so it cannot start itself again. Start it again by hand.");
    const child = deps.spawn("sh", ["-c", WAIT_THEN_START, "sh", String(deps.pid), launch.execPath, ...launch.execArgv, launch.script, ...launch.args], {
      cwd: launch.cwd,
      env: deps.env,
      // Its own session, so that the terminal closing does not take it along; its output goes where the portal's did.
      detached: true,
      stdio: ["ignore", "inherit", "inherit"],
    });
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("spawn", () => resolve());
    });
    child.unref();
  }
  // Ended with the status that has a manager start it again, wherever one may be; not set when the copy could not be started.
  if (mode !== "self") exitStatus = RESTART_EXIT;
  setTimeout(deps.stop, deps.delayMs);
}

/** A container: Docker's marker file, or Podman's. */
const inContainer = (): boolean => existsSync("/.dockerenv") || existsSync("/run/.containerenv");

/**
 * The restart policy Docker has for this container (`always`, `unless-stopped`, `on-failure`, or `no` / empty for
 * none), asked over the socket by the container's name; nothing where that cannot be asked (no socket, another name).
 */
export async function containerRestartPolicy(env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  const name = env.PORTAL_CONTAINER_NAME || env.HOSTNAME;
  if (!name || !dockerAvailable()) return undefined;
  try {
    const res = await request<{ HostConfig?: { RestartPolicy?: { Name?: string } } }>("GET", `/containers/${encodeURIComponent(name)}/json`, undefined, 3000);
    return res.status === 200 ? (res.body?.HostConfig?.RestartPolicy?.Name ?? "") : undefined;
  } catch {
    return undefined;
  }
}

/** What is there to start the portal again, or why nothing is. */
export type RestartSupport =
  | { ok: true; mode: RestartMode; /** What starts it: the words the page and the log use. */ by: "systemd" | "container" | "manager" | "copy" }
  | { ok: false; code: "unsupervised" | "policy"; message: string };

export interface SupportDeps {
  env?: NodeJS.ProcessEnv;
  cgroup?: string | undefined;
  show?: (args: string[]) => Promise<string | undefined>;
  pids?: number[];
  container?: () => boolean;
  /** The container's restart policy, as `containerRestartPolicy` says it. */
  policy?: () => Promise<string | undefined>;
}

/**
 * Whether the owner's Restart button can do what it says. Stricter than the update, which starts a copy of the portal
 * itself where nothing else would: a portal started by hand in a terminal is not restarted from a page by a copy that
 * takes the terminal's job over, unless `PORTAL_UPDATE_RESTART=self` says that is wanted.
 *
 * - `PORTAL_UPDATE_RESTART=self`: the portal starts its own copy.
 * - a systemd service whose unit starts it again: it stops with `RESTART_EXIT`. A unit that does not is refused, also
 *   when the portal is only in its control group (a wrapper script, `npm start` under dash): the copy it starts there is
 *   ended with the group when the unit stops.
 * - `PORTAL_UPDATE_RESTART=exit` (pm2, `while true`): it stops with `RESTART_EXIT`.
 * - a container: it stops with `RESTART_EXIT`, and Docker's restart policy starts it. A policy that Docker says is
 *   none is refused; where Docker cannot be asked, the compose files' `restart: unless-stopped` is taken as given.
 * - otherwise nothing is known to start it again: refused.
 */
export async function restartSupport(deps: SupportDeps = {}): Promise<RestartSupport> {
  const env = deps.env ?? process.env;
  const cgroup = deps.cgroup ?? readCgroup() ?? "";
  if (env.PORTAL_UPDATE_RESTART === "self") return { ok: true, mode: "self", by: "copy" };
  const { mode, service, group } = await restartPlan(env, cgroup, deps.show, deps.pids);
  const unit = service ?? group;
  if (unit && unit.restart && !RESTARTS_ON_FAILURE.has(unit.restart)) {
    return {
      ok: false,
      code: "policy",
      message: service
        ? `The portal runs as the systemd service ${unit.unit}, which is set to Restart=${unit.restart}, so it would not be started again. Set Restart=on-failure (or Restart=always) in the unit.`
        : `The portal runs in the systemd service ${unit.unit} (started by a script or by npm, not as the unit's own process), which is set to Restart=${unit.restart}, so it would not be started again. Set Restart=on-failure (or Restart=always) in the unit. For a job of a daemon that is not stopped when the job ends (cron), PORTAL_UPDATE_RESTART=self lets the portal start its own copy.`,
    };
  }
  if (mode === "exit") return { ok: true, mode, by: service ? "systemd" : "manager" };
  // In a systemd service's control group without being its process: see restartPlan; the unit has to start it.
  if (mode === "both") return { ok: true, mode, by: "systemd" };
  if ((deps.container ?? inContainer)()) {
    const policy = await (deps.policy ?? (() => containerRestartPolicy(env)))();
    if (policy === "" || policy === "no") {
      return { ok: false, code: "policy", message: "This container has no restart policy, so Docker would not start it again. Run it with restart: unless-stopped (as the compose files do), or restart it on the host." };
    }
    return { ok: true, mode: "exit", by: "container" };
  }
  return {
    ok: false,
    code: "unsupervised",
    message: "Nothing would start this portal again here: it was not started by systemd or in a container. Start it again on the host, or run it under systemd (Restart=on-failure) or Docker. PORTAL_UPDATE_RESTART=self lets the portal start its own copy.",
  };
}
