import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fakeModel, resultsIn } from "./fake-model.mjs";
import { inProcessHome } from "./server-harness.mjs";

/**
 * pi's own MCP support as the portal gives it to a chat (issue 361, PR B): real pi, the portal's own client and guard, a model
 * that asks for what the script says, and a real MCP server over stdio (tests/fixtures/mcp-server.mjs). What is looked at:
 * which servers a chat connects with it (direct) and which only when a tool of them is first wanted (lazy), that what the
 * model is sent first does not change when a server connects, and what the search finds of a server that is not running.
 */
const home = inProcessHome("pithagoras-mcp-native-");
const agent = process.env.PI_CODING_AGENT_DIR;
mkdirSync(path.join(agent, "extensions"), { recursive: true });
mkdirSync(process.env.WORKSPACE_ROOT, { recursive: true });

const FIXTURE = fileURLToPath(new URL("../../../tests/fixtures/mcp-server.mjs", import.meta.url));
const serversLog = path.join(home, "servers.log");
const logged = () => (existsSync(serversLog) ? readFileSync(serversLog, "utf8").split("\n").filter(Boolean).map((line) => line.split(" ").slice(2).join(" ")) : []);
const count = (what) => logged().filter((line) => line === what).length;
const entry = (name, tools = "one,two", extra = {}) => ({ command: process.execPath, args: [FIXTURE, name, "--tools", tools, "--log", serversLog], ...extra });
const writeServers = (servers) => writeFileSync(path.join(agent, "mcp.json"), JSON.stringify({ mcpServers: servers }));

let script = [];
// The results already in the chat's history when a message starts: the script is read from there.
let offset = 0;
const model = await fakeModel((request) => script[resultsIn(request) - offset] ?? "Done.");
writeFileSync(path.join(agent, "models.json"), JSON.stringify(model.models()));

const { SdkPiClient } = await import("../dist/pi/sdk-client.js");
const db = await import("../dist/db.js");
const cache = await import("../dist/mcp-tools.js");

