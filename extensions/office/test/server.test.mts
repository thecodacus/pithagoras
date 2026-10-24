/**
 * Unit tests for src/server.ts (T-WIRE): the boot wiring, the loopback listener, and every UI route -- against a
 * FAKE portal (mini router + recorded log/audit/extensions.use) with real tmp dataDirs and a recording fake Docker
 * literal. Nothing here reaches the real portal(), the Docker socket, or any network host but 127.0.0.1 loopback
 * (the listener itself). Booted instances are cleaned up at the end of each test; live-module presence is reset for
 * isolation because it is process-global.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import type { AddressInfo } from "node:net";
import type { ServerPortal } from "@pithagoras/extension-api/server";
import type { ContainerInfo, Docker, ExecResult, VolumeInfo } from "../../docker/src/api";
import officeServer, { dsOrigin, jwtSecret, loopbackPort, settleKept } from "../src/server";
import * as store from "../src/store";
import { rewriteZip } from "../src/ooxml";
import * as live from "../src/live";
import { mintTicket, verifyTicket } from "../src/tickets";
import { verifyJwt } from "../src/jwt";
import { makeKey, parseKey, revHashOf } from "../src/callback";

const DEFAULT_TAG = "onlyoffice/documentserver:10.0";

/* ------------------------------------------------------------------ */
/* fakes                                                               */
/* ------------------------------------------------------------------ */

class MiniRouter {
  routes: Array<{ method: string; pattern: string | RegExp; handler: (req: unknown, res: FakeRes) => Promise<void> | void }> = [];
  private reg(method: string) {
    return (pattern: string | RegExp, ...rest: unknown[]) => {
      const handler = rest[rest.length - 1] as (req: unknown, res: FakeRes) => Promise<void> | void;
      this.routes.push({ method, pattern, handler });
    };
  }
  /** Express-shaped registration: (pattern, ...middlewares, handler). */
  get(...args: unknown[]) { this.reg("GET")(...args); }
  post(...args: unknown[]) { this.reg("POST")(...args); }
  put(...args: unknown[]) { this.reg("PUT")(...args); }
  delete(...args: unknown[]) { this.reg("DELETE")(...args); }

  /** Express-shaped fake request: the plain fields PLUS the stream surface -- an async iterator over the body
   * (real IncomingMessages are async-iterable, and the /ds proxy's POST forwarding reads `for await (req)`). */
  private fakeReq(method: string, urlPath: string, params: Record<string, string>, body: unknown, headers: Record<string, string>): unknown {
    const o: Record<PropertyKey, unknown> = { method, url: urlPath, params, query: {}, body, headers };
    const data = typeof body === "string" ? Buffer.from(body, "utf8") : Buffer.isBuffer(body) ? body : undefined;
    o[Symbol.asyncIterator] = async function* () { if (data && data.length > 0) yield data; };
    return o;
  }

  async dispatch(method: string, urlPath: string, body: unknown, headers: Record<string, string> = {}): Promise<FakeRes> {
    const us = urlPath.split("/").filter(Boolean);
    for (const route of this.routes) {
      if (route.method !== method) continue;
      // Express regex paths match the WHOLE raw url (query included); groups land in params[0..].
      if (typeof route.pattern === "object") {
        const m = route.pattern.exec(urlPath);
        if (!m) continue;
        const params: Record<string, string> = {};
        for (let g = 1; g < m.length; g++) params[String(g - 1)] = m[g] ?? "";
        const res = fakeRes();
        await route.handler(this.fakeReq(method, urlPath, params, body, headers), res);
        return res;
      }
      const ps = route.pattern.split("/").filter(Boolean);
      if (ps.length !== us.length) continue;
      const params: Record<string, string> = {};
      let hit = true;
      for (let i = 0; i < ps.length; i++) {
        if (ps[i].startsWith(":")) params[ps[i].slice(1)] = decodeURIComponent(us[i]);
        else if (ps[i] !== us[i]) { hit = false; break; }
      }
      if (!hit) continue;
      const res = fakeRes();
      await route.handler(this.fakeReq(method, urlPath, params, body, headers), res);
      return res;
    }
    throw new Error(`no registered ${method} route for ${urlPath}`);
  }
}

function fakeRes(): FakeRes {
  let code = 200;
  const r = {
    headers: {} as Record<string, unknown>,
    data: undefined as unknown,
    body: undefined as unknown,
    status(c: number) { code = c; return r; },
    json(o: unknown) { r.body = o; return r; },
    setHeader(k: string, v: unknown) { r.headers[k.toLowerCase()] = v; },
    writeHead(c: number, h?: Record<string, string>) { code = c; if (h) for (const k of Object.keys(h)) r.headers[k.toLowerCase()] = h[k]; },
    end(b?: unknown) { r.data = b; },
  };
  Object.defineProperty(r, "statusCode", { get: () => code });
  return r as unknown as FakeRes;
}

type FakeRes = {
  headers: Record<string, unknown>;
  data: unknown;
  body: unknown;
  statusCode: number;
};

function makeDocker(opts: { networkMode?: string } = {}) {
  const state = { container: undefined as ContainerInfo | undefined, volumes: [] as VolumeInfo[], inspectBody: undefined as Record<string, unknown> | undefined, execResult: { output: "", exitCode: 1, timedOut: false } as ExecResult, networkMode: opts.networkMode ?? "host" };
  const calls = { ensure: [] as string[], create: [] as Array<[string, Record<string, unknown>]>, start: [] as string[], stop: [] as string[] };
  const docker = {
    available: async () => true,
    sharedNetwork: async () => state.networkMode,
    images: { present: async () => true, ensure: async (image: string) => { calls.ensure.push(image); } },
    containers: {
      list: async () => (state.container ? [state.container] : []),
      get: async () => state.container,
      create: async (name: string, spec: Record<string, unknown>) => {
        calls.create.push([name, spec]);
        const info: ContainerInfo = { name, id: `cid-${calls.create.length}`, image: String(spec.Image), state: "created", status: "Created", owner: "", labels: {} };
        state.container = info;
        return info;
      },
      start: async (name: string) => { calls.start.push(name); if (state.container && name === state.container.name) state.container.state = "running"; },
      stop: async (name: string) => { calls.stop.push(name); if (state.container && name === state.container.name) state.container.state = "exited"; },
      remove: async () => {}, logs: async () => "", inspect: async () => state.inspectBody,
      exec: async () => state.execResult, adopt: async () => { throw Object.assign(new Error("nope"), { status: 404 }); },
    },
    volumes: { list: async () => [...state.volumes], create: async (n: string) => { state.volumes.push({ name: n, owner: "" }); }, remove: async () => {}, adopt: async () => { throw Object.assign(new Error("nope"), { status: 404 }); } },
  } as unknown as Docker;
  return { docker, calls, state };
}

