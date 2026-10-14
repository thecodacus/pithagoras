import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { freePort, inProcessHome, serverEnv, startServer } from "./server-harness.mjs";

/**
 * Where a chat may run: Home, or inside the workspace root, judged by where the
 * path really leads. A link an agent made in a project is the case that matters:
 * it passes the check on the text of the path, and leads anywhere.
 */
const home = inProcessHome("pithagoras-workspaces-");
const root = path.join(home, "ws");
const outside = path.join(home, "outside");
mkdirSync(path.join(root, "site", "docs"), { recursive: true });
mkdirSync(path.join(root, "notes"), { recursive: true });
mkdirSync(outside);
writeFileSync(path.join(root, "site", "README.md"), "a file\n");
// What an agent can do in a project it works in.
symlinkSync(outside, path.join(root, "escape"));
symlinkSync("/", path.join(root, "to-root"));
symlinkSync(path.join(root, "notes"), path.join(root, "site", "inside-link"));
symlinkSync(path.join(home, "gone"), path.join(root, "dangling"));

const { checkWorkspace, projectOf } = await import("../dist/workspaces.js");
const { agentHomePath } = await import("../dist/agent-home.js");

const refusal = "workspace must be inside the workspace root";

test("a project by its name, by its path, or a folder inside it is a place to work", () => {
  assert.deepEqual(checkWorkspace("site"), { path: path.join(root, "site") });
  assert.deepEqual(checkWorkspace(path.join(root, "site")), { path: path.join(root, "site") });
  assert.deepEqual(checkWorkspace(path.join(root, "site", "docs")), { path: path.join(root, "site", "docs") });
});

test("a place outside the root is refused, however it is written", () => {
  for (const raw of ["../outside", "site/../../outside", outside, "/etc", "/", root + "-other"]) {
    assert.deepEqual(checkWorkspace(raw), { error: refusal }, raw);
  }
});

test("a link that leads out of the root is refused, a link that stays inside is not", () => {
  // The text of these paths is inside the root; where they lead is not.
  assert.deepEqual(checkWorkspace("escape"), { error: refusal });
  assert.deepEqual(checkWorkspace(path.join(root, "to-root")), { error: refusal });
  // The same link is as much a way out when it is a folder further down.
  assert.deepEqual(checkWorkspace("escape/"), { error: refusal });
  // Where it leads is the project's own neighbour: still in the root.
  assert.deepEqual(checkWorkspace(path.join(root, "site", "inside-link")), { path: path.join(root, "site", "inside-link") });
});

test("a place that is not there, a link to nothing, and a file are refused with their own reason", () => {
  assert.deepEqual(checkWorkspace("nope"), { error: "workspace does not exist" });
  assert.deepEqual(checkWorkspace("dangling"), { error: "workspace does not exist" });
  assert.deepEqual(checkWorkspace(path.join(root, "site", "README.md")), { error: "workspace is not a directory" });
});

test("Home is the one place outside the root a chat may work in, and only itself", () => {
  const agentHome = agentHomePath();
  mkdirSync(agentHome, { recursive: true });
  assert.deepEqual(checkWorkspace(agentHome), { path: agentHome });
  // Not what is inside it, which says why, or beside it.
  assert.deepEqual(checkWorkspace(path.join(agentHome, "sub")), { error: "only an agent's home itself can be used, not a folder in it" });
  assert.deepEqual(checkWorkspace(path.dirname(agentHome)), { error: refusal });
});

test("the root itself being a link does not turn every project away, and a link out of it is still one", (t) => {
  const real = path.join(home, "real-root");
  const linked = path.join(home, "linked-root");
  mkdirSync(path.join(real, "p"), { recursive: true });
  symlinkSync(outside, path.join(real, "out"));
  symlinkSync(real, linked);
  const before = process.env.WORKSPACE_ROOT;
  process.env.WORKSPACE_ROOT = linked;
  t.after(() => { process.env.WORKSPACE_ROOT = before; });
  assert.deepEqual(checkWorkspace("p"), { path: path.join(linked, "p") });
  assert.deepEqual(checkWorkspace("out"), { error: refusal });
  assert.equal(projectOf(path.join(linked, "p")), "p");
  assert.equal(projectOf(path.join(real, "p")), "p");
});

test("the project a place belongs to is where it really leads", () => {
  assert.equal(projectOf(path.join(root, "site", "docs")), "site");
  // A link in one project to another has the settings of the second.
  assert.equal(projectOf(path.join(root, "site", "inside-link")), "notes");
  assert.equal(projectOf(outside), undefined);
  assert.equal(projectOf(agentHomePath()), undefined);
});

let base;
before(async () => {
  ({ base } = await startServer(serverEnv(home, await freePort())));
});
const start = (workspace) =>
  fetch(`${base}/api/sessions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ workspace }) })
    .then(async (r) => ({ status: r.status, ...(await r.json()) }));

test("a chat is started only in a place the check allows", async () => {
  assert.equal((await start("site")).workspace, path.join(root, "site"));
  assert.equal((await start(agentHomePath())).workspace, agentHomePath());
  for (const raw of ["escape", "../outside", outside, path.join(root, "to-root"), "nope", path.join(root, "site", "README.md")]) {
    const refused = await start(raw);
    assert.equal(refused.status, 400, raw);
    assert.match(refused.error, /^workspace /, raw);
  }
  // Without one it starts in Home.
  const none = await fetch(`${base}/api/sessions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  assert.equal((await none.json()).workspace, agentHomePath());
});
