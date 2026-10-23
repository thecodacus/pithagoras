/**
 * Unit tests for src/tools.ts (the agent's office_* tools, plan 5.4/5.5). Run from the repo ROOT:
 *   env -u NODE_ENV node --import tsx --test extensions/pithagoras-office/test/tools.test.mts
 * Self-contained: tmp dataDir per test, real docx/xlsx via store.createDoc (real templates), comment
 * XML injected with ooxml.rewriteZip, every portal bit (extend registrar, chat->folder, folders list,
 * inFolder, root, record, log) injected through registerTools and the forcesave hook through
 * setForcesaveHook -- the tests NEVER reach portal().
 *
 * Refusals are THROWN by the tool's execute (docs convention: "a refusal is an error the agent
 * reads"), so error cases assert on the rejection MESSAGE, which must start with "error:<code> ".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerTools, setForcesaveHook, __resetToolsForTests } from "../src/tools";
import { createDoc, getDoc } from "../src/store";
import { parseDocx, rewriteZip } from "../src/ooxml";
import { setUser, resetLive } from "../src/live";

/* ------------------------------------------------------------------ */
/* fakes                                                               */
/* ------------------------------------------------------------------ */

type FolderLite = { path: string; name: string; kind: "agent" | "project" | "chat"; home?: boolean };
const FOLDERS: FolderLite[] = [
  { path: "/f/atlas", name: "Atlas", kind: "agent" },
  { path: "/f/acme", name: "Acme", kind: "project" },
  { path: "/f/notes", name: "Notes", kind: "chat" }, // wrong kind: never gets tools
];
const HOME_BY_FOLDER: Record<string, string[]> = {
  "/f/atlas": ["chat-atlas-home"],
  "/f/acme": ["zzz-acme-b", "aaa-acme-a"], // two sessions; the deterministic pick must be the lowest id
};
const CHAT_TO_FOLDER: Record<string, string> = {
  "chat-atlas-home": "/f/atlas",
  "aaa-acme-a": "/f/acme",
  "zzz-acme-b": "/f/acme",
  "chat-notes": "/f/notes",
};

type ToolResult = { content: { type: string; text: string }[]; details?: any };
type PiFake = { registered: Record<string, any>[]; sent: unknown[][]; uiHandlers: ((m: any) => void)[]; find: (name: string) => any } & Record<string, any>;

function makePi(): PiFake {
  const registered: Record<string, any>[] = [];
  const sent: unknown[][] = [];
  const uiHandlers: ((m: any) => void)[] = [];
  return Object.assign(({} as any), {
    registered,
    sent,
    uiHandlers,
    find: (name: string) => registered.find((t) => t.name === name),
    registerTool: (def: Record<string, any>) => {
      registered.push(def);
    },
    sendMessage: (msg: unknown, opts: unknown) => {
      sent.push([msg, opts]);
    },
    events: {
      on: (_name: string, fn: (m: any) => void) => {
        uiHandlers.push(fn);
        return () => {};
      },
    },
  });
}

type Seen = { records: { subject: string; reason: string; chatId: string }[]; logs: string[] };

/** One isolated world: tmp root, a captured extend factory, a fake pi for `chatId`, seams wired so no default touches portal(). */
function setup(chatId = "chat-atlas-home"): { root: string; seen: Seen; pi: PiFake; folderPath: string } {
  __resetToolsForTests();
  resetLive();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "office-tools-"));
  const seen: Seen = { records: [], logs: [] };
  const pi = makePi();
  let factory!: (pi: unknown, chat: { id: string }) => void;
  registerTools({
    extend: (f) => {
      factory = f;
    },
    chatFolder: (id) => {
      const p = CHAT_TO_FOLDER[id];
      if (!p) throw new Error(`no workspace for ${id}`);
      return p;
    },
    folders: () => FOLDERS,
    inFolder: (p) => (HOME_BY_FOLDER[p] ?? []).map((id) => ({ id })),
    root,
    record: (e) => seen.records.push(e),
    log: (l) => seen.logs.push(l),
  });
  // The factory body runs PER CALL so each test step sees exactly one registration pass for its chat.
  (setup as any).__run = () => factory(pi, { id: chatId });
  return { root, seen, pi, folderPath: CHAT_TO_FOLDER[chatId] };
}

