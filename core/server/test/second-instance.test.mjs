import { test, before } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fakeModel } from "./fake-model.mjs";
import { ENTRY, freePort, inProcessHome, runToEnd, serverEnv, startServer, testHome } from "./server-harness.mjs";

/**
 * The server started a second time: by an extension that starts pi as pi's
 * examples do, with this runtime and `process.argv[1]`, or as a second server,
 * by hand or by the agent in a chat.
 */
const home = inProcessHome("pithagoras-second-");
const agentDir = path.join(home, "agent");

/** A model that answers every request with the same words, streamed. */
const model = await fakeModel(() => "Found it in the archive.");
writeFileSync(path.join(agentDir, "models.json"), JSON.stringify(model.models()));

writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "fake", defaultModel: "m" }));

// An extension saying what pi is to extensions in the server: what the
// deep-research extension reads to start another. It also reads every file in
// the data directory once, as the agent's read tool could: a lock on a file
// was let go by the whole process when any of it closed that file.
const seen = path.join(home, "argv.json");
mkdirSync(path.join(agentDir, "extensions"), { recursive: true });
writeFileSync(path.join(agentDir, "extensions", "argv.ts"), `
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
export default function () {
  if (existsSync(${JSON.stringify(seen)})) return;
  for (const name of readdirSync(${JSON.stringify(home)})) {
    try { readFileSync(path.join(${JSON.stringify(home)}, name)); } catch {}
  }
  writeFileSync(${JSON.stringify(seen)}, JSON.stringify([process.execPath, process.argv[1]]));
}
`);

let port = await freePort();
const env = serverEnv(home, port);

const db = await import("../dist/db.js");

let base;
before(async () => {
  ({ base, port } = await startServer(env));
  // The port it listens on, which is another than it was given where that one was taken meanwhile.
  env.PORT = String(port);
});

const newChat = async () =>
  (await (await fetch(`${base}/api/sessions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).json()).id;
/** A chat the first server has running, as far as the database says. */
async function runningChat() {
  const id = await newChat();
  db.updateSession(id, { status: "running" });
  return id;
}
/** Still running, and nothing in the chat says it was interrupted. */
function untouched(id) {
  assert.equal(db.getSession(id).status, "running");
  assert.equal(db.eventsSince(id, 0).filter((e) => e.type === "portal_status").length, 0);
}

test("an extension in the server that starts pi as pi's examples do gets pi, and an answer", async () => {
  // As @forecastx/deep-research does it. It used to get a second server, which
  // failed on the port, and its research came back empty.
  const chat = await newChat();
  await fetch(`${base}/api/sessions/${chat}/prompt`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: "Hello" }) });
  for (let i = 0; !existsSync(seen); i++) {
    assert.ok(i < 200, "the extension was never loaded");
    await new Promise((r) => setTimeout(r, 50));
  }
  const [runtime, script] = JSON.parse(readFileSync(seen, "utf8"));
  assert.equal(runtime, process.execPath);
  assert.notEqual(script, ENTRY);
  // With an environment of its own: nothing the server set is needed.
  const { code, out, err } = await runToEnd([script, "--mode", "json", "-p", "--no-session", "Look it up"], {
    PATH: process.env.PATH, HOME: home, PI_CODING_AGENT_DIR: agentDir,
  }, { cwd: home });
  assert.equal(code, 0, err);
  assert.match(out, /Found it in the archive\./);
});

test("a second server on the same data says so, and leaves the first one's chats running", async () => {
  const id = await runningChat();
  // On the same port and on another: the agent in a chat starting the server
  // to try it has the same data, and a PORT of its own. Given an argument too.
  for (const [args, second] of [[[], env], [[], { ...env, PORT: String(await freePort()) }], [["--version"], env]]) {
    const { code, out, err } = await runToEnd([ENTRY, ...args], second, { cwd: home });
    assert.equal(code, 1, out + err);
    assert.match(err, new RegExp(`already running on ${home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.doesNotMatch(out + err, /at Server\.|at listen/, "no stack trace");
    // Before, it had marked them interrupted by the time it found out, and
    // said so in each.
    untouched(id);
  }
});

test("a server killed outright does not keep the next one out", async () => {
  const other = testHome("pithagoras-second-killed-");
  const { child } = await startServer(serverEnv(other, await freePort()));
  child.kill("SIGKILL");
  await once(child, "exit");
  // Its socket is still there, and answers nobody.
  await startServer(serverEnv(other, await freePort()));
});

test("a data directory too long for a socket in it is held all the same", async () => {
  const deep = path.join(testHome("pithagoras-second-deep-"), "x".repeat(60), "y".repeat(60));
  const lock = new URL("../dist/instance-lock.js", import.meta.url).href;
  const { code, out, err } = await runToEnd(["--input-type=module", "-e", `
    import { holdDataDir } from ${JSON.stringify(lock)};
    process.stdout.write(String(await holdDataDir(${JSON.stringify(deep)})) + " " + String(await holdDataDir(${JSON.stringify(deep)})));
  `], process.env);
  assert.equal(code, 0, err);
  assert.equal(out.trim(), "true false", "held, and then refused");
  assert.ok(!existsSync(path.join(deep, "portal.sock")));
});

test("a server that cannot listen says where and why, without a stack trace", async () => {
  const { code, out, err } = await runToEnd([ENTRY], serverEnv(testHome("pithagoras-second-other-"), port));
  assert.equal(code, 1, out + err);
  assert.match(err, new RegExp(`could not listen on 127\\.0\\.0\\.1:${port}: .*address already in use`));
  assert.doesNotMatch(out + err, /at Server\.|at listen/);
});
