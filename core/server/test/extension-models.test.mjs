import assert from "node:assert/strict";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { inProcessHome } from "./server-harness.mjs";

/**
 * The models the chats use, as a server half asks for them (`portal.models`): the model a chat is on now, where a
 * model is asked and with which key, and the providers set up by their address.
 */
const home = inProcessHome("extension-models-");
writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, "models.json"), JSON.stringify({
  providers: {
    local: {
      baseUrl: "http://127.0.0.1:1/v1/", api: "openai-completions", apiKey: "sk-local",
      models: [{ id: "small", name: "Small", reasoning: false, input: ["text"], contextWindow: 10000, maxTokens: 100 }],
    },
    // Its key is a command pi runs when it asks.
    ran: {
      baseUrl: "http://127.0.0.1:2", api: "anthropic-messages", apiKey: "!printf ran-key",
      models: [{ id: "big", name: "Big", reasoning: false, input: ["text"], contextWindow: 10000, maxTokens: 100 }],
    },
    // A built-in service's address changed, with no models of its own: not a provider set up here.
    openrouter: { baseUrl: "http://127.0.0.1:3/api/v1" },
  },
}));
const host = await import("../dist/extension-host.js");
const db = await import("../dist/db.js");
test.after(() => host.stopServerHalves());

/** What the session manager says a running chat is on, by chat. */
const live = {};
host.setChatBridge({ tell: async () => false, offers: () => undefined, reload: async () => ({ reloaded: 0, waiting: 0 }), model: async (id) => live[id] });

const dir = path.join(home, "packages", "asker");
mkdirSync(dir, { recursive: true });
const file = path.join(dir, "server.js");
writeFileSync(file, "export default function (portal) { globalThis.portal = portal; }\n");
await host.syncServerHalves([{ name: "asker", version: "1.0.0", file, rev: statSync(file).size.toString(36) }]);
const { models } = globalThis.portal;

test("the model a chat is on: its pi's while it runs, else the one stored for it; without a chat, the one new chats start on", async () => {
  db.setSettings({ provider: "local", model: "small" });
  assert.deepEqual(await models.of(), { provider: "local", id: "small" });

  db.createSession({ id: "stored", title: "stored", workspace: home, executor: "host" });
  // One that names none is on the default.
  assert.deepEqual(await models.of("stored"), { provider: "local", id: "small" });
  db.updateSession("stored", { provider: "ran", model: "big" });
  assert.deepEqual(await models.of("stored"), { provider: "ran", id: "big" });

  // Running, on another than the stored one: a chat can switch its model as it goes.
  live.stored = { provider: "local", id: "small" };
  assert.deepEqual(await models.of("stored"), { provider: "local", id: "small" });
  delete live.stored;
  assert.deepEqual(await models.of("stored"), { provider: "ran", id: "big" });

  assert.equal(await models.of("no-such-chat"), undefined);
  // Nothing chosen for new chats: no model.
  db.setSettings({ provider: "", model: "" });
  assert.equal(await models.of(), undefined);
});

test("where a model is asked, with its key apart from the headers; a command's key is said to be one", async () => {
  assert.deepEqual(await models.endpoint("local", "small"), {
    api: "openai-completions",
    baseUrl: "http://127.0.0.1:1/v1",
    headers: {},
    key: "sk-local",
    keyFromCommand: false,
  });
  // Anthropic's API takes a key in a header of its own: which one is the extension's to say, by `api`.
  const ran = await models.endpoint("ran", "big");
  assert.equal(ran.api, "anthropic-messages");
  assert.equal(ran.key, "ran-key", "the key the command gave");
  assert.equal(ran.keyFromCommand, true);
  assert.deepEqual(ran.headers, {});
});

test("a model pi does not know is refused", async () => {
  await assert.rejects(models.endpoint("local", "nowhere"), /local\/nowhere is not a model pi knows/);
  await assert.rejects(models.endpoint("nobody", "small"), /nobody\/small is not a model pi knows/);
});

test("the providers set up by their address, with their models; an override of a built-in service is not one", () => {
  assert.deepEqual(models.list(), [
    { provider: "local", api: "openai-completions", baseUrl: "http://127.0.0.1:1/v1/", models: ["small"] },
    { provider: "ran", api: "anthropic-messages", baseUrl: "http://127.0.0.1:2", models: ["big"] },
  ]);
});
