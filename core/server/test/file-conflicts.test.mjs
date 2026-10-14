import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { freePort, scratch, serverEnv, startServer, testHome } from "./server-harness.mjs";
const { holdDataDir } = await import("../dist/instance-lock.js");

/**
 * What the pages save while the agent works in the same files: the agent's own
 * files and a project's AGENTS.md answer 409 to a save made from an older copy.
 */
const home = testHome("file-conflicts-");
writeFileSync(path.join(home, "agent-home", "MEMORY.md"), "# MEMORY.md\n");
const { base } = await startServer(serverEnv(home, await freePort()));

const call = async (method, url, body) => {
  const res = await fetch(`${base}${url}`, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
};
const memory = (setup) => setup.files.find((f) => f.name === "MEMORY.md");

test("an agent's file is saved with the time the page read it at, and not over what the agent wrote since", async () => {
  const opened = (await call("GET", "/api/agents/home/setup")).body;
  assert.ok(memory(opened).mtime > 0);
  assert.equal(opened.files.find((f) => f.name === "WATCH.md").mtime, 0, "a file that is not there has no time");

  const file = path.join(home, "agent-home", "MEMORY.md");
  // The agent records a decision while the page is open.
  writeFileSync(file, "# MEMORY.md\n\nThree decisions.\n");
  utimesSync(file, new Date(), new Date(memory(opened).mtime + 60_000));
  const stale = await call("PUT", "/api/agents/home/files/MEMORY.md", { content: "# MEMORY.md\n\nA typo fixed.", mtime: memory(opened).mtime });
  assert.equal(stale.status, 409, JSON.stringify(stale.body));
  assert.equal(stale.body.error, "The file changed after you opened it");
  assert.equal(readFileSync(file, "utf8"), "# MEMORY.md\n\nThree decisions.\n");

  // Read again, the save goes through, and answers the new time to send next.
  const reread = (await call("GET", "/api/agents/home/setup")).body;
  const saved = await call("PUT", "/api/agents/home/files/MEMORY.md", { content: "# MEMORY.md\n\nFixed.", mtime: memory(reread).mtime });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(memory(saved.body).content, "# MEMORY.md\n\nFixed.\n");
  assert.ok(memory(saved.body).mtime > 0, "the answer carries the time to send next");

  // "Save mine anyway": no time, whatever is there is replaced.
  writeFileSync(file, "the agent again\n");
  assert.equal((await call("PUT", "/api/agents/home/files/MEMORY.md", { content: "mine" })).status, 200);
  assert.equal(readFileSync(file, "utf8"), "mine\n");
  assert.equal((await call("PUT", "/api/agents/home/files/MEMORY.md", { content: "x", mtime: "soon" })).status, 400);
  assert.equal((await call("PUT", "/api/agents/home/files/notes.txt", { content: "x" })).status, 400, "only the agent's own files");
});

test("the first agent's older addresses answer as the scoped ones do: a file changed since is not overwritten, and the wizard names what it kept", async () => {
  const file = path.join(home, "agent-home", "MEMORY.md");
  writeFileSync(file, "# MEMORY.md\n\nBefore.\n");
  const opened = (await call("GET", "/api/agent/setup")).body;
  writeFileSync(file, "# MEMORY.md\n\nWhat the agent wrote.\n");
  utimesSync(file, new Date(), new Date(memory(opened).mtime + 60_000));
  const stale = await call("PUT", "/api/agent/files/MEMORY.md", { content: "old page text", mtime: memory(opened).mtime });
  assert.equal(stale.status, 409, JSON.stringify(stale.body));
  assert.equal(stale.body.code, "conflict");
  assert.equal(readFileSync(file, "utf8"), "# MEMORY.md\n\nWhat the agent wrote.\n");
  assert.equal((await call("PUT", "/api/agent/files/MEMORY.md", { content: "x", mtime: "soon" })).status, 400);

  const reread = (await call("GET", "/api/agent/setup")).body;
  assert.equal((await call("PUT", "/api/agent/files/MEMORY.md", { content: "Fixed.", mtime: memory(reread).mtime })).status, 200);

  const wizard = await call("POST", "/api/agent/setup", { agentName: "Ada", userName: "Sam" });
  assert.equal(wizard.status, 200, JSON.stringify(wizard.body));
  assert.ok(wizard.body.kept.includes("MEMORY.md"), "the file that was there is named, not silently kept");
  assert.equal(readFileSync(file, "utf8"), "Fixed.\n");
});

test("a project's instructions are saved with the time they were read at", async () => {
  const made = await call("POST", "/api/projects", { name: "demo", instructions: "Use tabs." });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  const opened = (await call("GET", "/api/projects/demo/instructions")).body;
  assert.equal(opened.text, "Use tabs.\n");
  assert.ok(opened.mtime > 0);

  const file = path.join(home, "ws", "demo", "AGENTS.md");
  writeFileSync(file, "Use tabs.\nNever force-push.\n");
  utimesSync(file, new Date(), new Date(opened.mtime + 60_000));
  const stale = await call("PUT", "/api/projects/demo/instructions", { text: "Use spaces.", mtime: opened.mtime });
  assert.equal(stale.status, 409, JSON.stringify(stale.body));
  assert.equal(readFileSync(file, "utf8"), "Use tabs.\nNever force-push.\n");

  const reread = (await call("GET", "/api/projects/demo/instructions")).body;
  assert.equal((await call("PUT", "/api/projects/demo/instructions", { text: "Use spaces.", mtime: reread.mtime })).status, 200);
  assert.equal(readFileSync(file, "utf8"), "Use spaces.\n");
  assert.equal((await call("PUT", "/api/projects/demo/instructions", { text: "Tabs.", mtime: "soon" })).status, 400);
  assert.equal((await call("PUT", "/api/projects/demo/instructions", { text: "Tabs." })).status, 200, "without a time it replaces, as before");
});

test("an agent made again under a deleted agent's name takes up its files and does not rewrite them", async () => {
  const first = await call("POST", "/api/agents", { name: "Ada", setup: { userName: "Sam" } });
  assert.equal(first.status, 200);
  assert.deepEqual(first.body.kept, []);
  writeFileSync(path.join(first.body.home, "SOUL.md"), "# Ada, by hand\n");
  writeFileSync(path.join(first.body.home, "PrimaryUser.md"), "# Sam, by hand\n");
  assert.equal((await call("DELETE", "/api/agents/ada")).status, 200);

  const again = await call("POST", "/api/agents", { name: "Ada", setup: { userName: "Somebody else", vibe: "Brisk." } });
  assert.equal(again.status, 200);
  assert.equal(again.body.id, "ada");
  assert.deepEqual(again.body.kept.sort(), ["MEMORY.md", "PrimaryUser.md", "SOUL.md"]);
  assert.equal(readFileSync(path.join(again.body.home, "SOUL.md"), "utf8"), "# Ada, by hand\n");
  assert.equal(readFileSync(path.join(again.body.home, "PrimaryUser.md"), "utf8"), "# Sam, by hand\n");
});

test("the raw MCP file is saved for its owner alone", async () => {
  const file = path.join(home, "agent", "mcp.json");
  writeFileSync(file, "{}\n", { mode: 0o644 });
  chmodSync(file, 0o644);
  assert.equal((await call("PUT", "/api/mcp/raw", { content: '{ "mcpServers": {} }' })).status, 200);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(readFileSync(file, "utf8"), '{ "mcpServers": {} }\n');
});

test("the data folder is closed to every other account, whoever made it", async () => {
  const parent = scratch("data-mode-");
  const made = path.join(parent, "new", "data");
  assert.equal(await holdDataDir(made), true);
  assert.equal(statSync(made).mode & 0o777, 0o700);
  // One an older version or the host made, readable by everybody.
  const old = path.join(parent, "old");
  mkdirSync(old, { mode: 0o755 });
  chmodSync(old, 0o755);
  assert.equal(await holdDataDir(old), true);
  assert.equal(statSync(old).mode & 0o777, 0o700);
  assert.ok(existsSync(path.join(old, "portal.sock")));
});
