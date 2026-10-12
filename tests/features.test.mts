import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { inProcessHome, scratch } from "./helpers.mts";

const temp = inProcessHome("pitha-features-");
const agentDir = process.env.PI_CODING_AGENT_DIR!;
delete process.env.MEMORY_UNDERSTORY_URL;

const {
  SUBAGENT_PACKAGE,
  UNDERSTORY_RULE,
  bundledSubagentDir,
  findSubagent,
  subagentModeOf,
  subagentLimitOf,
  understoryDefaultUrl,
  understoryEntry,
  understoryIn,
  understoryOn,
  understoryTokenOf,
} = await import("../server/src/features.ts");
const { extraContextFiles } = await import("../server/src/pi/sdk-client.ts");

test("a stranger at the memory's model route is turned away, and no key is made for the asking", async () => {
  const express = (await import("express")).default;
  const llm = await import("../server/src/memory-llm.ts");
  const service = await import("../server/src/extensions/understory-service.ts");
  assert.equal(service.existingLlmToken(), undefined, "none made yet");
  const app = express().use(llm.memoryLlmRouter(async () => undefined));
  const portal = app.listen(0, "127.0.0.1");
  await new Promise((r) => portal.once("listening", r));
  try {
    const at = `http://127.0.0.1:${(portal.address() as { port: number }).port}/understory-llm/v1/chat/completions`;
    const r = await fetch(at, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer guess" }, body: "{}" });
    assert.equal(r.status, 401);
    assert.equal(service.existingLlmToken(), undefined, "still none: asking does not make one");
  } finally {
    portal.close();
  }
});

test("the subagent tool ships with the portal, as a pi package", () => {
  const dir = bundledSubagentDir();
  assert.ok(dir, "found from source");
  assert.equal(path.basename(dir!), "subagent");
});

test("the subagent tool is found in pi's packages by its folder, or by its name from anywhere else", () => {
  const bundled = "/app/extensions/subagent";
  const names: Record<string, string> = { "/src/clone/extensions/subagent": SUBAGENT_PACKAGE, "/x/other": "something-else" };
  const nameOf = (dir: string) => names[dir];
  assert.equal(findSubagent(["npm:pi-mcp-adapter", "/x/other"], "/home/.pi/agent", bundled, nameOf), undefined);
  assert.deepEqual(findSubagent(["npm:x", bundled], "/home/.pi/agent", bundled, nameOf), { source: bundled, enabled: true });
  // Relative to the settings file's folder, as pi reads it.
  assert.deepEqual(findSubagent(["../../../app/extensions/subagent"], "/home/.pi/agent", bundled, nameOf), {
    source: "../../../app/extensions/subagent",
    enabled: true,
  });
  assert.deepEqual(findSubagent(["/src/clone/extensions/subagent"], "/home/.pi/agent", bundled, nameOf)?.source, "/src/clone/extensions/subagent");
  // Switched off in Extensions: there, and off.
  const off = { source: bundled, extensions: [], skills: [], prompts: [], themes: [] };
  assert.deepEqual(findSubagent([off], "/home/.pi/agent", bundled, nameOf), { source: bundled, enabled: false });
});

test("a subagent interrupts unless pi's settings say background", () => {
  assert.equal(subagentModeOf({}), "interrupt");
  assert.equal(subagentModeOf({ subagentMode: "sideways" }), "interrupt");
  assert.equal(subagentModeOf({ subagentMode: "background" }), "background");
});

test("one subagent at a time unless pi's settings allow more, as the tool reads it", () => {
  assert.equal(subagentLimitOf({}), 1);
  assert.equal(subagentLimitOf({ subagentMaxParallel: 4 }), 4);
  assert.equal(subagentLimitOf({ subagentMaxParallel: 2.5 }), 1);
  assert.equal(subagentLimitOf({ subagentMaxParallel: 40 }), 16);
});

test("Understory's entry puts its tools in front of the agent, and names its token rather than holding it", () => {
  assert.equal(understoryDefaultUrl(), "http://localhost:3800/mcp");
  assert.deepEqual(understoryEntry("http://understory:3800/mcp"), { url: "http://understory:3800/mcp", lifecycle: "lazy", directTools: true });
  assert.deepEqual(understoryEntry("http://u/mcp", { tokenEnv: "MEMORY_UNDERSTORY_AUTH_TOKEN" }), {
    url: "http://u/mcp",
    lifecycle: "lazy",
    directTools: true,
    auth: "bearer",
    bearerTokenEnv: "MEMORY_UNDERSTORY_AUTH_TOKEN",
  });
  assert.equal(understoryIn({ mcpServers: {} }), false);
  assert.equal(understoryIn({ mcpServers: { understory: { url: "x" } } }), true);
  assert.equal(understoryIn({ mcpServers: { understory: { url: "x", disabled: true } } }), false, "switched off in MCP is off");
});

test("while Understory is the memory, MEMORY.md is not read; switched off, it is again", () => {
  const home = scratch("pitha-home-");
  for (const f of ["SOUL.md", "PrimaryUser.md", "MEMORY.md"]) writeFileSync(path.join(home, f), `# ${f}\n`);
  const names = (role?: string) => extraContextFiles(home, role).map((f) => path.basename(f.path));

  assert.deepEqual(names(), ["SOUL.md", "PrimaryUser.md", "MEMORY.md"]);
  writeFileSync(path.join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { understory: understoryEntry("http://u/mcp") } }));
  // Its tools come through the adapter: without it, MEMORY.md stays.
  assert.equal(understoryOn(), false, "no adapter installed");
  writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ packages: [{ source: "npm:pi-mcp-adapter", extensions: [], skills: [], prompts: [], themes: [] }] }));
  assert.equal(understoryOn(), false, "the adapter switched off");
  assert.deepEqual(names(), ["SOUL.md", "PrimaryUser.md", "MEMORY.md"]);
  writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ packages: ["npm:pi-mcp-adapter"] }));
  assert.equal(understoryOn(), true);
  assert.deepEqual(names(), ["SOUL.md", "PrimaryUser.md"]);
  assert.deepEqual(names("primary"), ["SOUL.md", "PrimaryUser.md"]);
  assert.match(UNDERSTORY_RULE, /understory_memory_query/);

  writeFileSync(path.join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { understory: { url: "http://u/mcp", disabled: true } } }));
  assert.deepEqual(names(), ["SOUL.md", "PrimaryUser.md", "MEMORY.md"]);
  // A file that cannot be read says nothing about Understory: the file memory stays.
  writeFileSync(path.join(agentDir, "mcp.json"), "{ nope");
  assert.equal(understoryOn(), false);
});

