import assert from "node:assert/strict";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { inProcessHome } from "./server-harness.mjs";

/**
 * A server of pi's mcp.json, as a server half reads and writes it (`portal.mcp`): whether the chats have its tools now,
 * and one written as pi accepts it, trusted by the guard only when it says so, and its tools in the model's list only when
 * it says so.
 */
const home = inProcessHome("extension-mcp-");
const agent = process.env.PI_CODING_AGENT_DIR;

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
/** The stand-in started (again). */
const start = async () => {
  await host.syncServerHalves([{ name: "notes", version: "1.0.0", file, rev: statSync(file).size.toString(36) }]);
  return globalThis.portal.mcp;
};

const mcpFile = () => path.join(agent, "mcp.json");
const servers = () => JSON.parse(readFileSync(mcpFile(), "utf8")).mcpServers;
const NOTES = { url: "http://127.0.0.1:1/mcp", headers: { Authorization: "Bearer ${NOTES_TOKEN}" } };

test("a server written for the portal's user alone, in pi's shape, and trusted only when asked", async () => {
  let mcp = await start();
  assert.deepEqual(await mcp.set("notes", NOTES), { reloaded: 1, waiting: 0 }, "what the idle chats' reload did");
  assert.equal(statSync(mcpFile()).mode & 0o777, 0o600);
  assert.deepEqual(servers().notes, NOTES);
  assert.equal(db.trustedMcpServers().has("notes"), false, "not trusted unless asked");
  assert.equal(reloads, 1, "the idle chats loaded again, once: by the extension's own say, not by the file's writer as well");
  // Removing a server leaves the guard's default as it is, while the person has not said which servers are theirs.
  await mcp.set("never", undefined);
  assert.equal(db.getSetting("guard_trusted_mcp_servers"), undefined);

  mcp = await start();
  assert.deepEqual(mcp.get("notes"), { entry: NOTES, on: true });
  await mcp.set("memory", { url: "http://127.0.0.1:2/mcp" }, { trusted: true });
  assert.equal(db.trustedMcpServers().has("memory"), true);
  // What else is in the file stays.
  assert.deepEqual(Object.keys(servers()).sort(), ["memory", "notes"]);
});

test("a server is in the model's list from the start only when it says so (direct), and the person's own mark stays", async () => {
  const mcp = await start();
  await mcp.set("recall", { url: "http://127.0.0.1:3/mcp" }, { direct: true });
  assert.equal(db.toolMarks().recall, "direct");
  // Set to lazy by the person, it is theirs: written again, it stays.
  db.setToolMarks({ ...db.toolMarks(), recall: "lazy" });
  await mcp.set("recall", { url: "http://127.0.0.1:3/mcp" }, { direct: true });
  assert.equal(db.toolMarks().recall, "lazy");
  // Without the say, no mark.
  await mcp.set("plain", { url: "http://127.0.0.1:4/mcp" });
  assert.equal(db.toolMarks().plain, undefined);
  // Gone, its mark goes with it: a server given that name later is not marked unasked.
  await mcp.set("recall", undefined);
  assert.equal(db.toolMarks().recall, undefined);
});

test("its tools are the chats' while the server is in the file and not switched off (enabled: false) or hidden", async () => {
  const mcp = await start();
  assert.deepEqual(mcp.get("notes"), { entry: NOTES, on: true });
  await mcp.set("notes", { ...NOTES, enabled: false });
  assert.deepEqual(mcp.get("notes"), { entry: { ...NOTES, enabled: false }, on: false }, "switched off in Settings → MCP");
  await mcp.set("notes", { ...NOTES, exposure: "hidden" });
  assert.equal(mcp.get("notes").on, false, "hidden");
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

test("a name or an entry pi would not take is refused, and so is a file that cannot be read", async () => {
  const mcp = await start();
  await assert.rejects(mcp.set("two words", NOTES), /letters, digits, underscore or dash/);
  await assert.rejects(mcp.set("dotted.name", NOTES), /letters, digits, underscore or dash/);
  await assert.rejects(mcp.set("notes", { lifecycle: "lazy" }), /needs either "command" \(stdio\) or "url"/);
  await assert.rejects(mcp.set("notes", { socket: "/run/mcp.sock" }), /pi does not read socket/);
  await assert.rejects(mcp.set("notes", { url: "http://a/mcp", enabled: "yes" }), /enabled must be a boolean/);
  await mcp.set("kept", { command: "run" });
  const before = readFileSync(mcpFile(), "utf8");
  writeFileSync(mcpFile(), "{ not json");
  assert.equal(mcp.get("kept"), undefined, "nothing can be said of it");
  await assert.rejects(mcp.set("notes", NOTES), /Fix mcp.json first/);
  assert.equal(readFileSync(mcpFile(), "utf8"), "{ not json", "left for the person to fix");
  writeFileSync(mcpFile(), before);
});
