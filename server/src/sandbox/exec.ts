import { spawn } from "node:child_process";
import type { Identity } from "./identity.js";

/**
 * Doing things as an agent's user in the sandbox: its shell commands, and what
 * pi's file tools do to files, so that the kernel decides each of them by the
 * permissions the policy put on the files.
 */

/** Who something runs as: an agent's user, its own group and the sandbox group's. */
export type Who = Pick<Identity, "user" | "uid" | "gid" | "shared" | "home" | "tmp">;

/**
 * The argv that runs the rest as the agent's user: its uid, its own group and
 * the sandbox group, and no capabilities carried over. New privileges are not
 * blocked: sudo has to be able to run a trusted command as `pi-tools`, which
 * the sudoers rules restrict to exactly those commands.
 */
export function asAgent(who: Who): string[] {
  return ["setpriv", `--reuid=${who.uid}`, `--regid=${who.gid}`, `--groups=${who.gid},${who.shared}`, "--inh-caps=-all", "--"];
}

/** Variables passed on: the shell's and the terminal's, and pi's own session metadata. */
const KEEP = new Set(["PATH", "LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE", "TERM", "TZ", "COLUMNS", "LINES", "NO_COLOR", "FORCE_COLOR", "PITHAGORAS_AGENT"]);

/**
 * The sandbox's environment: a short list, nothing else. The portal's own
 * holds its password, its secret and provider keys, and a command could print
 * them with `env`. pi's PI_* session variables stay (they say which session
 * this is), except the ones that point into the portal's HOME.
 */
export function sandboxEnv(base: NodeJS.ProcessEnv, who: Who): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (KEEP.has(key) || (key.startsWith("PI_") && key !== "PI_CODING_AGENT_DIR" && !/KEY|TOKEN|SECRET|PASSWORD/.test(key))) out[key] = value;
  }
  // Its own HOME and temporary folder: /tmp is everyone's, and a file one agent left there another could read.
  out.HOME = who.home;
  out.USER = who.user;
  out.LOGNAME = who.user;
  out.SHELL = "/bin/bash";
  out.TMPDIR = who.tmp;
  // The projects belong to root and the agent works in them as its own user, which git takes for a repository
  // someone else put there ("dubious ownership"). Trusted here, through git's own environment config, so
  // no file of anyone's changes. A command that sets its own keeps them: git counts them from 0 again.
  if (!out.GIT_CONFIG_COUNT) {
    out.GIT_CONFIG_COUNT = "1";
    out.GIT_CONFIG_KEY_0 = "safe.directory";
    out.GIT_CONFIG_VALUE_0 = "*";
  }
  out.PATH ??= "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
  return out;
}

/** A word for sh, quoted so nothing in it is read as shell syntax. */
export const shQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * pi's bash spawn hook: the command, as typed, run by bash as the agent's user, with
 * a umask that leaves what it makes writable for the group, so the portal and
 * the agent can both change it later.
 */
export function bashSpawnHook(who: Who) {
  return (context: { command: string; cwd: string; env: NodeJS.ProcessEnv }) => ({
    command: `exec ${asAgent(who).join(" ")} /bin/bash -c ${shQuote(`umask 002\n${context.command}`)}`,
    cwd: context.cwd,
    env: sandboxEnv(context.env, who),
  });
}

interface Ran {
  code: number | null;
  stdout: Buffer;
  stderr: string;
}