test("the memory is read through the portal: only Understory's read API, with its token, and only while it is on", async () => {
  const { createServer } = await import("node:http");
  const express = (await import("express")).default;
  const { memoryRouter } = await import("../server/src/api/memory.ts");
  const asked: { url: string; auth?: string }[] = [];
  const understory = createServer((req, res) => {
    asked.push({ url: req.url!, auth: req.headers.authorization });
    res.setHeader("content-type", "application/json");
    if (req.url!.startsWith("/api/concept?path=%2Fgone.md")) return res.writeHead(404).end(JSON.stringify({ error: "Concept not found: /gone.md" }));
    if (req.url === "/api/log") return res.writeHead(500).end("<html>broken</html>");
    res.end(JSON.stringify(req.url === "/api/tree" ? { name: "/", path: "/", kind: "directory", children: [] } : [{ path: "/a.md" }]));
  });
  await new Promise<void>((r) => understory.listen(0, "127.0.0.1", r));
  const port = (understory.address() as { port: number }).port;
  const app = express().use(express.json()).use("/api", memoryRouter());
  const portal = app.listen(0, "127.0.0.1");
  await new Promise((r) => portal.once("listening", r));
  const at = `http://127.0.0.1:${(portal.address() as { port: number }).port}/api/memory`;
  const get = async (p: string) => {
    const r = await fetch(`${at}${p}`);
    return { status: r.status, body: await r.json() };
  };
  try {
    writeFileSync(path.join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: {} }));
    assert.equal((await get("/tree")).status, 409, "not while it is off");

    writeFileSync(path.join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { understory: understoryEntry(`http://127.0.0.1:${port}/mcp`, { tokenEnv: "MEMORY_UNDERSTORY_AUTH_TOKEN" }) } }));
    process.env.MEMORY_UNDERSTORY_AUTH_TOKEN = "s3cret";
    assert.deepEqual(await get("/tree"), { status: 200, body: { name: "/", path: "/", kind: "directory", children: [] } });
    assert.deepEqual(asked.at(-1), { url: "/api/tree", auth: "Bearer s3cret" });
    assert.equal((await get("/search?q=deploy%20script")).status, 200);
    assert.equal(asked.at(-1)!.url, "/api/search?q=deploy+script");
    assert.equal((await get("/search")).status, 400, "a search needs something to look for");
    assert.deepEqual(await get("/concept?path=/gone.md"), { status: 404, body: { error: "Concept not found: /gone.md" } });
    assert.equal((await get("/log")).status, 502, "what is not JSON is Understory failing");
    assert.equal((await get("/graph")).status, 200);
    assert.equal(asked.at(-1)!.url, "/api/graph");
    assert.equal((await fetch(`${at}/chat`)).status, 404, "the librarian is asked with a POST, in the Understory the portal runs only (memory-chat.test.mts)");
    // A note is changed only in the Understory the portal runs; this one it does not.
    const put = await fetch(`${at}/concept`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "/a.md", frontmatter: { type: "T", title: "A" }, body: "" }) });
    assert.equal(put.status, 409);
    assert.match((await put.json()).error, /only in the Understory the portal runs/);
    delete process.env.MEMORY_UNDERSTORY_AUTH_TOKEN;
    await get("/tree");
    assert.equal(asked.at(-1)!.auth, undefined);
  } finally {
    understory.close();
    portal.close();
  }
});

