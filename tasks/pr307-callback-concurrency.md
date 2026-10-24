# PR #307 review — callback loop, mtime revision gate, store & container lifecycle (concurrency/correctness)

Repo: `/root/repos/pithagoras`, branch `office/280-pithagoras-office` @ `fee666ce`, diff vs `main`.
Slice files read in full: `extensions/office/src/callback.ts` (521), `store.ts` (459), `container.ts` (336), `ping.ts` (273); skimmed `live.ts`, `jwt.ts`, relevant parts of `server.ts` and `tools.ts`; tests skimmed: `test/callback.test.mts`, `test/store.test.mts`, `test/container.test.mts`, `test/ping.test.mts`.

## Scope
1. DS callback status-table fidelity (incl. the 200-with-`{"error":1}` trick, retry behavior).
2. mtime revision gate: TOCTOU/atomicity, index atomicity, mtime granularity, clock changes.
3. Agent-edit path: forcesave-first ordering vs the expectedMtimeMs gate; concurrent agent edit + DS persist.
4. Duplicate / out-of-order callbacks and idempotency.
5. Trash sweep at the 7-day boundary; concurrent index writers.
6. Container lifecycle: adopt-never-recreate, ds.json origin drift, volume reuse, loopback port allocation, netns handling.
7. lookAfter/ping health loops.

## Method
Full read of the four slice modules and both adjacent seams (tools edit path, server boot/loopback); read all four matching test files to map already-covered races; cross-checked the handler against the official DS callback contract (api.onlyoffice.com callback-handler page: statuses 1/2/3/4/6/7 in the current table, `users` on status 1, `url` on 2/3/6/7, `forcesavetype` on 6/7, editor shows an error when the answer is not `{error:0}`); ran a throwaway fs probe in /tmp (deleted afterwards): 20k consecutive writes show sub-ms `mtimeMs` deltas (min 7.8 µs) and that rename preserves the tmp file's write time as the new revision mtime. Checklists: `cross-cutting/async-concurrency-patterns.md`, `cross-cutting/error-handling-principles.md`.

## Findings

### 🔴 [blocking]
(none in this slice — the status table, envelope binding, and persist gate are all correct against the current DS contract; details under "What's good".)

### 🟡 [important]

**1. Latent infinite stall: a *working* forcesave hook makes every `office_edit` with an open human session fail.**
- Where: `src/tools.ts:373–379`. After `const flushed = await forcesaveHook(doc.docId)` succeeds, the re-gate compares against the ORIGINAL base: `if (Math.abs(meta.mtimeMs - base) > 1) throw stale(meta);` (line 377).
- Why it matters: a completed force-save is exactly what moves the file mtime by far more than 1 ms — so the re-check throws `revision_mismatch` for every future forcesave flow, and the agent loops forever ("changed since you read it") while the human has the document open. The comment at line ~372 says the re-check exists because "that save moves the file" — but compares against the wrong baseline. Not reachable today only because `makeForcesaveHook()` (`src/server.ts:140–148`) always returns `false` while users are present (documented M0 deferral); when the real hook lands, this line defeats it.
- Fix: capture `const preFlushMtime = getDoc(...)?.mtimeMs` before calling the hook; after a successful flush accept the fresh meta if `meta.mtimeMs >= preFlushMtime` (the advance IS our forcesave persist — or re-check disk-vs-meta strictly, which `persistBytes` does anyway). Reject only if the revision moved again *between* flush completion and now.

**2. `persistBytes` can strand a document: file renamed, index update failed/crashed, no reconciliation path.**
- Where: `src/store.ts:449–457`. Order is: gate (440–446) → write tmp + rename (449) → re-stat (450) → `readIndex`/mutate/`writeIndex` (452–457). If the index write throws (ENOSPC, EIO, corrupt-index surprise) or the process dies between line 449 and 457, the on-disk file has a NEWER mtime than `index.json` records.
- Why it matters: from then on every save for that doc fails — callback stale gate passes (key matches old index mtime) but `persistBytes`' strict check (`st.mtimeMs !== doc.mtimeMs`, line 444) throws `revision_mismatch`; `office_edit`'s first gate also refuses. The document becomes permanently unsaveable until someone hand-edits the index. No self-heal exists: `settleKept`/`pruneMissingDocs` (`src/store.ts:336–351`) only drops entries whose *file* is missing — a disk-newer-than-index entry is invisible to it, and the "run settleKept to reconcile" hint on `index_corrupt` (line 57) does not cover this case.
- Fix (concrete): keep the ordering but add an explicit resync escape hatch — e.g. store ops detect `diskMtimeMs > meta.mtimeMs` and log a distinct, greppable line (`revision diverged: disk ahead of index for <docId> — run repair`) plus an admin op (tool or route) that re-baselines the entry's `mtimeMs`/`sizeBytes` from disk after human confirmation. Alert on the existing `persist for <docId>: store failure:` log line (`src/callback.ts:478–479`).
- Confidence: high (ordering verified in code; trigger requires a failed index write or crash in a window of a few ms — realistic under ENOSPC on a box running a document server).

