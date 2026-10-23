import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import Database from "better-sqlite3";
import { freePort, serverEnv, startServer, testHome } from "./server-harness.mjs";

const home = testHome("agents-");
// The first agent is named from its SOUL.md, as the setup wizard writes it.
writeFileSync(path.join(home, "agent-home", "SOUL.md"), "Who you are.\n\n---\n\n# Nova\n\nWarm and direct.\n");
const { base } = await startServer(serverEnv(home, await freePort()));

const call = async (method, url, body) => {
  const res = await fetch(`${base}${url}`, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
};

test("the first agent is the Home there was, named by its SOUL.md", async () => {
  const { body } = await call("GET", "/api/agents");
  assert.equal(body.agents.length, 1);
  assert.equal(body.agents[0].id, "home");
  assert.equal(body.agents[0].name, "Nova");
  assert.equal(body.agents[0].home, path.join(home, "agent-home"));
  assert.equal(body.agents[0].first, true);
});

test("an agent has a home, files and chats of its own", async () => {
  const made = await call("POST", "/api/agents", { name: "Research Bot", setup: { userName: "Sam", vibe: "Curious." } });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  assert.equal(made.body.id, "research-bot");
  assert.equal(made.body.home, path.join(home, "agents", "research-bot"));
  assert.equal(made.body.initialised, true);
  assert.match(readFileSync(path.join(made.body.home, "SOUL.md"), "utf8"), /Research Bot/);
  assert.ok(!existsSync(path.join(home, "agent-home", "PrimaryUser.md")), "the first agent's files are untouched");

  const chat = await call("POST", "/api/sessions", { agent: "research-bot" });
  assert.equal(chat.body.workspace, made.body.home);
  const homeChat = await call("POST", "/api/sessions", {});
  assert.equal(homeChat.body.workspace, path.join(home, "agent-home"));

  const named = await call("POST", "/api/agent/sessions", { agent: "research-bot", title: "hi" });
  assert.equal(named.body.workspace, made.body.home);
  const chats = (await call("GET", "/api/sessions")).body.sessions;
  assert.ok(chats.some((s) => s.id === named.body.id), "a conversation started on the Agent page is listed with the chats");
  const listed = await call("GET", "/api/agent/sessions?agent=research-bot");
  assert.deepEqual(listed.body.sessions.map((s) => s.id).sort(), [chat.body.id, named.body.id].sort(), "the chat the + starts is a conversation of the agent like the one started on its page");
  assert.deepEqual((await call("GET", "/api/agent/sessions")).body.sessions.map((s) => s.id), [homeChat.body.id], "the first agent's list has its own chat, and none of the other agent's");
  assert.equal(listed.body.sessions.find((s) => s.id === chat.body.id).channel, null);

  const projects = await call("GET", "/api/projects?bare=1");
  assert.deepEqual(projects.body.agents.map((a) => a.name), ["Nova", "Research Bot"]);

  assert.equal((await call("POST", "/api/agents", { name: "Research Bot" })).body.id, "research-bot-2", "a taken name gets a folder of its own");
  assert.equal((await call("POST", "/api/agents", { name: "  " })).status, 400);
  assert.equal((await call("POST", "/api/sessions", { agent: "nobody" })).status, 404);
});

test("renaming keeps the folder", async () => {
  const renamed = await call("PATCH", "/api/agents/research-bot", { name: "Scout" });
  assert.equal(renamed.body.name, "Scout");
  assert.equal(renamed.body.home, path.join(home, "agents", "research-bot"));
});

test("an agent renamed and deleted with its folder kept comes back under its last name, and a new one given its first name does not get its files", async () => {
  const vega = (await call("POST", "/api/agents", { name: "Vega" })).body;
  writeFileSync(path.join(vega.home, "notes.md"), "Vega's notes.\n");
  assert.equal((await call("PATCH", `/api/agents/${vega.id}`, { name: "Lyra" })).status, 200);
  assert.equal(readFileSync(path.join(vega.home, ".agent-name"), "utf8"), "Lyra", "the folder says whose it is now");
  assert.equal((await call("DELETE", `/api/agents/${vega.id}`)).status, 200);

  const stranger = (await call("POST", "/api/agents", { name: "Vega" })).body;
  assert.notEqual(stranger.home, vega.home);
  assert.ok(!existsSync(path.join(stranger.home, "notes.md")), "the folder that was kept for Lyra is not Vega's");
  const lyra = (await call("POST", "/api/agents", { name: "Lyra" })).body;
  assert.equal(lyra.home, vega.home, "found by the name it was given last, not by the folder name");
  assert.equal(readFileSync(path.join(lyra.home, "notes.md"), "utf8"), "Vega's notes.\n");
  assert.equal((await call("DELETE", `/api/agents/${stranger.id}?folder=delete`)).status, 200);
  assert.equal((await call("DELETE", `/api/agents/${lyra.id}?folder=delete`)).status, 200);
});

/** A job as the agent's tool call starts one: marked as the portal's, in the folder, in a Unix session of its own. */
async function withJob(folder, run) {
  const job = spawn("sleep", ["60"], { cwd: folder, detached: true, stdio: "ignore", env: { ...process.env, PITHAGORAS_AGENT: "1" } });
  const ended = once(job, "exit");
  try {
    await run();
    await Promise.race([ended, new Promise((_, reject) => setTimeout(() => reject(new Error("the job is still running")), 10_000))]);
  } finally {
    try {
      process.kill(-job.pid, "SIGKILL");
    } catch {
      // Gone, as it should be.
    }
  }
}

test("an agent made in a folder that already holds its own files says which, with the wizard and without it", async () => {
  // Kept from an agent of that name, or put there before the name was taken.
  for (const name of ["finance", "legal"]) {
    mkdirSync(path.join(home, "agents", name), { recursive: true });
    writeFileSync(path.join(home, "agents", name, "SOUL.md"), "# What was there\n");
  }
  writeFileSync(path.join(home, "agents", "legal", "MEMORY.md"), "Remembered.\n");

  const plain = await call("POST", "/api/agents", { name: "Finance" });
  assert.equal(plain.status, 200, JSON.stringify(plain.body));
  assert.equal(plain.body.home, path.join(home, "agents", "finance"));
  assert.deepEqual(plain.body.kept, ["SOUL.md"], "it was not silently taken up");
  assert.equal(plain.body.initialised, false);

  const wizard = await call("POST", "/api/agents", { name: "Legal", setup: { userName: "Sam", vibe: "Brisk." } });
  assert.equal(wizard.status, 200, JSON.stringify(wizard.body));
  assert.deepEqual(wizard.body.kept, ["SOUL.md", "MEMORY.md"], "the answers did not replace them");
  assert.equal(readFileSync(path.join(wizard.body.home, "SOUL.md"), "utf8"), "# What was there\n");
  assert.ok(existsSync(path.join(wizard.body.home, "PrimaryUser.md")), "the one that was not there is written");

  const fresh = await call("POST", "/api/agents", { name: "Fresh" });
  assert.deepEqual(fresh.body.kept, []);
});

test("deleting an agent stops the jobs its chats started, in a folder that is kept as well", async () => {
  const made = (await call("POST", "/api/agents", { name: "Jobber" })).body;
  await withJob(made.home, async () => {
    const gone = await call("DELETE", `/api/agents/${made.id}`);
    assert.equal(gone.status, 200, JSON.stringify(gone.body));
    assert.equal(gone.body.jobsStopped, 1);
  });
});

test("deleting a project stops the jobs its chats started", async () => {
  const project = await call("POST", "/api/projects", { name: "Jobs" });
  assert.equal(project.status, 200, JSON.stringify(project.body));
  await withJob(project.body.path, async () => {
    const gone = await call("DELETE", `/api/projects/${project.body.name}?discard=1`);
    assert.equal(gone.status, 200, JSON.stringify(gone.body));
    assert.equal(gone.body.jobsStopped, 1);
  });
});

test("deleting an agent or a project stops a job that started after the last look at its folder", async () => {
  // The jobs panel of an open chat looks every few seconds, and what a look finds is kept for a second.
  const looked = async (folder, chat) => {
    assert.equal((await call("GET", `/api/sessions/${chat}/background`)).status, 200);
    assert.ok(existsSync(folder));
  };
  const made = (await call("POST", "/api/agents", { name: "Panel" })).body;
  const agentChat = (await call("POST", "/api/sessions", { agent: made.id })).body;
  await looked(made.home, agentChat.id);
  await withJob(made.home, async () => {
    const gone = await call("DELETE", `/api/agents/${made.id}?folder=delete`);
    assert.equal(gone.status, 200, JSON.stringify(gone.body));
    assert.equal(gone.body.jobsStopped, 1, "a job the last look did not see");
  });

  const project = await call("POST", "/api/projects", { name: "Panel" });
  assert.equal(project.status, 200, JSON.stringify(project.body));
  const projectChat = (await call("POST", "/api/sessions", { workspace: project.body.path })).body;
  await looked(project.body.path, projectChat.id);
  await withJob(project.body.path, async () => {
    const gone = await call("DELETE", `/api/projects/${project.body.name}?discard=1`);
    assert.equal(gone.status, 200, JSON.stringify(gone.body));
    assert.equal(gone.body.jobsStopped, 1);
  });
});

test("the first agent is not deleted", async () => {
  assert.equal((await call("DELETE", "/api/agents/home")).status, 409);
  const { status } = await call("DELETE", "/api/agents/nobody");
  assert.equal(status, 404);
});

test("deleting an agent removes its chats, and its folder only when asked", async () => {
  const kept = await call("DELETE", "/api/agents/research-bot");
  assert.equal(kept.status, 200, JSON.stringify(kept.body));
  assert.equal(kept.body.sessionsDeleted, 2);
  assert.ok(existsSync(path.join(home, "agents", "research-bot", "SOUL.md")), "kept by default");
  assert.ok(!(await call("GET", "/api/agents")).body.agents.some((a) => a.id === "research-bot"));

  // Made again under the name it was given last, it takes its folder up again: not under the one it was made with.
  const other = await call("POST", "/api/agents", { name: "Research Bot" });
  assert.notEqual(other.body.home, path.join(home, "agents", "research-bot"), "the folder was kept for Scout");
  assert.equal((await call("DELETE", `/api/agents/${other.body.id}?folder=delete`)).status, 200);
  const back = await call("POST", "/api/agents", { name: "Scout" });
  assert.equal(back.body.id, "research-bot");
  assert.equal(back.body.initialised, true);

  const gone = await call("DELETE", "/api/agents/research-bot?folder=delete");
  assert.equal(gone.status, 200);
  assert.ok(!existsSync(path.join(home, "agents", "research-bot")));
  assert.ok(existsSync(path.join(home, "agent-home", "SOUL.md")));
});

test("each agent has an avatar of its own, and voice mode shows its chat's agent's", async () => {
  const ops = (await call("POST", "/api/agents", { name: "Ops" })).body;
  const before = (await call("GET", "/api/agents")).body.agents.find((a) => a.first).orb;
  const saved = await call("PUT", "/api/agents/ops/orb", { ...ops.orb, personality: "playful", hat: "crown" });
  assert.equal(saved.status, 200);
  const agents = (await call("GET", "/api/agents")).body.agents;
  assert.equal(agents.find((a) => a.id === "ops").orb.hat, "crown");
  assert.deepEqual(agents.find((a) => a.first).orb, before, "the first agent's avatar is untouched");

  const chat = (await call("POST", "/api/sessions", { agent: "ops" })).body;
  assert.equal((await call("GET", `/api/agent/orb?session=${chat.id}`)).body.hat, "crown");
  const homeChat = (await call("POST", "/api/sessions", {})).body;
  assert.deepEqual((await call("GET", `/api/agent/orb?session=${homeChat.id}`)).body, before);
  assert.equal((await call("PUT", "/api/agents/ops/orb", [])).status, 400);
});

test("an agent's avatar can be one an extension offers, and voice mode is told the chat's agent with it", async () => {
  const scout = (await call("POST", "/api/agents", { name: "Scout" })).body;
  assert.equal(scout.orb.avatar, "orb");
  const saved = await call("PUT", "/api/agents/scout/orb", { ...scout.orb, avatar: "test-puppet/puppet", hat: "crown" });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.avatar, "test-puppet/puppet");
  const agents = (await call("GET", "/api/agents")).body.agents;
  assert.equal(agents.find((a) => a.id === "scout").orb.avatar, "test-puppet/puppet");
  const first = agents.find((a) => a.first);

  const chat = (await call("POST", "/api/sessions", { agent: "scout" })).body;
  const avatar = (await call("GET", `/api/agent/avatar?session=${chat.id}`)).body;
  assert.deepEqual(avatar.agent, { id: "scout", name: "Scout" });
  // The orb's look is kept with the choice: it is what is drawn where the extension's cannot be.
  assert.deepEqual([avatar.orb.avatar, avatar.orb.hat], ["test-puppet/puppet", "crown"]);
  const homeChat = (await call("POST", "/api/sessions", {})).body;
  assert.deepEqual((await call("GET", `/api/agent/avatar?session=${homeChat.id}`)).body, { agent: { id: first.id, name: first.name }, orb: first.orb });
  // Saved without it, the orb is chosen again, as any field left out is its default.
  const { avatar: _, ...look } = saved.body;
  assert.equal((await call("PUT", "/api/agents/scout/orb", look)).body.avatar, "orb");
});

