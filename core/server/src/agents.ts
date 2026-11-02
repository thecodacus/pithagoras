import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "./atomic-write.js";
import { getDb, getSetting, putSetting } from "./db.js";
import { removeFolderLater } from "./folder-removal.js";
import { agentHomePath } from "./agent-home.js";
import { AGENT_NAME_FILE as NAME_FILE } from "./pi/context-files.js";
import { isWithinText } from "./within.js";
import { normalizeOrb, type OrbStyle } from "./orb-style.js";

/**
 * The agents, each a home folder of its own with its own SOUL.md,
 * PrimaryUser.md and MEMORY.md: its own personality and memory.
 *
 * A chat is an agent's because it works in that agent's home; nothing else
 * records it. The first agent is the Home there always was (`home`), kept
 * where it was, and the one a chat, a channel or a routine goes to when none is
 * named. It can be renamed, not deleted.
 */

export interface Agent {
  id: string;
  name: string;
  home: string;
  /** Its avatar as stored: see orbOf. */
  orb: string | null;
  /** The voice it speaks with: an id from the voices voice mode's source offers; null is the source's own choice. */
  voice: string | null;
  /** How often it looks around on its own, in minutes; null is never. See heartbeat.ts. */
  heartbeat_minutes: number | null;
  /** The hours it keeps quiet, "HH:MM", both or neither. */
  quiet_start: string | null;
  quiet_end: string | null;
  last_heartbeat: string | null;
  /** How the last look went, in a few words. */
  heartbeat_status: string | null;
  created_at: string;
}

export const DEFAULT_AGENT = "home";

/** Where agents other than the first are made: beside the first one's home, in `agents/`. */
export const agentsRoot = () => path.join(path.dirname(agentHomePath()), "agents");

/** The first agent's home is wherever AGENT_HOME says now, not where it was when its row was made. */
const placed = (a: Agent): Agent => (a.id === DEFAULT_AGENT ? { ...a, home: agentHomePath() } : a);

export function listAgents(): Agent[] {
  return (getDb().prepare("SELECT * FROM agents ORDER BY id = 'home' DESC, created_at ASC, name ASC").all() as Agent[]).map(placed);
}

export function getAgent(id: string): Agent | undefined {
  const row = getDb().prepare("SELECT * FROM agents WHERE id = ?").get(id) as Agent | undefined;
  return row && placed(row);
}

/** The first agent: the one a chat, channel or routine goes to when none is named. */
export function defaultAgent(): Agent {
  // Its row alone where it is there, as it always is: the agents are read whole only where it is not.
  return getAgent(DEFAULT_AGENT) ?? firstAgent(listAgents());
}

/**
 * The first agent of these, all of them as listAgents gives them: what defaultAgent is, for a caller that has read
 * the agents already and marks the first among them (folders.list's `home`), so the two cannot come apart.
 */
export function firstAgent(agents: Agent[]): Agent {
  return agents.find((a) => a.id === DEFAULT_AGENT) ?? agents[0];
}

const NEW_CHAT_AGENT = "new_chat_agent";

/**
 * The agent a new chat started without a project or an agent goes to: the one
 * picked for it, else the first agent. An agent that has been deleted since is
 * not one, so the first agent takes over. Given the agents, a caller that has read them already reads them once.
 */
export function newChatAgent(agents: Agent[] = listAgents()): Agent {
  const id = getSetting(NEW_CHAT_AGENT);
  return (id ? agents.find((a) => a.id === id) : undefined) ?? firstAgent(agents);
}

/** Picks the agent new chats go to; the first agent is the one that needs no pick, so it clears it. */
export function setNewChatAgent(id: string): Agent {
  const agent = getAgent(id);
  if (!agent) throw new AgentError("No such agent", 404);
  putSetting(NEW_CHAT_AGENT, id === DEFAULT_AGENT ? "" : id);
  return agent;
}

/** The agent whose home this is, if any. */
export function agentAt(home: string): Agent | undefined {
  const at = path.resolve(home);
  return listAgents().find((a) => a.home === at);
}

/**
 * The agent a chat working here belongs to: its home, or inside it. Given the
 * agents, a caller that asks about every chat reads them once, not once per chat.
 */
