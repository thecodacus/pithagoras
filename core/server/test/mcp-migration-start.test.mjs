import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { inProcessHome } from "./server-harness.mjs";

// When the move from pi-mcp-adapter to pi's own MCP support runs, as the portal starts (issue 361, review 1 of PR B): not on a
// database made now, and, where it waited for an mcp.json that could not be read, as an upgrade of its own with a backup.
inProcessHome("pithagoras-mcp-migration-start-");
const agent = process.env.PI_CODING_AGENT_DIR;
const mcpPath = path.join(agent, "mcp.json");
mkdirSync(agent, { recursive: true });
// What pi's own command line writes, before the portal ever ran here: pi's keys, no exposure.
const NATIVE = JSON.stringify({ mcpServers: { fs: { command: "npx", args: ["-y", "x"] } } }, null, 2);
writeFileSync(mcpPath, NATIVE);
writeFileSync(path.join(agent, "settings.json"), JSON.stringify({ packages: ["npm:pi-web-access"] }));

const db = await import("../dist/db.js");
const { upgradeCheck } = await import("../dist/db-upgrade.js");
const { SCHEMA_VERSION } = await import("../dist/schema-version.js");
const d = db.getDb();
test.after(() => d.close());

test("a new database carries nothing over: an mcp.json that is there is pi's, and is left as it is", () => {
  // Correctness review 1 of PR B, finding 5.
  assert.equal(readFileSync(mcpPath, "utf8"), NATIVE);
  assert.equal(db.mcpMigration().report, null);
});

test("a move that waited for an unreadable mcp.json is an upgrade with a backup once the file can be read, and not before", () => {
  // Correctness review 1 of PR B, finding 9: it rewrites switches and rules, perhaps long after the upgrade's backup.
  assert.equal(upgradeCheck().needed, false);
  db.putSetting("mcp_migration", JSON.stringify({ v: 1, status: "pending", at: "2026-11-01T00:00:00.000Z" }));
  writeFileSync(mcpPath, `{ "mcpServers": { "a": `);
  assert.equal(upgradeCheck().needed, false, "nothing to do while it cannot be read: no backup at every start");
  writeFileSync(mcpPath, NATIVE);
  assert.deepEqual(upgradeCheck(), { needed: true, from: SCHEMA_VERSION, mcp: true });
  db.putSetting("mcp_migration", JSON.stringify({ v: 1, status: "done", at: "2026-11-01T00:00:00.000Z" }));
  assert.equal(upgradeCheck().needed, false);
});
