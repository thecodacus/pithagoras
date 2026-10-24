# PR #307 Consolidated Review Summary

PR: thecodacus/pithagoras #307 "Office documents in the portal: OnlyOffice Document Server extension" (author Piggidragon, OPEN, MERGEABLE)
Branch office/280-pithagoras-office @ fee666ce vs main tip 138738f5 — +8703/-1 across 44 files; everything under extensions/office/ plus one line in core/server/test/extension-ui.test.mjs. Per PLAN-office-280.md / issue #280.

## Overall verdict

🔄 **Request Changes** — one merge-relevant 🔴 blocker in PR code (dense-grid xlsx parse), several 🟡 to address before merge, and a ready-to-post answer to the one unresolved CodeRabbit comment. The failing CI test is an unrelated PRE-EXISTING bug in extensions/docs: rerun CI + file a separate issue; it does not gate this PR.

## 🔴 Blocking (PR code)

1. **Dense-grid `parseXlsx` scales with cell coordinates, not file size** (tasks/pr307-ooxml.md). Measured 1671-byte xlsx → +523 MB heap / ~18 s CPU; multiple GB possible for a sparse workbook with high row/col refs. No per-file parse guard; reachable from project-chat agents (office_read/edit paths parse inline, extensions/office/src/tools.ts:190). `truncatedSheets` plumbing already exists as the fix slot-in. Fix + follow-up wall-clock guard for huge legit workbooks (open question Q2 in that file).

## 🟡 Should address before merge

**Architecture / docs-vs-behavior (tasks/pr307-triage-architecture.md, 4 items):**
1. Co-editing semantics INVERTED in docs: web/settings.tsx:109 and README.md:11 claim ON=proceeds/forcesave, OFF=refused; actual v1 = tools.ts:371 forcesave branch requires coEdit&&usersOf>0 AND server.ts:140 makeForcesaveHook ALWAYS returns false while a session is open ⇒ ON = agent edits refused (error:session_open) until the editor closes; OFF = proceeds under the bare mtime gate with a human session open. test/server.test.mts:557-572 asserts the refusal. Fix docs (or flip behavior).
2. extensions/office/deps.js committed but DEAD — nothing imports it, ensureDependencies never called at boot; built server.js:350 keeps `import JSZip from "jszip"` external ⇒ a hand-copied install without node_modules fails ERR_MODULE_NOT_FOUND. Fix: import missingDependencies in build.mjs (docs pattern) + call ensureDependencies at boot, OR bundle jszip and delete deps.js.
3. "Export to chat folders" is claimed in PR body/README but DOES NOT EXIST — server.ts:384-409 export = copy to temp dir, serve attachment, delete; web/library.tsx:155-158 both plain downloads. Also absent from the honest Deferred list.
4. ping.ts:158-173 addGrant re-implements index.json read-modify-write+rename, bypassing store.ts writeIndex (:61) — a second hand-rolled writer over a versioned schema.

**Security (tasks/pr307-security.md):**
- S1: host-mode DS runs nginx bound 0.0.0.0:80 (container.ts:210-211 NetworkMode="host"), exposing the community image's web surface to LAN/Tailnet — an undocumented accepted choice. Fix options: verify pinned onlyoffice/documentserver:10.0 bindings; custom nginx conf binding 127.0.0.1 via named volume /etc/nginx/conf.d/ds.conf; or document + firewall.
- S2 (medium confidence): presence is minted at config time (server.ts:271 live.setUser(docId, EDITOR_USER={id:"portal-user",name:"Portal"}, true)) and cleared unconditionally on terminal close; one shared seat id ⇒ a failed open = stuck lock forever (no TTL in live.ts) DoSes agent edits, and a second tab's close unlocks the first tab's unsaved buffer.
- S3: one shared secret covers all three token types (full detail in file).

**OOXML (tasks/pr307-ooxml.md):** no CRC-32 validation on read — corrupt archives are silently re-persisted with their original wrong CRC (open question Q1: import-reject vs accept-warn); nested w:p (text boxes / mc:AlternateContent) corrupts extraction and mis-targets quote edits, doc comment describes different behavior. 🟢 notes: committed fixtures embed wall-clock timestamps; case-only name mismatches in rewriteZip create shadow duplicate parts.