interface Booted {
  root: string;
  portal: ServerPortal;
  router: MiniRouter;
  logs: string[];
  audits: Array<Record<string, unknown>>;
  allowedDirs: string[];
  cleanup: () => Promise<void>;
}

async function boot(root?: string, docker?: Docker): Promise<Booted> {
  const rootDir = root ?? fs.mkdtempSync(path.join(os.tmpdir(), "office-server-"));
  const logs: string[] = [];
  const audits: Array<Record<string, unknown>> = [];
  const allowedDirs: string[] = [];
  const router = new MiniRouter();
  const ddock = docker ?? makeDocker().docker; // ONE instance per boot: extensions.use() resolves the same fake every time
  const portalObj = {
    extension: "pithagoras-office",
    dataDir: () => rootDir,
    log: (l: unknown) => logs.push(String(l)),
    audit: { record: (e: Record<string, unknown>) => audits.push(e) },
    router,
    http: { json: (_o?: unknown) => (_req: unknown, _res: unknown, next: () => void) => next(), text: () => () => undefined, raw: () => () => undefined, send: () => () => {}, upgrade: () => undefined },
    folders: { list: () => [] as never[], allowed: (p: string) => allowedDirs.some((d) => p === d || p.startsWith(d + path.sep)), label: () => ({ name: "" }) },
    chats: { extend: (_f: unknown) => {}, get: () => undefined, list: () => [], inFolder: () => [] as never[], folder: () => { throw new Error("none"); }, send: () => {}, tell: async () => false },
    extensions: { use: () => ddock },
  } as unknown as ServerPortal;
  const cleanup = await officeServer(portalObj);
  return { root: rootDir, portal: portalObj, router, logs, audits, allowedDirs, cleanup };
}

async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 10));
  }
}

function writeDsJson(root: string, origin = "http://127.0.0.1"): void {
  fs.writeFileSync(path.join(root, "ds.json"), JSON.stringify({ containerId: "cid-test", origin, imageTag: DEFAULT_TAG }));
}

/* ---------------- boot: jwt-secret + cleanup ---------------- */

test("boot creates jwt-secret 0600 exactly once; a second boot reuses the bytes verbatim", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "office-secret-"));
  const b1 = await boot(root);
  const file = path.join(root, "jwt-secret");
  assert.ok(fs.existsSync(file), "jwt-secret created at boot");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600, "mode is exactly 0600 (umask-proof)");
  const s1 = jwtSecret(root);
  assert.match(s1, /^[0-9a-f]{64}$/, "trimmed content is a 64-hex-char random value");

  const b2 = await boot(root); // same dataDir, second portal start
  assert.equal(jwtSecret(root), s1, "second boot reuses the existing secret byte-for-byte");
  const before = fs.readFileSync(file, "utf8");
  const b3 = await boot(root);
  assert.equal(fs.readFileSync(file, "utf8"), before);

  await b3.cleanup(); await b2.cleanup(); await b1.cleanup();
});

test("cleanup closes the loopback listener and clears the timer (nothing keeps node alive)", async () => {
  const b = await boot();
  const port = loopbackPort();
  assert.ok(port > 0, "the listener bound a real ephemeral loopback port");
  let ok = false;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/nope`);
    ok = r.status === 404; // reachable BEFORE cleanup, unknown path -> 404 JSON
  } catch { assert.fail("loopback was not reachable before cleanup"); }
  assert.ok(ok);

  await b.cleanup();
  assert.equal(loopbackPort(), 0, "port state cleared after cleanup");
  let refused = false;
  try {
    await fetch(`http://127.0.0.1:${port}/nope`);
  } catch {
    refused = true;
  }
  assert.ok(refused, "the listener is closed: connections are refused after cleanup");
});

/* ---------------- loopback listener ---------------- */