### 🟢 [nit] / 💡 [suggestion]

**3. 🟢 Revision identity is mtime-only; coarse-granularity filesystems can merge two revisions.**
- Where: `src/callback.ts:104–108` (`revHashOf` = sha256 of `String(mtimeMs)`), gate at `src/store.ts:444`, key mint at `src/server.ts:~256` (`callback.makeKey(doc.docId, doc.mtimeMs)`).
- Why: on an fs with 1–2 s mtime granularity (CIFS/SMB, HFS+, FAT), two legitimate saves landing in the same bucket produce identical `mtimeMs` → identical revHash → both the stale gate and the strict persist check treat a stale session as current, so the older revision silently overwrites the newer one. On this host I measured min consecutive-write deltas of 7.8 µs, so ext4-class storage is fine; this is a deployment-shape hazard (and `String(mtimeMs)` float formatting keeps sub-ms distinctions only while the fs reports them).
- Fix: add a monotonically-increasing per-doc counter to `DocMeta`, embed it in the key (`office|<docId>|<n>-<hash>`), and compare it in both gates; keep mtime as the human-facing revision. Cheap, kills the whole class.

**4. 🟢 Tolerance inconsistency: tools use ±1 ms, everything else is zero-tolerance.**
- Where: `src/tools.ts:365` and `:377` (`Math.abs(meta.mtimeMs - base) > 1`) vs strict `!==` at `src/store.ts:444` and hash equality in `persistSaved`.
- Why: the ±1 ms window matters only for drift ≤1 ms (backward NTP step, two revisions <1 ms apart — the fs probe shows sub-ms deltas are real on ext4). No clobber is possible because the final `persistBytes` gate compares disk-vs-index regardless of base; but the design summary claims "zero tolerance" and a reader can't tell which invariant holds where. Align both to `meta.mtimeMs !== base` (or document the epsilon deliberately).

**5. 🟢 [speculative, low confidence] Rename/delete landing inside the callback's fetch window loses one human save.**
- Where: `src/callback.ts:430` (`store.getDoc`) → `await fetchWithRetry(...)` (~350 ms worst case) → `persistBytes(meta, ...)` at `src/callback.ts:474` with the title-path from the pre-fetch meta; path built at `src/store.ts:~78` (`docs/<docId>/<title>.<ext>`).
- Why: a human retitle in that window makes the file path ENOENT → logged as generic "store failure" (`src/callback.ts:478–479`) → save refused, the human's changes gone for this session; a delete behaves the same (refused, but the doc is gone anyway). Narrow timing window, single one-time loss. Fix: re-resolve the meta by `docId` immediately before the persist in `persistSaved`, and map ENOENT to its own log line.

**6. 💡 Ephemeral loopback port doesn't survive a portal restart, but open DS sessions do.**
- Where: `src/server.ts:528` (`server.listen(0, "127.0.0.1", ...)`), config mint at `~244` (`base = http://127.0.0.1:${loopPort}`), cleanup sets `loopPort = 0`.
- Why: the DS container is adopt-never-recreate and outlives portal restarts; every in-flight editor session's `callbackUrl` then points at the dead port — next save fails (editor error; no clobber, since the key pins the old revision) until the user reopens the editor. No retry-storm risk: per the DS contract a non-`{error:0}` answer only shows an editor message, and our handler always answers every persist failure with 200 `{"error":1}`, and internal retries are bounded to 3 attempts (`src/callback.ts:~205`). Fix: pick a stable high port once (persist in settings or `ds.json`, retry next on EADDRINUSE) so sessions survive restarts; also guard `buildEditorConfig` against `loopPort === 0`.

**7. 🟢 ds.json origin is never refreshed while the DS keeps running.**
- Where: `src/container.ts:330` (`lookAfter`: `if (existing?.state === "running") return;` skips `ensureContainer`), vs the rewrite at `src/container.ts:224`.
- Why: a deployment-shape flip (host netns ↔ portal-container netns) with a running DS leaves the recorded `origin` stale until the next stop/start — `api.js` src (`src/server.ts:418`) and the M0-marker logic then use the wrong origin. Rare, self-limiting; fix by validating/rewriting origin during `lookAfter` (or on every `ensureContainer` success it already does — just reach that path when only the origin is stale).

**8. 🟢 Single-process assumption for index.json is documented but unenforced.**
- Where: all index writers (`src/store.ts:63–71` writeIndex, `src/ping.ts:158+` addGrant raw read-modify-write) rely on the Node event loop: each writer's read→mutate→rename block contains no await, so it is atomic within one process (verified — that's why the code is deliberately sync). Two portal processes over one dataDir would silently clobber each other's entries (no O_EXCL/lockfile), and `writeIndex` tmp names (`.<pid>.tmp`) only serialize same-pid. Fix: an advisory pidfile lock on dataDir with a loud error, or at least state it in the README next to the "deferred" list. Related nit: `addGrant` re-implements a raw index writer instead of going through store.ts exports (the module comment admits this) — drift risk; fold into a store grant-mutation op.