test("the Understory the portal runs: its model from a provider or an address of its own, its tidying up, a token of its own", async () => {
  const service = await import("../server/src/extensions/understory-service.ts");
  assert.equal(service.intervalMs("6h"), 6 * 3_600_000);
  assert.equal(service.intervalMs("sometimes"), null);
  assert.equal(service.validInterval(""), true, "never is an interval too");
  assert.equal(service.validInterval("30m"), true);
  assert.equal(service.validInterval("2m"), false, "Understory's floor is five minutes");

  writeFileSync(
    path.join(agentDir, "models.json"),
    JSON.stringify({ providers: { "llama-swap": { baseUrl: "http://gpu:8080/v1", api: "openai-completions", models: [{ id: "model-a" }] }, claude: { baseUrl: "https://api.anthropic.com", api: "anthropic-messages", apiKey: "$CLAUDE_KEY", models: [{ id: "sonnet" }] } } }),
  );
  process.env.CLAUDE_KEY = "sk-from-env";
  assert.deepEqual(service.llmEnv({ source: "provider", provider: "llama-swap", model: "model-a" }), { baseUrl: "http://gpu:8080/v1", apiKey: "none", model: "model-a", format: "openai" });
  assert.deepEqual(service.llmEnv({ source: "provider", provider: "claude", model: "sonnet" }), { baseUrl: "https://api.anthropic.com", apiKey: "sk-from-env", model: "sonnet", format: "anthropic" });
  assert.throws(() => service.llmEnv({ source: "provider", provider: "gone", model: "x" }), /no provider "gone"/);
  // A key is read as pi reads it: "$NAME" and "${NAME}" name a variable, a word in capitals is a key that happens to look like one, and a command is pi's to run.
  const keyed = (apiKey: string) => {
    writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: { keyed: { baseUrl: "http://gpu:8080/v1", api: "openai-completions", apiKey, models: [{ id: "m" }] } } }));
    return service.llmEnv({ source: "provider", provider: "keyed", model: "m" }).apiKey;
  };
  assert.equal(keyed("${CLAUDE_KEY}"), "sk-from-env");
  assert.equal(keyed("CLAUDE_KEY"), "CLAUDE_KEY", "a bare word is the key itself, not the variable of that name");
  assert.equal(keyed("$NOT_SET_ANYWHERE"), "none", "a variable that is not set is no key, not the text of its name");
  assert.throws(() => keyed("!pass show llm"), /command pi runs/);
  writeFileSync(
    path.join(agentDir, "models.json"),
    JSON.stringify({ providers: { "llama-swap": { baseUrl: "http://gpu:8080/v1", api: "openai-completions", models: [{ id: "model-a" }] }, claude: { baseUrl: "https://api.anthropic.com", api: "anthropic-messages", apiKey: "$CLAUDE_KEY", models: [{ id: "sonnet" }] } } }),
  );

  const token = service.token();
  assert.equal(service.token(), token, "made once");
  const env = service.spec({ llm: { source: "provider", provider: "llama-swap", model: "model-a" }, dreamInterval: "6h" }, token).Env;
  for (const line of ["BUNDLE_ROOT=/bundle", `AUTH_TOKEN=${token}`, "LLM_API_BASE_URL=http://gpu:8080/v1", "LLM_MODEL=model-a", "DREAM_INTERVAL=6h"]) assert.ok(env.includes(line), line);
  assert.ok(!service.spec({ llm: { source: "provider", provider: "llama-swap", model: "model-a" }, dreamInterval: "" }, token).Env.some((l) => l.startsWith("DREAM_INTERVAL")), "never is no interval at all");

  // A key the page never holds is kept when it sends none.
  service.saveConfig({ llm: { source: "custom", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat", format: "openai", apiKey: "sk-1" }, dreamInterval: "1d" });
  service.saveConfig({ llm: { source: "custom", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-reasoner", format: "openai" }, dreamInterval: "1d" });
  assert.deepEqual(service.config(), { llm: { source: "custom", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-reasoner", format: "openai", apiKey: "sk-1" }, dreamInterval: "1d", dreamAt: "" });
  // Another address does not get the key the last one had.
  service.saveConfig({ llm: { source: "custom", baseUrl: "http://other:8080/v1", model: "m", format: "openai" }, dreamInterval: "1d" });
  assert.equal((service.config().llm as { apiKey?: string }).apiKey, undefined, "a key is its server's");
  service.saveConfig({ llm: { source: "custom", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-reasoner", format: "openai", apiKey: "" }, dreamInterval: "" });
  assert.equal((service.config().llm as { apiKey?: string }).apiKey, "", "an empty one clears it");
});

test("the portal's own Understory is written with its token; one run elsewhere names it from the environment", () => {
  assert.deepEqual(understoryEntry("http://127.0.0.1:3800/mcp", { token: "t0k" }), { url: "http://127.0.0.1:3800/mcp", lifecycle: "lazy", directTools: true, auth: "bearer", bearerToken: "t0k" });
  assert.equal(understoryTokenOf({ bearerToken: "t0k" }), "t0k");
  process.env.SOME_TOKEN = "from-env";
  assert.equal(understoryTokenOf({ bearerTokenEnv: "SOME_TOKEN" }), "from-env");
  assert.equal(understoryTokenOf({ url: "x" }), undefined);
});

test("tidying up at a set time: the next time it comes round, Understory's own timer off, the report read from what the pass printed", async () => {
  const service = await import("../server/src/extensions/understory-service.ts");
  assert.equal(service.validTime("03:00"), true);
  assert.equal(service.validTime(""), true);
  assert.equal(service.validTime("3am"), false);
  assert.equal(service.validTime("24:00"), false);

  const evening = new Date(2026, 8, 28, 22, 15);
  assert.deepEqual(service.nextAt("03:00", evening), new Date(2026, 8, 29, 3, 0));
  const night = new Date(2026, 8, 29, 2, 0);
  assert.deepEqual(service.nextAt("03:00", night), new Date(2026, 8, 29, 3, 0), "later the same night");
  assert.deepEqual(service.nextAt("03:00", new Date(2026, 8, 29, 3, 0)), new Date(2026, 8, 30, 3, 0), "not twice in the same minute");

  const llm = { source: "custom" as const, baseUrl: "http://gpu:8080/v1", model: "m", format: "openai" as const };
  assert.ok(!service.spec({ llm, dreamInterval: "6h", dreamAt: "03:00" }, "t").Env.some((l) => l.startsWith("DREAM_INTERVAL")), "a set time wins");
  service.saveConfig({ llm, dreamInterval: "6h", dreamAt: "03:00" });
  assert.deepEqual([service.config().dreamInterval, service.config().dreamAt], ["", "03:00"]);
  assert.ok(service.nextDreamAt(), "scheduled once saved");
  service.saveConfig({ llm, dreamInterval: "", dreamAt: "" });
  assert.equal(service.nextDreamAt(), undefined, "and no longer once it is not");

  assert.deepEqual(service.readReport('\u001b[0mloading\r\n{"ran":false,"reason":"memory healthy"}\r\n'), { ran: false, reason: "memory healthy" });
  assert.deepEqual(service.readReport('{"ran":true,"summary":"merged two","filesChanged":["/a.md"]}\nbye'), { ran: true, summary: "merged two", filesChanged: ["/a.md"] });
  assert.equal(service.readReport("Error: boom"), null);
});

test("Understory thinking with the chat's model: the chat whose memory tool runs, its model, its key, the answer streamed back", async () => {
  const { createServer } = await import("node:http");
  const express = (await import("express")).default;
  const llm = await import("../server/src/memory-llm.ts");
  const service = await import("../server/src/extensions/understory-service.ts");

  llm.forgetAsking();
  llm.noteToolCall("chat-a", "r1", "read", "start");
  assert.equal(llm.askingChat(), undefined, "only the memory's tools count");
  llm.noteToolCall("chat-a", "a1", "understory_memory_add", "start");
  llm.noteToolCall("chat-b", "b1", "understory_memory_query", "start");
  assert.equal(llm.askingChat(), "chat-b", "the newest asking");
  llm.noteToolCall("chat-b", "b1", "understory_memory_query", "end");
  assert.equal(llm.askingChat(), "chat-a");
  llm.noteToolCall("chat-a", "a1", "understory_memory_add", "end");
  assert.equal(llm.askingChat(), "chat-b", "none asking now: the last that started asking");
  llm.noteToolCall("chat-a", "a1", "understory_memory_add", "start");
  llm.noteToolCall("chat-a", "a1", "understory_memory_add", "end");

  const seen: { body: any; auth?: string }[] = [];
  const upstream = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      seen.push({ body: JSON.parse(raw), auth: req.headers.authorization });
      res.setHeader("content-type", "text/event-stream");
      res.write('data: {"choices":[{"delta":{"content":"he"}}]}\n\n');
      setTimeout(() => res.end('data: {"choices":[{"delta":{"content":"llo"}}]}\n\ndata: [DONE]\n\n'), 30);
    });
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  const up = (upstream.address() as { port: number }).port;
  writeFileSync(
    path.join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        fake: { baseUrl: `http://127.0.0.1:${up}/v1`, api: "openai-completions", apiKey: "sk-fake", models: [{ id: "model-b" }] },
        claude: { baseUrl: "https://api.anthropic.com", api: "anthropic-messages", apiKey: "x", models: [{ id: "sonnet" }] },
      },
    }),
  );
  let chatModel = { provider: "fake", id: "model-b" };
  const app = express().use(llm.memoryLlmRouter(async (id) => (id === "chat-a" ? chatModel : undefined)));
  const portal = app.listen(0, "127.0.0.1");
  await new Promise((r) => portal.once("listening", r));
  const at = `http://127.0.0.1:${(portal.address() as { port: number }).port}/understory-llm/v1`;
  const ask = (auth = service.llmToken()) =>
    fetch(`${at}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${auth}` },
      body: JSON.stringify({ model: "auto", stream: true, messages: [{ role: "user", content: "hi" }] }),
    });
  try {
    assert.equal((await ask("wrong")).status, 401);
    // Turned away before its body is read: what is not JSON is not even looked at.
    const unread = await fetch(`${at}/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: "{ not json" });
    assert.equal(unread.status, 401);
    const answer = await ask();
    assert.equal(answer.status, 200, answer.status === 200 ? "" : await answer.clone().text());
    assert.match(answer.headers.get("content-type") ?? "", /event-stream/);
    assert.match(await answer.text(), /"he"[\s\S]*"llo"[\s\S]*\[DONE\]/);
    assert.deepEqual(seen[0], { body: { model: "model-b", stream: true, messages: [{ role: "user", content: "hi" }] }, auth: "Bearer sk-fake" });

    // Understory hanging up mid-answer ends the stream here, and nothing else.
    const hangUp = new AbortController();
    const cut = await fetch(`${at}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${service.llmToken()}` },
      body: JSON.stringify({ model: "auto", stream: true, messages: [] }),
      signal: hangUp.signal,
    });
    await cut.body!.getReader().read();
    hangUp.abort();
    await new Promise((r) => setTimeout(r, 100));
    assert.equal((await ask()).status, 200, "still answering after one hung up");

    // A chat whose pi is gone asks nothing any more.
    llm.noteToolCall("chat-gone", "g1", "understory_memory_add", "start");
    assert.equal(llm.askingChat(), "chat-gone");
    llm.forgetChat("chat-gone");
    assert.equal(llm.askingChat(), undefined, "nobody asking: the model new chats start on");
    // A subagent killed mid-call asks no more.
    llm.noteToolCall("chat-s", "sub-1:c1", "understory_memory_query", "start");
    assert.equal(llm.askingChat(), "chat-s");
    llm.subagentGone("chat-s", "sub-1");
    llm.noteToolCall("chat-t", "t1", "understory_memory_query", "start");
    llm.noteToolCall("chat-t", "t1", "understory_memory_query", "end");
    assert.equal(llm.askingChat(), "chat-t", "chat-s is not held asking by a call that never ended");
    llm.forgetChat("chat-s");
    llm.forgetChat("chat-t");
    llm.noteToolCall("chat-a", "a1", "understory_memory_add", "start");

    chatModel = { provider: "claude", id: "sonnet" };
    const refused = await ask();
    assert.equal(refused.status, 502);
    assert.match((await refused.json()).error.message, /speaks anthropic-messages, not OpenAI chat completions/);
  } finally {
    upstream.close();
    portal.close();
  }

  // Understory is pointed at it, with its own key, in "the chat's" mode — the default.
  service.saveConfig({ llm: { source: "auto" }, dreamInterval: "", dreamAt: "" });
  assert.deepEqual(service.llmEnv(service.config().llm), { baseUrl: "http://127.0.0.1:4100/understory-llm/v1", apiKey: service.llmToken(), model: "auto", format: "openai" });
});

test("a note changed by hand is one of its own: absolute, markdown, not Understory's index or log, and not outside the bundle", async () => {
  const { notePath } = await import("../server/src/api/memory.ts");
  assert.equal(notePath("/people/owner.md"), "/people/owner.md");
  assert.equal(notePath("people/owner.md"), undefined);
  assert.equal(notePath("/people/owner.txt"), undefined);
  assert.equal(notePath("/index.md"), undefined);
  assert.equal(notePath("/people/log.md"), undefined);
  assert.equal(notePath("/people/../../etc/passwd.md"), undefined);
  assert.equal(notePath(42), undefined);
});

test("what a model says it did is kept to one plain line: its first sentence, without the markdown", async () => {
  const { firstLine } = await import("../server/src/extensions/understory-service.ts");
  assert.equal(firstLine("The orphan is resolved — the graph is now healthy (4 concepts).\n\n## What changed\n\n- a"), "The orphan is resolved — the graph is now healthy (4 concepts).");
  assert.equal(firstLine("**Fixed** the link from [branches](/deployment/branches.md). More."), "Fixed the link from branches.");
  assert.equal(firstLine("x".repeat(300)).length, 160);
  assert.equal(firstLine(undefined), "");
});

test("what is handed to Understory is measured as it travels: UTF-8, base64, in one variable of at most 128 KiB", async () => {
  const service = await import("../server/src/extensions/understory-service.ts");
  const note = (body: string) => ({ path: "/a.md", frontmatter: { type: "T", title: "A" }, body, summary: "x" });
  assert.equal(service.fitsInEnv(note("a".repeat(90_000))), true);
  assert.equal(service.fitsInEnv(note("a".repeat(99_000))), false, "under 100 000 characters, over the limit once base64'd");
  assert.equal(service.fitsInEnv(note("記".repeat(30_000))), true);
  assert.equal(service.fitsInEnv(note("記".repeat(34_000))), false, "three bytes a letter");
});

test("background subagents the last server left running are found by their start without an end", async () => {
  const { appendEvent, openDetachedSubagents } = await import("../server/src/db.ts");
  const { createSession } = await import("../server/src/db.ts");
  createSession({ id: "bg-chat", title: "t", workspace: "/w", executor: "host", kind: "task" });
  appendEvent("bg-chat", "portal_subagent", { type: "portal_subagent", op: "start", id: "done-one", detached: true });
  appendEvent("bg-chat", "portal_subagent", { type: "portal_subagent", op: "end", id: "done-one", detached: true, status: "done" });
  appendEvent("bg-chat", "portal_subagent", { type: "portal_subagent", op: "start", id: "left-one", detached: true });
  appendEvent("bg-chat", "portal_subagent", { type: "portal_subagent", op: "start", id: "foreground", toolCallId: "c" });
  assert.deepEqual(openDetachedSubagents(), [{ sessionId: "bg-chat", id: "left-one" }]);
});

test("a saved key goes with the same address only, and what was saved before can be put back as it was", async () => {
  const service = await import("../server/src/extensions/understory-service.ts");
  service.saveConfig({ llm: { source: "custom", baseUrl: "https://a/v1", model: "m", format: "openai", apiKey: "sk-a" }, dreamInterval: "", dreamAt: "" });
  assert.equal((service.withSavedKey({ source: "custom", baseUrl: "https://a/v1", model: "n", format: "openai" }) as any).apiKey, "sk-a");
  assert.equal((service.withSavedKey({ source: "custom", baseUrl: "https://b/v1", model: "n", format: "openai" }) as any).apiKey, undefined);
  const before = service.config();
  service.saveConfig({ llm: { source: "auto" }, dreamInterval: "6h", dreamAt: "" });
  service.restoreConfig(before);
  assert.deepEqual(service.config(), before);
});

test("the page is shown the three defaults it edits, and nothing else the settings table keeps", async () => {
  const { setSettings, shownStoredSettings } = await import("../server/src/db.ts");
  const service = await import("../server/src/extensions/understory-service.ts");
  service.token();
  service.llmToken();
  service.saveConfig({ llm: { source: "custom", baseUrl: "https://a/v1", model: "m", format: "openai", apiKey: "sk-secret" }, dreamInterval: "", dreamAt: "" });
  setSettings({ provider: "llama-swap", model: "model-a" });
  const shown = shownStoredSettings();
  assert.deepEqual(shown, { provider: "llama-swap", model: "model-a" });
  assert.doesNotMatch(JSON.stringify(shown), /sk-secret|understory/);
});

test("the chat's model for the memory is off only when the portal really serves its own TLS: both files named, and there", async () => {
  const service = await import("../server/src/extensions/understory-service.ts");
  const cert = path.join(temp, "cert.pem");
  const key = path.join(temp, "key.pem");
  process.env.PORTAL_TLS_CERT = cert;
  process.env.PORTAL_TLS_KEY = key;
  try {
    assert.ok(service.portalLlmBase(), "named but missing: the portal serves plain HTTP");
    writeFileSync(cert, "x");
    writeFileSync(key, "x");
    assert.equal(service.portalLlmBase(), undefined);
  } finally {
    delete process.env.PORTAL_TLS_CERT;
    delete process.env.PORTAL_TLS_KEY;
  }
});

test("the portal's Understory shares the portal's network and says it is the portal's", async () => {
  const service = await import("../server/src/extensions/understory-service.ts");
  const made = service.spec({ llm: { source: "custom", baseUrl: "http://gpu/v1", model: "m", format: "openai" }, dreamInterval: "", dreamAt: "" }, "t", "container:abc");
  assert.equal(made.HostConfig.NetworkMode, "container:abc");
  assert.deepEqual(made.Labels, { [service.LABEL]: "understory" });
});

test("a package pi lists by its folder is found as a full path, ~ for home included", async () => {
  const { localPackagePath } = await import("../server/src/features.ts");
  const home = process.env.HOME;
  process.env.HOME = "/home/someone";
  try {
    assert.equal(localPackagePath("~/src/pithagoras/extensions/subagent", "/home/someone/.pi/agent"), "/home/someone/src/pithagoras/extensions/subagent");
    assert.equal(localPackagePath("../../src/x", "/home/someone/.pi/agent"), "/home/someone/src/x");
    assert.equal(localPackagePath("/abs/x", "/home/someone/.pi/agent"), "/abs/x");
  } finally {
    process.env.HOME = home;
  }
});

test("background subagents open in a chat are kept in step with their starts and ends, and dropped with the chat", async () => {
  const { appendEvent, openSubagentsIn, createSession, deleteSession } = await import("../server/src/db.ts");
  createSession({ id: "open-chat", title: "t", workspace: "/w", executor: "host", kind: "task" });
  appendEvent("open-chat", "portal_subagent", { type: "portal_subagent", op: "start", id: "a", detached: true });
  appendEvent("open-chat", "portal_subagent", { type: "portal_subagent", op: "start", id: "b", detached: true });
  appendEvent("open-chat", "portal_subagent", { type: "portal_subagent", op: "event", id: "a", detached: true, event: { type: "agent_start" } });
  appendEvent("open-chat", "portal_subagent", { type: "portal_subagent", op: "end", id: "a", detached: true, status: "done" });
  assert.deepEqual(openSubagentsIn("open-chat"), ["b"]);
  deleteSession("open-chat");
  assert.deepEqual(openSubagentsIn("open-chat"), []);
});
