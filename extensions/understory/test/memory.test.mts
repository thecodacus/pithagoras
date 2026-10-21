import { test } from "node:test";
import assert from "node:assert/strict";
import { inProcessHome } from "../../../tests/helpers.mts";
import { serveUnderstory, sse } from "./portal.mts";

/**
 * The Memory page's routes, at /api/x/pithagoras-understory, as the portal serves them: Understory's own read API
 * handed on with its token while it is the agent's memory, the changes run through Understory's own write path in the
 * container the portal runs, and the librarian, Understory's own agent, asked through the portal.
 */

inProcessHome("pithagoras-understory-memory-");
const { at, understory, docker, machine, scripts, adapterOn, putServers } = await serveUnderstory();
const { chatMessages, notePath } = await import("../src/server/memory.ts");
const { understoryEntry } = await import("../src/server/entry.ts");
const service = await import("../src/server/service.ts");
const store = await import("../src/server/store.ts");

const port = Number(process.env.UNDERSTORY_PORT);
const get = async (route: string) => {
  const r = await fetch(`${at}${route}`);
  return { status: r.status, body: await r.json() };
};
const send = async (method: string, route: string, body?: unknown) => {
  const r = await fetch(`${at}${route}`, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: r.status, body: await r.json() };
};
/** Understory as the agent's memory at an address of its own, with its token named from the environment. */
const elsewhere = (host = "127.0.0.1") => putServers({ understory: understoryEntry(`http://${host}:${port}/mcp`, { tokenEnv: "MEMORY_UNDERSTORY_AUTH_TOKEN" }) });
/** What a script run in the container was handed. */
const handed = () => {
  const line = docker.execs.at(-1)!.Env.find((e) => e.startsWith("PORTAL_INPUT="));
  return line && JSON.parse(Buffer.from(line.slice("PORTAL_INPUT=".length), "base64").toString("utf8"));
};
adapterOn();

test("the memory is read through the portal: only Understory's read API, with its token, and only while it is the agent's memory", async () => {
  understory.state.reads = {
    "/api/tree": { body: { name: "/", path: "/", kind: "directory", children: [] } },
    "/api/concept": { status: 404, body: { error: "Concept not found: /gone.md" } },
    "/api/log": { status: 500, body: "<html>broken</html>" },
  };
  putServers({});
  assert.deepEqual(await get("/tree"), { status: 409, body: { error: "Understory is not the agent's memory. Switch it on in Settings → Memory." } });

  elsewhere();
  process.env.MEMORY_UNDERSTORY_AUTH_TOKEN = "s3cret";
  try {
    assert.deepEqual(await get("/tree"), { status: 200, body: { name: "/", path: "/", kind: "directory", children: [] } });
    assert.deepEqual(understory.seen.at(-1), { method: "GET", url: "/api/tree", auth: "Bearer s3cret" });
    assert.equal((await get("/search?q=deploy%20script")).status, 200);
    assert.equal(understory.seen.at(-1)!.url, "/api/search?q=deploy+script");
    assert.equal((await get("/search")).status, 400, "a search needs something to look for");
    assert.deepEqual(await get("/concept?path=/gone.md"), { status: 404, body: { error: "Concept not found: /gone.md" } });
    assert.deepEqual(await get("/log"), { status: 502, body: { error: "Understory answered 500 with something that is not JSON." } });
    assert.equal((await get("/graph")).status, 200);
    assert.equal(understory.seen.at(-1)!.url, "/api/graph");
    // A run's steps, by the id asked for; none asked for is refused here, before Understory hears of it.
    const before = understory.seen.length;
    assert.deepEqual(await get("/trace"), { status: 400, body: { error: "id is required" } });
    assert.equal(understory.seen.length, before);
    // Its server switched off in Settings → MCP: it is not the agent's memory, whatever the adapter.
    putServers({ understory: { ...understoryEntry(`http://127.0.0.1:${port}/mcp`), disabled: true } });
    assert.equal((await get("/tree")).status, 409);
    elsewhere();
  } finally {
    delete process.env.MEMORY_UNDERSTORY_AUTH_TOKEN;
  }
  await get("/tree");
  assert.equal(understory.seen.at(-1)!.auth, undefined, "no token where none is set");
  understory.state.down = true;
  assert.match((await get("/tree")).body.error, new RegExp(`^Could not reach Understory at http://127.0.0.1:${port}: `));
  understory.state.down = false;
});

