# PR #307 triage + architecture review — extensions/office ("pithagoras-office")

Branch `office/280-pithagoras-office` @ fee666ce, base main. 44 files, +8703/-1.

## Scope

Files assigned to this slice: `extensions/office/{README.md,build.mjs,deps.js,package.json,package-lock.json,tsconfig.json,.gitignore}`, `src/{settings.ts,host.ts,portal.tsx,office-ui.ts}`, the 1-line change in `core/server/test/extension-ui.test.mjs`, plus a skim of every other `src/*` and `test/*` file to map module boundaries. Reference: `architecture-review-guide.md`; comparison against sibling extensions (`docker`, `files`, `kanban`, `canvas`, `docs`).

## Method

- Full `git diff main...HEAD --stat` + read of all 13 server/client TS modules, README, build/packaging files, tsconfig, and the core test hunk.
- Structural diff vs 4–5 sibling extensions (layout, build.mjs, deps.js precedent in `docs`, cross-extension imports, tsconfig identity).
- Dependency-direction mapping across settings/host/server/callback/container/ping/store/tools/web; verification of wiring claims (imports actually used, routes registered, hooks attached) with grep + reading the built `server.js` to confirm what esbuild externalizes.
- Behavior-vs-docs cross-check: PR body / README / UI copy vs actual code paths (co-edit gate, forcesave hook, import/export endpoints, naming registration).

## Findings

### 🔴 [blocking]

None found in this slice. The concurrency/credential design (revision gate, signed callback envelope, loopback scoping) is sound; the issues below are documentation/wiring/boundary problems, not merge-stoppers as of this commit.

### 🟡 [important]

**1. Co-editing semantics are described backwards in the UI and README — the headline feature's mental model is inverted.**
- `src/web/settings.tsx:109` (coEdit toggle detail): "While **on**, an agent edit of a document somebody has open **proceeds** under the revision gate with a force-save request first; while **off**, it is **refused until the editor is closed**."
- Actual v1 behavior: `src/tools.ts:371` only enters the forcesave branch `if (loadSettings(rootDir()).coEdit && usersOf(doc.docId).length > 0)`, and the wired hook (`src/server.ts:140` `makeForcesaveHook`) **always returns false while a session is open** — so with coEdit ON, agent edits are *refused* (`error:session_open`) for as long as anyone has the editor open; with coEdit OFF, the branch is skipped entirely and agent edits *proceed* under the bare mtime gate even with a human session open.
- `README.md:11` repeats the same overclaim ("An open editor session does not block an agent edit — the extension force-saves the session first"). The test suite itself asserts the refusal (`test/server.test.mts:557–572`), i.e. code and docs disagree.
- Why it matters: a user who reads the toggle believes OFF is "the safe setting"; turning it off actually *removes* the only protection for an open human buffer (agent writes behind DS's back, then the human's save hits the stale-key gate at `src/callback.ts` persist path and fails in the editor). And users with defaults never see the advertised "co-editing".
- Fix: rewrite `settings.tsx:109` to state v1 reality ("with an editor session open, agent edits are refused until it closes or saves; a force-save flush is planned for M0") and fix `README.md:11`; add "browser-side forcesave-first (v1 refuses while a session is open)" to the README *Deferred* list. If the intended v1 semantics were instead "proceed after confirmed flush", that would be a functional gap in `makeForcesaveHook`, not a copy bug — worth one explicit sentence from the author on which is intended.

