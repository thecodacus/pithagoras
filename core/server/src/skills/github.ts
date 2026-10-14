import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, readFileSync, type Dirent } from "node:fs";
import { cp, lstat, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { environment } from "../git.js";
import { isWithinText, realPath } from "../within.js";

const run = promisify(execFile);

/**
 * Importing skills from a git repository.
 *
 * A skill is markdown, so this is a shallow clone and a copy — nothing is
 * executed, unlike a package install. What it *is* is a set of instructions the
 * agent will follow, which is its own kind of risk: only import from somewhere
 * you would take instructions from.
 *
 * The repository is somebody else's, so nothing in it is trusted to say where
 * it goes: its names are checked before they become paths, and its links are
 * never followed, copied or written through.
 */

export interface SkillSource {
  /** What was typed, kept so the import can be repeated to update. */
  spec: string;
  url: string;
  ref?: string;
  /** Subdirectory within the repository, when the spec pointed at one. */
  subpath?: string;
  importedAt: string;
}

/** Written beside SKILL.md so the origin survives a restart. */
export const SOURCE_FILE = ".source.json";

/**
 * The login out of the addresses in `text`: `https://token@host/…` is how a
 * token gets pasted, and nothing here keeps or shows one. An ssh user stays, it
 * is not a secret, but its password does not.
 */
export function withoutLogin(text: string): string {
  return text.replace(/\b([a-z][\w+.-]*):\/\/([^/@\s]*)@/gi, (_all, scheme: string, login: string) =>
    scheme.toLowerCase() === "ssh" ? `${scheme}://${login.split(":")[0]}@` : `${scheme}://`);
}

const clean = (value: unknown) => (typeof value === "string" ? withoutLogin(value) : value);

export function readSource(skillDir: string): SkillSource | null {
  try {
    const file = path.join(skillDir, SOURCE_FILE);
    // A link here would be read from wherever it leads.
    const info = lstatSync(file);
    if (!info.isFile() || info.size > 64 * 1024) return null;
    const source = JSON.parse(readFileSync(file, "utf8"));
    // One written before logins were refused may hold one: shown, and written again, without.
    return { ...source, spec: clean(source.spec), url: clean(source.url) };
  } catch {
    return null;
  }
}

/** What a pasted address starts with when it carries a login. */
const LOGIN_IN_ADDRESS = /^([a-z][\w+.-]*):\/\/([^/@\s]*)@/i;

interface Parsed {
  url: string;
  ref?: string;
  subpath?: string;
  /** What follows `/tree/` when that is more than a ref: where the ref ends is for the repository to say. */
  tree?: string;
}

/** A folder of the repository, as a path that cannot lead out of it or into git's own files. */
function checkedSubpath(subpath: string | undefined, spec: string): string | undefined {
  if (subpath === undefined) return undefined;
  const parts = subpath.split("/").filter(Boolean);
  if (!parts.length) return undefined;
  if (subpath.includes("\0") || subpath.includes("\\") || parts.some((p) => p === ".." || p.toLowerCase() === ".git")) {
    throw new Error(`"${spec}" does not name a folder inside the repository`);
  }
  return parts.join("/");
}

/**
 * Work out what to clone.
 *
 * Accepts what someone would actually paste: a shorthand, a repository URL, or
 * the URL of a subdirectory copied straight from the browser's address bar —
 * which carries `/tree/<branch>/<path>` and has to be taken apart.
 */
export function parseSpec(input: string): Parsed {
  const spec = input.trim().replace(/\.git$/, "");

  const login = LOGIN_IN_ADDRESS.exec(spec);
  if (login && (login[1].toLowerCase() !== "ssh" || login[2].includes(":"))) {
    throw new Error(
      "Leave the login out of the address. A private repository is reached through the git login of this server (a credential helper), which is never stored here.",
    );
  }

  // https://github.com/user/repo/tree/main/skills/foo
  const tree = /^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+)\/tree\/(.+)$/.exec(spec);
  if (tree) {
    const parts = tree[3].split("/").filter(Boolean);
    return {
      url: `https://github.com/${tree[1]}/${tree[2]}.git`,
      // The first segment: the ref, unless the branch's own name has a slash.
      ref: parts[0],
      subpath: checkedSubpath(parts.slice(1).join("/"), input.trim()),
      tree: parts.length > 1 ? parts.join("/") : undefined,
    };
  }

  // Any other URL: clone as given.
  if (/^(https?:\/\/|git@|ssh:\/\/|git:\/\/)/.test(spec)) {
    const [url, ref] = spec.split("#");
    return { url: url.endsWith(".git") ? url : `${url}.git`, ref: ref || undefined };
  }

  // user/repo, user/repo#branch, user/repo/sub/dir
  const shorthand = /^([\w.-]+)\/([\w.-]+)(?:\/(.*?))?(?:#(.+))?$/.exec(spec);
  if (shorthand) {
    return {
      url: `https://github.com/${shorthand[1]}/${shorthand[2]}.git`,
      ref: shorthand[4] || undefined,
      subpath: checkedSubpath(shorthand[3], input.trim()),
    };
  }

  throw new Error(`Cannot tell what "${input}" points at. Try "user/repo" or a GitHub URL.`);
}

/** What a skill with no name of its own is called when it is the top of the repository: the repository. */
const repoName = (url: string) => /([^/:]+?)(?:\.git)?\/?$/.exec(url)?.[1] ?? "";

/**
 * A skill's name becomes a folder in the skills folder, and the repository
 * chose it: one plain name, never a place. `..` or a name with a slash would
 * otherwise write — and with overwrite, delete — outside the skills folder.
 */
function usableName(name: string): boolean {
  return name !== "" && name !== "." && name !== ".." && !name.startsWith(".") && !/[/\\\u0000-\u001f]/.test(name);
}

/** Directories holding a SKILL.md, found without descending into one. Links are not looked through. */
async function findSkillDirs(root: string, depth = 0): Promise<string[]> {
  if (depth > 4) return [];
  try {
    if ((await lstat(path.join(root, "SKILL.md"))).isFile()) return [root];
  } catch {
    // none here; look further
  }

  const out: string[] = [];
  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    // A link is not a folder here, whatever it leads to.
    if (entry.isDirectory()) out.push(...(await findSkillDirs(path.join(root, entry.name), depth + 1)));
  }
  return out;
}