/** Run the captured factory on the fake pi and hand back the registered tool by name. */
function tool(s: ReturnType<typeof setup>, name: string): any {
  (setup as any).__run();
  const t = s.pi.find(name);
  if (!t) throw new Error(`tool ${name} not registered`);
  s.pi.registered.length = 0; // registrations must not stack across calls on the same pi
  return t;
}

/** Await an execute that MUST refuse, and return the refusal message (docs convention: it is thrown, and starts with "error:<code> "). */
async function refused(p: Promise<unknown>, what = ""): Promise<string> {
  try {
    const v = await p;
    throw new Error(`expected a refusal (${what}) but the tool succeeded: ${JSON.stringify((v as ToolResult)?.content ?? v)}`);
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("expected a refusal")) throw e;
    const msg = e instanceof Error ? e.message : String(e);
    if (!/^error:[a-z_]+ /.test(msg)) throw new Error(`bad refusal format (${what}): ${msg}`);
    return msg;
  }
}

const readDocBytes = (root: string, docId: string): Buffer => {
  const doc = getDoc(docId, root)!;
  return fs.readFileSync(path.join(root, "docs", docId, `${doc.title}.${doc.ext}`));
};

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
function commentsXml(cs: { id: string; author: string; text: string }[]): string {
  return (
    '<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    cs.map((c) => `<w:comment id="${c.id}" author="${esc(c.author)}" date="2026-01-02T03:04:05Z"><w:p><w:r><w:t xml:space="preserve">${esc(c.text)}</w:t></w:r></w:p></w:comment>`).join("") +
    "</w:comments>"
  );
}

function addGrant(root: string, docId: string, chatId: string, commentId: string): void {
  const p = path.join(root, "index.json");
  const raw = JSON.parse(fs.readFileSync(p, "utf8"));
  raw.docs.find((d: any) => d.docId === docId).grants.push({ chatId, commentId, at: Date.now() });
  fs.writeFileSync(p, JSON.stringify(raw, null, 2));
}

/** Simulate a forcesaved DS session bumping the revision to `toMs` (file mtime AND index entry move together, so every gate sees one consistent fresh revision). */
function bumpRevision(root: string, docId: string, toMs: number): void {
  const doc = getDoc(docId, root)!;
  const file = path.join(root, "docs", docId, `${doc.title}.${doc.ext}`);
  fs.utimesSync(file, new Date(toMs), new Date(toMs));
  const p = path.join(root, "index.json");
  const raw = JSON.parse(fs.readFileSync(p, "utf8"));
  raw.docs.find((d: any) => d.docId === docId).mtimeMs = toMs;
  fs.writeFileSync(p, JSON.stringify(raw, null, 2));
}

/* ------------------------------------------------------------------ */
/* registration + scope                                                */
/* ------------------------------------------------------------------ */

test("registers office_* only in agent and project home chats", () => {
  const s = setup("chat-atlas-home");
  (setup as any).__run();
  assert.deepEqual(
    s.pi.registered.map((t) => t.name).sort(),
    ["office_comments", "office_create", "office_edit", "office_list", "office_read"],
  );

  // wrong kind (a plain chat folder): the factory RETURNS, nothing registered
  const notes = makePi();
  registerTools({
    extend: (f) => f(notes, { id: "chat-notes" }),
    chatFolder: (id) => CHAT_TO_FOLDER[id],
    folders: () => FOLDERS,
    inFolder: (p) => (HOME_BY_FOLDER[p] ?? []).map((id) => ({ id })),
    root: s.root,
    log: (l) => s.seen.logs.push(l),
  });
  assert.equal(notes.registered.length, 0);

  // a chat whose folder is gone: no tools, one log line, no throw
  const ghost = makePi();
  registerTools({
    extend: (f) => f(ghost, { id: "chat-gone" }),
    chatFolder: () => {
      throw new Error("folder gone");
    },
    folders: () => FOLDERS,
    inFolder: () => [],
    root: s.root,
    log: (l) => s.seen.logs.push(l),
  });
  assert.equal(ghost.registered.length, 0);
  assert.ok(s.seen.logs.some((l) => l.includes("no workspace folder for chat chat-gone")));
});

