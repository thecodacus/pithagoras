# PR #307 — office: create-bug diagnosis + workspace library (scan/index, sortable)

Branch `office/280-pithagoras-office`, work lands on top of pushed `f4330519` + the uncommitted co-editor-model changes. All numbers below re-verified at the finish line.

## (a) Task 1 — "cannot create a new document": root cause, proven with logs

**Root cause: the live portal is serving a STALE pre-12:18 build of the office extension.** The running process is `node server/dist/index.js` from `/root/pithagoras`, pid **2115289** (started Oct 24 10:19), which loaded the office half at **Oct 24 11:47** from the pi package path `../../repos/pithagoras/extensions/office` (`/root/.pi/agent/settings.json`, added that same morning per the `settings.json.bak-20261024-114641` diff). The rebuilt bundles in-tree are newer than the loaded code:

* Journal (systemd, process 2115289 — the exact lines that proved it):
  ```
  Oct 24 11:47:51 lxcpithagoras node[2115289]: [extension pithagoras-office] server half started
  Oct 24 11:56:52 lxcpithagoras node[2115289]: [extension pithagoras-office] pithagoras-office: pithagoras-office-ds -- document server started
  Oct 24 11:58:03 lxcpithagoras node[2115289]: [extension pithagoras-office] pithagoras-office: pithagoras-office settings -- enabled=true imageTag=onlyoffice/documentserver:10.0 coEdit=true
  ```
  **No further "server half started" line exists** — the extension has not restarted since 11:47, i.e. it runs code from before the noon rebuild.
* Proof the loaded code is old: `journalctl` shows the live audit at 11:58 **accepted a `coEdit` settings key**, and `/var/lib/pithagoras/extension-data/pithagoras-office/settings.json` still contains `"coEdit": true`. Only the pre-co-editor-model bundle accepted that key — current source and the rebuilt bundles contain no `coEdit` at all (`grep -c coEdit server.js web/client.js` = 0 in both, built 12:18:59).
* The old code also swallowed the create failure on the UI side (no log line is left for it — there is NO error entry anywhere around `POST /documents`), so the click looks dead.
* Dependencies were never the missing piece at boot time: `node_modules/jszip` in the office folder exists with mtime Oct 23 16:28, i.e. BEFORE the 11:47 half start; `import("jszip")` from the office dir resolves fine (`typeof m.default === function`).
* **The current-tree creation path is proven good end-to-end**: direct `store.createDoc` probe on a tmp dataDir → 201, docx 1740 bytes; and a full express round-trip against the freshly built `server.js` with a stub portal → `POST /documents` **201** for both `word` and `cell`, `GET /state` 200. So: after whatever reloads the extension (a later deploy/restart — NOT done here, per instructions), creation works; until then the button hits dead/stale code.

**Robustness fix implemented so the failure mode can never be a dead click again:**
* `POST /documents` in `src/server.ts` now catches jszip/dependency load failures (`isDependencyError()` walks the `.cause` chain for `ERR_MODULE_NOT_FOUND` naming jszip or an install message) and answers **503 `{ error: "...jszip dependency is still installing... retry in a few seconds.", code: "dependencies_pending" }`**; every OTHER createDoc failure now gets a `logLine(`POST /documents failed: ...`)` before the coded response — route errors previously left no trace at all, which is exactly why this incident had no log to read.
* The UI already surfaces it verbatim: core's `json()` throws `ApiError(body.error)` (verified `core/web/src/api.ts`), and `NewDocument` renders it in an `ErrorBanner`.

## (b) Task 2 — scan roots: which platform API, and what resolves here

**API: `portal().folders.list(): AgentFolder[]`** — declared in `packages/extension-api/server.d.ts` ("Every agent's home, every project, and every folder a chat of any kind works in, each once"), implemented by core at `core/server/src/agent-folders.ts:listFolders()` (wired into the extension context at `core/server/src/extension-host.ts:551`, `list: () => listFolders()`). No paths are hardcoded anywhere in the office code — both the boot scan and `POST /documents/rescan` call `portal().folders.list().map((f) => f.path)` fresh.

On THIS machine (live portal pid 2115289, `WORKSPACE_ROOT=/root/repos` per `/proc/<pid>/environ`; core default would be `/workspaces`): the resolved roots are `/root/repos` itself plus every agent/project/chat folder beneath it (`listProjects(workspaceRoot())` in agent-folders.ts). The office's own data dir (`/var/lib/pithagoras/extension-data/pithagoras-office`) is OUTSIDE that tree, but the scanner still defensively skips its own realpath if it ever were nested. `find /root/repos -name '*.docx' -o -name '*.xlsx'` currently returns nothing, so a live rescan today would honestly index 0 files.

## (c) Files changed and why (all under extensions/office/** unless noted)

