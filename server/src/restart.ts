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

export type RestartMode = "self" | "exit";

/**
 * `exit`: the portal only stops, with a status that makes whatever runs it start it again. `self`: it starts its
 * replacement itself. `PORTAL_UPDATE_RESTART` says which; unset, a portal that runs as a systemd service exits, since
 * what it starts itself is in the service's control group and is ended with it, and anything else starts its own.
 */
export function restartMode(env: NodeJS.ProcessEnv = process.env, cgroup: string | undefined = readCgroup()): RestartMode {
  if (env.PORTAL_UPDATE_RESTART === "exit" || env.PORTAL_UPDATE_RESTART === "self") return env.PORTAL_UPDATE_RESTART;
  return serviceOf(cgroup) ? "exit" : "self";
}

/** Restart policies that start a program again that ended with a status other than 0. */
const RESTARTS_ON_FAILURE = new Set(["always", "on-failure"]);

const systemctl = (args: string[]): Promise<string | undefined> =>
  new Promise((resolve) => execFile("systemctl", args, { timeout: 5000 }, (error, stdout) => resolve(error ? undefined : stdout)));

/**
 * Why the portal would not come back after it stops, when it would not: a systemd service that is not set to start
 * again. Looked at before an update is begun, so that it is not found out afterwards. Nothing is claimed where it
 * cannot be read: no systemctl, another manager.
 */
export async function restartProblem(
  mode: RestartMode = restartMode(),
  service = serviceOf(readCgroup()),
  show: (args: string[]) => Promise<string | undefined> = systemctl,
): Promise<string | null> {
  if (mode !== "exit" || !service) return null;
  const out = await show([...(service.user ? ["--user"] : []), "show", "--property=Restart", service.unit]);
  const policy = /^Restart=(.*)$/m.exec(out ?? "")?.[1]?.trim();
  if (!policy || RESTARTS_ON_FAILURE.has(policy)) return null;
  return `The portal runs as the systemd service ${service.unit}, which is set to Restart=${policy}, so it would not be started again after the update. Set Restart=on-failure (or Restart=always) in the unit, then update again.`;
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
 * the replacement first, detached, so that it outlives this process; or, in `exit` mode (see `restartMode`), with
 * the status `RESTART_EXIT` and nothing started.
 *
 * Throws, before anything is stopped, when the replacement cannot be started: the old portal stays up.
 */
export async function restartPortal(launch: Launch = LAUNCH, deps: RestartDeps = real()): Promise<void> {
  if (restartMode(deps.env, deps.cgroup ?? "") === "exit") exitStatus = RESTART_EXIT;
  else {
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
  setTimeout(deps.stop, deps.delayMs);
}