test("home chat of a multi-session project folder is the lowest id (ping.ts rule)", async () => {
  const s = setup("zzz-acme-b"); // a NON-lowest session of the Acme project
  const made = await tool(s, "office_create").execute("c", { title: "Acme Note", type: "word" });
  assert.equal(getDoc(made.details.id, s.root)!.owner, "aaa-acme-a"); // owner = the deterministic home, not the acting session
});

test("scope: owned and granted docs visible; another home's doc invisible to list AND read", async () => {
  const s = setup();
  const home = "chat-atlas-home";
  await createDoc({ title: "Mine", type: "word", owner: home }, s.root);
  const theirs = await createDoc({ title: "Theirs Secret Doc", type: "word", owner: "chat-other" }, s.root); // no grant to us
  const granted = await createDoc({ title: "Shared One", type: "cell", owner: "chat-other" }, s.root);
  addGrant(s.root, granted.docId, home, "c-grant");

  (setup as any).__run();
  const listText = (await tool(s, "office_list").execute("c", {})) as ToolResult;
  assert.ok(listText.content[0].text.includes('"Mine"'));
  assert.ok(listText.content[0].text.includes('"Shared One"'));
  assert.ok(!listText.content[0].text.includes("Theirs Secret Doc"), "another home's doc must not appear in office_list");

  // office_read of the out-of-scope id refuses with the SAME words as a nonexistent id (docs convention: no leak)
  const missing = await refused(tool(s, "office_read").execute("c", { id: "no-such-id" }), "missing id");
  const foreign = await refused(tool(s, "office_read").execute("c", { id: theirs.docId }), "out-of-scope id");
  assert.equal(foreign, missing);
  assert.match(foreign, /^error:not_found /);

  // the granted doc IS readable (xlsx grid path per plan 5.5)
  const shared = (await tool(s, "office_read").execute("c", { id: granted.docId })) as ToolResult;
  assert.ok(shared.content[0].text.includes('"Shared One"'));
});

/* ------------------------------------------------------------------ */
/* office_create                                                       */
/* ------------------------------------------------------------------ */

test("office_create: happy path returns id + meta, owner is the home; duplicate title+type -> error:exists", async () => {
  const s = setup();
  const t = tool(s, "office_create");
  const res = (await t.execute("c1", { title: "Budget", type: "cell" })) as ToolResult;
  const meta = getDoc(res.details.id, s.root)!;
  assert.ok(meta); // exists in the index and on disk
  assert.equal(meta.owner, "chat-atlas-home");
  assert.equal(meta.ext, "xlsx");
  assert.equal(typeof res.details.mtimeMs, "number");
  assert.ok(res.content[0].text.includes(res.details.id));
  assert.ok(s.seen.records.some((r) => r.chatId === "chat-atlas-home" && r.reason.includes("office_create")), "audit recorded for create");

  const dup = await refused(t.execute("c2", { title: "Budget", type: "cell" }), "duplicate");
  assert.match(dup, /^error:exists /);

  // a different type with the same title is NOT a duplicate
  const word = (await t.execute("c3", { title: "Budget", type: "word" })) as ToolResult;
  assert.ok(word.details.id && !word.content[0].text.startsWith("error:"));

  // bad type -> error:unsupported_format; blank title -> error:invalid (refused before the store is touched)
  assert.match(await refused(t.execute("c4", { title: "Nope", type: "spreadsheet" }), "bad type"), /^error:unsupported_format /);
  assert.match(await refused(t.execute("c5", { title: "  ", type: "word" }), "blank title"), /^error:invalid /);
});

/* ------------------------------------------------------------------ */
/* office_edit                                                         */
/* ------------------------------------------------------------------ */

