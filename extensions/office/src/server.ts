/**
 * The server half of pithagoras-office -- the portal start/stop entry (the built server.js behind package.json's
 * `server` field). Boots exactly what the contract's "server.ts" section fixes, over the seams this wave commits:
 *
 *   1. setPortal(portal) + the shared HS256 secret file dataDir()/jwt-secret (0600; created ONCE with
 *      crypto.randomBytes(32).toString("hex"), reused on every later boot -- one secret for callback JWTs,
 *      document tickets AND editor-config signing: plan 5.6).
 *   2. registerTools({record}), wirePing({root, record}) -- both audit sinks land in portal().audit AND a log line.
 *   3. The co-editor model (plan 5.7): there is NO co-editing switch and NO hook to wire -- office_edit
 *      proceeds under the strict mtime/revision gate no matter who has the editor open, and a stale edit is
 *      refused loudly as a conflict (fail loud, re-read + retry). Nothing here installs any refusal machinery.
 *   4. callback.configure(...) once, with getState = () => container.readDsRecord(root) and the boot secret;
 *      live.setMetaResolver(docId -> store.getDoc(docId, root)?.mtimeMs ?? null).
 *   5. The UI routes on portal.router (mounted by core at /api/x/pithagoras-office, session-gated there): see the
 *      route table in .reports/T-WIRE.md; every error is JSON {error, message?, code?}.
 *   6. The cookie-free LOOPBACK listener (plan 5.2 design decision): http bound to 127.0.0.1 port 0 that serves ONLY
 *      GET /doc/<ticket> (a fresh document fetch for the editor: verifyTicket -> bytes, no-store) and POST /callback
 *      (the DS callback, callback.handleCallback). Everything else is a 404 JSON. This origin -- not dsOrigin() --
 *      is what document.url and editorConfig.callbackUrl point at in the minted config (a container cannot fetch a
 *      browser-only origin; "container:<id>" origins have no URL at all). Divergence from the contract's one-liner,
 *      documented.
 *   7. Boot: settleKept() (.trash >7d sweep + index-vs-disk prune) FIRST, then the workspace scan
 *      (store.scanWorkspace over portal().folders.list(): every .docx/.xlsx of the agent homes and projects
 *      indexed IN PLACE -- manual import is gone, the scanned file IS the document; POST /documents/rescan
 *      re-runs it on demand) + container.lookAfter() (adopt an existing DS),
 *      then a 30_000 ms unref'd interval that re-runs settleKept+lookAfter. The returned cleanup closes the listener and clears it.
 *   8. deps.js, the pithagoras-docs pattern: ensureDependencies runs at boot IN THE BACKGROUND (this module has NO
 *      static jszip import, so a folder without node_modules imports cleanly) and arms jsZip() to wait for it --
 *      the first template call blocks on the install; later calls use the one cached load. A create that still
 *      hits an unready dependency answers 503 code "dependencies_pending" (retryable) and logs why.
 *
 * dsOrigin(): ONE function, per the contract -- the origin read straight out of ds.json (network-mode option (a),
 * plan 5.2: host-networked DS at http://127.0.0.1). The BROWSER now reaches it through the portal's GET /ds/ reverse
 * proxy (api.js, the editor iframe and every asset -- same-origin, behind the session gate like every route here):
 * apiJs is that root-relative prefix, and api.js' getBasePath() turns it into the editor's base URL. What stays an
 * ABSOLUTE LOOPBACK URL in the signed config is document.url and editorConfig.callbackUrl: those are fetched by the
 * DS server-side (host netns -> loopback works), never by a browser -- leave them exactly as-is. When the recorded
 * origin is a "container:<id>" marker there is NO usable URL in v1: it is returned as-is and /editor-config AND /ds
 * refuse with a clear JSON error saying that deployment shape needs an M0 decision.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type { ServerPortal } from "@pithagoras/extension-api/server";
import { setPortal, portal, dataDir } from "./host";
import * as container from "./container";
import { loadSettings, saveSettings, type OfficeSettings } from "./settings";
import { signJwt } from "./jwt";
import { mintTicket, verifyTicket } from "./tickets";
import * as store from "./store";
import * as live from "./live";
import * as callback from "./callback";
import { wirePing } from "./ping";
import { registerTools } from "./tools";
import { ensureDependencies } from "../deps.js"; // the pithagoras-docs pattern: its own node_modules installed at boot, in the background
import { armJsZipInstall } from "./jszip";

/* ------------------------------------------------------------------ */
/* constants                                                           */
/* ------------------------------------------------------------------ */

