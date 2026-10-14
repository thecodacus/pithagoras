import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import type { Agent } from "./agents.js";

/**
 * Skills an agent writes for itself: in a `skills` folder in its own home, one
 * folder per skill with a SKILL.md, as pi's skills are. The portal hands the
 * folder to pi as skills, which are text the model reads, so an agent may
 * write them wherever it may write: what a skill tells it to run, it runs with
 * its own tools, inside the sandbox when that is on. The skills in Settings →
 * Skills are pi's own, for every agent, and kept apart.
 */

export const SKILLS_FOLDER = "skills";

export const agentSkillsDir = (agent: Pick<Agent, "home">) => path.join(agent.home, SKILLS_FOLDER);

export interface AgentSkill {
  /** Its folder's name, which the page and the route know it by. */
  id: string;
  /** The name its SKILL.md gives, or its folder's. */
  name: string;
  description: string;
  /** When its SKILL.md last changed, in ms. */
  updatedAt: number;
  /** The other files beside SKILL.md: scripts, references. */
  files: string[];
}

/** name and description from a SKILL.md's frontmatter, as pi reads them. */
export function skillFrontmatter(text: string): { name?: string; description?: string } {
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1];
  if (!block) return {};
  const out: Record<string, string> = {};
  for (const line of block.split(/\r?\n/)) {
    const m = /^(name|description):\s*(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "").trim();
  }
  return out;
}

const ID = /^[\w.-]{1,100}$/;

/** The skills in an agent's folder, newest change first. A folder without a SKILL.md is not one. */
export function listAgentSkills(agent: Pick<Agent, "home">): AgentSkill[] {
  const dir = agentSkillsDir(agent);
  if (!existsSync(dir)) return [];
  const skills: AgentSkill[] = [];
  for (const id of readdirSync(dir)) {
    if (!ID.test(id)) continue;
    const file = path.join(dir, id, "SKILL.md");
    try {
      const text = readFileSync(file, "utf8");
      const meta = skillFrontmatter(text);
      const files = readdirSync(path.join(dir, id), { recursive: true })
        .map(String)
        .filter((f) => f !== "SKILL.md" && statSync(path.join(dir, id, f)).isFile())
        .slice(0, 50);
      skills.push({ id, name: meta.name || id, description: meta.description ?? "", updatedAt: statSync(file).mtimeMs, files });
    } catch {
      // No SKILL.md, or unreadable: not a skill, or not yet one.
    }
  }
  return skills.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** One skill's SKILL.md, or null where there is none by that id. */
export function readAgentSkill(agent: Pick<Agent, "home">, id: string): string | null {
  if (!ID.test(id)) return null;
  const file = path.join(agentSkillsDir(agent), id, "SKILL.md");
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/** What the agent is told about its own skills: where they go and what makes one. */
export function skillsLine(agent: Pick<Agent, "home">): string {
  return `Your own skills are in ${agentSkillsDir(agent)}: one folder per skill, with a SKILL.md that starts with frontmatter giving its name and a one-line description of when to use it. To keep a procedure you will need again, write it there; it is available from your next conversation, and the person you work for sees it on your Skills tab.`;
}
