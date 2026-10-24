/**
 * Unit tests for src/store.ts: the document library (index + docs/<docId>/), CRUD, ownership/grant scoping,
 * import/export, the persistBytes REVISION GATE and trash sweeping. Templates are asserted to be REAL office
 * files by parsing them with src/ooxml.ts (parseDocx/parseXlsx). Every root is an mkdtemp dir in os.tmpdir() --
 * the real data dir and portal() are never touched.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import {
  listDocs, getDoc, docsForHome, createDoc, renameDoc, deleteDoc, sweepTrash,
  importFile, exportDoc, persistBytes, templateDocx, templateXlsx, slugify,
  scanWorkspace, pruneMissingDocs,
} from "../src/store";
import { parseDocx, parseXlsx } from "../src/ooxml";

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "office-store-"));
}

const docFile = (root: string, meta: { docId: string; title: string; ext: string }) => path.join(root, "docs", meta.docId, `${meta.title}.${meta.ext}`);

/* ---------------- templates ---------------- */

test("templateDocx: minimal docx parses with ooxml.parseDocx and carries real content", async () => {
  const buf = await templateDocx();
  assert.ok(buf.length > 500);
  const parsed = parseDocx(buf); // throws if the zip or word/document.xml is missing/broken
  assert.deepEqual(parsed.paragraphs, ["New document"]);
  assert.equal(parsed.comments.length, 0);
  // every part the contract names must be present in the archive
  const zip = await JSZip.loadAsync(buf);
  for (const name of ["[Content_Types].xml", "_rels/.rels", "word/document.xml", "word/styles.xml"]) assert.ok(zip.file(name), `missing ${name}`);
});

test("templateXlsx: minimal xlsx parses with ooxml.parseXlsx as one empty Sheet1", async () => {
  const buf = await templateXlsx();
  const parsed = parseXlsx(buf); // throws if workbook/rels/sheet parts are missing/broken
  assert.deepEqual(parsed.sheetNames, ["Sheet1"]);
  assert.deepEqual(parsed.sheets["Sheet1"], []);
  const zip = await JSZip.loadAsync(buf);
  for (const name of ["[Content_Types].xml", "_rels/.rels", "xl/workbook.xml", "xl/_rels/workbook.xml.rels", "xl/worksheets/sheet1.xml"]) assert.ok(zip.file(name), `missing ${name}`);
});

test("slugify: lowercase, non-alnum runs -> single dash, trimmed", () => {
  assert.equal(slugify("Quarterly Report  Q3"), "quarterly-report-q3");
  assert.equal(slugify("  --Weird__Name!! "), "weird-name");
});

/* ---------------- create / list / get ---------------- */

test("createDoc: word and cell write parseable templates into docs/<docId>/", async () => {
  const root = tmpRoot();
  const w = await createDoc({ title: "Quarterly Report", type: "word" }, root);
  assert.equal(w.ext, "docx");
  assert.match(w.docId, /^quarterly-report-[a-z0-9]{6}$/);
  assert.equal(parseDocx(fs.readFileSync(docFile(root, w))).text, "New document");
  assert.ok(w.sizeBytes > 0 && w.mtimeMs > 0);

  const c = await createDoc({ title: "Budget", type: "cell" }, root);
  assert.equal(c.ext, "xlsx");
  assert.match(c.docId, /^budget-[a-z0-9]{6}$/);
  assert.deepEqual(parseXlsx(fs.readFileSync(docFile(root, c))).sheetNames, ["Sheet1"]);

  // fresh index.json on disk, version 1
  const index = JSON.parse(fs.readFileSync(path.join(root, "index.json"), "utf8"));
  assert.equal(index.version, 1);
  assert.equal(index.docs.length, 2);
});

test("createDoc: duplicate (same title + type) throws code 'exists'; same title different type is fine", async () => {
  const root = tmpRoot();
  await createDoc({ title: "Report", type: "word" }, root);
  await assert.rejects(async () => createDoc({ title: "Report", type: "word" }, root), (err: Error) => err.code === "exists");
  // a spreadsheet with the same title is a different document, not a duplicate
  const cell = await createDoc({ title: "Report", type: "cell" }, root);
  assert.equal(cell.ext, "xlsx");
});

