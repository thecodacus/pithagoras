import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express from "express";
import { routes } from "../src/server.ts";
import files from "../src/server.ts";
import { SourceRegistry, type FilesSource, type SourceContext } from "../src/sources.ts";

/**
 * Files' sources (src/sources.ts, and their routes in src/server.ts): what an extension registers through `portal.provide`, and what the
 * page is told of it. The chat's folder is a stand-in that records what is asked of it, to show that a source's paths never reach it and
 * the other way round.
 */

const WORKSPACE = "/work/chat-folder";
const person = { id: "owner", name: "Owner", role: "primary" as const };

/** A source with a few files in its own tree; `more` overrides or adds members. */
function source(more: Partial<FilesSource> = {}, seen: { calls: string[]; contexts: SourceContext[] } = { calls: [], contexts: [] }): FilesSource {
  const tree: Record<string, { name: string; type: "file" | "dir"; size?: number; mtime?: number }[]> = {
    "": [
      { name: "b.txt", type: "file", size: 5, mtime: 7 },
      { name: "Docs", type: "dir" },
      { name: "a dir", type: "dir" },
    ],
    Docs: [{ name: "readme.md", type: "file", size: 3, mtime: 9 }],
  };
  return {
    id: "cloud",
    label: "Cloud",
    list: (path, context) => {
      seen.calls.push(`list ${path}`);
      seen.contexts.push(context);
      return tree[path] ?? [];
    },
    read: (path, context) => {
      seen.calls.push(`read ${path}`);
      seen.contexts.push(context);
      if (path === "Docs/readme.md") return { content: "# Hi\n", mtime: 9 };
      if (path === "pic.bin") return { bytes: new Uint8Array([1, 2, 3, 4]), mtime: 11 };
      if (path === "big.txt") return { content: "x".repeat(1024 * 1024 + 1), mtime: 12 };
      throw Object.assign(new Error("There is no such file"), { code: "missing" });
    },
    ...more,
  };
}

/** The routes with a registry, the chat folder's stand-in, and a short timeout. */
async function withApi(fn: (base: string, h: { registry: SourceRegistry; workspace: string[] }) => Promise<void>, timeoutMs = 150) {
  const registry = new SourceRegistry(100);
  const workspace: string[] = [];
  const stand = new Proxy({} as never, {
    get: (_t, name) => (...args: unknown[]) => {
      workspace.push(`${String(name)} ${JSON.stringify(args.slice(1, 2))}`);
      if (name === "list") return { path: String(args[1] ?? ""), entries: [], truncated: false };
      throw new Error("not under test");
    },
  });
  const app = express();
  const router = express.Router();
  routes(
    router,
    express.json({ limit: "3mb" }),
    stand,
    (id) => {
      if (id !== "chat") throw new Error("No such chat");
      return WORKSPACE;
    },
    { registry, who: (_req, chatId) => ({ chatId, owner: { name: "One", kind: "agent" }, person }), timeoutMs },
  );
  app.use("/api/x/pithagoras-files", router);
  const server = createServer(app).listen(0);
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/x/pithagoras-files/chats/chat`;
  try {
    await fn(base, { registry, workspace });
  } finally {
    server.closeAllConnections();
    server.close();
  }
}
const answer = async (r: Response) => ({ status: r.status, ...((await r.json()) as Record<string, unknown>) });
const get = (url: string) => fetch(url).then(answer);
const put = (url: string, body: unknown) => fetch(url, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then(answer);
const q = (p: string, more = "") => `?path=${encodeURIComponent(p)}${more}`;

test("a source is validated as it is registered, and each extension has its own", () => {
  const registry = new SourceRegistry();
  const a = registry.forConsumer("ext-a");
  assert.throws(() => a.sources.register(undefined as never), TypeError);
  assert.throws(() => a.sources.register(source({ id: "" })), /id/);
  assert.throws(() => a.sources.register(source({ id: "has space" })), /id/);
  assert.throws(() => a.sources.register(source({ id: "../up" })), /id/);
  assert.throws(() => a.sources.register(source({ label: " " })), /label/);
  assert.throws(() => a.sources.register(source({ list: undefined as never })), /list/);
  assert.throws(() => a.sources.register(source({ read: "no" as never })), /read/);
  assert.throws(() => a.sources.register(source({ write: 5 as never })), /write/);
  a.sources.register(source());
  // Its own again replaces; another extension's id is refused, and its removal does nothing.
  a.sources.register(source({ label: "Cloud 2" }));
  const b = registry.forConsumer("ext-b");
  assert.throws(() => b.sources.register(source()), /Another extension/);
  b.sources.unregister("cloud");
  b.sources.register(source({ id: "other" }));
  a.sources.unregister("cloud");
  return registry.list({ chatId: "c" }).then((all) => assert.deepEqual(all.map((s) => s.id), ["other"]));
});

test("an extension that is started anew starts from no sources", async () => {
  const registry = new SourceRegistry();
  registry.forConsumer("ext-a").sources.register(source());
  registry.forConsumer("ext-b").sources.register(source({ id: "keep" }));
  assert.deepEqual((await registry.list({ chatId: "c" })).map((s) => s.id), ["cloud", "keep"]);
  // Its factory is called again by the portal when it restarts.
  registry.forConsumer("ext-a");
  assert.deepEqual((await registry.list({ chatId: "c" })).map((s) => s.id), ["keep"]);
});

test("Files gives the hook through portal.provide, as the extension named in requires uses it", async () => {
  let factory: ((consumer: { name: string }) => unknown) | undefined;
  const router = express.Router();
  files({
    router,
    http: { json: () => express.json(), person: () => person },
    files: {},
    chats: { folder: () => WORKSPACE, owner: () => undefined },
    provide: (f: typeof factory) => (factory = f),
  } as never);
  assert.ok(factory);
  const mine = factory!({ name: "pithagoras-nextcloud" }) as { sources: { register(s: FilesSource): void } };
  mine.sources.register(source());
  // The same registry serves the routes of the same router.
  const app = express().use("/api/x/pithagoras-files", router);
  const server = createServer(app).listen(0);
  try {
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/x/pithagoras-files/chats/chat`;
    assert.deepEqual(await get(`${base}/sources`), { status: 200, sources: [{ id: "cloud", label: "Cloud", writable: false }] });
  } finally {
    server.close();
  }
});

