import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { inProcessHome } from "./server-harness.mjs";

// Tool settings per project: a layer between the portal-wide default and a
// chat's own exceptions, resolved from where the chat works.
const home = inProcessHome("pithagoras-project-tools-");
const ws = process.env.WORKSPACE_ROOT;
// A server called `browser`, so its tools are the browser's.
writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, "mcp.json"), JSON.stringify({ mcpServers: { browser: {} } }));
for (const dir of ["alpha/sub", "alpha-old", "beta", ".hidden"]) mkdirSync(path.join(ws, dir), { recursive: true });
// A folder inside alpha that is really beta.
symlinkSync(path.join(ws, "beta"), path.join(ws, "alpha", "to-beta"));

const db = await import("../dist/db.js");
const { projectOf } = await import("../dist/workspaces.js");
const { sessions } = await import("../dist/session-manager.js");

db.rememberTools([
  { name: "web_search", source: "pi-web-access" },
  { name: "web_fetch", source: "pi-web-access" },
  { name: "todo", source: "pi-todo" },
  { name: "browser_browser_click", source: "pi-mcp-adapter" },
]);

let n = 0;
/** A chat working in `workspace`. */
const chat = (workspace) => {
  const id = `c${++n}`;
  db.createSession({ id, title: id, workspace, executor: "host" });
  return id;
};
const reset = () => {
  db.setToolDefaultsOff([]);
  for (const p of ["alpha", "beta"]) db.clearProjectTools(p);
};

test("the project of a chat is the folder directly under the root that it works in or below", () => {
  assert.equal(projectOf(path.join(ws, "alpha")), "alpha");
  // A chat may run in a subfolder, and belongs to the project all the same.
  assert.equal(projectOf(path.join(ws, "alpha", "sub")), "alpha");
  assert.equal(projectOf(path.join(ws, "alpha", "sub") + "/"), "alpha");
  // A folder that only shares the start of the name is another project.
  assert.equal(projectOf(path.join(ws, "alpha-old")), "alpha-old");
  // `..` says what it means.
  assert.equal(projectOf(path.join(ws, "alpha", "..", "beta")), "beta");
});

test("Home, the root itself and anything outside it are in no project", () => {
  assert.equal(projectOf(process.env.AGENT_HOME), undefined);
  assert.equal(projectOf(ws), undefined);
  assert.equal(projectOf(home), undefined);
  assert.equal(projectOf(path.join(home, "ws-elsewhere", "alpha")), undefined);
  assert.equal(projectOf(path.join(ws, ".hidden")), undefined);
  assert.equal(projectOf(null), undefined);
  assert.equal(projectOf(""), undefined);
});

test("a link from one project into another counts as the project it leads to", () => {
  // Otherwise working in beta through alpha's link would run on alpha's tools.
  assert.equal(projectOf(path.join(ws, "alpha", "to-beta")), "beta");
});

test("a folder that is gone is still told by its path", () => {
  assert.equal(projectOf(path.join(ws, "removed", "deep")), "removed");
});

test("with no project settings anywhere, a chat is as it always was", () => {
  reset();
  db.setToolDefaultsOff(["web_search"]);
  const inProject = chat(path.join(ws, "alpha"));
  const inHome = chat(process.env.AGENT_HOME);
  assert.deepEqual(sessions.offFor(inProject), ["web_search"]);
  assert.deepEqual(sessions.offFor(inHome), ["web_search"]);
  db.setSessionTools(inProject, { off: ["todo"], on: [] });
  assert.deepEqual(sessions.offFor(inProject), ["todo", "web_search"]);
  assert.deepEqual(db.projectTools("alpha"), { off: [], on: [] });
});

test("the order is the portal-wide default, then the project, then the chat", () => {
  reset();
  db.setToolDefaultsOff(["web_search", "web_fetch"]);
  // The project switches web_search back on and todo off.
  db.setProjectTools("alpha", { off: ["todo"], on: ["web_search"] });

  const plain = chat(path.join(ws, "alpha"));
  assert.deepEqual(sessions.offFor(plain), ["todo", "web_fetch"]);

  // The chat has the last word, in both directions.
  const own = chat(path.join(ws, "alpha", "sub"));
  db.setSessionTools(own, { off: ["web_search"], on: ["todo"] });
  assert.deepEqual(sessions.offFor(own), ["web_fetch", "web_search"]);

  // Another project and Home are not touched by it.
  assert.deepEqual(sessions.offFor(chat(path.join(ws, "beta"))), ["web_fetch", "web_search"]);
  assert.deepEqual(sessions.offFor(chat(process.env.AGENT_HOME)), ["web_fetch", "web_search"]);
});

