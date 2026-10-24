# PR #307 — latest CodeRabbit comment review: import-time DOCX parsing on the portal event loop

**Scope:** CodeRabbit thread id 4364892451 (2026-00-10-23, `extensions/office/src/store.ts:384`), 🩺 Stability & Availability / 🟠 Major / "🏗️ Heavy lift", plus its embedded ast-grep CWE-22 note on the same line. Review-only; no fixes implemented.

## The comment

> Keep import-time DOCX parsing off the portal event loop. The portal router handles `/import` by calling `store.importFile(...)` synchronously. `importFile` reads the complete source with `fs.readFileSync` and parses the DOCX inline. A large valid DOCX can block other portal requests. Move parsing to a worker or enforce a suitable import-size limit before the synchronous read.

Suggested prompt: move the read+parse to a worker **or** enforce an import-size limit before `fs.readFileSync`; preserve `importedBaseline` behavior.

Nested ast-grep note: `384-384: Filesystem path is not a string literal; a request-/variable-derived path can enable path traversal [CWE-22]`.

## Evidence (file:line)

### 1. The code path — claim is factually correct

- `extensions/office/src/server.ts:366` — `r.post("/import", json, ...)`: takes `{path}` from the JSON body, `path.resolve(given)` (server-side, absolute or relative to portal cwd), gates with `portal().folders.allowed(parent)` (`server.ts:372`), then calls `store.importFile(abs, ...)` **synchronously inside the async handler** (`server.ts:376`). There is **no size limit anywhere on this route**.
- `extensions/office/src/store.ts:362` — `importFile`: stats the source (`store.ts:371`, `fs.statSync(absPath)`), rejects non-files (`:376`), then for docx does `importedBaseline = parseDocx(fs.readFileSync(absPath))...` (`store.ts:384`) and finally `fs.copyFileSync(absPath, file)` (`store.ts:407`). The xlsx branch skips parsing (copy only).
- **No import-size cap exists anywhere.** There is no HTTP upload at all — the client (`extensions/office/web/api.ts:77`, `web/client.tsx`) sends only a *path* string; the bytes are read from server disk. So "upload size limit" infrastructure does not apply; the file can be any size present in an allowed workspace folder, and the store header (`store.ts:6-7`) explicitly says the portal's 1 MB managed-file cap **does not apply** to the library (>1 MB Office files work natively by design).
- Portal process model: `extensions/office/package.json` has no `"isolated"` flag (only `pithagoras.server` + `requires: pithagoras-docker`), and isolated halves "give nothing to build on" (`core/server/src/extension-host.ts:887`) — so the office server half runs **in the portal's own process**, whose event loop it shares with core and every non-isolated extension (routes mounted at `/api/x/pithagoras-office`, `server.ts:12`). A blocking import therefore does starve all other portal requests. Claim valid.

### 2. Worst-case parse cost (is it really big?)

- `extensions/office/src/ooxml.ts:90,96` — `MAX_ENTRY_BYTES = 256 MiB` per entry, `MAX_TOTAL_BYTES = 1 GiB` total *advertised* expansion, enforced in `readZip` **before** any inflate. So memory is bounded (≈1 GiB resident worst case — `readZipParts` retains every expanded part), but that bound is large and:
  - `inflateRawSync` on a ~256 MiB `word/document.xml` is single-threaded sync work (seconds of CPU);
  - `findParagraphs`/`paragraphText`/`parseComments` then run multiple regex passes over the full XML string; a hostile-but-valid document can keep those multi-second (our own ooxml review measured ~18 s CPU / +523 MB heap for a **1.7 KB** xlsx via the dense-grid path — see cross-reference).
  - `store.ts:407` `copyFileSync` then synchronously copies the whole file again.
- Practical worst case today: an agent-generated (or user-placed) several-hundred-MB docx in a workspace folder → one `/import` can block the shared portal event loop for seconds-to-tens-of-seconds and hold ~GiB of heap, while every other route hangs. Unbounded file size = unbounded blocking time. Claim valid, with real (if bounded) severity.

### 3. House style — is this a regression?

No. Sync fs in request paths is the established pattern across this codebase:
- `store.ts` module header declares it by design: "everything that touches existing files is sync"; sync is load-bearing for index atomicity ("no await may sit between readIndex and writeIndex", `createDoc`; same for `persistBytes`, which also does a full sync parse path via ping).
- Same extension, same process, same kind of work: `GET /documents/:id` downloads do `fs.readFileSync(fileFor(dd, doc))` of the **entire library file** (`server.ts:340`), `/export` reads back an exported copy (`server.ts:394`), the loopback listener reads bytes sync (`server.ts:215`).
- Core: ~30 core files use `readFileSync` on request paths (e.g. `core/server/src/api/*.ts`, `projects.ts`, `skills/*`); other extensions too (`extensions/git/src/git.ts:360`, `extensions/docker/src/docker.ts:51`, `extensions/office/src/tools.ts:190` — the `office_read` tool reads whole library files sync and then parses inline, i.e. agents can already trigger the same parse cost with **no** size limit).
- Our own review already judged this class "Acceptable at current scale" (see cross-reference below).

So: a real availability hazard, but not a PR-307 regression — it is the house-wide sync-fs pattern made more visible because import has *no* size cap and adds a parse step.

### 4. The nested CWE-22 note (path traversal)

