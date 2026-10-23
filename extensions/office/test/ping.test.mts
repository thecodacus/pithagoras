/**
 * Unit tests for src/ping.ts (wake on comment mention, plan 5.4). Run from the repo ROOT:
 *   env -u NODE_ENV node --import tsx --test extensions/office/test/ping.test.mts
 * Self-contained: tmp dataDir per test, real docx created via store.createDoc, comment XML injected
 * with ooxml.rewriteZip, every side effect (folders/inFolder/tell/record/log) injected through
 * wirePing so the tests NEVER reach portal().
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  wirePing,
  __resetPingForTests,
  handlePersisted,
  drainWakeQueue,
  officeWakeMessage,
  type PingAuditEntry,
  type WakeEntry,
} from "../src/ping";
import { createDoc, getDoc, importFile, templateDocx } from "../src/store";
import { rewriteZip, parseDocx } from "../src/ooxml";

/* ------------------------------------------------------------------ */
/* fakes                                                               */
/* ------------------------------------------------------------------ */

const FOLDERS = [
  { path: "/f/acme", name: "Acme", kind: "project" as const },
  { path: "/f/atlas", name: "Atlas", kind: "agent" as const },
  { path: "/f/helper", name: "Helper", kind: "agent" as const },
  { path: "/f/twin-agent", name: "Twin", kind: "agent" as const },
  { path: "/f/twin-project", name: "twin", kind: "project" as const }, // case-insensitive duplicate of the agent above -> ambiguous
  { path: "/f/notes", name: "Notes", kind: "chat" as const }, // wrong kind: never a mention target
];
const HOME_CHAT: Record<string, string> = {
  "/f/acme": "chat-acme-home",
  "/f/atlas": "chat-atlas-home",
  "/f/helper": "chat-helper-home",
  "/f/twin-agent": "twin-agent-chat",
  "/f/twin-project": "twin-project-chat",
};

type Seen = { tells: [string, unknown][]; records: PingAuditEntry[]; logs: string[] };

function setup(): { root: string; seen: Seen } {
  __resetPingForTests();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "office-ping-"));
  const seen: Seen = { tells: [], records: [], logs: [] };
  wirePing({
    root,
    folders: () => FOLDERS,
    inFolder: (p) => (HOME_CHAT[p] ? [{ id: HOME_CHAT[p] }] : []),
    tell: (chatId: string, data: unknown) => {
      seen.tells.push([chatId, data]);
      return true;
    },
    record: (e) => seen.records.push(e),
    log: (l) => seen.logs.push(l),
  });
  return { root, seen };
}

