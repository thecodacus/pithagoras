/**
 * Unit tests for src/callback.ts (+ src/live.ts): the DS callback state machine of plan 5.3. Everything is
 * self-contained -- tmp data dirs, self-minted HS256 JWTs, a LOCAL node:http server standing in for the
 * Document Server's saved-file/changes endpoints, and synthetic IncomingMessage/ServerResponse pairs (a
 * Readable stream + a recording object). Nothing here reaches portal() or the real data dir: every handler is
 * built with createCallbackHandler with an explicit root; only the bare handleCallback/configure test touches
 * module-level wiring (and still only status-4, which writes nothing).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { Readable } from "node:stream";
import { createHmac, createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { signJwt, verifyJwt } from "../src/jwt";
import {
  CallbackState, configure, createCallbackHandler, handleCallback, makeKey, onPersisted, parseKey, revHashOf,
} from "../src/callback";
import { createDoc, getDoc } from "../src/store";
import * as live from "../src/live";

const SECRET = "unit-test-secret-0123456789abcdef";
const DS_STATE: CallbackState = { containerId: "cid-1", origin: "http://127.0.0.1", imageTag: "onlyoffice/documentserver:10.0" };

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "office-callback-"));
}

const docFile = (root: string, meta: { docId: string; title: string; ext: string }): string =>
  path.join(root, "docs", meta.docId, `${meta.title}.${meta.ext}`);

/* ------------------------------------------------------------------ */
/* synthetic req/res + the local "DS" file server                      */
/* ------------------------------------------------------------------ */

type FakeRes = {
  statusCode: number;
  body: string;
  headersSent: boolean;
  ended: boolean;
  finished: Promise<void>;
  writeHead(code: number, headers?: Record<string, string>): void;
  end(chunk?: string | Buffer): void;
};

function makeRes(): FakeRes {
  const res = { statusCode: 0, body: "", headersSent: false, ended: false, _done: null as null | (() => void) } as FakeRes & { _done: null | (() => void) };
  res.finished = new Promise<void>((r) => (res._done = r));
  res.writeHead = function (code: number): void {
    this.statusCode = code;
    this.headersSent = true;
  };
  res.end = function (chunk?: string | Buffer): void {
    if (chunk !== undefined && chunk !== null) this.body += chunk.toString();
    this.ended = true;
    res._done?.();
  };
  return res;
}

function makeReq(method: string, url: string, headers: Record<string, string>, bodyObj: unknown): IncomingMessage {
  const stream = Readable.from([Buffer.from(JSON.stringify(bodyObj))]);
  Object.assign(stream, { method, url, headers });
  return stream as unknown as IncomingMessage;
}

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

async function post(handler: Handler, body: Record<string, unknown>, opts: { method?: string; url?: string; headers?: Record<string, string> } = {}): Promise<FakeRes> {
  const res = makeRes();
  handler(makeReq(opts.method ?? "POST", opts.url ?? "/callback", opts.headers ?? {}, body), res as unknown as ServerResponse);
  await res.finished;
  return res;
}

const json = (res: FakeRes): Record<string, unknown> => JSON.parse(res.body) as Record<string, unknown>;

/** A local node:http server standing in for the DS saved-file/changes endpoints. onSaved(n) decides the n-th
 * GET /saved outcome; changes is served verbatim at /changes.zip. Records every X-Auth-Token it was sent. */
type FileServer = {
  base: string;
  savedAttempts: number;
  tokens: string[];
  close(): Promise<void>;
};