test("one run's steps are read from Understory through the portal, with its token, by the id asked for", async () => {
  elsewhere();
  process.env.MEMORY_UNDERSTORY_AUTH_TOKEN = "s3cret";
  try {
    understory.state.reads = { "/api/trace": { body: { id: "run-1", kind: "query", notation: "read owner.md → ✓", steps: [{ seq: 1, tool: "read_concept", summary: "/people/owner.md", paths: ["/people/owner.md"], write: false }] } } };
    const run = await get("/trace?id=run-1");
    assert.equal(run.status, 200);
    assert.deepEqual(run.body.steps[0].paths, ["/people/owner.md"], "the full path of the note the step touched");
    assert.deepEqual(understory.seen.at(-1), { method: "GET", url: "/api/trace?id=run-1", auth: "Bearer s3cret" });
    // An id Understory does not know is the page's to say.
    understory.state.reads = { "/api/trace": { status: 404, body: { error: "trace not found" } } };
    assert.deepEqual(await get("/trace?id=gone"), { status: 404, body: { error: "trace not found" } });
    // And only while Understory is the memory.
    putServers({});
    assert.equal((await get("/trace?id=run-1")).status, 409);
  } finally {
    delete process.env.MEMORY_UNDERSTORY_AUTH_TOKEN;
    understory.state.reads = {};
  }
});

test("notes are changed only in the Understory the portal runs, while it runs and is the agent's memory", async () => {
  machine.reset();
  // Understory elsewhere: read, not written.
  elsewhere("localhost");
  assert.deepEqual(await get("/health"), { status: 200, body: { writable: false } });
  const refused = await send("PUT", "/concept", { path: "/a.md", frontmatter: { type: "T", title: "A" }, body: "" });
  assert.deepEqual(refused, { status: 409, body: { error: "Notes can be changed here only in the Understory the portal runs, while it is running and the agent's memory." } });
  // The portal's, installed and its memory.
  assert.equal((await send("POST", "/install")).status, 200);
  assert.deepEqual(await get("/health"), { status: 200, body: { writable: true, health: { healthy: true, orphans: [], brokenLinks: [], issues: [] } } });
  await service.stop();
  assert.deepEqual(await get("/health"), { status: 200, body: { writable: false } }, "not while its container is stopped");
  await service.start();
  assert.equal(docker.execs.some((e) => e.Env.some((line) => line.startsWith("PORTAL_INPUT="))), false, "nothing was handed over yet");
});