test("office_edit: applies ops to the stored bytes, bumps the revision; old baseRevision -> error:revision_mismatch with the fresh mtime; quote_not_found passes through", async () => {
  const s = setup();
  const doc = await createDoc({ title: "Edit Me", type: "word", owner: "chat-atlas-home" }, s.root);
  const base1 = getDoc(doc.docId, s.root)!.mtimeMs;
  assert.equal(parseDocx(readDocBytes(s.root, doc.docId)).text, "New document");

  const t = tool(s, "office_edit");
  const ok = (await t.execute("e1", { id: doc.docId, ops: [{ quote: "New document", replacement: "Edited text" }], baseRevision: base1 })) as ToolResult;
  assert.ok(!ok.content[0].text.startsWith("error:"), `unexpected error: ${ok.content[0].text}`);
  assert.match(ok.content[0].text, /now at revision/);

  // round-trip: re-reading the STORED bytes shows the edit; persistBytes updated the index's revision
  assert.equal(parseDocx(readDocBytes(s.root, doc.docId)).text, "Edited text");
  assert.equal(getDoc(doc.docId, s.root)!.mtimeMs, ok.details.to);

  // a second edit on the OLD baseRevision is refused with the FRESH mtime in the message -- and nothing written
  const fresh = getDoc(doc.docId, s.root)!.mtimeMs;
  const stale = await refused(t.execute("e2", { id: doc.docId, ops: [{ quote: "Edited text", replacement: "again" }], baseRevision: fresh - 5000 }), "stale gate");
  assert.match(stale, /^error:revision_mismatch /);
  assert.ok(stale.includes(String(fresh)), `the fresh mtime ${fresh} must be in the message: ${stale}`);
  assert.equal(parseDocx(readDocBytes(s.root, doc.docId)).text, "Edited text"); // unchanged

  // with the FRESH base it applies; a bad quote surfaces ooxml's quote_not_found code verbatim
  const ok2 = await t.execute("e3", { id: doc.docId, ops: [{ quote: "Edited text", replacement: "Final words" }], baseRevision: getDoc(doc.docId, s.root)!.mtimeMs });
  assert.ok(!ok2.content[0].text.startsWith("error:"), ok2.content[0].text);
  const qnf = await refused(t.execute("e4", { id: doc.docId, ops: [{ quote: "not in the document at all", replacement: "x" }], baseRevision: getDoc(doc.docId, s.root)!.mtimeMs }), "quote_not_found");
  assert.match(qnf, /^error:quote_not_found /);
  assert.equal(parseDocx(readDocBytes(s.root, doc.docId)).text, "Final words"); // still nothing written

  // spreadsheets cannot be edited in v1 (plan 5.5: document.xml run-level edits are Word-only)
  const sheet = await createDoc({ title: "Grid", type: "cell", owner: "chat-atlas-home" }, s.root);
  assert.match(await refused(t.execute("e5", { id: sheet.docId, ops: [{ quote: "a", replacement: "b" }], baseRevision: getDoc(sheet.docId, s.root)!.mtimeMs }), "xlsx edit"), /^error:unsupported_format /);

  // audit recorded for the two successful edits only
  assert.equal(s.seen.records.filter((r) => r.reason.includes("office_edit")).length, 2);
});

