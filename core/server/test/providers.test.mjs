import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { inProcessHome } from "./server-harness.mjs";

inProcessHome("pi-agent-");
const dir = process.env.PI_CODING_AGENT_DIR;
const p = await import("../dist/providers.js");
const read = (name) => JSON.parse(readFileSync(path.join(dir, name), "utf8"));

test("a server's models are read from each server's own shape", () => {
  assert.deepEqual(p.parseModels({ data: [{ id: "a" }, { id: "a" }, { id: "b", name: "Bee" }] }), [{ id: "a" }, { id: "b", name: "Bee" }]);
  assert.deepEqual(
    p.parseModels({ data: [{ id: "x/y", name: "Y", context_length: 200000, architecture: { input_modalities: ["text", "image"] }, supported_parameters: ["tools", "reasoning"] }] }),
    [{ id: "x/y", name: "Y", contextWindow: 200000, input: ["text", "image"], reasoning: true }],
  );
  assert.deepEqual(p.parseModels({ data: [{ id: "q", meta: { n_ctx_train: 32768 } }] }), [{ id: "q", contextWindow: 32768 }]);
  assert.deepEqual(p.parseModels({ nope: true }), []);
});

test("a llama-swap alias is known by its own name, not by the name of the model it stands for", () => {
  // As llama-swap lists them: the router, and each preset behind it as an alias carrying the router's name.
  const listed = { data: [
    { id: "llamacpp", name: "llama.cpp router (presets)", meta: { llamaswap: { type: "model", aliases: ["model-a-128k"] } } },
    { id: "model-a-128k", name: "llama.cpp router (presets)", meta: { llamaswap: { type: "alias", modelID: "llamacpp" } } },
    { id: "model-c", name: "Model C — Flash (2 GPUs, 64k)", meta: { llamaswap: { type: "model" } } },
  ] };
  assert.deepEqual(p.parseModels(listed).map((m) => m.name ?? m.id), ["llama.cpp router (presets)", "model-a-128k", "Model C — Flash (2 GPUs, 64k)"]);
});

test("an address is made into the base pi wants", () => {
  assert.equal(p.normalizeBaseUrl("localhost:8080", "llama-cpp"), "http://localhost:8080/v1");
  assert.equal(p.normalizeBaseUrl("http://h:11434/", "ollama"), "http://h:11434/v1");
  assert.equal(p.normalizeBaseUrl("https://gw.example/api/v1/models", "custom"), "https://gw.example/api/v1");
  assert.equal(p.normalizeBaseUrl("http://h:8000", "custom"), "http://h:8000");
});

test("a key is never shown, only told apart", () => {
  assert.equal(p.keyHint("sk-or-v1-abcdef123456"), "sk-o…3456");
  assert.equal(p.keyHint("$OPENROUTER_API_KEY"), "OPENROUTER_API_KEY");
  assert.equal(p.keyHint("!op read x"), "from a command");
});

test("saving a server keeps what was written by hand, and the file stays private", async () => {
  writeFileSync(path.join(dir, "models.json"), JSON.stringify({
    providers: {
      "llama-swap": { baseUrl: "http://gpu:8080/v1", api: "openai-completions", apiKey: "none", models: [
        { id: "model-a", name: "Model A", reasoning: true, thinkingLevelMap: { off: "off", medium: "medium" }, contextWindow: 327680 },
        { id: "Old" },
      ] },
      anthropic: { baseUrl: "https://proxy.example/v1" },
    },
    somethingElse: 1,
  }));
  await p.saveProvider("llama-swap", { kind: "llama-swap", baseUrl: "http://gpu:8080", models: [{ id: "model-a", contextWindow: 65536, reasoning: true }, { id: "New", input: ["text", "image"] }] });
  const file = read("models.json");
  assert.equal(file.somethingElse, 1);
  assert.deepEqual(file.providers.anthropic, { baseUrl: "https://proxy.example/v1" });
  const swap = file.providers["llama-swap"];
  assert.equal(swap.baseUrl, "http://gpu:8080/v1");
  assert.equal(swap.apiKey, "none");
  assert.deepEqual(swap.models.map((m) => m.id), ["model-a", "New"]);
  assert.deepEqual(swap.models[0].thinkingLevelMap, { off: "off", medium: "medium" });
  assert.equal(swap.models[0].contextWindow, 65536);
  assert.equal(swap.models[0].name, undefined, "a name the form cleared is gone");
  assert.equal(statSync(path.join(dir, "models.json")).mode & 0o777, 0o600);

  const listed = p.listProviders();
  assert.deepEqual(listed.map((x) => [x.id, x.kind, x.key.set]), [["llama-swap", "llama-swap", false]], "the address override is not a server of its own");
});

