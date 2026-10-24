/**
 * In-memory co-editing registry, shared by src/callback.ts (DS status-1 presence + the lock commands of the
 * plan 5.3 state machine), src/server.ts (the /state poller and editor-config minting) and later src/ping.ts.
 *
 * Deliberately dependency-free -- no fs, no node:fs, no portal(), no store import: pure process memory keyed by
 * docId, so every module (and every unit test) can import it anywhere without a started server half or a data
 * dir. The ONE piece of external knowledge pollState needs (the document's current mtimeMs revision) is injected
 * through setMetaResolver: server.ts registers `docId -> store.getDoc(docId)?.mtimeMs ?? null` once at boot, and
 * until then (or in tests without a resolver) pendingRev stays null. The contract's two-argument pollState shape
 * is kept exactly for that reason -- the resolver lives at module scope instead of becoming a third parameter.
 *
 * State is process-local by design: after a portal restart nobody is known to be editing until the DS session's
 * next status-1 callback or the next editor-config mint calls setUser again, which is the correct reading of
 * "closed with no changes" for a fresh process.
 *
 * Lock model (plan 5.3 table): an EXPLICIT flag carries the command-based entries -- status 2 "unlock after
 * persist", status 4 "unlock", status 6 "keep locked" -- while status 1's row says "set users[] from body
 * (lock = users.length>0)", so presence itself also counts as a lock: someone who opened the editor (a
 * server-minted setUser before any callback, or a DS connect we are about to hear about) keeps the doc locked
 * until they leave. pollState therefore reports `locked` when EITHER holds; unlocking never hides a user that is
 * still tracked as present. Conservative on purpose: a false "still editing" badge beats a false "free to edit".
 * TERMINAL CLOSES are authoritative though: status 2 (ready for saving) and status 4 (closed with no changes)
 * mean nobody is connected anymore, so callback.ts clears presence AND the flag there (clearDoc) instead of
 * only flipping the flag -- otherwise a server-minted user without a DS leave event would badge forever.
 *
 * On top of that, tracked PRESENCE carries a TTL (DEFAULT_PRESENCE_TTL_MS = 15 min, setPresenceTtl to change):
 * presence is minted at editor-config time for a single shared seat and only cleared on terminal closes, so
 * an abandoned open (api.js never loads, tab closed before DS connects) would otherwise hold the doc locked for
 * DS and badge "still editing" -- forever. Stale entries are dropped lazily on read (usersOf/pollState); a live
 * session is immune because every status-1 heartbeat re-calls setUser and pushes expiresAt forward. This adds
 * expiry only -- it does NOT change lock/badge semantics: a non-expired open session still locks the doc for
 * DS (the status rules above) and is reported to polling clients by pollState. Agent edits are gated purely on
 * the revision, never on who is present -- an open editor neither allows nor blocks office_edit (co-editor model).
 */

export type LiveUser = { id: string; name?: string; at: number };

/** A tracked entry plus its expiry (internal: usersOf returns LiveUser copies without it).
 * The TTL closes the stuck-lock DoS of S2: presence is minted at editor-config time (a single shared seat,
 * EDITOR_USER id "portal-user") and only cleared unconditionally on a terminal DS close -- so a failed or
 * abandoned open (api.js never loads, tab closed before DS connects) left the doc locked FOREVER. With a TTL
 * such a stuck entry auto-expires; a LIVE session keeps itself fresh because every status-1 heartbeat re-calls
 * setUser and pushes expiresAt forward.
 * 15 minutes matches CONFIG_TTL_MS (server.ts): an editor config outlives a single page-load, and the badge is
 * already best-effort (the /state poller refreshes it every 5 s from this same map). */
const DEFAULT_PRESENCE_TTL_MS = 15 * 60_000;
type PresenceRecord = LiveUser & { expiresAt: number };

let presenceTtlMs = DEFAULT_PRESENCE_TTL_MS;

/** Change the presence TTL (default DEFAULT_PRESENCE_TTL_MS). Affects joins from now on; already-tracked users
 * keep their existing expiry until their next heartbeat re-sets them. Tests use it to exercise expiry fast.
 * Non-finite or non-positive values are ignored rather than stored (0 would expire everything immediately). */
export function setPresenceTtl(ms: number): void {
  if (Number.isFinite(ms) && ms > 0) presenceTtlMs = ms;
}

/** The configured presence TTL in milliseconds. */
export function getPresenceTtl(): number {
  return presenceTtlMs;
}

function isStale(u: PresenceRecord, now: number): boolean {
  return u.expiresAt <= now; // inclusive: exactly-at-expiry counts as gone (clocks only ever move forward here)
}