/** Runs argv as the agent's user, with `input` on stdin; never throws for a non-zero exit. */
export function runAsAgent(who: Who, argv: string[], input?: Buffer | string, options: { cwd?: string; signal?: AbortSignal } = {}): Promise<Ran> {
  return new Promise((resolve, reject) => {
    const [cmd, ...args] = [...asAgent(who), ...argv];
    // stdin only where there is something to send. A command that does not read it can be gone
    // before it is written; the write then fails with EPIPE, which unheard would end the portal.
    const child = spawn(cmd, args, { env: sandboxEnv(process.env, who), cwd: options.cwd ?? "/", stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
    options.signal?.addEventListener("abort", () => child.kill("SIGTERM"), { once: true });
    const out: Buffer[] = [];
    let err = "";
    child.stdout!.on("data", (d: Buffer) => out.push(d));
    child.stderr!.on("data", (d: Buffer) => (err += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout: Buffer.concat(out), stderr: err.trim() }));
    if (child.stdin) {
      child.stdin.on("error", () => {});
      child.stdin.end(input);
    }
  });
}

/** An error as fs would throw it, from what the command said: "Permission denied" reads as EACCES. */
function fsError(op: string, target: string, ran: Ran): Error {
  const denied = /permission denied|operation not permitted/i.test(ran.stderr);
  const missing = /no such file|not a directory/i.test(ran.stderr);
  const code = denied ? "EACCES" : missing ? "ENOENT" : "EIO";
  const why = denied ? "the sandbox does not let the agent do that here" : ran.stderr || `exit ${ran.code}`;
  const e = new Error(`${op} ${target}: ${why}`) as NodeJS.ErrnoException;
  e.code = code;
  e.path = target;
  return e;
}

/**
 * What pi's file tools do to files, done as the agent's user: read, write,
 * edit and ls. grep and find run whole as the agent: see runToolAsAgent.
 */
export function fileOperations(who: Who) {
  const run = (argv: string[], input?: Buffer | string) => runAsAgent(who, argv, input);
  const test = async (flag: string, p: string) => (await run(["test", flag, p])).code === 0;
  /**
   * Whether a path is there. A path inside a folder the sandbox may not enter
   * counts as there: "not found" would send the agent looking elsewhere, when
   * the truth is that it may not look.
   */
  const exists = async (p: string) => {
    const ran = await run(["stat", "--", p]);
    return ran.code === 0 || /permission denied/i.test(ran.stderr);
  };
  const readFile = async (p: string) => {
    const ran = await run(["cat", "--", p]);
    if (ran.code !== 0) throw fsError("read", p, ran);
    return ran.stdout;
  };
  const writeFile = async (p: string, content: string) => {
    const ran = await run(["sh", "-c", 'umask 002; cat > "$1"', "sh", p], content);
    if (ran.code !== 0) throw fsError("write", p, ran);
  };
  // Opening it says which it is, missing or not allowed, where test(1) says only "no".
  const access = async (p: string, write = false) => {
    const ran = await run(["head", "-c", "0", "--", p]);
    if (ran.code !== 0) throw fsError("access", p, ran);
    if (write && !(await test("-w", p))) throw fsError("access", p, { code: 1, stdout: Buffer.alloc(0), stderr: "Permission denied" });
  };
  return {
    read: { readFile, access: (p: string) => access(p) },
    write: {
      writeFile,
      mkdir: async (dir: string) => {
        const ran = await run(["sh", "-c", 'umask 002; mkdir -p -- "$1"', "sh", dir]);
        if (ran.code !== 0) throw fsError("mkdir", dir, ran);
      },
    },
    edit: { readFile, writeFile, access: (p: string) => access(p, true) },
    ls: {
      exists,
      stat: async (p: string) => {
        const ran = await run(["stat", "-c", "%F", "--", p]);
        if (ran.code !== 0) throw fsError("stat", p, ran);
        const dir = ran.stdout.toString().trim() === "directory";
        return { isDirectory: () => dir };
      },
      readdir: async (p: string) => {
        const ran = await run(["find", p, "-mindepth", "1", "-maxdepth", "1", "-printf", "%f\\0"]);
        if (ran.code !== 0) throw fsError("list", p, ran);
        return ran.stdout.toString("utf8").split("\0").filter(Boolean);
      },
    },
  };
}

/** Where pi is, for a process of the agent's own to load it from. */
const PI_MODULE = import.meta.resolve("@earendil-works/pi-coding-agent");

/** What the agent's process runs: pi's own tool, made and run as pi makes and runs it, its answer as JSON. */
const TOOL_RUNNER = `
let input = "";
for await (const chunk of process.stdin) input += chunk;
const { module, tool, cwd, params } = JSON.parse(input);
const pi = await import(module);
const make = { grep: pi.createGrepTool, find: pi.createFindTool }[tool];
try {
  const result = await make(cwd).execute("sandbox", params);
  process.stdout.write(JSON.stringify({ result }));
} catch (e) {
  process.stdout.write(JSON.stringify({ error: String(e?.message ?? e) }));
}
`;

/**
 * pi's grep or find, run whole by a process of the agent's own: the search
 * (rg, fd) as well as the reading, so it finds only what that agent may read.
 * The answer is pi's own, as its tool would have given it in the portal.
 */
export async function runToolAsAgent(who: Who, tool: "grep" | "find", cwd: string, params: unknown, signal?: AbortSignal) {
  const ran = await runAsAgent(who, [process.execPath, "--input-type=module", "-e", TOOL_RUNNER], JSON.stringify({ module: PI_MODULE, tool, cwd, params }), { cwd, signal });
  let answer: { result?: unknown; error?: string };
  try {
    answer = JSON.parse(ran.stdout.toString("utf8"));
  } catch {
    throw new Error(`${tool} could not run in the sandbox: ${ran.stderr.split("\n").slice(-3).join(" ") || `exit ${ran.code}`}`);
  }
  if (answer.error) throw new Error(answer.error);
  return answer.result as { content: { type: "text"; text: string }[]; details: unknown };
}
