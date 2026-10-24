# PR #307 — CORE logic fixes (implemented)

Branch `office/280-pithagoras-office`, scope `extensions/office/src/` + its tests. All items implemented in the
given order, suite green after each item. Inputs: `tasks/pr307-ooxml.md` (items 1, 3, 7) and
`tasks/pr307-security.md` S2/S3/N1/N2 (items 2, 5, 6).

**Finish line (final state):** `env -u NODE_ENV node --import tsx --test "extensions/office/test/*.test.mts"` →
**135 pass / 3 skip (docker-gated) / 0 fail** (baseline was 120/3/0 — 15 new tests).
`npx tsc --noEmit -p extensions/office` → clean. `node scripts/build-extensions.mjs` → office extension builds.

---

## 1) [BLOCKING] Dense-grid xlsx parse memory explosion

**What changed:** `src/ooxml.ts`
- New caps (`src/ooxml.ts:456-457`): `MAX_SHEET_CELLS = 256 * 1024` (materialized product cap per sheet) and
  `MAX_TOTAL_GRID_CELLS = 1024 * 1024` (combined grid budget across all sheets of one archive) — the cell-space
  analogs of the existing `MAX_ENTRY_BYTES = 256 MiB` / `MAX_TOTAL_BYTES = 1 GiB` byte caps at lines 90/96.
- `parseXlsx` (`src/ooxml.ts:426`) creates one archive-wide `gridBudget` shared by every sheet (the unbounded-sheet-count
  hole), passed into `parseSheet`.
- `parseSheet` (`src/ooxml.ts:478-503`): after collecting the kept cells it now shrinks the HEIGHT before any
  allocation — `rows = min(maxRow, floor(MAX_SHEET_CELLS/maxCol), floor(budget.left/maxCol))`, decrements the budget,
  and sets the pre-existing `truncated` flag when anything beyond the affordable rows exists. The dense fill loop now
  iterates only `rows × maxCol`. Axis caps (`MAX_GRID_ROWS`/`MAX_GRID_COLS`) unchanged.

**Why:** the grid allocated `maxRow × maxCol` of the farthest *kept* coordinates — a 1,671-byte xlsx with sparse cells at
row 20000 / col ~500 per sheet measured ~523 MB heap + ~18 s CPU (review finding 🔴); sheet count was unbounded. Now the
materialized work is bounded per sheet AND per archive (~a few MB of JS arrays max), and the skip is reported honestly in
`truncatedSheets`, which `office_read` already surfaces ("those far-out cells were not read").

**Tests:** `test/ooxml.test.mts` — "parseXlsx bounds the dense grid of sparse far-out cells": 3 sheets × 2 cells
each (A1 + cell at column 500, row 20000), built with jszip; asserts fast parse (< 2 s), bounded grid height per sheet
(< 20000 rows, A1 still readable), and `truncatedSheets` true for every sheet. All existing fixture round-trip tests unchanged/green.

## 2) Import route guards

**What changed:**
- (a) `src/server.ts:374-396` (`POST /import`): `fs.realpathSync(abs)` runs BEFORE the `folders.allowed` gate and the
  gate checks the REALPATHED parent; the realpathed path is what gets imported. Missing file → `404 not_found` (same status
  as before, now pre-check). Closes symlink traversal out of allowed folders (CWE-22 / S-audit N1).
- (b) `src/store.ts:387`: `importFile` hard-rejects sources above `MAX_IMPORT_BYTES = 512 MiB` (`src/store.ts:44`) with
  `{code:"too_large"}`, before any copy; `CODE_STATUS` maps it to HTTP 413 (`src/server.ts:166`). Guards the sync
  `copyFileSync` and keeps imports under the ooxml reader's 1 GiB zip envelope.
- (c) `src/store.ts:391-401`: the docx `importedBaseline` is computed only for sources ≤ `MAX_BASELINE_BYTES = 32 MiB`
  (`src/store.ts:45`); above the cap it stays `undefined`, so `src/ping.ts:235-247` applies its documented "unparseable
  source" first-save fallback (baseline everything the first save holds) — first-save wake semantics preserved.
- Doc comment on `importFile` updated (`src/store.ts:362-370`).

**Why:** no size cap existed (N2), and the allowed-folder check ran on a logical path while stat/copy followed symlinks (N1).
All-SYNC store contract kept — no worker, no async added.

