import { existsSync } from "node:fs";
import { readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * What an update puts aside and puts back: the files a build is made of, so that a step that fails leaves the old
 * build as it was, and what the build in place was made from.
 *
 * `npm ci` empties `node_modules` before it installs, and a build writes into `core/server/dist` and `core/web/dist` as it goes
 * (tsc writes the files of a program that has a type error), so the portal's old files are moved aside before each
 * step, put back when it fails, and thrown away only when the whole build has worked.
 */
export interface Artifacts {
  /** The commit the build in place was made from, if it is known: not once somebody has built since. */
  builtFrom(): Promise<string | undefined>;
  /** Writes down what the build in place was made from; with `onlyIfUnknown`, only where it is not known already. */
  markBuilt(sha: string, onlyIfUnknown?: boolean): Promise<void>;
  /** Puts `node_modules` aside, for the install. */
  keepModules(): Promise<void>;
  /** Puts the built server and web app aside, for the build. */
  keepBuild(): Promise<void>;
  /** Puts back what was put aside, and removes what the step that failed made in its place. */
  restore(): Promise<void>;
  /** The build worked: what was put aside goes. */
  discard(): Promise<void>;
}

const ASIDE = ".update-old";
const MODULES = ["node_modules"];
// With the old start files (server/dist, see scripts/old-entries.mjs), which a build writes again too.
const BUILD = [path.join("core", "server", "dist"), path.join("core", "web", "dist"), path.join("server", "dist")];
/** In the server's build, so that the record goes with the build it describes: put aside with it, and put back with it. */
const MARK = path.join("core", "server", "dist", ".built-from");
/**
 * Files every build writes again, whose times are written down with the commit. A build that was not made by the
 * update (`npm run build` on the host) leaves the record where it was, since tsc never removes what it did not write,
 * but writes these: so a record whose times are not the files' times is of a build that is not in place any more.
 */
const WITNESSES = [path.join("core", "server", "dist", "index.js"), path.join("core", "web", "dist", "index.html")];

export function fileArtifacts(root: string): Artifacts {
  /** What is aside now, in the order it was put there. */
  let aside: string[] = [];
  const at = (rel: string) => path.join(root, rel);

  /** When each of the build's own files was written, to the nanosecond; null where there is none. */
  const times = (): Promise<(string | null)[]> =>
    Promise.all(WITNESSES.map((rel) => stat(at(rel), { bigint: true }).then((st) => String(st.mtimeNs), () => null)));

  async function keep(rels: string[]): Promise<void> {
    for (const rel of rels) {
      if (!existsSync(at(rel))) continue;
      // What an update that was cut off left: older than what is there now.
      await rm(at(rel) + ASIDE, { recursive: true, force: true });
      await rename(at(rel), at(rel) + ASIDE);
      aside.push(rel);
    }
  }

  return {
    async builtFrom() {
      try {
        const kept = JSON.parse(await readFile(at(MARK), "utf8")) as { sha?: unknown; times?: unknown };
        const now = await times();
        return typeof kept.sha === "string" && JSON.stringify(kept.times) === JSON.stringify(now) ? kept.sha || undefined : undefined;
      } catch {
        return undefined;
      }
    },
    async markBuilt(sha, onlyIfUnknown = false) {
      // A portal with no build has nothing to describe.
      if (!existsSync(at(BUILD[0])) || (onlyIfUnknown && (await this.builtFrom()) !== undefined)) return;
      await writeFile(at(MARK), JSON.stringify({ sha, times: await times() }) + "\n");
    },
    keepModules: () => keep(MODULES),
    keepBuild: () => keep(BUILD),
    async restore() {
      const back = aside.reverse();
      aside = [];
      for (const rel of back) {
        await rm(at(rel), { recursive: true, force: true });
        await rename(at(rel) + ASIDE, at(rel));
      }
    },
    async discard() {
      const gone = aside;
      aside = [];
      for (const rel of gone) await rm(at(rel) + ASIDE, { recursive: true, force: true });
    },
  };
}
