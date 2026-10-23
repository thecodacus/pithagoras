/**
 * Integration tests for pithagoras-office (contract "tests (W5)" / plan 7 "Integration"), each skipped
 * with a clear reason when the gate below does not hold. What they assert, exactly as the contract lists:
 *
 *   1. A ticketed GET on the REAL loopback listener serves a document LARGER than 1 MB byte-for-byte
 *      (the whole reason the cookie-free listener exists is that portal-managed files cap at MAX_EDIT_BYTES
 *      = 1 MB -- core/server/src/workspace-files.ts:47) and rejects an expired ticket.
 *   2. A synthetic OnlyOffice callback with status 2 arrives on the loopback POST /callback WITHOUT any
 *      session cookie, persists (bytes on disk changed to exactly what body.url served), bumps the index
 *      revision, writes history/<doc>/<rev>.zip from changesurl, and clears the lock AFTER the persist.
 *   3. office_edit against a doc with a live human session present: the forcesave hook is AWAITED before
 *      the edit's own persistBytes runs (observable via the injected counter seam setForcesaveHook), and a
 *      revision that moves DURING the hook surfaces as error:revision_mismatch -- nothing is overwritten.
 *
 * The gate (why it is an env flag + a docker CLI probe instead of host.docker()): the contract says these
 * tests are "docker-gated on docker.available()", but src/host.ts' docker() mirrors the portal's
 * extensions.use("pithagoras-docker") -- it only exists inside a RUNNING portal process, and this file (like
 * every unit test) must never reach portal(). The closest honest probe OUTSIDE a portal is: the operator
 * has declared intent via OFFICE_IT_DOCKER=1 AND `docker info` answers from the CLI. When both hold we
 * assume the operator pre-started the DS container per the plan's M0 procedure; these three assertions
 * themselves run against a tmp dataDir + the real in-process loopback listener, with a tiny second ephemeral
 * server standing in for the DS download endpoint (body.url / changesurl), so they exercise exactly the
 * HTTP boundary a real DS crosses. The full save-loop-with-real-DS-url and the DocEditor browser assertions
 * of plan 7 stay deferred to a Playwright/CI environment with a running portal -- not invented here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import type { ServerPortal } from "@pithagoras/extension-api/server";
import officeServer, { jwtSecret, loopbackPort } from "../src/server";
import * as store from "../src/store";
import * as live from "../src/live";
import { mintTicket } from "../src/tickets";
import { signJwt } from "../src/jwt";
import { makeKey } from "../src/callback";
import { parseDocx, rewriteZip } from "../src/ooxml";
import { registerTools, setForcesaveHook, __resetToolsForTests } from "../src/tools";

const FIXTURES = fileURLToPath(new URL("../fixtures/", import.meta.url));
/** The committed sample docx doubles as the "what the DS saved" payload in test 2: it differs from the
 * blank store template on disk, so "bytes changed" is a meaningful assertion. */
const SAVED_DOCX = fs.readFileSync(`${FIXTURES}sample.docx`);

/* ------------------------------------------------------------------ */
/* the docker gate                                                     */
/* ------------------------------------------------------------------ */

/** Reason every test below must be skipped, or undefined when the gate holds. */
function gateReason(): string | undefined {
  if (process.env.OFFICE_IT_DOCKER !== "1") {
    return 'docker-gated integration test: set OFFICE_IT_DOCKER=1 to run it (plan M0 procedure -- the operator starts the DS container first; host.docker() is unusable outside a running portal process)';
  }
  const probe = spawnSync("docker", ["info"], { encoding: "utf8", timeout: 20_000 });
  if (probe.error) return `docker-gated: the docker CLI is unreachable (${(probe.error as Error).code ?? (probe.error as Error).message})`;
  if (probe.status !== 0) return `docker-gated: "docker info" exited ${probe.status}`;
  return undefined; // a working docker host exists -- proceed
}

const SKIP = gateReason();
/** Register an integration test; node:test reports it as skipped with the reason when SKIP is set. */
function IT(name: string, fn: () => Promise<void>): void {
  test(name, { skip: SKIP }, fn);
}

/* ------------------------------------------------------------------ */
/* booting the real server half against a tmp dataDir + fake portal    */
/* ------------------------------------------------------------------ */

interface Booted {
  root: string;
  logs: string[];
  audits: Array<Record<string, unknown>>;
  cleanup: () => Promise<void>;
}

/** The REAL officeServer entry (routes registered on a no-op router, the REAL loopback listener bound to an
 * ephemeral 127.0.0.1 port) over a tmp dataDir and a recording fake portal. The fake Docker literal answers
 * available()=false so lookAfter never tries to touch anything; settings default disabled keeps it quiet. */