test("loopback GET /doc/<ticket> returns the exact bytes + content-type + no-store; bad/expired tickets -> 401", async () => {
  const b = await boot();
  const doc = await store.createDoc({ title: "Loop", type: "word" }, b.root);
  const secret = jwtSecret(b.root);
  const { token } = mintTicket(doc.docId, 600_000, secret);

  const r = await fetch(`http://127.0.0.1:${loopbackPort()}/doc/${token}`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  assert.equal(r.headers.get("cache-control"), "no-store");
  const disk = fs.readFileSync(path.join(b.root, "docs", doc.docId, `${doc.title}.docx`));
  assert.ok(Buffer.compare(Buffer.from(await r.arrayBuffer()), disk) === 0, "served bytes are exactly the library bytes");

  // xlsx gets the spreadsheet media type
  const cell = await store.createDoc({ title: "Cells", type: "cell" }, b.root);
  const { token: t2 } = mintTicket(cell.docId, 600_000, secret);
  const r2 = await fetch(`http://127.0.0.1:${loopbackPort()}/doc/${t2}`);
  assert.equal(r2.headers.get("content-type"), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");

  // invalid ticket -> 401 JSON; expired ticket -> 401 JSON (negative ttl mints an already-expired one)
  const r3 = await fetch(`http://127.0.0.1:${loopbackPort()}/doc/garbage.ticket.here`);
  assert.equal(r3.status, 401);
  assert.deepEqual(await r3.json(), { error: "invalid or expired document ticket", code: "bad_ticket" });
  const { token: expired } = mintTicket(doc.docId, -1_000, secret);
  assert.equal(verifyTicket(expired, secret), null, "sanity: the negative-ttl ticket does not verify");
  const r4 = await fetch(`http://127.0.0.1:${loopbackPort()}/doc/${expired}`);
  assert.equal(r4.status, 401);

  live.clearDoc(doc.docId); live.clearDoc(cell.docId);
  await b.cleanup();
});

test("loopback POST /callback while the DS is unconfigured -> 503 {error:1}; unknown paths -> 404 JSON", async () => {
  const b = await boot(); // fresh root: no ds.json yet, but configure() ran at boot with this root's lookups
  const r = await fetch(`http://127.0.0.1:${loopbackPort()}/callback`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(r.status, 503);
  assert.deepEqual(await r.json(), { error: 1 }); // the DS callback convention, not our JSON shape

  const r2 = await fetch(`http://127.0.0.1:${loopbackPort()}/whatever`);
  assert.equal(r2.status, 404);
  const body = (await r2.json()) as Record<string, unknown>;
  assert.equal(typeof body.error, "string");
  assert.equal(body.code, "not_found");

  const r3 = await fetch(`http://127.0.0.1:${loopbackPort()}/callback`); // GET on the POST-only route is also 404
  assert.equal(r3.status, 404);
  await b.cleanup();
});

/* ---------------- /editor-config ---------------- */

test("editor-config (docx): key round-trips through parseKey, url is a fresh verifiable loopback ticket, the whole config is JWT-signed", async () => {
  const b = await boot();
  writeDsJson(b.root);
  const doc = await store.createDoc({ title: "Plan", type: "word" }, b.root);
  const secret = jwtSecret(b.root);

  const res = await b.router.dispatch("POST", "/editor-config", { doc: doc.docId });
  assert.equal(res.statusCode, 200);
  const body = res.body as Record<string, unknown> & { token: string; apiJs: string };

  // the plain fields a DocsAPI.DocEditor gets
  assert.equal(body.documentType, "word");
  assert.equal(body.type, "embedded");
  assert.equal(body.title, "Plan");
  const document = body.document as Record<string, unknown>;
  assert.equal(document.fileType, "docx");
  assert.equal(document.title, "Plan.docx");
  // key: exactly makeKey(docId, current mtime) and parseable back
  assert.equal(document.key, makeKey(doc.docId, doc.mtimeMs));
  const parsed = parseKey(String(document.key)) as { docId: string; revHash: string };
  assert.equal(parsed.docId, doc.docId);
  assert.equal(parsed.revHash, revHashOf(doc.mtimeMs));
  // url: on OUR loopback listener (plan 5.2), ticketed, and the ticket verifies with the boot secret
  const url = String(document.url);
  assert.ok(url.startsWith(`http://127.0.0.1:${loopbackPort()}/doc/`), `url uses the loopback origin: ${url}`);
  const ticket = url.split("/doc/")[1];
  assert.ok(ticket.length > 0 && !ticket.includes("/"));
  assert.equal(verifyTicket(ticket, secret)?.docId, doc.docId, "the minted ticket verifies with the boot secret");
  // editorConfig per plan 5.6
  const ec = body.editorConfig as Record<string, unknown>;
  assert.equal(ec.callbackUrl, `http://127.0.0.1:${loopbackPort()}/callback`);
  assert.equal(ec.mode, "edit");
  assert.deepEqual(ec.user, { id: "portal-user", name: "Portal" });
  // the JWT wrap: payload == the WHOLE plain config (minus token/apiJs), 15-minute life, verifies with the same secret
  const claims = verifyJwt(body.token, secret);
  assert.ok(claims, "the signed config verifies");
  assert.deepEqual(
    { documentType: claims?.documentType, type: claims?.type, title: claims?.title, document: claims?.document, editorConfig: claims?.editorConfig },
    { documentType: body.documentType, type: body.type, title: body.title, document: body.document, editorConfig: body.editorConfig },
  );
  const exp = Number(claims?.exp); const iat = Number(claims?.iat);
  assert.equal(exp - iat, 900, "config token lives exactly 15 minutes (the official sample's window)");
  // api.js src: ROOT-RELATIVE through this extension's own /ds proxy (resolved by the browser against the page
  // origin it reached the portal at); getBasePath() turns that prefix into the editor iframe base. The loopback
  // document.url/callbackUrl above are what STAY absolute for DS-side fetches.
  assert.equal(body.apiJs, "/api/x/pithagoras-office/ds/web-apps/apps/api/documents/api.js");
  // and minting claimed the seat in live presence
  assert.deepEqual(live.usersOf(doc.docId).map((u) => ({ id: u.id, name: u.name })), [{ id: "portal-user", name: "Portal" }]);

  live.clearDoc(doc.docId);
  await b.cleanup();
});

test("editor-config (xlsx): documentType cell; a container:<id> origin refuses with the M0 error", async () => {
  const b = await boot();
  writeDsJson(b.root);
  const cell = await store.createDoc({ title: "Budget", type: "cell" }, b.root);
  let res = await b.router.dispatch("POST", "/editor-config", { doc: cell.docId });
  assert.equal(res.statusCode, 200);
  assert.equal((res.body as Record<string, unknown>).documentType, "cell");
  live.clearDoc(cell.docId);

  // the deployment shape with no browser-reachable URL in v1: dsOrigin returns the marker AS-IS and /editor-config refuses
  writeDsJson(b.root, "container:9f3a1c2d");
  assert.equal(dsOrigin(b.root), "container:9f3a1c2d");
  res = await b.router.dispatch("POST", "/editor-config", { doc: cell.docId });
  assert.equal(res.statusCode, 422);
  const body = res.body as Record<string, unknown>;
  assert.equal(body.code, "unresolvable_ds_origin");
  assert.match(String(body.error), /M0/);

  // and with no ds.json at all: 503 not-configured; unknown doc: 404
  fs.rmSync(path.join(b.root, "ds.json"));
  res = await b.router.dispatch("POST", "/editor-config", { doc: cell.docId });
  assert.equal(res.statusCode, 503);
  res = await b.router.dispatch("POST", "/editor-config", { doc: "nope" });
  assert.equal(res.statusCode, 404);
  assert.equal((res.body as Record<string, unknown>).code, "not_found");

  writeDsJson(b.root); // leave a sane record for anyone reusing this root later
  await b.cleanup();
});

/* ---------------- /state ---------------- */

test("/state: settings + container status + docs list + locks for EVERY doc", async () => {
  const b = await boot();
  const d1 = await store.createDoc({ title: "Alpha", type: "word" }, b.root);
  const d2 = await store.createDoc({ title: "Beta", type: "cell" }, b.root);
  live.setUser(d1.docId, { id: "u-ada", name: "Ada" }, true);

  const res = await b.router.dispatch("GET", "/state");
  assert.equal(res.statusCode, 200);
  const body = res.body as Record<string, unknown>;
  assert.deepEqual(Object.keys(body).sort(), ["container", "docs", "enabled", "imageTag", "locks"]);
  assert.equal(body.enabled, false); // defaults from a fresh dataDir
  assert.equal(body.imageTag, DEFAULT_TAG);
  const c = body.container as Record<string, unknown>;
  assert.equal(c.state, "stopped"); // fake docker: nothing made yet
  const docs = body.docs as store.DocMeta[];
  assert.equal(docs.length, 2);
  assert.deepEqual(docs.map((d) => d.title).sort(), ["Alpha", "Beta"]);
  const locks = body.locks as Record<string, { id: string; name?: string }[]>;
  assert.deepEqual(locks[d1.docId], [{ id: "u-ada", name: "Ada" }]);
  assert.deepEqual(locks[d2.docId], [], "every doc gets a locks entry -- empty when nobody is in it");

  live.resetLive();
  await b.cleanup();
});

/* ---------------- /documents CRUD ---------------- */

test("/documents: create (409 on duplicate), rename keeps mtimeMs, download bytes+disposition, delete clears live presence", async () => {
  const b = await boot();

  let res = await b.router.dispatch("POST", "/documents", { title: "Plan", type: "word" });
  assert.equal(res.statusCode, 201);
  const meta = res.body as store.DocMeta;
  assert.equal(meta.ext, "docx");
  assert.ok(meta.docId.length > 0);

  res = await b.router.dispatch("POST", "/documents", { title: "Plan", type: "word" }); // same title+ext -> exists
  assert.equal(res.statusCode, 409);
  assert.equal((res.body as Record<string, unknown>).code, "exists");

  res = await b.router.dispatch("POST", "/documents", { title: "", type: "word" });
  assert.equal(res.statusCode, 400);
  res = await b.router.dispatch("POST", "/documents", { title: "X", type: "slides" });
  assert.equal(res.statusCode, 400);

  // rename: a new title, the SAME mtimeMs (open sessions' revision survives a retitle)
  const before = store.getDoc(meta.docId, b.root) as store.DocMeta;
  res = await b.router.dispatch("POST", `/documents/${meta.docId}/rename`, { title: "Plan v2" });
  assert.equal(res.statusCode, 200);
  const after = res.body as store.DocMeta;
  assert.equal(after.title, "Plan v2");
  assert.equal(after.mtimeMs, before.mtimeMs);

  // download: the exact disk bytes with an attachment disposition
  live.setUser(meta.docId, { id: "u-1", name: "U" }, true); // set presence BEFORE delete to prove clearDoc
  res = await b.router.dispatch("GET", `/documents/${meta.docId}`);
  assert.equal(res.statusCode, 200);
  const disk = fs.readFileSync(path.join(b.root, "docs", meta.docId, "Plan v2.docx"));
  assert.ok(Buffer.compare(Buffer.from(res.data as Buffer), disk) === 0);
  assert.equal(res.headers["content-type"], "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  assert.match(String(res.headers["content-disposition"]), /attachment; filename="Plan v2\.docx"/);

  // delete: gone, and the live doc cleared with it
  res = await b.router.dispatch("DELETE", `/documents/${meta.docId}`);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(live.usersOf(meta.docId), []);
  res = await b.router.dispatch("GET", `/documents/${meta.docId}`);
  assert.equal(res.statusCode, 404);
  // export of a gone doc refuses too
  res = await b.router.dispatch("GET", `/documents/${meta.docId}/export`);
  assert.equal(res.statusCode, 404);

  live.resetLive();
  await b.cleanup();
});

/* ---------------- /documents/rescan (the import route is gone) ---------------- */

/** Point the fake portal's folders.list at a workspace AFTER boot: the rescan route reads it live per request,
 * so overwriting the method is enough -- exactly how a real portal picks up newly added agent folders. */
function pointFoldersAt(b: Booted, ...dirs: string[]): void {
  // the route reads AgentFolder[] ({path,name,kind}) -- the fake must hand back that shape, not bare strings
  (b.portal as unknown as { folders: { list: () => Array<{ path: string; name: string; kind: string }> } }).folders.list =
    () => dirs.map((d) => ({ path: d, name: path.basename(d), kind: "project" }));
}

test("/documents/rescan: indexes in place (no copy), skips hidden/node_modules/.txt, second run is a no-op", async () => {
  const b = await boot(); // boots with folders.list -> [] : the boot scan logs zero and touches nothing
  assert.ok(b.logs.some((l) => l.startsWith("workspace scan at boot:")), "boot logged its workspace scan");
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "office-ws-"));
  const srcBytes = Buffer.from(`a docx of sorts ${Date.now()}`);
  fs.writeFileSync(path.join(ws, "report.docx"), srcBytes);
  fs.mkdirSync(path.join(ws, "deep", "drafts"), { recursive: true }); // nested dirs ARE walked
  fs.writeFileSync(path.join(ws, "deep", "drafts", "plan.xlsx"), Buffer.from("an xlsx of sorts"));
  fs.mkdirSync(path.join(ws, ".hidden"));
  fs.writeFileSync(path.join(ws, ".hidden", "secret.docx"), srcBytes); // hidden dir: never indexed
fs.mkdirSync(path.join(ws, "node_modules", "pkg"), { recursive: true });
  fs.writeFileSync(path.join(ws, "node_modules", "pkg", "bundled.docx"), srcBytes); // node_modules: never indexed
  fs.writeFileSync(path.join(ws, "notes.txt"), "plain text is not office"); // wrong type: ignored, not an error
  pointFoldersAt(b, ws);

  const res = await b.router.dispatch("POST", "/documents/rescan");
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { added: 2, updated: 0 });
  const docs = store.listDocs(b.root);
  assert.equal(docs.length, 2);
  const report = docs.find((d) => d.title === "report")!;
  assert.equal(report.path, path.join(ws, "report.docx"), "the entry points at the REAL file");
  assert.ok(fs.existsSync(path.join(ws, "report.docx")), "the source file is still where it was: IN PLACE, never copied");
  assert.ok(!fs.existsSync(path.join(b.root, "docs", report.docId)), "nothing was written into the library's docs/ for a scanned doc");
  assert.equal(report.owner, null); // a human doc: every home's view shows it (docsForHome's unowned pass)
  assert.equal(report.imported, true);

  // rescan again with nothing changed: idempotent by realpath identity, counts stay honest
  const again = await b.router.dispatch("POST", "/documents/rescan");
  assert.deepEqual(again.body, { added: 0, updated: 0 });
  assert.equal(store.listDocs(b.root).length, 2);

  // something wrote the file straight to disk (an agent outside DS): a rescan REFRESHES it in place
  const bigger = Buffer.concat([srcBytes, Buffer.from(" more")]);
  fs.writeFileSync(path.join(ws, "report.docx"), bigger);
  const refresh = await b.router.dispatch("POST", "/documents/rescan");
  assert.deepEqual(refresh.body, { added: 0, updated: 1 });
  const refreshed = store.listDocs(b.root).find((d) => d.docId === report.docId)!;
  assert.equal(refreshed.sizeBytes, bigger.length);
  assert.ok(Math.abs(refreshed.mtimeMs - fs.statSync(path.join(ws, "report.docx")).mtimeMs) < 50, "mtimeMs now matches the file on disk");

  // /state's payload carries the sort keys: mtimeMs and sizeBytes are real numbers, path is where it lives
  const state = (await b.router.dispatch("GET", "/state")).body as { docs: Array<Record<string, unknown>> };
  const stReport = state.docs.find((d) => d.docId === report.docId)!;
  assert.equal(typeof stReport.mtimeMs, "number");
  assert.equal(stReport.sizeBytes, bigger.length);
  assert.equal(stReport.path, path.join(ws, "report.docx"));

  // export of a scanned doc serves the REAL file's bytes as an attachment (fileFor honors DocMeta.path)
  const ex = await b.router.dispatch("GET", `/documents/${report.docId}/export`);
  assert.equal(ex.statusCode, 200);
  assert.ok(Buffer.compare(Buffer.from(ex.data as Buffer), bigger) === 0);
  assert.match(String(ex.headers["content-disposition"]), /filename="report\.docx"/);

  // the manual import surface is GONE: no route registered at all (MiniRouter throws, not a coded refusal)
  await assert.rejects(b.router.dispatch("POST", "/import", { path: path.join(ws, "report.docx") }), /no registered POST route for \/import/);

  fs.rmSync(ws, { recursive: true, force: true });
  await b.cleanup();
});

test("/documents/rescan: a docx with pre-existing comments is stamped with an importedBaseline at index time", async () => {
  const b = await boot();
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "office-ws-baseline-"));
  const docBytes = rewriteZip(await store.templateDocx(), { "word/comments.xml": commentsXmlWith([
    { id: "1", author: "Cara", text: "a mention from before the library existed" },
  ]) });
  fs.writeFileSync(path.join(ws, "legacy.docx"), docBytes);
  pointFoldersAt(b, ws);

  const res = await b.router.dispatch("POST", "/documents/rescan");
  assert.equal(res.statusCode, 200);
  const doc = store.listDocs(b.root).find((d) => d.title === "legacy")!;
  assert.deepEqual(doc.importedBaseline, ["1"], "the file's own comment history is the first-save baseline -- index time must not wake anyone");
  fs.rmSync(ws, { recursive: true, force: true });
  await b.cleanup();
});