test("office_edit forcesave-first: coEdit + open session -> hook awaited before persist; a mid-flight revision bump surfaces as revision_mismatch", async () => {
  const s = setup();
  const doc = await createDoc({ title: "Co Edit", type: "word", owner: "chat-atlas-home" }, s.root);
  setUser(doc.docId, { id: "human-1", name: "Human" }, true); // an editor is open
  const order: string[] = [];

  // Case A: the forcesave itself lands a save while our edit is in flight -> the re-gate must refuse with that fresh mtime
  let bumpedTo = 0;
  setForcesaveHook(async (docId: string) => {
    order.push("hook");
    bumpedTo = Date.now() + 5000; // guaranteed >1 ms ahead of base
    bumpRevision(s.root, docId, bumpedTo);
  });
  const baseA = getDoc(doc.docId, s.root)!.mtimeMs;
  const refusedMsg = await refused(tool(s, "office_edit").execute("f1", { id: doc.docId, ops: [{ quote: "New document", replacement: "late" }], baseRevision: baseA }), "mid-flight bump");
  assert.deepEqual(order, ["hook"], "the hook was awaited (exactly once)");
  assert.match(refusedMsg, /^error:revision_mismatch /);
  assert.ok(refusedMsg.includes(String(bumpedTo)), `the fresh bumped mtime ${bumpedTo} must be in the message: ${refusedMsg}`);
  assert.equal(parseDocx(readDocBytes(s.root, doc.docId)).text, "New document"); // NOTHING written by the agent edit

  // Case B: the forcesave moves nothing (session had no dirty change) -> the edit proceeds AFTER the awaited hook
  const doc2 = await createDoc({ title: "Co Edit Two", type: "word", owner: "chat-atlas-home" }, s.root);
  setUser(doc2.docId, { id: "human-2" }, true);
  setForcesaveHook(async () => {
    order.push("hook2");
  });
  const ok = (await tool(s, "office_edit").execute("f2", { id: doc2.docId, ops: [{ quote: "New document", replacement: "Saved after forcesave" }], baseRevision: getDoc(doc2.docId, s.root)!.mtimeMs })) as ToolResult;
  assert.deepEqual(order.slice(-1), ["hook2"], "the hook ran before the edit was allowed on");
  assert.ok(!ok.content[0].text.startsWith("error:"), ok.content[0].text);
  assert.equal(parseDocx(readDocBytes(s.root, doc2.docId)).text, "Saved after forcesave");

  // Case C: coEdit switched off -> no hook at all, even with a session open
  fs.writeFileSync(path.join(s.root, "settings.json"), JSON.stringify({ enabled: true, imageTag: "onlyoffice/documentserver:10.0", coEdit: false }));
  const doc3 = await createDoc({ title: "No Co Edit", type: "word", owner: "chat-atlas-home" }, s.root);
  setUser(doc3.docId, { id: "human-3" }, true);
  order.length = 0;
  const ok3 = (await tool(s, "office_edit").execute("f3", { id: doc3.docId, ops: [{ quote: "New document", replacement: "No hook" }], baseRevision: getDoc(doc3.docId, s.root)!.mtimeMs })) as ToolResult;
  assert.ok(!ok3.content[0].text.startsWith("error:"), ok3.content[0].text);
  assert.equal(order.length, 0, "with coEdit off the forcesave hook must not run");

  // Case D: no hook registered yet (T-WIRE has not wired it) -> logged no-op default, then the edit still proceeds after re-gating
  fs.writeFileSync(path.join(s.root, "settings.json"), JSON.stringify({ enabled: true, imageTag: "onlyoffice/documentserver:10.0", coEdit: true })); // case C turned coEdit off in this root
  setForcesaveHook(null);
  const doc4 = await createDoc({ title: "No Hook Yet", type: "word", owner: "chat-atlas-home" }, s.root);
  setUser(doc4.docId, { id: "human-4" }, true);
  const before = s.seen.logs.length;
  const ok4 = (await tool(s, "office_edit").execute("f4", { id: doc4.docId, ops: [{ quote: "New document", replacement: "Default path" }], baseRevision: getDoc(doc4.docId, s.root)!.mtimeMs })) as ToolResult;
  assert.ok(!ok4.content[0].text.startsWith("error:"), ok4.content[0].text);
  assert.ok(s.seen.logs.slice(before).some((l) => l.includes("no forcesave hook is registered")));
});

/* ------------------------------------------------------------------ */
/* office_comments                                                     */
/* ------------------------------------------------------------------ */

