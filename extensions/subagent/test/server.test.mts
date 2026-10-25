import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { inProcessHome } from "../../../tests/helpers.mts";
import { describe } from "../src/pi.ts";
import { serveSubagent } from "./portal.mts";

/**
 * The subagent extension's server half, through the portal's own extension host: its settings and their checks at its
 * own address and at the portal's old one, and the tool it gives each chat's pi while it runs, with what they say.
 */

inProcessHome("pithagoras-subagent-server-");
const portal = await serveSubagent();
const { at, api } = portal;

const json = { "content-type": "application/json" };
const put = (url: string, body: unknown) => fetch(url, { method: "PUT", headers: json, body: JSON.stringify(body) });
const shown = async () => (await fetch(`${at}/settings`)).json();

test("the settings start as the tool does without being told, are saved for their owner alone, and reload the chats", async () => {
  assert.deepEqual(await shown(), { mode: "interrupt", maxParallel: 1, model: "auto", maxParallelLimit: 16 });
  const saved = await put(`${at}/settings`, { mode: "background", maxParallel: 3, model: "llama-swap/model-b" });
  assert.equal(saved.status, 200);
  assert.deepEqual(await saved.json(), { mode: "background", maxParallel: 3, model: "llama-swap/model-b", maxParallelLimit: 16, reloaded: 0, waiting: 0 });
  assert.deepEqual(await shown(), { mode: "background", maxParallel: 3, model: "llama-swap/model-b", maxParallelLimit: 16 });
  const file = path.join(portal.data, "settings.json");
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { mode: "background", maxParallel: 3, model: "llama-swap/model-b" });
  assert.equal(statSync(file).mode & 0o777, 0o600);
  // One change at a time keeps the rest; a default is left out of the file.
  await put(`${at}/settings`, { mode: "interrupt" });
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { maxParallel: 3, model: "llama-swap/model-b" });
  await put(`${at}/settings`, { maxParallel: 1, model: "auto" });
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), {});
});

test("what is not a mode, a limit from 1 to 16 or a model is refused, and nothing is saved", async () => {
  const before = await shown();
  for (const [body, error] of [
    [{ mode: "sideways" }, "mode must be interrupt or background"],
    [{ maxParallel: 0 }, "maxParallel must be a whole number from 1 to 16"],
    [{ maxParallel: 17 }, "maxParallel must be a whole number from 1 to 16"],
    [{ maxParallel: 2.5 }, "maxParallel must be a whole number from 1 to 16"],
    [{ maxParallel: "3" }, "maxParallel must be a whole number from 1 to 16"],
    [{ model: "no-slash" }, 'model must be "auto" or provider/model'],
    [{ model: 3 }, 'model must be "auto" or provider/model'],
    // The switch is Settings → Extensions': off is not this address's to do.
    [{ enabled: false, mode: "background" }, "The subagent tool is switched off in Settings → Extensions (PUT /api/extensions/enabled)"],
  ] as const) {
    const answer = await put(`${at}/settings`, body);
    assert.deepEqual([answer.status, (await answer.json()).error], [400, error], JSON.stringify(body));
  }
  assert.deepEqual(await shown(), before);
  // On it is already, as it answers.
  assert.equal((await put(`${at}/settings`, { enabled: true })).status, 200);
});

test("the portal's old address for the settings sends to the extension's, the method and the body kept", async () => {
  const asked = await fetch(`${api}/features/subagent`, { redirect: "manual" });
  // Not a 308: a browser keeps that for good, and a version without the extension has nothing at the new address.
  assert.equal(asked.status, 307);
  assert.equal(asked.headers.get("location"), "/api/x/pithagoras-subagent/settings");
  const changed = await put(`${api}/features/subagent`, { maxParallel: 2 });
  assert.equal(changed.status, 200);
  assert.equal((await changed.json()).maxParallel, 2);
  assert.equal((await (await fetch(`${api}/features/subagent`)).json()).maxParallel, 2);
  await put(`${at}/settings`, { maxParallel: 1 });
});

test("while it runs every chat's pi has the subagent tool, held to the guard's delegate rule, saying what the settings say; switched off, none has", async () => {
  portal.db.createSession({ id: "chat-1", title: "t", workspace: process.env.WORKSPACE_ROOT!, executor: "host", kind: "task" });
  await put(`${at}/settings`, { mode: "background", maxParallel: 3 });
  const tool = portal.toolsIn("chat-1").get("subagent");
  assert.ok(tool, "the chat's pi has it");
  assert.deepEqual(tool.guard, { acts: ["delegate"] });
  assert.equal(tool.description, describe("background", 3));
  assert.deepEqual((await (await fetch(`${api}/features/flags`)).json()).subagent, { enabled: true });

  // Settings → Extensions' switch (PUT /api/extensions/enabled), which brings the server halves in line with pi's settings.
  await portal.stop();
  assert.equal(portal.toolsIn("chat-1").size, 0, "off: nothing of it in the chat");
  assert.deepEqual((await (await fetch(`${api}/features/flags`)).json()).subagent, { enabled: false });
  assert.equal((await fetch(`${at}/settings`)).status, 404, "nor its address");

  await portal.start();
  assert.equal(portal.toolsIn("chat-1").get("subagent")?.description, describe("background", 3), "on again, with the settings it kept");
  await put(`${at}/settings`, { mode: "interrupt", maxParallel: 1 });
});