async function boot(): Promise<Booted> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "office-it-"));
  const logs: string[] = [];
  const audits: Array<Record<string, unknown>> = [];
  const fakeDocker = { available: async () => false } as Record<string, unknown>;
  const portalObj = {
    dataDir: () => root,
    log: (l: unknown) => logs.push(String(l)),
    audit: { record: (e: Record<string, unknown>) => audits.push(e) },
    router: { get() {}, post() {}, put() {}, delete() {} }, // UI routes are covered by server.test.mts; the listener is what this file drives
    http: { json: () => (_a?: unknown, _b?: unknown, next?: () => void) => next?.(), text: () => (_a?: unknown, _b?: unknown, next?: () => void) => next?.(), raw: () => () => {}, send: () => () => {}, upgrade: () => undefined },
    folders: { list: () => [] as never[], allowed: () => false, label: () => ({ name: "" }) },
    chats: { extend: () => {}, get: () => undefined, list: () => [], inFolder: () => [] as never[], folder: () => { throw new Error("no workspace folder"); }, send: () => {}, tell: async () => false },
    extensions: { use: () => fakeDocker },
  } as unknown as ServerPortal;
  const cleanup = await officeServer(portalObj);
  return { root, logs, audits, cleanup };
}

function closeServer(server: http.Server): Promise<void> {
  server.closeAllConnections(); // drop undici keep-alives so close() actually finishes
  return new Promise((resolve) => server.close(() => resolve()));
}

/* ------------------------------------------------------------------ */
/* 1. ticketed GET > 1 MB                                              */
/* ------------------------------------------------------------------ */

IT("ticketed GET on the real loopback listener serves a >1 MB document byte-for-byte and rejects an expired ticket", async () => {
  const b = await boot();
  try {
    const doc = await store.createDoc({ title: "Heavy Report", type: "word" }, b.root);

    // A REAL .docx over 1 MB, built through this extension's own writer (rewriteZip of the store template).
    // Most of the size is one incompressible run: deflate would otherwise shrink repetitive filler below the
    // cap and the test would stop proving what it claims. The document still opens/parses -- parseDocx below.
    const blob = randomBytes(1_300_000).toString("base64"); // 1.7 MB of text that survives deflate (random bytes -> base64)
    const filler = Array.from({ length: 200 }, (_, i) => `<w:p><w:r><w:t xml:space="preserve">filler line ${i + 1} of the heavy integration fixture</w:t></w:r></w:p>`).join("");
    const bigXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Heavy document</w:t></w:r></w:p>${filler}<w:p><w:r><w:t xml:space="preserve">${blob}</w:t></w:r></w:p></w:body></w:document>`;
    const big = rewriteZip(await store.templateDocx(), { "word/document.xml": bigXml });
    assert.ok(big.length > 1024 * 1024, `the built document is ${big.length} bytes (>1 MB)`);

    store.persistBytes(doc, big, b.root); // the meta we hold still matches -- straight through the gate
    const fresh = store.getDoc(doc.docId, b.root)!;
    assert.ok(fresh.sizeBytes > 1024 * 1024, `the index sizeBytes is ${fresh.sizeBytes} (>1 MB)`);

    const secret = jwtSecret(b.root);
    const { token } = mintTicket(fresh.docId, 600_000, secret);
    // node's fetch carries no cookie jar: this request -- like the DS's own GET -- crosses without a session cookie.
    const r = await fetch(`http://127.0.0.1:${loopbackPort()}/doc/${token}`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("content-type"), "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    assert.equal(r.headers.get("cache-control"), "no-store");
    const served = Buffer.from(await r.arrayBuffer());
    assert.ok(served.length > 1024 * 1024, `the wire payload is ${served.length} bytes -- past the portal-files 1 MB cap`);
    const onDisk = fs.readFileSync(path.join(b.root, "docs", fresh.docId, "Heavy Report.docx"));
    assert.equal(Buffer.compare(served, onDisk), 0, "the served bytes are exactly the library bytes");
    // and it is a real Word document end to end, not just bytes:
    assert.ok(parseDocx(served).text.startsWith("Heavy document"), "the heavy doc still parses as docx");

    const { token: dead } = mintTicket(fresh.docId, -1_000, secret); // negative ttl -> already expired at mint time
    const r2 = await fetch(`http://127.0.0.1:${loopbackPort()}/doc/${dead}`);
    assert.equal(r2.status, 401);
    assert.deepEqual(await r2.json(), { error: "invalid or expired document ticket", code: "bad_ticket" });

    live.clearDoc(fresh.docId);
  } finally {
    await b.cleanup();
  }
});

/* ------------------------------------------------------------------ */
/* 2. synthetic status-2 callback without a session cookie             */
/* ------------------------------------------------------------------ */