/** The editor-config JWT lives 15 minutes: the official DS signing sample uses expiresIn 15*60, and a config is
 * only ever handed to a fresh api.js load right after minting. */
const CONFIG_TTL_MS = 15 * 60 * 1000;
/** A document ticket lives 10 minutes: one editor open-and-fetch window (the tickets module's own default). */
const TICKET_TTL_MS = 600_000;
/** The fallback identity the minted config claims: portal exposes no per-route session user in v1, so every
 * co-edited doc shows this seat (plan 5.6 editorConfig.user). */
const EDITOR_USER = { id: "portal-user", name: "Portal" } as const;

const DOCX_MEDIA = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX_MEDIA = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
function mediaType(ext: "docx" | "xlsx"): string {
  return ext === "docx" ? DOCX_MEDIA : XLSX_MEDIA;
}

/* ------------------------------------------------------------------ */
/* module state (one boot per portal start; the host re-runs us)       */
/* ------------------------------------------------------------------ */

/** Port of the loopback listener once booted (0 before boot / after cleanup); tests reach it via this. */
let loopPort = 0;
export function loopbackPort(): number {
  return loopPort;
}

function logLine(line: string): void {
  try {
    portal().log(line);
  } catch {
    // pre-portal (unit seams) or a dead portal -- console is the floor, never crash a boot.
    console.error(line);
  }
}

/** The ONE audit sink for this wave: every mutating op lands in portal().audit AND as one log line. */
function recordAudit(entry: { subject: string; reason?: string; chatId?: string }): void {
  const line = `pithagoras-office: ${entry.subject}${entry.reason ? ` -- ${entry.reason}` : ""}${entry.chatId ? ` (chat ${entry.chatId})` : ""}`;
  try {
    portal().audit.record({ subject: entry.subject, reason: entry.reason, chatId: entry.chatId });
  } catch (e) {
    logLine(`audit.record refused the entry: ${(e as Error).message}`);
  }
  logLine(line);
}

/* ------------------------------------------------------------------ */
/* the shared secret                                                   */
/* ------------------------------------------------------------------ */

/** Create dataDir()/jwt-secret ONCE -- mode 0600, explicit chmod (umask-proof), hex of crypto.randomBytes(32) -- and
 * return its trimmed content. Existing files are reused byte-for-byte (second boot and every one after). */
function ensureJwtSecret(dd: string): string {
  fs.mkdirSync(dd, { recursive: true });
  const file = path.join(dd, "jwt-secret");
  let raw = "";
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    raw = ""; // missing: generated below
  }
  if (raw.trim().length < 32) fs.writeFileSync(file, randomBytes(32).toString("hex") + "\n", { mode: 0o600 }); // empty or truncated too soon to be a usable secret: (re)generate rather than reuse
  fs.chmodSync(file, 0o600); // the exact perms either way -- never rely on the process umask
  return fs.readFileSync(file, "utf8").trim();
}

/** Read the boot secret from `root` (the portal dataDir by default). Boot creates the file; this only reads. */
export function jwtSecret(root?: string): string {
  return fs.readFileSync(path.join(root ?? dataDir(), "jwt-secret"), "utf8").trim();
}

/* ------------------------------------------------------------------ */
/* settleKept                                                          */
/* ------------------------------------------------------------------ */

/** Reconcile the library with what is on disk: sweep .trash entries older than 7 days, then drop index entries
 * whose library file vanished (store.pruneMissingDocs). The index is the source of truth -- a docs/<id>/ dir with no
 * entry is NOT added back. Pure function of (root): booted at start and on the interval, unit-tested directly. */
export function settleKept(root?: string): { sweptTrash: number; prunedDocs: string[] } {
  const dd = root ?? dataDir();
  return { sweptTrash: store.sweepTrash(dd), prunedDocs: store.pruneMissingDocs(dd) };
}