async function makeDoc(root: string, title: string, opts?: { type?: "word" | "cell"; owner?: string | null }) {
  const input = { title, type: opts?.type ?? ("word" as const) };
  if (opts && "owner" in opts) input.owner = opts.owner;
  return await createDoc(input, root);
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
type C = { id: string; author: string; text: string };
function commentsXml(cs: C[]): string {
  return (
    '<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    cs.map((c) => `<w:comment id="${c.id}" author="${esc(c.author)}" date="2026-01-01T00:00:00Z"><w:p><w:r><w:t xml:space="preserve">${esc(c.text)}</w:t></w:r></w:p></w:comment>`).join("") +
    "</w:comments>"
  );
}

/** Simulate a DS persist of the doc with exactly these comments in word/comments.xml. */
function persistWith(root: string, docId: string, title: string, ext: string, cs: C[]): void {
  const buf = fs.readFileSync(path.join(root, "docs", docId, `${title}.${ext}`));
  handlePersisted(docId, rewriteZip(buf, { "word/comments.xml": commentsXml(cs) }));
}

const stateFile = (root: string, docId: string) => path.join(root, "state", `${docId}.json`);

/* ------------------------------------------------------------------ */
/* officeWakeMessage                                                   */
/* ------------------------------------------------------------------ */

test("officeWakeMessage renders the exact plan 5.4 template", () => {
  const msg = officeWakeMessage("Budget 2026", "Alice", "first line @agent\nsecond line");
  assert.equal(
    msg,
    [
      'Alice asked you in a comment on the office document "Budget 2026":',
      "> first line @agent",
      "> second line",
      "You have edit access to this document for this task; answer with the office_* tools.",
    ].join("\n")
  );
  // single-line comment, no trailing blank line
  assert.equal(officeWakeMessage("T", "Bob", "one"), 'Bob asked you in a comment on the office document "T":\n> one\nYou have edit access to this document for this task; answer with the office_* tools.');
});

/* ------------------------------------------------------------------ */
/* persist behavior                                                    */
/* ------------------------------------------------------------------ */

test("created doc, first save: a mention IS processed (no baseline swallows first-session intent)", async () => {
  const { root, seen } = setup();
  const meta = await makeDoc(root, "Budget", { owner: "chat-atlas-home" });
  persistWith(root, meta.docId, meta.title, meta.ext, [
    { id: "1", author: "Alice", text: "@agent please review this" }, // created docs get NO baseline: the mention wakes on save #1
    { id: "2", author: "Bob", text: "notes for later" },
  ]);
  assert.deepEqual(seen.tells, [["chat-atlas-home", { type: "ping" }]]);
  assert.equal(seen.records.length, 1);
  const state = JSON.parse(fs.readFileSync(stateFile(root, meta.docId), "utf8")) as { ids: string[] };
  assert.deepEqual(state.ids.sort(), ["1", "2"]);
  const grants = getDoc(meta.docId, root)?.grants ?? [];
  assert.equal(grants.length, 1);
  assert.equal(grants[0].chatId, "chat-atlas-home");
  assert.equal(grants[0].commentId, "1");
});

test("imported doc, first save: its existing comments are baselined WITHOUT wakes", async () => {
  const { root, seen } = setup();
  // A file with comment history that predates this library -- the whole point of importFile(imported:true).
  const src = path.join(root, "src-import.docx");
  fs.writeFileSync(src, rewriteZip(await templateDocx(), { "word/comments.xml": commentsXml([
    { id: "7", author: "Cara", text: "carry-over note" },
    { id: "8", author: "Dan", text: "old @agent mention" },
  ]) }));
  const meta = importFile(src, { title: "Carried Over" }, root); // sync
  assert.equal(meta.imported, true);
  assert.deepEqual(meta.importedBaseline, ["7", "8"]); // stamped from the file at IMPORT time (review 4364810146)

  // A mention added AFTER the import but BEFORE the first save is NEW to this library (not in importedBaseline) -> it IS
  // processed on save #1; the imported history (7, 8) baselines silently.
  persistWith(root, meta.docId, meta.title, meta.ext, [
    { id: "7", author: "Cara", text: "carry-over note" },
    { id: "8", author: "Dan", text: "old @agent mention" },
    { id: "9", author: "Eli", text: "@project:acme please take over this doc" },
  ]);
  assert.deepEqual(seen.tells, [["chat-acme-home", { type: "ping" }]]); // only the post-import mention wakes
  assert.equal(seen.records.length, 1);
  const state = JSON.parse(fs.readFileSync(stateFile(root, meta.docId), "utf8")) as { ids: string[] };
  assert.deepEqual(state.ids.sort(), ["7", "8", "9"]);
  const grants = getDoc(meta.docId, root)?.grants ?? [];
  assert.equal(grants.length, 1);
  assert.equal(grants[0].commentId, "9");

  // ...and a plain re-send of the same set adds nothing (pure id diff)
  persistWith(root, meta.docId, meta.title, meta.ext, [
    { id: "7", author: "Cara", text: "carry-over note" },
    { id: "8", author: "Dan", text: "old @agent mention" },
    { id: "9", author: "Eli", text: "@project:acme please take over this doc" },
  ]);
  assert.deepEqual(seen.tells, [["chat-acme-home", { type: "ping" }]]); // still just the one wake from save #1
});

test("second persist: @agent wakes the owner; @project:<name> matches case-insensitively, grant + wake queued; re-send dedupes", async () => {
  const { root, seen } = setup();
  const meta = await makeDoc(root, "Budget", { owner: "chat-atlas-home" });
  persistWith(root, meta.docId, meta.title, meta.ext, [{ id: "1", author: "Alice", text: "baseline" }]);
  assert.deepEqual(seen.tells, []);

  const c2: C = { id: "2", author: "Alice", text: "@agent please review this" };
  const c3: C = { id: "3", author: "Bob", text: "hand off to @project:acme when ready" };
  persistWith(root, meta.docId, meta.title, meta.ext, [{ id: "1", author: "Alice", text: "baseline" }, c2, c3]);

  // owner wake with the EXACT template text, and project home resolved per plan 2.1 via inFolder(folder.path)
  assert.deepEqual(seen.tells, [
    ["chat-atlas-home", { type: "ping" }],
    ["chat-acme-home", { type: "ping" }],
  ]);
  const ownerQueue = drainWakeQueue("chat-atlas-home");
  assert.equal(ownerQueue.length, 1);
  assert.deepEqual(ownerQueue[0], { text: officeWakeMessage(meta.title, c2.author, c2.text), details: { docId: meta.docId, commentId: "2" } });
  const acmeQueue = drainWakeQueue("chat-acme-home") as WakeEntry[];
  assert.equal(acmeQueue.length, 1);
  assert.deepEqual(acmeQueue[0].text, officeWakeMessage(meta.title, c3.author, c3.text));
  assert.deepEqual(acmeQueue[0].details, { docId: meta.docId, commentId: "3" });

  // grants added (deduped by commentId) and audited
  const grants = getDoc(meta.docId, root)?.grants ?? [];
  for (const g of grants) assert.equal(typeof g.at, "number");
  assert.ok(grants.some((g) => g.chatId === "chat-atlas-home" && g.commentId === "2"));
  assert.ok(grants.some((g) => g.chatId === "chat-acme-home" && g.commentId === "3"));
  assert.equal(grants.length, 2);
  assert.equal(seen.records.length, 2);
  for (const r of seen.records) {
    assert.equal(r.subject, meta.title);
    assert.match(r.reason, /comment mention/);
    assert.ok(["chat-atlas-home", "chat-acme-home"].includes(r.chatId));
  }

  // re-send the SAME comments: no second ping, no second grant
  persistWith(root, meta.docId, meta.title, meta.ext, [{ id: "1", author: "Alice", text: "baseline" }, c2, c3]);
  assert.deepEqual(seen.tells.length, 2);
  assert.equal(getDoc(meta.docId, root)?.grants?.length, 2);
  assert.equal(drainWakeQueue("chat-acme-home").length, 0);

  // state now holds all seen ids
  const state = JSON.parse(fs.readFileSync(stateFile(root, meta.docId), "utf8")) as { ids: string[] };
  assert.deepEqual(state.ids.sort(), ["1", "2", "3"]);
});

test("bare @name matches an agent folder case-insensitively; unmatched and ambiguous names log only; duplicate mention of one target pings once", async () => {
  const { root, seen } = setup();
  const meta = await makeDoc(root, "Plan", { owner: null });
  persistWith(root, meta.docId, meta.title, meta.ext, [{ id: "1", author: "A", text: "baseline" }]);

  persistWith(root, meta.docId, meta.title, meta.ext, [
    { id: "1", author: "A", text: "baseline" },
    { id: "2", author: "B", text: "cc @HELPER on the draft" }, // folder is named "Helper"
    { id: "3", author: "C", text: "whoever reads this, @nobody help" }, // no such folder
    { id: "4", author: "D", text: "@twin please sort this out" }, // agent + project both named Twin (case-insensitive) -> ambiguous
    { id: "5", author: "E", text: "@acme and again @ACME, one job" }, // same target twice in one comment
  ]);

  assert.deepEqual(seen.tells, [
    ["chat-helper-home", { type: "ping" }],
    ["chat-acme-home", { type: "ping" }],
  ]);
  const logs = seen.logs.join("\n");
  assert.match(logs, /@nobody .* matches no agent or project/);
  assert.match(logs, /@twin is ambiguous .*(agent|project).*Twin.*-- no silent disambiguation/);
  // chat-kind folders are never mention targets: @notes would be unmatched (not asserted above) -- but grants confirm only real targets landed
  const grants = getDoc(meta.docId, root)?.grants ?? [];
  assert.deepEqual(
    grants.map((g) => [g.chatId, g.commentId]).sort(),
    [["chat-acme-home", "5"], ["chat-helper-home", "2"]].sort()
  );
});

test("@agent on an ownerless doc is skipped with a log line, no crash", async () => {
  const { root, seen } = setup();
  const meta = await makeDoc(root, "Solo", {}); // owner omitted -> null
  assert.equal(meta.owner, null);
  persistWith(root, meta.docId, meta.title, meta.ext, [{ id: "1", author: "A", text: "baseline" }]);
  persistWith(root, meta.docId, meta.title, meta.ext, [
    { id: "1", author: "A", text: "baseline" },
    { id: "2", author: "B", text: "@agent fix the totals" },
  ]);
  assert.deepEqual(seen.tells, []);
  assert.deepEqual(seen.records, []);
  assert.match(seen.logs.join("\n"), /@agent .* ownerless document -- no wake/);
  // ids still recorded so a later save diff stays sane
  const state = JSON.parse(fs.readFileSync(stateFile(root, meta.docId), "utf8")) as { ids: string[] };
  assert.deepEqual(state.ids.sort(), ["1", "2"]);
});

test("xlsx persist is a no-op (v1 wakes docx only)", async () => {
  const { root, seen } = setup();
  const meta = await makeDoc(root, "Sheet", { type: "cell", owner: "chat-atlas-home" });
  assert.equal(meta.ext, "xlsx");
  // even a complete garbage buffer must be ignored without touching state or pings
  handlePersisted(meta.docId, Buffer.from("not a zip at all"));
  assert.deepEqual(seen.tells, []);
  assert.ok(!fs.existsSync(stateFile(root, meta.docId)));
  assert.equal(getDoc(meta.docId, root)?.grants?.length ?? 0, 0);
});

test("corrupt state file: logged, previous set treated as empty, mentions processed once, state restored", async () => {
  const { root, seen } = setup();
  const meta = await makeDoc(root, "Ledger", { owner: "chat-atlas-home" });
  persistWith(root, meta.docId, meta.title, meta.ext, [{ id: "1", author: "A", text: "@agent baseline ask" }]); // created doc: the @agent mention IS processed on its very first save (no baseline)
  fs.writeFileSync(stateFile(root, meta.docId), "{ this is not json");

  persistWith(root, meta.docId, meta.title, meta.ext, [
    { id: "1", author: "A", text: "@agent baseline ask" }, // corrupt state -> empty seen set: "new" again -- re-wake accepted (see module docs)
    { id: "2", author: "B", text: "@agent second ask" },
  ]);
  assert.match(seen.logs.join("\n"), /state file .* corrupt/);
  // one ping from the first save, then BOTH comments re-process after the corruption (queue dedupes per comment, but the tell fires each pass)
  assert.deepEqual(seen.tells, [
    ["chat-atlas-home", { type: "ping" }],
    ["chat-atlas-home", { type: "ping" }],
    ["chat-atlas-home", { type: "ping" }],
  ]);
  // wake queue dedupes per (docId, commentId) but grants also dedupe: both asks land once
  const grants = getDoc(meta.docId, root)?.grants ?? [];
  assert.deepEqual(
    grants.map((g) => [g.chatId, g.commentId]).sort(),
    [["chat-atlas-home", "1"], ["chat-atlas-home", "2"]].sort()
  );
  const state = JSON.parse(fs.readFileSync(stateFile(root, meta.docId), "utf8")) as { ids: string[] };
  assert.deepEqual(state.ids.sort(), ["1", "2"]); // restored to a sane file
});

test("sanity: the injected comments are really parsed from the rewritten docx (fixture self-check)", async () => {
  const { root } = setup();
  const meta = await makeDoc(root, "Selfcheck", {});
  persistWith(root, meta.docId, meta.title, meta.ext, [{ id: "9", author: "Zoe", text: "multi\nword check @agent" }]);
  const buf = fs.readFileSync(path.join(root, "docs", meta.docId, `${meta.title}.docx`));
  assert.equal(parseDocx(rewriteZip(buf, { "word/comments.xml": commentsXml([{ id: "9", author: "Zoe", text: "multi\nword check @agent" }]) })).comments.length, 1);
});
