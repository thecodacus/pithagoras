import { test, before } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { freePort, inProcessHome, serverEnv, startServer } from "./server-harness.mjs";

/**
 * Opening a chat, against the whole server: what the page asks for first, and
 * what it keeps open.
 */
const home = inProcessHome("pithagoras-open-");
const agentDir = path.join(home, "agent");
const map = (on) => Object.fromEntries(["off", "minimal", "low", "medium", "high", "xhigh", "max"].map((l) => [l, on.includes(l) ? l : null]));
writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({
  providers: {
    "test-server": {
      baseUrl: "http://127.0.0.1:1/v1", api: "openai-completions", apiKey: "none",
      models: [
        // Thinking only on or off, as some models do.
        { id: "switch", name: "Switch", reasoning: true, thinkingLevelMap: map(["off", "medium"]), input: ["text"], contextWindow: 1000, maxTokens: 100 },
        { id: "plain", name: "Plain", reasoning: false, input: ["text"], contextWindow: 1000, maxTokens: 100 },
      ],
    },
    // A model of the same name elsewhere, which does not think.
    "second-server": {
      baseUrl: "http://127.0.0.1:1/v1", api: "openai-completions", apiKey: "none",
      models: [{ id: "switch", name: "Switch", reasoning: false, input: ["text"], contextWindow: 1000, maxTokens: 100 }],
    },
  },
}));

// The server's database, to set what its rows say where no route does.
const db = await import("../dist/db.js");

let base;
before(async () => {
  ({ base } = await startServer(serverEnv(home, await freePort())));
});

const json = async (url, init) => {
  const res = await fetch(base + url, { ...init, headers: { "Content-Type": "application/json" } });
  assert.ok(res.ok, `${url}: ${res.status} ${await res.clone().text()}`);
  return res.json();
};

/** The config of a chat, asked again until pi's catalogue, built at start-up, has answered. */
async function configOf(id) {
  for (let i = 0; ; i++) {
    const config = await json(`/api/sessions/${id}/config`);
    if (config.thinking.levels.length || i > 50) return config;
    await new Promise((r) => setTimeout(r, 100));
  }
}

test("a chat that is not running says which thinking levels its model has", async () => {
  // Before, it said none: a page that had not seen the model drew the full
  // effort slider for one that only switches thinking on and off, until the
  // chat was next run.
  await json("/api/settings", { method: "PUT", body: JSON.stringify({ provider: "test-server", model: "switch" }) });
  const chat = await json("/api/sessions", { method: "POST", body: JSON.stringify({}) });
  const config = await configOf(chat.id);
  assert.equal(config.live, false);
  assert.equal(config.state.model.id, "switch");
  assert.deepEqual(config.thinking.levels, ["off", "medium"]);
  // What its row names: nothing, so the page keeps these for chats like it.
  assert.deepEqual(config.named, { provider: null, model: null });

  await json("/api/settings", { method: "PUT", body: JSON.stringify({ provider: "test-server", model: "plain" }) });
  assert.deepEqual((await json(`/api/sessions/${chat.id}/config`)).thinking.levels, ["off"]);

  // One pi does not know: nothing to say, rather than a guess.
  await json("/api/settings", { method: "PUT", body: JSON.stringify({ provider: "test-server", model: "gone" }) });
  assert.deepEqual((await json(`/api/sessions/${chat.id}/config`)).thinking.levels, []);
});

test("an idle chat's model and levels are the ones it would be started on", async () => {
  await json("/api/settings", { method: "PUT", body: JSON.stringify({ provider: "test-server", model: "plain" }) });
  const chat = await json("/api/sessions", { method: "POST", body: JSON.stringify({}) });
  await configOf(chat.id);

  // Its own, named on its row.
  db.updateSession(chat.id, { provider: "test-server", model: "switch" });
  const own = await json(`/api/sessions/${chat.id}/config`);
  assert.deepEqual(own.thinking.levels, ["off", "medium"]);
  assert.deepEqual(own.named, { provider: "test-server", model: "switch" });

  // A row naming a provider and no model runs the default model there — as
  // pi is started. The levels were looked up for the default's provider
  // instead: another server's model of the same name, which does not think,
  // beside a model named for the row's.
  db.updateSession(chat.id, { provider: "test-server", model: null });
  await json("/api/settings", { method: "PUT", body: JSON.stringify({ provider: "second-server", model: "switch" }) });
  const half = await json(`/api/sessions/${chat.id}/config`);
  assert.deepEqual(half.state.model, { id: "switch", name: "switch", provider: "test-server" });
  assert.deepEqual(half.thinking.levels, ["off", "medium"]);
  assert.deepEqual(half.named, { provider: "test-server", model: null });

  // And one naming a model and no provider runs it on the default's provider.
  db.updateSession(chat.id, { provider: null, model: "switch" });
  const other = await json(`/api/sessions/${chat.id}/config`);
  assert.equal(other.state.model.provider, "second-server");
  assert.deepEqual(other.thinking.levels, ["off"]);
});