test("listDocs: titles ascending; getDoc miss -> null", async () => {
  const root = tmpRoot();
  const banana = await createDoc({ title: "Banana Plan", type: "word" }, root);
  const apple = await createDoc({ title: "apple notes", type: "word" }, root);
  assert.deepEqual(listDocs(root).map((d) => d.docId), [apple.docId, banana.docId]);
  assert.equal(getDoc("nope-123456", root), null);
  const found = getDoc(apple.docId, root);
  assert.ok(found && found.title === "apple notes");
});

/* ---------------- ownership / grants ---------------- */

test("docsForHome: owner path, grant path, dedupe of owned-and-granted doc; others' docs excluded", async () => {
  const root = tmpRoot();
  const homeA = "chat-A";
  const homeB = "chat-B";
  const owned = await createDoc({ title: "A owned doc", owner: homeA }, root);
  const granted = await createDoc({ title: "B doc granted to A", owner: homeB }, root);
  const stranger = await createDoc({ title: "C doc nobody shares", owner: "chat-C" }, root);

  // grant A access to the B doc (what ping.ts does on a mention)
  const index = JSON.parse(fs.readFileSync(path.join(root, "index.json"), "utf8"));
  const entry = index.docs.find((d: { docId: string }) => d.docId === granted.docId);
  entry.grants.push({ chatId: homeA, commentId: "c1", at: Date.now() });
  // the A-owned doc is ALSO granted to A: dedupe must keep it exactly once
  const ownedEntry = index.docs.find((d: { docId: string }) => d.docId === owned.docId);
  ownedEntry.grants.push({ chatId: homeA, commentId: "c2", at: Date.now() });
  fs.writeFileSync(path.join(root, "index.json"), JSON.stringify(index));

  const visible = docsForHome(homeA, root).map((d) => d.docId);
  assert.deepEqual(visible.sort(), [granted.docId, owned.docId].sort());
  assert.equal(visible.filter((id) => id === owned.docId).length, 1); // deduped
  assert.ok(!visible.includes(stranger.docId));

  const bView = docsForHome(homeB, root).map((d) => d.docId);
  assert.deepEqual(bView, [granted.docId]);
});

test("docsForHome: UNOWNED docs (workspace-scanned and human-made) are visible to EVERY home", async () => {
  const root = tmpRoot();
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "office-unowned-"));
  fs.writeFileSync(path.join(ws, "shared plan.docx"), Buffer.from("a shared docx of sorts"));
  assert.deepEqual(scanWorkspace([ws], root), { added: 1, updated: 0 });
  const scanned = getDoc(listDocs(root)[0].docId, root)!;
  assert.equal(scanned.owner, null);

  // a human-made doc (no owner passed) is shared too, while another home's OWNED doc stays private to it
  const human = await createDoc({ title: "Human-made" }, root);
  assert.equal(human.owner, null);
  const onlyB = await createDoc({ title: "B only", owner: "chat-B" }, root);

  for (const home of ["chat-A", "chat-C"]) {
    const visible = docsForHome(home, root).map((d) => d.docId);
    assert.ok(visible.includes(scanned.docId), `${home} sees the unowned scanned doc`);
    assert.ok(visible.includes(human.docId), `${home} sees the unowned human doc`);
    assert.ok(!visible.includes(onlyB.docId), `${home} does NOT see chat-B's owned doc`);
  }
  const bView = docsForHome("chat-B", root).map((d) => d.docId);
  assert.deepEqual(bView.sort(), [scanned.docId, human.docId, onlyB.docId].sort());
  fs.rmSync(ws, { recursive: true, force: true });
});

/* ---------------- rename / delete / trash ---------------- */

test("renameDoc: renames the file on disk, keeps bytes and mtimeMs, bumps updatedAt", async () => {
  const root = tmpRoot();
  const doc = await createDoc({ title: "Old Title" }, root);
  const oldBytes = fs.readFileSync(docFile(root, doc));
  const before = getDoc(doc.docId, root);
  assert.ok(before);

  const renamed = renameDoc(doc.docId, "New Title", root);
  assert.equal(renamed.docId, doc.docId); // stable across renames -- tickets/history key off it
  assert.equal(renamed.title, "New Title");
  assert.ok(!fs.existsSync(docFile(root, { ...doc, title: "Old Title" })));
  const newBytes = fs.readFileSync(docFile(root, renamed));
  assert.deepEqual(newBytes, oldBytes); // bytes untouched
  assert.equal(renamed.mtimeMs, before!.mtimeMs); // content mtime (the revision) is preserved by the rename
  assert.ok(renamed.updatedAt >= before!.updatedAt);
  // renaming onto another doc's title -> exists
  await createDoc({ title: "Taken", type: "word" }, root);
  assert.throws(() => renameDoc(doc.docId, "Taken", root), (err: Error) => err.code === "exists");
});

