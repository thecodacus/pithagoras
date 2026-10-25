import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { inProcessHome } from "../../../tests/helpers.mts";
import { describe } from "../src/pi.ts";
import { SPEC, serveSubagent } from "./portal.mts";

/**
 * A portal whose subagent tool was a pi package, with its settings in pi's settings.json, and that kept what each chat
 * said its subagents run on in its own database (version 12), upgraded: the database's upgrade leaves both for the
 * extension, takes the settings out of pi's file and the chats' out of the database, and the extension's server half,
 * as it starts, takes them up. The tool then tells the model what it told it before, and each chat's subagents run on
 * what the chat said.
 */

inProcessHome("pithagoras-subagent-upgrade-");
const piSettings = path.join(process.env.PI_CODING_AGENT_DIR!, "settings.json");
writeFileSync(piSettings, JSON.stringify({ packages: ["../../extensions/subagent"], subagentMode: "background", subagentMaxParallel: 3, defaultProvider: "llama-swap" }));
// The portal's settings as version 12 kept them: one chat said a model, another said one and then the default again.
mkdirSync(process.env.DATA_DIR!, { recursive: true });
const old = new Database(path.join(process.env.DATA_DIR!, "portal.db"));
old.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
old.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("subagent_model:chat-1", "llama-swap/model-b");
old.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("subagent_model:chat-2", "");
old.pragma("user_version = 12");
old.close();
// The chats are in the database, as they are in a real one: the extension takes up only those the portal has.
const core = await import(new URL("../../../core/server/dist/db.js", import.meta.url).href);
core.getDb();
for (const id of ["chat-1", "chat-2"]) core.createSession({ id, title: "t", workspace: process.env.WORKSPACE_ROOT!, executor: "host", kind: "task" });
const portal = await serveSubagent();

test("the mode and the limit pi's settings held are the extension's after the upgrade, and the tool says them as before", async () => {
  assert.deepEqual(await (await fetch(`${portal.at}/settings`)).json(), { mode: "background", maxParallel: 3, model: "auto", keep: false, maxParallelLimit: 16 });
  assert.equal(portal.toolsIn("chat-1").get("subagent")?.description, describe("background", 3));
  // Out of pi's file, and the rest of it as it was; the hand-off taken and done with.
  assert.deepEqual(JSON.parse(readFileSync(piSettings, "utf8")), { packages: ["../../extensions/subagent"], defaultProvider: "llama-swap" });
  assert.equal(existsSync(path.join(process.env.DATA_DIR!, "handoff", "subagent")), false);
  assert.equal(existsSync(path.join(portal.data, "handoff-subagent")), false);
});

test("what each chat said its subagents run on is the extension's after the upgrade, and out of the portal's database", async () => {
  assert.deepEqual(await (await fetch(`${portal.at}/chats/chat-1/model`)).json(), { model: "llama-swap/model-b", default: "auto" });
  assert.deepEqual(await (await fetch(`${portal.at}/chats/chat-2/model`)).json(), { model: null, default: "auto" });
  assert.deepEqual(portal.db.getDb().prepare("SELECT key FROM settings WHERE key LIKE 'subagent%'").all(), []);
  assert.equal(existsSync(path.join(process.env.DATA_DIR!, "handoff", "subagent-chats")), false);
  assert.equal(existsSync(path.join(portal.data, "handoff-subagent-chats")), false);
});

test("an upgraded portal whose pi listed the folder lists the extension as on, serving, with its browser and server halves, and as off where the entry is switched off", async () => {
  const listed = async () => (await portal.list()).find((e) => e.spec === SPEC);
  // Nothing was done but the upgrade and the start: the entry pi had is the extension, on.
  assert.deepEqual({ name: (await listed())?.name, enabled: (await listed())?.enabled, kinds: (await listed())?.kinds }, { name: "pithagoras-subagent", enabled: true, kinds: ["pithagoras"] });
  assert.equal(portal.host.isServing("pithagoras-subagent"), true);

  // The entry as pi writes one that was switched off (`pi config`, Settings → Extensions): the extension is off.
  await portal.install({ source: SPEC, extensions: [], skills: [], prompts: [], themes: [] });
  assert.equal((await listed())?.enabled, false);
  assert.equal(portal.host.isServing("pithagoras-subagent"), false);
  await portal.install(SPEC);
  assert.equal(portal.host.isServing("pithagoras-subagent"), true);
});