test("a source is told whose chat it is, but not where the owner's folder is on this machine", async () => {
  let factory: ((consumer: { name: string }) => unknown) | undefined;
  const router = express.Router();
  files({
    router,
    http: { json: () => express.json(), person: () => person },
    files: {},
    chats: { folder: () => WORKSPACE, owner: () => ({ path: "/srv/agents/one", name: "One", kind: "agent", home: true }) },
    provide: (f: typeof factory) => (factory = f),
  } as never);
  const given: SourceContext[] = [];
  const mine = factory!({ name: "pithagoras-nextcloud" }) as { sources: { register(s: FilesSource): void } };
  mine.sources.register(source({ visible: (c) => (given.push(c), true), list: (_p, c) => (given.push(c), []) }));
  const server = createServer(express().use("/api/x/pithagoras-files", router)).listen(0);
  try {
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/x/pithagoras-files/chats/chat`;
    await get(`${base}/sources`);
    await get(`${base}/sources/cloud/files${q("")}`);
    assert.equal(given.length, 3);
    for (const c of given) {
      assert.deepEqual(c.owner, { name: "One", kind: "agent", home: true });
      assert.ok(!JSON.stringify(c).includes("/srv/agents"), "the owner's folder reached the source");
    }
  } finally {
    server.close();
  }
});

test("the page is told which sources there are, and which can be written", async () => {
  await withApi(async (base, { registry }) => {
    assert.deepEqual(await get(`${base}/sources`), { status: 200, sources: [] });
    const mine = registry.forConsumer("ext");
    mine.sources.register(source());
    mine.sources.register(source({ id: "writable", label: "Notes", write: () => {} }));
    assert.deepEqual(await get(`${base}/sources`), {
      status: 200,
      sources: [
        { id: "cloud", label: "Cloud", writable: false },
        { id: "writable", label: "Notes", writable: true },
      ],
    });
  });
});

test("who may see a source follows the chat's owner: it is asked with the chat, its owner and the person, and one that says no is not there", async () => {
  await withApi(async (base, { registry }) => {
    const asked: SourceContext[] = [];
    const mine = registry.forConsumer("ext");
    mine.sources.register(source({ id: "mine", visible: (c) => (asked.push(c), c.owner?.name === "One") }));
    mine.sources.register(source({ id: "other", visible: (c) => c.owner?.name === "Two" }));
    mine.sources.register(source({ id: "broken", visible: () => Promise.reject(new Error("no")) }));
    mine.sources.register(source({ id: "slow", visible: () => new Promise<boolean>(() => {}) }));
    assert.deepEqual(((await get(`${base}/sources`)).sources as { id: string }[]).map((s) => s.id), ["mine"]);
    assert.deepEqual(asked[0], { chatId: "chat", owner: { name: "One", kind: "agent" }, person });
    // Not seen, so not reachable by its address either.
    for (const id of ["other", "broken", "slow", "nobody"]) assert.deepEqual(await get(`${base}/sources/${id}/files${q("")}`), { status: 404, error: "There is no such source", code: "missing" });
    assert.equal((await get(`${base}/sources/mine/files${q("")}`)).status, 200);
  });
});

test("a chat that is gone has no sources", async () => {
  await withApi(async (base, { registry }) => {
    registry.forConsumer("ext").sources.register(source());
    const gone = base.replace("/chats/chat", "/chats/gone");
    assert.equal((await get(`${gone}/sources`)).status, 404);
    assert.equal((await get(`${gone}/sources/cloud/files${q("")}`)).status, 404);
  });
});

test("a source's folder is listed in its own paths: folders first, bad entries left out, and the chat's folder is neither read nor given", async () => {
  await withApi(async (base, { registry, workspace }) => {
    const seen = { calls: [] as string[], contexts: [] as SourceContext[] };
    registry.forConsumer("ext").sources.register(
      source(
        {
          list: (path, context) => {
            seen.calls.push(`list ${path}`);
            seen.contexts.push(context);
            return [
              { name: "z.txt", type: "file", size: 4, mtime: 2 },
              { name: "sub", type: "dir" },
              { name: "a/b", type: "file" },
              { name: "", type: "file" },
              { name: "link", type: "link" as never },
              { name: "n\0ul", type: "file" },
              { name: "a.txt", type: "file", size: Number.NaN },
              { name: "..", type: "dir" },
              { name: ".", type: "dir" },
              { name: "a\\b", type: "file" },
            ];
          },
        },
        seen,
      ),
    );
    const listed = await get(`${base}/sources/cloud/files${q("Docs/sub dir/x")}`);
    assert.equal(listed.status, 200);
    // The path is the source's own, passed on as it came: nothing resolves it, against the chat's folder or otherwise.
    assert.deepEqual(seen.calls, ["list Docs/sub dir/x"]);
    assert.deepEqual(listed.entries, [
      { name: "sub", type: "dir", size: 0, mtime: 0 },
      { name: "a.txt", type: "file", size: 0, mtime: 0 },
      { name: "z.txt", type: "file", size: 4, mtime: 2 },
    ]);
    assert.equal(listed.truncated, false);
    // The chat's folder reached neither way.
    assert.deepEqual(workspace, []);
    assert.ok(!JSON.stringify(seen.contexts).includes(WORKSPACE));
    await get(`${base}/files${q("Docs")}`);
    assert.deepEqual(workspace, ['list ["Docs"]']);
    assert.deepEqual(seen.calls, ["list Docs/sub dir/x"]);
    // A path with a NUL, or a list that is not one, is not passed on.
    assert.equal((await get(`${base}/sources/cloud/files${q("a\0b")}`)).status, 400);
  });
});

test("a way out in a path never reaches a source: the page builds paths from names it was listed, so none has one", async () => {
  await withApi(async (base, { registry }) => {
    const seen = { calls: [] as string[], contexts: [] as SourceContext[] };
    registry.forConsumer("ext").sources.register(source({ write: () => {} }, seen));
    for (const bad of ["..", "../x", "Docs/../x", "Docs/..", "/etc/x", "/", "a\\b", "a//b", "a/./b", ".", "Docs/", "a\0b"]) {
      for (const route of ["files", "file"]) assert.deepEqual(await get(`${base}/sources/cloud/${route}${q(bad)}`), { status: 400, error: "That is not a path", code: "invalid" }, `${route} ${JSON.stringify(bad)}`);
      assert.equal((await put(`${base}/sources/cloud/file${q(bad)}`, { content: "x" })).status, 400, `put ${JSON.stringify(bad)}`);
      assert.equal((await fetch(`${base}/sources/cloud/file${q(bad, "&download=1")}`, { redirect: "manual" })).status, 400, `download ${JSON.stringify(bad)}`);
    }
    assert.deepEqual(seen.calls, []);
    // Names with dots in them, and the root, are paths.
    assert.equal((await get(`${base}/sources/cloud/files${q("")}`)).status, 200);
    assert.equal((await get(`${base}/sources/cloud/files${q("Docs/.hidden/..x")}`)).status, 200);
    assert.deepEqual(seen.calls, ["list ", "list Docs/.hidden/..x"]);
  });
});

test("a file is read as the file view reads one: text, bytes as a file that has none to show, one over 1 MB, and always in full", async () => {
  await withApi(async (base, { registry }) => {
    registry.forConsumer("ext").sources.register(source());
    assert.deepEqual(await get(`${base}/sources/cloud/file${q("Docs/readme.md")}`), { status: 200, binary: false, size: 5, mtime: 9, content: "# Hi\n" });
    assert.deepEqual(await get(`${base}/sources/cloud/file${q("pic.bin")}`), { status: 200, binary: true, size: 4, mtime: 11 });
    assert.deepEqual(await get(`${base}/sources/cloud/file${q("big.txt")}`), { status: 200, binary: true, size: 1024 * 1024 + 1, mtime: 12 });
    // A look at whether it changed is the chat folder's: a source's file is sent whole (the page does not watch one).
    assert.equal((await get(`${base}/sources/cloud/file${q("Docs/readme.md", "&since=9&size=5")}`)).content, "# Hi\n");
    // A refusal with a code keeps its status.
    assert.deepEqual(await get(`${base}/sources/cloud/file${q("nope")}`), { status: 404, error: "There is no such file", code: "missing" });
  });
});

test("a download is a redirect to the source's own link, or the file as an attachment; a link that is not web is refused", async () => {
  await withApi(async (base, { registry }) => {
    const mine = registry.forConsumer("ext");
    mine.sources.register(source({ id: "linked", url: (p) => `https://cloud.example/f?p=${encodeURIComponent(p)}` }));
    mine.sources.register(source({ id: "evil", url: () => "javascript:alert(1)" }));
    mine.sources.register(source());
    const redirect = await fetch(`${base}/sources/linked/file${q("Docs/readme.md", "&download=1")}`, { redirect: "manual" });
    assert.equal(redirect.status, 302);
    assert.equal(redirect.headers.get("location"), "https://cloud.example/f?p=Docs%2Freadme.md");
    assert.equal((await get(`${base}/sources/evil/file${q("x", "&download=1")}`)).status, 502);
    const plain = await fetch(`${base}/sources/cloud/file${q("Docs/readme.md", "&download=1")}`);
    assert.equal(plain.status, 200);
    assert.match(plain.headers.get("content-disposition") ?? "", /attachment; filename="readme\.md"/);
    assert.equal(await plain.text(), "# Hi\n");
    const bytes = await fetch(`${base}/sources/cloud/file${q("pic.bin", "&download=1")}`);
    assert.deepEqual([...new Uint8Array(await bytes.arrayBuffer())], [1, 2, 3, 4]);
  });
});