test("renameDoc on unknown id -> not_found", () => {
  const root = tmpRoot();
  assert.throws(() => renameDoc("ghost-123456", "X", root), (err: Error) => err.code === "not_found");
});

test("deleteDoc: moves docs/<docId> into .trash, prunes the index; unknown id -> not_found", async () => {
  const root = tmpRoot();
  const doc = await createDoc({ title: "Doomed", type: "word" }, root);
  deleteDoc(doc.docId, root);
  assert.ok(!fs.existsSync(path.join(root, "docs", doc.docId)));
  const trash = fs.readdirSync(path.join(root, ".trash"));
  assert.equal(trash.length, 1);
  assert.match(trash[0], new RegExp(`^\\d+-${doc.docId}$`));
  assert.ok(fs.existsSync(path.join(root, ".trash", trash[0], "Doomed.docx"))); // content kept for the TTL
  assert.equal(getDoc(doc.docId, root), null);
  assert.throws(() => deleteDoc(doc.docId, root), (err: Error) => err.code === "not_found");
});

test("sweepTrash: removes only entries older than 7 days", () => {
  const root = tmpRoot();
  const trash = path.join(root, ".trash");
  const oldStamp = Date.now() - 8 * 24 * 60 * 60 * 1000; // 8 days
  fs.mkdirSync(path.join(trash, `${oldStamp}-ancient-doc`), { recursive: true });
  fs.writeFileSync(path.join(trash, `${oldStamp}-ancient-doc`, "x.docx"), Buffer.from("z"));
  const freshStamp = Date.now() - 3600 * 1000; // 1h ago
  fs.mkdirSync(path.join(trash, `${freshStamp}-young-doc`), { recursive: true });
  fs.writeFileSync(path.join(trash, `${freshStamp}-young-doc`, "x.docx"), Buffer.from("z"));
  fs.mkdirSync(path.join(trash, "not-a-stamped-entry"), { recursive: true }); // no numeric prefix -- leave it alone

  const removed = sweepTrash(root);
  assert.equal(removed, 1);
  assert.ok(!fs.existsSync(path.join(trash, `${oldStamp}-ancient-doc`)));
  assert.ok(fs.existsSync(path.join(trash, `${freshStamp}-young-doc`)));
  assert.ok(fs.existsSync(path.join(trash, "not-a-stamped-entry")));

  // empty root: no .trash at all -> 0, no throw
  assert.equal(sweepTrash(tmpRoot()), 0);
});

/* ---------------- import / export ---------------- */

test("importFile: copies a real docx in (title from basename by default), records size and mtime", async () => {
  const root = tmpRoot();
  const srcRoot = tmpRoot();
  const template = await templateDocx();
  const src = path.join(srcRoot, "Client proposal FINAL.docx");
  fs.writeFileSync(src, template);

  const meta = importFile(src, {}, root);
  assert.equal(meta.title, "Client proposal FINAL");
  assert.equal(meta.ext, "docx");
  assert.match(meta.docId, /^client-proposal-final-[a-z0-9]{6}$/);
  const stored = fs.readFileSync(docFile(root, meta));
  assert.deepEqual(stored, template);
  assert.equal(parseDocx(stored).text, "New document");
  assert.deepEqual(meta.importedBaseline, []); // parseable source without comments -> empty baseline stamped at import time
  assert.equal(meta.sizeBytes, template.length);

  // explicit title + owner override the defaults
  const src2 = path.join(srcRoot, "grid.xlsx");
  fs.writeFileSync(src2, await templateXlsx());
  const meta2 = importFile(src2, { title: "Grid", owner: "chat-9" }, root);
  assert.equal(meta2.title, "Grid");
  assert.equal(meta2.owner, "chat-9");
});

test("importFile: .txt -> unsupported_format; missing file -> not_found; uppercase extension accepted", async () => {
  const root = tmpRoot();
  const srcRoot = tmpRoot();
  const txt = path.join(srcRoot, "notes.txt");
  fs.writeFileSync(txt, "hi");
  await assert.rejects(async () => importFile(txt, {}, root), (err: Error) => err.code === "unsupported_format");
  await assert.rejects(async () => importFile(path.join(srcRoot, "ghost.docx"), {}, root), (err: Error) => err.code === "not_found");

  const upper = path.join(srcRoot, "UPPER.DOCX");
  fs.writeFileSync(upper, await templateDocx());
  const meta = importFile(upper, {}, root);
  assert.equal(meta.ext, "docx"); // normalized to the stored extension
});