- `absPath` **is** request-derived (`server.ts:369-370`), but it is not free-form: `path.resolve` + parent must pass `portal().folders.allowed(parent)` (`server.ts:372`; definition at `packages/extension-api/server.d.ts:412-415`: agent home or inside the workspace root, "by its real path"). Arbitrary traversal (e.g. `/etc/passwd.docx`) is rejected with 403 — the classic CWE-22 framing overstates it.
- The genuine gap (ours, already filed): the check runs on the resolved-but-**not realpath'd** path, and `statSync`/`copyFileSync` (`store.ts:371,407`) follow symlinks — a symlink planted inside an allowed workspace folder points the import outside it. Our `pr307-security.md` N1 rates impact **low** because every principal (agents, portal) already has host-filesystem access as the same user; isolated-half.ts states the isolation "is no security boundary: the process is the portal's user". No conflict with CR — we never called it safe; we rated it low-value. A `fs.realpathSync` + re-run `folders.allowed` (≈4 lines) closes it either way and makes a clean response to both comments at once.

### 5. `importedBaseline` behavior & the ping fallback (the "preserve existing behavior" constraint)

- Consumer: `extensions/office/src/ping.ts:235-240` — on first save of an imported doc, if `meta.importedBaseline !== undefined` it baselines exactly those ids; **if absent, it falls back to baselining everything this save holds** (comment at `ping.ts:238-240`: "When the field is absent (unparseable source) we fall back..."). So "skip parsing → leave `importedBaseline` undefined" already has defined, safe semantics (first save never wakes; slightly more conservative than an explicit baseline).

## Verdict

**Accept-and-fix — but with the minimal variant of CR's options, not a worker.** The core claim is valid: `/import` today has no size cap and the docx branch does an unbounded-length sync read + inflate + regex passes on the shared portal event loop (single in-process half; worst case seconds–tens-of-seconds + ~1 GiB heap, bounded only by `ooxml.ts` expansion caps). The CWE-22 note is our already-filed N1 (symlink follow past the logical-path `folders.allowed` check), low impact.

Recommended minimal fix (~8 lines in `importFile`, using the `st` that already exists at `store.ts:371`):
1. **Parse gate (soft):** run `parseDocx(readFileSync(...))` only when `st.size <= 32 MiB`; above it, leave `importedBaseline` undefined — exactly the documented "unparseable source" fallback in `ping.ts`, so imported-baseline behavior is preserved and no legitimate large doc is rejected. 32 MiB compressed ≈ far beyond any real text-document; parse cost stays under ~100 ms.
2. **Absolute cap (hard):** reject with a new `code: "too_large"` above e.g. **512 MiB**, guarding the copy and the ooxml memory envelope regardless of extension (xlsx imports skip parsing but still `copyFileSync` the whole file sync).
3. Optional, cheap, closes CR's ast-grep note too: `fs.realpathSync(absPath)` before the `folders.allowed` check in `server.ts` (per our N1).

**worker_threads is not justified**: it would break the deliberately-sync store contract (index atomicity), require a second parse pipeline for the equally-sync tool/persist paths (`tools.ts:190`, ping persist) to be consistent, and the margin case (skip-parse + cap) removes the blocking in practice. **CR's "🏗️ Heavy lift" label is overblown** — the minimal fix is a few lines; the worker option CR listed first is the heavy one and the wrong choice here.

## Recommended response (ready to post)

> Good catch on the missing size bound — agreed, and the fix is small rather than a worker: `importFile` already stats the source (`store.ts:371`), so I'll (a) run the docx baseline parse only up to a 32 MiB cap and leave `importedBaseline` undefined above it — which reuses the documented "unparseable source" fallback in `ping.ts`, preserving first-save baseline semantics — and (b) reject imports over 512 MiB outright, since the sync copy and the ooxml 1 GiB expansion envelope make anything larger a shared-event-loop hazard. For the traversal note: the path is gated by `folders.allowed` on its parent (`server.ts:372`), so arbitrary traversal is blocked; the real gap is symlink-following past the logical-path check — I'll `realpathSync` and re-check that closes it.

## Cross-reference with our findings (no conflicts)

- **`tasks/pr307-callback-concurrency.md`** (finding, ~line 64): "multi-MB docx parsed with the sync zlib codec **blocks the event loop for tens of ms per persist** — … Acceptable at current scale; if docs grow large, move diff/wake to a queue…" → we already accepted this hazard class on the *persist* path as scale-acceptable and prescribed the same escape valve CR proposes ("if docs get large, …move off"). Consistent: accept-and-fix-light is exactly our prior stance.
- **`tasks/pr307-ooxml.md`** (🔴 blocking, dense-grid `parseXlsx`): measured 1671-byte xlsx → +523 MB heap / ~18 s CPU; "there is no per-file parse guard … reachable from project-chat agents". Same unbounded-parse family, worse worst case than CR's docx framing, and it establishes the concrete parse-cost numbers used above. Also `ooxml.ts:90/96` caps (256 MiB entry / 1 GiB total) come from this review wave.
- **`tasks/pr307-security.md` N1** ("`importFile` follows symlinks — allowed-parent is checked on the logical path only", fix: `realpathSync` + re-check): CR's embedded CWE-22 note is this finding. No conflict — we rated it low-value (shared-user FS access), CR calls it traversal; both say "the check can be bypassed via symlink". Worth folding N1's one-line fix into the same response.
- `tasks/pr307-triage-architecture.md`, `tasks/pr307-tools-verification.md`: not relevant to this thread.

## Open questions

1. Is 512 MiB the right hard cap for *any* import, or should xlsx (no parse) be allowed larger than docx? (Copy is sync either way — argue for one shared cap.)
2. Should the same size gate eventually apply to `GET /documents/:id` (`server.ts:340`, whole-file `readFileSync`) and the `office_read` tool path (`tools.ts:190`) — same hazard, different routes; out of scope for replying to CR but a candidate follow-up ticket.
3. (Process note) pre-existing worktree `/tmp/pi-main-check [main]` present at `git worktree list`; not created by this review session, left untouched. No scratch files were created; no fixes applied.