**2. `deps.js` is committed but dead — and the runtime-dependency guarantee it exists to provide is never wired.**
- Nothing imports `extensions/office/deps.js`: not `src/*`, not `test/*`, not `build.mjs`. The build duplicates its missing-deps check inline (`build.mjs:24–27`), mirroring what the docs extension does by *importing* it (`extensions/docs/build.mjs:15`).
- Consequence: the scenario the file's own header promises to handle ("a folder that comes without them (a checkout the portal runs from, a copy made by hand) has them installed here, once") does not exist in office — `ensureDependencies` is never called at server boot. The built half imports jszip as an external (`server.js:350` `import JSZip from "jszip"`; esbuild leaves packages external), so a package copy installed by path or hand-copied *without* its `node_modules/` fails to load the whole server half at import time with `ERR_MODULE_NOT_FOUND`. In the primary shipped flow (`extensions/office/` checkout, `npm ci` run by build.mjs) it works — hence not blocking.
- Fix (pick one): (a) follow the docs pattern — import `missingDependencies` in `build.mjs` instead of duplicating, and call `ensureDependencies(portal().log)` during boot before any template write; or (b) cleaner: bundle jszip into `server.js` (it is pure JS, no native bits), which removes the runtime `node_modules` requirement entirely and lets `deps.js` be deleted. Either way, as-is it is a boat anchor plus a missing safety net.

**3. "Export to chat folders" is claimed in the PR body/README but does not exist — and it is missing from the honest deferred list.**
- README *What it is* (line ~7): "import/export .docx/.xlsx to chat folders". `src/server.ts:366` `POST /import` genuinely imports *from* an agent workspace folder (gated by `portal().folders.allowed(parent)`). But `src/server.ts:384–409` `GET /documents/:id/export` only copies the bytes to a temp dir, serves them as an attachment, and deletes the temp dir — nothing is ever written into any chat/agent folder, and there is no other export route. The UI backs this up (`src/web/library.tsx:155–158`: "Download" and "Export a fresh copy" are both plain `<a href>` downloads).
- Why it matters: the PR body and README sell a v1 feature that isn't shipped, and unlike xlsx comments / refresh handshake / M0 reach, this absence is not on the *Deferred (honest list)*.
- Fix: implement `POST /documents/:id/export {path}` mirroring import in reverse (target parent must satisfy `folders.allowed`), or add "export to chat folders (v1 exports are downloads)" to Deferred and fix both texts.

**4. `ping.ts` keeps a second, inline writer for `index.json`, bypassing the module that owns it.**
- `src/ping.ts:158–173` `addGrant()` re-implements read-index → mutate doc.grants → atomic tmp+rename (`fs.renameSync(tmp, p)` at :171) — a duplicate of `src/store.ts:61` `writeIndex`, while store.ts's header declares index.json "the single source of truth" and exposes no grant mutation. The code concedes it: "If grant mutations are centralized in store.ts later, this helper goes away."
- Why it matters: the index has a `version: 1` field; any schema change (e.g. adding per-comment grant expiry, which is on the deferred list) now has to be remembered in two hand-rolled writers, and both use their own shape assumptions (`raw.docs`, `doc.grants ??= []`). Single-process sync read-modify-write means no live race today — this is an encapsulation/evolvability issue, not a correctness one.
- Fix: add `store.grantAccess(docId, chatId, commentId): boolean` (dedupe by `(chatId, commentId)`, `notFound` if the doc vanished between resolve and grant) and delete the inline writer in ping.ts.

### 🟢 [nit] / 💡 [suggestion]

**5. 💡 Unpinned image tags slip past the pin check → implicit `:latest`.**
- `src/server.ts:435` refuses `/:(latest|stable)$/i` or `@latest`, but a tag with *no* tag at all (e.g. `onlyoffice/documentserver`) passes and pulls `:latest` implicitly — precisely the "moved image breaks co-editing keys" scenario the refusal exists for. Suggestion: require an explicit pin — reject unless the tag contains a digest (`@sha256:`) or an explicit `:<tag>` after the last `/`. (Confidence: high on the regex gap; low that it matters in practice — the UI pre-fills the pinned default.)

**6. 🟢 `writeAtomic` (tmp-file + rename) is copy-pasted in four places.**
- `src/settings.ts:51`, `src/callback.ts:212`, `src/container.ts:102`, and inline twice in `src/ping.ts` (:148/:171), plus a third variant inside `store.writeIndex` (`src/store.ts:61–69`). All five are the same 5-line idiom with the same `.${name}.${pid}.tmp` convention. Suggest one shared internal module (e.g. `src/fsutil.ts`) — cheap now, and it keeps the tmp naming consistent if any of them ever needs a change. (Not a blocker; the copies are currently identical in behavior.)