/** Minimal comments.xml body for a docx (ping.test has its own richer variant). */
function commentsXmlWith(comments: Array<{ id: string; author: string; text: string }>): string {
  const items = comments.map((c) => `<w:comment w:id="${c.id}" w:author="${c.author}"><w:p><w:r><w:t>${c.text}</w:t></w:r></w:p></w:comment>`).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${items}</w:comments>`;
}

/* ---------------- /settings + container routes ---------------- */

test("/settings: enable fires ensureContainer exactly once with the settings tag; disable stops + leaves the user-stopped marker", async () => {
  const m = makeDocker();
  const b = await boot(undefined, m.docker);
  assert.equal(store.listDocs(b.root).length, 0);
  // a LEGACY settings file (written before the removed switch existed) must load without crashing -- write it
  // before any POST so every route in this test runs over tolerant loading; saveSettings then rewrites it clean.
  fs.writeFileSync(path.join(b.root, "settings.json"), JSON.stringify({ enabled: false, imageTag: DEFAULT_TAG, coEdit: true }));

  // enable: side effect is fire-and-forget -- poll for the create, not the response
  let res = await b.router.dispatch("POST", "/settings", { enabled: true });
  assert.equal(res.statusCode, 200);
  const body = res.body as Record<string, unknown>;
  assert.equal((body.settings as Record<string, unknown>).enabled, true);
  assert.equal(body.starting, true, "the response says the start is underway");
  await until(() => m.calls.create.length === 1);
  const [name, spec] = m.calls.create[0];
  assert.equal(name, "pithagoras-office-ds");
  assert.equal(spec.Image, DEFAULT_TAG, "the tag comes from settings (default), not a constant");
  assert.ok((spec.Env as string[]).includes(`JWT_SECRET=${jwtSecret(b.root)}`), "the container is env'd with the boot secret");
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(b.root, "ds.json"), "utf8")), { containerId: "cid-1", origin: "http://127.0.0.1", imageTag: DEFAULT_TAG });
  await until(() => m.calls.start.length === 1);

  // a second enable is an adopt: no second create, no restart
  res = await b.router.dispatch("POST", "/settings", { enabled: true });
  assert.equal((res.body as Record<string, unknown>).starting, undefined, "already enabled -> no start fired");
  await new Promise((r) => setTimeout(r, 100)); // give a stray fire-and-forget a chance to (wrongly) run
  assert.equal(m.calls.create.length, 1);
  assert.equal(m.calls.start.length, 1);

  // disable: awaited stop + the intent marker on disk
  res = await b.router.dispatch("POST", "/settings", { enabled: false });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(m.calls.stop, ["pithagoras-office-ds"]);
  assert.ok(fs.existsSync(path.join(b.root, "user-stopped")), "user-stopped marker file written");
  assert.equal((res.body as { settings: Record<string, unknown> }).settings.enabled, false);
  assert.equal((res.body as { container: Record<string, unknown> }).container.state, "stopped");

  // and :latest is refused with a real reason
  res = await b.router.dispatch("POST", "/settings", { imageTag: "onlyoffice/documentserver:latest" });
  assert.equal(res.statusCode, 400);
  assert.equal((res.body as Record<string, unknown>).code, "invalid_image_tag");

  // there is no co-editing switch in this payload any more (the agent is a co-editor under the revision gate,
  // full stop): a body carrying only the LEGACY key hits the existing no-known-setting path and changes nothing
  res = await b.router.dispatch("POST", "/settings", { coEdit: true });
  assert.equal(res.statusCode, 400);
  assert.match(String((res.body as Record<string, unknown>).error), /no known setting/);
  const after = await b.router.dispatch("GET", "/state");
  assert.equal(after.statusCode, 200, "a legacy key in the body must not wedge the state poller");
  assert.ok(!JSON.stringify(after.body).includes("coEdit"), "the removed setting never lands in the /state payload");

  // the audit sink got the settings change
  assert.ok(b.audits.some((a) => String(a.subject).includes("settings")), "the settings change was audited");

  live.resetLive();
  await b.cleanup();
});

test("/container/status + /container/start + /container/stop drive the same lifecycle", async () => {
  const m = makeDocker();
  const b = await boot(undefined, m.docker);

  let res = await b.router.dispatch("GET", "/container/status");
  assert.equal(res.statusCode, 200);
  assert.equal((res.body as Record<string, unknown>).state, "stopped");

  res = await b.router.dispatch("POST", "/container/start");
  assert.equal(res.statusCode, 200);
  assert.equal((res.body as Record<string, unknown>).started, true);
  assert.equal((res.body as { container: Record<string, unknown> }).container.state, "running");

  res = await b.router.dispatch("POST", "/container/start"); // idempotent adopt
  assert.equal((res.body as Record<string, unknown>).started, false);
  assert.equal(m.calls.start.length, 1, "never restarted");

  res = await b.router.dispatch("POST", "/container/stop");
  assert.equal(res.statusCode, 200);
  assert.deepEqual(m.calls.stop, ["pithagoras-office-ds"]);
  assert.ok(fs.existsSync(path.join(b.root, "user-stopped")));

  live.resetLive();
  await b.cleanup();
});

/* ---------------- settleKept ---------------- */

test("settleKept: stale index entries are pruned, orphan dirs stay, fresh trash is kept and old trash is swept", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "office-settle-"));
  // a real doc (bytes present) + a ghost entry whose dir vanished out-of-band + an orphan dir with NO index entry
  const real: store.DocMeta = { docId: "real-1", title: "Real", ext: "docx", createdAt: 1, updatedAt: 1, sizeBytes: 3, mtimeMs: 1, owner: null, grants: [] };
  const ghost: store.DocMeta = { ...real, docId: "ghost-1", title: "Gone" };
  fs.mkdirSync(path.join(root, "docs", "real-1"), { recursive: true });
  fs.writeFileSync(path.join(root, "docs", "real-1", "Real.docx"), "abc");
  fs.mkdirSync(path.join(root, "docs", "orphan-9"), { recursive: true }); // index is the source of truth: NOT added back
  fs.writeFileSync(path.join(root, "index.json"), JSON.stringify({ version: 1, docs: [real, ghost] }));

  const day = 24 * 60 * 60 * 1000;
  const now = Date.now();
  const oldStamp = `${now - 8 * day}-old-doc`; // > 7 days -> swept
  const freshStamp = `${now - 2 * day}-fresh-doc`; // kept
  fs.mkdirSync(path.join(root, ".trash", oldStamp), { recursive: true });
  fs.mkdirSync(path.join(root, ".trash", freshStamp), { recursive: true });
  fs.mkdirSync(path.join(root, ".trash", "not-a-timestamp"), { recursive: true }); // not a deleteDoc entry -> untouched

  const out = settleKept(root);
  assert.equal(out.sweptTrash, 1);
  assert.deepEqual(out.prunedDocs, ["ghost-1"]);

  const idx = JSON.parse(fs.readFileSync(path.join(root, "index.json"), "utf8")) as { docs: store.DocMeta[] };
  assert.deepEqual(idx.docs.map((d) => d.docId), ["real-1"], "the ghost entry is gone and the orphan dir was NOT indexed");
  assert.ok(!fs.existsSync(path.join(root, ".trash", oldStamp)), "the 8-day-old trash entry was swept");
  assert.ok(fs.existsSync(path.join(root, ".trash", freshStamp)), "the 2-day-old trash entry stays (7-day TTL)");
  assert.ok(fs.existsSync(path.join(root, ".trash", "not-a-timestamp")), "non-deleteDoc entries are untouched");
});

/* ---------------- GET /ds/* (browser -> DS proxy) ---------------- */

const API_JS_BYTES = Buffer.from("// stand-in for the real api.js: getBasePath() walks document scripts\nwindow.DocsAPI={};");

/** A fake Document Server on an ephemeral 127.0.0.1 port: serves /web-apps/... with a body + content-type,
 * answers a dedicated 404, and records every raw request url it received (the verbatim-pass-through proof). */
function startFakeDs(): Promise<{ server: http.Server; port: number; urls: string[] }> {
  const urls: string[] = [];
  const server = http.createServer((req, res) => {
    urls.push(req.url);
    if (req.method === "GET" && req.url?.startsWith("/web-apps/")) {
      res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "no-cache" });
      res.end(API_JS_BYTES);
      return;
    }
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("nope");
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve({ server, port: (server.address() as AddressInfo).port, urls }));
  });
}

test("/ds proxy: 200 passes the body, content-type and the RAW query string verbatim to the recorded DS origin", async () => {
  const b = await boot();
  const ds = await startFakeDs();
  try {
    writeDsJson(b.root, `http://127.0.0.1:${ds.port}`);
    // the iframe-style query: percent-encoded chars must arrive upstream byte-for-byte (no re-encoding)
    const q = "/ds/web-apps/apps/api/documents/api.js?dockey=a%2Bb~c&lang=en-US&x=1%20two";
    const res = await b.router.dispatch("GET", q);
    assert.equal(res.statusCode, 200, "the upstream status passes through");
    assert.equal(Buffer.from(res.data as Buffer).compare(API_JS_BYTES), 0, "the body bytes are byte-for-byte what the DS sent");
    assert.match(String(res.headers["content-type"]), /application\/javascript/, "content-type is copied");
    assert.equal(res.headers["cache-control"], "no-cache", "cache-control is copied");
    const upstream = ds.urls.at(-1);
    assert.ok(upstream !== undefined, "the fake DS was hit");
    assert.equal(upstream, q.replace(/^\/ds/, ""), "path + raw query string reached the DS untouched (no re-encoding)");
  } finally {
    ds.server.closeAllConnections();
    await new Promise<void>((r) => ds.server.close(() => r()));
    await b.cleanup();
  }
});

