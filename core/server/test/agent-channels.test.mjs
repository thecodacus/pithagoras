import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { inProcessHome } from "./server-harness.mjs";

const home = inProcessHome("pithagoras-agent-channels-");

const { getDb } = await import("../dist/db.js");
const { createAgent, deleteAgent } = await import("../dist/agents.js");
const { resolveChannelSession, scopeKey, unscopeKey } = await import("../dist/agent.js");

const channel = (slug, agentId) =>
  getDb().prepare("INSERT INTO channels (id, slug, kind, name, config, agent_id) VALUES (?, ?, 'test', ?, '{}', ?)").run(slug, slug, slug, agentId);
const talkAs = (slug, agentId) => getDb().prepare("UPDATE channels SET agent_id = ? WHERE slug = ?").run(agentId, slug);

test("a channel talks as its agent, and moved back finds its old conversations", () => {
  const scout = createAgent({ name: "Scout" });
  channel("tg", "");
  const first = resolveChannelSession({ channelSlug: "tg", key: "chat:1", executor: "host" });
  assert.equal(first.session.workspace, process.env.AGENT_HOME);
  assert.equal(first.session.channel_key, "tg:chat:1", "the first agent's keys are as they were");

  talkAs("tg", scout.id);
  const moved = resolveChannelSession({ channelSlug: "tg", key: "chat:1", executor: "host" });
  assert.equal(moved.created, true);
  assert.equal(moved.session.workspace, scout.home);
  assert.equal(moved.session.channel_key, "tg@scout:chat:1");
  assert.equal(unscopeKey("tg", moved.session.channel_key), "chat:1");
  assert.equal(scopeKey("tg", "chat:1"), "tg@scout:chat:1");

  talkAs("tg", "");
  const back = resolveChannelSession({ channelSlug: "tg", key: "chat:1", executor: "host" });
  assert.equal(back.created, false);
  assert.equal(back.session.id, first.session.id);
});

test("an agent a channel talks as is not deleted until the channel is moved", () => {
  const ops = createAgent({ name: "Ops" });
  channel("slack", ops.id);
  assert.throws(() => deleteAgent(ops.id, { deleteFolder: false }), /Slack|slack talks as this agent/);
  talkAs("slack", "");
  assert.equal(deleteAgent(ops.id, { deleteFolder: false }).id, ops.id);
});
