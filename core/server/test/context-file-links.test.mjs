import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fakeModel } from "./fake-model.mjs";
import { inProcessHome } from "./server-harness.mjs";

/**
 * What the portal reads into an agent's prompt out of folders the agent writes in: its own files (SOUL.md,
 * MEMORY.md and the others), pi's AGENTS.md or CLAUDE.md, and its heartbeat's WATCH.md. With the sandbox on the
 * portal is root, so a link the agent leaves in place of one would hand the agent whatever the link leads to:
 * none is followed, and a file the agent could not read itself is not read for it.
 */
const home = inProcessHome("pithagoras-context-links-");
// The folders above the agent's are open to everyone, as a sandbox has them: the kernel needs search on each.
chmodSync(home, 0o755);

/** Each request's system prompt, in the order they came. */
const sent = [];
const model = await fakeModel(async (request) => {
  const system = request.messages.find((m) => m.role === "system" || m.role === "developer");
  sent.push(typeof system?.content === "string" ? system.content : system?.content?.map((c) => c.text).join("") ?? "");
  return "Sure.";
});
const agentDir = process.env.PI_CODING_AGENT_DIR;
writeFileSync(path.join(agentDir, "models.json"), JSON.stringify(model.models()));

const { SdkPiClient, agentsFilesFor, extraContextFiles, ownFiles } = await import("../dist/pi/sdk-client.js");
const { loadProjectContextFiles } = await import("@earendil-works/pi-coding-agent");
const { setAgentAccess } = await import("../dist/workspace-files.js");
const { createSession, getDb, getSession, setProjectAgent } = await import("../dist/db.js");
const { createAgent, getAgent } = await import("../dist/agents.js");
const { heartbeat, watchList, WATCH_FILE } = await import("../dist/heartbeat.js");

/** What the agent must not be handed: another agent's files, the portal's own. */
const outside = path.join(home, "outside");
mkdirSync(outside);
const SECRET = "API_KEY=sk-not-for-the-agent";
writeFileSync(path.join(outside, "secret.env"), `${SECRET}\n`);
// pi's agent folder is the portal's own, and its AGENTS.md may well be a link to the operator's dotfiles.
writeFileSync(path.join(outside, "dotfiles.md"), "Be brief.\n");
symlinkSync(path.join(outside, "dotfiles.md"), path.join(agentDir, "AGENTS.md"));

const folder = (name) => {
  const dir = path.join(home, name);
  mkdirSync(dir, { recursive: true });
  return dir;
};
const names = (files) => files.map((f) => path.basename(f.path));
/** A project, linked to `agent`: its chats carry that agent's files, read from the agent's home. */
const linkedProject = (name, agent) => {
  const dir = path.join(process.env.WORKSPACE_ROOT, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "AGENTS.md"), "Answer in German.\n");
  setProjectAgent(name, { agent: agent.id, memoryOff: false });
  return dir;
};
/** Where the agent's access is told on a folder's descriptor, named as /proc/self/fd/<n>: Linux. */
const LINUX_ONLY = process.platform !== "linux" && "what the agent may read is told on the folder's descriptor, which is named as /proc/self/fd/<n> on Linux only";

let chats = 0;
const open = (cwd, sessionId) => {
  const dir = path.join(home, "chats", String(++chats));
  mkdirSync(dir, { recursive: true });
  return SdkPiClient.create({ cwd, sessionDir: dir, provider: "fake", modelId: "m", sessionId, role: "primary" });
};
/** The end of the run going now, or a failure after 10 s. */
const settled = (client) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => { client.off("event", on); reject(new Error("the run did not settle within 10 s")); }, 10_000);
  const on = (e) => { if (e?.type === "agent_settled") { clearTimeout(timer); client.off("event", on); resolve(); } };
  client.on("event", on);
});
/** Sends one message, and gives the system prompt its run was answered with. */
async function say(client, text) {
  const before = sent.length;
  const done = settled(client);
  await client.prompt(text);
  await done;
  assert.equal(sent.length, before + 1);
  return sent.at(-1);
}

test("a link left in place of one of the agent's files is not handed to it, nor named as its own, wherever it leads", () => {
  const dir = folder("links");
  writeFileSync(path.join(dir, "SOUL.md"), "# Nova\n");
  // Out of the folder, to what the portal can read and the agent cannot.
  symlinkSync(path.join(outside, "secret.env"), path.join(dir, "MEMORY.md"));
  // In it, to a file of the agent's own: still not the file its name says.
  symlinkSync(path.join(dir, "SOUL.md"), path.join(dir, "PrimaryUser.md"));
  assert.deepEqual(extraContextFiles(dir, "primary").map((f) => [path.basename(f.path), f.content]), [["SOUL.md", "# Nova\n"]]);
  assert.match(ownFiles(dir, "primary")[0], /^SOUL\.md in your working directory are yours/);
});