test("a source without write is read-only, one with it saves, and says conflict when the file changed", async () => {
  await withApi(async (base, { registry }) => {
    const written: unknown[] = [];
    const mine = registry.forConsumer("ext");
    mine.sources.register(source());
    mine.sources.register(
      source({
        id: "rw",
        write: (path, content, context) => {
          written.push([path, content, context.expected, context.chatId]);
          if (content === "stale") throw Object.assign(new Error("It changed"), { code: "conflict" });
          return { mtime: 20 };
        },
      }),
    );
    assert.deepEqual(await put(`${base}/sources/cloud/file${q("Docs/readme.md")}`, { content: "x" }), { status: 405, error: "This source is read-only", code: "read-only" });
    assert.deepEqual(await put(`${base}/sources/rw/file${q("Docs/readme.md")}`, { content: "new", mtime: 9 }), { status: 200, ok: true, size: 3, mtime: 20 });
    assert.deepEqual(written, [["Docs/readme.md", "new", 9, "chat"]]);
    assert.deepEqual(await put(`${base}/sources/rw/file${q("Docs/readme.md")}`, { content: "stale", mtime: 9 }), { status: 409, error: "It changed", code: "conflict" });
    assert.equal((await put(`${base}/sources/rw/file${q("x")}`, { content: 5 })).status, 400);
    assert.equal((await put(`${base}/sources/rw/file${q("x")}`, { content: "x".repeat(1024 * 1024 + 1) })).status, 413);
  });
});