**Tests:** `test/server.test.mts` — new "a symlink inside an allowed folder pointing OUTSIDE is refused": link in the allowed
workspace → 403 `not_allowed`, nothing imported; a link staying INSIDE still imports (201). `test/store.test.mts` — two new
tests: 600 MiB sparse file (`ftruncateSync`) → `too_large`, library empty; ≤-cap real docx stamps `importedBaseline`
(deepEqual `[]` for the template) vs a 33 MiB sparse `.docx` → `importedBaseline === undefined`.

## 3) CRC-32 validation on zip read

**What changed:** `src/ooxml.ts:116` (`readEntryData`): after decode + length check,
`if (crc32(out) !== e.crc) throw ooxmlError(\`CRC mismatch for ${e.name}: …\`, "invalid_zip")`. The CRC was read from the
central directory and never compared — stored-entry byte flips and deflate streams that still inflate to the advertised
length parsed silently, and `rewriteZip` re-persisted corruption with its original wrong CRC. Now every decode path
(import, office_read, office_edit persist) fails loudly per the extension's fail-loud posture.

**Tests:** `test/ooxml.test.mts` — "a zip entry whose data no longer matches its CRC-32 is rejected loudly": builds the docx
with jszip in STORED mode (so a flipped payload byte breaks ONLY the CRC, not inflate), flips one byte of the stored
`word/document.xml` payload; asserts `parseDocx` throws `invalid_zip` with "CRC mismatch for word/document.xml" and that
`rewriteZip(corrupt, {})` fails too (corruption is never re-persisted). The clean STORED archive parses first, proving the
flip is what trips it.

## 4) office_comments output cap

**What changed:** `src/tools.ts`
- Hoisted `MAX_READ_CHARS = 200_000` to module scope (`src/tools.ts:187`) shared by `office_read` and `office_comments`.
- `office_comments` (`src/tools.ts:425-430`): the aggregated text is now capped exactly like office_read —
  `slice(0, MAX_READ_CHARS) + "\n\n[output truncated by office_comments: it exceeds 200,000 characters]"`. The details
  side-channel is bounded the same way office_read bounds its own (comments sliced to 100 × 500 chars, true total in
  `commentCount`), since details also land in the tool-event store / web transcript.

**Tests:** `test/tools.test.mts` — new test: a doc with 300 comments × ~750 chars (well over the cap); asserts the marker is
present, output length ≤ 200,000 + marker slack, `Comments (300)` still announced, `details.commentCount === 300`,
`details.comments.length === 100`, each detail text ≤ 500 chars.

## 5) Presence lock TTL

**What changed:** `src/live.ts`
- `DEFAULT_PRESENCE_TTL_MS = 15 * 60_000` (`live.ts:44`) — matches the 15-minute editor-config signature lifetime
  (`CONFIG_TTL_MS`, server.ts:52). Configurable via `setPresenceTtl(ms)` / readable via `getPresenceTtl()` (ignores
  non-finite/≤ 0 values); `resetLive()` restores the default.
- Internal `PresenceRecord = LiveUser & { expiresAt }` (the exported `LiveUser` shape is unchanged — no ripple to
  server/tools/web). `setUser(joined=true)` keeps the original `at` (badge shows first open) but pushes
  `expiresAt = now + ttl` on EVERY join/heartbeat (`live.ts:102-103`), so a live DS session (status-1 heartbeats) never
  trips its own TTL, while an abandoned mint — api.js failed to load, tab closed before DS connected — expires.
- Expiry is enforced lazily on read: `usersOf` (`live.ts:82-90`) physically drops stale entries and returns only live ones;
  `pollState` now counts presence through the same filtered path (`live.ts:135`). Stale locks therefore vanish from the
  /state badge, `lockLine`, AND the `office_edit` refusal (`tools.ts:371` uses `usersOf`) without any timer or new call sites.

**Why:** S2 — presence was minted at editor-config time for one shared seat and cleared only on terminal DS closes; a
failed/stuck open left a permanent lock that DoSes every agent edit of the doc. Co-edit BEHAVIOR is otherwise untouched:
a non-expired open session still refuses agent edits (test `server.test.mts:563-580` "refusal while a session is open"
passes unchanged — default TTL is 15 min).