test("a hosted service's key goes to auth.json, and removing it takes it out", async () => {
  await p.saveProvider("openrouter", { kind: "openrouter", apiKey: "sk-or-v1-0123456789" });
  assert.deepEqual(read("auth.json").openrouter, { type: "api_key", key: "sk-or-v1-0123456789" });
  const listed = p.listProviders({ openrouter: "OpenRouter" }, { anthropic: "environment" });
  assert.deepEqual(listed.filter((x) => !x.endpoint).map((x) => [x.id, x.label, x.key.hint ?? x.key.source]), [
    ["openrouter", "OpenRouter", "sk-o…6789"], ["anthropic", "anthropic", "environment"],
  ]);
  await p.saveProvider("openrouter", { kind: "openrouter" });
  assert.equal(read("auth.json").openrouter.key, "sk-or-v1-0123456789", "no key sent keeps the one stored");
  assert.equal((await p.removeProvider("openrouter")).found, true);
  assert.equal(read("auth.json").openrouter, undefined);
  assert.equal((await p.removeProvider("openrouter")).found, false);
});

test("a bad name is refused before anything is written", async () => {
  await assert.rejects(p.saveProvider("../x", { kind: "custom", baseUrl: "http://h" }), /name/);
  await assert.rejects(p.saveProvider("x", { kind: "custom" }), /address/);
});

test("a llama-server is asked for its models, and for the window it really gives", async () => {
  const server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/v1/models") return res.end(JSON.stringify({ data: [{ id: "model-b-q4.gguf", meta: { n_ctx_train: 262144 } }] }));
    if (req.url === "/props") return res.end(JSON.stringify({ default_generation_settings: { n_ctx: 65536 }, modalities: { vision: true } }));
    res.statusCode = 404; res.end("{}");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  try {
    const found = await p.probeModels("llama-cpp", `127.0.0.1:${port}`);
    assert.equal(found.baseUrl, `http://127.0.0.1:${port}/v1`);
    assert.deepEqual(found.models, [{ id: "model-b-q4.gguf", contextWindow: 65536, input: ["text", "image"] }]);
    // A custom address without /v1 is tried again with it.
    assert.equal((await p.probeModels("custom", `http://127.0.0.1:${port}`)).baseUrl, `http://127.0.0.1:${port}/v1`);
  } finally {
    server.close();
  }
  await assert.rejects(p.probeModels("llama-cpp", `http://127.0.0.1:${port}`), /Nothing answered/);
});

test("each server is asked whether it answers, and which chosen models it no longer lists", async () => {
  const server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/v1/models") return res.end(JSON.stringify({ data: [{ id: "A" }, { id: "B" }] }));
    if (req.url === "/running") return res.end(JSON.stringify({ running: [{ model: "A", state: "ready" }, { model: "B", state: "starting" }] }));
    res.statusCode = 404; res.end("{}");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  try {
    writeFileSync(path.join(dir, "models.json"), JSON.stringify({ providers: {
      "llama-swap": { baseUrl: `http://127.0.0.1:${port}/v1`, api: "openai-completions", models: [{ id: "A" }, { id: "Old" }] },
      down: { baseUrl: "http://127.0.0.1:1/v1", models: [{ id: "x" }] },
      anthropic: { baseUrl: "https://proxy.example/v1" },
    } }));
    const status = await p.checkProviders();
    assert.deepEqual(Object.keys(status).sort(), ["down", "llama-swap"], "an override of a hosted service is not asked");
    const swap = status["llama-swap"];
    assert.equal(swap.state, "up");
    assert.equal(typeof swap.ms, "number");
    assert.deepEqual([swap.listed, swap.missing, swap.loaded], [2, ["Old"], ["A"]]);
    assert.equal(status.down.state, "down");
    assert.match(status.down.message, /Nothing answered/);
  } finally {
    server.close();
  }
});

/** A server that lists `models`, and says which key each request brought. */
async function listing(models, { needsKey = false } = {}) {
  const keys = [];
  const server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    keys.push(req.headers.authorization);
    if (needsKey && !req.headers.authorization) { res.statusCode = 401; return res.end("{}"); }
    if (req.url === "/v1/models") return res.end(JSON.stringify({ data: models.map((id) => ({ id })) }));
    res.statusCode = 404; res.end("{}");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, keys, base: `http://127.0.0.1:${server.address().port}/v1` };
}