test("an idle chat's effort is the one pi would start it on", async () => {
  // Asked for xhigh, on a model that offers off and medium: pi starts it on
  // medium. The pill said xhigh, which the slider could not show.
  await json("/api/settings", { method: "PUT", body: JSON.stringify({ provider: "test-server", model: "switch", thinkingLevel: "xhigh" }) });
  const chat = await json("/api/sessions", { method: "POST", body: JSON.stringify({}) });
  const config = await configOf(chat.id);
  assert.deepEqual(config.thinking.levels, ["off", "medium"]);
  assert.equal(config.state.thinkingLevel, "medium");
  await json("/api/settings", { method: "PUT", body: JSON.stringify({ thinkingLevel: "medium" }) });
});

test("a running chat's answer says what its row names only when pi is on the model it comes to", async () => {
  await json("/api/settings", { method: "PUT", body: JSON.stringify({ provider: "test-server", model: "plain" }) });
  const chat = await json("/api/sessions", { method: "POST", body: JSON.stringify({}) });
  // Listing its commands starts pi, on the default.
  await json(`/api/sessions/${chat.id}/commands`);
  const live = await json(`/api/sessions/${chat.id}/config`);
  assert.equal(live.live, true);
  assert.equal(live.state.model.id, "plain");
  assert.deepEqual(live.named, { provider: null, model: null });

  // The default changed in Settings while this chat's pi still runs the last:
  // its levels are not the default's now, and were kept as them.
  await json("/api/settings", { method: "PUT", body: JSON.stringify({ provider: "test-server", model: "switch" }) });
  const stale = await json(`/api/sessions/${chat.id}/config`);
  assert.equal(stale.state.model.id, "plain");
  assert.equal(stale.named, undefined);
  await json(`/api/sessions/${chat.id}/abort`, { method: "POST" }).catch(() => {});
});

/** Reads a server-sent stream until `until` says it has what it wants. */
async function readStream(url, until, ms = 5000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  const res = await fetch(base + url, { signal: ac.signal });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      const events = text.split("\n\n").filter(Boolean).map((block) => ({
        name: /^event: (.*)$/m.exec(block)?.[1] ?? "message",
        data: /^data: (.*)$/m.exec(block)?.[1],
      }));
      if (await until(events)) return events;
    }
  } catch (e) {
    if (e.name !== "AbortError") throw e;
  } finally {
    clearTimeout(timer);
    ac.abort();
  }
  throw new Error(`the stream did not say what was waited for:\n${text}`);
}

test("a chat's canvases come on its event stream, not a stream of their own", async () => {
  // Two streams per open chat is how three tabs used up the six connections a
  // browser allows one address, and a fourth chat opened blank.
  const chat = await json("/api/sessions", { method: "POST", body: JSON.stringify({}) });
  const canvas = (events) => events.filter((e) => e.name === "canvas").map((e) => JSON.parse(e.data));

  let created = false;
  const events = await readStream(`/api/sessions/${chat.id}/events?since=0`, async (events) => {
    const said = canvas(events);
    if (said.length && !created) {
      created = true;
      await json(`/api/sessions/${chat.id}/canvases`, { method: "POST", body: JSON.stringify({ title: "Notes" }) });
    }
    return said.some((m) => m.type === "create");
  });
  const said = canvas(events);
  assert.deepEqual(said[0], { type: "snapshot", canvases: [] });
  assert.equal(said.find((m) => m.type === "create").canvas.title, "Notes");

  // The stream of their own is gone.
  const old = await fetch(`${base}/api/sessions/${chat.id}/canvases/events`);
  assert.equal(old.headers.get("content-type")?.includes("text/event-stream"), false);
  await old.body?.cancel();
});

test("the canvas list comes before the conversation, and a document being written comes as its latest", async () => {
  const chat = await json("/api/sessions", { method: "POST", body: JSON.stringify({}) });
  let doc = await json(`/api/sessions/${chat.id}/canvases`, { method: "POST", body: JSON.stringify({ title: "Draft" }) });
  let edited = false;
  const events = await readStream(`/api/sessions/${chat.id}/events?since=0`, async (events) => {
    if (events.some((e) => e.name === "caught-up") && !edited) {
      edited = true;
      // Ten changes in a row, as a document being written makes them.
      for (let i = 1; i <= 10; i++) {
        doc = await json(`/api/sessions/${chat.id}/canvases/${doc.id}`, { method: "PUT", body: JSON.stringify({ revision: doc.revision, title: "Draft", content: "x".repeat(i) }) });
      }
    }
    return events.some((e) => e.name === "canvas" && JSON.parse(e.data).canvas?.revision === 10);
  });
  const names = events.map((e) => e.name);
  // Before the replay, not after it: a long one kept the panel empty until it had all come.
  assert.ok(names.indexOf("canvas") < names.indexOf("live-reset"), names.join(","));
  // Each change was the whole document, and the conversation waited behind them all.
  const updates = events.filter((e) => e.name === "canvas" && JSON.parse(e.data).type === "update");
  assert.ok(updates.length <= 3, `${updates.length} updates sent for 10 changes`);
  assert.equal(JSON.parse(updates.at(-1).data).canvas.content, "x".repeat(10));
});