**9. 💡 Synchronous full-document parsing on the persist hot path.**
- Where: `src/ping.ts:~230` (`parseDocx(buffer)` inside `handlePersisted`, fired synchronously by the callback hook loop at `src/callback.ts:500–507`); same pattern in `store.importFile` (`fs.readFileSync` + `parseDocx`, `src/store.ts:383–390`).
- Why: multi-MB docx parsed with the sync zlib codec blocks the event loop for tens of ms per persist — it also delays answering DS, stretching the window where the editor shows "saving". Acceptable at current scale; if docs grow large, move diff/wake to a queue processed after the `{error:0}` answer (the hook already runs post-answer-prepare, so ordering is safe to change).

**10. 🟢 Unbounded in-memory wake queue.**
- Where: `src/ping.ts:~83` (`const wakes = new Map<string, WakeEntry[]>()`, drained only by the target chat's UI_RECEIVE handler in `tools.hearOfficePings`). If a home chat never registers the drain (no session, older pi build without event bus — the guard at `src/tools.ts:~470` returns silently), entries accumulate for the process lifetime. Tiny objects, but add a size cap + log line on overflow.

### What's good
- **Status-table fidelity is correct against the current (10.x) DS contract** — I verified against the official callback-handler docs: statuses 1 (users[] join/leave snapshot), 2 (saved, url+changesurl, persist-then-unlock), 3/7 (DS-side error → log only, answer `{error:0}` since we didn't fail), 4 (no changes → clear presence AND lock), 6 (force-saved, stays locked) are all handled exactly, and `forcesavetype` is correctly treated as 6/7-only. There is no status 0 in the current table (older docs' pre-connection status was folded into status 1 with `actions[]`). The legacy-shape `actions[].type === 2` persist on a status-1 envelope is harmless defensive code (`src/callback.ts:~340`).
- **Envelope binding from signed JWT claims** (`src/callback.ts:~285–300`) is the right call: the unsigned body is ignored entirely, a valid non-callback token cannot drive a hostile POST, and `verifyJwt` pins `alg:"HS256"` with `timingSafeEqual` and exp checks (`src/jwt.ts:66–84`). Token verified exactly once per request (documented rationale in the code).
- **The persist path is event-loop atomic where it must be**: `persistBytes` has no await between stat-gate, tmp write, and rename (`src/store.ts:440–457`) — concurrent DS-persist + agent-edit on one doc serialize to a clean last-writer-wins with the loser getting `revision_mismatch`, which is exactly the intended clobber protection. Same for every index read-modify-write block.
- **Duplicate force-save idempotency** (`lastPersist` memo, `src/callback.ts:~140–165`) handles the documented forcesave→status-6 double pass, is scoped to (url, our revision), fails closed on any newer change at a different url, and has a direct test (`duplicate force-save pass` in `test/callback.test.mts`).
- **No retry storms**: every persist failure answers 200 with `{"error":1}` (correct — DS reads the JSON field), internal download retries are bounded to 3 attempts over ~350 ms, fetch-failure leaves lock state untouched for DS-side visibility, and 2 MB body cap with drain.
- **`ensureContainer` serializes the whole lifecycle** (`src/container.ts:~157–165`, cleared in `finally`), so the 30 s `lookAfter` interval joins the in-flight pull instead of piling up; user-stopped marker is written BEFORE the stop to close the lookAfter race; tag changes only recreate *stopped* containers (no surprise restarts, named volume preserves DS data).
- **Trash handling** is race-free within its stated model: stamps carry the docId so same-millisecond deletions of different docs never collide, `sweepTrash` skips non-stamped entries and runs on a 30 s timer that can't preempt the sync delete/sweep blocks, and there is no in-app restore to race against.
- **`live.ts` lock model** is conservative in the safe direction (presence OR flag; terminal closes clear both — so a server-minted seat without a DS leave event won't badge forever), with the mint-time `setUser` in `buildEditorConfig` covering session detection even before any DS callback arrives.

### Open questions
1. **Forcesave path**: when M0 wires the real tier-1 flush, do you go via command-service or the editor UI `forcesave:true` option? Finding 1 must be fixed whichever way; also decide whether the status-6 that then arrives needs to clear `lastPersist` semantics (today it's absorbed by the memo).
2. **"Undoable" trash**: the PR copy says "7-day undoable trash", but there is no restore op or route anywhere in `src/` (I grepped — only `deleteDoc`→`.trash`, then `sweepTrash`). Manual `mv` works but is undocumented. Is an in-app restore deferred, or should the README wording be corrected?
3. **Revision identity**: will you take finding 3's rev-counter suggestion before anyone runs this on SMB/NFS-backed storage? It's a one-field change that makes the whole gate bulletproof.
4. **Loopback port stability** (finding 6): fixed persisted port vs accept "re-open the editor after a portal restart" as documented behavior?
5. **Repair semantics** (finding 2): should re-baselining disk→index be an operator op, or is an auto-heal at boot acceptable once you've logged a divergence?