test("a saved key is sent only to the address it was saved with, and a typed one is never looked up", async () => {
  const theirs = await listing(["A"]);
  const own = await listing(["B"], { needsKey: true });
  try {
    writeFileSync(path.join(dir, "models.json"), JSON.stringify({ providers: {
      gpu: { baseUrl: own.base, api: "openai-completions", apiKey: "sk-saved-0123456789", models: [{ id: "B" }] },
    } }));
    writeFileSync(path.join(dir, "auth.json"), JSON.stringify({ openrouter: { type: "api_key", key: "sk-or-v1-secret" } }));
    process.env.PORTAL_TEST_SECRET = "hunter2";

    // Its own address: the saved key goes with it.
    assert.deepEqual((await p.probeModels("custom", own.base, undefined, p.savedServer("gpu"))).models, [{ id: "B" }]);
    assert.equal(own.keys.at(-1), "Bearer sk-saved-0123456789");
    // Another address: not the saved key, nor a hosted service's, nor the environment.
    await p.probeModels("custom", theirs.base, undefined, p.savedServer("gpu"));
    assert.equal(p.savedServer("openrouter"), undefined, "a hosted service has no address to be asked at");
    await p.probeModels("custom", theirs.base, "$PORTAL_TEST_SECRET", p.savedServer("openrouter"));
    await p.probeModels("custom", theirs.base, "!cat /etc/passwd");
    assert.deepEqual(theirs.keys, [undefined, undefined, undefined]);
    // Moved to an address that wants a key, it says why the saved one was not sent.
    const moved = await listing(["B"], { needsKey: true });
    try {
      await assert.rejects(p.probeModels("custom", moved.base, undefined, p.savedServer("gpu")), /only sent to the address it was saved with/);
    } finally {
      moved.server.close();
    }
  } finally {
    theirs.server.close();
    own.server.close();
    delete process.env.PORTAL_TEST_SECRET;
  }
});

test("removing a hosted service leaves an override of it written by hand", async () => {
  writeFileSync(path.join(dir, "models.json"), JSON.stringify({ providers: { anthropic: { baseUrl: "https://proxy.example/v1" } } }));
  writeFileSync(path.join(dir, "auth.json"), JSON.stringify({ anthropic: { type: "api_key", key: "sk-ant-0123456789" } }));
  assert.equal((await p.removeProvider("anthropic")).found, true);
  assert.equal(read("auth.json").anthropic, undefined);
  assert.deepEqual(read("models.json").providers.anthropic, { baseUrl: "https://proxy.example/v1" });
});

test("a server is the kind it was saved as, whatever its name", async () => {
  writeFileSync(path.join(dir, "models.json"), JSON.stringify({ providers: {
    openrouter: { baseUrl: "http://gw:4000/v1", apiKey: "none", models: [{ id: "x" }] },
  } }));
  writeFileSync(path.join(dir, "auth.json"), "{}");
  await p.saveProvider("gpu", { kind: "llama-swap", baseUrl: "http://gpu:8080", models: [{ id: "A" }] });
  await p.saveProvider("box", { kind: "llama-cpp", baseUrl: "http://box:8080", models: [{ id: "B" }] });
  const kinds = Object.fromEntries(p.listProviders().map((x) => [x.id, [x.kind, x.endpoint]]));
  assert.deepEqual(kinds, {
    // Written by hand under a hosted service's name, it is still a server — edited with its address and models.
    openrouter: ["custom", true],
    gpu: ["llama-swap", true],
    box: ["llama-cpp", true],
  });
  assert.equal(read("models.json").providers.gpu.kind, undefined, "pi's file holds only what pi knows");
  await p.removeProvider("gpu");
  assert.equal(read("portal-providers.json").gpu, undefined);
});

test("the llama-swap saved under another name is still asked what it has loaded", async () => {
  const server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/v1/models") return res.end(JSON.stringify({ data: [{ id: "A" }] }));
    if (req.url === "/running") return res.end(JSON.stringify({ running: [{ model: "A", state: "ready" }] }));
    res.statusCode = 404; res.end("{}");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    writeFileSync(path.join(dir, "models.json"), "{}");
    await p.saveProvider("gpu", { kind: "llama-swap", baseUrl: `http://127.0.0.1:${server.address().port}`, models: [{ id: "A" }] });
    assert.deepEqual((await p.checkProviders()).gpu.loaded, ["A"]);
  } finally {
    server.close();
  }
});