test("/ds proxy: an upstream 404 passes through as a 404 with the upstream body", async () => {
  const b = await boot();
  const ds = await startFakeDs();
  try {
    writeDsJson(b.root, `http://127.0.0.1:${ds.port}`);
    const res = await b.router.dispatch("GET", "/ds/missing/page.html?dockey=z");
    assert.equal(res.statusCode, 404, "the upstream status passes through");
    assert.match(String(res.data), /nope/, "the upstream body passes through");
  } finally {
    ds.server.closeAllConnections();
    await new Promise<void>((r) => ds.server.close(() => r()));
    await b.cleanup();
  }
});

test("/ds proxy: an identity request answered with GZIP bytes + LYING headers still delivers the FULL original payload", async () => {
  // The exact PR #307 bug, replayed against a hostile upstream: it honours NOTHING -- it answers our
  // accept-encoding: identity ask with a gzip body while declaring content-encoding: gzip and a
  // content-length sized to the COMPRESSED bytes. undici auto-decodes the gzip; the handler must not copy
  // either lying header, so the client reads every original byte intact -- no truncation, no manual gunzip.
  const ORIGINAL = Buffer.concat(Array.from({ length: 64 }, () => API_JS_BYTES));
  assert.ok(ORIGINAL.length > 1024, "sanity: the payload is big enough for gzip to shrink it");
  const gzipped = zlib.gzipSync(ORIGINAL);
  assert.ok(gzipped.length < ORIGINAL.length, "sanity: the gzip body is really smaller than the original");
  const b = await boot();
  const seenEncodings: string[] = [];
  let server: http.Server | undefined;
  try {
    server = http.createServer((req, res) => {
      seenEncodings.push(req.headers["accept-encoding"] ?? "");
      res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8", "Content-Encoding": "gzip", "Content-Length": gzipped.length });
      res.end(gzipped);
    });
    await new Promise<void>((resolve, reject) => { server!.once("error", reject); server!.listen(0, "127.0.0.1", () => resolve()); });
    const port = (server.address() as AddressInfo).port;
    writeDsJson(b.root, `http://127.0.0.1:${port}`);
    const res = await b.router.dispatch("GET", "/ds/web-apps/apps/api/documents/api.js");
    assert.equal(res.statusCode, 200, "the upstream status passes through");
    assert.equal(seenEncodings.at(-1), "identity", "the proxy asks the DS for an UNENCODED body");
    assert.match(String(res.headers["content-type"]), /application\/javascript/, "the content-type passes through");
    assert.equal(res.headers["content-encoding"], undefined, "the (lying) upstream content-encoding is NOT copied");
    assert.ok(!Object.keys(res.headers).includes("content-length"), "no upstream-declared content-length is forwarded -- Node sizes the real buffer");
    assert.equal(Buffer.from(res.data as Buffer).compare(ORIGINAL), 0, "the FULL original payload arrives intact (undici decoded it; no truncation at the lying length)");
  } finally {
    if (server) { server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())); }
    await b.cleanup();
  }
});