test("importFile: a file above 512 MiB is rejected with too_large before anything is copied", async () => {
  const root = tmpRoot();
  const srcRoot = tmpRoot();
  // Sparse on purpose: ftruncate advertises the size without writing 600 MiB of zeros (stat-based cap).
  const big = path.join(srcRoot, "huge.docx");
  const fd = fs.openSync(big, "w");
  try {
    fs.ftruncateSync(fd, 600 * 1024 * 1024);
  } finally {
    fs.closeSync(fd);
  }
  await assert.rejects(async () => importFile(big, {}, root), (err: Error) => err.code === "too_large" && /512 MiB/.test(err.message));
  assert.equal(listDocs(root).length, 0, "nothing landed in the library");
});

test("importFile: docx at/under 32 MiB stamps importedBaseline; above it leaves it undefined (ping fallback)", async () => {
  const root = tmpRoot();
  const srcRoot = tmpRoot();

  // under the cap: a real parseable docx with one comment -> baseline of its ids (the existing rule)
  const small = path.join(srcRoot, "small.docx");
  fs.writeFileSync(small, await templateDocx());
  const metaSmall = importFile(small, {}, root);
  assert.deepEqual(metaSmall.importedBaseline, [], "under-cap docx still parses and baselines (no comments in the template)");

  // above the cap: a sparse 33 MiB .docx -- no parsing happens at all, baseline unknown, first-save fallback applies
  const big = path.join(srcRoot, "big.docx");
  const fd = fs.openSync(big, "w");
  try {
    fs.ftruncateSync(fd, 33 * 1024 * 1024);
  } finally {
    fs.closeSync(fd);
  }
  const metaBig = importFile(big, {}, root);
  assert.equal(metaBig.importedBaseline, undefined, "above-cap docx skips the baseline; ping.ts baselines everything at first save");
  assert.ok(metaBig.sizeBytes > 32 * 1024 * 1024);
});

test("exportDoc: writes <title>.<ext> into a created dest dir and returns the absolute path", async () => {
  const root = tmpRoot();
  const doc = await createDoc({ title: "Export me", type: "word" }, root);
  const destDir = path.join(tmpRoot(), "out", "nested"); // must be created recursively
  const written = exportDoc(doc.docId, destDir, root);
  assert.equal(written, path.join(destDir, "Export me.docx"));
  assert.ok(path.isAbsolute(written));
  assert.deepEqual(parseDocx(fs.readFileSync(written)), parseDocx(fs.readFileSync(docFile(root, doc))));
  assert.throws(() => exportDoc("ghost-123456", destDir, root), (err: Error) => err.code === "not_found");
});

/* ---------------- persist gate ---------------- */

test("persistBytes: success writes the bytes, updates the index mtime/size and returns the new mtimeMs", async () => {
  const root = tmpRoot();
  const doc = await createDoc({ title: "Live" }, root);
  const oldMeta = getDoc(doc.docId, root);
  assert.ok(oldMeta);
  const saved = Buffer.from("saved-by-DS-" + "x".repeat(100));

  const res = persistBytes(oldMeta, saved, root);
  const fresh = fs.statSync(docFile(root, doc));
  assert.equal(res.mtimeMs, fresh.mtimeMs);
  const updated = getDoc(doc.docId, root);
  assert.ok(updated);
  assert.equal(updated!.mtimeMs, res.mtimeMs);
  assert.equal(updated!.sizeBytes, saved.length);
  assert.deepEqual(fs.readFileSync(docFile(root, doc)), saved); // the bytes really landed
});