**Concurrency (tasks/pr307-callback-concurrency.md):** no 🔴. Multi-MB docx sync parse blocks the event loop for tens of ms per persist — accepted at current scale, with escape valve "move diff/wake to a queue if docs grow". Same stance as CR-latest below: consistent, not a conflict.

**Agent tools (tasks/pr307-tools-verification.md):** 🟡 mention grants are permanent with no revocation while the wake text promises access only "for this task" (extensions/office/src/ping.ts:168); 🟡 office_comments output is unbounded unlike office_read (extensions/office/src/tools.ts:418). 🟢 cross-paragraph quote edit leaves a stray line break.

## CI failure — NOT caused by this PR (tasks/pr307-ci-failure.md)

- `gh pr checks 307`: server FAIL (run 40036094127, job 120695809498); CodeRabbit PASS; browser(1/2)+browser(2/2)+web pass. The one failing test: `not ok 366 - a rename that was cut off between its halves is finished only for the file it was decided for: a file with the two names that is another one is left as it is` at extensions/docs/test/rename.test.mts (stack line 759; subtest ~:740-771), error 'neither name of the other file was taken away', deepStrictEqual expected ['after.md','plan.md'] actual ['after.md']. PR touches nothing in extensions/docs; area introduced by main commit fc6d396c.
- Reproduced on a merge-base worktree WITHOUT PR code (1/5 full-file runs fail identically; branch 0/5; isolated subtest loops 0/30, 0/34 instrumented, 0/60 forced).
- Mechanism: the only path producing the observed disk state is the `#carryRename` recovery branch at extensions/docs/store.js:1108-1109 — it unlinks 'plan.md' via removeDocument when `recovering && old.isFile && now.isFile && same ino && nlink>1 && sameId(old,file)`, then commits a bogus rename revision. ROOT CAUSE (🟡 leaning 🔴, data-loss class): file identity decided from {dev,ino} ALONE — idOf at store.js:88 captures only dev+ino (captured at :1007/:1014); sameId :91 compares those two; the window spans the whole crash gap plus arbitrary other-actor activity; ext4 reuses inodes aggressively (~99% immediate reuse in create→unlink→create microbench). The test's own recreation (rename.test.mts:752-755) lands on the original inode when the allocator cooperates. workspace-files.ts `linkOver` already defends against exactly this with same-call re-stat+nlink; #carryRename has no equivalent. Second sameId use store.js:1164 (#carryDelete) is safe-direction — no change.
- Proposed fix (separate issue, not this PR): widen fingerprint to {dev,ino,size,mtimeNs} and require all four at :1108; optionally blobId(readBytes(from))===row.blob content check; harden the test with stub files that share dev+ino but differ in content.
- ACTION: rerun CI on PR #307 (unrelated flake); file a separate issue against extensions/docs.

## CodeRabbit — latest unresolved comment (tasks/pr307-cr-latest.md)

All other CR threads are resolved per the author. Thread id 4364892451 (2026-10-23T22:56:14Z), extensions/office/src/store.ts:384, 🩺 Stability & Availability / 🟠 Major / "🏗️ Heavy lift": "Keep import-time DOCX parsing off the portal event loop… Move parsing to a worker or enforce a suitable import-size limit before the synchronous read." + embedded ast-grep note '384-384: Filesystem path is not a string literal; … [CWE-22]'.