test("a note written by hand goes through Understory's own write path, with what it says of itself, its index and log following", async () => {
  scripts.save = () => ({ out: `${JSON.stringify({ concept: { path: "/people/owner.md", frontmatter: { type: "Person", title: "Owner" }, body: "hi" }, health: { healthy: true, orphans: [], brokenLinks: [], issues: [] } })}\n` });
  const saved = await send("PUT", "/concept", { path: "/people/owner.md", frontmatter: { type: "Person", title: "Owner" }, body: "hi" });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.concept.path, "/people/owner.md");
  assert.deepEqual(handed(), { path: "/people/owner.md", frontmatter: { type: "Person", title: "Owner" }, body: "hi", summary: "Edited [Owner](/people/owner.md) by hand in the portal." });
  const run = docker.execs.at(-1)!;
  assert.deepEqual([run.Cmd.slice(0, 2), run.WorkingDir, run.Tty], [["node", "-e"], "/app/server", true]);
  assert.match(run.Cmd[2], /pithagoras-portal-run/, "marked, so a run given up on can be found and ended");

  for (const [body, error] of [
    [{ path: "people/owner.md", frontmatter: { type: "T", title: "A" }, body: "" }, "A note's path is absolute, ends in .md, and is not an index.md or log.md"],
    [{ path: "/a.md", frontmatter: [], body: "" }, "frontmatter must be an object"],
    [{ path: "/a.md", frontmatter: { type: "T" }, body: "" }, "A note needs a type and a title"],
    [{ path: "/a.md", frontmatter: { type: "T", title: "A" }, body: 3 }, "body must be text"],
    [{ path: "/a.md", frontmatter: { type: "T", title: "A" }, body: "a".repeat(99_000) }, "This note is too long to write from here: at most about 95 kB, less in scripts that take more bytes a letter"],
  ] as const) {
    assert.deepEqual(await send("PUT", "/concept", body), { status: 400, body: { error } });
  }

  await send("DELETE", "/concept?path=/people/owner.md");
  assert.deepEqual(handed(), { path: "/people/owner.md", summary: "Deleted /people/owner.md by hand in the portal." });
  for (const [route, script] of [["/reindex", "reindex"], ["/clear-log", "clearLog"], ["/repair", "repair"]]) {
    assert.equal((await send("POST", route)).status, 200, route);
    assert.equal(machine.ran().at(-1), script);
  }
});

test("wiped, the memory is cleared, Understory is stopped and started again, and the answer waits until it answers", async () => {
  const before = understory.seen.length;
  const starts = docker.starts.length;
  const wiped = await send("POST", "/wipe");
  assert.equal(wiped.status, 200);
  assert.equal(machine.ran().at(-1), "wipe");
  assert.equal(docker.starts.length, starts + 1, "started again");
  const asked = understory.seen.slice(before);
  assert.deepEqual(asked.map((r) => [r.url, r.auth]), [["/api/validate", `Bearer ${store.setting("token")}`]]);
});

test("a conversation is checked before it is passed on: user and assistant messages with parts, ending in the user's; a note's path is one of its own", () => {
  assert.equal(chatMessages(undefined), undefined);
  assert.equal(chatMessages([]), undefined);
  assert.equal(chatMessages([{ role: "system", parts: [] }]), undefined);
  assert.equal(chatMessages([{ role: "user" }]), undefined, "no parts");
  assert.equal(chatMessages([{ role: "user", parts: [] }, { role: "assistant", parts: [] }]), undefined, "it ends with the answer, not the question");
  assert.equal(chatMessages(Array.from({ length: 201 }, () => ({ role: "user", parts: [] }))), undefined);
  assert.deepEqual(chatMessages([{ role: "user", parts: [{ type: "text", text: "a" }], extra: 1 }]), [{ id: "m0", role: "user", parts: [{ type: "text", text: "a" }] }]);

  assert.equal(notePath("/people/owner.md"), "/people/owner.md");
  assert.equal(notePath("people/owner.md"), undefined);
  assert.equal(notePath("/people/owner.txt"), undefined);
  assert.equal(notePath("/index.md"), undefined);
  assert.equal(notePath("/people/log.md"), undefined);
  assert.equal(notePath("/people/../../etc/passwd.md"), undefined);
  assert.equal(notePath(42), undefined);
});

// --- the librarian: only in the Understory the portal runs, handed on with its token, one run at a time ---