test("an Ollama server's every model is listed, past the ones looked up", async () => {
  const names = Array.from({ length: 60 }, (_, i) => `m${i}`);
  const shown = [];
  const server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/v1/models") return res.end(JSON.stringify({ data: names.map((id) => ({ id })) }));
    if (req.url === "/api/show") {
      let body = "";
      req.on("data", (c) => (body += c));
      return req.on("end", () => { shown.push(JSON.parse(body).model); res.end(JSON.stringify({ model_info: { "llama.context_length": 8192 } })); });
    }
    res.statusCode = 404; res.end("{}");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const found = await p.probeModels("ollama", `127.0.0.1:${server.address().port}`);
    assert.equal(found.models.length, 60);
    assert.deepEqual(found.models.at(-1), { id: "m59" });
    assert.deepEqual(found.models[0], { id: "m0", contextWindow: 8192 });
    assert.equal(shown.length, 40, "only so many are asked about one by one");
  } finally {
    server.close();
  }
});

test("a models.json with comments is read as pi reads it, and a save keeps what is in it", async () => {
  writeFileSync(path.join(dir, "models.json"), `{
  // The GPU box, by hand.
  "providers": {
    "box": { "baseUrl": "http://box:8080/v1", "apiKey": "none", "models": [{ "id": "A" }], },
  },
}`);
  assert.deepEqual(p.listProviders().map((x) => x.id), ["box"]);
  await p.saveProvider("gpu", { kind: "llama-swap", adding: true, baseUrl: "http://gpu:8080", models: [{ id: "B" }] });
  assert.deepEqual(Object.keys(read("models.json").providers), ["box", "gpu"]);
});

test("a file that cannot be read is not saved over", async () => {
  const broken = '{ "providers": { "box": { "baseUrl": "http://box:8080/v1", "models": [ }';
  writeFileSync(path.join(dir, "models.json"), broken);
  await assert.rejects(p.saveProvider("gpu", { kind: "llama-swap", baseUrl: "http://gpu:8080", models: [{ id: "B" }] }), /models\.json could not be read/);
  await assert.rejects(p.removeProvider("box"), /could not be read/);
  assert.equal(readFileSync(path.join(dir, "models.json"), "utf8"), broken);

  writeFileSync(path.join(dir, "auth.json"), '{ "anthropic": { "type": "oauth", "refresh": "r1"');
  await assert.rejects(p.saveProvider("openrouter", { kind: "openrouter", apiKey: "sk-or-v1-0123456789" }), /auth\.json could not be read/);
  assert.equal(readFileSync(path.join(dir, "auth.json"), "utf8"), '{ "anthropic": { "type": "oauth", "refresh": "r1"');
  writeFileSync(path.join(dir, "models.json"), "{}");
  writeFileSync(path.join(dir, "auth.json"), "{}");
});

test("auth.json is changed under pi's lock, so a login pi refreshes meanwhile is kept", async () => {
  const { createRequire } = await import("node:module");
  const lockfile = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"))("proper-lockfile");
  const file = path.join(dir, "auth.json");
  writeFileSync(file, JSON.stringify({ anthropic: { type: "oauth", refresh: "old" } }));
  // pi, refreshing the login: it holds the lock while it reads, asks, and writes.
  const release = await lockfile.lock(file, { realpath: false });
  const before = JSON.parse(readFileSync(file, "utf8"));
  const saving = p.saveProvider("openrouter", { kind: "openrouter", apiKey: "sk-or-v1-0123456789" });
  await new Promise((r) => setTimeout(r, 300));
  writeFileSync(file, JSON.stringify({ ...before, anthropic: { type: "oauth", refresh: "new" } }));
  await release();
  await saving;
  const auth = read("auth.json");
  assert.equal(auth.anthropic.refresh, "new", "the refreshed login is not written over");
  assert.equal(auth.openrouter.key, "sk-or-v1-0123456789");
  writeFileSync(file, "{}");
});