test("an agent speaks with a voice its voice mode's source offers, or the source's own choice", async () => {
  await call("POST", "/api/agents", { name: "Herald" });
  assert.equal((await call("GET", "/api/agents")).body.agents.find((a) => a.id === "herald").voice, "");
  // With no source, no voice is offered (voice-providers.test.mjs has one that offers some).
  const refused = await call("PUT", "/api/agents/herald/voice", { voice: "design" });
  assert.deepEqual([refused.status, refused.body.error], [400, "Choose one of the voices voice mode's source offers now, or none"]);
  assert.equal((await call("PUT", "/api/agents/herald/voice", { voice: "" })).body.voice, "");
  assert.equal((await call("PUT", "/api/agents/nobody/voice", { voice: "" })).status, 404);
});

test("a deleted agent's routines are switched off with its folder kept, and gone with it deleted, so a new agent of that name does not run them", async () => {
  const made = (await call("POST", "/api/agents", { name: "Scout" })).body;
  const routine = await call("POST", "/api/routines", { name: "scout daily", schedule: "@daily", instructions: "Look around.", workspace: made.home });
  assert.equal(routine.status, 200, JSON.stringify(routine.body));
  const routines = async () => (await call("GET", "/api/routines")).body.routines.filter((r) => r.name === "scout daily");

  // Its folder kept: the routine stays, off, and says why it cannot run.
  const kept = await call("DELETE", `/api/agents/${made.id}`);
  assert.deepEqual([kept.body.routinesSwitchedOff, kept.body.routinesDeleted], [["scout daily"], []]);
  const [left] = await routines();
  assert.equal(left.enabled, false);
  assert.match(left.workspaceProblem, /agent whose home this was has been deleted/, "not a complaint about the workspace root");
  // The agent made under the name has the folder again, and the routine with it, still off.
  assert.equal((await call("POST", "/api/agents", { name: "Scout" })).body.id, made.id);
  assert.deepEqual((await routines()).map((r) => [r.enabled, r.workspaceProblem]), [[false, null]]);

  // Its folder deleted: nothing of it is left for the next agent of that name.
  const gone = await call("DELETE", `/api/agents/${made.id}?folder=delete`);
  assert.deepEqual([gone.body.routinesSwitchedOff, gone.body.routinesDeleted], [[], ["scout daily"]]);
  assert.deepEqual(await routines(), []);
  assert.equal((await call("POST", "/api/agents", { name: "Scout" })).body.id, made.id);
  assert.deepEqual(await routines(), [], "the agent made again starts without it");
});