const ask = (body: unknown, signal?: AbortSignal) => fetch(`${at}/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal });
const question = { messages: [{ id: "q1", role: "user", parts: [{ type: "text", text: "What is deployed?" }], extra: "dropped" }] };
/** Its own entry: the Understory the portal runs, with its token. */
const managed = () => putServers({ understory: understoryEntry(`http://127.0.0.1:${port}/mcp`, { token: store.setting("token") }) });

test("the librarian is asked through the portal: its token, the conversation as it was cut, the stream handed on", async () => {
  managed();
  understory.state.chat = "answer";
  const res = await ask(question);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type")!, /text\/event-stream/);
  assert.equal(await res.text(), sse({ type: "start" }) + sse({ type: "text-delta", id: "t", delta: "Hi" }, "[DONE]"));
  assert.deepEqual(understory.seen.at(-1), { method: "POST", url: "/api/chat", auth: `Bearer ${store.setting("token")}`, body: { messages: [{ id: "q1", role: "user", parts: [{ type: "text", text: "What is deployed?" }] }] } });

  assert.equal((await ask({ messages: [] })).status, 400);
  understory.state.chat = "refuse";
  const refused = await ask(question);
  assert.equal(refused.status, 502);
  assert.match((await refused.json()).error, /no model/);
});

test("the librarian is asked only in the Understory the portal runs, while it runs", async () => {
  understory.state.chat = "answer";
  const before = understory.seen.length;
  // Understory elsewhere: read, not written, and its librarian writes.
  elsewhere("localhost");
  assert.equal((await ask(question)).status, 409);
  managed();
  await service.stop();
  assert.equal((await ask(question)).status, 409, "not while its container is stopped");
  await service.start();
  putServers({});
  assert.equal((await ask(question)).status, 409, "not while it is not the memory");
  assert.equal(understory.seen.length, before, "nothing of that reached Understory");
});

test("only the fixed chat of the configured Understory is reached, and a conversation too long to send says so", async () => {
  managed();
  const before = understory.seen.length;
  // Whatever the page puts into the body, the target is Understory's own, from the server's config.
  const res = await ask({ ...question, url: "http://127.0.0.1:1/x", origin: "http://example.invalid", path: "/api/other", model: "other" });
  assert.equal(res.status, 200);
  await res.text();
  assert.equal(understory.seen.length, before + 1);
  assert.deepEqual(Object.keys(understory.seen.at(-1)!.body), ["messages"]);
  assert.equal(understory.seen.at(-1)!.url, "/api/chat");

  const long = await ask({ messages: Array.from({ length: 201 }, (_, n) => ({ role: n % 2 ? "assistant" : "user", parts: [] })) });
  assert.equal(long.status, 400);
  assert.match((await long.json()).error, /too long.*clear the chat/);
  assert.equal(understory.seen.length, before + 1, "it did not reach Understory");
});

test("Stop does not stop the librarian, so a new question waits until the run has ended", async () => {
  managed();
  understory.state.chat = "hang";
  understory.state.closed = false;
  const stop = new AbortController();
  const res = await ask(question, stop.signal);
  assert.equal(res.status, 200);
  const reader = res.body!.getReader();
  await reader.read();
  stop.abort();
  await reader.read().catch(() => {});
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(understory.state.closed, false, "the portal does not pretend to cut a run Understory goes on with");
  const before = understory.seen.length;
  const busy = await ask(question);
  assert.equal(busy.status, 409);
  assert.match((await busy.json()).error, /still working on the previous question/);
  assert.equal(understory.seen.length, before, "a second librarian is not started on the same memory");
  understory.state.finish!();
  understory.state.chat = "answer";
  for (let n = 0; n < 200; n++) {
    const again = await ask(question);
    if (again.status === 200) return void (await again.text());
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail("the librarian never became free again");
});

test("an answer cut off by Understory failing ends in an error chunk, so the page does not show half a sentence as whole", async () => {
  managed();
  understory.state.chat = "cut";
  const res = await ask(question);
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.ok(text.startsWith(sse({ type: "start" })));
  assert.match(text, /\n\ndata: \{"type":"error","errorText":"Understory stopped answering: [^"]+\."\}\n\n$/);
  understory.state.chat = "answer";
});