**7. 🟢 No dedicated unit test for `src/live.ts`; no browser-level tests.**
- `live.ts` carries the most subtle state model in the extension (explicit lock flag vs presence-as-lock, terminal-close authority, meta resolver) but is only exercised through callback/server/tools/integration tests (no `test/live.test.mts`). Suggest a small dedicated file for the edge cases (`setUser` keep-original-`at`, unlock never hides presence, `pollState.pendingRev` with/without resolver). Also: sibling extensions ship browser tests (`extensions/docker/test/browser/docker.spec.mts`) while office has none — the once-per-page `api.js` load + DocEditor lifecycle in `src/web/office-editor.tsx` (script cache that *keeps* a rejected promise on failure, :28–46) is exactly the kind of thing a page-level test would pin down.

**8. 🟢 Client/server type duplication drift risk.**
- `src/web/api.ts` re-declares `OfficeDoc`/`OfficeContainer` hand-mirrored from `store.DocMeta`/`container.status` (expected — separate bundle, and it already omits `imported`/`importedBaseline`), but there is no shared type source of truth. Fine for v1; worth a comment or generated snippet if the meta grows fields (grant expiry would be the first).

**9. 📚 Verified non-issues from the triage brief.**
- *Naming:* `office/` dir vs `pithagoras-office` name is **not a mismatch** — every shipped extension follows `<dir>` = package name minus the `pithagoras-` prefix (docker→pithagoras-docker, files→pithagoras-files, …), and the core test hunk (`core/server/test/extension-ui.test.mjs:216`) asserts exactly that mapping (`spec.endsWith(extensions/<name without prefix>)`). Registration, log prefixes, `DS_NAME = "pithagoras-office-ds"`, routes (`/x/pithagoras-office`, `/api/x/pithagoras-office`) all key off the package name. Consistent.
- *Cross-extension imports:* `src/host.ts:2` / `src/container.ts:45` importing types from `../../docker/src/api` matches existing precedent (browser, voice, understory do the same), and both are type-only. No runtime cross-extension coupling.
- *tsconfig/packaging:* byte-identical tsconfig to `extensions/docker` (`strict`, `noEmit`, ES2022); build via repo `@pithagoras/extension-api/build` like siblings; `.gitignore` matches the kanban variant exactly. No divergence.
- *settings schema:* opt-in default (`enabled: false`), pinned tag default, field-by-field merge with silent fallback on corruption (documented at the module header of `src/settings.ts`) — reasonable for a local trusted file; only asymmetry is #5/#7-of-load (no format validation on load, only in `POST /settings`).

### Module-boundary map (what I checked)

```
host.ts        ← composition seam: ServerPortal, dataDir, docker() (type-only from extensions/docker)
settings.ts    → host(dataDir)                 [pure-ish, fs over root]
store.ts       → host, ooxml(parseDocx, import baseline), jszip(templates)   [owns index.json + docs/ layout]
ooxml.ts       → node:zlib only                [pure over buffers]
jwt.ts/tickets.ts → node:crypto only           [pure; shared secret string owned by caller]
live.ts        → (nothing)                     [pure process memory + injected resolver]
callback.ts    → host, jwt, store, live        [deliberately NOT container — keeps CallbackState local; documented]
ping.ts        → host, store(getDoc), ooxml, callback(onPersisted)  [+ inline index writer — finding #4]
tools.ts       → host, store, ooxml, live, settings, ping(drainWakeQueue)
container.ts   → host(settings via loadSettings, docker type-only), fs (ds.json, user-stopped marker)
server.ts      → all of the above              [composition root: wires seams once, owns loopback listener + routes]
web/*          → portal.tsx(slot/api seam), api.ts(hand-mirrored types) — client bundle, no server imports
```
Direction is clean (leaves are fs/portal-free; only server.ts knows everything); the two boundary blurs are findings #4 (ping→index.json) and the minor `store→ooxml` import for import-time comment baselines (`src/store.ts:19,384`) — the latter I accept: it's documented, one function, and moving it up would push docx internals into the route layer instead.