test("a routine made under the name of a deleted one starts a conversation of its own, and an explicit slug takes the old one up again", async () => {
  const made = (await call("POST", "/api/agents", { name: "Slug Bot" })).body;
  const first = (await call("POST", "/api/routines", { name: "slug daily", schedule: "@daily", instructions: "Old agent's plan.", workspace: made.home })).body;
  assert.equal(first.slug, "slug-daily");
  // A run of it, as one that ran leaves it behind.
  const db = new Database(path.join(home, "portal.db"));
  db.prepare("INSERT INTO sessions (id, title, workspace, executor, kind, routine_slug) VALUES ('slug-run', 'A run', ?, 'host', 'routine', ?)").run(made.home, first.slug);
  db.close();
  const runsOf = async (id) => (await call("GET", `/api/routines/${id}/sessions`)).body.sessions.map((s) => s.id);
  assert.deepEqual(await runsOf(first.id), ["slug-run"]);

  // Its agent deleted with its folder, and made again: its routine of that name is a new one.
  assert.deepEqual((await call("DELETE", `/api/agents/${made.id}?folder=delete`)).body.routinesDeleted, ["slug daily"]);
  assert.equal((await call("POST", "/api/agents", { name: "Slug Bot" })).body.home, made.home);
  const again = (await call("POST", "/api/routines", { name: "slug daily", schedule: "@daily", instructions: "New agent's plan.", workspace: made.home })).body;
  assert.notEqual(again.slug, first.slug, "not the slug whose runs are still there");
  assert.deepEqual(await runsOf(again.id), [], "it does not list the deleted routine's runs, and its first run is not made in one of them");

  // The same for one deleted by itself, once it has a run.
  const more = new Database(path.join(home, "portal.db"));
  more.prepare("INSERT INTO sessions (id, title, workspace, executor, kind, routine_slug) VALUES ('slug-run-2', 'A run', ?, 'host', 'routine', ?)").run(made.home, again.slug);
  more.close();
  assert.equal((await call("DELETE", `/api/routines/${again.id}`)).status, 200);
  const third = (await call("POST", "/api/routines", { name: "slug daily", schedule: "@daily", workspace: made.home })).body;
  assert.ok(![first.slug, again.slug].includes(third.slug));

  // A slug asked for is the way back to what that slug had.
  assert.equal((await call("DELETE", `/api/routines/${third.id}`)).status, 200);
  const back = (await call("POST", "/api/routines", { name: "slug daily", slug: first.slug, schedule: "@daily", workspace: made.home })).body;
  assert.equal(back.slug, first.slug);
  assert.deepEqual(await runsOf(back.id), ["slug-run"]);
});