test("persistBytes: a stale meta (external write moved the mtime) throws revision_mismatch with currentMtimeMs", async () => {
  const root = tmpRoot();
  const doc = await createDoc({ title: "Contended" }, root);
  const staleMeta = getDoc(doc.docId, root);
  assert.ok(staleMeta);

  // an external writer (another DS session / the agent) rewrites the file and pushes its mtime far forward
  const file = docFile(root, doc);
  fs.writeFileSync(file, Buffer.from("someone else saved this"));
  const forced = new Date(Date.now() + 60_000).getTime(); // a definitely-distinct mtime
  fs.utimesSync(file, forced / 1000, forced / 1000);
  const currentMtimeMs = fs.statSync(file).mtimeMs;
  assert.notEqual(currentMtimeMs, staleMeta.mtimeMs);

  await assert.rejects(
    (async () => persistBytes(staleMeta, Buffer.from("my stale save"), root))(),
    (err: Error) => {
      assert.equal(err.code, "revision_mismatch");
      assert.equal((err as NodeJS.ErrnoException & { currentMtimeMs?: number }).currentMtimeMs, currentMtimeMs);
      return true;
    },
  );
  // the library file is untouched by the refused write
  assert.deepEqual(fs.readFileSync(file), Buffer.from("someone else saved this"));
});

test("persistBytes: an FRESH meta after the external write persists again (the gate clears)", async () => {
  const root = tmpRoot();
  const doc = await createDoc({ title: "Retry" }, root);
  const file = docFile(root, doc);
  fs.writeFileSync(file, Buffer.from("newer content"));
  const freshMeta = getDoc(doc.docId, root) ?? undefined; // re-read: still the OLD index mtime -> would mismatch
  assert.ok(freshMeta);
  // but persistBytes with the stale index meta must fail...
  await assert.rejects((async () => persistBytes(freshMeta, Buffer.from("z"), root))(), (err: Error) => err.code === "revision_mismatch");
});

/* ---------------- end-to-end-ish ---------------- */

test("a full round-trip: create -> edit bytes through the gate -> export is parseable", async () => {
  const root = tmpRoot();
  const doc = await createDoc({ title: "Round Trip" }, root);
  let meta = getDoc(doc.docId, root)!;
  for (let i = 0; i < 3; i++) {
    const bytes = Buffer.from(`revision ${i} of the round trip document`);
    await new Promise((r) => setTimeout(r, 2)); // let mtime advance so successive persists are distinct revisions
    const res = persistBytes(meta, bytes, root);
    meta = getDoc(doc.docId, root)!;
    assert.equal(meta.mtimeMs, res.mtimeMs);
  }
  const out = exportDoc(doc.docId, path.join(tmpRoot(), "rt"), root);
  assert.equal(fs.readFileSync(out).toString("utf8"), "revision 2 of the round trip document");
});

/* ---------------- workspace scan (in-place indexing, replaces manual import) ---------------- */

test("scanWorkspace: discovers nested docx/xlsx case-insensitively; skips hidden dirs, node_modules, .txt", () => {
  const root = tmpRoot();
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "office-scan-ws-"));
  fs.writeFileSync(path.join(ws, "alpha.docx"), Buffer.from("bytes a"));
  fs.mkdirSync(path.join(ws, "nested", "deeper"), { recursive: true });
  fs.writeFileSync(path.join(ws, "nested", "deeper", "BETA.XLSX"), Buffer.from("bytes b")); // uppercase ext counts
  fs.mkdirSync(path.join(ws, ".cache"));
  fs.writeFileSync(path.join(ws, ".cache", "hidden.docx"), Buffer.from("nope"));
  fs.mkdirSync(path.join(ws, "node_modules", "pkg"), { recursive: true });
  fs.writeFileSync(path.join(ws, "node_modules", "pkg", "vendor.docx"), Buffer.from("nope"));
  fs.writeFileSync(path.join(ws, "readme.txt"), "not office");

  const out = scanWorkspace([ws], root);
  assert.deepEqual(out, { added: 2, updated: 0 });
  const docs = listDocs(root);
  assert.deepEqual(docs.map((d) => d.title), ["alpha", "BETA"], "listDocs keeps its localeCompare order even with a mixed-case title");
  for (const doc of docs) {
    assert.equal(doc.path, path.join(ws, doc.title === "alpha" ? "alpha.docx" : path.join("nested", "deeper", "BETA.XLSX")), "points at the real file in place");
    assert.equal(doc.owner, null); // unowned human doc: docsForHome shows it to every home
    assert.ok(fs.existsSync(doc.path!)); // IN PLACE: no copy was made
  }
  fs.rmSync(ws, { recursive: true, force: true });
});

