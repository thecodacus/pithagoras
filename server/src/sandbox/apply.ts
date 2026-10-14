import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, chownSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { getSetting, putSetting } from "../db.js";
import { DATA_DIR as DATA_SETTING } from "../data-dir.js";
import { piAgentDir } from "../pi-settings.js";
import { agentOf, agentsRoot, listAgents, type Agent } from "../agents.js";
import { identityOf } from "./identity.js";
import { SANDBOX_GROUP, SANDBOX_HOME, SECRETS_DIR, TOOLS_USER, TRUSTED_DIR, ruleFor, type SandboxPolicy, type SandboxSupport } from "./policy.js";

/**
 * Puts a policy on the files: owner, group and mode for each rule, each
 * agent's own folders, and the trusted commands' folder, keys and sudo rules.
 *
 * - none: the path's group is root's and neither group nor others may do
 *   anything with it. For a folder that closes everything under it. The keys'
 *   folder keeps the trusted commands' group, which may read it.
 * - read: readable and runnable by everyone, writable by nobody but root,
 *   under it as well.
 * - write: the sandbox group owns it and may write, under it as well, and
 *   folders hand that group on to what is made in them.
 *
 * The rules go on from the widest to the narrowest, so a narrower one under a
 * wider one has the last word.
 *
 * The agents' homes and their HOMEs in the sandbox are no rule's: each belongs
 * to its own agent's group alone, so one agent cannot read another's (see
 * identity.ts). The folders that hold them can be passed through, not listed.
 */

const run = promisify(execFile);
const DATA_DIR = path.resolve(DATA_SETTING);
/** Where the portal keeps the sandbox's state: whether it is on, for the search wrappers. */
export const STATE_DIR = path.join(DATA_DIR, "sandbox");
export const ON_FLAG = path.join(STATE_DIR, "enabled");
const SUDOERS = "/etc/sudoers.d/pithagoras-sandbox";
const WRAPPER_MARK = "# pithagoras sandbox: generated";
const BIN_DIR = path.join(DATA_DIR, "bin");

export interface ApplyReport {
  ok: boolean;
  /** One line per thing done, for the page. */
  done: string[];
  /** What it could not do, or would not. */
  warnings: string[];
}

type Ids = NonNullable<SandboxSupport["ids"]>;

/** Rules in the order they go on: widest first. */
const widestFirst = (policy: SandboxPolicy) => [...policy.rules].sort((a, b) => a.path.length - b.path.length);

/** What was last put on the files with the recursive parts, so a start that changes nothing does not walk every tree again. */
export const rulesHash = (policy: SandboxPolicy) => createHash("sha256").update(JSON.stringify(widestFirst(policy))).digest("hex").slice(0, 16);

async function recursive(args: string[], report: ApplyReport) {
  try {
    await run(args[0], args.slice(1), { maxBuffer: 1 << 20 });
  } catch (e) {
    report.warnings.push(`${args.join(" ")}: ${(e as Error).message.split("\n")[0]}`);
  }
}

/**
 * Makes the folders above a path passable by others (x, not r), so the
 * sandbox can reach what a rule opens. Not past a folder a rule closes.
 */
function passable(policy: SandboxPolicy, target: string, report: ApplyReport) {
  for (let dir = path.dirname(target); dir !== path.dirname(dir); dir = path.dirname(dir)) {
    const above = ruleFor(policy, dir);
    if (above?.access === "none") {
      report.warnings.push(`${target} is inside ${above.path}, which the agent may not enter: it cannot reach it.`);
      return;
    }
    try {
      const mode = statSync(dir).mode;
      if (!(mode & 0o001)) {
        chmodSync(dir, (mode & 0o7777) | 0o001);
        report.done.push(`${dir}: others may pass through`);
      }
    } catch {
      return;
    }
  }
}

async function applyRules(policy: SandboxPolicy, ids: Ids, report: ApplyReport, deep: boolean) {
  for (const rule of widestFirst(policy)) {
    // Each rule on its own: one that cannot be put on must not leave the rest undone, as /certs on a
    // read-only mount once did to every rule after it.
    try {
      await applyRule(policy, rule, ids, report, deep);
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === "EROFS") report.done.push(`${rule.path}: on a read-only filesystem, left as it is`);
      else {
        report.ok = false;
        report.warnings.push(`${rule.path}: ${err.message}`);
      }
    }
  }
}

