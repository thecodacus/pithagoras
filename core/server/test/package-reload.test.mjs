import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { inProcessHome } from "./server-harness.mjs";

/**
 * Installing, removing and updating packages, and a change of pi's settings by hand, reload the open chats: what a
 * package's server half adds to a chat's pi is there without /reload, and gone with it. With pi's own CLI, which
 * installs a folder by reference: installing the same folder again is how a package written there is reloaded, every
 * file of its halves as it is now, without a restart.
 */
const home = inProcessHome("pithagoras-package-reload-");
mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, "settings.json"), "{}");
// The `pi` the portal runs is the one it ships with.
process.env.PATH = `${fileURLToPath(new URL("../../../node_modules/.bin", import.meta.url))}${path.delimiter}${process.env.PATH}`;

// A package with a server half that gives every chat's pi a tool, and counts the loads that ask it for one.
const pkg = mkdtempSync(path.join(home, "stand-in-"));
writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "stand-in", version: "1.0.0", type: "module", keywords: ["pi-package"], pi: {}, pithagoras: { server: "./server.js" } }));
writeFileSync(path.join(pkg, "server.js"), `export default function (portal) {
  portal.chats.extend((pi) => {
    globalThis.standInLoads = (globalThis.standInLoads ?? 0) + 1;
    pi.registerTool({ name: "stand_in", label: "stand_in", description: "A stand-in.", parameters: { type: "object", properties: {} },
      async execute() { return { content: [{ type: "text", text: "done" }], details: {} }; } });
  });
}
`);

const { default: express } = await import("express");
const { packagesRouter } = await import("../dist/api/packages.js");
const { extensionsRouter } = await import("../dist/api/extensions.js");
const { createSession } = await import("../dist/db.js");
const { sessions } = await import("../dist/session-manager.js");
const { extensionRoutes, isServing, stopServerHalves } = await import("../dist/extension-host.js");
const app = express();
app.use(express.json());
app.use("/api", packagesRouter());
app.use("/api", extensionsRouter());
app.use("/api/x", extensionRoutes);
const listener = app.listen(0, "127.0.0.1");
await new Promise((resolve) => listener.once("listening", resolve));
const base = `http://127.0.0.1:${listener.address().port}/api`;
test.after(async () => {
  listener.close();
  await stopServerHalves();
});

const send = async (url, method, body) => {
  const res = await fetch(base + url, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = await res.json();
  assert.equal(res.status, 200, JSON.stringify(json));
  return json;
};

test("the package routes reload the open chats", async () => {
  const work = mkdtempSync(path.join(process.env.WORKSPACE_ROOT, "chat-"));
  createSession({ id: "open", title: "open", workspace: work, executor: "host" });
  const client = await sessions.ensureClient("open");
  const has = async () => (await client.getTools()).some((tool) => tool.name === "stand_in");
  assert.equal(await has(), false);

  assert.deepEqual((({ reloaded, waiting }) => ({ reloaded, waiting }))(await send("/packages", "POST", { spec: pkg })), { reloaded: 1, waiting: 0 });
  assert.equal(await has(), true, "installed: the chat has its tool");
  assert.equal(globalThis.standInLoads, 1);

  await send("/packages", "POST", { spec: pkg });
  assert.equal(globalThis.standInLoads, 2, "installed again: loaded again");

  await send("/packages/update", "POST");
  assert.equal(globalThis.standInLoads, 3, "updated");

  await send("/pi-settings", "PUT", { content: JSON.stringify({ packages: [] }) });
  assert.equal(await has(), false, "taken out of the settings by hand");
  await send("/pi-settings", "PUT", { content: JSON.stringify({ packages: [pkg] }) });
  assert.equal(await has(), true, "and put back");

  await send("/packages", "DELETE", { spec: pkg });
  assert.equal(await has(), false, "removed");
});

test("a folder installed again runs every file of its halves as they are now, without a restart, and removed, its routes are gone", async () => {
  const dir = mkdtempSync(path.join(home, "in-place-"));
  const write = (file, text) => {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), text);
  };
  write("package.json", JSON.stringify({ name: "in-place", version: "1.0.0", type: "module", keywords: ["pi-package"], pi: {}, pithagoras: { server: "./server.js", client: "./web/client.js" } }));
  // Its module answers with what it says itself, and with what a file it imports says and holds; each revision stopped
  // is counted.
  const server = (said) => `import { said as lib, marks } from "./lib.js";
export default function (portal) {
  portal.router.get("/said", (req, res) => res.json({ server: ${JSON.stringify(said)}, lib, marks }));
  return () => { globalThis.inPlaceStops = (globalThis.inPlaceStops ?? 0) + 1; };
}
`;
  const lib = (said) => `export const said = ${JSON.stringify(said)};\nexport const marks = [];\n`;
  write("server.js", server("first"));
  write("lib.js", lib("first"));
  write("web/client.js", 'import { part } from "./part.js";\nexport default function () { return part; }\n');
  write("web/part.js", 'export const part = "first";\n');
  const said = async () => {
    const res = await fetch(`${base}/x/in-place/said`);
    return res.status === 200 ? await res.json() : res.status;
  };
  const listed = async () => (await (await fetch(`${base}/extension-ui`)).json()).extensions.find((e) => e.name === "in-place");

  await send("/packages", "POST", { spec: dir });
  // The first revision the portal starts imports its files as anything else in the process does: one lib.js.
  const plain = await import(pathToFileURL(path.join(dir, "lib.js")).href);
  plain.marks.push("the test's");
  assert.deepEqual(await said(), { server: "first", lib: "first", marks: ["the test's"] });
  const first = await listed();

  // Only the file its module imports changed: that is what answers now, a lib.js of its revision's own, and what
  // imported lib.js itself keeps the first one.
  write("lib.js", lib("second, and longer"));
  await send("/packages", "POST", { spec: dir });
  assert.deepEqual(await said(), { server: "first", lib: "second, and longer", marks: [] });
  assert.equal(plain.said, "first");
  assert.equal(globalThis.inPlaceStops, 1, "the revision before was stopped");
  assert.equal((await listed()).rev, first.rev, "a file outside the web folder is not the browser half's");

  // Its module changed.
  write("server.js", server("third, the longest"));
  await send("/packages", "POST", { spec: dir });
  assert.deepEqual(await said(), { server: "third, the longest", lib: "second, and longer", marks: [] });

  // A file the browser half's module imports changed: another revision of it, under which a page fetches that file as
  // it is now. The web folder is in the server half's folder here, so that half is started again too.
  write("web/part.js", 'export const part = "fourth, and longer";\n');
  await send("/packages", "POST", { spec: dir });
  const changed = await listed();
  assert.notEqual(changed.rev, first.rev);
  assert.equal(await (await fetch(new URL("./part.js", new URL(changed.entry, base)))).text(), 'export const part = "fourth, and longer";\n');
  assert.equal(globalThis.inPlaceStops, 3);

  await send("/packages", "DELETE", { spec: dir });
  assert.equal(await said(), 404, "removed: its routes are gone");
  assert.equal(isServing("in-place"), false);
  assert.equal(globalThis.inPlaceStops, 4, "and it was stopped");
});