- VERDICT: factually correct. server.ts:366 POST /import takes {path} from the JSON body, path.resolve, gates the parent with portal().folders.allowed(parent) (server.ts:372), then calls store.importFile synchronously (store.ts:362; statSync :371; parseDocx(fs.readFileSync(absPath)) for the docx baseline at :384; copyFileSync at :407). NO size cap anywhere; no HTTP upload (web/api.ts:77 sends only a path string); store header says the portal's 1 MB managed-file cap does not apply to the library by design. The office half runs IN the portal process (no "isolated" flag in package.json; core/server/src/extension-host.ts:887), so a blocking import starves all routes.
- Context: sync fs is established house style (load-bearing for index atomicity; ~30 core files readFileSync in request paths; same file does whole-file readFileSync on GET /documents/:id server.ts:340; office_read tool tools.ts:190 parses inline with no limit). ooxml caps exist pre-inflate: MAX_ENTRY_BYTES=256 MiB, MAX_TOTAL_BYTES=1 GiB (extensions/office/src/ooxml.ts:90,96).
- The CWE-22 note = our security finding N1 (folders.allowed checked on the resolved-but-not-realpath'd path; a symlink in an allowed folder points the import outside). Rated low impact (all principals share the host FS as the portal user); realpathSync + re-check (~4 lines) closes both notes at once.
- RECOMMENDED MINIMAL FIX (worker_threads NOT justified — it would break the deliberately-sync store contract / index atomicity and require a second parse pipeline for the equally-sync tool/persist paths tools.ts:190 and ping persist):
  (a) run the docx baseline parse only up to a **32 MiB cap**; above it leave importedBaseline undefined → reuses the documented "unparseable source" fallback at extensions/office/src/ping.ts:235-240, preserving first-save baseline semantics;
  (b) hard-reject imports above **512 MiB** with code:"too_large" (guards the sync copy + the 1 GiB envelope);
  (c) fs.realpathSync(absPath) before the folders.allowed check.
- A ready-to-post response paragraph for the author is at the bottom of tasks/pr307-cr-latest.md.

## PR's own checks (tasks/pr307-tools-verification.md, part B — ran in /root/repos/pithagoras)

- `env -u NODE_ENV node --import tsx --test "extensions/office/test/*.test.mts"` → 123 total / 120 pass / 3 skip (docker-gated; see below) / 0 fail, run without the flag. The PR body's claimed "120/117/3" is STALE (+3 passing since).
  - Those 3 skips are NOT waiting on an OnlyOffice image: they gate on `OFFICE_IT_DOCKER=1` + a healthy `docker info` (plan M0 operator intent) and need no DS image or container, because the assertions run in-process against a synthetic DS stand-in. Locally verified 3/3 pass with the flag; now also enabled in CI by commit f6788220 (`OFFICE_IT_DOCKER=1` in test.yml's server job).
- `npx tsc --noEmit -p extensions/office` strict-clean (no root tsconfig exists; the PR's `-p .` only works from the extension dir).
- `node scripts/build-extensions.mjs` emits gitignored web/ + server.js — zero tracked pollution.

## Open questions / follow-up candidates

1. ooxml Q1: import-reject vs accept-warn for CRC-corrupt archives.
2. ooxml Q2 / cr-latest Q2: same size guard for GET /documents/:id (server.ts:340) and office_read (tools.ts:190) — same hazard, different routes; candidate follow-up ticket.
3. cr-latest Q1: one shared 512 MiB cap vs per-format (argue for one shared cap; copy is sync either way).
4. Mention grants permanent with no revocation path (ping.ts:168) — "for this task" promise unkept.

## Merge notes / conflicts

No findings conflict across the six review waves. Consistency points worth stating in the PR reply: the callback-concurrency file already accepted the sync-parse event-loop hazard class as scale-appropriate with a queue escape valve (matches the CR-latest minimal-fix stance), and CR's ast-grep CWE-22 note is our own security finding N1, answered by the same realpathSync line.

## Findings files

- tasks/pr307-triage-architecture.md
- tasks/pr307-security.md
- tasks/pr307-ooxml.md
- tasks/pr307-callback-concurrency.md
- tasks/pr307-tools-verification.md (tools review + PR self-checks)
- tasks/pr307-ci-failure.md (unrelated docs bug, repro + fix)
- tasks/pr307-cr-latest.md (latest CR thread verdict + ready-to-post reply)
- tasks/pr307-coderabbit-comments.md (CR top-level comments archive)

## Environment / cleanup

Repo left clean: no worktrees beyond the main checkout, no orphaned test processes, git status shows only pre-existing untracked files (tasks/, PLAN-office-280.md, .office-contracts.md, .pi/, .reports/). Ephemeral /tmp/pithagoras-* test dirs from runs were left in place. No fixes applied to PR code; no scratch files created by the review itself.


## Fixes implemented (pushed) — commit f4330519 "Office extension: address code review findings (#307)"

22 files, +606/−109, fast-forward push fee666ce..f4330519 to thecodacus/pithagoras branch office/280-pithagoras-office; PR #307 tip confirmed at f4330519. Independent re-verification: 135 pass / 3 docker-gated skip / 0 fail, tsc strict clean, build OK, built server has no static jszip import.

**Core (tasks/pr307-fixes-core.md):**
1. 🔴 Dense-grid cap in ooxml.ts parseXlsx — MAX_SHEET_CELLS = 256*1024 per sheet + MAX_TOTAL_GRID_CELLS = 1024*1024 archive budget; height shrunk before allocation, skips surfaced via existing truncatedSheets. Attack shape (3 sheets × sparse row-20000/col-500 cells) now parses in ms with honest truncation.
2. Import guards — server.ts realpathSync before the folders.allowed gate (CWE-22 symlink escape closed, tested); store.ts 512 MiB hard cap → too_large/HTTP 413; docx importedBaseline only ≤ 32 MiB else undefined (ping first-save fallback applies).
3. CRC-32 validation on zip read — structured invalid_zip "CRC mismatch" throw in readEntryData; corrupt archives fail loudly instead of being re-persisted (byte-flip test added). Resolves open question Q1 as import-reject/fail-loud.
4. office_comments output cap — mirrors office_read: shared 200,000-char limit + truncation marker, details bounded 100 × 500 chars with true total in commentCount.
5. Presence TTL in live.ts — 15-min default (matches config-signature lifetime), setPresenceTtl for tests, heartbeat refresh on every setUser(true) so live sessions never trip it; stale entries drop lazily on read. Co-edit refusal semantics unchanged.
6. Token purpose separation — signed typ claim in portal-minted JWTs (editor-config / fetch) + optional purpose pin in verifyJwt; tickets HMAC over "document-ticket|docId|expMs". No key change → adopted DS containers unaffected. (Deliberately NOT done: per-purpose key derivation, because DS verifies the config signature against the raw env secret.)
7. rewriteZip case-insensitive dedupe — case-variant part names now overwrite in place (original name kept); no more shadow parts.

**Docs/wiring (tasks/pr307-fixes-docs.md):**
1. Co-edit docs corrected to REAL semantics (behavior confirmed intentional by author): README.md:11, src/web/settings.tsx:109 tooltip + three spots in src/tools.ts now state ON ⇒ agent edits refused (error:session_open) while a human session is open; OFF ⇒ proceeds under the mtime gate. Logic/tests untouched.
2. deps.js wired (docs pattern): new src/jszip.ts lazy loader (jsZip()/armJsZipInstall), store.ts+tools.ts load lazily, server.ts boots void armJsZipInstall(ensureDependencies(logLine)), build.mjs uses deps.js missingDependencies, new deps.d.ts. Verified: built server imports fine with node_modules/jszip renamed away; missingDependencies() reports ["jszip"] when absent.
3. Export wording fixed — README says "import into the library and export (download) a copy"; "Exporting into chat folders" added to Deferred.
4. Single index writer — new exported store.addGrant (readIndex → dedupe → atomic writeIndex); ping.ts's hand-rolled read-modify-write deleted, thin wrapper keeps its vanished-doc log line.
5. Wake wording fixed — "…for this task" → "You have been given edit access to this document"; ping.test.mts template assertions updated; expiry remains deferred.
6. README "Security notes" section — host netns ⇒ DS nginx on 0.0.0.0:80 visible to host/LAN/tailnet; firewall :80 or (planned) named-volume nginx override. (Container setup deliberately unchanged — no OnlyOffice image available locally to test.)

**Deliberately not done:** 🟢 cross-paragraph quote-edit stray line break (needs paragraph-level XML surgery, documented in pr307-fixes-docs.md); host-mode nginx conf bind change (untestable without DS image).

**Remaining follow-ups:** size gate for GET /documents/:id + office_read on huge workbooks (wall-clock guard); mention-grant revocation/expiry; per-purpose key rotation. CI server job will re-run — the prior failure is the unrelated extensions/docs {dev,ino} flake (separate issue to be filed against that extension).

## Workspace library + co-editor push

Verified independently on top of pushed tip f4330519, then committed and pushed as one commit.

- **Tests** — `env -u NODE_ENV node --import tsx --test "extensions/office/test/*.test.mts"` run 6 times in a row:
  every run **143 tests / 140 pass / 0 fail / 3 skipped** (the 3 pre-existing docker-gated integration skips; OFFICE_IT_DOCKER unset), all exit 0.
- **tsc** — `npx tsc --noEmit -p extensions/office` → exit 0, no errors.
- **Build** — `node scripts/build-extensions.mjs` → exit 0 (web/ + server.js regenerated); `git status` clean of tracked pollution afterwards (build outputs are gitignored).
- **Coherence spot-checks** — settings shape is `{enabled, imageTag}` only in web/api.ts types, the POST /settings 400 path ("send { enabled?, imageTag? }") and GET /state payload; zero `coEdit` identifiers remain outside legacy-tolerance comment + tests; zero `session_open`; office_edit stale paths answer `error:revision_mismatch` with a loud CONFLICT naming open editors; POST /import route and ImportDocuments UI are gone; scanWorkspace runs at boot after settleKept and on POST /documents/rescan; README describes the no-switch co-editor model + automatic scan.
- **Scope** — changed set confined to `extensions/office/**` + doc artifacts (`tasks/`, `PLAN-office-280.md`). Untracked `.office-contracts.md` (its own header says "local scratch, never commit"), `.pi/` and `.reports/` were deliberately left uncommitted.
- **Commit** — `e4fd0b51716f7e589443584397090e2be6d28756` "Office extension: agents co-edit alongside humans; workspace scan instead of manual import" (no trailers, matching the PR's prior commit style), 32 files (+3045/−375): extensions/office {README.md, style.css, src/{live,ping,server,settings,store,tools}.ts, src/web/{api.ts,library.tsx,settings.tsx}, test/{container,integration,server,settings,store,tools}.test.mts} + PLAN-office-280.md + tasks/ report set.
- **Push** — fast-forward f4330519..e4fd0b51 to origin; `gh pr view 307 --json headRefOid` == e4fd0b51… ✓. At the moment of the push no CI checks were reported on the branch yet ("no checks reported" — created later, not waited on).

### DEPLOYMENT NOTE (read before assuming anything is live)

The live portal process is **still running a stale pre-rebuild extension bundle** (it started before the noon rebuild and never reloaded; its data dir had no `index.json`, and it accepted a `coEdit` setting post-change — only the old code has that key). **None of these behaviors (no coEdit switch, CONFLICT model, workspace scan/rescan, sortables, 503 dependencies_pending) are visible to the user until the portal restarts/deploys.** The verify agent did NOT restart or kill any process.

## Proxy encoding bug (user m00343: editor script at /api/x/pithagoras-office/ds/... could not be loaded, after reload with bfb5edc5 live)
- Live diagnosis: portal port 4100, routes behind session gate (unauth 401); SSO-only login (password switched off), forged a valid pi_portal_auth cookie locally (sha256(PORTAL_SECRET+\0+identity) HMAC) and probed with it: /state 200, both /ds/ URLs => connection 'terminated' mid-response.
- ROOT CAUSE: Node undici fetch AUTO-DECODES gzip but keeps upstream content-encoding: gzip + COMPRESSED content-length (live api.js: CL 13720 vs 67458 decoded bytes). Proxy copied both, res.end(67458B) => Node emitted Content-Length: 13720 over a 67458-byte body => truncated invalid api.js + corrupted keep-alive stream in every remote browser.
- FIX cefef592 (pushed; PR #307 tip confirmed): /ds fetch now sends accept-encoding: identity (OnlyOffice nginx honors it); content-encoding + content-length no longer copied -- Node sizes the answer from the actual buffer. New regression test: hostile fake DS answers the identity ask with gzip body + lying headers, asserts full original payload arrives intact. Findings: tasks/pr307-ds-proxy-fix2.md (+ pr307-ds-proxy.md).
- Test wrinkle hit along the way: first draft of that regression test asserted gzip(85-byte API_JS_BYTES stub) < original -- false for tiny payloads, and its throw skipped boot() cleanup so the whole node --test process never exited (looked like a hang). Rewrote with 64x repeated payload + always-run finally cleanup.
- Finish line: 151 total / 148 pass / 0 fail / 3 docker-gated skips; tsc -p extensions/office exit 0; build exit 0. User reloaded once more to pick up cefef592; editor load pending their confirmation.

## Editor stuck on "Loading the editor…" (user m00574) — DocEditor placeholder bug, fixed 2026-07 (commit pending tip)
- Symptom: after cefef592 was live and the proxy served api.js byte-perfect (live-verified: 67458 B, CL matches), the page still sat on the loading state forever; no error banner, editor never appeared. Deterministic, reproduced in a logged-in browser.
- ROOT CAUSE: extensions/office/src/web/office-editor.tsx passed the host ELEMENT to `new window.DocsAPI.DocEditor(box.current, config)`, but api.js declares `DocsAPI.DocEditor = function(placeholderId, config)` and does `document.getElementById(placeholderId)` then `target.parentNode.replaceChild(iframe, target)`. An element stringifies to "[object HTMLDivElement]" => getElementById returns null => the constructor silently builds nothing (no iframe, no alert, no error) => the 500 ms ready-poll never fires.
- FIX: the effect now appends its own `div#po-doceditor` placeholder INSIDE the host box but OUTSIDE React's children, and passes the id string; cleanup sweeps `document.getElementById("po-doceditor")?.remove()` (no-op after a successful build, since DS replaces it with the iframe; remount safety removes any stacked leftover first). Type updated: `DocEditor: new (placeholderId: string, ...)`.
- Live verification (browser logged in on 127.0.0.1:4100, running portal picked up the rebuilt web/ without restart): sample.docx renders the word editor, sample.xlsx the spreadsheet editor; "N editing now" badge intact. The suspected secondary blocker (sdkjs/vendor/string.js 404 under the proxy prefix) did not prevent boot.
- Finish line: office suite 151 total / 148 pass / 0 fail / 3 docker-gated skips; tsc -p extensions/office exit 0; build exit 0.

## Document loads but never opens (white spinner) — the /ds proxy was GET-only, fixed in 13308687
- Symptom: after e818ddc the editor iframe booted (api.js + app assets load) but the page sat on DS's white loading animation endlessly; docserver never logged document activity for our keys.
- Protocol replay through the proxy (logged-in fetch): `GET …/doc/<key>/c/?EIO=4&transport=polling` answers a 120-byte engine.io v4 handshake (`0{"sid":…,"upgrades":["websocket"],"pingInterval":25000,…}`); the browser's stuck loop = fast ~302 B handshakes + upstream 499 at exactly 15.000 s, repeating ~1/s (DS nginx log), zero successful document sessions.
- ROOT CAUSE (proven): `/c/` is the editor app's socket.io POLLING channel — after the handshake its packets arrive as **POSTs** (`"40"` connect packet etc.). Our /ds route was registered GET-only, so every POST died at the portal with the core's 404 "No such API route" (core/server/src/server.ts:1723); the channel could never open. Second wrinkle in the same handler: `AbortSignal.timeout(15_000)` killed healthy idle long-polls — undici abort closes the upstream socket, which docserver records as the 499 at precisely that moment (engine.io pings every 25 s, so polls routinely sit empty > 15 s).
- FIX 13308687 (pushed; PR #307 headRefOid confirmed == 13308687): handler now serves GET **and** POST — non-GET/HEAD bodies are streamed through verbatim (128 MB cap, above the handshake's maxPayload 100 MB) with the client's content-type forwarded; the abort window grew to 90 s (a full ping cycle + slack); and outbound handshakes get `websocket` stripped from `upgrades` (the fetch-based proxy cannot relay WS frames — pinning clients to polling removes failed-upgrade churn), re-serialized behind the preserved `0` EIO packet prefix.
- Tests: three new /ds cases in test/server.test.mts against a fake engine.io endpoint — POST forwards method + raw body + query verbatim (byte-for-byte "40"), handshake stripping keeps sid and drops websocket, and an idle poll HELD 16.5 s still answers 200 (elapsed >= 15 s asserted) guarding the old abort class. MiniRouter gained a streamable fake request (asyncIterator over body + headers arg) to exercise the POST path.
- Finish line: 3 consecutive full-suite runs 154 total / 151 pass / 0 fail / 3 docker-gated skips; tsc -p extensions/office exit 0; build exit 0. Push was a single-commit fast-forward (cefef592 + 51bc708d were already in origin via e818ddc's ancestry).
- DEPLOYMENT NOTE: server.ts changed — the running portal process must be reloaded/restarted for the fix to be live (a browser-only reload is not enough; look for a fresh "[extension pithagoras-office] server half started" journal line), then reopen the document.