test("/ds proxy: a dead origin -> 503 {code:'ds_unavailable'} and a log line", async () => {
  const b = await boot();
  try {
    // an ephemeral port nothing listens on: bind one, close it, reuse the number for the dead target
    const dead = http.createServer();
    await new Promise<void>((resolve, reject) => { dead.once("error", reject); dead.listen(0, "127.0.0.1", () => resolve()); });
    const port = (dead.address() as AddressInfo).port;
    await new Promise<void>((r) => dead.close(() => r()));
    writeDsJson(b.root, `http://127.0.0.1:${port}`);

    const res = await b.router.dispatch("GET", "/ds/web-apps/apps/api/documents/api.js");
    assert.equal(res.statusCode, 503);
    assert.deepEqual(res.body, { error: `the document server at http://127.0.0.1:${port} did not answer`, code: "ds_unavailable" });
    assert.ok(b.logs.some((l) => l.includes("GET /ds/") && l.includes(`http://127.0.0.1:${port}`)), "the failure left a log line");
  } finally {
    await b.cleanup();
  }
});

test("/ds proxy: an unconfigured data dir -> 503 {code:'ds_not_configured'}; a container: origin -> the same 422 /editor-config refusal", async () => {
  const b = await boot(); // fresh root, no ds.json
  try {
    const none = await b.router.dispatch("GET", "/ds/web-apps/apps/api/documents/api.js");
    assert.equal(none.statusCode, 503);
    assert.equal((none.body as Record<string, unknown>).code, "ds_not_configured");

    writeDsJson(b.root, "container:cid-ab12");
    const cc = await b.router.dispatch("GET", "/ds/web-apps/apps/api/documents/api.js");
    assert.equal(cc.statusCode, 422);
    const body = cc.body as Record<string, unknown>;
    assert.equal(body.code, "unresolvable_ds_origin");
    assert.equal(body.origin, "container:cid-ab12", "same refusal family as /editor-config");
  } finally {
    await b.cleanup();
  }
});

