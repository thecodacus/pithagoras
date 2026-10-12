import { existsSync } from "node:fs";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * What an update puts aside and puts back: the files a build is made of, so that a step that fails leaves the old
 * build as it was, and what the build in place was made from.
 *
 * `npm ci` empties `node_modules` before it installs, and a build writes into `server/dist` and `web/dist` as it goes
 * (tsc writes the files of a program that has a type error), so the portal's old files are moved aside before each
 * step, put back when it fails, and thrown away only when the whole build has worked.
 */
export interface Artifacts {
  /** The commit the build in place was made from, if it is known. */
  builtFrom(): Promise<string | undefined>;
  /** Writes down what the build in place was made from; with `onlyIfMissing`, only where nothing is written down yet. */
  markBuilt(sha: string, onlyIfMissing?: boolean): Promise<void>;
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
const BUILD = [path.join("server", "dist"), path.join("web", "dist")];
/** In the server's build, so that the record goes with the build it describes: put aside with it, and put back with it. */
const MARK = path.join("server", "dist", ".built-from");

export function fileArtifacts(root: string): Artifacts {
  /** What is aside now, in the order it was put there. */
  let aside: string[] = [];
  const at = (rel: string) => path.join(root, rel);

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
        return (await readFile(at(MARK), "utf8")).trim() || undefined;
      } catch {
        return undefined;
      }
    },
    async markBuilt(sha, onlyIfMissing = false) {
      // A portal with no build has nothing to describe.
      if (!existsSync(at(BUILD[0])) || (onlyIfMissing && existsSync(at(MARK)))) return;
      await writeFile(at(MARK), `${sha}\n`);
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