/** docId -> userId -> PresenceRecord. Maps (not arrays) so a re-join of the same user never duplicates. */
const presence = new Map<string, Map<string, PresenceRecord>>();
/** docIds explicitly locked by a callback command (statuses 1/2/4/6). */
const locked = new Set<string>();
/** Injected source of "the document's current mtimeMs revision"; null until server.ts registers one. */
let resolveMeta: ((docId: string) => number | null) | null = null;

function userMap(docId: string): Map<string, PresenceRecord> {
  let users = presence.get(docId);
  if (!users) {
    users = new Map();
    presence.set(docId, users);
  }
  return users;
}

/** Everyone currently tracked as present on the doc (join time ascending), or [] for none. Returns copies --
 * callers may hold onto them freely. Expired entries (TTL passed without a heartbeat) are dropped on sight:
 * they no longer count as "editing now", so tools.ts' "editing now" annotation expires with them. */
export function usersOf(docId: string): LiveUser[] {
  const users = presence.get(docId);
  if (!users) return [];
  const now = Date.now();
  for (const [id, u] of [...users]) if (isStale(u, now)) users.delete(id);
  return [...users.values()].map(({ id, name, at }) => ({ id, name, at }));
}

/** Track a join (joined=true -- inserts or updates the entry, KEEPING the original `at` of an already-tracked
 * user so the badge shows when they first opened it) or a leave (joined=false -- removes the id; a no-op if
 * absent). Used by status-1 action handling AND by server.ts when it mints an editor config. An empty user id
 * is ignored rather than stored under "". */
export function setUser(docId: string, user: { id: string; name?: string }, joined: boolean): void {
  if (!user || typeof user.id !== "string" || user.id === "") return;
  const users = userMap(docId);
  if (joined) {
    const existing = users.get(user.id);
    // `at` keeps the FIRST join (the badge shows when they opened it); expiresAt moves forward on EVERY
    // join/heartbeat, so a live session never trips its own TTL while a dead one does.
    users.set(user.id, { id: user.id, name: user.name ?? existing?.name, at: existing?.at ?? Date.now(), expiresAt: Date.now() + presenceTtlMs });
  } else {
    users.delete(user.id);
  }
}

/** The explicit lock flag (plan 5.3: statuses 1/2/4/6 set it). */
export function setLocked(docId: string, isLocked: boolean): void {
  if (isLocked) locked.add(docId);
  else locked.delete(docId);
}

/** Whether the explicit lock flag is set for this doc. */
export function isLocked(docId: string): boolean {
  return locked.has(docId);
}

/**
 * The poll answer of the /state route (plan 5.7 tier-1 fallback, polled every 5 s by the editor page):
 * `locked` -- an explicit lock flag OR at least one tracked present user (see module header for the model);
 * `pendingRev` -- the document's current mtimeMs when a resolver is registered and reports it as strictly
 * NEWER than clientMtimeMs (an agent revision landed since the client opened it; same number = same revision
 * = not pending), else null. No resolver registered -> null.
 */
export function pollState(docId: string, clientMtimeMs: number): { locked: boolean; pendingRev: number | null } {
  // usersOf filters + physically drops expired entries, so "present" here can never count a stale lock
  const present = usersOf(docId).length > 0;
  let pendingRev: number | null = null;
  if (resolveMeta) {
    const mtimeMs = resolveMeta(docId);
    if (mtimeMs !== null && mtimeMs > clientMtimeMs) pendingRev = mtimeMs;
  }
  return { locked: present || locked.has(docId), pendingRev };
}

/** Register the function that answers "what is this doc's current revision mtime?" (server.ts at boot, with a
 * store.getDoc lookup); pass null to clear it. Must be a pure synchronous read of the library index. */
export function setMetaResolver(resolver: ((docId: string) => number | null) | null): void {
  resolveMeta = resolver;
}

/** Drop ALL state for one doc -- server.ts calls this after store.deleteDoc so a deleted doc never shows a
 * phantom lock badge. */
export function clearDoc(docId: string): void {
  presence.delete(docId);
  locked.delete(docId);
}

/** Wipe every doc's state (and the resolver) and restore the DEFAULT presence TTL. Exported for unit tests that
 * share one process; safe to call at any other time -- it only loses in-memory lock badges, nothing on disk. */
export function resetLive(): void {
  presence.clear();
  locked.clear();
  resolveMeta = null;
  presenceTtlMs = DEFAULT_PRESENCE_TTL_MS;
}
