import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { getSetting, putSetting } from "../db.js";
import { DATA_DIR as DATA_SETTING } from "../data-dir.js";

/** The data folder, absolute: the rules are compared as absolute paths. */
const DATA_DIR = path.resolve(DATA_SETTING);

/**
 * The sandbox: what the agent may read, change and run, held by the operating
 * system rather than by matching what it asks for.
 *
 * With it on, everything the agent does to files runs as an unprivileged user,
 * `pi-agent`: its shell commands and whatever they start, and the reads,
 * writes, listings and searches of pi's own file tools. What that user may do
 * to a path is set here and put on the files as owner, group and mode, so a
 * way round it (a script of its own, a symlink, an interpreter) meets the same
 * permissions. Its environment is a short list, without the portal's secrets.
 *
 * Trusted commands are the way to what the agent may not read: scripts in a
 * folder it cannot change, run as a second user, `pi-tools`, through a sudo
 * rule pinned to each one. Only that user can read their keys.
 */

/** What the agent may do to a path and what is under it. */
export type Access = "none" | "read" | "write";

export interface SandboxRule {
  path: string;
  access: Access;
  /** Why it is there, for the page; the defaults say. */
  note?: string;
}

export interface TrustedCommand {
  /** What the agent types: a plain command name. */
  name: string;
  /** The script, in the trusted folder. */
  script: string;
}

export interface SandboxPolicy {
  enabled: boolean;
  rules: SandboxRule[];
  trusted: TrustedCommand[];
}

/** The user trusted commands run as; made by the image (see the Dockerfile). Each agent's own user is made as needed (see identity.ts). */
export const TOOLS_USER = "pi-tools";
/** Owns what the agent may change, so the portal (root) and the agent can both write there. */
export const SANDBOX_GROUP = "pi-sandbox";

/** Where trusted commands live, and their keys: neither may the agent change, nor the keys read. */
export const TRUSTED_DIR = path.join(DATA_DIR, "trusted");
export const SECRETS_DIR = path.join(DATA_DIR, ".secrets");
/** The agent's own HOME in the sandbox: caches and tools it installs go here, not into the portal's HOME. */
export const SANDBOX_HOME = path.join(DATA_DIR, "sandbox-home");

const env = (name: string, fallback: string) => process.env[name] || fallback;

/**
 * The policy a portal starts from. Unlisted paths keep the permissions they
 * have, which for most of the system is readable and not writable.
 */
export function defaultRules(): SandboxRule[] {
  const home = path.resolve(env("HOME", "/data/home"));
  return [
    { path: path.resolve(env("WORKSPACE_ROOT", env("WORKSPACES_DIR", "/workspaces"))), access: "write", note: "The projects." },
    { path: path.join(DATA_DIR, "bin"), access: "read", note: "Commands on PATH: run, not changed." },
    { path: SECRETS_DIR, access: "none", note: "Keys for trusted commands." },
    { path: path.join(DATA_DIR, "portal.db"), access: "none", note: "The portal's database, with its settings." },
    { path: home, access: "none", note: "The portal's HOME: pi's auth.json, SSH keys, packages." },
    { path: path.resolve(env("SESSION_DIR", path.join(DATA_DIR, "sessions"))), access: "none", note: "Every chat's transcript." },
    { path: path.join(DATA_DIR, "browser-profile"), access: "none", note: "The browser's cookies and logins." },
    { path: path.join(DATA_DIR, "backups"), access: "none", note: "Database backups." },
    { path: "/certs", access: "none", note: "The portal's TLS key." },
  ];
}

export const DEFAULT_POLICY = (): SandboxPolicy => ({ enabled: false, rules: defaultRules(), trusted: [] });

const ACCESS: readonly Access[] = ["none", "read", "write"];
const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