export function agentOf(workspace: string | null | undefined, agents: Agent[] = listAgents()): Agent | undefined {
  if (!workspace) return undefined;
  const at = path.resolve(workspace);
  return agents.find((a) => isWithinText(a.home, at));
}

/** Of these chats, the ones that are `agent`'s. The agents are read once, whatever the number of chats. */
export function chatsOf<T extends { workspace: string | null | undefined }>(agent: Agent, chats: T[]): T[] {
  const agents = listAgents();
  return chats.filter((s) => agentOf(s.workspace, agents)?.id === agent.id);
}

/**
 * A folder name from a name: lower case, letters and digits joined by dashes,
 * accents dropped. A name with no letter or digit a folder name can keep (in
 * another alphabet, or emoji) is `agent-` and a short code of the name, so that
 * it is not the folder of every other such name.
 */
export function slugOf(name: string): string {
  const slug = name.normalize("NFKD").replace(/\p{M}+/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return slug || `agent-${createHash("sha1").update(sameName(name)).digest("hex").slice(0, 6)}`;
}

/** Names are the same when they differ in case and in the space around them only. */
const sameName = (name: string): string => name.normalize("NFC").trim().toLowerCase();

/**
 * Whether an agent called `name` may have `home`: it is not there, or empty, or
 * kept from an agent of that name. Two names can make the same slug ("Maria 2",
 * "小助手 2"), and what one kept is not the other's. A folder from before the
 * name was recorded is taken as the name's when the name is all plain letters,
 * as it was before.
 */
function freeFor(home: string, name: string): boolean {
  if (!existsSync(home) || readdirSync(home).length === 0) return true;
  try {
    return sameName(readFileSync(path.join(home, NAME_FILE), "utf8")) === sameName(name);
  } catch {
    return /^[\x20-\x7e]+$/.test(name);
  }
}

/** The name recorded in an agent's folder, as `sameName` compares it; none for a folder from before it was recorded. */
function recordedName(home: string): string | undefined {
  try {
    return sameName(readFileSync(path.join(home, NAME_FILE), "utf8"));
  } catch {
    return undefined;
  }
}

/**
 * The folder kept from an agent that was named `name` when it was deleted, which no agent has. Not the folder
 * `name` makes: an agent that was renamed keeps the folder it was made in, and takes that one up again under its
 * last name. Where two were kept under one name, the one `name` would make, else the first.
 */
function keptFolderOf(name: string, taken: Set<string>, own: string): string | undefined {
  let folders: string[];
  try {
    folders = readdirSync(agentsRoot(), { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith(".")).map((d) => d.name).sort();
  } catch {
    return undefined;
  }
  const kept = folders.filter((f) => !taken.has(f) && f !== DEFAULT_AGENT && recordedName(path.join(agentsRoot(), f)) === sameName(name));
  return kept.includes(own) ? own : kept[0];
}

const checkName = (name: unknown): string => {
  if (typeof name !== "string" || !name.trim()) throw new AgentError("An agent needs a name", 400);
  if (name.trim().length > 60) throw new AgentError("An agent's name is at most 60 characters", 400);
  return name.trim();
};

export class AgentError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/**
 * A new agent, with a home of its own under agentsRoot(). Named like one that
 * was deleted with its folder kept, it takes that folder up again, with its
 * files and memory: that is how a deleted agent comes back. A folder kept by
 * another name is left alone.
 */
export function createAgent(input: { name: unknown }): Agent {
  const name = checkName(input.name);
  const taken = new Set(listAgents().map((a) => a.id));
  const base = slugOf(name);
  let id = keptFolderOf(name, taken, base) ?? base;
  for (let n = 2; taken.has(id) || id === DEFAULT_AGENT || !freeFor(path.join(agentsRoot(), id), name); n++) id = `${base}-${n}`;
  const home = path.join(agentsRoot(), id);
  mkdirSync(home, { recursive: true });
  writeFileAtomic(path.join(home, NAME_FILE), name);
  getDb().prepare("INSERT INTO agents (id, name, home) VALUES (?, ?, ?)").run(id, name, home);
  return getAgent(id)!;
}

export function renameAgent(id: string, name: unknown): Agent {
  const agent = getAgent(id);
  if (!agent) throw new AgentError("No such agent", 404);
  const named = checkName(name);
  // The folder keeps its name, and says whose it is now: kept when the agent is deleted, it is taken up again by
  // an agent of this name, and not by one that is given the name it was made with.
  if (isWithinText(agentsRoot(), agent.home) && existsSync(agent.home)) writeFileAtomic(path.join(agent.home, NAME_FILE), named);
  getDb().prepare("UPDATE agents SET name = ? WHERE id = ?").run(named, id);
  return getAgent(id)!;
}

/** An agent's avatar: the default orb where it has none, or one that no longer parses. */
export function orbOf(agent: Agent): OrbStyle {
  let stored: unknown;
  try {
    stored = agent.orb ? JSON.parse(agent.orb) : undefined;
  } catch {
    // The default orb, not a broken page.
  }
  return normalizeOrb(stored);
}

export function setOrb(id: string, style: unknown): OrbStyle {
  if (!getAgent(id)) throw new AgentError("No such agent", 404);
  if (!style || typeof style !== "object" || Array.isArray(style)) throw new AgentError("An orb style is required", 400);
  const orb = normalizeOrb(style);
  getDb().prepare("UPDATE agents SET orb = ? WHERE id = ?").run(JSON.stringify(orb), id);
  return orb;
}

/**
 * The voice it speaks with in voice mode: one of `offered`, the ids of the voices voice mode's source offers now
 * (undefined while there is none, or it is not running), or "" for the source's own choice.
 */
export function setVoice(id: string, voice: unknown, offered: readonly string[] | undefined): Agent {
  if (!getAgent(id)) throw new AgentError("No such agent", 404);
  if (typeof voice !== "string") throw new AgentError("Choose a voice", 400);
  if (voice && !offered?.includes(voice)) throw new AgentError("Choose one of the voices voice mode's source offers now, or none", 400);
  getDb().prepare("UPDATE agents SET voice = ? WHERE id = ?").run(voice || null, id);
  return getAgent(id)!;
}

/** The channels that talk as this agent: an agent with any cannot be deleted until they are moved. */
export function channelsOf(id: string): { slug: string; name: string }[] {
  return getDb()
    .prepare("SELECT slug, name FROM channels WHERE agent_id = ? OR (agent_id = '' AND ? = 'home')")
    .all(id, id) as { slug: string; name: string }[];
}

/** The agent, if it may be deleted: not the first one, and not one a channel talks as. Throws otherwise. */
export function deletable(id: string): Agent {
  const agent = getAgent(id);
  if (!agent) throw new AgentError("No such agent", 404);
  if (id === DEFAULT_AGENT) throw new AgentError("The first agent cannot be deleted. It can be renamed.", 409);
  const channels = channelsOf(id);
  if (channels.length) {
    throw new AgentError(`${channels.map((c) => c.name).join(", ")} ${channels.length === 1 ? "talks" : "talk"} as this agent. Give ${channels.length === 1 ? "it" : "them"} another agent first.`, 409);
  }
  return agent;
}

/**
 * Takes the agent out of the portal. Its folder stays unless `deleteFolder`
 * says otherwise. Its chats are removed by the caller, which knows whether any
 * is running; this refuses the first agent, and one a channel talks as.
 */
export function deleteAgent(id: string, { deleteFolder }: { deleteFolder: boolean }): Agent {
  const agent = deletable(id);
  getDb().prepare("DELETE FROM agents WHERE id = ?").run(id);
  // An agent made later under the same name gets the same id, and must not inherit the pick.
  if (getSetting(NEW_CHAT_AGENT) === id) putSetting(NEW_CHAT_AGENT, "");
  // Only a folder this module made, under agentsRoot(): nothing else is ever removed.
  if (deleteFolder && isWithinText(agentsRoot(), agent.home) && agent.home !== agentsRoot() && existsSync(agent.home)) {
    removeFolderLater(agent.home);
  }
  return agent;
}

/** The home of the agent a channel talks as: its own, or the first agent's. */
export function channelAgentHome(agentId: string | null | undefined): string {
  return (agentId ? getAgent(agentId) : undefined)?.home ?? defaultAgent().home;
}
