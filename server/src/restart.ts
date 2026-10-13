import { execFile, spawn, type SpawnOptions } from "node:child_process";
import { readFileSync } from "node:fs";

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
  const service = serviceOf(cgroup);
  if (!service) return undefined;
  const out = await show([...(service.user ? ["--user"] : []), "show", "--property=MainPID,Restart", service.unit]);
  const main = Number(/^MainPID=(\d+)$/m.exec(out ?? "")?.[1]);
  if (!main || !pids.includes(main)) return undefined;
  return { ...service, restart: /^Restart=(.*)$/m.exec(out ?? "")?.[1]?.trim() };
}

export interface RestartPlan {
  mode: RestartMode;
  /** The service the portal is the main process of, where it is. */
  service?: { unit: string; user: boolean; restart: string | undefined };
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
  const service = await ownService(cgroup, show, pids);
  if (env.PORTAL_UPDATE_RESTART === "exit" || service) return { mode: "exit", service };
  return { mode: serviceOf(cgroup) ? "both" : "self" };
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
 * Throws, before anything is stopped, when the replacement cannot be started: the old portal stays up.
 */
export async function restartPortal(launch: Launch = LAUNCH, deps: RestartDeps = real()): Promise<void> {
  const { mode } = await restartPlan(deps.env, deps.cgroup ?? "", deps.show, deps.pids);
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
