/**
 * The OnlyOffice Document Server callback handler (plan 5.3): a plain node:http req/res function served by the
 * loopback listener's POST /callback (server.ts, wave T-WIRE) -- NOT a portal route, because every portal route
 * is session-gated and the DS container holds no cookie (plan 5.2 design decision).
 *
 * Flow (per plan 5.3/5.6): verify the HS256 JWT BEFORE dispatch, parse the envelope, branch on status exactly
 * per the plan 5.3 table. The token arrives in the X-Auth-Token header -- that is where it lives because the
 * container env we mint sets JWT_HEADER=X-Auth-Token and JWT_IN_BODY=false (src/container.ts dsEnv, plan 4); an
 * embedded body.token is accepted ONLY as a defensive fallback for DS builds that ignore those vars.
 *
 * document.key format (FIXED by the contract): "office|" + docId + "|" + base64url-no-pad(sha256(String(expectedMtimeMs))).
 * The hash pins the revision the config was minted against, so a stale session's save-back can never clobber a
 * newer revision (plan 5.3: "the file's mtime/sha is the revision tools compare against"). The persist path
 * re-derives the hash from the CURRENT store.getDoc(docId) meta and refuses on mismatch -- see persistSaved.
 *
 * Persistence (statuses 2/6 + the status-1 forcesave action): fetch body.url with retries (the DS can lag after
 * a save), run store.persistBytes through its mtime gate, store the changesurl archive at
 * dataDir/history/<docId>/<newMtimeMs>.zip (mkdir -p; best-effort -- the document write is what matters), fire
 * every onPersisted(docId, buffer) hook (src/ping.ts registers its comment-mention wake through wirePing later),
 * then apply the status's lock rule: 2 unlocks AFTER persist, 6 STAYS locked. Everything happens BEFORE the
 * {"error":0} answer -- DS acts on the JSON error field, and any non-zero makes the editor show a save error /
 * retry (plan 4).
 *
 * JWT for fetching body.url: plan 4 verifies the official example's plain fetch(req.body.url) and plan 5.3 just
 * says "fetch url" -- the plan is SILENT on auth headers for that GET, though our image-wide env sets
 * JWT_ENABLED=true. Belt-and-braces: we send a fresh 60 s HS256 token (claims {docId, key}) in X-Auth-Token --
 * harmless if DS's own download path is not gated, correct if it is. Documented choice, not a plan mandate.
 *
 * Wiring chosen here (the contract allows either): BOTH the contracted factory AND a bare module-level handler.
 * - createCallbackHandler(getState, getSecret, opts?) returns an isolated handler -- tests build instances with
 *   their own tmp root/secret/retry budget and no global state at all.
 * - configure({ getState, getSecret, root?, retryDelaysMs?, log? }) + export const handleCallback: T-WIRE's
 *   server.ts calls configure ONCE at boot with getState = () => container.readDsRecord() (ds.json is the single
 *   source of truth), getSecret = () => the jwt-secret string read once from dataDir()/jwt-secret, and the
 *   loopback listener dispatches `POST /callback -> callback.handleCallback(req, res)`. Before configure runs --
 *   or whenever getState/getSecret answer null (container never ensured, no ds.json / no secret yet) -- every
 *   request gets 503 {"error":1} and nothing else happens.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dataDir, portal } from "./host";
import { signJwt, verifyJwt } from "./jwt";
import * as store from "./store";
import * as live from "./live";

/** == the DsRecord shape of container.readDsRecord (kept local so this module does not import the Docker half). */
export type CallbackState = { containerId: string; origin: string; imageTag: string };

export interface CallbackHandlerOptions {
  /** Document-library root; production leaves it undefined (= host.dataDir()), unit tests pass a tmp dir. */
  root?: string;
  /** Fixed backoff schedule BETWEEN attempts of the body.url / changesurl fetches. Default [100, 250] ms -> at
   * most 3 attempts and ~350 ms of total waiting (plan 5.3: "retry fetch a few times (DS can lag)"; kept tiny on
   * purpose so unit tests stay fast). */
  retryDelaysMs?: number[];
  /** Log sink for the status-3/7 lines and every failure; defaults to portal().log with a console.error fallback. */
  log?: (line: string) => void;
}

type CallbackConfig = { getState: () => CallbackState | null; getSecret: () => string | null } & CallbackHandlerOptions;

