import path from "node:path";
import { agentOf, agentsRoot, firstAgent, listAgents, newChatAgent } from "./agents.js";
import { getDb } from "./db.js";
import { listProjects } from "./projects.js";
import { isWithinText, pathBelow, realPath } from "./within.js";
import { projectOf, workspaceRoot } from "./workspaces.js";
import { baseDir } from "./workspace-files.js";

/**
 * The folders the agents work in, as the portal knows them: what a server half is given (`portal.folders`). Each is a
 * real path: a folder reached by a link is named by where it is.
 */

/** A folder the agents work in: an agent's home, a project, or one a chat works in that is neither. */
export interface AgentFolder {
  path: string;
  /** What the person calls it: its agent for an agent's home, else its place under the workspace root. */
  name: string;
  kind: "agent" | "project" | "chat";
  /** The first agent's home: defaultAgent's, the agent a chat, a channel or a routine goes to when none is named. */
  home?: true;
  /** The home of the agent the New button starts chats with: newChatAgent's, the first agent unless the person picked another. */
  newChats?: true;
}

/**
 * What a folder is called to the person: its agent for an agent's home, else its place under the workspace root (a
 * project's name, or the way to a folder in one). `home` marks the first agent's home and `newChats` the home of the
 * agent New starts chats with, each found by the function the rest of the portal asks (firstAgent, newChatAgent).
 */
export function folderLabel(folder: string): { name: string; home: boolean; newChats: boolean } {
  const agents = listAgents();
  const agent = agents.find((a) => realPath(a.home) === folder);
  // Named after its agent, as the sidebar names it.
  if (agent) return { name: agent.name, home: agent.id === firstAgent(agents).id, newChats: agent.id === newChatAgent(agents).id };
  const inRoot = pathBelow(realPath(workspaceRoot()) ?? workspaceRoot(), folder);
  return { name: inRoot || path.basename(folder), home: false, newChats: false };
}

/** A folder as list names it, by its real path, with the marks that are true of it only. */
function entryOf(real: string, kind: AgentFolder["kind"]): AgentFolder {
  const { name, home, newChats } = folderLabel(real);
  return { path: real, name, kind, ...(home ? { home: true as const } : {}), ...(newChats ? { newChats: true as const } : {}) };
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
    found.set(real, entryOf(real, kind));
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

/** Whose a chat is: its agent's home or its project's folder, as list gives it. */
export type ChatOwner = AgentFolder & { kind: "agent" | "project" };

/**
 * Whose a chat working in `workspace` (as stored for it) is: the agent whose home it works in, by the rule the sandbox
 * picks the user a chat runs as by (agentOf on the stored workspace: a link in it that leads elsewhere changes
 * nothing), else the project it works in, by the rule a project's settings and its link to an agent are found by
 * (projectOf). Undefined for a chat in neither (the workspace root itself, the kept folder of a deleted agent), which
 * the sandbox runs as the first agent all the same, and for one whose agent's home or project folder cannot be reached
 * now, as list leaves that out.
 */
export function chatOwner(workspace: string): ChatOwner | undefined {
  const agent = agentOf(workspace);
  const project = agent ? undefined : projectOf(workspace);
  const dir = agent ? agent.home : project ? path.join(workspaceRoot(), project) : undefined;
  if (!dir) return undefined;
  let real: string;
  try {
    real = baseDir(dir);
  } catch {
    return undefined;
  }
  return entryOf(real, agent ? "agent" : "project") as ChatOwner;
}