test("a provider is not added under a name that is taken", async () => {
  writeFileSync(path.join(dir, "models.json"), JSON.stringify({ providers: { "llama-swap": { baseUrl: "http://gpu:8080/v1", apiKey: "none", models: [{ id: "A" }, { id: "B" }] } } }));
  writeFileSync(path.join(dir, "auth.json"), JSON.stringify({ openrouter: { type: "api_key", key: "sk-or-v1-first" } }));
  await assert.rejects(p.saveProvider("llama-swap", { kind: "llama-swap", adding: true, baseUrl: "http://other:8080", models: [{ id: "C" }] }), p.TakenError);
  await assert.rejects(p.saveProvider("openrouter", { kind: "openrouter", adding: true, apiKey: "sk-or-v1-second" }), p.TakenError);
  assert.deepEqual(read("models.json").providers["llama-swap"].models.map((m) => m.id), ["A", "B"]);
  assert.equal(read("auth.json").openrouter.key, "sk-or-v1-first");
  // Edited, it is changed.
  await p.saveProvider("llama-swap", { kind: "llama-swap", baseUrl: "http://gpu:8080", models: [{ id: "A" }] });
  assert.deepEqual(read("models.json").providers["llama-swap"].models.map((m) => m.id), ["A"]);
});

test("a server's key goes where pi reads it first: auth.json, when one is kept there", async () => {
  writeFileSync(path.join(dir, "models.json"), JSON.stringify({ providers: { box: { baseUrl: "http://box:8080/v1", apiKey: "none", models: [{ id: "A" }] } } }));
  writeFileSync(path.join(dir, "auth.json"), JSON.stringify({ box: { type: "api_key", key: "sk-old-0123456789" } }));
  await p.saveProvider("box", { kind: "llama-cpp", baseUrl: "http://box:8080", apiKey: "sk-new-0123456789", models: [{ id: "A" }] });
  assert.equal(p.storedKey("box"), "sk-new-0123456789");
  assert.equal(p.listProviders().find((x) => x.id === "box").key.hint, "sk-n…6789");
  // Cleared, it is gone from both.
  await p.saveProvider("box", { kind: "llama-cpp", baseUrl: "http://box:8080", apiKey: "", models: [{ id: "A" }] });
  assert.equal(read("auth.json").box, undefined);
  assert.equal(p.listProviders().find((x) => x.id === "box").key.set, false);
});

test("a models.json with comments is kept as it was before a save drops them", async () => {
  const { readdirSync } = await import("node:fs");
  const commented = '{\n  // by hand\n  "providers": { "box": { "baseUrl": "http://box:8080/v1", "apiKey": "none", "models": [{ "id": "A" }] } }\n}';
  writeFileSync(path.join(dir, "models.json"), commented);
  writeFileSync(path.join(dir, "models.json.bak"), "someone's own copy");
  const copies = () => readdirSync(dir).filter((f) => f.startsWith("models.json.before-")).length;
  const had = copies();
  const { backup } = await p.saveProvider("gpu", { kind: "llama-swap", baseUrl: "http://gpu:8080", models: [{ id: "B" }] });
  assert.match(backup, /^models\.json\.before-.+\.bak$/);
  assert.equal(readFileSync(path.join(dir, backup), "utf8"), commented);
  assert.equal(readFileSync(path.join(dir, "models.json.bak"), "utf8"), "someone's own copy", "a copy already there is not written over");
  // Without comments now: no more copies.
  assert.equal((await p.saveProvider("gpu", { kind: "llama-swap", baseUrl: "http://gpu:8080", models: [{ id: "B" }] })).backup, undefined);
  assert.equal((await p.removeProvider("gpu")).backup, undefined);
  assert.equal(copies(), had + 1);
  writeFileSync(path.join(dir, "models.json"), "{}");
});

test("a hosted key is removed even while models.json cannot be read, and the page is told why when not", async () => {
  const express = (await import("express")).default;
  const { providersRouter } = await import("../dist/api/providers.js");
  const app = express();
  app.use(express.json());
  app.use("/api", providersRouter());
  const server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const url = `http://127.0.0.1:${server.address().port}/api/providers`;
  try {
    writeFileSync(path.join(dir, "models.json"), '{ "providers": { "box": ');
    writeFileSync(path.join(dir, "auth.json"), JSON.stringify({ openrouter: { type: "api_key", key: "sk-or-v1-0123456789" } }));
    const removed = await fetch(`${url}/openrouter`, { method: "DELETE" });
    assert.equal(removed.status, 200);
    assert.equal(read("auth.json").openrouter, undefined);
    // A server in the file that cannot be read: a message the page can show, not an HTML page.
    const refused = await fetch(`${url}/box`, { method: "DELETE" });
    assert.equal(refused.status, 500);
    assert.match((await refused.json()).error, /models\.json could not be read/);
  } finally {
    server.close();
    writeFileSync(path.join(dir, "models.json"), "{}");
    writeFileSync(path.join(dir, "auth.json"), "{}");
  }
});
