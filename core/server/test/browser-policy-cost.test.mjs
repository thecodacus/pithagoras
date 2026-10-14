import { test } from "node:test";
import assert from "node:assert/strict";
import fs, { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { inProcessHome } from "./server-harness.mjs";

// Which conversations disagree with the browser default is asked about on a
// poll, over every conversation that says anything about tools. It is one read
// of the MCP file and of the settings for the lot, not for each of them.
const home = inProcessHome("pithagoras-policy-cost-");
const mcp = path.join(process.env.PI_CODING_AGENT_DIR, "mcp.json");
writeFileSync(mcp, JSON.stringify({ mcpServers: { chrome: { command: "npx", args: ["--cdp-endpoint", "http://127.0.0.1:9222"] }, other: {} } }));

const db = await import("../dist/db.js");
const { browserServers } = await import("../dist/api/mcp.js");
const { getDb } = db;

const NAMES = ["chrome_browser_click", "chrome_browser_navigate"];
db.rememberTools(NAMES.map((name) => ({ name, source: "pi-mcp-adapter" })));
const projects = ["alpha", "beta"];
for (const project of projects) mkdirSync(path.join(process.env.WORKSPACE_ROOT, project), { recursive: true });
// One project switches the browser off for its chats; the other says something that is not about it.
db.setProjectTools("alpha", { off: NAMES, on: [] });
db.setProjectTools("beta", { off: ["something_else"], on: [] });
for (let i = 0; i < 120; i++) {
  const workspace = i % 3 === 0 ? home : path.join(process.env.WORKSPACE_ROOT, projects[i % 2]);
  db.createSession({ id: `c${i}`, title: `c${i}`, workspace, executor: "host" });
  // Every fourth says something about tools, either way; every seventh holds the browser off or on against its project.
  if (i % 4 === 0) db.setSessionTools(`c${i}`, { off: i % 8 === 0 ? NAMES : ["unrelated"], on: [] });
  if (i % 7 === 0) db.setSessionTools(`c${i}`, { off: [], on: NAMES });
}

/** Counts what a call reads: the MCP file, and the whole settings table. */
function counting(run) {
  const read = fs.readFileSync;
  const counts = { mcp: 0, settings: 0 };
  fs.readFileSync = (file, ...rest) => {
    if (String(file) === mcp) counts.mcp++;
    return read(file, ...rest);
  };
  syncBuiltinESMExports();
  const handle = getDb();
  const prepare = handle.prepare.bind(handle);
  handle.prepare = (sql) => {
    if (/FROM settings\b/.test(sql)) counts.settings++;
    return prepare(sql);
  };
  try {
    return { result: run(), counts };
  } finally {
    delete handle.prepare;
    fs.readFileSync = read;
    syncBuiltinESMExports();
  }
}

test("the MCP file is read once to tell which servers are the browser", () => {
  const { result, counts } = counting(() => browserServers());
  assert.deepEqual(result, ["chrome"]);
  assert.equal(counts.mcp, 1);
});

test("the conversations that differ from the browser default are found from one read of the file and of the settings", () => {
  // What each conversation would answer asked on its own: the answer to hold the pass against.
  const byDefault = db.browserByDefault();
  const rows = getDb().prepare("SELECT * FROM sessions ORDER BY updated_at DESC").all();
  const expected = rows.filter((row) => db.browserAllowed(row) !== byDefault).map((row) => row.id).sort();
  assert.ok(expected.length > 10 && expected.length < rows.length, `${expected.length} of ${rows.length}`);

  const { result, counts } = counting(() => db.browserExceptions());
  assert.deepEqual(result.map((row) => row.id).sort(), expected);
  assert.ok(counts.mcp <= 2, `${counts.mcp} reads of the MCP file`);
  assert.ok(counts.settings <= 4, `${counts.settings} reads of the settings table`);
});
