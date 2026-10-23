/**
 * Unit tests for src/server.ts (T-WIRE): the boot wiring, the loopback listener, and every UI route -- against a
 * FAKE portal (mini router + recorded log/audit/extensions.use) with real tmp dataDirs and a recording fake Docker
 * literal. Nothing here reaches the real portal(), the Docker socket, or any network host but 127.0.0.1 loopback
 * (the listener itself). Booted instances are cleaned up at the end of each test; live-module presence is reset for
 * isolation because it is process-global.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ServerPortal } from "@pithagoras/extension-api/server";
import type { ContainerInfo, Docker, ExecResult, VolumeInfo } from "../../docker/src/api";
import officeServer, { dsOrigin, jwtSecret, loopbackPort, makeForcesaveHook, settleKept } from "../src/server";
import * as store from "../src/store";
import * as live from "../src/live";
import { mintTicket, verifyTicket } from "../src/tickets";
import { verifyJwt } from "../src/jwt";
import { makeKey, parseKey, revHashOf } from "../src/callback";

const DEFAULT_TAG = "onlyoffice/documentserver:10.0";

/* ------------------------------------------------------------------ */
/* fakes                                                               */
/* ------------------------------------------------------------------ */

class MiniRouter {
  routes: Array<{ method: string; pattern: string; handler: (req: unknown, res: FakeRes) => Promise<void> | void }> = [];
  private reg(method: string) {
    return (pattern: string, ...rest: unknown[]) => {
      const handler = rest[rest.length - 1] as (req: unknown, res: FakeRes) => Promise<void> | void;
      this.routes.push({ method, pattern, handler });
    };
  }
  /** Express-shaped registration: (pattern, ...middlewares, handler). */
  get(...args: unknown[]) { this.reg("GET")(...args); }
  post(...args: unknown[]) { this.reg("POST")(...args); }
  put(...args: unknown[]) { this.reg("PUT")(...args); }
  delete(...args: unknown[]) { this.reg("DELETE")(...args); }

  async dispatch(method: string, urlPath: string, body: unknown): Promise<FakeRes> {
    const us = urlPath.split("/").filter(Boolean);
    for (const route of this.routes) {
      if (route.method !== method) continue;
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
      await route.handler({ method, url: urlPath, params, query: {}, body }, res);
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
  // api.js src: the browser-facing DS origin (ds.json option a) + the fixed path
  assert.equal(body.apiJs, "http://127.0.0.1/web-apps/apps/api/documents/api.js");
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
  assert.deepEqual(Object.keys(body).sort(), ["coEdit", "container", "docs", "enabled", "imageTag", "locks"]);
  assert.equal(body.enabled, false); // defaults from a fresh dataDir
  assert.equal(body.imageTag, DEFAULT_TAG);
  assert.equal(body.coEdit, true);
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

/* ---------------- /import + /export ---------------- */

test("/import: allowed folder passes (bytes copied), outside is 403 not_allowed, bad ext 415, missing 404", async () => {
  const b = await boot();
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "office-ws-"));
  b.allowedDirs.push(ws);
  const srcBytes = Buffer.from(`a docx of sorts ${Date.now()}`);
  fs.writeFileSync(path.join(ws, "report.docx"), srcBytes);

  let res = await b.router.dispatch("POST", "/import", { path: path.join(ws, "report.docx") });
  assert.equal(res.statusCode, 201);
  const doc = res.body as store.DocMeta;
  assert.equal(doc.title, "report"); // basename without extension
  assert.equal(doc.ext, "docx");
  const libBytes = fs.readFileSync(path.join(b.root, "docs", doc.docId, "report.docx"));
  assert.ok(Buffer.compare(libBytes, srcBytes) === 0);

  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "office-outside-"));
  fs.writeFileSync(path.join(outside, "sneaky.docx"), srcBytes);
  res = await b.router.dispatch("POST", "/import", { path: path.join(outside, "sneaky.docx") });
  assert.equal(res.statusCode, 403);
  const body = res.body as Record<string, unknown>;
  assert.equal(body.code, "not_allowed");

  fs.writeFileSync(path.join(ws, "notes.txt"), "plain text is not office");
  res = await b.router.dispatch("POST", "/import", { path: path.join(ws, "notes.txt") });
  assert.equal(res.statusCode, 415);
  assert.equal((res.body as Record<string, unknown>).code, "unsupported_format");

  res = await b.router.dispatch("POST", "/import", { path: path.join(ws, "ghost.docx") });
  assert.equal(res.statusCode, 404);
  assert.equal((res.body as Record<string, unknown>).code, "not_found");

  // export of the imported doc: a fresh copy served as an attachment
  res = await b.router.dispatch("GET", `/documents/${doc.docId}/export`);
  assert.equal(res.statusCode, 200);
  assert.ok(Buffer.compare(Buffer.from(res.data as Buffer), srcBytes) === 0);
  assert.match(String(res.headers["content-disposition"]), /filename="report\.docx"/);

  await b.cleanup();
});

/* ---------------- /settings + container routes ---------------- */

test("/settings: enable fires ensureContainer exactly once with the settings tag; disable stops + leaves the user-stopped marker", async () => {
  const m = makeDocker();
  const b = await boot(undefined, m.docker);
  assert.equal(store.listDocs(b.root).length, 0);

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

/* ---------------- settleKept + forcesave hook ---------------- */

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

test("makeForcesaveHook: no-op without open sessions; one audit line per session group while somebody is in it", async () => {
  const b = await boot();
  const doc = await store.createDoc({ title: "Hooked", type: "word" }, b.root);
  const hook = makeForcesaveHook();

  const auditsBefore = b.audits.length;
  await hook(doc.docId); // nobody open
  assert.equal(b.audits.length, auditsBefore, "no audit line when no session is open");

  live.setUser(doc.docId, { id: "u-ada", name: "Ada" }, true);
  await hook(doc.docId);
  assert.equal(b.audits.length, auditsBefore + 1);
  const last = b.audits[b.audits.length - 1];
  assert.equal(last.subject, doc.docId);
  assert.match(String(last.reason), /forcesave requested while 1 editor session/);
  // and the log line landed too (the one-line audit that also hits portal().log)
  assert.ok(b.logs.some((l) => l.includes(`pithagoras-office: ${doc.docId}`)));

  live.resetLive();
  await b.cleanup();
});
