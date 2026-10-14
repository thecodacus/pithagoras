import { nanoid } from "nanoid";
import { createSession, findChannelSession, getDb, type SessionRow } from "./db.js";
import { DEFAULT_AGENT, channelAgentHome } from "./agents.js";

/** Keys come from outside, so they are bounded before touching the database. */
const MAX_KEY = 200;

/** The agent a channel talks as, by its slug: "" for the first agent, as every channel was before there were others. */
function channelAgent(channelSlug: string): string {
  const row = getDb().prepare("SELECT agent_id FROM channels WHERE slug = ?").get(channelSlug) as { agent_id: string } | undefined;
  return row?.agent_id && row.agent_id !== DEFAULT_AGENT ? row.agent_id : "";
}

/**
 * The key a package supplies is namespaced by its channel's slug.
 *
 * The slug and not the channel's id: ids are regenerated when a channel is
 * deleted and recreated, which silently orphaned every conversation it had —
 * same bot, same chat, same token, and an agent with amnesia. A slug is stable
 * and yours to choose, so re-adding under the same one picks the conversations
 * back up, and picking a different one is a deliberate fresh start.
 *
 * It also reads: `my-bot:chat:999` rather than `jAUF15d6Gg:chat:999`.
 *
 * The agent it talks as goes in too, when that is not the first one: a channel
 * moved to another agent starts new conversations there, and moved back finds
 * its old ones. The first agent's keys are as they always were.
 */
export const scopeKey = (channelSlug: string, key: string, agentId = channelAgent(channelSlug)) =>
  agentId && agentId !== DEFAULT_AGENT ? `${channelSlug}@${agentId}:${key}` : `${channelSlug}:${key}`;

export function unscopeKey(channelSlug: string, stored: string): string {
  for (const prefix of [`${channelSlug}:`, `${channelSlug}@`]) {
    if (!stored.startsWith(prefix)) continue;
    return prefix.endsWith(":") ? stored.slice(prefix.length) : stored.slice(stored.indexOf(":", prefix.length) + 1);
  }
  return stored;
}

export function resolveChannelSession(opts: {
  /** The channel's stable slug, not its primary key. */
  channelSlug: string;
  key: string;
  /** Human label for the first time this conversation is seen. */
  title?: string;
  executor: string;
  /** The agent to talk to: the channel's own, unless given. */
  agentId?: string;
}): { session: SessionRow; created: boolean } {
  const key = String(opts.key ?? "").trim().slice(0, MAX_KEY);
  if (!key) throw new Error("A channel must supply a session key for each conversation");

  const agentId = opts.agentId ?? channelAgent(opts.channelSlug);
  const scoped = scopeKey(opts.channelSlug, key, agentId);

  const existing = findChannelSession(scoped);
  if (existing) return { session: existing, created: false };

  const id = nanoid(12);
  createSession({
    id,
    title: (opts.title ?? "").trim().slice(0, 120) || key,
    workspace: channelAgentHome(agentId),
    executor: opts.executor,
    kind: "agent",
    channel_slug: opts.channelSlug,
    channel_key: scoped,
  });

  // Re-read rather than construct: the row carries defaults this does not set.
  const session = findChannelSession(scoped);
  if (!session) throw new Error("Failed to create the session for this conversation");
  return { session, created: true };
}
