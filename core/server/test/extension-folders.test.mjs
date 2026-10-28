import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { freePort, serverEnv, startServer, testHome } from "./server-harness.mjs";

/**
 * What a server half is told of the folders the agents work in (`portal.folders`): each of them, by its real path and
 * what the person calls it, which of them it may serve from, what the person calls one no list has any more, and when
 * the portal deletes one. Against the whole server, with one package installed whose server half keeps what it heard
 * in its own folder.
 */
const home = testHome("extension-folders-");
const pkg = path.join(home, "packages", "watcher");
mkdirSync(pkg, { recursive: true });
writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "folder-watcher", version: "1.0.0", pi: {}, pithagoras: { server: "./server.js" } }));
writeFileSync(
  path.join(pkg, "server.js"),
  `import { appendFileSync } from "node:fs";
import path from "node:path";
export default function (portal) {
  portal.folders.on("removed", (folder) => appendFileSync(path.join(portal.dataDir(), "removed.txt"), folder + "\\n"));
  portal.router.get("/folders", (req, res) => res.json({ list: portal.folders.list(), allowed: portal.folders.allowed(String(req.query.check ?? "")) }));
  portal.router.get("/label", (req, res) => res.json(portal.folders.label(String(req.query.folder))));
}
`,
);
// pi, as far as the portal asks it which packages there are.
const bin = path.join(home, "fake-bin");
mkdirSync(bin, { recursive: true });
writeFileSync(path.join(bin, "pi"), `#!/bin/bash\n[ "$1" = list ] || exit 0\nprintf 'User packages:\\n  npm:folder-watcher\\n    ${pkg}\\n'\n`);
chmodSync(path.join(bin, "pi"), 0o755);
writeFileSync(path.join(home, "agent", "settings.json"), JSON.stringify({ packages: ["npm:folder-watcher"] }));

const env = serverEnv(home, await freePort());
const { base } = await startServer({ ...env, PATH: `${bin}${path.delimiter}${env.PATH}` });
const call = async (method, url, body) => {
  const res = await fetch(`${base}${url}`, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
};
const removed = () => {
  const file = path.join(home, "extension-data", "folder-watcher", "removed.txt");
  return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n") : [];
};
/** The server half is started after the portal listens: asked until it answers. */
async function folders(check = "") {
  for (let i = 0; i < 100; i++) {
    const res = await fetch(`${base}/api/x/folder-watcher/folders?check=${encodeURIComponent(check)}`);
    if (res.status === 200) return res.json();
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("the server half never answered");
}

test("a server half is told of the folders the agents work in, and when the portal deletes one", async () => {
  const project = await call("POST", "/api/projects", { name: "Garden" });
  assert.equal(project.status, 200, JSON.stringify(project.body));
  const agent = await call("POST", "/api/agents", { name: "Scout" });
  assert.equal(agent.status, 200, JSON.stringify(agent.body));
  const real = (p) => realpathSync(p);

  const { list } = await folders();
  const named = (p) => list.find((f) => f.path === real(p));
  // A project by its place under the workspace root.
  assert.deepEqual(named(project.body.path), { path: real(project.body.path), name: path.basename(project.body.path), kind: "project" });
  assert.deepEqual(named(agent.body.home), { path: real(agent.body.home), name: "Scout", kind: "agent" });
  assert.equal(named(path.join(home, "agent-home")).home, true, "the first agent's home is Home");
  assert.equal((await folders(real(project.body.path))).allowed, true);
  assert.equal((await folders(real(path.join(home, "agent")))).allowed, false, "pi's own folder is not a folder the agents work in");

  const projectFolder = real(project.body.path);
  const agentHome = real(agent.body.home);
  assert.equal((await call("DELETE", `/api/projects/${project.body.name}?discard=1`)).status, 200);
  // An agent whose folder is kept is not a folder that went.
  const kept = await call("POST", "/api/agents", { name: "Keeper" });
  assert.equal((await call("DELETE", `/api/agents/${kept.body.id}`)).status, 200);
  assert.equal((await call("DELETE", `/api/agents/${agent.body.id}?folder=delete`)).status, 200);
  assert.deepEqual(removed(), [projectFolder, agentHome]);
});

test("a server half is told what the person calls a folder, whether a list has it or not", async () => {
  const project = await call("POST", "/api/projects", { name: "Orchard" });
  assert.equal(project.status, 200, JSON.stringify(project.body));
  const agent = await call("POST", "/api/agents", { name: "Picker" });
  assert.equal(agent.status, 200, JSON.stringify(agent.body));
  const label = async (folder) => (await call("GET", `/api/x/folder-watcher/label?folder=${encodeURIComponent(folder)}`)).body;
  await folders();

  const real = (p) => realpathSync(p);
  const projectFolder = real(project.body.path);
  assert.deepEqual(await label(projectFolder), { name: path.basename(project.body.path) });
  assert.deepEqual(await label(real(agent.body.home)), { name: "Picker" });
  assert.equal((await label(real(path.join(home, "agent-home")))).home, true, "the first agent's home is Home");
  // A folder in a project, which no list has, by its place under the workspace root; one outside it by its last part.
  assert.deepEqual(await label(path.join(projectFolder, "beds", "north")), { name: `${path.basename(project.body.path)}/beds/north` });
  assert.deepEqual(await label("/somewhere/else"), { name: "else" });
  // And one that went with its project is still named as it was.
  assert.equal((await call("DELETE", `/api/projects/${project.body.name}?discard=1`)).status, 200);
  assert.deepEqual(await label(projectFolder), { name: path.basename(project.body.path) });
});

test("the default agent's home is marked home, and the home of the agent New starts chats with newChats, as the agents say", async () => {
  const agent = await call("POST", "/api/agents", { name: "Usher" });
  assert.equal(agent.status, 200, JSON.stringify(agent.body));
  const label = async (folder) => (await call("GET", `/api/x/folder-watcher/label?folder=${encodeURIComponent(folder)}`)).body;
  const real = (p) => realpathSync(p);
  const marked = async (mark) => {
    const { list } = await folders();
    return list.filter((one) => one[mark]).map((one) => one.path);
  };
  // The agents as the page has them: which one is first, which one New starts chats with.
  const agents = async () => (await call("GET", "/api/agents")).body.agents;
  const first = (await agents()).find((one) => one.first);
  const homeFolder = real(first.home);

  assert.deepEqual(await marked("home"), [homeFolder], "the first agent's home, and only it");
  assert.deepEqual(await marked("newChats"), [homeFolder], "New starts chats with the first agent unless another is picked");
  assert.deepEqual(await label(homeFolder), { name: first.name, home: true, newChats: true });

  assert.equal((await call("PUT", `/api/agents/${agent.body.id}/new-chats`, { on: true })).status, 200);
  assert.equal((await agents()).find((one) => one.newChats).id, agent.body.id);
  assert.deepEqual(await marked("home"), [homeFolder], "the default agent stays the first");
  assert.deepEqual(await marked("newChats"), [real(agent.body.home)], "the picked agent's home");
  assert.deepEqual(await label(real(agent.body.home)), { name: "Usher", newChats: true });
  assert.deepEqual(await label(homeFolder), { name: first.name, home: true });

  // Its agent deleted, New starts chats with the first agent again, and so says the list.
  assert.equal((await call("DELETE", `/api/agents/${agent.body.id}`)).status, 200);
  assert.deepEqual(await marked("newChats"), [homeFolder]);
});