test("a folder in an agent's home is not said to be the home of a deleted agent", async () => {
  const made = (await call("POST", "/api/agents", { name: "Path Bot" })).body;
  mkdirSync(path.join(made.home, "reports"));
  const place = async (workspace) => (await call("POST", "/api/sessions", { workspace })).body;
  assert.equal((await place(made.home)).workspace, made.home);
  assert.match((await place(path.join(made.home, "reports"))).error, /only an agent's home itself/, "a folder of an agent that is there");
  assert.match((await call("POST", "/api/routines", { name: "p", schedule: "@daily", workspace: path.join(made.home, "reports") })).body.error, /only an agent's home itself/);
  // Only a folder directly in the agents' folder was ever a home.
  const agents = path.dirname(made.home);
  assert.match((await place(path.join(agents, "nobody"))).error, /agent whose home this was has been deleted/);
  assert.match((await place(path.join(agents, "nobody", "reports"))).error, /inside the workspace root/);
  assert.match((await place(agents)).error, /inside the workspace root/);
  assert.match((await place("/etc")).error, /inside the workspace root/);
});

test("a routine's chat that its agent's delete left in place takes messages again, so the routine runs once the agent is made again", async () => {
  const made = (await call("POST", "/api/agents", { name: "Keeper" })).body;
  const routine = (await call("POST", "/api/routines", { name: "keeper daily", schedule: "@daily", instructions: "Look around.", workspace: made.home })).body;
  // By hand. With no model it ends in an error, with its pi still loaded: the delete lets go of that pi and keeps the chat.
  const first = await call("POST", `/api/routines/${routine.id}/run`);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.lastStatus, "error");
  assert.match(first.body.lastOutput, /There is no model to answer with/);

  const gone = await call("DELETE", `/api/agents/${made.id}`);
  assert.deepEqual(gone.body.routinesSwitchedOff, ["keeper daily"]);
  assert.equal((await call("POST", "/api/agents", { name: "Keeper" })).body.id, made.id);
  // The same run again, in the same chat: not "being deleted", which every run after it would meet until the portal restarted.
  const again = await call("POST", `/api/routines/${routine.id}/run`);
  assert.equal(again.body.lastOutput, first.body.lastOutput);
});

test("the New button's chat goes to the agent picked for new chats, the first agent's until one is, and again when that agent is deleted", async () => {
  const homePath = path.join(home, "agent-home");
  const picked = (await call("POST", "/api/agents", { name: "Default Pick" })).body;
  const other = (await call("POST", "/api/agents", { name: "Other Pick" })).body;
  const flags = async () => Object.fromEntries((await call("GET", "/api/agents")).body.agents.map((a) => [a.id, a.newChats]));
  assert.equal((await call("POST", "/api/sessions", {})).body.workspace, homePath);
  assert.equal((await flags()).home, true, "the first agent has them until another is picked");

  const on = await call("PUT", `/api/agents/${picked.id}/new-chats`, { on: true });
  assert.equal(on.status, 200, JSON.stringify(on.body));
  assert.equal(on.body.newChats, true);
  const now = await flags();
  assert.deepEqual(Object.keys(now).filter((id) => now[id]), [picked.id], "one agent has them");
  // The sidebar's house comes from this route, not from /api/agents.
  const shown = (await call("GET", "/api/projects?bare=1")).body.agents;
  assert.deepEqual(shown.filter((x) => x.newChats).map((x) => x.id), [picked.id], "the sidebar's list marks the picked agent and no other");
  assert.ok(shown.length >= 3 && shown.every((x) => x.newChats === (x.id === picked.id)), "every other agent is marked off");
  assert.equal((await call("POST", "/api/sessions", {})).body.workspace, picked.home);
  assert.equal((await call("POST", "/api/sessions", { agent: other.id })).body.workspace, other.home, "an agent named is the one used");
  assert.equal((await call("POST", "/api/sessions", { workspace: homePath })).body.workspace, homePath, "so is a folder named, Home included");

  assert.equal((await call("PUT", `/api/agents/${other.id}/new-chats`, { on: false })).body.newChats, false);
  assert.equal((await flags())[picked.id], true, "off for an agent that does not have them leaves the pick alone");
  assert.equal((await call("PUT", "/api/agents/nobody/new-chats", { on: true })).status, 404);
  assert.equal((await call("PUT", "/api/agents/nobody/new-chats", { on: false })).status, 404);
  for (const body of [undefined, {}, { on: "false" }, { on: 0 }, { on: null }]) {
    const bad = await call("PUT", `/api/agents/${other.id}/new-chats`, body);
    assert.equal(bad.status, 400, JSON.stringify(body));
    assert.equal(bad.body.error, "on must be a boolean");
  }
  assert.equal((await flags())[picked.id], true, "a malformed body does not move the pick");

  await call("PUT", `/api/agents/${picked.id}/new-chats`, { on: false });
  assert.equal((await call("POST", "/api/sessions", {})).body.workspace, homePath, "off hands them back to the first agent");

  await call("PUT", `/api/agents/${picked.id}/new-chats`, { on: true });
  await call("DELETE", `/api/agents/${picked.id}`);
  assert.equal((await call("POST", "/api/sessions", {})).body.workspace, homePath, "a deleted agent is not the pick");
  const again = (await call("POST", "/api/agents", { name: "Default Pick" })).body;
  assert.equal(again.newChats, false, "one made later under its name does not inherit it");
});