/** The factory the contract fixes: an isolated handler around these two lookups (+ optional test knobs). */
export function createCallbackHandler(
  getState: () => CallbackState | null,
  getSecret: () => string | null,
  opts?: CallbackHandlerOptions,
): (req: IncomingMessage, res: ServerResponse) => void {
  return makeHandler({ getState, getSecret, ...opts });
}

/** Module-level configuration for the BARE handler below; T-WIRE's server.ts calls this exactly once at boot. */
export function configure(config: CallbackConfig): void {
  configured = config;
}

let configured: CallbackConfig | null = null;

/** The contracted bare handler (loopback listener POST /callback). 503 {"error":1} while unconfigured or until
 * the DS record/secret exist. Fire-and-forget on purpose: all disk work completes before res.end, which is how
 * callers (and tests) observe completion -- via the response. */
export const handleCallback = (req: IncomingMessage, res: ServerResponse): void => {
  if (!configured) {
    respond(res, 503, 1);
    return;
  }
  makeHandler(configured)(req, res);
};

/* ------------------------------------------------------------------ */
/* document.key                                                        */
/* ------------------------------------------------------------------ */

/** base64url-no-pad(sha256(String(expectedMtimeMs))) -- the revision hash embedded in every document.key. */
export function revHashOf(mtimeMs: number): string {
  return createHash("sha256").update(String(mtimeMs)).digest("base64url");
}

/** The only key shape this package mints (server.ts editor-config) and the only one parseKey accepts. */
export function makeKey(docId: string, expectedMtimeMs: number): string {
  return `office|${docId}|${revHashOf(expectedMtimeMs)}`;
}

/**
 * Parse "office|" + docId + "|" + base64url-no-pad(sha256(...)). Null when the prefix is missing, the docId part
 * is empty, or the hash part is not 43 base64url characters (exactly one unpadded sha256 digest). The docId is
 * taken greedily between the first and LAST pipe, so a future docId containing "|" still parses.
 */
export function parseKey(key: string): { docId: string; revHash: string } | null {
  if (typeof key !== "string") return null;
  const m = /^office\|(.+)\|[A-Za-z0-9_-]{43}$/.exec(key);
  if (!m) return null;
  const docId = m[1];
  if (docId === "") return null;
  return { docId, revHash: key.slice(7 + docId.length + 1) };
}

/* ------------------------------------------------------------------ */
/* persist hooks + the double-save guard                               */
/* ------------------------------------------------------------------ */

const persistedHooks: Array<(docId: string, buffer: Buffer) => void> = [];

/** Register a hook fired with (docId, EXACT saved bytes) after every successful persist -- src/ping.ts's
 * comment-mention wake registers here through wirePing; the document save never waits on or dies with a hook. */
export function onPersisted(fn: (docId: string, buffer: Buffer) => void): void {
  persistedHooks.push(fn);
}

/**
 * Per-doc memo of our own last successful persist ({ url, mtimeMs }), module scope for the process's lifetime.
 * WHY IT EXISTS: DS can report one force-save twice -- a status-1 envelope carries a forcesave action (type 2)
 * whose result also arrives as the canonical status-6 callback. The second pass re-fetches with a key minted
 * against the OLD mtime, so its revHash no longer matches the meta WE just wrote; without this memo that pass
 * would look like an external agent edit and answer {error:1} (a spurious save-failure in the editor). The memo
 * fires only when BOTH the document's current revision AND the download url equal ours -- a newer change at a
 * different url still gets refused (plan 5.3: never overwrite a newer revision). Known accepted limit (report):
 * typing between our forcesave and session close is dropped on that refusal -- exactly the stale-overwrite
 * protection the plan demands; the user reloads via refreshFile (plan 5.7 tier 1).
 */
const lastPersist = new Map<string, { url: string; mtimeMs: number }>();

/* ------------------------------------------------------------------ */
/* small plumbing                                                      */
/* ------------------------------------------------------------------ */

/** Default log sink: portal().log once the server half set it, console.error before/without (tests stay quiet
 * by passing their own). Same lazy pattern as src/container.ts. */
function defaultLog(line: string): void {
  try {
    portal().log(`pithagoras-office: callback: ${line}`);
  } catch {
    console.error(`[pithagoras-office callback] ${line}`);
  }
}

function respond(res: ServerResponse, status: number, error: number): void {
  if (res.headersSent) return; // already answered; an inner failure must not double-end
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error }));
}