/** The folders kept per agent rather than by the rules: the homes, the folder of the other agents', the sandbox HOMEs. */
function perAgent(target: string): boolean {
  const inside = (dir: string) => target === dir || target.startsWith(`${dir}/`);
  return [SANDBOX_HOME, agentsRoot(), ...listAgents().map((a) => a.home)].some((dir) => inside(path.resolve(dir)));
}

async function applyRule(policy: SandboxPolicy, rule: SandboxPolicy["rules"][number], ids: Ids, report: ApplyReport, deep: boolean) {
  if (perAgent(rule.path)) {
    report.done.push(`${rule.path}: kept per agent`);
    return;
  }
  if (!existsSync(rule.path)) {
    // Put on when it appears, on the next apply.
    report.done.push(`${rule.path}: not there yet`);
    return;
  }
  const dir = lstatSync(rule.path).isDirectory();
  if (rule.access === "none") {
    const keys = rule.path === SECRETS_DIR;
    chownSync(rule.path, 0, keys ? ids.tools : 0);
    chmodSync(rule.path, dir ? (keys ? 0o750 : 0o700) : keys ? 0o640 : 0o600);
    // A database's journal holds what was written last: SQLite keeps it beside the file, readable unless closed too.
    if (!dir) {
      for (const side of ["-wal", "-shm", "-journal"]) {
        const sibling = `${rule.path}${side}`;
        if (existsSync(sibling)) {
          chownSync(sibling, 0, 0);
          chmodSync(sibling, 0o600);
        }
      }
    }
    report.done.push(`${rule.path}: no access`);
    return;
  }
  passable(policy, rule.path, report);
  if (rule.access === "read") {
    if (deep && dir) {
      await recursive(["chown", "-R", "--no-dereference", ":0", rule.path], report);
      await recursive(["chmod", "-R", "go-w,o+rX", rule.path], report);
    } else {
      chownSync(rule.path, statSync(rule.path).uid, 0);
      chmodSync(rule.path, (statSync(rule.path).mode & 0o7777 & ~0o022) | (dir ? 0o005 : 0o004));
    }
    report.done.push(`${rule.path}: read-only`);
  } else {
    if (deep && dir) {
      await recursive(["chown", "-R", "--no-dereference", `:${ids.group}`, rule.path], report);
      await recursive(["chmod", "-R", "g+rwX", rule.path], report);
      await recursive(["find", rule.path, "-type", "d", "-exec", "chmod", "g+s", "{}", "+"], report);
    } else {
      chownSync(rule.path, statSync(rule.path).uid, ids.group);
      chmodSync(rule.path, (statSync(rule.path).mode & 0o7777) | (dir ? 0o2070 : 0o060));
    }
    report.done.push(`${rule.path}: read and write`);
  }
}

/** The script a trusted command runs, and the wrapper on PATH the agent calls it by. */
function wrapper(script: string) {
  return `#!/bin/sh\n${WRAPPER_MARK}: runs ${script} as ${TOOLS_USER}, which only sudo may do.\nexec sudo -n -u ${TOOLS_USER} -- ${script} "$@"\n`;
}

const isOurs = (file: string) => {
  try {
    return readFileSync(file, "utf8").includes(WRAPPER_MARK);
  } catch {
    return false;
  }
};

