import path from "node:path";
import { agentsRoot, listAgents } from "./agents.js";
import { getDb } from "./db.js";
import { listProjects } from "./projects.js";
import { isWithinText, pathBelow, realPath } from "./within.js";
import { workspaceRoot } from "./workspaces.js";
import { baseDir } from "./workspace-files.js";

/**
 * The folders the agents work in, as the portal knows them: what the galleries look through for what the agents made
 * (media-folders.ts) and what a server half is given (`portal.folders`). Each is a real path: a folder reached by a
 * link is named by where it is.
 */

/** A folder the agents work in: an agent's home, a project, or one a chat works in that is neither. */
export interface AgentFolder {
  path: string;
  /** What the person calls it: its agent for an agent's home, else its place under the workspace root. */
  name: string;
  kind: "agent" | "project" | "chat";
  /** The first agent's home, which the sidebar calls Home. */
  home?: true;
}

/** What a folder is called to the person: its agent for an agent's home, else its place under the workspace root (a project's name, or the way to a folder in one). `home` marks the first agent's home. */
export function folderLabel(folder: string): { name: string; home: boolean } {
  const agents = listAgents();
  const agent = agents.find((a) => realPath(a.home) === folder);
  // Named after its agent, as the sidebar names it. The first agent's home stays the one that is Home.
  if (agent) return { name: agent.name, home: agent === agents[0] };
  const inRoot = pathBelow(realPath(workspaceRoot()) ?? workspaceRoot(), folder);
  return { name: inRoot || path.basename(folder), home: false };
}

/**
 * Whether a folder, real, is one a file may be found in or served from: the
 * home of an agent, a folder made for one in `agents/` (that of an agent that was
 * deleted with its folder kept stays one, with its files, for the agent
 * made under the same name to take up again) or inside the workspace root, as
 * a chat's folder has to be. Asked once for all the folders a pass looks at.
 */
export function folderAllowed(): (real: string) => boolean {
  const homes = new Set(listAgents().map((a) => realPath(a.home)));
  const made = realPath(agentsRoot());
  const root = realPath(workspaceRoot());
  return (real) => homes.has(real) || (made !== null && path.dirname(real) === made) || (root !== null && isWithinText(root, real));
}

/**
 * Every folder the agents work in, each once: the agents' homes, the projects, and the folders chats of any kind work
 * in. One that cannot be reached, or is not one a file may be found in (folderAllowed), is not listed.
 */
export function listFolders(): AgentFolder[] {
  const allowed = folderAllowed();
  const found = new Map<string, AgentFolder>();
  const add = (dir: string | null, kind: AgentFolder["kind"]) => {
    if (!dir) return;
    let real: string;
    try {
      real = baseDir(dir);
    } catch {
      // Not there, or out of reach: nothing to look at.
      return;
    }
    if (!allowed(real) || found.has(real)) return;
    const { name, home } = folderLabel(real);
    found.set(real, { path: real, name, kind, ...(home ? { home: true as const } : {}) });
  };
  for (const agent of listAgents()) add(agent.home, "agent");
  try {
    for (const project of listProjects(workspaceRoot())) add(project.path, "project");
  } catch {
    // No workspace root yet.
  }
  for (const row of getDb().prepare("SELECT DISTINCT workspace AS dir FROM sessions").all() as { dir: string | null }[]) add(row.dir, "chat");
  return [...found.values()];
}