async function startFileServer(
  onSaved: (n: number) => { status: number; bytes: Buffer },
  changes: Buffer | null,
): Promise<FileServer> {
  const server = http.createServer((req, res) => {
    let n = 0;
    if (req.url === "/saved") {
      n = ++serverSavedCalls;
      serverTokens.push(typeof req.headers["x-auth-token"] === "string" ? req.headers["x-auth-token"] : "");
      const out = onSaved(n);
      res.writeHead(out.status, { "Content-Type": "application/octet-stream" });
      res.end(out.bytes);
    } else if (req.url === "/changes.zip") {
      if (!changes) return res.writeHead(404).end();
      serverTokens.push(typeof req.headers["x-auth-token"] === "string" ? req.headers["x-auth-token"] : "");
      res.writeHead(200, { "Content-Type": "application/zip" });
      res.end(changes);
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  let serverSavedCalls = 0;
  const serverTokens: string[] = [];
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address() as { port: number };
  return {
    base: `http://127.0.0.1:${addr.port}`,
    get savedAttempts() {
      return serverSavedCalls;
    },
    get tokens() {
      return serverTokens;
    },
    close: () =>
      new Promise<void>((r, j) => {
        // undici's fetch pool keep-ALIVEs its sockets; force them down so close() resolves immediately
        server.closeAllConnections?.();
        server.close((e) => (e ? j(e) : r()));
      }),
  };
}

/* ------------------------------------------------------------------ */
/* parseKey                                                            */
/* ------------------------------------------------------------------ */

test("parseKey: valid round-trip (sha256 of '12345', base64url no pad)", () => {
  const sha = createHash("sha256").update("12345").digest("base64url");
  assert.equal(sha.length, 43); // one unpadded sha256 digest in base64url
  assert.equal(revHashOf(12345), sha);
  assert.equal(makeKey("my-doc", 12345), `office|my-doc|${sha}`);
  const parsed = parseKey(`office|my-doc|${sha}`);
  assert.deepEqual(parsed, { docId: "my-doc", revHash: sha });
});

test("parseKey: a docId containing a pipe still parses (greedy first/last split)", () => {
  const key = makeKey("a|b", 42);
  assert.deepEqual(parseKey(key), { docId: "a|b", revHash: revHashOf(42) });
});

test("parseKey: null on missing parts, empty docId and malformed hash part", () => {
  const sha = revHashOf(1);
  assert.equal(parseKey(""), null);
  assert.equal(parseKey(`my-doc|${sha}`), null); // no "office|" prefix
  assert.equal(parseKey("office|my-doc"), null); // missing hash part
  assert.equal(parseKey(`office|my-doc|`), null); // empty hash part
  assert.equal(parseKey(`office||${sha}`), null); // empty docId
  assert.equal(parseKey(`office|doc|x`.padEnd(7 + 4 + 50, "z")), null); // wrong length / alphabet
  assert.equal(parseKey("office|doc|" + sha.slice(0, 42)), null); // 42 chars -- not a sha256 digest
  assert.equal(parseKey("office|doc|" + "=".repeat(43)), null); // "=" is not base64url
});

/* ------------------------------------------------------------------ */
/* status-2 happy path                                                 */
/* ------------------------------------------------------------------ */

const hookLog: { docId: string; buffer: Buffer }[] = [];
onPersisted((docId, buffer) => hookLog.push({ docId, buffer })); // single module-level collector, cleared per test

test("status 2 happy path: persists bytes, bumps index, stores history zip, fires onPersisted, unlocks", async () => {
  const root = tmpRoot();
  const sink: string[] = [];
  const doc = await createDoc({ title: "Quarterly Report", type: "word" }, root);
  const before = getDoc(doc.docId, root)!;
  hookLog.length = 0;

  live.setUser(doc.docId, { id: "u1", name: "Ana" }, true); // the human editor is open -> locked via presence
  assert.equal(live.pollState(doc.docId, 0).locked, true);

  const newBytes = Buffer.from("saved-by-ds-content-" + "x".repeat(257));
  const zipBytes = Buffer.from("CHANGES-ARCHIVE-BYTES");
  const server = await startFileServer(() => ({ status: 200, bytes: newBytes }), zipBytes);
  const handler = createCallbackHandler(() => DS_STATE, () => SECRET, { root, retryDelaysMs: [5, 10], log: (l) => sink.push(l) });

  const res = await post(handler, {
    key: makeKey(doc.docId, before.mtimeMs),
    status: 2,
    url: `${server.base}/saved`,
    changesurl: `${server.base}/changes.zip`,
  }, { headers: { "x-auth-token": signJwt({ key: "", status: 2 }, 60_000, SECRET) } });

  await server.close();
  assert.equal(res.statusCode, 200);
  assert.deepEqual(json(res), { error: 0 });

  // the file bytes changed to exactly what DS served
  assert.ok(fs.readFileSync(docFile(root, doc)).equals(newBytes), "document bytes were replaced");
  // the index moved on: new mtime revision + size of the new bytes
  const after = getDoc(doc.docId, root)!;
  assert.notEqual(after.mtimeMs, before.mtimeMs);
  assert.equal(after.sizeBytes, newBytes.length);
  // the changes archive landed at history/<doc>/<newRev>.zip (rev = the NEW post-persist mtime)
  const zipPath = path.join(root, "history", doc.docId, `${after.mtimeMs}.zip`);
  assert.ok(fs.readFileSync(zipPath).equals(zipBytes), "changes zip stored under the new revision");
  // onPersisted fired once for this doc with the exact buffer (ping's wake hook will see these bytes)
  const mine = hookLog.filter((h) => h.docId === doc.docId);
  assert.equal(mine.length, 1);
  assert.ok(mine[0].buffer.equals(newBytes));
  // the persist path did not need retries and authenticated its outbound GETs with a verifiable HS256 token
  assert.equal(server.savedAttempts, 1);
  const t = server.tokens.find((x) => x !== "");
  assert.ok(t && verifyJwt(t, SECRET), "outbound fetch carried a valid X-Auth-Token JWT");
  // lock released after the persist (status-2 row: unlock AFTER persist)
  assert.equal(live.pollState(doc.docId, 0).locked, false);
});

test("stale key (revHash of an older mtime): document NOT overwritten, JSON error, one log line", async () => {
  const root = tmpRoot();
  const sink: string[] = [];
  const doc = await createDoc({ title: "Stale Doc", type: "word" }, root);
  const before = getDoc(doc.docId, root)!;
  const original = fs.readFileSync(docFile(root, doc));
  hookLog.length = 0;

  const server = await startFileServer(() => ({ status: 200, bytes: Buffer.from("should-never-land") }), null);
  const handler = createCallbackHandler(() => DS_STATE, () => SECRET, { root, retryDelaysMs: [5, 10], log: (l) => sink.push(l) });

  // key minted from an OLDER mtime than the one currently in the index
  const res = await post(handler, {
    key: makeKey(doc.docId, before.mtimeMs - 60_000),
    status: 2,
    url: `${server.base}/saved`,
  }, { headers: { "x-auth-token": signJwt({}, 60_000, SECRET) } });

  await server.close();
  assert.equal(res.statusCode, 200);
  assert.deepEqual(json(res), { error: 1 }); // non-zero -> the editor shows a save failure, per plan 4
  assert.ok(fs.readFileSync(docFile(root, doc)).equals(original), "file untouched");
  const after = getDoc(doc.docId, root)!;
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.equal(after.sizeBytes, original.length);
  assert.equal(server.savedAttempts, 0, "stale gate refuses BEFORE the download");
  assert.equal(hookLog.filter((h) => h.docId === doc.docId).length, 0);
  assert.ok(!fs.existsSync(path.join(root, "history", doc.docId)));
  assert.ok(sink.some((l) => l.includes("stale key") && l.includes(doc.docId)), `a stale-key line was logged: ${sink.join("; ")}`);
});

test("duplicate force-save pass (same url + our revision): treated as done, no second write", async () => {
  const root = tmpRoot();
  const sink: string[] = [];
  const doc = await createDoc({ title: "Forced Doc", type: "word" }, root);
  const before = getDoc(doc.docId, root)!;
  hookLog.length = 0;

  const firstBytes = Buffer.from("first-forcesave");
  let n = 0;
  const server = await startFileServer(() => ({ status: 200, bytes: firstBytes }), null);
  const handler = createCallbackHandler(() => DS_STATE, () => SECRET, { root, retryDelaysMs: [5, 10], log: (l) => sink.push(l) });
  const tokenHeaders = { "x-auth-token": signJwt({}, 60_000, SECRET) };

  // Pass 1: the status-1 forcesave action (actions[].type === 2) persists now, doc STAYS locked.
  live.setLocked(doc.docId, true);
  const r1 = await post(handler, {
    key: makeKey(doc.docId, before.mtimeMs),
    status: 1,
    users: [{ id: "u2", name: "Bob" }],
    actions: [{ type: 2, userid: "u2" }],
    url: `${server.base}/saved`,
  }, { headers: tokenHeaders });
  assert.deepEqual(json(r1), { error: 0 });
  const mid = getDoc(doc.docId, root)!;
  assert.ok(fs.readFileSync(docFile(root, doc)).equals(firstBytes));
  assert.equal(live.pollState(doc.docId, 0).locked, true, "forcesave keeps the doc locked (status-6 rules)");

  // Pass 2: DS then reports the canonical status 6 for the SAME save. The key now hashes an older mtime than
  // the one we just wrote -- without lastPersist this would answer {error:1} as a stale session.
  const r2 = await post(handler, {
    key: makeKey(doc.docId, before.mtimeMs),
    status: 6,
    url: `${server.base}/saved`,
    forcesavetype: 1,
  }, { headers: tokenHeaders });
  assert.deepEqual(json(r2), { error: 0 }, "duplicate pass reports success");
  const after = getDoc(doc.docId, root)!;
  assert.equal(after.mtimeMs, mid.mtimeMs, "no second persist happened");
  assert.equal(hookLog.filter((h) => h.docId === doc.docId).length, 1, "hook fired once for the single real save");
  await server.close();
});

/* ------------------------------------------------------------------ */
/* JWT verification                                                    */
/* ------------------------------------------------------------------ */

test("JWT: garbage token -> 401 {error:1} without touching disk", async () => {
  const root = tmpRoot();
  const doc = await createDoc({ title: "Jwt Doc", type: "word" }, root);
  const original = fs.readFileSync(docFile(root, doc));
  const server = await startFileServer(() => ({ status: 200, bytes: Buffer.from("nope") }), null);
  const handler = createCallbackHandler(() => DS_STATE, () => SECRET, { root, log: () => {} });

  const res = await post(handler, {
    key: makeKey(doc.docId, getDoc(doc.docId, root)!.mtimeMs),
    status: 2,
    url: `${server.base}/saved`,
  }, { headers: { "x-auth-token": "garbage.token.value" } });

  await server.close();
  assert.equal(res.statusCode, 401);
  assert.deepEqual(json(res), { error: 1 });
  assert.ok(fs.readFileSync(docFile(root, doc)).equals(original), "no download, no write");
  assert.equal(server.savedAttempts, 0);
});

test("JWT: RS256-alg token with a valid HMAC signature is still rejected (alg pinned to HS256)", async () => {
  const root = tmpRoot();
  const doc = await createDoc({ title: "Alg Doc", type: "word" }, root);
  const original = fs.readFileSync(docFile(root, doc));

  // Forge a token whose header says RS256 but whose signature is the HS256 MAC over that exact pair.
  const b64url = (s: string | Buffer) => Buffer.from(s).toString("base64url");
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const body = b64url(JSON.stringify({ key: makeKey(doc.docId, getDoc(doc.docId, root)!.mtimeMs), status: 2 }));
  const sig = b64url(createHmac("sha256", SECRET).update(`${head}.${body}`).digest());
  const handler = createCallbackHandler(() => DS_STATE, () => SECRET, { root, log: () => {} });

  const res = await post(handler, { status: 2 }, { headers: { "x-auth-token": `${head}.${body}.${sig}` } });
  assert.equal(res.statusCode, 401);
  assert.deepEqual(json(res), { error: 1 });
  assert.ok(fs.readFileSync(docFile(root, doc)).equals(original));
});

test("JWT: expired token -> 401; missing token entirely -> 401", async () => {
  const root = tmpRoot();
  const handler = createCallbackHandler(() => DS_STATE, () => SECRET, { root, log: () => {} });
  const key = makeKey("whatever-doc", 1);

  const expired = await post(handler, { key, status: 4 }, { headers: { "x-auth-token": signJwt({ sub: "x" }, -1000, SECRET) } });
  assert.equal(expired.statusCode, 401);
  assert.deepEqual(json(expired), { error: 1 });

  const missing = await post(handler, { key, status: 4 }); // no x-auth-token header at all
  assert.equal(missing.statusCode, 401);
  assert.deepEqual(json(missing), { error: 1 });
});

test("JWT: embedded body.token is accepted as a defensive fallback (header path stays canonical)", async () => {
  const root = tmpRoot();
  const handler = createCallbackHandler(() => DS_STATE, () => SECRET, { root, log: () => {} });
  live.setLocked("fallback-doc", true);

  const res = await post(handler, {
    key: makeKey("fallback-doc", 1),
    status: 4,
    token: signJwt({ sub: "x" }, 60_000, SECRET), // no x-auth-token header
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(json(res), { error: 0 });
  assert.equal(live.pollState("fallback-doc", 0).locked, false, "status-4 unlock applied through the fallback");
});

/* ------------------------------------------------------------------ */
/* status 1 / 4 presence + lock commands                               */
/* ------------------------------------------------------------------ */

test("status 1 join then leave mutates live.usersOf; status 4 unlocks without any disk write", async () => {
  const root = tmpRoot();
  const doc = await createDoc({ title: "Presence Doc", type: "word" }, root);
  const before = getDoc(doc.docId, root)!;
  const original = fs.readFileSync(docFile(root, doc));
  const handler = createCallbackHandler(() => DS_STATE, () => SECRET, { root, log: () => {} });
  const headers = { "x-auth-token": signJwt({}, 60_000, SECRET) };

  // JOIN: presence lands in live with id/name and a numeric join time; the doc locks (users.length>0).
  const join = await post(handler, { key: makeKey(doc.docId, before.mtimeMs), status: 1, users: [{ id: "u9", name: "Bob" }] }, { headers });
  assert.deepEqual(json(join), { error: 0 });
  const joined = live.usersOf(doc.docId);
  assert.equal(joined.length, 1);
  assert.equal(joined[0].id, "u9");
  assert.equal(joined[0].name, "Bob");
  assert.equal(typeof joined[0].at, "number");
  assert.equal(live.pollState(doc.docId, 0).locked, true);

  // LEAVE: the empty users snapshot removes the user and clears the derived lock.
  const leave = await post(handler, { key: makeKey(doc.docId, before.mtimeMs), status: 1, users: [] }, { headers });
  assert.deepEqual(json(leave), { error: 0 });
  assert.deepEqual(live.usersOf(doc.docId), []);
  assert.equal(live.pollState(doc.docId, 0).locked, false);

  // STATUS 4: explicit unlock, and the file + index are byte-identical to before.
  live.setLocked(doc.docId, true);
  const r4 = await post(handler, { key: makeKey(doc.docId, before.mtimeMs), status: 4 }, { headers });
  assert.deepEqual(json(r4), { error: 0 });
  assert.equal(live.pollState(doc.docId, 0).locked, false);
  assert.ok(fs.readFileSync(docFile(root, doc)).equals(original), "status 4 wrote nothing");
  const after = getDoc(doc.docId, root)!;
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.equal(after.sizeBytes, before.sizeBytes);
});

test("statuses 3 and 7: one log line each, zero file changes, zero downloads", async () => {
  const root = tmpRoot();
  const sink: string[] = [];
  const doc = await createDoc({ title: "Errors Doc", type: "word" }, root);
  const before = getDoc(doc.docId, root)!;
  const original = fs.readFileSync(docFile(root, doc));

  const server = await startFileServer(() => ({ status: 200, bytes: Buffer.from("should-not-be-fetched") }), null);
  const handler = createCallbackHandler(() => DS_STATE, () => SECRET, { root, retryDelaysMs: [5, 10], log: (l) => sink.push(l) });
  const headers = { "x-auth-token": signJwt({}, 60_000, SECRET) };

  const r3 = await post(handler, { key: makeKey(doc.docId, before.mtimeMs), status: 3, url: `${server.base}/saved` }, { headers });
  assert.equal(r3.statusCode, 200);
  assert.deepEqual(json(r3), { error: 0 }, "we did not fail internally, so the answer is 0");

  const r7 = await post(handler, { key: makeKey(doc.docId, before.mtimeMs), status: 7, url: `${server.base}/saved`, forcesavetype: 2 }, { headers });
  assert.equal(r7.statusCode, 200);
  assert.deepEqual(json(r7), { error: 0 });

  await server.close();
  assert.ok(fs.readFileSync(docFile(root, doc)).equals(original));
  const after = getDoc(doc.docId, root)!;
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.equal(server.savedAttempts, 0, "no fetch happened for 3/7");
  assert.ok(sink.some((l) => l.startsWith("status-3:")), `status-3 line present: ${sink.join("; ")}`);
  assert.ok(sink.some((l) => l.startsWith("status-7:") && l.includes("forcesavetype=2")), `status-7 line present`);
});

/* ------------------------------------------------------------------ */
/* retries                                                             */
/* ------------------------------------------------------------------ */

test("retry: two failed downloads then success -> persisted", async () => {
  const root = tmpRoot();
  const doc = await createDoc({ title: "Flaky Doc", type: "word" }, root);
  const before = getDoc(doc.docId, root)!;
  hookLog.length = 0;

  const saved = Buffer.from("eventually-arrives");
  const server = await startFileServer((n) => (n < 3 ? { status: 500, bytes: Buffer.alloc(0) } : { status: 200, bytes: saved }), null);
  const handler = createCallbackHandler(() => DS_STATE, () => SECRET, { root, retryDelaysMs: [5, 10], log: () => {} });

  const res = await post(handler, {
    key: makeKey(doc.docId, before.mtimeMs),
    status: 2,
    url: `${server.base}/saved`,
  }, { headers: { "x-auth-token": signJwt({}, 60_000, SECRET) } });

  await server.close();
  assert.deepEqual(json(res), { error: 0 });
  assert.equal(server.savedAttempts, 3, "failed twice, succeeded on the third attempt");
  assert.ok(fs.readFileSync(docFile(root, doc)).equals(saved));
  assert.equal(hookLog.filter((h) => h.docId === doc.docId).length, 1);
});

test("retry: all attempts fail -> JSON error, doc untouched, lock left as-is", async () => {
  const root = tmpRoot();
  const sink: string[] = [];
  const doc = await createDoc({ title: "Dead Doc", type: "word" }, root);
  const before = getDoc(doc.docId, root)!;
  const original = fs.readFileSync(docFile(root, doc));

  const server = await startFileServer(() => ({ status: 503, bytes: Buffer.alloc(0) }), null);
  const handler = createCallbackHandler(() => DS_STATE, () => SECRET, { root, retryDelaysMs: [5, 10], log: (l) => sink.push(l) });

  live.setLocked(doc.docId, true);
  const res = await post(handler, {
    key: makeKey(doc.docId, before.mtimeMs),
    status: 2,
    url: `${server.base}/saved`,
  }, { headers: { "x-auth-token": signJwt({}, 60_000, SECRET) } });

  await server.close();
  assert.equal(res.statusCode, 200); // DS reads the JSON error field, not the HTTP code (plan 4)
  assert.deepEqual(json(res), { error: 1 });
  assert.equal(server.savedAttempts, 3, "1 + retryDelaysMs.length attempts");
  assert.ok(fs.readFileSync(docFile(root, doc)).equals(original), "existing file never deleted or replaced");
  const after = getDoc(doc.docId, root)!;
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.equal(live.pollState(doc.docId, 0).locked, true, "fetch failure leaves the lock state untouched (DS will retry)");
  assert.ok(sink.some((l) => l.includes("could not download")), `a download-failure line was logged`);
});

/* ------------------------------------------------------------------ */
/* envelope / route rejections                                         */
/* ------------------------------------------------------------------ */

test("route + envelope: GET -> 405, bad path -> 404, unknown status / bad key -> 400", async () => {
  const root = tmpRoot();
  const handler = createCallbackHandler(() => DS_STATE, () => SECRET, { root, log: () => {} });
  const key = makeKey("route-doc", 1);
  const headers = { "x-auth-token": signJwt({}, 60_000, SECRET) };

  const get = await post(handler, { key, status: 4 }, { method: "GET", headers });
  assert.equal(get.statusCode, 405);
  assert.deepEqual(json(get), { error: 1 });

  const wrongPath = await post(handler, { key, status: 4 }, { url: "/doc/something-else", headers });
  assert.equal(wrongPath.statusCode, 404);
  assert.deepEqual(json(wrongPath), { error: 1 });

  const unknownStatus = await post(handler, { key, status: 99 }, { headers });
  assert.equal(unknownStatus.statusCode, 400);
  assert.deepEqual(json(unknownStatus), { error: 1 });

  const badKey = await post(handler, { key: "nope", status: 2 }, { headers });
  assert.equal(badKey.statusCode, 400);
  assert.deepEqual(json(badKey), { error: 1 });

  const noKey = await post(handler, { status: 2 }, { headers });
  assert.equal(noKey.statusCode, 400);
  assert.deepEqual(json(noKey), { error: 1 });
});

/* ------------------------------------------------------------------ */
/* the bare module-level handler + configure (T-WIRE wiring)           */
/* ------------------------------------------------------------------ */

test("bare handleCallback: 503 until configure; after configure it serves requests", async () => {
  const root = tmpRoot();

  // Not configured yet (no test before this one called configure).
  const notYet = await post(handleCallback, { key: makeKey("wire-doc", 1), status: 4 });
  assert.equal(notYet.statusCode, 503);
  assert.deepEqual(json(notYet), { error: 1 });

  // Configured but the DS record is still absent (getState -> null) -> 503 as well.
  configure({ getState: () => null, getSecret: () => SECRET, root, log: () => {} });
  const noState = await post(handleCallback, { key: makeKey("wire-doc", 1), status: 4 });
  assert.equal(noState.statusCode, 503);
  assert.deepEqual(json(noState), { error: 1 });

  // The real wiring shape (what server.ts does at boot).
  live.setLocked("wire-doc", true);
  configure({ getState: () => DS_STATE, getSecret: () => SECRET, root, log: () => {} });
  const ok = await post(handleCallback, { key: makeKey("wire-doc", 1), status: 4 }, { headers: { "x-auth-token": signJwt({}, 60_000, SECRET) } });
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(json(ok), { error: 0 });
  assert.equal(live.pollState("wire-doc", 0).locked, false);
});

/* ------------------------------------------------------------------ */
/* live.ts pollState resolver                                          */
/* ------------------------------------------------------------------ */

test("live.pollState: pendingRev only when the resolved revision is strictly newer than the client's", () => {
  live.resetLive(); // clean slate (also proves reset exists and wipes state)
  const docId = "resolver-doc";
  live.setMetaResolver((id) => (id === docId ? 2000 : null));

  assert.deepEqual(live.pollState(docId, 1999), { locked: false, pendingRev: 2000 }); // agent updated since open
  assert.deepEqual(live.pollState(docId, 2000), { locked: false, pendingRev: null }); // same revision
  assert.deepEqual(live.pollState(docId, 5000), { locked: false, pendingRev: null }); // client ahead (weird but safe)

  live.setUser(docId, { id: "u", name: "Z" }, true);
  assert.equal(live.pollState(docId, 2000).locked, true, "presence locks even without the flag");
  live.setLocked(docId, false);
  live.clearDoc(docId);
  assert.deepEqual(live.usersOf(docId), []);
  assert.equal(live.pollState(docId, 1999).locked, false, "clearDoc drops the lock entirely");

  // A cleared resolver makes pendingRev null again (server.ts re-registers at boot).
  live.setMetaResolver(null);
  assert.deepEqual(live.pollState(docId, 1999), { locked: false, pendingRev: null });
});