test("office_comments: docx lists comment ids/authors/text + grants; xlsx -> unsupported note", async () => {
  const s = setup();
  const doc = await createDoc({ title: "Commented", type: "word", owner: "chat-atlas-home" }, s.root);
  // inject a comments part into the stored bytes (mtime moves -- the tool re-reads the meta anyway)
  const file = path.join(s.root, "docs", doc.docId, `${doc.title}.${doc.ext}`);
  fs.writeFileSync(file, rewriteZip(readDocBytes(s.root, doc.docId), { "word/comments.xml": commentsXml([{ id: "c1", author: "Ada Person", text: "@agent please fix this" }, { id: "c2", author: "Bob", text: "second note" }]) }));
  addGrant(s.root, doc.docId, "chat-other", "c1");

  const res = (await tool(s, "office_comments").execute("cm", { id: doc.docId })) as ToolResult;
  const t = res.content[0].text;
  assert.ok(!t.startsWith("error:"), t);
  assert.match(t, /c1\s+Ada Person/);
  assert.match(t, /@agent please fix this/);
  assert.match(t, /c2\s+Bob/);
  assert.match(t, /chat-other.*via comment c1/s);
  assert.equal(res.details.comments.length, 2);
  assert.equal(res.details.grants[0].chatId, "chat-other");

  // a doc with no comments -> a readable "(none)", not an error
  const bare = await createDoc({ title: "Bare", type: "word", owner: "chat-atlas-home" }, s.root);
  const bareRes = (await tool(s, "office_comments").execute("cm2", { id: bare.docId })) as ToolResult;
  assert.match(bareRes.content[0].text, /Comments \(0\):\n\(none\)/);

  // xlsx: the unsupported note with the docs-style code prefix (comments arrive in M4)
  const sheet = await createDoc({ title: "Sheet", type: "cell", owner: "chat-atlas-home" }, s.root);
  assert.match(await refused(tool(s, "office_comments").execute("cm3", { id: sheet.docId }), "xlsx comments"), /^error:unsupported_format /);
});

/* ------------------------------------------------------------------ */
/* error string format (docs convention, office fix)                   */
/* ------------------------------------------------------------------ */

test("every refusal the agent reads starts with \"error:<code> \"", async () => {
  const s = setup();
  const doc = await createDoc({ title: "Fmt", type: "word", owner: "chat-atlas-home" }, s.root);
  const sheet = await createDoc({ title: "F2", type: "cell", owner: "chat-atlas-home" }, s.root);

  assert.match(await refused(tool(s, "office_read").execute("x1", { id: "nope" }), "not_found"), /^error:not_found /);
  const stale = await refused(tool(s, "office_edit").execute("x2", { id: doc.docId, ops: [{ quote: "New document", replacement: "r" }], baseRevision: getDoc(doc.docId, s.root)!.mtimeMs - 9000 }), "stale gate");
  assert.match(stale, /^error:revision_mismatch /);
  assert.match(await refused(tool(s, "office_edit").execute("x3", { id: doc.docId, ops: [], baseRevision: getDoc(doc.docId, s.root)!.mtimeMs }), "empty ops"), /^error:invalid /);
  assert.match(await refused(tool(s, "office_create").execute("x4", { title: "Fmt", type: "word" }), "exists"), /^error:exists /);
  assert.match(await refused(tool(s, "office_comments").execute("x5", { id: sheet.docId }), "xlsx comments"), /^error:unsupported_format /);
});

/* ------------------------------------------------------------------ */
/* the wake drain side (plan 5.4 step 4)                                */
/* ------------------------------------------------------------------ */

test("the factory also registers the UI_RECEIVE ping drain for office chats only", () => {
  const s = setup();
  (setup as any).__run();
  assert.equal(s.pi.uiHandlers.length, 1);
  // a non-ping bell is ignored without draining anything or throwing
  s.pi.uiHandlers[0]({ data: { type: "other" } });
  assert.equal(s.pi.sent.length, 0);

  const notes = makePi();
  registerTools({
    extend: (f) => f(notes, { id: "chat-notes" }),
    chatFolder: () => "/f/notes",
    folders: () => FOLDERS,
    inFolder: () => [],
    root: s.root,
    log: (l) => s.seen.logs.push(l),
  });
  assert.equal(notes.uiHandlers.length, 0); // no tools in a plain chat -> no drain either
});
