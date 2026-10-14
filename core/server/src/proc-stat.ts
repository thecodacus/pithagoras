import { readFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";

/** Fields of /proc/<pid>/stat after the command name, which may hold spaces: [0] is the state, [3] the session. */
export const fieldsOf = (stat: string): string[] => stat.slice(stat.lastIndexOf(")") + 2).split(" ");

export function statOf(pid: string | number): string[] | undefined {
  try {
    return fieldsOf(readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return undefined;
  }
}

/**
 * Signals every process in a session, and says which they were.
 *
 * A walk of /proc — every process on the host — so it is read without holding
 * up the event loop: a busy host has thousands, and a closing panel is no
 * reason for every open stream to stall. Read a batch at a time rather than
 * one after another, which on such a host kept the hangup waiting on
 * thousands of reads in turn.
 */
export async function signalSession(session: number, signal: NodeJS.Signals): Promise<number[]> {
  let pids: string[];
  try {
    pids = (await readdir("/proc")).filter((name) => /^\d+$/.test(name));
  } catch {
    return [];
  }
  const members: number[] = [];
  for (let i = 0; i < pids.length; i += STAT_BATCH) {
    const stats = await Promise.all(
      pids.slice(i, i + STAT_BATCH).map((pid) => readFile(`/proc/${pid}/stat`, "utf8").then((stat) => ({ pid, stat }), () => undefined)),
    );
    for (const found of stats) {
      if (!found || Number(fieldsOf(found.stat)[3]) !== session) continue;
      try {
        process.kill(Number(found.pid), signal);
        members.push(Number(found.pid));
      } catch {
        // Gone already, or not ours to signal.
      }
    }
  }
  return members;
}

/** How many /proc entries signalSession reads at once: well under any open-file limit. */
const STAT_BATCH = 256;
