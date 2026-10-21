import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { inProcessHome } from "./server-harness.mjs";

/**
 * A server of pi's mcp.json, as a server half reads and writes it (`portal.mcp`): whether the chats have its tools
 * now, and one written with pi-mcp-adapter made sure of, trusted by the guard only when it says so.
 */
const home = inProcessHome("extension-mcp-");
const agent = process.env.PI_CODING_AGENT_DIR;
// A pi that notes what it was asked, and installs a package as pi does: into its settings. While `held` is there, an
// install waits for it to go, as a real one takes its time.
const bin = path.join(home, "bin");
const asked = path.join(home, "pi-was-asked");
const held = path.join(home, "install-held");
mkdirSync(bin);
writeFileSync(path.join(bin, "pi"), `#!/bin/sh\necho "$@" >> '${asked}'\nif [ "$1" = install ]; then\nwhile [ -e '${held}' ]; do sleep 0.05; done\nprintf '{"packages":["%s"]}' "$2" > "$PI_CODING_AGENT_DIR/settings.json"\nfi\n`);
chmodSync(path.join(bin, "pi"), 0o755);
process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;

const host = await import("../dist/extension-host.js");
const db = await import("../dist/db.js");
// The session manager hands the host its own bridge as it loads, and writing a server loads it: loaded first, so the test's own is the one used.
await import("../dist/session-manager.js");
test.after(() => host.stopServerHalves());

let reloads = 0;
host.setChatBridge({ tell: async () => false, offers: () => undefined, reload: async () => (reloads++, { reloaded: 1, waiting: 0 }), model: async () => undefined });

const dir = path.join(home, "packages", "notes");
mkdirSync(dir, { recursive: true });
const file = path.join(dir, "server.js");
writeFileSync(file, "export default function (portal) { globalThis.portal = portal; }\n");
/** The stand-in started (again): installing a package brings the server halves in line with what pi's settings list, which is not it. */
const start = async () => {
  await host.syncServerHalves([{ name: "notes", version: "1.0.0", file, rev: statSync(file).size.toString(36) }]);
  return globalThis.portal.mcp;
};

const mcpFile = () => path.join(agent, "mcp.json");
const servers = () => JSON.parse(readFileSync(mcpFile(), "utf8")).mcpServers;
const settings = (packages) => writeFileSync(path.join(agent, "settings.json"), JSON.stringify({ packages }));
/** What pi was asked to change: the server halves following a package installed list them as well. */
const piAsked = () => (existsSync(asked) ? readFileSync(asked, "utf8").trim().split("\n").filter((line) => line !== "list") : []);
const NOTES = { url: "http://127.0.0.1:1/mcp", lifecycle: "lazy" };

test("a server written for the portal's user alone, with the adapter installed where it is missing, and trusted only when asked", async () => {
  settings([]);
  let mcp = await start();
  assert.deepEqual(await mcp.set("notes", NOTES), { reloaded: 1, waiting: 0 }, "what the idle chats' reload did");
  assert.deepEqual(piAsked(), ["install npm:pi-mcp-adapter@2.18.0"]);
  assert.equal(statSync(mcpFile()).mode & 0o777, 0o600);
  assert.deepEqual(servers().notes, NOTES);
  assert.equal(db.trustedMcpServers().has("notes"), false, "not trusted unless asked");
  assert.equal(reloads, 1, "the idle chats loaded again");
  // Removing a server leaves the guard's default as it is, while the person has not said which servers are theirs.
  await mcp.set("never", undefined);
  assert.equal(db.getSetting("guard_trusted_mcp_servers"), undefined);

  mcp = await start();
  assert.deepEqual(mcp.get("notes"), { entry: NOTES, on: true });
  await mcp.set("memory", { url: "http://127.0.0.1:2/mcp" }, { trusted: true });
  assert.equal(db.trustedMcpServers().has("memory"), true);
  assert.deepEqual(piAsked(), ["install npm:pi-mcp-adapter@2.18.0"], "installed once");
  // What else is in the file stays.
  assert.deepEqual(Object.keys(servers()).sort(), ["memory", "notes"]);
});

test("its tools are the chats' only through the adapter, switched on, and while the server is not switched off", async () => {
  const mcp = await start();
  settings([{ source: "npm:pi-mcp-adapter@2.18.0", extensions: [], skills: [], prompts: [], themes: [] }]);
  assert.equal(mcp.get("notes").on, false, "the adapter is switched off");
  // Written, the adapter is switched on, not installed again.
  await mcp.set("notes", { ...NOTES, disabled: true });
  assert.equal(JSON.parse(readFileSync(path.join(agent, "settings.json"), "utf8")).packages[0].extensions, undefined, "switched on");
  assert.equal(piAsked().length, 1);
  assert.deepEqual(mcp.get("notes"), { entry: { ...NOTES, disabled: true }, on: false }, "switched off in Settings → MCP");
  await mcp.set("notes", NOTES);
  assert.equal(mcp.get("notes").on, true);
  // What a caller does with what it was told is its own.
  mcp.get("notes").entry.url = "http://elsewhere/mcp";
  assert.equal(mcp.get("notes").entry.url, NOTES.url);
  assert.equal(mcp.get("nothing"), undefined);
});

test("removed, it is gone from the file, from what the chats have and from the servers trusted", async () => {
  const mcp = await start();
  await mcp.set("notes", undefined);
  assert.equal(servers().notes, undefined);
  assert.equal(mcp.get("notes"), undefined);
  assert.ok(servers().memory, "the others stay");
  // Trusted with its entry, and no longer once it is gone: the next server of that name has to be trusted anew.
  await mcp.set("memory", undefined, { trusted: true });
  assert.equal(servers().memory, undefined);
  assert.equal(db.trustedMcpServers().has("memory"), false);
});

test("a name or a server the adapter would not take is refused, and so is a file that cannot be read", async () => {
  const mcp = await start();
  await assert.rejects(mcp.set("two words", NOTES), /letters, digits, dot, dash or underscore/);
  await assert.rejects(mcp.set("notes", { lifecycle: "lazy" }), /Needs a command, a url or a socket path/);
  await assert.rejects(mcp.set("notes", { url: "http://a/mcp", command: "run" }), /Only one of command, url or socket/);
  const before = readFileSync(mcpFile(), "utf8");
  writeFileSync(mcpFile(), "{ not json");
  assert.equal(mcp.get("memory"), undefined, "nothing can be said of it");
  await assert.rejects(mcp.set("notes", NOTES), /Fix mcp.json first/);
  assert.equal(readFileSync(mcpFile(), "utf8"), "{ not json", "left for the person to fix");
  writeFileSync(mcpFile(), before);
});

test("what is written to the file while the adapter is being installed stays", async () => {
  const mcp = await start();
  settings([]);
  writeFileSync(held, "");
  const pending = mcp.set("late", NOTES);
  // The second install has begun, and waits.
  while (piAsked().filter((line) => line.startsWith("install")).length < 2) await new Promise((resolve) => setTimeout(resolve, 20));
  // Meanwhile the person saves a server of their own in Settings → MCP.
  const github = { url: "https://api.example.com/mcp", headers: { authorization: "Bearer theirs" } };
  writeFileSync(mcpFile(), JSON.stringify({ mcpServers: { ...servers(), github } }));
  rmSync(held);
  await pending;
  assert.deepEqual(servers().github, github);
  assert.deepEqual(servers().late, NOTES);
});