No circular dependencies; no god objects except `server.ts` (561 lines), which is defensible as the composition root + HTTP surface for a single-extension process.

### Test strategy (architecture view)

120 unit tests across 10 files + 3 docker-gated integration tests (`test/integration.test.mts`, gated on `OFFICE_IT_DOCKER=1` + `docker info` probe, skipping with explicit reasons). Coverage is strong where the logic is dense: callback status machine incl. double-save memo & stale-key refusal (598 lines), container lifecycle with a fake Docker (343), all UI routes + boot/loopback against a fake portal (577), tools refusals/revision gate (417), ping mention grammar/baselining (301), store ops (304), ooxml zip codec cross-validated vs jszip + committed fixtures. Gaps: `live.ts` directly (#7), browser half end-to-end (#7), and the *real* DS save loop stays human-operated by design — honestly stated in the integration header ("not invented here"), which I accept for v1.

### README honesty check

*Deferred (honest list)* matches code well: xlsx comments (M4) ✓, refresh handshake/M0 reach + option-a recorded origin with loud `container:<id>` refusal (`src/server.ts:246` → 422 JSON) ✓, portal proxy for DS traffic ✓, `.pptx`/`office_comment_add`/grant expiry/postMessage badges as M4 stretch ✓. **Not** on the list but absent: "export to chat folders" (#3) and the forcesave-first flush that v1 cannot perform (#1). Those two are the honest-list gaps.

## What's good

- 🎉 Composition discipline is excellent for a new extension: `server.ts` wires every seam exactly once at boot; every stateful module takes injectable seams with lazy defaults so 120 unit tests never touch `portal()` or the Docker socket; module headers read like contracts (and the comments document *divergences from the plan*, e.g. no `HostConfig.Memory` cap, `container:` origin marker, zip re-compression deviation — rare and valuable).
- 🎉 The callback handler's envelope-from-signed-claims design (`src/callback.ts` "Envelope binding (security)") closes what would otherwise be a trivial overwrite primitive: with a valid token alone an attacker can still only persist what DS itself signed. Status-table fidelity (200 + `{"error":1}` on persist failure) is implemented exactly as documented in the module header.
- 🎉 Deliberate dependency inversion where it counts: `callback.ts` keeps a local `CallbackState` type instead of importing the Docker half; `live.ts` stays fs/portal-free with an injected meta resolver; `ooxml/jwt/tickets` are pure and trivially testable.
- 🎉 The core change is surgically minimal — one asserted array entry in `core/server/test/extension-ui.test.mjs`, no core behavior touched.
- 🎉 Store discipline: atomic index writes, mtime-as-revision with a strict write-time gate, safe-title validation (`assertSafeTitle`), 7-day trash sweep, adopt-never-recreate container policy with a durable `user-stopped` marker file.

## Open questions

1. **Intended v1 co-edit semantics** — is "agent refused while any human session is open" (what ships) the accepted reading of plan 5.7 tier-1, or should `makeForcesaveHook` reach the browser for a real forcesave? Determines whether finding #1 is copy-only or also functional.
2. **Human-UI scoping** — all `/documents*` routes are unscoped: any authenticated portal session can list/download/delete *any* document (owner/grants scope only the agent tools and chat panel). Fine for a single-user homelab, but worth an explicit sentence in the README; multi-user would need per-route checks.
3. **Ticket replay** — `GET /doc/<ticket>` tickets are HMAC'd + 10-min TTL but not consumed-once; any local process can replay one within its window (mitigated by 127.0.0.1-only binding). Acceptable for v1?
4. **Presence identity** — `EDITOR_USER = { id: "portal-user", name: "Portal" }` collapses all humans into one seat, so two real co-editors show as one and can't be distinguished in lock badges. Known limitation (commented) — confirm it's acceptable.
5. **History retention** — `history/<docId>/<rev>.zip` archives are written per persist with no pruning anywhere (only removed when the doc itself hits the 7-day trash sweep). Unbounded growth is presumably fine for v1; worth a note or a cap.
