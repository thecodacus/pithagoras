import { spawn, type SpawnOptions } from "node:child_process";

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
 * Waits until the old portal is gone (its port and its data are free then), and runs the command in its place. A
 * minute at most: a portal that is still there after that has the new one turned away by its lock, as any second
 * start would be.
 */
const WAIT_THEN_START = 'n=0; while kill -0 "$1" 2>/dev/null && [ "$n" -lt 300 ]; do sleep 0.2; n=$((n+1)); done; shift; exec "$@"';

/** What a restart needs of the system, so that a test can look at what it would do. */
export interface RestartDeps {
  spawn: (command: string, args: string[], options: SpawnOptions) => ReturnType<typeof spawn>;
  /** Ends this process the way the system's own stop does. */
  stop: () => void;
  pid: number;
  env: NodeJS.ProcessEnv;
  /** How long the stop waits, so that a page asking in the meantime is told the portal is restarting. */
  delayMs: number;
}

const real: RestartDeps = {
  spawn,
  stop: () => process.kill(process.pid, "SIGTERM"),
  pid: process.pid,
  env: process.env,
  delayMs: 1500,
};

/**
 * Restarts the portal: stops it as a SIGTERM does (running chats are wound down, channels closed), and unless
 * `PORTAL_UPDATE_RESTART=exit` says something else starts the replacement first, detached, so that it outlives this
 * process. `exit` is for a portal run by a service manager that starts it again by itself (systemd with
 * `Restart=always`, a container's restart policy): two starts at once would have the replacement of the one cut
 * off by the manager's own.
 *
 * Throws, before anything is stopped, when the replacement cannot be started: the old portal stays up.
 */
export async function restartPortal(launch: Launch = LAUNCH, deps: RestartDeps = real): Promise<void> {
  if (deps.env.PORTAL_UPDATE_RESTART !== "exit") {
    if (!launch.script) throw new Error("The portal was not started from a file, so it cannot start itself again. Start it again by hand.");
    const child = deps.spawn("sh", ["-c", WAIT_THEN_START, "sh", String(deps.pid), launch.execPath, ...launch.execArgv, launch.script, ...launch.args], {
      cwd: launch.cwd,
      env: deps.env,
      // Its own session, so that the terminal closing or the service stopping the old portal does not take it along;
      // its output goes where the portal's did.
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