| File | Why |
|---|---|
| `src/store.ts` | Added `DocMeta.path?: string` (in-place identity for scanned docs, realpath); `docPath()` prefers it; NEW `scanWorkspace(roots, root)` + `indexOne()` — sync bounded walk (skips own dataDir, `.trash`, hidden dirs, `node_modules`; case-insensitive `*.docx/*.xlsx`; realpath identity so symlinked duplicates index once), 512 MiB cap, unsafe-title skip, `importedBaseline` stamped AT INDEX TIME for docx ≤32 MiB (pre-existing @mentions never wake at index time); refreshes mtimeMs/sizeBytes on rescan (only real changes count as `updated`). `renameDoc` renames inside the file's own dir (workspace files rename in place, library files unchanged behavior); `deleteDoc` moves a scanned doc's REAL file to `.trash` (7-day sweep) and treats an already-vanished file as a clean index drop instead of ENOENT; `importFile` kept (ping.test exercises its copy-into-library baseline flow) but marked superseded. |
| `src/server.ts` | Boot now runs `scanWorkspace(folders.list() paths)` AFTER `settleKept` (prune first, so vanished files aren't re-added) and logs counts; NEW route `POST /documents/rescan → {added, updated}` (reads folders live per request); DELETED `POST /import`; Task-1 fix: 503 `dependencies_pending` + `logLine` for create failures; `fileFor()` honors `DocMeta.path` so download/export serve the real workspace file. |
| `src/web/api.ts` | Dropped `api.importFile`; added `api.rescanLibrary()`; documented that core's `ApiError(body.error)` makes every refusal (incl. the 503) land in the UI verbatim. |
| `src/web/library.tsx` | Removed the `ImportDocuments` form and all import copy (header comment, PageHeader description, Empty state); added sort controls — `portal.ui.Select` (name/modified/size/type) + direction toggle, persisted to `localStorage` (`po-sort`), default modified-descending, pure client-side over the polled payload (`useMemo`); added a Rescan workspace ghost button that says its counts in a hint line. Row layout untouched. |
| `style.css` | `.po-listhead`, `.po-sortbar`, `.po-rescan` (flex rows consistent with existing `.po-form`/`.po-hint`). |
| `src/ping.ts` | Comment-only: baseline stampers are now `importFile / scanWorkspace`. |
| `test/store.test.mts` | +5 tests: nested/case-insensitive discovery + skip rules; own-dir (docs/ and .trash) never indexed even when passed as a root; rescan refresh semantics + in-place mtime-gated persist on a scanned doc; oversized (sparse 513 MiB)/unsafe-title/title-collision are quiet skips; deleteDoc moves the real file to trash, vanished-file delete is a clean drop, `pruneMissingDocs` agrees. |
| `test/server.test.mts` | Replaced both `/import` route tests with: rescan indexes in place (no copy into docs/), skips hidden/node_modules/.txt, idempotent second run, refresh after out-of-band write, `/state` payload carries `mtimeMs`/`sizeBytes`/`path`, export serves the real file's bytes, and `POST /import` is **unregistered** (`assert.rejects ... no registered POST route for /import`); plus a rescan baseline-stamping test (real docx with a pre-existing comment → `importedBaseline ["1"]`). |
| `README.md` | Library bullet + Setup step 2 rewritten: no manual import — automatic boot scan (+ Rescan button), in-place docs, deleting a scanned doc moves the real file to the 7-day trash. |
| `.office-contracts.md` (repo root) | Endpoint docs updated: `POST /import` gone, `POST /documents/rescan` added, `/state` docs now carry mtimeMs/sizeBytes (+path), store interface gains `scanWorkspace`, deleteDoc/prune semantics for external paths. |
| `PLAN-office-280.md` (repo root) | Supersession note at §2 where import is described as first-class: manual import replaced by the `folders.list()` scan; export-to-chat-folders stays deferred. |

## (d) Finish line (all at once, re-run after every edit)

* Tests: `env -u NODE_ENV node --import tsx --test "extensions/office/test/*.test.mts"` → **140 pass / 0 fail / 3 skipped** (the 3 docker-gated integration skips are the pre-existing ones; baseline was 135/0/3).
* `npx tsc --noEmit -p extensions/office` → **exit 0, no errors**.
* `node scripts/build-extensions.mjs` → **DONE, exit 0** (office built web/ + server.js among all packages).
* `git status`: modified files exactly `extensions/office/{README.md, src/live.ts, src/ping.ts, src/server.ts, src/settings.ts, src/store.ts, src/tools.ts, src/web/api.ts, src/web/library.tsx, src/web/settings.tsx, style.css, test/container.test.mts, test/integration.test.mts, test/server.test.mts, test/settings.test.mts, test/store.test.mts, test/tools.test.mts}` (the non-office-hunk ones are the co-editor's uncommitted changes, untouched) + untracked `.office-contracts.md`, `PLAN-office-280.md`, `tasks/` (`.pi/`, `.reports/` predate this session).

## (e) Deliberately NOT done

* **No redeploy/restart of the live portal** — the stale bundle is only fixed by a reload/deploy, which the task assigned to a later push agent; nothing was killed or rewritten outside its log files (logs read-only, via `journalctl`/`/proc`).
* No changes under `core/` or other extensions (read for discovery only).
* Kept `store.importFile` and its 4 store tests instead of deleting them: ping.test's first-save wake semantics are the product behavior and it exercises the copy flow cheaply; the route/UI surface is gone, which is what the decision required.
* The boot scan runs once at startup (plus manual Rescan) — there is no interval-based rescan; a `folders.removed`-triggered unindex also does not exist yet (a workspace file deleted out-of-band simply prunes itself at the next settleKept/boot).
* `DocMeta.path` deliberately appears in the human `/state` payload but never in agent-facing tool output: tools scope through `docsForHome`, and every scanned doc is `owner:null`, so path-carrying docs are invisible to `office_*` tools by construction.
* Did not add xlsx baseline stamping (docx only) — consistent with the pre-existing importFile behavior, and xlsx comment wakes are already an M4 item.