async function applyTrusted(policy: SandboxPolicy, ids: Ids, report: ApplyReport) {
  mkdirSync(TRUSTED_DIR, { recursive: true });
  chownSync(TRUSTED_DIR, 0, 0);
  chmodSync(TRUSTED_DIR, 0o755);
  mkdirSync(SECRETS_DIR, { recursive: true });
  chownSync(SECRETS_DIR, 0, ids.tools);
  chmodSync(SECRETS_DIR, 0o750);
  for (const name of readdirSync(SECRETS_DIR)) {
    const file = path.join(SECRETS_DIR, name);
    if (!lstatSync(file).isFile()) continue;
    chownSync(file, 0, ids.tools);
    chmodSync(file, 0o640);
  }
  mkdirSync(BIN_DIR, { recursive: true });

  const lines: string[] = [];
  for (const t of policy.trusted) {
    const onPath = path.join(BIN_DIR, t.name);
    // A command already on PATH under that name, not one of ours, is taken in: moved to the trusted folder.
    if (!existsSync(t.script) && existsSync(onPath) && !isOurs(onPath)) {
      renameSync(onPath, t.script);
      report.done.push(`${t.name}: moved from ${BIN_DIR} into ${TRUSTED_DIR}`);
    }
    if (!existsSync(t.script)) {
      report.warnings.push(`${t.name}: ${t.script} does not exist; put the script there.`);
      continue;
    }
    chownSync(t.script, 0, 0);
    chmodSync(t.script, 0o755);
    if (existsSync(onPath) && !isOurs(onPath)) {
      report.warnings.push(`${t.name}: ${onPath} is something else of the same name; left alone, so the agent runs that one.`);
    } else {
      writeFileSync(onPath, wrapper(t.script), { mode: 0o755 });
      chownSync(onPath, 0, 0);
    }
    lines.push(`%${SANDBOX_GROUP} ALL=(${TOOLS_USER}) NOPASSWD: ${t.script}`);
    report.done.push(`${t.name}: runs ${t.script} as ${TOOLS_USER}`);
  }
  // Wrappers for commands no longer trusted go, so nothing calls a sudo rule that is not there.
  for (const name of readdirSync(BIN_DIR)) {
    const file = path.join(BIN_DIR, name);
    if (isOurs(file) && !policy.trusted.some((t) => t.name === name)) {
      rmSync(file);
      report.done.push(`${name}: no longer trusted, wrapper removed`);
    }
  }

  const sudoers = `# Written by the Pithagoras sandbox: the agents may run exactly these as ${TOOLS_USER}.\n` +
    `Defaults:%${SANDBOX_GROUP} !requiretty, env_reset\n${lines.join("\n")}\n`;
  if (!existsSync(path.dirname(SUDOERS))) {
    report.warnings.push(`${path.dirname(SUDOERS)} does not exist: sudo is not set up, so trusted commands will not run.`);
    return;
  }
  const draft = `${SUDOERS}.new`;
  writeFileSync(draft, sudoers, { mode: 0o440 });
  try {
    await run("visudo", ["-cf", draft]);
    renameSync(draft, SUDOERS);
  } catch (e) {
    rmSync(draft, { force: true });
    report.warnings.push(`The sudo rules did not check out, so they were not changed: ${(e as Error).message.split("\n")[0]}`);
  }
}

/**
 * The rg and fd wrappers an earlier sandbox put in pi's tools folder, taken
 * out: grep and find now run whole as the chat's own agent (exec.ts,
 * runToolAsAgent), which a wrapper shared by every chat could not know. A
 * binary pi had downloaded there goes back in its place.
 */
function removeToolWrappers(report: ApplyReport) {
  const dir = path.join(piAgentDir(), "bin");
  for (const tool of ["rg", "fd"]) {
    const file = path.join(dir, tool);
    if (!isOurs(file)) continue;
    rmSync(file);
    if (existsSync(`${file}.real`)) renameSync(`${file}.real`, file);
    report.done.push(`${tool}: the old search wrapper removed`);
  }
}

/**
 * One agent's folders, its own: its home and its HOME in the sandbox belong to
 * its group, with nothing for anyone else, and folders hand the group on to
 * what is made in them. `deep` walks the home, for what was made in it before
 * (by the portal, or by another user).
 */
async function applyAgent(agent: Agent, support: SandboxSupport, report: ApplyReport, deep: boolean) {
  const who = identityOf(agent, support);
  for (const dir of [who.home, who.tmp]) {
    mkdirSync(dir, { recursive: true });
    chownSync(dir, 0, who.gid);
    chmodSync(dir, 0o2770);
  }
  if (!existsSync(agent.home)) return;
  if (deep) {
    await recursive(["chown", "-R", "--no-dereference", `:${who.gid}`, agent.home], report);
    await recursive(["chmod", "-R", "g+rwX,o-rwx", agent.home], report);
    await recursive(["find", agent.home, "-type", "d", "-exec", "chmod", "g+s", "{}", "+"], report);
  }
  chownSync(agent.home, 0, who.gid);
  chmodSync(agent.home, 0o2770);
  report.done.push(`${agent.home}: ${who.user}'s only`);
}

