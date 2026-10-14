import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { dataFolder } from "./data-dir.js";

/**
 * The agent's fixed working directory, separate from the per-task workspaces:
 * the first agent's unless another's is given, made if it is not there.
 *
 * Kept out of the workspace root deliberately: it is not a project you would
 * start a session against, and listing it as one would be misleading.
 *
 * A module of its own so that the database can use it without importing
 * agent.ts, which imports the database.
 */
export function agentHome(dir = agentHomePath()): string {
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Where Home is, without making sure it is there: for comparing a path with it. */
export function agentHomePath(): string {
  return dataFolder("AGENT_HOME", "agent-home");
}

/**
 * The name an agent's SOUL.md gives it: the first heading after its preamble,
 * as the setup wizard writes it. "Agent" where there is none to read.
 */
export function homeAgentName(home: string): string {
  try {
    const soul = readFileSync(path.join(home, "SOUL.md"), "utf8");
    const body = soul.includes("\n---") ? soul.slice(soul.indexOf("\n---") + 4) : soul;
    const heading = /^#\s+(.+)$/m.exec(body)?.[1]?.trim();
    if (heading && !/^SOUL\.md\b/.test(heading)) return heading.slice(0, 60);
  } catch {
    // No SOUL.md yet: the setup wizard has not run.
  }
  return "Agent";
}