IT("synthetic status-2 callback WITHOUT any session cookie: persist happened (bytes changed, index bumped, history zip written) and the lock cleared", async () => {
  const b = await boot();
  try {
    // The listener's POST /callback was configured at boot to read this tmp root's ds.json + jwt-secret on
    // every request -- so writing the record here is what turns the endpoint from 503 into live.
    fs.writeFileSync(path.join(b.root, "ds.json"), JSON.stringify({ containerId: "it-cid", origin: "http://127.0.0.1", imageTag: "onlyoffice/documentserver:10.0" }));
    const doc = await store.createDoc({ title: "Round Trip", type: "word" }, b.root);

    // A stand-in for the DS download endpoint (body.url / changesurl): a second ephemeral loopback server
    // serving the "saved" bytes (our committed fixture docx -- different from the on-disk template) and a
    // fixed changes archive. This is exactly the URL pair a real DS callback would carry.
    const changesArchive = Buffer.concat([Buffer.from("PK\x03\x04"), randomBytes(1024)]);
    let hits: string[] = [];
    const dsStandin = http.createServer((req, res) => {
      if (req.method === "GET" && req.url === "/saved") {
        hits.push("saved");
        res.writeHead(200, { "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
        res.end(SAVED_DOCX);
        return;
      }
      if (req.method === "GET" && req.url === "/changes.zip") {
        hits.push("changes.zip");
        res.writeHead(200, { "Content-Type": "application/zip" });
        res.end(changesArchive);
        return;
      }
      res.writeHead(404);
      res.end("nope");
    });
    await new Promise<void>((resolve, reject) => { dsStandin.once("error", reject); dsStandin.listen(0, "127.0.0.1", () => resolve()); });
    const dsPort = (dsStandin.address() as AddressInfo).port;

    // The state a status-1 join would have left: one human present, the lock flag set.
    live.setUser(doc.docId, { id: "u-sam", name: "Sam" }, true);
    live.setLocked(doc.docId, true);
    const before = store.getDoc(doc.docId, b.root)!;

    // The DS envelope, signed with THIS tmp root's boot secret -- the same value server.ts created on disk.
    const secret = jwtSecret(b.root);
    const envelope = {
      key: makeKey(before.docId, before.mtimeMs), // the only key shape this package mints
      status: 2, // ready for saving: terminal close
      url: `http://127.0.0.1:${dsPort}/saved`,
      changesurl: `http://127.0.0.1:${dsPort}/changes.zip`,
    };
    const token = signJwt(envelope, 60_000, secret);

    // POSTed to the loopback listener exactly as DS would (X-Auth-Token per the container env) -- node's fetch
    // sends no cookies, so structurally NOTHING like a session cookie crosses on this request.
    const r = await fetch(`http://127.0.0.1:${loopbackPort()}/callback`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-auth-token": token },
      body: JSON.stringify(envelope),
    });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { error: 0 }, "DS reads the JSON error field; 0 is the only success");

    const after = store.getDoc(before.docId, b.root)!;
    const onDisk = fs.readFileSync(path.join(b.root, "docs", before.docId, "Round Trip.docx"));
    assert.equal(Buffer.compare(onDisk, SAVED_DOCX), 0, "the bytes the callback downloaded are now the library bytes");
    assert.ok(parseDocx(onDisk).comments.length === 2, "and they really ARE a docx -- our own parser reads it back");
    assert.notEqual(after.mtimeMs, before.mtimeMs, "the index revision (mtimeMs) bumped with the persist");
    assert.equal(after.sizeBytes, SAVED_DOCX.length);
    const historyZip = path.join(b.root, "history", before.docId, `${after.mtimeMs}.zip`);
    assert.ok(fs.existsSync(historyZip), `the changes archive is stored at history/<doc>/<rev>.zip (${historyZip})`);
    assert.equal(Buffer.compare(fs.readFileSync(historyZip), changesArchive), 0, "the stored archive is exactly what changesurl served");
    assert.deepEqual(hits.sort(), ["changes.zip", "saved"], "the listener fetched BOTH urls through the loopback path");
    assert.deepEqual(live.usersOf(before.docId), [], "presence cleared by the status-2 terminal close");
    assert.equal(live.isLocked(before.docId), false, "the lock flag cleared AFTER the persist landed");

    await closeServer(dsStandin);
  } finally {
    live.resetLive();
    await b.cleanup();
  }
});

/* ------------------------------------------------------------------ */
/* 3. forcesave ordering + mid-flight revision bump                    */
/* ------------------------------------------------------------------ */