/** A fake engine.io polling endpoint: answers the handshake GET and records every POST body it received.
 * The real docserver's /<app>/10.0.0-<buildhash>/doc/<key>/c/ speaks exactly this shape (replayed live). */
function startFakeEngineIo(holdMs = 0): Promise<{ server: http.Server; port: number; posts: string[] }> {
  const posts: string[] = [];
  const HANDSHAKE = '0{"sid":"Zkx0F6Y_6ZptlT-cAAKS","upgrades":["websocket"],"pingInterval":25000,"pingTimeout":20000,"maxPayload":100000000}';
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url?.startsWith("/c/?")) {
      if (holdMs > 0) setTimeout(() => { res.writeHead(200, { "Content-Type": "text/plain" }); res.end(HANDSHAKE); }, holdMs);
      else { res.writeHead(200, { "Content-Type": "text/plain" }); res.end(HANDSHAKE); }
      return;
    }
    if (req.method === "POST" && req.url?.startsWith("/c/?")) {
      let b = "";
      req.on("data", (d: string) => (b += d));
      req.on("end", () => { posts.push(b); res.writeHead(200, { "Content-Type": "text/plain" }); res.end(""); });
      return;
    }
    res.writeHead(404); res.end("nope");
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve({ server, port: (server.address() as AddressInfo).port, posts }));
  });
}