/** A SKILL.md that is a link, a device, or far larger than any is not read. */
const MAX_SKILL_FILE = 1024 * 1024;

/** Just enough frontmatter to describe a skill before importing it. */
async function frontmatter(file: string): Promise<{ name?: string; description?: string }> {
  let text: string;
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.size > MAX_SKILL_FILE) return {};
    text = await readFile(file, "utf8");
  } catch {
    return {};
  }
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!block) return {};

  const read = (key: string) => {
    const line = new RegExp(`^${key}\\s*:\\s*(.*)$`, "m").exec(block[1]);
    if (!line) return undefined;
    const raw = line[1].trim();

    // A block scalar — "description: |-" with the text indented underneath.
    // Common in longer descriptions, and reading only the marker showed "|-"
    // where the description should be.
    if (/^[|>][+-]?$/.test(raw)) {
      const after = block[1].slice(line.index + line[0].length).split(/\r?\n/);
      const body: string[] = [];
      for (const next of after) {
        if (!next.trim()) {
          if (body.length) body.push("");
          continue;
        }
        if (!/^\s/.test(next)) break; // dedented: the block ended
        body.push(next.trim());
      }
      // Folded scalars join with spaces; literal ones keep their line breaks,
      // but a description is shown as one line either way.
      return body.join(" ").trim();
    }
    // Quoted values are the common case now, since a description contains
    // colons; unquoted ones still have to work for hand-written skills.
    if (raw.startsWith('"') && raw.endsWith('"')) {
      try {
        return JSON.parse(raw) as string;
      } catch {
        return raw.slice(1, -1);
      }
    }
    return raw.replace(/^'|'$/g, "");
  };

  return { name: read("name"), description: read("description") };
}

export interface FoundSkill {
  /** Directory name, which is what it will be installed as. */
  name: string;
  description: string;
  /** Already present under the skills root. */
  installed: boolean;
  /** Path within the repository, for orientation. */
  from: string;
}

export interface Skipped {
  name: string;
  reason: string;
}

export interface Preview {
  found: FoundSkill[];
  /** What is in the repository and cannot be imported, and why. */
  skipped: Skipped[];
  /** The commit that was looked at: what an import of it asks for, so that it installs what was shown. */
  sha: string;
}

