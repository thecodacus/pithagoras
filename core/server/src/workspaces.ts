import { existsSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { agentHomePath } from "./agent-home.js";
import { agentAt, agentOf, agentsRoot } from "./agents.js";
import { isWithinText, pathBelow, realPath } from "./within.js";

/** Where projects live. WORKSPACE_ROOT is the new name; WORKSPACES_DIR still works for existing deploys. */
export function workspaceRoot(): string {
  return path.resolve(process.env.WORKSPACE_ROOT || process.env.WORKSPACES_DIR || "/workspaces");
}

/**
 * Where a chat or a routine may run: Home — the agent's own directory — or
 * somewhere inside the workspace root, judged by where the path really leads.
 * A bare name is a project under the root.
 */
export function checkWorkspace(raw: string): { path: string } | { error: string } {
  const root = workspaceRoot();
  const resolved = path.isAbsolute(raw) ? path.resolve(raw) : path.join(root, raw);
  // An agent's home is the one place outside the workspace root a chat may work in.
  if (resolved === agentHomePath() || agentAt(resolved)) return { path: resolved };
  // Keep pi inside the mounted workspace area — no escaping to the rest of the FS.
  if (!isWithinText(root, resolved)) {
    // Where an agent's home was, with no agent there now: said so, or the one who
    // set it is sent looking for a project that was never meant to be one. Only a
    // folder directly in the agents' folder was ever a home.
    const inAgents = pathBelow(agentsRoot(), resolved);
    if (inAgents && !inAgents.includes("/")) return { error: "the agent whose home this was has been deleted" };
    // A folder in the home of an agent that is there: its home itself is the place, not what is in it.
    if (agentOf(resolved)) return { error: "only an agent's home itself can be used, not a folder in it" };
    return { error: "workspace must be inside the workspace root" };
  }
  if (!existsSync(resolved)) return { error: "workspace does not exist" };
  // The folder can go between one look and the next, or not be ours to read.
  // Either is an answer about this place, never a failure of the caller.
  try {
    // The check above is on the text of the path, and a link inside the root
    // passes it while leading anywhere. Where it really points must be inside too.
    const real = realpathSync(resolved);
    const realRoot = realpathSync(root);
    if (!isWithinText(realRoot, real)) {
      return { error: "workspace must be inside the workspace root" };
    }
    // A file would be taken as far as the launch, and every run would fail there.
    if (!statSync(real).isDirectory()) return { error: "workspace is not a directory" };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return { error: code === "ENOENT" ? "workspace does not exist" : `workspace cannot be read (${code ?? (e as Error).message})` };
  }
  return { path: resolved };
}

/**
 * The project a chat or a routine works in, by its folder's name: the one
 * directly under the root that `workspace` is, or is inside — a chat may run in
 * a subfolder, and it belongs to the project all the same. Home, and anywhere
 * else outside the root, is none.
 *
 * Judged by where the path really leads, as checkWorkspace does, so that a link
 * in one project to another does not borrow the first one's settings while
 * working in the second. The text of the path decides only where that cannot be
 * followed, such as a folder that is gone.
 */
export function projectOf(workspace: string | null | undefined): string | undefined {
  if (!workspace) return undefined;
  const root = workspaceRoot();
  const realRoot = realPath(root);
  const real = realRoot && realPath(workspace);
  const inside = realRoot && real ? pathBelow(realRoot, real) : pathBelow(root, workspace);
  const name = inside?.split("/")[0];
  // Not one resolveProject would accept either: a project's name is never a dot-name.
  return name && !name.startsWith(".") ? name : undefined;
}

/** Why a routine's place cannot be used now, such as a project that was deleted; null when it can. Home always can. */
export function placeProblem(workspace: string | null): string | null {
  if (!workspace) return null;
  const where = checkWorkspace(workspace);
  return "error" in where ? where.error : null;
}

/**
 * Where a routine runs, as the page or the agent asked for it. Nothing, "" or
 * "home" is Home (a project called "home" is still reached by its path).
 * Anything else must be a place a chat could run. Home is kept as null, so
 * that a routine follows it if AGENT_HOME moves.
 */
export function routinePlace(raw: unknown): { workspace: string | null } | { error: string } {
  if (raw === undefined || raw === null) return { workspace: null };
  if (typeof raw !== "string") return { error: "workspace must be a project's name or path, or null for Home" };
  const text = raw.trim();
  if (!text || /^home$/i.test(text)) return { workspace: null };
  const where = checkWorkspace(text);
  if ("error" in where) return where;
  return { workspace: where.path === agentHomePath() ? null : where.path };
}
