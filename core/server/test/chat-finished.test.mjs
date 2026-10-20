import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { inProcessHome } from "./server-harness.mjs";

// A server half is told a chat is finished when the run it was started for is over and the portal stopped its pi for
// good: a routine run in a session of its own. Not when a chat's pi is stopped for being idle, which starts again with
// the next message, and not for a routine run whose session is kept for the next. A person who goes on with a finished
// run's chat starts its pi again.
const home = inProcessHome("pithagoras-chat-finished-");
mkdirSync(path.join(home, "work"), { recursive: true });

const { createSession, getDb } = await import("../dist/db.js");
const { SdkPiClient } = await import("../dist/pi/sdk-client.js");
const { sessions } = await import("../dist/session-manager.js");
const { routineSupervisor } = await import("../dist/routines/supervisor.js");
const host = await import("../dist/extension-host.js");

/** What stands in for pi: enough of it to be started and let go. */
class FakePi extends EventEmitter {
  running = true;
  constructor(opts) {
    super();
    this.sessionFile = path.join(opts.sessionDir, "conversation.jsonl");
  }
  isIdle() { return true; }
  dialogsOpen() { return 0; }
  async getTools() { return []; }
  async getCommands() { return []; }
  async getState() { return { model: { id: "m", name: "M", provider: "p", input: ["text"] }, thinkingLevel: "off" }; }
  async prompt() { return { outcome: "started" }; }
  clearQueue() { return []; }
  async abort() {}
  async shutdown() {}
  dispose() {
    this.running = false;
    this.emit("exit", { code: 0, signal: null });
  }
}
SdkPiClient.create = async (opts) => new FakePi(opts);

// A server half that writes down what it hears of the chats.
const pkg = path.join(home, "packages", "listener");
mkdirSync(pkg, { recursive: true });
const file = path.join(pkg, "server.js");
writeFileSync(file, `export default function (portal) {
  const heard = (globalThis.heard = []);
  for (const event of ["started", "stopped", "deleted", "finished"]) portal.chats.on(event, (id) => heard.push(event + " " + id));
}
`);
await host.syncServerHalves([{ name: "listener", version: "1.0.0", file, rev: `${statSync(file).size}` }]);
test.after(async () => {
  await host.stopServerHalves();
  getDb().close();
});
const heard = () => globalThis.heard;

let count = 0;
function routine(fresh) {
  const id = `r${++count}`;
  getDb()
    .prepare("INSERT INTO routines (id, slug, name, schedule, instructions, fresh_session) VALUES (?, ?, 'Look around', '0 9 * * *', 'x', ?)")
    .run(id, `routine-${count}`, fresh ? 1 : 0);
  return getDb().prepare("SELECT * FROM routines WHERE id = ?").get(id);
}

/** A routine run, its pi started for it as a run starts one, and what the halves heard of its session. */
async function run(fresh) {
  const ask = sessions.ask;
  let asked;
  sessions.ask = async (id) => {
    asked = id;
    await sessions.ensureClient(id);
    return "done";
  };
  try {
    heard().length = 0;
    await routineSupervisor.run(routine(fresh), "manual");
  } finally {
    sessions.ask = ask;
  }
  return { id: asked, heard: heard().filter((line) => line.endsWith(` ${asked}`)) };
}

const of = (id) => heard().filter((line) => line.endsWith(` ${id}`));

test("a routine run in a session of its own is finished once it is over and its pi stopped", async () => {
  const { id, heard: said } = await run(true);
  assert.deepEqual(said, [`started ${id}`, `stopped ${id}`, `finished ${id}`]);
});

test("a person who goes on with a finished run's chat starts its pi again, and it is a chat like any other then", async () => {
  const { id } = await run(true);
  heard().length = 0;
  await sessions.prompt(id, "And one more thing");
  assert.deepEqual(of(id), [`started ${id}`]);
  await sessions.stop(id);
  assert.deepEqual(of(id), [`started ${id}`, `stopped ${id}`]);
});

test("a routine run whose session is kept for the next is not finished, and neither is a chat stopped for being idle", async () => {
  const kept = await run(false);
  assert.deepEqual(kept.heard, [`started ${kept.id}`]);

  createSession({ id: "idle-chat", title: "idle", workspace: path.join(home, "work"), executor: "host" });
  heard().length = 0;
  await sessions.ensureClient("idle-chat");
  await sessions.stop("idle-chat");
  assert.deepEqual(heard(), ["started idle-chat", "stopped idle-chat"]);
});