test("scanWorkspace: never indexes the library's own dir (docs/ or .trash), even when it is passed as a root", async () => {
  const root = tmpRoot();
  await createDoc({ title: "Inside The Library", type: "word" }, root); // lives in docs/<id>/ -- must stay unindexed-as-scanned
  fs.mkdirSync(path.join(root, ".trash"));
  fs.writeFileSync(path.join(root, ".trash", "old.docx"), Buffer.from("trash stays trash"));

  const out = scanWorkspace([root], root); // the data dir IS a root: the whole walk must refuse to enter it
  assert.deepEqual(out, { added: 0, updated: 0 });
  const doc = listDocs(root)[0];
  assert.equal(doc.path, undefined, "the library-created doc has no path and is not re-indexed over itself");
});

test("scanWorkspace: a second scan refreshes changed mtime/size in place; untouched files do not count as updated", () => {
  const root = tmpRoot();
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "office-scan-refresh-"));
  fs.writeFileSync(path.join(ws, "one.docx"), Buffer.from("12345"));
  fs.writeFileSync(path.join(ws, "two.xlsx"), Buffer.from("abcdef"));
  assert.deepEqual(scanWorkspace([ws], root), { added: 2, updated: 0 });

  assert.deepEqual(scanWorkspace([ws], root), { added: 0, updated: 0 }, "immediately rescanning changes nothing");

  fs.writeFileSync(path.join(ws, "one.docx"), Buffer.from("123456789")); // grew AND got a new mtime
  const out = scanWorkspace([ws], root);
  assert.deepEqual(out, { added: 0, updated: 1 }, "only the file that actually changed counts as refreshed");
  const one = getDoc(listDocs(root).find((d) => d.title === "one")!.docId, root)!;
  assert.equal(one.sizeBytes, 9);
  assert.ok(Math.abs(one.mtimeMs - fs.statSync(path.join(ws, "one.docx")).mtimeMs) < 50);

  // and the refreshed doc still persists through the mtime gate: its revision IS the file's own mtime
  const saved = persistBytes(one, Buffer.from("123456789X"), root);
  assert.equal(saved.mtimeMs, fs.statSync(path.join(ws, "one.docx")).mtimeMs);
  fs.rmSync(ws, { recursive: true, force: true });
});

test("scanWorkspace stamps DocMeta.workspace: first path segment under the DEEPEST scan root containing the file; a direct child takes the root's own dir name", () => {
  const root = tmpRoot();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "office-wslabel-"));
  const repos = path.join(base, "repos"); // an inner root (e.g. a repo dir) nested under another one
  const home = path.join(base, "homes", "acme"); // a home root; the deepest root for its files
  fs.mkdirSync(path.join(repos, "pithagoras", "extensions"), { recursive: true });
  fs.mkdirSync(path.join(home, "plans"), { recursive: true });
  fs.writeFileSync(path.join(repos, "pithagoras", "extensions", "sample.docx"), Buffer.from("a docx of sorts"));
  fs.writeFileSync(path.join(repos, "top.xlsx"), Buffer.from("an xlsx straight in the inner root"));
  fs.writeFileSync(path.join(home, "readme.docx"), Buffer.from("directly in the home root"));
  fs.writeFileSync(path.join(home, "plans", "q3.xlsx"), Buffer.from("nested in the home"));

  // base is ALSO a root: the deepest matching root must label, not the broadest (via base, sample would read "repos")
  assert.deepEqual(scanWorkspace([base, repos, home], root), { added: 4, updated: 0 });
  const byTitle = new Map(listDocs(root).map((d) => [d.title, d.workspace]));
  assert.equal(byTitle.get("sample"), "pithagoras", "first path segment under the deepest containing root (repos, not base)");
  assert.equal(byTitle.get("top"), "repos", "a file straight in a root takes that root's OWN dir name, not its own file name");
  assert.equal(byTitle.get("readme"), "acme", "a home-root file takes the home's dir name");
  assert.equal(byTitle.get("q3"), "plans", "a nested file takes its first segment under the root");
  fs.rmSync(base, { recursive: true, force: true });
});