test("what a chat held before its project said anything is kept as it was", () => {
  reset();
  db.setToolDefaultsOff(["web_search"]);
  const id = chat(path.join(ws, "alpha"));
  // Its own decisions: todo off although the default leaves it on, web_search on
  // although the default has it off. And web_fetch it never mentioned.
  db.setSessionTools(id, { off: ["todo"], on: ["web_search"] });
  assert.deepEqual(sessions.offFor(id), ["todo"]);

  // The project now disagrees on all three.
  db.setProjectTools("alpha", { off: ["web_search", "web_fetch"], on: ["todo"] });

  // The two it decided are still its own; the one it never mentioned follows the project.
  assert.deepEqual(sessions.offFor(id), ["todo", "web_fetch"]);
});

test("a chat's switch is written against what its project starts it with", async () => {
  reset();
  db.setProjectTools("alpha", { off: ["web_search"], on: [] });
  const id = chat(path.join(ws, "alpha"));

  // Wanting exactly what the project says writes nothing down, so a later change to it still reaches the chat.
  await sessions.setTools(id, ["web_search"]);
  assert.deepEqual(db.sessionTools(id), { off: [], on: [] });

  // Switching on what the project has off is the chat's own exception.
  await sessions.setTools(id, []);
  assert.deepEqual(db.sessionTools(id), { off: [], on: ["web_search"] });
  assert.deepEqual(sessions.offFor(id), []);

  // And the chat shows where it disagrees with its project.
  const { tools } = await sessions.getTools(id);
  const search = tools.find((t) => t.name === "web_search");
  assert.equal(search.enabled, true);
  assert.equal(search.defaultOn, false);
  assert.equal(tools.find((t) => t.name === "todo").defaultOn, true);
});

test("the portal-wide default still reaches a project's tools it never disagreed about", () => {
  reset();
  db.setProjectTools("alpha", { off: ["todo"], on: [] });
  const id = chat(path.join(ws, "alpha"));
  assert.deepEqual(sessions.offFor(id), ["todo"]);
  db.setToolDefaultsOff(["web_fetch"]);
  assert.deepEqual(sessions.offFor(id), ["todo", "web_fetch"]);
});

test("a project that says nothing leaves no row", () => {
  reset();
  db.setProjectTools("alpha", { off: ["todo", "todo", " "], on: [] });
  assert.deepEqual(db.projectTools("alpha"), { off: ["todo"], on: [] });
  assert.ok(db.projectsWithTools().has("alpha"));
  db.setProjectTools("alpha", { off: [], on: [] });
  assert.ok(!db.projectsWithTools().has("alpha"));
});

test("a routine run in a project gets the project's tools", () => {
  reset();
  db.setProjectTools("beta", { off: ["web_search"], on: [] });
  const id = "run1";
  db.createSession({ id, title: "run", workspace: path.join(ws, "beta"), executor: "host", kind: "routine", routine_slug: "nightly" });
  assert.deepEqual(sessions.offFor(id), ["web_search"]);
});

test("the browser follows the project: its tools off there take the browser with them", () => {
  reset();
  const inAlpha = db.getSession(chat(path.join(ws, "alpha")));
  const inBeta = db.getSession(chat(path.join(ws, "beta")));
  assert.equal(db.browserAllowed(inAlpha), true);
  db.setProjectTools("alpha", { off: ["browser_browser_click"], on: [] });
  assert.equal(db.browserAllowed(inAlpha), false);
  assert.equal(db.browserAllowed(inBeta), true);
  // Listed with the conversations that differ from the default, though it never said anything itself.
  const differ = db.browserExceptions().map((s) => s.id);
  assert.ok(differ.includes(inAlpha.id));
  assert.ok(!differ.includes(inBeta.id));
  // A chat that switched it back on is the exception to its project.
  db.setSessionTools(inAlpha.id, { off: [], on: ["browser_browser_click"] });
  assert.equal(db.browserAllowed(inAlpha), true);
});

test("a change to a project reaches the chats running in it, and only those", async () => {
  reset();
  const told = {};
  const fake = (id) => ({
    getTools: async () => [],
    setToolsOff: async (off) => { (told[id] ??= []).push(off); },
  });
  const inAlpha = chat(path.join(ws, "alpha", "sub"));
  const inBeta = chat(path.join(ws, "beta"));
  const inHome = chat(process.env.AGENT_HOME);
  for (const id of [inAlpha, inBeta, inHome]) sessions.live.set(id, { client: fake(id) });
  try {
    db.setProjectTools("alpha", { off: ["todo"], on: [] });
    assert.equal(await sessions.applyToolDefaults("alpha"), 1);
    assert.deepEqual(told, { [inAlpha]: [["todo"]] });
    // Without a project it is the portal-wide default that changed: everyone is told.
    assert.equal(await sessions.applyToolDefaults(), 3);
  } finally {
    for (const id of [inAlpha, inBeta, inHome]) sessions.live.delete(id);
  }
});