test("a chat in a project linked to an agent is not handed what a link in that agent's home leads to either", () => {
  const vega = createAgent({ name: "Vega" });
  writeFileSync(path.join(vega.home, "SOUL.md"), "# Vega\n");
  symlinkSync(path.join(outside, "secret.env"), path.join(vega.home, "MEMORY.md"));
  const dir = linkedProject("with-vega", vega);
  assert.deepEqual(extraContextFiles(dir, "primary").map((f) => [f.path, f.content]), [[path.join(vega.home, "SOUL.md"), "# Vega\n"]]);
  assert.match(ownFiles(dir, "primary")[0], /^SOUL\.md of the agent this project works with are yours/);
});

test("pi's AGENTS.md or CLAUDE.md is dropped where it is a link, the others are handed on as they read now, and the one in pi's own folder stays as pi read it", () => {
  const top = folder("project");
  const dir = path.join(top, "sub");
  mkdirSync(dir);
  symlinkSync(path.join(outside, "secret.env"), path.join(dir, "AGENTS.md"));
  writeFileSync(path.join(top, "CLAUDE.md"), "\uFEFFUse tabs.\n");
  const found = loadProjectContextFiles({ cwd: dir, agentDir });
  assert.ok(found.some((f) => f.content.includes(SECRET)), "pi itself reads what the link leads to");
  const handed = agentsFilesFor(found, agentDir);
  assert.ok(!handed.some((f) => f.content.includes(SECRET)));
  assert.ok(!handed.some((f) => f.path === path.join(dir, "AGENTS.md")));
  const byPath = new Map(handed.map((f) => [f.path, f.content]));
  assert.equal(byPath.get(path.join(top, "CLAUDE.md")), "Use tabs.\n", "without its byte order mark, as pi has it");
  assert.equal(byPath.get(path.join(agentDir, "AGENTS.md")), "Be brief.\n");
});

