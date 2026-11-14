import assert from "node:assert/strict";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { inProcessHome } from "./server-harness.mjs";

/**
 * A server of pi's mcp.json, as a server half reads and writes it (`portal.mcp`): whether the chats have its tools now, its
 * entry in pi's own keys (the old adapter's still translated for this release), trusted by the guard only when it says so, and
 * the tools that are to be confirmed each time.
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
const NOTES = { url: "http://127.0.0.1:1/mcp" };
const audit = () => db.listAudit(20).filter((row) => row.kind === "mcp-command");

test("a server written for the portal's user alone, pi's own exposure on it where none is said, and trusted only when asked", async () => {
  let mcp = await start();
  assert.deepEqual(await mcp.set("notes", NOTES), { reloaded: 1, waiting: 0 }, "what the idle chats' reload did");
  assert.equal(statSync(mcpFile()).mode & 0o777, 0o600);
  // pi alone (its command line, a container's pi) reaches the tools through its own tool search: `deferred`, said in the file.
  assert.deepEqual(servers().notes, { ...NOTES, exposure: "deferred" });
  assert.equal(db.trustedMcpServers().has("notes"), false, "not trusted unless asked");
  assert.equal(reloads, 1, "the idle chats loaded again");
  // Removing a server leaves the guard's default as it is, while the person has not said which servers are theirs.
  await mcp.set("never", undefined);
  assert.equal(db.getSetting("guard_trusted_mcp_servers"), undefined);

  mcp = await start();
  assert.deepEqual(mcp.get("notes"), { entry: { ...NOTES, exposure: "deferred" }, on: true });
  await mcp.set("memory", { url: "http://127.0.0.1:2/mcp", exposure: "direct" }, { trusted: true });
  assert.equal(db.trustedMcpServers().has("memory"), true);
  assert.deepEqual(Object.keys(servers()).sort(), ["memory", "notes"], "what else is in the file stays");
  // The exposure an extension says is where the person's mark starts, and no further.
  assert.deepEqual(db.toolMarks(), { memory: "direct" });
  db.setToolMarks({ memory: "lazy" });
  await mcp.set("memory", { url: "http://127.0.0.1:2/mcp", exposure: "direct" }, { trusted: true });
  assert.deepEqual(db.toolMarks(), { memory: "lazy" }, "the person's own mark stays");
  db.setToolMarks({});
});

test("its tools are the chats' while the server is there and not switched off, by pi's own key or the old adapter's", async () => {
  const mcp = await start();
  await mcp.set("notes", { ...NOTES, enabled: false });
  assert.deepEqual(mcp.get("notes"), { entry: { ...NOTES, enabled: false, exposure: "deferred" }, on: false }, "switched off in Settings → MCP");
  await mcp.set("notes", NOTES);
  assert.equal(mcp.get("notes").on, true);
  // What a caller does with what it was told is its own.
  mcp.get("notes").entry.url = "http://elsewhere/mcp";
  assert.equal(mcp.get("notes").entry.url, NOTES.url);
  assert.equal(mcp.get("nothing"), undefined);
  // A file as the old adapter wrote it: its `disabled` still means off.
  writeFileSync(mcpFile(), JSON.stringify({ mcpServers: { old: { url: "http://a/mcp", disabled: true } } }));
  assert.equal(mcp.get("old").on, false);
});

test("the old adapter's keys are translated for one release, and the tools to be confirmed are kept with the server", async () => {
  const mcp = await start();
  await mcp.set("legacy", { url: "http://127.0.0.1:3/mcp", lifecycle: "lazy", directTools: true, auth: "bearer", bearerTokenEnv: "LEGACY_TOKEN", approveTools: ["delete_*"], excludeTools: ["drop_*"] });
  assert.deepEqual(servers().legacy, { url: "http://127.0.0.1:3/mcp", exposure: "direct", headers: { Authorization: "Bearer ${LEGACY_TOKEN}" }, toolExposure: { "drop_*": "hidden" } });
  assert.deepEqual(db.mcpApprove(), { legacy: ["delete_*"] });
  assert.deepEqual(db.toolMarks().legacy, "direct", "the old key said direct, and the person has no mark");
  // `approve` of the call, with those of the old key.
  await mcp.set("legacy", { url: "http://127.0.0.1:3/mcp" }, { approve: ["create_*"] });
  assert.deepEqual(db.mcpApprove(), { legacy: ["create_*"] });
  // Removed, the server takes its confirmations and its mark with it.
  await mcp.set("legacy", undefined);
  assert.deepEqual(db.mcpApprove(), {});
  assert.equal(db.toolMarks().legacy, undefined);
});

test("removed, it is gone from the file, from what the chats have and from the servers trusted", async () => {
  const mcp = await start();
  writeFileSync(mcpFile(), JSON.stringify({ mcpServers: {} }));
  await mcp.set("notes", NOTES);
  await mcp.set("memory", NOTES, { trusted: true });
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
  writeFileSync(mcpFile(), JSON.stringify({ mcpServers: { memory: NOTES } }));
  await assert.rejects(mcp.set("two words", NOTES), /letters, digits, dash or underscore/);
  await assert.rejects(mcp.set("dotted.name", NOTES), /letters, digits, dash or underscore/);
  await assert.rejects(mcp.set("notes", { exposure: "direct" }), /needs either "command"/);
  await assert.rejects(mcp.set("notes", { url: "http://a/mcp", type: "sse" }), /SSE/);
  await assert.rejects(mcp.set("notes", { socket: "/tmp/mux.sock" }), /socket/);
  await assert.rejects(mcp.set("notes", { url: "http://a/mcp", exposure: "everywhere" }), /exposure must be one of/);
  await assert.rejects(mcp.set("my_notes", NOTES).then(() => mcp.set("my-notes", NOTES)), /would be taken for/, "pi puts - and _ together");
  const before = readFileSync(mcpFile(), "utf8");
  writeFileSync(mcpFile(), "{ not json");
  assert.equal(mcp.get("memory"), undefined, "nothing can be said of it");
  await assert.rejects(mcp.set("notes", NOTES), /Fix mcp.json first/);
  assert.equal(readFileSync(mcpFile(), "utf8"), "{ not json", "left for the person to fix");
  writeFileSync(mcpFile(), before);
});

test("a value that runs a command is allowed, as a command is, and left on the record", async () => {
  const mcp = await start();
  writeFileSync(mcpFile(), JSON.stringify({ mcpServers: {} }));
  await mcp.set("signed", { url: "https://x.test/mcp", headers: { Authorization: "!echo Bearer $(gh auth token)" } });
  assert.equal(servers().signed.headers.Authorization, "!echo Bearer $(gh auth token)");
  const rows = audit();
  assert.equal(rows.length, 1);
  assert.match(rows[0].reason, /signed.*headers\.Authorization/);
  await mcp.set("plain", { url: "https://x.test/mcp", headers: { A: "b" } });
  assert.equal(audit().length, 1, "nothing for what runs nothing");
});
