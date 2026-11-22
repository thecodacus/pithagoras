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
  assert.deepEqual(mcp.get("notes"), { entry: NOTES, on: true, approve: [] });
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
  assert.deepEqual(mcp.get("notes"), { entry: NOTES, on: true, approve: [] });
  await mcp.set("notes", { ...NOTES, enabled: false });
  assert.deepEqual(mcp.get("notes"), { entry: { ...NOTES, enabled: false }, on: false, approve: [] }, "switched off in Settings → MCP");
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
  await assert.rejects(mcp.set("notes", { url: "http://a/mcp", enabled: "yes" }), /enabled must be a boolean/);
  await mcp.set("kept", { command: "run" });
  const before = readFileSync(mcpFile(), "utf8");
  writeFileSync(mcpFile(), "{ not json");
  assert.equal(mcp.get("kept"), undefined, "nothing can be said of it");
  await assert.rejects(mcp.set("notes", NOTES), /Fix mcp.json first/);
  assert.equal(readFileSync(mcpFile(), "utf8"), "{ not json", "left for the person to fix");
  writeFileSync(mcpFile(), before);
});

test("the tools whose calls the person confirms first (approve) are kept by the portal, replaced by each set, and dropped by a set without them and by removing the server", async () => {
  const mcp = await start();
  await mcp.set("mail", { url: "http://127.0.0.1:5/mcp" }, { approve: ["send_*", " delete_mail ", "send_*"] });
  assert.deepEqual(db.mcpApprove().mail, ["send_*", "delete_mail"], "trimmed, once each");
  assert.deepEqual(mcp.get("mail").approve, ["send_*", "delete_mail"], "get says it");
  assert.equal(JSON.stringify(servers().mail).includes("approve"), false, "mcp.json stays pi's alone");
  // Each set replaces what was there.
  await mcp.set("mail", { url: "http://127.0.0.1:5/mcp" }, { approve: ["share_*"], trusted: true });
  assert.deepEqual(db.mcpApprove().mail, ["share_*"]);
  // Settings -> MCP's list says them in the server's row, and none for a server without.
  await mcp.set("plain", { url: "http://127.0.0.1:10/mcp" });
  const { mcpRouter } = await import("../dist/api/mcp.js");
  const { default: express } = await import("express");
  const app = express();
  app.use("/api", mcpRouter());
  const listener = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => listener.once("listening", resolve));
  try {
    const view = await (await fetch(`http://127.0.0.1:${listener.address().port}/api/mcp`)).json();
    assert.deepEqual(view.servers.find((one) => one.name === "mail").approve, ["share_*"]);
    assert.deepEqual(view.servers.find((one) => one.name === "plain").approve, []);
  } finally {
    listener.close();
  }
  // Another server's list is its own.
  await mcp.set("cal", { url: "http://127.0.0.1:6/mcp" }, { approve: ["*"] });
  assert.deepEqual(Object.keys(db.mcpApprove()).sort(), ["cal", "mail"]);
  // A set without approve (or with none) drops them: the server asks for nothing.
  await mcp.set("mail", { url: "http://127.0.0.1:5/mcp" });
  assert.equal(db.mcpApprove().mail, undefined);
  assert.deepEqual(mcp.get("mail").approve, []);
  await mcp.set("cal", { url: "http://127.0.0.1:6/mcp" }, { approve: [] });
  assert.equal(db.mcpApprove().cal, undefined);
  // Removing the server drops them too, and a server given the name later is not gated by an old list.
  await mcp.set("mail", { url: "http://127.0.0.1:5/mcp" }, { approve: ["send_*"] });
  await mcp.set("mail", undefined);
  assert.equal(db.mcpApprove().mail, undefined);
  await mcp.set("mail", { url: "http://127.0.0.1:7/mcp" });
  assert.deepEqual(mcp.get("mail").approve, []);
  // A server taken out of the file by someone else (Settings -> MCP) takes its patterns with it as well.
  await mcp.set("gone", { url: "http://127.0.0.1:8/mcp" }, { approve: ["x"] });
  const file = JSON.parse(readFileSync(mcpFile(), "utf8"));
  delete file.mcpServers.gone;
  const { writeMcpFile } = await import("../dist/api/mcp.js");
  writeMcpFile(file);
  assert.equal(db.mcpApprove().gone, undefined);
});

test("approve takes a list of texts, and the adapter's approveTools in the entry is refused with the option named; nothing is written or stored then", async () => {
  const mcp = await start();
  const before = readFileSync(mcpFile(), "utf8");
  for (const approve of ["delete_*", [""], [" "], [1], [null], {}, "*"]) {
    await assert.rejects(mcp.set("risky", { url: "http://127.0.0.1:9/mcp" }, { approve }), /approve takes a list of patterns of the server's own tool names/, JSON.stringify(approve));
  }
  for (const approveTools of [true, false, [], ["delete_*"]]) {
    await assert.rejects(mcp.set("risky", { url: "http://127.0.0.1:9/mcp", approveTools }, { approve: ["x"] }), /approveTools.*`approve` option/s, JSON.stringify(approveTools));
  }
  // `approve` inside the entry is no gate either: the file would say it, and nothing would ask.
  for (const approve of [["send_*"], true, []]) {
    await assert.rejects(mcp.set("risky", { url: "http://127.0.0.1:9/mcp", approve }), /approve is not a key of pi's.*`approve` option.*beside the entry/s, JSON.stringify(approve));
  }
  assert.equal(readFileSync(mcpFile(), "utf8"), before, "the file is as it was");
  assert.equal(db.mcpApprove().risky, undefined);
  // Not stored while the file cannot be read either.
  writeFileSync(mcpFile(), "{ not json");
  await assert.rejects(mcp.set("risky", { url: "http://127.0.0.1:9/mcp" }, { approve: ["x"] }), /Fix mcp.json first/);
  assert.equal(db.mcpApprove().risky, undefined);
  writeFileSync(mcpFile(), before);
});

test("a rename in Settings keeps the server's gate under its new name, and the old name has none left", async () => {
  const mcp = await start();
  await mcp.set("mail", { url: "http://127.0.0.1:5/mcp" }, { approve: ["send_*", "delete_*"] });
  const { mcpRouter } = await import("../dist/api/mcp.js");
  const { default: express } = await import("express");
  const app = express();
  app.use(express.json());
  app.use("/api", mcpRouter());
  const listener = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => listener.once("listening", resolve));
  const base = `http://127.0.0.1:${listener.address().port}/api`;
  try {
    const put = await fetch(`${base}/mcp/servers/post`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ from: "mail", entry: { url: "http://127.0.0.1:5/mcp" } }) });
    assert.equal(put.status, 200, await put.clone().text());
    const view = (await (await fetch(`${base}/mcp`)).json()).servers;
    assert.deepEqual(view.find((one) => one.name === "post").approve, ["send_*", "delete_*"], "the same server under another name is gated as it was");
    assert.equal(view.some((one) => one.name === "mail"), false);
    assert.equal(db.mcpApprove().mail, undefined, "a server given the old name later is not gated by a stale list");
    assert.deepEqual(db.mcpApprove().post, ["send_*", "delete_*"]);
  } finally {
    listener.close();
  }
  await mcp.set("post", undefined);
});