/** The policy as sent by the page, checked; throws with what is wrong. */
export function parsePolicy(value: unknown): SandboxPolicy {
  const v = value as Partial<SandboxPolicy> | null;
  if (!v || typeof v !== "object") throw new Error("A sandbox policy is an object");
  if (typeof v.enabled !== "boolean") throw new Error("enabled must be true or false");
  if (!Array.isArray(v.rules) || v.rules.length > 200) throw new Error("rules must be a list of at most 200");
  const seen = new Set<string>();
  const rules = v.rules.map((r) => {
    const p = typeof r?.path === "string" ? r.path.trim() : "";
    if (!path.isAbsolute(p)) throw new Error(`"${p}" is not an absolute path`);
    const clean = path.resolve(p);
    if (clean === "/") throw new Error("The whole filesystem cannot be one rule");
    if (!ACCESS.includes(r.access)) throw new Error(`${clean}: access must be none, read or write`);
    if (seen.has(clean)) throw new Error(`${clean} is listed twice`);
    seen.add(clean);
    return { path: clean, access: r.access, ...(typeof r.note === "string" && r.note.trim() ? { note: r.note.trim().slice(0, 200) } : {}) };
  });
  if (!Array.isArray(v.trusted) || v.trusted.length > 100) throw new Error("trusted must be a list of at most 100");
  const names = new Set<string>();
  const trusted = v.trusted.map((t) => {
    const name = typeof t?.name === "string" ? t.name.trim() : "";
    if (!NAME.test(name)) throw new Error(`"${name}" is not a command name: letters, digits, dot, dash and underscore`);
    if (names.has(name)) throw new Error(`${name} is listed twice`);
    names.add(name);
    const script = path.resolve(TRUSTED_DIR, typeof t?.script === "string" && t.script.trim() ? t.script.trim() : name);
    if (path.dirname(script) !== TRUSTED_DIR) throw new Error(`${name}: its script must be directly in ${TRUSTED_DIR}`);
    return { name, script };
  });
  return { enabled: v.enabled, rules, trusted };
}

/** The saved policy, or the default one, off. */
export function sandboxPolicy(): SandboxPolicy {
  try {
    const saved = getSetting("sandbox");
    return saved ? parsePolicy(JSON.parse(saved)) : DEFAULT_POLICY();
  } catch {
    return DEFAULT_POLICY();
  }
}

export function saveSandboxPolicy(policy: SandboxPolicy): void {
  putSetting("sandbox", JSON.stringify(policy));
}

/** A user's or group's id, or null where it does not exist. */
export function idOf(kind: "user" | "group", name: string): number | null {
  try {
    const line = execFileSync("getent", [kind === "user" ? "passwd" : "group", name], { encoding: "utf8" }).trim();
    const id = Number(line.split(":")[2]);
    return Number.isInteger(id) ? id : null;
  } catch {
    return null;
  }
}

export interface SandboxSupport {
  available: boolean;
  /** Why not, in a sentence for the page. */
  reason?: string;
  ids?: { tools: number; group: number };
}

/**
 * Whether this portal can sandbox at all: Linux, running as root (it has to
 * change to the agents' users and set permissions), with the user, group and
 * tools the image installs. A native install without them says so instead.
 */
export function sandboxSupport(): SandboxSupport {
  if (process.platform !== "linux") return { available: false, reason: "The sandbox needs Linux: it runs the agent as another user." };
  if (process.getuid?.() !== 0) return { available: false, reason: "The portal runs as a user that cannot change to another: the sandbox needs it to run as root, as the Docker image does." };
  const tools = idOf("user", TOOLS_USER), group = idOf("group", SANDBOX_GROUP);
  if (tools === null || group === null) {
    return { available: false, reason: `The user ${TOOLS_USER} and the group ${SANDBOX_GROUP} do not exist here. The Docker image makes them; on another install, create them as the docs describe.` };
  }
  for (const tool of ["setpriv", "sudo", "useradd", "groupadd"]) {
    if (!["/usr/bin", "/bin", "/usr/sbin", "/sbin"].some((d) => existsSync(path.join(d, tool)))) {
      return { available: false, reason: `${tool} is not installed.` };
    }
  }
  return { available: true, ids: { tools, group } };
}

/** Whether the agent works in the sandbox now: switched on, and possible here. */
export function sandboxOn(): boolean {
  return sandboxPolicy().enabled && sandboxSupport().available;
}

/** The rule that decides a path: the most specific one above or at it, or none. */
export function ruleFor(policy: SandboxPolicy, target: string): SandboxRule | undefined {
  const clean = path.resolve(target);
  let best: SandboxRule | undefined;
  for (const rule of policy.rules) {
    if (clean === rule.path || clean.startsWith(rule.path.endsWith("/") ? rule.path : `${rule.path}/`)) {
      if (!best || rule.path.length > best.path.length) best = rule;
    }
  }
  return best;
}