/** What git said, as far as it is for the person at the form. */
function explain(stderr: string, fallback: string): string {
  const detail = withoutLogin(stderr).trim();
  // Nobody is at a terminal to answer: git failed at the question instead of asking it.
  if (/could not read (Username|Password)|terminal prompts disabled|Authentication failed|Permission denied \(publickey|Host key verification failed/i.test(detail)) {
    return "Not found, or private: this server has no login for it. A private repository needs a git credential helper set up for the server's git.";
  }
  return detail.split("\n").slice(-2).join(" ") || fallback;
}

async function git(args: string[], cwd?: string, fallback = "git failed"): Promise<string> {
  try {
    const { stdout } = await run("git", args, { cwd, env: environment(true), timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
    return stdout.trim();
  } catch (e) {
    throw new Error(explain(String((e as { stderr?: string }).stderr ?? (e as Error).message), fallback));
  }
}

/**
 * Where the ref of a pasted GitHub folder address ends. The address does not
 * say: `tree/release/2.0/skills/pdf` is the branch `release` and a folder
 * `2.0/skills/pdf`, or the branch `release/2.0` and a folder `skills/pdf`. The
 * longest name that is a branch or tag of the repository is taken.
 */
async function resolveTree(url: string, tree: string): Promise<{ ref: string; subpath?: string } | null> {
  const parts = tree.split("/");
  try {
    const listed = await git(["ls-remote", "--heads", "--tags", "--", url]);
    const names = new Set(
      listed.split("\n").map((line) => /\trefs\/(?:heads|tags)\/(.+?)(?:\^\{\})?$/.exec(line)?.[1]).filter((n): n is string => !!n),
    );
    for (let n = parts.length; n >= 1; n--) {
      const ref = parts.slice(0, n).join("/");
      if (names.has(ref)) return { ref, subpath: checkedSubpath(parts.slice(n).join("/"), tree) };
    }
  } catch {
    // Taken as the first segment; the clone says what is wrong with it.
  }
  return null;
}

interface Cloned {
  tmp: string;
  base: string;
  found: string[];
  url: string;
  ref?: string;
  subpath?: string;
  sha: string;
}

/**
 * Clone into a temporary directory, hand over what is inside, then clean up.
 *
 * `pin` is a commit to take rather than the head of the branch: what an import
 * installs is what the look before it showed.
 */
async function withClone<T>(spec: string, use: (ctx: Cloned) => Promise<T>, pin?: string): Promise<T> {
  const parsed = parseSpec(spec);
  const { url } = parsed;
  let { ref, subpath } = parsed;
  if (parsed.tree) {
    const resolved = await resolveTree(url, parsed.tree);
    if (resolved) ({ ref, subpath } = resolved);
  }
  const tmp = await mkdtemp(path.join(os.tmpdir(), "pithagoras-skill-"));

  try {
    // Links are checked out as small files holding the link text: where a
    // repository's link leads is the portal host's business, not its own.
    // Given a folder to look in, only that folder is fetched and written.
    const args = ["clone", "-c", "core.symlinks=false", "--depth", "1", "--quiet"];
    if (subpath) args.push("--filter=blob:none", "--sparse");
    if (ref) args.push("--branch", ref);
    args.push("--", url, tmp);
    await git(args, undefined, `Could not clone ${withoutLogin(url)}`);
    if (subpath) await git(["sparse-checkout", "set", "--", subpath], tmp);

    let sha = await git(["rev-parse", "HEAD"], tmp);
    if (pin && pin !== sha) {
      try {
        await git(["fetch", "--quiet", "--depth", "1", "origin", pin], tmp);
        await git(["checkout", "--quiet", "--detach", pin], tmp);
        sha = pin;
      } catch {
        throw new Error("The repository has changed since you looked at it, and what you looked at is not there any more. Look again.");
      }
    }

    // Held to the clone by where it leads as well as by its text.
    const base = subpath ? path.resolve(tmp, subpath) : tmp;
    const realBase = realPath(base);
    const realTmp = realPath(tmp);
    if (!isWithinText(tmp, base) || !realBase || !realTmp || !isWithinText(realTmp, realBase) || !(await lstat(base)).isDirectory()) {
      throw new Error(`"${subpath}" is not in that repository`);
    }

    const found = await findSkillDirs(base);
    if (!found.length) {
      throw new Error("No SKILL.md found there — a skill is a directory containing one");
    }
    return await use({ tmp, base, found, url, ref, subpath, sha });
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

interface Surveyed {
  name: string;
  dir: string;
  description: string;
  from: string;
}

/**
 * What is in the clone, by the names it would be installed under. The one
 * place a name is made, so that looking and importing cannot differ on it.
 */
async function survey(ctx: Cloned): Promise<{ entries: Surveyed[]; skipped: Skipped[]; named: Set<string> }> {
  const entries: Surveyed[] = [];
  const skipped: Skipped[] = [];
  const named = new Set<string>();
  for (const dir of ctx.found) {
    const meta = await frontmatter(path.join(dir, "SKILL.md"));
    // The top of the clone is in a temporary folder, whose name is nobody's.
    const name = meta.name?.trim() || (dir === ctx.tmp ? repoName(ctx.url) : path.basename(dir));
    named.add(name);
    if (!usableName(name)) {
      skipped.push({ name: name.slice(0, 80), reason: "unusable name" });
      continue;
    }
    if (entries.some((e) => e.name === name)) {
      skipped.push({ name, reason: "another skill in the repository has the same name" });
      continue;
    }
    entries.push({ name, dir, description: meta.description?.trim() ?? "", from: path.relative(ctx.base, dir) || "." });
  }
  return { entries, skipped, named };
}

/** Clone and report what is in there, without installing anything. */
export async function previewFromGit(spec: string, destRoot: string): Promise<Preview> {
  return withClone(spec, async (ctx) => {
    const { entries, skipped } = await survey(ctx);
    return {
      found: entries.map((e) => ({ name: e.name, description: e.description, installed: existsSync(path.join(destRoot, e.name)), from: e.from })),
      skipped,
      sha: ctx.sha,
    };
  });
}

export interface ImportResult {
  imported: string[];
  skipped: Skipped[];
}

/** What goes along into the skill's folder: files and folders, not links, git's own files or a `.source.json` of the repository's. */
const keepable = async (src: string) => {
  const name = path.basename(src);
  if (name === ".git" || name === SOURCE_FILE) return false;
  const info = await lstat(src);
  return info.isFile() || info.isDirectory();
};

const exists = (p: string) => lstat(p).then(() => true, () => false);

/**
 * Put one skill in place, whole or not at all. It is copied beside where it
 * goes first, under a name pi does not load, and an installed one is moved
 * aside only for the moment of the swap: a copy that fails half way leaves what
 * was there as it was.
 */
async function install(dir: string, dest: string, source: SkillSource, replace: boolean): Promise<void> {
  const root = path.dirname(dest);
  const tag = randomBytes(4).toString("hex");
  const staging = path.join(root, `.importing-${path.basename(dest)}-${tag}`);
  try {
    await cp(dir, staging, { recursive: true, filter: keepable });
    // Written into a folder made for this, so there is nothing for it to follow.
    await writeFile(path.join(staging, SOURCE_FILE), JSON.stringify(source, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
    if (!replace) {
      await rename(staging, dest);
      return;
    }
    const aside = path.join(root, `.replaced-${path.basename(dest)}-${tag}`);
    await rename(dest, aside);
    try {
      await rename(staging, dest);
    } catch (e) {
      await rename(aside, dest).catch(() => {});
      throw e;
    }
    await rm(aside, { recursive: true, force: true });
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/**
 * Copy the skills found into `destRoot`.
 *
 * Existing ones are skipped rather than overwritten unless asked — an import
 * that silently replaced something you had edited would be a bad surprise.
 * What could not be taken, and why, is in `skipped`: also a name that was asked
 * for and is not in the repository.
 */
export async function importFromGit(
  spec: string,
  destRoot: string,
  opts: { overwrite?: boolean; only?: string[]; sha?: string } = {}
): Promise<ImportResult> {
  return withClone(spec, async (ctx) => {
    const { entries, skipped, named } = await survey(ctx);
    const wanted = opts.only?.length ? new Set(opts.only) : null;
    const result: ImportResult = { imported: [], skipped: wanted ? skipped.filter((s) => wanted.has(s.name)) : skipped };
    const root = path.resolve(destRoot);

    for (const entry of entries) {
      if (wanted && !wanted.has(entry.name)) continue;
      const dest = path.join(root, entry.name);
      // The name was checked; this holds the path to it as well.
      if (path.dirname(path.resolve(dest)) !== root) {
        result.skipped.push({ name: entry.name, reason: "unusable name" });
        continue;
      }
      const present = await exists(dest);
      if (present && !opts.overwrite) {
        result.skipped.push({ name: entry.name, reason: "already installed" });
        continue;
      }
      const source: SkillSource = {
        spec: withoutLogin(spec),
        url: withoutLogin(ctx.url),
        ref: ctx.ref,
        subpath: ctx.subpath
          ? path.posix.join(ctx.subpath, path.relative(ctx.base, entry.dir))
          : path.relative(ctx.base, entry.dir) || undefined,
        importedAt: new Date().toISOString(),
      };
      try {
        await install(entry.dir, dest, source, present);
        result.imported.push(entry.name);
      } catch (e) {
        result.skipped.push({ name: entry.name, reason: withoutLogin((e as Error).message) });
      }
    }
    for (const name of wanted ?? []) {
      if (!named.has(name)) result.skipped.push({ name, reason: "not in the repository any more" });
    }
    return result;
  }, opts.sha);
}
