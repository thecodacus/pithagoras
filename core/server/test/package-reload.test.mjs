import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inProcessHome } from "./server-harness.mjs";

/**
 * Installing, removing and updating packages, and a change of pi's settings by hand, reload the open chats: what a
 * package's server half adds to a chat's pi is there without /reload, and gone with it. With pi's own CLI, which
 * installs a folder by reference: installing the same folder again is how a package written there is reloaded.
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
const { createSession } = await import("../dist/db.js");
const { sessions } = await import("../dist/session-manager.js");
const { stopServerHalves } = await import("../dist/extension-host.js");
const app = express();
app.use(express.json());
app.use("/api", packagesRouter());
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
