import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { inProcessHome } from "../../../core/server/test/server-harness.mjs";

/**
 * The hook as the portal wires it: Files' own built server half as the provider, and another extension's half that names it in
 * `pithagoras.requires` and registers a source with `portal.extensions.use("pithagoras-files")`, both loaded by the portal's extension host
 * and reached by the portal's own route mount (/api/x/<package>).
 */
const home = inProcessHome("pithagoras-files-provide-");
const host = await import("../../../core/server/dist/extension-host.js");
const { createSession } = await import("../../../core/server/dist/db.js");
const { default: express } = await import("express");
test.after(() => host.stopServerHalves());

const work = path.join(home, "work");
mkdirSync(work);
createSession({ id: "chat1", title: "chat", workspace: work, executor: "host" });

let revs = 0;
const consumer = (name: string, body: string) => {
  const dir = path.join(home, "packages", name);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `server-${++revs}.js`);
  writeFileSync(file, `export default async function (portal) {\n${body}\n}\n`);
  return { name, version: "1.0.0", file, rev: `c${revs}`, requires: { "pithagoras-files": "*" } };
};
const filesHalf = { name: "pithagoras-files", version: "0.1.0", file: path.resolve(import.meta.dirname, "../server.js"), rev: "files1" };

const REGISTER = `
const hook = portal.extensions.use("pithagoras-files");
hook.sources.register({
  id: "cloud",
  label: "Cloud",
  visible: (who) => who.owner === undefined || who.owner.kind === "agent",
  list: (at, who) => [{ name: "hello.txt", type: "file", size: 5, mtime: 3 }, { name: "seen-by", type: "dir" }],
  read: (at, who) => ({ content: "hello:" + at + ":" + who.chatId + ":" + (who.person ? who.person.role : "nobody"), mtime: 3 }),
});
return () => hook.sources.unregister("cloud");
`;

async function withPortal(fn: (base: string) => Promise<void>) {
  const app = express();
  app.use("/api/x", host.extensionRoutes);
  const server = app.listen(0);
  try {
    await fn(`http://127.0.0.1:${(server.address() as { port: number }).port}/api/x/pithagoras-files/chats/chat1`);
  } finally {
    server.close();
  }
}

test("an extension that requires Files registers a source, and it is served for a chat, with the chat it is asked for and not the chat's folder", async () => {
  await host.syncServerHalves([consumer("pithagoras-cloud", REGISTER), filesHalf]);
  assert.equal(host.isServing("pithagoras-files"), true, host.serverFailure("pithagoras-files"));
  assert.equal(host.isServing("pithagoras-cloud"), true, host.serverFailure("pithagoras-cloud"));
  await withPortal(async (base) => {
    assert.deepEqual(await fetch(`${base}/sources`).then((r) => r.json()), { sources: [{ id: "cloud", label: "Cloud", writable: false }] });
    const listed = (await fetch(`${base}/sources/cloud/files?path=`).then((r) => r.json())) as { entries: { name: string }[] };
    assert.deepEqual(listed.entries.map((e) => e.name), ["seen-by", "hello.txt"]);
    const read = (await fetch(`${base}/sources/cloud/file?path=a/b.txt`).then((r) => r.json())) as { content: string };
    assert.equal(read.content, "hello:a/b.txt:chat1:nobody");
    // The chat's folder is its own tree: no hello.txt there.
    const folder = (await fetch(`${base}/files?path=`).then((r) => r.json())) as { entries: unknown[] };
    assert.deepEqual(folder.entries, []);
    assert.equal((await fetch(`${base.replace("chat1", "nochat")}/sources`)).status, 404);
  });
});

test("when the extension that registered it stops, its source is gone with it", async () => {
  await host.syncServerHalves([filesHalf]);
  await withPortal(async (base) => {
    assert.deepEqual(await fetch(`${base}/sources`).then((r) => r.json()), { sources: [] });
  });
});

test("when Files is started anew, the extension that builds on it is too, and registers again", async () => {
  await host.syncServerHalves([consumer("pithagoras-cloud", REGISTER), filesHalf]);
  await host.syncServerHalves([consumer("pithagoras-cloud", REGISTER), { ...filesHalf, rev: "files2" }]);
  await withPortal(async (base) => {
    assert.deepEqual(((await fetch(`${base}/sources`).then((r) => r.json())) as { sources: { id: string }[] }).sources.map((s) => s.id), ["cloud"]);
  });
});