test("scanWorkspace rescan BACKFILLS DocMeta.workspace on entries indexed before the stamp (counted as refreshed exactly once)", () => {
  const root = tmpRoot();
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "office-wsbackfill-"));
  fs.mkdirSync(path.join(ws, "pithagoras", "fixtures"), { recursive: true });
  fs.writeFileSync(path.join(ws, "pithagoras", "fixtures", "sample.docx"), Buffer.from("a docx of sorts"));
  assert.deepEqual(scanWorkspace([ws], root), { added: 1, updated: 0 });

  // simulate an older index.json (pre-stamp): the entry's workspace field is simply absent
  const indexPathFile = path.join(root, "index.json");
  const idx = JSON.parse(fs.readFileSync(indexPathFile, "utf8"));
  delete idx.docs[0].workspace;
  fs.writeFileSync(indexPathFile, JSON.stringify(idx));
  assert.equal(listDocs(root)[0].workspace, undefined);

  const second = scanWorkspace([ws], root);
  assert.deepEqual(second, { added: 0, updated: 1 }, "the backfill counts as a refresh, once");
  assert.equal(listDocs(root)[0].workspace, "pithagoras", "the existing entry picked up its label on the rescan");

  const third = scanWorkspace([ws], root);
  assert.deepEqual(third, { added: 0, updated: 0 }, "idempotent once backfilled");
  fs.rmSync(ws, { recursive: true, force: true });
});

test("scanWorkspace: skips files whose basename cannot be a title or busts the size cap; a collision on title does not sink the sweep", () => {
  const root = tmpRoot();
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "office-scan-bad-"));
  fs.writeFileSync(path.join(ws, "bad\tname.docx"), Buffer.from("control char in a title: skipped, not indexed"));
  fs.writeFileSync(path.join(ws, "hugemem.docx"), Buffer.alloc(1)); // size is faked below with sparse write
  fs.rmSync(path.join(ws, "hugemem.docx"));
  const huge = fs.openSync(path.join(ws, "hugemem.docx"), "w");
  fs.ftruncateSync(huge, 513 * 1024 * 1024); // just above the 512 MiB cap: sparse file, no real I/O
  fs.closeSync(huge);
  fs.writeFileSync(path.join(ws, "same.docx"), Buffer.from("first"));
  const ws2 = fs.mkdtempSync(path.join(os.tmpdir(), "office-scan-bad2-"));
  fs.writeFileSync(path.join(ws2, "same.docx"), Buffer.from("second -- same title in another folder: skipped by the guard"));

  const out = scanWorkspace([ws, ws2], root);
  assert.deepEqual(out, { added: 1, updated: 0 }, "only 'same' from the first root survived: bad title, over cap and title collision are all quiet skips");
  assert.equal(listDocs(root)[0].title, "same");
  fs.rmSync(ws, { recursive: true, force: true });
  fs.rmSync(ws2, { recursive: true, force: true });
});

test("deleteDoc on a scanned doc moves its REAL file to the office trash; an already-vanished file is a clean prune, not ENOENT", () => {
  const root = tmpRoot();
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "office-scan-del-"));
  fs.writeFileSync(path.join(ws, "doomed.docx"), Buffer.from("soon to be trashed"));
  scanWorkspace([ws], root);
  const doc = listDocs(root)[0];

  deleteDoc(doc.docId, root); // the real workspace file is what moves
  assert.ok(!fs.existsSync(path.join(ws, "doomed.docx")), "the workspace file is gone from its folder");
  const trash = fs.readdirSync(path.join(root, ".trash"));
  assert.equal(trash.length, 1, "exactly one entry landed in the office trash -- recoverable for 7 days");
  assert.equal(fs.readFileSync(path.join(root, ".trash", trash[0]), "utf8"), "soon to be trashed");
  assert.equal(listDocs(root).length, 0);

  // a file deleted OUT-OF-BAND (no one asked the library): deleting its index entry must not ENOENT
  fs.writeFileSync(path.join(ws, "walked.docx"), Buffer.from("leaving on its own"));
  scanWorkspace([ws], root);
  const gone = listDocs(root)[0];
  fs.rmSync(path.join(ws, "walked.docx")); // the workspace itself loses the file
  deleteDoc(gone.docId, root); // and: no throw, just the index drop -- pruneMissingDocs semantics on demand
  assert.equal(listDocs(root).length, 0);

  // and pruneMissingDocs agrees with that: it drops the orphaned entry, nothing else
  fs.writeFileSync(path.join(ws, "fleeing.docx"), Buffer.from("gone before the sweep"));
  scanWorkspace([ws], root);
  fs.rmSync(path.join(ws, "fleeing.docx"));
  const fleeingId = listDocs(root)[0].docId;
  assert.deepEqual(pruneMissingDocs(root), [fleeingId], "the orphaned scanned entry is dropped by the next settleKept");
  assert.equal(listDocs(root).length, 0);
  fs.rmSync(ws, { recursive: true, force: true });
});