IT("office_edit with a live session: the forcesave hook is AWAITED before the edit persists; a revision bump during the hook surfaces as revision_mismatch", async () => {
  __resetToolsForTests(); // this file's process starts clean; be explicit
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "office-it-tools-"));
  const home = "chat-aegis-home";

  // Register through the REAL tools seams: an agent folder whose home chat owns what it edits.
  type ToolDef = { name: string; execute: (callId: unknown, params: Record<string, unknown>) => Promise<unknown> };
  const tools2: Record<string, ToolDef> = {};
  registerTools({
    root,
    extend: (factory) => factory({ registerTool: (def: ToolDef) => { tools2[def.name] = def; } }, { id: home }),
    chatFolder: () => "/workspaces/aegis",
    folders: () => [{ path: "/workspaces/aegis", name: "aegis", kind: "agent" }],
    inFolder: () => [{ id: home }],
    record: () => {}, log: () => {},
  });
  assert.ok(tools2.office_edit, "office_edit registered into the agent home (ownership scope is real here)");

  /* Scenario A -- ordering without a bump: the hook's counter must show it ran to completion BEFORE the
   * edit's own persist landed; while it runs, the OLD bytes are still on disk. */
  const docA = await store.createDoc({ title: "Order Doc", type: "word", owner: home }, root); // template says "New document"
  live.setUser(docA.docId, { id: "u-sam", name: "Sam" }, true); // a fake human with the editor open (coEdit default ON)
  const fileA = path.join(root, "docs", docA.docId, "Order Doc.docx");
  const eventsA: string[] = [];
  let hookSawOriginalBytes = false;
  setForcesaveHook(async () => {
    eventsA.push("hook:start");
    // The library file is a zip, so "the old content" is checked through our own parser, not raw bytes.
    hookSawOriginalBytes = parseDocx(fs.readFileSync(fileA)).text.includes("New document"); // still the pre-edit content while the hook runs
    await new Promise((r) => setTimeout(r, 25)); // a slow status-6 round-trip to DS, simulated
    eventsA.push("hook:end");
  });
  await tools2.office_edit.execute(null, { id: docA.docId, ops: [{ quote: "New document", replacement: "Edited by the agent" }], baseRevision: docA.mtimeMs });
  setForcesaveHook(null);
  eventsA.push("edit:resolved"); // recorded only after office_edit -- and its persistBytes -- finished
  assert.deepEqual(eventsA, ["hook:start", "hook:end", "edit:resolved"], "the hook fully resolved BEFORE the edit (and its persist) completed");
  assert.ok(hookSawOriginalBytes, "while the hook ran, the pre-edit bytes were still on disk -- the edit's persistBytes cannot have run yet");
  assert.ok(parseDocx(fs.readFileSync(fileA)).text.includes("Edited by the agent"), "the edit landed at a new revision afterwards");
  assert.notEqual(store.getDoc(docA.docId, root)!.mtimeMs, docA.mtimeMs);

  /* Scenario B -- a bump MID-FLIGHT: the hook's own save moves the revision, so office_edit must refuse
   * error:revision_mismatch and leave the human's (the hook's) bytes on disk. */
  const docB = await store.createDoc({ title: "Bump Doc", type: "word", owner: home }, root);
  live.setUser(docB.docId, { id: "u-sam", name: "Sam" }, true);
  const fileB = path.join(root, "docs", docB.docId, "Bump Doc.docx");
  const eventsB: string[] = [];
  setForcesaveHook(async (d: string) => {
    eventsB.push("hook:start");
    store.persistBytes(store.getDoc(d, root)!, SAVED_DOCX, root); // the DS forcesave lands a NEWER revision under our feet
    await new Promise((r) => setTimeout(r, 10)); // >1 ms apart so mtime-as-revision actually moves (the gate's threshold)
    eventsB.push("hook:persisted-newer-revision");
  });
  let thrown: unknown;
  try {
    await tools2.office_edit.execute(null, { id: docB.docId, ops: [{ quote: "New document", replacement: "should never land" }], baseRevision: docB.mtimeMs });
  } catch (e) {
    thrown = e;
  } finally {
    setForcesaveHook(null);
  }
  assert.ok(thrown instanceof Error, "office_edit refused");
  assert.match((thrown as Error).message, /^error:revision_mismatch /, `the refusal carries the coded prefix (got: ${(thrown as Error).message})`);
  assert.deepEqual(eventsB.slice(0, 2), ["hook:start", "hook:persisted-newer-revision"], "the hook -- including its persist -- completed before the re-gate refused");
  assert.equal(Buffer.compare(fs.readFileSync(fileB), SAVED_DOCX), 0, "the HUMAN's forcesave is what stayed on disk; the agent edit never wrote");

  __resetToolsForTests();
  live.resetLive();
});
