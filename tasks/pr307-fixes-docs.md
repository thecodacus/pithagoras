# PR #307 review fixes — DOCS, WIRING & small SRC hygiene (docs agent)

Scope: items 1–6 of the review + item 7 (checked, skipped). Core-logic items (ooxml.ts
parsing/CRC, server.ts import route, live.ts TTL, token claims) were owned by another agent
working in the same tree concurrently; I did not touch those files' logic.

Branch: `office/280-pithagoras-office`. All verification commands run from `/root/repos/pithagoras`.

---

## 1) Co-editing docs inversion — DOCS ONLY (behavior untouched, confirmed intentional)

Real v1 semantics (asserted by `test/server.test.mts:557-572`, implemented in
`src/tools.ts:377` gate + `src/server.ts:146` `makeForcesaveHook` which resolves **false** while
any session is open): `coEdit` ON (default) => agent edits **refused** with
`error:session_open` until the human editor session closes; `coEdit` OFF => edits proceed under
the bare mtime revision gate even with a session open.

Rewritten spots (all were inverted — they claimed on=proceeds/forcesave, off=refused):

- `extensions/office/README.md:11` — bullet now: "Co-edit protection, on by default (`coEdit`):
  while a human has the document open in the editor, an agent edit is REFUSED with
  `error:session_open` until the session closes … With `coEdit` switched off in settings, agent
  edits proceed under the plain mtime revision gate even with an editor session open."
- `extensions/office/src/web/settings.tsx:109` — the toggle's detail text now says the same
  (on = refused until session closes; off = proceeds under the revision gate).
- `extensions/office/src/tools.ts:16-24` (module header comment) — was "the agent does not
  refuse -- it FORCESAVEs … An open session never blocks"; now describes v1 fail-closed refusal
  and the coEdit-OFF exception.
- `extensions/office/src/tools.ts:328` (`office_edit` tool description, agent-facing) — was
  "proceeds only once their unsaved changes are flushed by a COMPLETED force-save"; now states
  the refusal-until-close semantics and the coEdit-off gate-only path.
- `extensions/office/src/tools.ts:367-372` (comment above the gate) — reworded to "fail-closed in
  v1 … v1's real hook never confirms while sessions are open, so this branch in practice always
  refuses until the editor closes; with coEdit off it is skipped and the gate decides."

Deliberately NOT touched: `src/tools.ts` gate logic (~:377), `src/server.ts:146-152`
(`makeForcesaveHook`, whose docblock was already accurate), and the tests asserting the refusal.

Tests: no behavior change; suite green after the item (comment/string-only edits).

## 2) Dead deps.js wiring — mirrored the pithagoras-docs pattern

`extensions/office/deps.js` was committed but imported by nothing; `ensureDependencies` never ran;
the built `server.js` kept a top-level external `import JSZip from "jszip"`, so a hand-copied
folder without `node_modules` died at module load with `ERR_MODULE_NOT_FOUND`.

Changes:

- **New `extensions/office/src/jszip.ts`** — lazy loader replacing the static imports. Exports
  `jsZip(): Promise<JSZipStatic>` (one cached load per process; a failed load is NOT cached) and
  `armJsZipInstall(promise)` which makes the first call await the boot-time install. The file uses
  `import type JSZip from "jszip"` only — erased at build, so the bundle carries no static jszip
  dependency. Runtime interop checked: Node's dynamic `import("jszip")` gives the package object as
  `.default` (CJS main), constructable + `loadAsync` present.
- `extensions/office/src/store.ts:17` — `import JSZip from "jszip"` replaced by
  `import { jsZip } from "./jszip"`; `templateDocx` (`store.ts:138`) and `templateXlsx`
  (`store.ts:182`) now do `new (await jsZip())()`. All other store I/O stays sync (house rule).
- `extensions/office/src/tools.ts:40,389` — same for the one edit-path use:
  `const zip = await (await jsZip()).loadAsync(buf);`.
- **New `extensions/office/deps.d.ts`** — type surface of the JS `deps.js` so strict tsc accepts
  the import from TS source (esbuild bundles the real .js; tsc reads the declarations).
- `extensions/office/src/server.ts:48-49,531` — server entry now wires the boot install, exactly
  as docs' `server.js:396-399` does for better-sqlite3: `void armJsZipInstall(ensureDependencies(logLine));`
  right after `setPortal`. Boot does NOT wait (background install); only the first
  template/import call blocks on it. Module-header docstring extended with step 8 documenting this.