**Tests:** new `test/live.test.mts` (4 tests): expiration drops the lock after a short forced TTL; heartbeats keep a live
session present past its original mint (and the badge's `at` stays the first join); TTL setter rejects nonsense values and
the default is 15 min; explicit lock flag / `clearDoc` semantics unchanged.

## 6) Token purpose separation (S3)

**What changed:** claim-based separation — no key change, no container/impact on adoption:
- `src/jwt.ts`: `signJwt(..., purpose?)` (`jwt.ts:37,48`) embeds a SIGNED `"typ"` claim in the payload; `verifyJwt(token, secret, purpose?)`
  (`jwt.ts:58+`) requires that claim to equal the requested purpose exactly when one is asked for. Tokens without a typ
  claim (DS-minted callback JWTs, and tokens from before this change) verify as before when no purpose is requested —
  the existing 15-minute verification flow and already-running DS containers are untouched.
- Mint sites tagged: editor-config → `"editor-config"` (`src/server.ts:435`); the 60 s outbound-fetch token →
  `"fetch"` (`src/callback.ts:463`). The DS-verified callback path (`callback.ts:307`) verifies WITHOUT a purpose — DS
  cannot be made to mint our claims; its envelope binding already rejects non-callback tokens.
- `src/tickets.ts`: tickets have no JWT claims, so the family marker lives inside the MAC'd message — HMAC now over
  `"document-ticket|docId|expMs"` (`tickets.ts:13,29,51`), mint + verify together. Token payload layout is unchanged.

**Why:** one shared secret currently covers all three token families; an in-portal verifier can no longer be handed a
token of the wrong family, and each family's keying is distinct. A full-secret leak still forges everything (HMAC key
shared by design with the DS container) — see "not done" below.

**Tests:** `test/jwt-tickets.test.mts` — two new tests: purpose claims separate families both directions + a stripped/
rewritten typ claim fails verification of its family; ticket round-trip intact while a MAC computed over the un-prefixed
(legacy) message is rejected. All existing jwt/ticket/editor-config/callback tests pass unchanged (backward compat).

## 7) [trivial] rewriteZip case-insensitive part dedupe — DONE

**What changed:** `src/ooxml.ts:520-551`: change keys are first deduped against each other case-insensitively
(last-one-wins, jszip behavior), then matched to existing entries by lowercased name; a match differing only in case
OVERWRITES the part IN PLACE (original entry name and order kept) instead of appending a shadow duplicate. Input zips
that already contain a shadow pair get the data on the first occurrence only. Doc comment documents the contract.

**Tests:** `test/ooxml.test.mts` — new test: `"WORD/DOCUMENT.XML"` over an archive holding `word/document.xml` replaces in
place (entry name list identical to the original, reparse shows the edit) and two case-variant change keys dedupe to the last one.

---

## Deliberately NOT done (with reason)

1. **Per-purpose derived keys (HMAC(secret, purpose))** for item 6 — not used: the editor-config signature is verified by
   the DS container itself against `JWT_SECRET` as given (`container.ts` env), so any key derivation breaks existing and
   adopted containers; the brief prefers the claim approach for exactly this reason. Residual risk unchanged for a full
   secret leak (one HMAC key underlies all families) — same trust statement as S3's "acceptable for a single-user local
   tool"; a rotate-secret setting is out of this slice's scope (server/container territory).
2. **DS callback JWTs carry no purpose claim** — DS mints them in its own envelope shape; we cannot add claims there.
   The verify side still distinguishes families for every portal-minted token, and the signed-envelope binding at
   `callback.ts:309+` already rejects config/fetch tokens arriving at the callback route.
3. **Lazily minting presence from the first DS-confirmed status-1** (S2's fuller fix) — only the TTL was added, per the
   brief ("add a TTL … do NOT change co-edit semantics beyond adding expiry"). The early-unlock-with-two-tabs note in S2
   (a terminal close wipes both tabs' presence under one shared seat id) is unchanged by design; it remains documented
   there.
4. **Wall-clock guard for `office_read` on huge legitimate workbooks** (ooxml review open question 2) — the grid bounds
   are size-based and deterministic (≤ ~1 M cells per archive ≈ a few ms–tens of ms of fill); a timing guard would add
   nondeterminism without protecting against anything the caps don't already bound.
5. **Nested `w:p` / `mc:AlternateContent` fix and fixture-timestamp determinism** (🟡/🟢 ooxml findings) — outside this
   brief's item list; not touched so as not to destabilize the codec in the same pass.

## House-style compliance

- Everything stays SYNC (no worker, no new async seams); no new runtime dependencies; strict TypeScript clean.
- Co-edit behavior unchanged (coEdit ON still refuses agent edits while a *live* session is open) — only expiry added.
- No git state was changed; `tasks/`, `PLAN-office-280.md`, `.office-contracts.md`, `.pi/`, `.reports/` untouched; no temp
  files left (tests use per-test `mkdtemp` dirs under `os.tmpdir()` per existing convention). Pre-existing working-tree
  modifications to `extensions/office/README.md`, `build.mjs`, and `src/web/settings.tsx` predate this work (earlier
  review rounds) and were not modified here.