test("/ds proxy: a POST forwards method + raw body verbatim to the DS (the socket.io client channel)", async () => {
  // The editor app's doc channel: engine.io GETs handshake, then its packets (the "40" connect packet and on
  // every state change) arrive as POSTs to the same /c/ path. A GET-only proxy answered those with the core's
  // 404 and the channel never opened -- the white-spinner root cause (reproduced live against DS 10.0).
  const ds = await startFakeEngineIo();
  const b = await boot();
  try {
    writeDsJson(b.root, `http://127.0.0.1:${ds.port}`);
    const res = await b.router.dispatch("POST", "/ds/c/?EIO=4&transport=polling&sid=Zkx0F6Y_6ZptlT-cAAKS", "40", { "content-type": "text/plain;charset=UTF-8" });
    assert.equal(res.statusCode, 200, "the upstream answer passes back through the proxy");
    assert.deepEqual(ds.posts, ["40"], "the raw engine.io packet arrived at the DS byte-for-byte with its query string");
  } finally {
    ds.server.closeAllConnections();
    await new Promise<void>((r) => ds.server.close(() => r()));
    await b.cleanup();
  }
});

test("/ds proxy: an engine.io handshake loses its websocket upgrade offer (this proxy is polling-only)", async () => {
  // fetch cannot relay WebSocket frames, so advertising upgrades:["websocket"] would only end in failed-upgrade
  // churn; the handler strips it from outbound handshakes and pins the client to long-polling.
  const ds = await startFakeEngineIo();
  const b = await boot();
  try {
    writeDsJson(b.root, `http://127.0.0.1:${ds.port}`);
    const res = await b.router.dispatch("GET", "/ds/c/?EIO=4&transport=polling");
    assert.equal(res.statusCode, 200);
    const raw = String(res.data as Buffer | string);
    assert.ok(raw.startsWith("0{"), "the EIO handshake prefix is preserved");
    const hs = JSON.parse(raw.slice(1)) as Record<string, unknown>;
    assert.equal(hs.sid, "Zkx0F6Y_6ZptlT-cAAKS", "everything else in the handshake is untouched");
    assert.ok(!Array.isArray(hs.upgrades) || !hs.upgrades.includes("websocket"), "no websocket upgrade is offered to the client");
  } finally {
    ds.server.closeAllConnections();
    await new Promise<void>((r) => ds.server.close(() => r()));
    await b.cleanup();
  }
});

test("/ds proxy: an idle long-poll HELD past the old 15s cutoff still comes back (engine.io keeps polls open until it has data)", async () => {
  // The pre-fix handler aborted every upstream fetch after exactly 15s -- and undici's abort also closes the
  // upstream socket, which docserver logs as a 499 at precisely that moment. engine.io pings at least every
  // 25s, so a healthy poll can sit empty for longer than 15s; the window must cover a full ping cycle.
  const ds = await startFakeEngineIo(16_500); // held open just past the old 15_000ms cutoff
  const b = await boot();
  try {
    writeDsJson(b.root, `http://127.0.0.1:${ds.port}`);
    const t0 = Date.now();
    const res = await b.router.dispatch("GET", "/ds/c/?EIO=4&transport=polling");
    assert.equal(res.statusCode, 200, "the held poll answers instead of a ds_unavailable abort");
    assert.match(String(res.data as Buffer | string), /Zkx0F6Y_6ZptlT-cAAKS/, "the handshake body arrives after the hold");
    assert.ok(Date.now() - t0 >= 15_000, "it really waited out the old cutoff window before answering");
  } finally {
    ds.server.closeAllConnections();
    await new Promise<void>((r) => ds.server.close(() => r()));
    await b.cleanup();
  }
});