test("a source that fails or never answers is told as its own failure, and the chat's folder is answered meanwhile", async () => {
  await withApi(async (base, { registry, workspace }) => {
    const mine = registry.forConsumer("ext");
    mine.sources.register(source({ id: "down", label: "Cloud", list: () => Promise.reject(new Error("connection refused")) }));
    mine.sources.register(source({ id: "stuck", label: "Slow cloud", list: () => new Promise(() => {}) }));
    mine.sources.register(source({ id: "bad", list: () => { throw "just a string"; } }));
    const down = await get(`${base}/sources/down/files${q("")}`);
    assert.deepEqual(down, { status: 502, error: "Cloud: connection refused", code: "source" });
    assert.equal((await get(`${base}/sources/bad/files${q("")}`)).status, 502);
    // The stuck one is still waiting when the chat's folder is asked: it answers at once, and the source's answer comes by its timeout.
    const stuck = get(`${base}/sources/stuck/files${q("")}`);
    const started = Date.now();
    assert.equal((await get(`${base}/files${q("")}`)).status, 200);
    assert.ok(Date.now() - started < 100, "the chat's folder waited for the source");
    assert.deepEqual(await stuck, { status: 504, error: "Slow cloud did not answer in time", code: "timeout" });
    assert.deepEqual(workspace, ['list [""]']);
  });
});