- `extensions/office/build.mjs:17,20` — the inline package-lock diffing was replaced by
  `import { missingDependencies } from "./deps.js"` + `missingDependencies(HERE, { dev: true })`,
  mirroring `extensions/docs/build.mjs` (build-time and runtime checks now share one implementation).

Tests added: **`extensions/office/test/jszip.test.mts`** (2 tests) — the armed install promise
gates the first load (still pending while unsettled, resolves to the real package after release);
the load is cached (a later non-settling arm cannot re-gate it); resolved shape has `loadAsync`,
constructs an archive, and exposes a version string.

Verification performed:

- `node scripts/build-extensions.mjs` succeeds; emitted `server.js` contains **zero** static
  `import ... from "jszip"` / `require("jszip")` — only the deferred dynamic `import("jszip")`,
  and the deps.js logic is bundled (`pithagoras-office/installs` symbol present, install log lines
  present). Top-level externals are node builtins only.
- Decisive check: renamed `extensions/office/node_modules/jszip` away and imported the BUILT
  `server.js` with plain Node → `IMPORT-OK, default export: function` (the pre-fix bundle fails
  this import); restored afterwards.
- `deps.js` detection sanity: `missingDependencies()` → `[]` with jszip present, `["jszip"]` with
  it hidden; i.e. a fresh boot would log-and-install in the background, and `jsZip()` would wait
  for it.

## 3) "Export to chat folders" claim removed

The export route (`src/server.ts:390-407`) copies to a temp dir, serves an attachment and deletes
it; both library buttons (`src/web/library.tsx:155-160`) are plain downloads. No copy-into-chat-
folder feature exists.

- `extensions/office/README.md:9` — now "import .docx/.xlsx into the library and export (download)
  a copy of one".
- `extensions/office/README.md:38` — Deferred list gains "**Exporting into chat folders** — the
  export route serves a download of the stored bytes (fresh copy, served as an attachment); copying
  a document into a chat folder does not exist in v1."

PR body untouched; feature NOT implemented. No tests needed (docs only).

## 4) Second index writer eliminated

`src/ping.ts` `addGrant` (old :152-173) did its own read-modify-write + rename of
`index.json`, bypassing the store's atomic path and duplicating the dedupe rule.

- **New `extensions/office/src/store.ts:204-221`** — exported
  `addGrant(docId, chatId, commentId, at, root?): "added" | "duplicate" | null`. It is THE index
  writer for grants: fresh `readIndex`, dedupe by (chatId, commentId), atomic tmp+rename through
  the store's private `writeIndex` (`store.ts:61-66`). Sync and log-free per the store module
  contract. Returns tri-state so callers can distinguish "added" / "already granted" / "doc not in
  index"; a corrupt index throws the usual `{code:"index_corrupt"}` like every other store op.
- `extensions/office/src/ping.ts:33,149-157` — the local writer is gone; ping's wrapper now calls
  `storeAddGrant(...)` and keeps its original log line for the vanished-doc case (`office ping:
  document <id> vanished from index between resolve and grant -- skipped`). Call site unchanged
  (`processComment`, ~:216); a throw (corrupt index) is caught by the existing per-comment
  try/catch in `handlePersisted` (`ping.ts:~265`) which logs and leaves the comment unseen for
  retry — strictly safer than the old raw-parse, which crashed out of that path on malformed JSON.

Behavior kept identical for all realistic inputs (well-formed index): same dedupe key, same grant
shape `{chatId, commentId, at}`, same file format (`JSON.stringify(index, null, 2)`, no trailing
newline — matches the store writer), and `writeSeen` still runs only after processing. Existing
ping/store tests (grant count, dedupe, `.at` typed, doc-missing skips) all pass unchanged; no new
test was added because the existing suite already exercises the grant path end-to-end through the
new single writer.

## 5) Mention-grant wording softened to match reality

Grants are permanent in v1 (per-comment expiry is deferred), so "for this task" was a false promise.