/** What a chat froze when it started: the sets that are lazy in it, and the line that names them. */
const head = (lazy = [], direct = []) => ({ v: 1, lazy, direct, hint: lazy.length ? `These tools are not in your list: ${lazy.join(", ")}.` : "", outside: false, voice: [], tag: "0a1b2c3d" });
const search = (action, rest = {}) => ({ name: "tool_search", args: { action, ...rest } });
const chatDir = () => mkdtempSync(path.join(process.env.WORKSPACE_ROOT, "chat-"));
const names = (request) => (request.tools ?? []).map((t) => t.function.name);
const textOf = (result) => JSON.stringify(result.result);
let n = 0;
const until = async (done, ms = 8000) => {
  const from = Date.now();
  while (!(await done())) {
    if (Date.now() - from > ms) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

/** A chat, and the means to talk to it: what each message led to is returned with the requests it made. */
async function chat(options = {}) {
  const client = await SdkPiClient.create({
    cwd: chatDir(), sessionDir: mkdtempSync(path.join(home, "chat-")), provider: "fake", modelId: "m", sessionId: `mcp-native-${n++}`, dialogs: false,
    mcpTimings: { connectWaitMs: 15000 }, ...options,
  });
  let seen = 0;
  const say = async (calls) => {
    script = calls;
    offset = seen;
    const from = model.requests.length;
    const results = [];
    const settled = new Promise((resolve) => {
      const listener = (e) => {
        if (e?.type === "tool_execution_end") results.push(e);
        if (e?.type === "agent_settled") {
          client.off("event", listener);
          resolve();
        }
      };
      client.on("event", listener);
    });
    await client.prompt("Go on");
    await settled;
    seen = resultsIn(model.requests.at(-1));
    return { results: results.filter((e) => !e.parentToolCallId), all: results, requests: model.requests.slice(from) };
  };
  return { client, say };
}

/** What the portal does before it lets a chat go: the servers it started are stopped. */
async function close(client) {
  await client.shutdown();
  client.dispose();
}

function reset() {
  rmSync(serversLog, { force: true });
  rmSync(cache.mcpToolCachePath(), { force: true });
  db.setTrustedMcpServers([]);
  db.setMcpApprove("beta", undefined);
}

test("a server that is direct in the chat connects with it, its tools are declared, and they run by name", async () => {
  reset();
  writeServers({ alpha: entry("alpha") });
  const { client, say } = await chat({ lazy: head() });
  try {
    const r = await say([{ name: "mcp__alpha__one", args: { text: "hi" } }]);
    assert.match(names(r.requests[0]).join(), /mcp__alpha__one,mcp__alpha__two/);
    assert.equal(count("start alpha"), 1);
    assert.match(textOf(r.results[0]), /alpha\/one says/);
    // Somebody else's words until the person says the server is theirs: the result is wrapped.
    assert.match(textOf(r.results[0]), /untrusted/);
    // The tools it registered are kept for the lists and the search of chats that have not connected it.
    assert.deepEqual(cache.cachedServer("alpha").tools.map((t) => t.name).sort(), ["mcp__alpha__one", "mcp__alpha__two"]);
    assert.deepEqual(cache.cachedServer("alpha").tools.map((t) => t.original).sort(), ["one", "two"]);
  } finally {
    await close(client);
  }
});

test("a server the person trusts is not outside content", async () => {
  reset();
  writeServers({ alpha: entry("alpha") });
  db.setTrustedMcpServers(["alpha"]);
  const { client, say } = await chat({ lazy: head() });
  try {
    const r = await say([{ name: "mcp__alpha__one", args: { text: "hi" } }]);
    assert.doesNotMatch(textOf(r.results[0]), /untrusted/);
  } finally {
    await close(client);
    db.setTrustedMcpServers([]);
  }
});

test("a lazy server is not started with the chat: its tools are found, called and wanted through tool_search, and the head of the chat does not change when it connects", async () => {
  reset();
  writeServers({ beta: entry("beta") });
  const { client, say } = await chat({ lazy: head(["beta"]) });
  try {
    // Not connected, and not looked for: a chat that never wants it never starts it.
    const first = await say(["Nothing to look up."]);
    assert.equal(count("start beta"), 0);
    assert.ok(names(first.requests[0]).includes("tool_search"), "the way to it is offered from the first request");
    assert.doesNotMatch(names(first.requests[0]).join(), /mcp__beta/);

    // Nothing is known of it, so the search starts it and waits, and finds its tools.
    const r = await say([search("search", { query: "one" }), search("call", { name: "mcp__beta__one", args: { text: "x" } })]);
    assert.equal(count("start beta"), 1);
    assert.match(textOf(r.results[0]), /mcp__beta__one/);
    assert.match(textOf(r.results[1]), /beta\/one says \{\\"text\\":\\"x\\"\}/);
    // Said to be somebody else's words: the call's result is wrapped as a direct call's is.
    assert.match(textOf(r.results[1]), /untrusted/);
    // What the model was sent first is the same in every request, before the server was there and after: the tools array
    // and the system prompt (pi's own `mcp_servers` section is taken out).
    const all = [...first.requests, ...r.requests];
    assert.equal(new Set(all.map((q) => JSON.stringify(q.tools))).size, 1);
    assert.equal(new Set(all.map((q) => q.messages[0].content)).size, 1);
    assert.doesNotMatch(JSON.stringify(all[0]), /MCP servers whose tools/);
    assert.doesNotMatch(JSON.stringify(all.at(-1).tools), /mcp__beta/);
    // And now it is in the cache for the next chat.
    assert.deepEqual(cache.cachedServer("beta").tools.map((t) => t.name).sort(), ["mcp__beta__one", "mcp__beta__two"]);
  } finally {
    await close(client);
  }
});

test("a lazy server that has run before is found in the cache, and started when its tool is called; a hit starts it in the background", async () => {
  reset();
  writeServers({ beta: entry("beta") });
  const warm = await chat({ lazy: head(["beta"]) });
  try {
    await warm.say([search("search", { query: "one" })]);
  } finally {
    await close(warm.client);
  }
  await until(() => count("exit beta") === 1);
  const { client, say } = await chat({ lazy: head(["beta"]) });
  try {
    await say(["Hello."]);
    assert.equal(count("start beta"), 1, "not started by a chat that does not want it");
    const r = await say([search("describe", { name: "mcp__beta__two" }), search("call", { name: "mcp__beta__two", args: { text: "y" } })]);
    assert.match(textOf(r.results[0]), /The two tool of beta/, "described from the cache");
    assert.match(textOf(r.results[1]), /beta\/two says/);
    assert.equal(count("start beta"), 2, "started for the call, and once");
    // The old name the adapter gave it finds it, for the history of a chat from before.
    const old = await say([search("describe", { name: "beta_one" })]);
    assert.match(textOf(old.results[0]), /mcp__beta__one/);
  } finally {
    await close(client);
  }
});

test("a server the portal started is stopped when nobody has used it for a while, and started again by the next call without touching the head", async () => {
  reset();
  writeServers({ beta: entry("beta") });
  const { client, say } = await chat({ lazy: head(["beta"]), mcpTimings: { connectWaitMs: 15000, idleMs: 300, idleCheckMs: 100 } });
  try {
    const first = await say([search("call", { name: "mcp__beta__one" })]);
    // Not known yet, so a call by a name that is not in the cache is refused with what to do, and the search starts it.
    assert.match(textOf(first.results[0]), /no lazy tool|beta/);
    const second = await say([search("search", { query: "one" }), search("call", { name: "mcp__beta__one", args: { text: "1" } })]);
    assert.equal(count("start beta"), 1);
    await until(() => count("exit beta") === 1);
    const again = await say([search("call", { name: "mcp__beta__two", args: { text: "2" } })]);
    assert.match(textOf(again.results[0]), /beta\/two says/);
    assert.equal(count("start beta"), 2);
    assert.equal(new Set([...first.requests, ...second.requests, ...again.requests].map((q) => JSON.stringify(q.tools))).size, 1, "the tools array did not move");
  } finally {
    await close(client);
  }
});

test("a server that is switched off in the file, and a tool that is switched off in the chat, are not reachable and not started", async () => {
  reset();
  writeServers({ gone: entry("gone", "one", { enabled: false }), old: entry("old", "one", { disabled: true }), beta: entry("beta") });
  const { client, say } = await chat({ lazy: head(["beta"]), toolsOff: ["mcp__beta__two"] });
  try {
    const r = await say([search("search", { query: "tool" }), search("call", { name: "mcp__beta__two" }), search("call", { name: "mcp__beta__one", args: { text: "z" } })]);
    assert.equal(count("start gone"), 0);
    assert.equal(count("start old"), 0, "the adapter's key for off still means off");
    assert.match(textOf(r.results[0]), /mcp__beta__one/);
    assert.doesNotMatch(textOf(r.results[0]), /mcp__beta__two/, "a tool that is off is not found");
    assert.match(textOf(r.results[1]), /switched off/);
    assert.match(textOf(r.results[2]), /beta\/one says/);
  } finally {
    await close(client);
  }
});

test("the resource tools are lazy with the lazy servers: not declared when a server with resources connects, found through the search", async () => {
  reset();
  writeServers({ res: entry("res", "one", { args: [FIXTURE, "res", "--tools", "one", "--log", serversLog, "--resources"] }) });
  const { client, say } = await chat({ lazy: head(["res"]) });
  try {
    const first = await say(["Hi."]);
    const r = await say([search("search", { query: "one" }), search("search", { query: "resources" })]);
    assert.equal(count("start res"), 1);
    const sent = [...first.requests, ...r.requests];
    for (const request of sent) assert.doesNotMatch(names(request).join(), /list_mcp_resources|read_mcp_resource/);
    assert.match(textOf(r.results[1]), /list_mcp_resources|read_mcp_resource/);
  } finally {
    await close(client);
  }
});

test("a trusted project's .pi/mcp.json brings servers, and cannot define one of the user's file again", async () => {
  reset();
  writeServers({ alpha: entry("alpha") });
  const folder = chatDir();
  mkdirSync(path.join(folder, ".pi"), { recursive: true });
  writeFileSync(path.join(folder, ".pi", "mcp.json"), JSON.stringify({ mcpServers: { proj: entry("proj", "one"), alpha: entry("evil", "one") } }));
  const { client, say } = await chat({ cwd: folder, lazy: head() });
  try {
    const r = await say([{ name: "mcp__proj__one", args: { text: "p" } }]);
    // The project's own server is there, as pi would have it; a server of the user's file is the user's and no other.
    assert.match(textOf(r.results[0]), /proj\/one says/);
    assert.equal(count("start evil"), 0, "a project cannot define a server of the user's file again");
    assert.equal(count("start alpha"), 1);
    // A server a project brings is nobody the person trusts, whatever it is called.
    db.setTrustedMcpServers(["proj"]);
    assert.match(textOf((await say([{ name: "mcp__proj__one", args: {} }])).results[0]), /untrusted/);
  } finally {
    await close(client);
  }
});

test("a server whose tools are marked to be confirmed each time is refused where nobody can be asked, and the others of it run", async () => {
  reset();
  writeServers({ beta: entry("beta", "read_it,delete_it") });
  db.setTrustedMcpServers(["beta"]);
  db.setMcpApprove("beta", ["delete_*"]);
  const { client, say } = await chat({ lazy: head() });
  try {
    const r = await say([{ name: "mcp__beta__read_it", args: {} }, { name: "mcp__beta__delete_it", args: {} }]);
    assert.match(textOf(r.results[0]), /beta\/read_it says/);
    assert.match(JSON.stringify(r.results[1]), /confirmed on each call|nobody here to confirm/);
    assert.doesNotMatch(logged().join("\n"), /tools\/call delete_it/, "the call did not reach the server");
  } finally {
    await close(client);
    db.setMcpApprove("beta", undefined);
    db.setTrustedMcpServers([]);
  }
});

test("what a chat reads of a project: pi's override rule, no auth, no server of the user's file defined again, and nothing where the project is not trusted", async () => {
  reset();
  const { chatServers } = await import("../dist/api/mcp.js");
  writeServers({ alpha: entry("alpha", "one", { headers: { A: "kept" }, env: { SECRET: "kept" } }), "my-notes": entry("notes") });
  const folder = chatDir();
  mkdirSync(path.join(folder, ".pi"), { recursive: true });
  const project = (servers) => writeFileSync(path.join(folder, ".pi", "mcp.json"), JSON.stringify({ mcpServers: servers }));
  project({
    alpha: { enabled: false },
    own: { url: "https://own.test/mcp" },
    stolen: { url: "https://x.test/mcp", auth: { provider: "p" } },
    my_notes: { command: "evil" },
    loose: { enabled: false },
    wide: { exposure: "direct", env: { X: "1" } },
  });
  const trusted = chatServers(folder, true);
  const byName = Object.fromEntries(trusted.servers.map((one) => [one.name, one]));
  assert.deepEqual(Object.keys(byName).sort(), ["alpha", "my-notes", "own"]);
  assert.equal(byName.alpha.entry.enabled, false, "a project turns a server of the user's off for itself");
  assert.deepEqual(byName.alpha.entry.env, { SECRET: "kept" }, "and keeps the rest of it, credentials included");
  assert.equal(byName.alpha.from, "user");
  assert.equal(byName.own.from, "project");
  assert.equal(trusted.errors.length, 4, trusted.errors.join("\n"));
  for (const word of ["stolen", "my_notes", "loose", "wide"]) assert.ok(trusted.errors.some((e) => e.includes(`"${word}"`)), word);
  // Not read at all where pi does not trust the project (and never while the sandbox is on).
  const untrusted = chatServers(folder, false);
  assert.deepEqual(untrusted.servers.map((one) => one.name).sort(), ["alpha", "my-notes"]);
  assert.equal(untrusted.servers.find((one) => one.name === "alpha").entry.enabled, undefined);
  assert.deepEqual(untrusted.errors, []);
});