/** The DS envelope is small (url + actions + users); a hard cap keeps one callback from eating memory. */
const MAX_BODY_BYTES = 2 * 1024 * 1024;

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let failed = false;
    req.on("data", (chunk: Buffer) => {
      if (failed) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        failed = true;
        reject(Object.assign(new Error(`callback body exceeds ${MAX_BODY_BYTES} bytes`), { code: "body_too_large" }));
        req.resume(); // drain without allocating
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const DEFAULT_RETRY_DELAYS_MS = [100, 250];

/** GET with the documented JWT header and a fixed backoff schedule; returns the full body or throws the last
 * error after 1 + delays.length attempts. HTTP non-2xx counts as a failure too (DS can answer a not-ready save). */
async function fetchWithRetry(url: string, token: string, retryDelaysMs: number[]): Promise<Buffer> {
  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      const res = await fetch(url, { headers: { "X-Auth-Token": token } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (err) {
      const delay = retryDelaysMs[attempt - 1];
      if (delay === undefined) throw err;
      await sleep(delay);
    }
  }
}

function writeAtomic(dest: string, bytes: Buffer): void {
  fs.mkdirSync(path.dirname(dest), { recursive: true }); // mkdir -p history/<docId>/
  const tmp = path.join(path.dirname(dest), `.${path.basename(dest)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, bytes);
  fs.renameSync(tmp, dest);
}

/* ------------------------------------------------------------------ */
/* the status machine                                                  */
/* ------------------------------------------------------------------ */

type Envelope = {
  key?: unknown;
  status?: unknown;
  url?: unknown;
  changesurl?: unknown;
  users?: unknown;
  actions?: unknown;
  forcesavetype?: unknown;
  token?: unknown;
  [extra: string]: unknown;
};

function makeHandler(cfg: CallbackConfig): (req: IncomingMessage, res: ServerResponse) => void {
  const log = cfg.log ?? defaultLog;
  return (req, res) => {
    void (async () => {
      try {
        await handleDispatch(log, cfg, req, res);
      } catch (err) {
        // Truly unexpected (fs failure in a path that should not throw, bug): one log line + a non-zero answer.
        log(`internal callback error: ${(err as Error).message}`);
        try {
          respond(res, 500, 1);
        } catch {
          /* res already ended or broken pipe -- nothing more to do */
        }
      }
    })();
  };
}

async function handleDispatch(
  log: (line: string) => void,
  cfg: CallbackConfig,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  // Route guard: the loopback listener serves exactly POST /callback (plan 5.2); reject anything else before
  // reading a byte of body. The listener itself routes, so this only ever fires for misdirected probes.
  if (req.method !== "POST") {
    respond(res, 405, 1);
    return;
  }
  const pathname = (req.url ?? "").split("?")[0];
  if (pathname !== "/callback" && pathname !== "/") {
    respond(res, 404, 1);
    return;
  }

  let body: Envelope;
  try {
    const raw = await readBody(req);
    body = JSON.parse(raw.toString("utf8")) as Envelope;
  } catch (err) {
    log(`malformed callback envelope: ${(err as Error).message}`);
    respond(res, 400, 1);
    return;
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    respond(res, 400, 1);
    return;
  }

  // DS configured at all? No ds record / no secret yet -> 503, nothing else.
  const state = cfg.getState();
  const secret = cfg.getSecret();
  if (!state || !secret) {
    respond(res, 503, 1);
    return;
  }

  // JWT BEFORE dispatch (plan 5.6): header X-Auth-Token (env pins JWT_HEADER=X-Auth-Token, JWT_IN_BODY=false),
  // embedded body.token only as a defensive fallback. No token or any verification failure -> 401 {error:1},
  // and nothing below ever touches the disk.
  const headerToken = req.headers["x-auth-token"];
  let token = typeof headerToken === "string" ? headerToken : Array.isArray(headerToken) ? headerToken[0] : undefined;
  if (token === undefined && typeof body.token === "string") token = body.token;
  if (token === undefined || verifyJwt(token, secret) === null) {
    log("rejected callback: missing or invalid JWT");
    respond(res, 401, 1);
    return;
  }

  // Envelope binding (security): the envelope is taken from the SIGNED claims, never from the unsigned JSON
  // body -- with a valid token alone anyone could otherwise POST any {key,status,url} and overwrite a library
  // document. DS carries the callback envelope in the JWT payload (possibly wrapped under a 'payload' key);
  // our own non-callback tokens (editor config, fetch) carry no envelope and are rejected below. The body is
  // ignored from here on.
  const claims = verifyJwt(token, secret)!;
  const signed = (claims.payload && typeof claims.payload === "object" && !Array.isArray(claims.payload))
    ? claims.payload as Record<string, unknown>
    : claims;
  if (typeof signed.key !== "string" || typeof signed.status !== "number" || !Number.isInteger(signed.status)) {
    log("rejected callback: token does not carry a signed callback envelope (key + integer status)");
    respond(res, 400, 1);
    return;
  }
  body = signed as Envelope;

  // Envelope shape.
  const parsed = parseKey(body.key as string); // signed.key was verified a string above
  if (!parsed) {
    log("rejected callback: missing or malformed document.key");
    respond(res, 400, 1);
    return;
  }
  const status = Number(body.status);
  if (!Number.isInteger(status)) {
    log(`rejected callback: non-integer status ${JSON.stringify(body.status)}`);
    respond(res, 400, 1);
    return;
  }

  switch (status) {
    case 1: {
      // Being edited: set presence from body.users (plan 5.3: "lock = users.length>0") and apply the lock rule.
      const snapshotIds = new Set<string>();
      if (Array.isArray(body.users)) {
        for (const u of body.users) {
          if (u && typeof u === "object" && typeof (u as Record<string, unknown>).id === "string") {
            const id = (u as { id: string }).id;
            const name = (u as { name?: unknown }).name;
            live.setUser(parsed.docId, { id, name: typeof name === "string" ? name : undefined }, true);
            snapshotIds.add(id);
          }
        }
      }
      for (const tracked of live.usersOf(parsed.docId)) if (!snapshotIds.has(tracked.id)) live.setUser(parsed.docId, { id: tracked.id }, false);
      live.setLocked(parsed.docId, live.usersOf(parsed.docId).length > 0); // plan 5.3, status-1 row

      // Forcesave-click (actions[].type === 2) while the session continues -> persist NOW from body.url and STAY
      // locked (status-6 rules; the canonical result may still arrive as a status-6 callback -- lastPersist
      // absorbs that duplicate). The envelope's forcesavetype field belongs to statuses 6/7 only.
      const actions = Array.isArray(body.actions) ? body.actions : [];
      if (actions.some((a) => a && typeof a === "object" && (a as { type?: unknown }).type === 2) && typeof body.url === "string") {
        await persistSaved(log, cfg, parsed.docId, parsed.revHash, body, false, res); // stays locked
        return;
      }
      respond(res, 200, 0);
      return;
    }

    case 3: {
      // Document saving error AT DS: log + audit only (audit.record is wired by T-WIRE; this log line IS the
      // record until then). No disk write. We did not fail internally -> answer 0 so DS does not loop.
      log(`status-3: document server reported a save error for ${parsed.docId}`);
      respond(res, 200, 0);
      return;
    }

    case 7: {
      // Force-saving error AT DS: same treatment as status 3 (one line each, no disk).
      log(`status-7: document server reported a force-save error for ${parsed.docId} (forcesavetype=${JSON.stringify(body.forcesavetype ?? null)})`);
      respond(res, 200, 0);
      return;
    }

    case 4: {
      // Closed with no changes: terminal close -- nobody is connected anymore, so clear BOTH the flag and any
      // tracked presence (no disk write of any kind).
      live.clearDoc(parsed.docId);
      respond(res, 200, 0);
      return;
    }

    case 2:
    case 6: {
      // Ready-for-saving / force-saved: persist (fetch url w/ retries -> persistBytes gate -> history zip ->
      // hooks); status 2 unlocks AFTER the persist, status 6 STAYS locked (plan 5.3 rows).
      await persistSaved(log, cfg, parsed.docId, parsed.revHash, body, status === 2, res);
      return;
    }

    default: {
      log(`unknown callback status ${status} for ${parsed.docId}`);
      respond(res, 400, 1);
      return;
    }
  }
}

/**
 * The shared persist path (status 2, status 6 and the status-1 forcesave action). ALWAYS answers `res` itself:
 * success -> 200 {"error":0}; every failure -> 200 {"error":1}. DS decides save outcomes from the JSON error
 * field (plan 4: "must answer {\"error\":0}; anything else makes the editor show an error"), which is why the
 * HTTP status stays 200 even for persist failures.
 */
async function persistSaved(
  log: (line: string) => void,
  cfg: CallbackConfig,
  docId: string,
  keyRevHash: string,
  body: Envelope,
  unlockAfter: boolean,
  res: ServerResponse,
): Promise<void> {
  const fail = (): void => respond(res, 200, 1);
  const rootDir = () => cfg.root ?? dataDir();

  const meta = store.getDoc(docId, rootDir());
  if (!meta) {
    log(`persist for ${docId}: document no longer in the library -- refusing`);
    return fail();
  }

  // STALE-GATE (plan 5.3): the key pins the revision the config was minted against; the CURRENT meta must match,
  // else something already moved the revision and we must NOT overwrite it. The double-save memo below tells
  // "we already wrote exactly this save" apart from "someone else won".
  if (revHashOf(meta.mtimeMs) !== keyRevHash) {
    const ours = lastPersist.get(docId);
    const sameUrl = typeof body.url === "string" && ours?.url === body.url;
    if (ours && ours.mtimeMs === meta.mtimeMs && sameUrl) {
      // The duplicate pass of a force-save we already persisted: report SUCCESS, apply the status's lock rule.
      log(`persist for ${docId}: this save was already persisted at revision ${meta.mtimeMs} -- treating as done`);
      if (unlockAfter) live.clearDoc(docId); // a status-2 re-send closes the session
      else live.setLocked(docId, true); // status 6: editing continues, stay locked
      respond(res, 200, 0);
      return;
    } else {
      log(`persist for ${docId}: stale key (current revision ${meta.mtimeMs}, expected hash ${keyRevHash}) -- NOT overwriting a newer revision`);
      if (unlockAfter) live.clearDoc(docId); // terminal close: the session is over, drop flag AND presence
    }
    return fail();
  }

  if (typeof body.url !== "string" || body.url === "") {
    log(`persist for ${docId}: callback carries no url to download`);
    return fail();
  }

  // JWT for the outbound GET (documented choice -- plan silent, see module header): a fresh 60 s HS256 token.
  const fetchToken = signJwt({ docId, key: body.key }, 60_000, secretOrThrow(cfg));
  let bytes: Buffer;
  try {
    bytes = await fetchWithRetry(body.url, fetchToken, cfg.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS);
  } catch (err) {
    log(`persist for ${docId}: could not download ${body.url} after ${(cfg.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS).length + 1} attempts: ${(err as Error).message}`);
    // Leave the lock state untouched -- DS will retry; a status-2 close without a save stays visible.
    return fail();
  }

  let newMtimeMs: number;
  try {
    newMtimeMs = store.persistBytes(meta, bytes, rootDir()).mtimeMs;
  } catch (err) {
    if ((err as { code?: string }).code === "revision_mismatch") {
      log(`persist for ${docId}: revision moved between read and write -- NOT overwriting`);
      if (unlockAfter) live.clearDoc(docId); // terminal close, same rule as the stale gate above
    } else {
      log(`persist for ${docId}: store failure: ${(err as Error).message}`);
    }
    return fail();
  }

  lastPersist.set(docId, { url: body.url, mtimeMs: newMtimeMs });

  // Changes archive -> dataDir/history/<docId>/<newRevision>.zip (rev = the NEW post-persist mtimeMs; the index
  // carries that number now too, so history entries line up with what office_edit and tools gate against).
  // Best-effort: a lost archive costs the editor's version-history view, never the document.
  if (typeof body.changesurl === "string" && body.changesurl !== "") {
    try {
      const zip = await fetchWithRetry(body.changesurl, fetchToken, cfg.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS);
      writeAtomic(path.join(rootDir(), "history", docId, `${newMtimeMs}.zip`), zip);
    } catch (err) {
      log(`persist for ${docId}: could not store the changes archive: ${(err as Error).message}`);
    }
  }

  // Wake hooks (ping.ts comment mentions register here): exact saved bytes; one bad hook must not kill the rest.
  for (const hook of persistedHooks) {
    try {
      hook(docId, bytes);
    } catch (err) {
      log(`onPersisted hook failed for ${docId}: ${(err as Error).message}`);
    }
  }

  if (unlockAfter) live.clearDoc(docId); // status 2: terminal close AFTER persist -- drop flag AND presence
  else live.setLocked(docId, true); // status 6: editing continues, stay locked

  // Success is only answered once the document AND the lock state are settled -- DS reads this JSON field to
  // decide the save outcome (plan 4). Every earlier branch already answered itself.
  respond(res, 200, 0);
}

/** The dispatch already verified a non-null secret; keep persistSaved's signature lean. */
function secretOrThrow(cfg: CallbackConfig): string {
  const secret = cfg.getSecret();
  if (!secret) throw Object.assign(new Error("jwt secret vanished mid-dispatch"), { code: "no_secret" });
  return secret;
}