/* ------------------------------------------------------------------ */
/* small response helpers                                              */
/* ------------------------------------------------------------------ */

/** A failure of the LAZY jszip load (deps.js): its module import is refused while npm still installs in the
 * background at boot, or the install failed and the next call has not retried yet. Recognized on the error chain,
 * not by message cosmetics alone: ERR_MODULE_NOT_FOUND naming jszip, or a message that names the dependency
 * install. A 503 retryable answer is right for BOTH (the other codes -- exists/corrupt index -- are not). */
function isDependencyError(e: unknown): boolean {
  let cur: unknown = e;
  for (let i = 0; cur && i < 10; i++) {
    const ce = cur as { code?: string; message?: string };
    if (ce.code === "ERR_MODULE_NOT_FOUND" && /jszip/i.test(ce.message ?? "")) return true;
    if (/Cannot find package 'jszip'|installing its dependencies|Could not install its dependencies/i.test(ce.message ?? "")) return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

const CODE_STATUS: Record<string, number> = {
  not_found: 404,
  exists: 409,
  unsupported_format: 415,
  invalid_title: 400,
  revision_mismatch: 409,
  index_corrupt: 500,
  no_docker: 503,
  too_large: 413, // store.importFile's 512 MiB import cap
};

/** Map the coded errors store/container throw onto consistent JSON {error, code?}. */
function codedResponse(res: { status: (c: number) => { json: (b: unknown) => void } }, e: unknown): void {
  const ce = e as Error & { code?: string };
  res.status(CODE_STATUS[ce.code ?? ""] ?? 500).json({ error: ce.message, ...(ce.code ? { code: ce.code } : {}) });
}

/** Where a doc's bytes live NOW: a scanned doc's real workspace file (DocMeta.path), else its library folder. */
function fileFor(root: string, doc: store.DocMeta): string {
  return doc.path ?? path.join(root, "docs", doc.docId, `${doc.title}.${doc.ext}`);
}

/** Content-Disposition for a download: an ASCII fallback name plus the RFC 5987 UTF-8 form for any non-ASCII title. */
function attachmentHeader(title: string, ext: string): string {
  const raw = `${title}.${ext}`;
  const ascii = raw.replace(/[^\x20-\x7e]/g, "-").replace(/["\\;:,]/g, "'");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(raw)}`;
}

function jsonRaw(res: http.ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return;
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

/* ------------------------------------------------------------------ */
/* the loopback listener (plan 5.2)                                    */
/* ------------------------------------------------------------------ */

function makeLoopbackHandler(dd: string, secret: string): (req: http.IncomingMessage, res: http.ServerResponse) => void {
  return (req, res) => {
    let pathname: string;
    try {
      pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    } catch {
      jsonRaw(res, 404, { error: "no such endpoint on the office loopback listener", code: "not_found" });
      return;
    }
    if (req.method === "GET" && pathname.startsWith("/doc/")) {
      // Tickets are base64url tokens: no percent-decoding -- decodeURIComponent would throw URIError on a
      // malformed escape, and an uncaught throw in the http listener kills the server. verifyTicket enforces the alphabet anyway.
      const ticket = pathname.slice("/doc/".length);
      const verified = verifyTicket(ticket, secret);
      if (!verified) {
        jsonRaw(res, 401, { error: "invalid or expired document ticket", code: "bad_ticket" });
        return;
      }
      const doc = store.getDoc(verified.docId, dd);
      if (!doc) {
        jsonRaw(res, 404, { error: `no such document ${verified.docId}`, code: "not_found" });
        return;
      }
      let bytes: Buffer;
      try {
        bytes = fs.readFileSync(fileFor(dd, doc));
      } catch {
        jsonRaw(res, 404, { error: `the library file for ${doc.docId} is missing from disk`, code: "not_found" });
        return;
      }
      res.writeHead(200, { "Content-Type": mediaType(doc.ext), "Cache-Control": "no-store" });
      res.end(bytes);
      return;
    }
    if (req.method === "POST" && pathname === "/callback") {
      callback.handleCallback(req, res);
      return;
    }
    jsonRaw(res, 404, { error: `no such endpoint on the office loopback listener (${req.method} ${pathname})`, code: "not_found" });
  };
}

/* ------------------------------------------------------------------ */
/* editor-config                                                       */
/* ------------------------------------------------------------------ */

/** Build (or refuse) the new DocsAPI.DocEditor config for `docId`. The plain object is signed WHOLE -- per the DS
 * signing rule ("the payload must have the same structure as the config"; since 7.1 sign exactly what you send) --
 * and returned as {...config, token, apiJs}: the page drops `apiJs` before calling DocEditor, everything else goes in. */
function buildEditorConfig(dd: string, secret: string, docId: string): { res?: unknown; config?: Record<string, unknown>; ticketUrl?: string } {
  const doc = store.getDoc(docId, dd);
  if (!doc) return { res: { status: 404, body: { error: `no document with id ${docId}`, code: "not_found" } } };

  const record = container.readDsRecord(dd);
  if (!record) return { res: { status: 503, body: { error: "the document server is not configured yet -- start it from the Office page first", code: "ds_not_configured" } } };
  // network-mode option (a): a "container:<id>" origin is a marker with no browser-reachable URL in v1 -- fail clearly.
  if (record.origin.startsWith("container:")) {
    return { res: { status: 422, body: { error: `the document server runs under ${record.origin}: that deployment shape cannot expose the editor to a browser until the M0 spike-2 decision lands`, code: "unresolvable_ds_origin", origin: record.origin } } };
  }

  const { token: ticket } = mintTicket(doc.docId, TICKET_TTL_MS, secret);
  // plan 5.2: document.url is the ticketed GET on OUR loopback listener (the container's fetch must reach a URL it
  // can actually dial -- never a browser-only origin); callbackUrl sits right next door.
  const base = `http://127.0.0.1:${loopPort}`;
  const config: Record<string, unknown> = {
    documentType: doc.ext === "docx" ? "word" : "cell",
    type: "embedded",
    title: doc.title,
    document: {
      fileType: doc.ext,
      key: callback.makeKey(doc.docId, doc.mtimeMs),
      title: `${doc.title}.${doc.ext}`,
      url: `${base}/doc/${ticket}`,
    },
    editorConfig: {
      callbackUrl: `${base}/callback`,
      mode: "edit",
      lang: "en", // v1 default -- portal exposes no per-user locale seam
      user: { id: EDITOR_USER.id, name: EDITOR_USER.name },
    },
  };
  live.setUser(doc.docId, { id: EDITOR_USER.id, name: EDITOR_USER.name }, true); // the seat opens: presence on mint
  return { config, ticketUrl: `${base}/doc/${ticket}` };
}

/* ------------------------------------------------------------------ */
/* the UI routes (core mounts portal.router at /api/x/pithagoras-office)*/
/* ------------------------------------------------------------------ */

function registerRoutes(dd: string, secret: string): void {
  const r = portal().router;
  const json = portal().http.json();

  /** GET /state -> settings + container status + the document list + who has what open. The poller's payload. */
  r.get("/state", async (_req, res) => {
    const s = loadSettings(dd);
    let c: Awaited<ReturnType<typeof container.status>>;
    try {
      c = await container.status(undefined, dd);
    } catch (e) {
      c = { state: "stopped", pull: null } as typeof c; // status() should not throw -- never kill the poller
      logLine(`container.status failed: ${(e as Error).message}`);
    }
    const docs = store.listDocs(dd);
    const locks: Record<string, { id: string; name?: string }[]> = {};
    for (const d of docs) {
      // every doc gets an entry -- the client badge code reads locks[docId] without a null check
      locks[d.docId] = live.usersOf(d.docId).map((u) => ({ id: u.id, name: u.name }));
    }
    res.json({ enabled: s.enabled, imageTag: s.imageTag, container: c, docs, locks });
  });

  /** POST /documents {title, type:"word"|"cell", owner?} -> 201 meta; 409 exists. A jszip load failure is NOT the
   * ordinary coded response: the dependency may still be installing in the background at boot (deps.js), so the
   * answer is a retryable 503 with code "dependencies_pending" -- the UI shows it verbatim and the click never dies
   * silently. Every other failure is logged too, so a live failure finally LEAVES A LINE in the portal's log
   * (the pre-fix routes logged nothing, which is why the first live create-failure had no trace to read). */
  r.post("/documents", json, async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const title = typeof body.title === "string" ? body.title : "";
    const type = body.type;
    if (title.trim() === "") return res.status(400).json({ error: "a document needs a non-empty { title }", code: "invalid_title" });
    if (type !== "word" && type !== "cell") return res.status(400).json({ error: '{ type } must be "word" or "cell"', code: "unsupported_format" });
    const owner = typeof body.owner === "string" && body.owner !== "" ? body.owner : null;
    try {
      const doc = await store.createDoc({ title, type, owner }, dd);
      recordAudit({ subject: title, reason: `created ${doc.ext} document ${doc.docId}`, chatId: owner ?? undefined });
      res.status(201).json(doc);
    } catch (e) {
      if (isDependencyError(e)) {
        logLine(`POST /documents failed while its jszip dependency is not ready yet: ${(e as Error).message}`);
        return res.status(503).json({
          error: "the document templates are not ready yet -- the extension's jszip dependency is still installing in the background (or its install failed; see the portal log). Retry in a few seconds.",
          code: "dependencies_pending",
        });
      }
      logLine(`POST /documents failed: ${(e as Error).message}`);
      codedResponse(res, e);
    }
  });

  /** POST /documents/rescan -> { added, updated }: re-run the workspace scan NOW over every agent folder (fresh from
   * portal().folders.list()), in addition to the automatic one at boot. The library UI's Rescan button calls it. */
  r.post("/documents/rescan", json, async (_req, res) => {
    try {
      const out = store.scanWorkspace(portal().folders.list().map((f) => f.path), dd);
      logLine(`workspace rescan: ${out.added} added, ${out.updated} refreshed`);
      res.json(out);
    } catch (e) {
      logLine(`workspace rescan failed: ${(e as Error).message}`);
      codedResponse(res, e);
    }
  });

  /** POST /documents/:id/rename {title} -> 200 the new meta; keeps mtimeMs (the open sessions' revision survives a retitle). */
  r.post("/documents/:id/rename", json, async (req, res) => {
    const id = String(req.params?.id ?? "");
    const body = (req.body ?? {}) as Record<string, unknown>;
    const title = typeof body.title === "string" ? body.title : "";
    if (title.trim() === "") return res.status(400).json({ error: "a rename needs a non-empty { title }", code: "invalid_title" });
    try {
      const doc = store.renameDoc(id, title, dd);
      recordAudit({ subject: `${doc.title} (${id})`, reason: `renamed from ${doc.title}`, chatId: undefined });
      res.json(doc);
    } catch (e) {
      codedResponse(res, e);
    }
  });

  /** GET /documents/:id -> the library bytes as an attachment (download). */
  r.get("/documents/:id", async (req, res) => {
    const doc = store.getDoc(String(req.params?.id ?? ""), dd);
    if (!doc) return res.status(404).json({ error: `no document with id ${String(req.params?.id ?? "")}`, code: "not_found" });
    let bytes: Buffer;
    try {
      bytes = fs.readFileSync(fileFor(dd, doc));
    } catch {
      return res.status(404).json({ error: `the library file for ${doc.docId} is missing from disk`, code: "not_found" });
    }
    res.setHeader("Content-Type", mediaType(doc.ext));
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Disposition", attachmentHeader(doc.title, doc.ext));
    res.end(bytes);
  });

  /** DELETE /documents/:id -> moved to .trash (settleKept reclaims after 7 days) + live presence cleared. */
  r.delete("/documents/:id", async (req, res) => {
    const id = String(req.params?.id ?? "");
    try {
      store.deleteDoc(id, dd);
    } catch (e) {
      codedResponse(res, e);
      return;
    }
    live.clearDoc(id); // nobody "has it open" for a gone doc anymore
    recordAudit({ subject: id, reason: "deleted (moved to .trash)" });
    res.json({ ok: true });
  });

  /** GET /documents/:id/export -> a FRESH copy of the current bytes, exported to a temp dir, served, and the temp
   * gone again (store.exportDoc writes `${title}.ext` next to nothing else -- nothing is ever overwritten). */
  r.get("/documents/:id/export", async (req, res) => {
    const id = String(req.params?.id ?? "");
    const doc = store.getDoc(id, dd);
    if (!doc) return res.status(404).json({ error: `no document with id ${id}`, code: "not_found" });
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "office-export-"));
    let bytes: Buffer;
    try {
      const written = store.exportDoc(id, tmp, dd);
      bytes = fs.readFileSync(written);
      recordAudit({ subject: doc.title, reason: `exported (download of a fresh copy)` });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
    res.setHeader("Content-Type", mediaType(doc.ext));
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Disposition", attachmentHeader(doc.title, doc.ext));
    res.end(bytes);
  });

  /** POST /editor-config {doc} -> the config object for `new DocsAPI.DocEditor(el, cfg)`: the plain fields plus
   * token = signJwt(the WHOLE plain config minus the token itself, 15 min) and apiJs (the script src -- drop it
   * before calling DocEditor). On a mint the seat joins live presence. See buildEditorConfig for the refusals. */
  r.post("/editor-config", json, async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const docId = typeof body.doc === "string" && body.doc !== "" ? body.doc : "";
    if (!docId) return res.status(400).json({ error: 'the body needs { doc: "<document id>" }' });
    const built = buildEditorConfig(dd, secret, docId);
    if (built.res) {
      const rr = built.res as { status: number; body: Record<string, unknown> };
      return res.status(rr.status).json(rr.body);
    }
    const config = built.config as Record<string, unknown>;
    // purpose "editor-config" (S3): the signed typ claim tags this token's family for any future in-portal
    // verification; DS itself checks only the HMAC/expiry and ignores the extra claim.
    // apiJs: ROOT-RELATIVE through this extension's /ds proxy. The browser resolves it against its own page origin
    // (exactly where the user reached the portal, session-gated) -- and api.js' getBasePath() takes everything before
    // "api/documents/api.js" in its script src as the editor iframe base, so the whole editor runs under that prefix.
    // It is NOT part of the signed payload (the client drops it before calling DocEditor).
    res.json({ ...config, token: signJwt(config, CONFIG_TTL_MS, secret, "editor-config"), apiJs: `/api/x/${encodeURIComponent(portal().extension)}/ds/web-apps/apps/api/documents/api.js` });
  });

  /** POST /settings {enabled?, imageTag?} -> saved + side effects: enabling fires ensureContainer WITHOUT
   * (There is NO co-editing switch in this payload: the agent is a co-editor under the revision gate, full stop.)
   * awaiting it forever (catch+log; the response says `starting:true` and reports the container state AS OF NOW --
   * a poller watches it arrive), disabling stops it now. :latest is refused -- a moved tag bricks co-editing keys. */
  r.post("/settings", json, async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const before = loadSettings(dd);
    const patch: Partial<OfficeSettings> = {};
    if ("enabled" in body) {
      if (typeof body.enabled !== "boolean") return res.status(400).json({ error: "{ enabled } must be a boolean", code: "invalid_enabled" });
      patch.enabled = body.enabled as boolean;
    }
    if ("imageTag" in body) {
      const tag = typeof body.imageTag === "string" ? body.imageTag.trim() : "";
      if (tag === "") return res.status(400).json({ error: "{ imageTag } must be a non-empty string like onlyoffice/documentserver:10.0", code: "invalid_image_tag" });
      if (/:(latest|stable)$/i.test(tag) || tag.endsWith("@latest")) return res.status(400).json({ error: "never pin :latest -- it moves under you and breaks co-editing keys", code: "invalid_image_tag" });
      patch.imageTag = tag;
    }
    if (Object.keys(patch).length === 0) return res.status(400).json({ error: "no known setting in the body -- send { enabled?, imageTag? }" });

    const settings = saveSettings(patch, dd);
    recordAudit({ subject: "pithagoras-office settings", reason: `enabled=${settings.enabled} imageTag=${settings.imageTag}` });

    let starting = false;
    if (patch.enabled === true && !before.enabled) {
      // fire-and-forget on purpose: a first pull takes minutes and must not hold the response open
      starting = true;
      void container.ensureContainer(undefined, undefined, dd).then((r2) => recordAudit({ subject: container.DS_NAME, reason: r2.started ? "document server started (settings)" : "document server already running" })).catch((e) => logLine(`could not start the document server: ${(e as Error).message}`));
    }
    if (patch.enabled === false && before.enabled) {
      try {
        await container.stopContainer(undefined, dd); // records the user-stopped intent either way
      } catch (e) {
        return res.status(503).json({ error: `settings were saved but the container could not be stopped: ${(e as Error).message}`, code: "no_docker", settings });
      }
    }

    const c = await container.status(undefined, dd);
    res.json({ settings, container: c, ...(starting ? { starting: true } : {}) });
  });

  /** GET /container/status -> the same object status() builds: state (+ version/memBytes when up), and pull -- the
   * latest pull line while a first start is downloading (the POST /container/start route awaits the whole ensure;
   * progress surfaces here via polling). */
  r.get("/container/status", async (_req, res) => {
    try {
      res.json(await container.status(undefined, dd));
    } catch (e) {
      codedResponse(res, e);
    }
  });

  /** POST /container/start -> ensureContainer to completion: adopt or make+start the DS, ds.json written, and the
   * response carries the resulting status. */
  r.post("/container/start", async (_req, res) => {
    try {
      const r2 = await container.ensureContainer(undefined, undefined, dd);
      recordAudit({ subject: container.DS_NAME, reason: r2.started ? "document server started" : "document server already running" });
      res.json({ ...r2, container: await container.status(undefined, dd) });
    } catch (e) {
      codedResponse(res, e);
    }
  });

  /** POST /container/stop -> stop + record the user-stopped intent (lookAfter stays quiet while it stands). */
  r.post("/container/stop", async (_req, res) => {
    try {
      await container.stopContainer(undefined, dd);
      recordAudit({ subject: container.DS_NAME, reason: "document server stopped" });
      res.json({ container: await container.status(undefined, dd) });
    } catch (e) {
      codedResponse(res, e);
    }
  });

  /** GET /ds/<rest...> -> a thin reverse proxy for the browser's Document Server traffic (api.js, the editor iframe,
   * its assets). Core mounts us at /api/x/<extension> BEHIND THE SESSION GATE (core/server/src/extension-host.ts),
   * so only signed-in browsers may reach this -- and it forwards GETs to ONE origin only: the recorded DS origin
   * from ds.json, never anywhere else. The upstream path is recomputed from the RAW request URL with its query
   * string included (express params may be decoded; an iframe's ?dockey=... must pass verbatim). Body bytes are
   * buffered and passed through untouched -- including a gzip/br content-encoding, whose header is copied, so the
   * browser decodes exactly what DS sent. Refusals mirror /editor-config: 503 ds_not_configured (no ds.json),
   * 422 unresolvable_ds_origin (a "container:<id>" marker has no URL until M0), 503 ds_unavailable (the origin
   * did not answer). GET-only; nothing below this route mutates portal state. */
  r.get(/^\/ds\/(.*)$/, async (req, res) => {
    const raw = typeof req.url === "string" ? req.url : "";
    const i = raw.indexOf("/ds/");
    if (i === -1) return res.status(404).json({ error: "bad proxy path", code: "not_found" });
    const rest = raw.slice(i + 4); // everything after /ds/, query string included, untouched
    const origin = dsOrigin(dd);
    if (origin === "") {
      return res.status(503).json({ error: "the document server is not configured yet -- start it from the Office page first", code: "ds_not_configured" });
    }
    if (origin.startsWith("container:")) {
      return res.status(422).json({ error: `the document server runs under ${origin}: that deployment shape cannot expose the editor to a browser until the M0 spike-2 decision lands`, code: "unresolvable_ds_origin", origin });
    }
    let upstream: Response;
    try {
      upstream = await fetch(`${origin}/${rest}`, { redirect: "follow", signal: AbortSignal.timeout(15_000) });
    } catch (e) {
      logLine(`GET /ds/${rest.split("?")[0]} -> ${origin} failed: ${(e as Error).message}`);
      return res.status(503).json({ error: `the document server at ${origin} did not answer`, code: "ds_unavailable" });
    }
    for (const k of ["content-type", "content-encoding", "content-length", "cache-control", "content-disposition", "access-control-allow-origin"]) {
      const v = upstream.headers.get(k);
      if (v !== null) res.setHeader(k, v);
    }
    // Everything else (hop-by-hop, set-cookie, server banners, ...) is dropped.
    try {
      const buf = Buffer.from(await upstream.arrayBuffer());
      res.status(upstream.status).end(buf.length === 0 ? undefined : buf);
    } catch (e) {
      logLine(`GET /ds/${rest.split("?")[0]}: the body from ${origin} could not be read: ${(e as Error).message}`);
      if (!res.headersSent) res.status(503).json({ error: `the document server at ${origin} did not answer`, code: "ds_unavailable" });
      else res.destroy();
    }
  });
}

/* ------------------------------------------------------------------ */
/* boot + cleanup                                                      */
/* ------------------------------------------------------------------ */

/** dsOrigin(): the browser-facing origin of the DS read from ds.json (option (a)). "" when unconfigured; a
 * "container:<id>" marker is returned AS-IS -- it is the clear signal that /editor-config must refuse with the M0 note. */
export function dsOrigin(root?: string): string {
  return container.readDsRecord(root ?? dataDir())?.origin ?? "";
}

export default async function officeServer(portalObj: ServerPortal): Promise<() => Promise<void>> {
  setPortal(portalObj);
  // The pithagoras-docs pattern: a folder without its own node_modules gets them installed in the BACKGROUND --
  // boot does not wait (the portal starts the rest), and jsZip() awaits this promise before first use.
  void armJsZipInstall(ensureDependencies(logLine));
  const dd = portal().dataDir();
  const secret = ensureJwtSecret(dd); // the one HS256 secret: callbacks, tickets and configs all sign with it (plan 5.6)

  // the seams, exactly as their module headers contract them (audit lands in portal().audit AND a log line).
  // NOTE: there is NO co-editing switch and no flush-before-write hook to install here -- office_edit runs under
  // the strict mtime/revision gate with human editor sessions open or not (co-editor model; fail loud, re-read + retry).
  registerTools({ root: dd, record: recordAudit });
  wirePing({ root: dd, record: recordAudit });
  callback.configure({ getState: () => container.readDsRecord(dd), getSecret: () => secret, root: dd });
  live.setMetaResolver((docId) => store.getDoc(docId, dd)?.mtimeMs ?? null);

  registerRoutes(dd, secret);

  // the cookie-free loopback listener (plan 5.2): 127.0.0.1, port 0 -> a private ephemeral port per boot
  const server = http.createServer(makeLoopbackHandler(dd, secret));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  loopPort = (server.address() as AddressInfo).port;

  // boot settle: reclaim trash + reconcile index vs disk, then adopt an existing DS if settings say it should run
  try {
    settleKept(dd);
  } catch (e) {
    logLine(`settleKept at boot failed: ${(e as Error).message}`);
  }
  // the workspace scan indexes every .docx/.xlsx of the agent folders IN PLACE (product decision: no manual import
  // any more -- what the agents work in IS the library). settleKept runs FIRST on purpose: it prunes entries whose
  // file vanished while the portal slept, so the scan then REFRESHES only surviving files instead of re-adding them.
  try {
    const out = store.scanWorkspace(portal().folders.list().map((f) => f.path), dd);
    logLine(`workspace scan at boot: ${out.added} added, ${out.updated} refreshed`);
  } catch (e) {
    logLine(`workspace scan at boot failed: ${(e as Error).message}`);
  }
  container.lookAfter(undefined, dd); // fire-and-forget by contract; logs its own failures

  let stopped = false;
  const timer = setInterval(() => {
    if (stopped) return;
    try {
      settleKept(dd);
    } catch (e) {
      logLine(`settleKept failed: ${(e as Error).message}`);
    }
    container.lookAfter(undefined, dd);
  }, 30_000);
  timer.unref(); // never hold the portal process open

  return async () => {
    stopped = true;
    clearInterval(timer);
    loopPort = 0;
    // close() alone would wait on keep-alive connections held open by clients (undici fetch among them);
    // dropping the idle ones is what lets a portal stop -- and a test's cleanup -- actually finish
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
}