- `extensions/office/src/ping.ts:104` — wake text last line: was
  `"You have edit access to this document for this task; answer with the office_* tools."`, now
  `"You have been given edit access to this document; answer with the office_* tools."`. The
  `officeWakeMessage` docblock (`ping.ts:99`) now explains why ("given access", NOT "for this
  task": grants are permanent, expiry deferred).
- `extensions/office/test/ping.test.mts:101,105` — the two exact-template assertions updated to
  the new sentence. No expiry/revocation implemented (explicitly out of scope).

## 6) Host-mode DS network exposure documented (no code change — untestable here)

Container setup untouched (per brief; no OnlyOffice image available locally to verify nginx).
Added a **`## Security notes`** section to `extensions/office/README.md:40-42`: the DS container
runs with the portal's shared network (`NetworkMode` from `docker.sharedNetwork()`, resolved to
`"host"` in this deployment per `src/container.ts:194,211`), so the image's nginx serves the DS
web origin (:80) on 0.0.0.0 — host/LAN/tailnet peers reaching port 80 get the Document Server UI
with no portal login gate in front (the per-config JWTs sign portal-minted requests, they are not
access control for strangers). Operators should firewall :80 or (planned work) override
`/etc/nginx/conf.d` via a named volume. This also becomes the anchor for the pre-existing "see
below" pointer at README:28, which previously pointed at nothing.

## 7) [Optional] Cross-paragraph quote edits leave a stray line break — SKIPPED (not a one-liner)

Checked `src/ooxml.ts` `applyEdit` (:314-385): the replacement lands in the first touched `w:t`;
fully-covered runs in LATER paragraphs are dropped, but their now-empty `<w:p>` elements stay in
document.xml. Re-parsing then yields an empty paragraph (a stray `\n`) at that position. A correct
fix means removing fully-emptied `<w:p>` subtrees from the XML (while not touching paragraphs that
keep text, bookmarks or section properties) — real paragraph-level surgery with edge cases
(sectPr-bearing final paragraph), NOT a safe one-liner. Left for the core-logic owner; noted here.

---

## Finish-line verification (final state of my items)

- Tests: `env -u NODE_ENV node --import tsx --test "extensions/office/test/*.test.mts"` →
  **0 fail, 3 skipped** (the docker-gated skips from baseline). Pass count grew 120 → 135: +2 mine
  (jszip loader), the rest added by the concurrent core-logic agent in the shared tree.
- Types: `npx tsc --noEmit -p extensions/office` → **clean** (strict). Note: during my run window
  the other agent had `src/live.ts` mid-edit (a transient `expiresAt` type error); at final check
  it — and everything else — compiled clean.
- Build: `node scripts/build-extensions.mjs` → DONE; deps wiring verified as in item 2 (no static
  jszip import in built server.js; imports without node_modules/jszip present).

## Deliberately NOT done

- Item 7 (see above): skip + note, per the "only if quick" rule.
- No bundle-of-jszip alternative for item 2: `packages/extension-api/build.mjs` hardcodes
  `packages: "external"` for server builds, so inlining jszip would have meant bypassing the shared
  builder — the docs pattern (lazy import + boot install) is the repo's established shape and was
  mirrored instead. `deps.js` therefore KEPT (now wired), not deleted.
- Co-edit behavior, container/nginx config, grant expiry/revocation, export-to-chat-folders: all
  untouched per brief; only docs changed where required.
- No temp files/dirs created; no git state-changing commands run. Untracked files in the tree
  (`tasks/`, `PLAN-office-280.md`, `.office-contracts.md`, `.pi/`, `.reports/`) left as found.

## Files I touched

| File | Change |
| --- | --- |
| `extensions/office/README.md` | items 1, 3, 6 (bullets :9/:11, deferred :38, security notes :40) |
| `extensions/office/src/web/settings.tsx` | item 1 (:109 tooltip) |
| `extensions/office/src/tools.ts` | item 1 (header :16-24, description :328, comment :367) + item 2 jszip lazy import (:40,:389) |
| `extensions/office/src/server.ts` | item 2 boot wiring (:48-49,:531, header step 8) — no other server logic touched |
| `extensions/office/src/store.ts` | item 2 lazy jszip (:17,:138,:182) + item 4 new exported `addGrant` (:204-221) |
| `extensions/office/src/ping.ts` | item 4 single writer (:33,:149-157) + item 5 wake text (:99,:104) |
| `extensions/office/src/jszip.ts` | NEW (item 2) |
| `extensions/office/deps.d.ts` | NEW (item 2, types for deps.js) |
| `extensions/office/build.mjs` | item 2 (uses deps.js `missingDependencies`) |
| `extensions/office/test/jszip.test.mts` | NEW (item 2 tests) |
| `extensions/office/test/ping.test.mts` | item 5 (two template assertions) |
