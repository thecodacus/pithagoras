import { agentOf, defaultAgent, getAgent, type Agent } from "./agents.js";
import { projectAgent } from "./db.js";
import { memoryHolder, type MemoryHolder } from "./memory-holder.js";
import { projectOf } from "./workspaces.js";

/**
 * Which agent a project works with, and whether what holds the agent's memory
 * holds it there.
 *
 * Agents and projects are separate: a chat in a project is not in an agent's
 * home, so it gets the project's AGENTS.md and nothing of the agent's own. A
 * project can be linked to an agent, and its chats then carry that agent's
 * soul, its primary user and its memory as well, read from the agent's home
 * (see extraContextFiles). Its skills, voice and avatar follow the link too.
 * What the link is stored as is in db.ts (project_agent).
 */

/** The agent a project works with; undefined for a blank slate, and where the agent it named is gone. */
export function linkedAgent(project: string): Agent | undefined {
  const id = projectAgent(project).agent;
  return id ? getAgent(id) : undefined;
}

/** The agent whose files a chat working here carries, because the project it is in is linked to it. */
export function agentLinkedAt(workspace: string | null | undefined): Agent | undefined {
  // A chat in an agent's home, or a folder of it, is that agent's already and gets its files from there.
  if (!workspace || agentOf(workspace)) return undefined;
  const project = projectOf(workspace);
  return project ? linkedAgent(project) : undefined;
}

/**
 * The folder whose SOUL.md, PrimaryUser.md and MEMORY.md a chat working here
 * carries: the workspace itself, which is the agent's home for a chat there (or
 * a plain task workspace, which has none of them). A chat in a linked project
 * reads the agent's home instead. A blank-slate project has no agent files at
 * all: its folder is the agent's to write, not a place to take a soul from.
 */
export function agentFilesAt(workspace: string): string | undefined {
  if (agentOf(workspace)) return workspace;
  const project = projectOf(workspace);
  return project ? linkedAgent(project)?.home : workspace;
}

/**
 * The agent a chat working here is with: the one whose home it is in, else the
 * one its project is linked to, else the first. Where the avatar, the voice and
 * the skills of a chat come from.
 */
export function agentFor(workspace: string | null | undefined): Agent {
  return agentOf(workspace) ?? agentLinkedAt(workspace) ?? defaultAgent();
}

/**
 * What holds the memory of a chat working here, where something holds the
 * agent's memory (see memory-holder.ts). A blank-slate project has no agent
 * and so no memory of the person: it does not get it. A project linked
 * to an agent does unless it says it does not want it (stored as
 * `memoryOff`), and then its chats neither get the holder's rule nor leave
 * the agent's MEMORY.md aside.
 */
export function memoryHeldAt(workspace: string | null | undefined): MemoryHolder | undefined {
  const holder = memoryHolder();
  if (!holder) return undefined;
  const project = !workspace || agentOf(workspace) ? undefined : projectOf(workspace);
  if (!project) return holder;
  return linkedAgent(project) && !projectAgent(project).memoryOff ? holder : undefined;
}