/** Every agent's folders, and the folders that hold them: passed through, not listed. */
async function applyAgents(support: SandboxSupport, report: ApplyReport, deep: boolean) {
  for (const dir of [SANDBOX_HOME, agentsRoot()]) {
    mkdirSync(dir, { recursive: true });
    chownSync(dir, 0, 0);
    chmodSync(dir, 0o711);
  }
  // What the earlier sandbox user, shared by all, left in the sandbox HOME is nobody's now.
  for (const name of readdirSync(SANDBOX_HOME)) {
    if (listAgents().some((a) => a.id === name)) continue;
    const old = path.join(SANDBOX_HOME, name);
    chownSync(old, 0, 0);
    chmodSync(old, lstatSync(old).isDirectory() ? 0o700 : 0o600);
  }
  for (const agent of listAgents()) {
    try {
      await applyAgent(agent, support, report, deep);
    } catch (e) {
      report.ok = false;
      report.warnings.push(`${agent.name}: ${(e as Error).message}`);
    }
  }
}

/**
 * Puts the policy on. `deep` walks every tree a read or write rule covers,
 * which can take a while on a big workspace: on a save, and on a start where
 * the rules changed since the last one. A start with the same rules only puts
 * back what lives outside the data volume (the sudo rules) and the top of
 * each rule.
 */
export async function applySandbox(policy: SandboxPolicy, support: SandboxSupport, deep: boolean): Promise<ApplyReport> {
  const report: ApplyReport = { ok: true, done: [], warnings: [] };
  if (!support.available || !support.ids) {
    return { ok: false, done: [], warnings: [support.reason ?? "The sandbox is not available here."] };
  }
  mkdirSync(STATE_DIR, { recursive: true });
  chmodSync(STATE_DIR, 0o755);
  if (!policy.enabled) {
    rmSync(ON_FLAG, { force: true });
    report.done.push("The sandbox is off: the agent works as the portal's user.");
    return report;
  }
  try {
    await applyRules(policy, support.ids, report, deep);
    await applyAgents(support, report, deep);
    await applyTrusted(policy, support.ids, report);
    removeToolWrappers(report);
  } catch (e) {
    report.ok = false;
    report.warnings.push((e as Error).message);
  }
  // Only a whole apply counts as applied, so the next start tries again.
  writeFileSync(ON_FLAG, "on\n", { mode: 0o644 });
  if (report.ok && deep) putSetting("sandbox_applied", rulesHash(policy));
  return report;
}

/**
 * A chat's folder, made writable again for the sandbox where a write rule says
 * it is, before the chat starts: what was added to it since the policy was put
 * on (a project cloned or created by the host's root, with root's umask) is not
 * the sandbox group's yet, and the agent could not change it. Only that folder,
 * so a start does not walk every project.
 */
export async function prepareFolder(policy: SandboxPolicy, support: SandboxSupport, folder: string): Promise<void> {
  if (!policy.enabled || !support.ids || !existsSync(folder)) return;
  const report: ApplyReport = { ok: true, done: [], warnings: [] };
  // An agent's home is that agent's: made its group's again, whatever was put in it since.
  const owner = agentOf(folder);
  if (owner) {
    await applyAgent(owner, support, report, true);
    if (report.warnings.length) console.log(`[sandbox] ${folder}: ${report.warnings.join("; ")}`);
    return;
  }
  if (ruleFor(policy, folder)?.access !== "write") return;
  await recursive(["chown", "-R", "--no-dereference", `:${support.ids.group}`, folder], report);
  await recursive(["chmod", "-R", "g+rwX", folder], report);
  await recursive(["find", folder, "-type", "d", "-exec", "chmod", "g+s", "{}", "+"], report);
  // A narrower rule inside it keeps its word: put the rules again that lie under this folder.
  const inside = policy.rules.filter((r) => r.path !== folder && r.path.startsWith(`${folder}/`));
  if (inside.length) await applyRules({ ...policy, rules: inside }, support.ids, report, true);
  if (report.warnings.length) console.log(`[sandbox] ${folder}: ${report.warnings.join("; ")}`);
}

/** At start: the whole policy again if its rules changed since they were last put on, else the quick part. */
export function applyOnStart(policy: SandboxPolicy, support: SandboxSupport): Promise<ApplyReport> {
  return applySandbox(policy, support, getSetting("sandbox_applied") !== rulesHash(policy));
}
