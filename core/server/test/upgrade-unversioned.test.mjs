import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, existsSync } from "node:fs";
import path from "node:path";
import { inProcessHome } from "./server-harness.mjs";

// A database from before the schema had a version (fixtures/portal-unversioned.db),
// made by that code itself, at 0718375: two conversations, the event types the
// newer indexes cover, and settings. An upgrade has to bring it to the current
// schema without losing any of it, and the portal has to read and write it after.
const home = inProcessHome("pithagoras-unversioned-");
const file = path.join(home, "portal.db");
copyFileSync(new URL("./fixtures/portal-unversioned.db", import.meta.url), file);

const { runUpgrade } = await import("../dist/db-upgrade-steps.js");
const { SCHEMA_VERSION } = await import("../dist/schema-version.js");
const { upgradeCheck } = await import("../dist/db-upgrade.js");

test("a database from before versions is upgraded, keeps everything, and works afterwards", async () => {
  assert.deepEqual(upgradeCheck(file), { needed: true, from: 0 });
  const backup = await runUpgrade({ file, from: 0, backupDir: path.join(home, "backups") }, () => {});
  assert.ok(backup && existsSync(backup));
  assert.equal(upgradeCheck(file).needed, false);

  const db = await import("../dist/db.js");
  assert.equal(db.getDb().pragma("user_version", { simple: true }), SCHEMA_VERSION);
  assert.equal(db.getSession("task1").title, "A task from v0.1.0");
  assert.equal(db.getSession("agent1").kind, "agent");
  const events = db.eventsSince("task1");
  assert.deepEqual(events.map((e) => e.type), ["portal_prompt", "portal_taken", "message_end", "portal_command", "portal_command_end"]);
  assert.equal(JSON.parse(db.eventsSince("agent1")[0].payload).message.content[0].text, "Hello from the agent.");
  assert.equal(JSON.parse(db.getSetting("voice")).voice, "design");

  db.appendEvent("task1", "message_end", { message: { role: "assistant", content: [{ type: "text", text: "after the upgrade" }] } });
  assert.equal(db.eventsSince("task1").length, 6);
  db.getDb().close();
});