test("a chat's pi is handed the agent's files and pi's as they are read for it, and nothing a link leads to", async () => {
  const dir = process.env.AGENT_HOME;
  writeFileSync(path.join(dir, "SOUL.md"), "# Nova, the agent\n");
  symlinkSync(path.join(outside, "secret.env"), path.join(dir, "MEMORY.md"));
  symlinkSync(path.join(outside, "secret.env"), path.join(dir, "AGENTS.md"));
  createSession({ id: "links", title: "links", workspace: dir, executor: "host" });
  const client = await open(dir, "links");
  try {
    const prompt = await say(client, "Who are you?");
    assert.match(prompt, /# Nova, the agent/);
    assert.match(prompt, /Be brief\./, "pi's own AGENTS.md");
    assert.match(prompt, /SOUL\.md in your working directory are yours/, "and MEMORY.md is not named as the agent's");
    assert.doesNotMatch(prompt, /sk-not-for-the-agent/);
  } finally {
    client.dispose();
  }
});

/** What the agent's last look said of itself. */
const looked = async (agent) => (await heartbeat.run(getAgent(agent.id), "manual")).heartbeat_status;
/** The session an agent's looks happen in, once there has been one. */
const lookOf = (agent) => getDb().prepare("SELECT id FROM sessions WHERE kind = 'heartbeat' AND workspace = ?").get(agent.home).id;

test("WATCH.md that is a link is nothing to watch, for a look or for the agent's page", async () => {
  const watcher = createAgent({ name: "Linked Watcher" });
  const watch = path.join(watcher.home, WATCH_FILE);
  writeFileSync(watch, "The open PRs on the repo.\n");
  assert.equal(watchList(watcher), "The open PRs on the repo.");
  const other = createAgent({ name: "Other" });
  writeFileSync(path.join(other.home, "notes.md"), "Another agent's notes.\n");
  for (const target of [path.join(outside, "secret.env"), path.join(other.home, "notes.md")]) {
    symlinkSync(target, `${watch}.link`);
    // Put in place by a rename, as an agent would to leave no moment without one.
    renameSync(`${watch}.link`, watch);
    assert.equal(watchList(watcher), "", target);
    assert.equal(await looked(watcher), `Nothing to watch: ${WATCH_FILE} is empty`, target);
    assert.equal(watchList(watcher, lookOf(watcher)), "", target);
  }
});

test("what the sandbox closed to the agent is not read for it: not its own files, not pi's, not WATCH.md, and nothing for a chat not named; what it can read is", { skip: LINUX_ONLY }, async () => {
  // The agent is another user than the one the files are the portal's for: everyone, to them.
  const AGENT = { uid: 61234, groups: [61234] };
  // As the portal's own says it: a chat it does not know is a refusal, and naming none names no agent.
  setAgentAccess((chats) => chats.map((id) => {
    if (!getSession(id)) throw new Error("No such chat");
    return AGENT;
  }));
  // pi's folder is the portal's HOME, which the sandbox closes to every agent.
  chmodSync(agentDir, 0o700);
  try {
    const dir = folder("closed");
    writeFileSync(path.join(dir, "SOUL.md"), "# Nova, open to the agent\n");
    writeFileSync(path.join(dir, "MEMORY.md"), "Closed to the agent.\n");
    chmodSync(path.join(dir, "MEMORY.md"), 0o600);
    writeFileSync(path.join(dir, "AGENTS.md"), "Closed to the agent too.\n");
    chmodSync(path.join(dir, "AGENTS.md"), 0o600);
    createSession({ id: "closed", title: "closed", workspace: dir, executor: "host" });

    assert.deepEqual(names(extraContextFiles(dir, "primary", "closed")), ["SOUL.md"]);
    assert.match(ownFiles(dir, "primary", "closed")[0], /^SOUL\.md in your working directory are yours/);
    assert.deepEqual(extraContextFiles(dir, "primary"), [], "no chat named, no agent to read for");
    const handed = agentsFilesFor(loadProjectContextFiles({ cwd: dir, agentDir }), agentDir, "closed");
    assert.ok(!handed.some((f) => f.path === path.join(dir, "AGENTS.md")));
    assert.ok(handed.some((f) => f.path === path.join(agentDir, "AGENTS.md")), "pi's own folder is not the agent's to read");

    // The chat's pi reads them for the chat it is: what the agent can read is in its prompt, and nothing else.
    const client = await open(dir, "closed");
    try {
      const prompt = await say(client, "Who are you?");
      assert.match(prompt, /# Nova, open to the agent/);
      assert.match(prompt, /Be brief\./);
      assert.doesNotMatch(prompt, /Closed to the agent/);
    } finally {
      client.dispose();
    }

    // A look reads WATCH.md as the agent its session runs as; the agent's page shows the person the file as it is.
    const watcher = createAgent({ name: "Closed Watcher" });
    const watch = path.join(watcher.home, WATCH_FILE);
    writeFileSync(watch, "The open PRs on the repo.\n");
    chmodSync(watch, 0o600);
    assert.equal(await looked(watcher), `Nothing to watch: ${WATCH_FILE} is empty`);
    assert.equal(watchList(watcher, lookOf(watcher)), "");
    assert.equal(watchList(watcher), "The open PRs on the repo.");
    chmodSync(watch, 0o644);
    assert.equal(watchList(watcher, lookOf(watcher)), "The open PRs on the repo.");
  } finally {
    chmodSync(agentDir, 0o755);
    setAgentAccess(() => undefined);
  }
});

test("a chat in a project linked to an agent reads that agent's files as the agent whose home they are in, and the project's AGENTS.md as the agent it runs as", { skip: LINUX_ONLY }, () => {
  const lyra = createAgent({ name: "Lyra" });
  // The agent the project's chats run as, which the sandbox keeps out of every other agent's home.
  const CHATS_AGENT = { uid: 61234, groups: [61234] };
  // The linked agent: its home is its group's, with nothing for anyone else, as the sandbox has it.
  const LYRA = { uid: 61236, groups: [process.getgid()] };
  setAgentAccess((chats, agents) => [
    ...chats.map((id) => {
      if (!getSession(id)) throw new Error("No such chat");
      return CHATS_AGENT;
    }),
    ...agents.map((id) => {
      if (id !== lyra.id) throw new Error("No such agent");
      return LYRA;
    }),
  ]);
  try {
    chmodSync(lyra.home, 0o750);
    for (const name of ["SOUL.md", "PrimaryUser.md"]) {
      writeFileSync(path.join(lyra.home, name), `# ${name} of Lyra\n`);
      chmodSync(path.join(lyra.home, name), 0o640);
    }
    // Closed to Lyra too: a file the sandbox kept from every agent, moved in under the name of one the portal reads.
    writeFileSync(path.join(lyra.home, "MEMORY.md"), "Closed to every agent.\n");
    chmodSync(path.join(lyra.home, "MEMORY.md"), 0o600);
    const dir = linkedProject("with-lyra", lyra);
    createSession({ id: "with-lyra", title: "with-lyra", workspace: dir, executor: "host" });

    assert.deepEqual(names(extraContextFiles(dir, "primary", "with-lyra")), ["SOUL.md", "PrimaryUser.md"]);
    assert.match(ownFiles(dir, "primary", "with-lyra")[0], /^SOUL\.md, PrimaryUser\.md of the agent this project works with are yours/);
    const handed = agentsFilesFor(loadProjectContextFiles({ cwd: dir, agentDir }), agentDir, "with-lyra");
    assert.equal(handed.find((f) => f.path === path.join(dir, "AGENTS.md"))?.content, "Answer in German.\n");
  } finally {
    setAgentAccess(() => undefined);
  }
});
