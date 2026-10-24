# PR #307 — co-edit model (no switch) implemented

Branch `office/280-pithagoras-office`. The refuse-while-a-session-is-open model (`coEdit` setting + forcesave-first
hook + `error:session_open`) is removed. The agent is now just another user in the editor: edits ALWAYS proceed under
the existing strict mtime/revision gate (zero tolerance, `store.persistBytes`), and a stale edit fails loudly as a
CONFLICT (`error:revision_mismatch`, same code other tools/tests depend on) with a re-read-and-retry instruction,
naming the open human editor when one stands. `live.ts` behavior is untouched; open editors still learn about external
changes through the existing polling loop (`pollState`).

## 1) Session-open / forcesave gate removed from office_edit — `extensions/office/src/tools.ts`

- Module header, revision-model paragraph (now ~lines 16–25): rewritten to the co-editor model (no switch, no session
  check; gate decides; stale edit → loud CONFLICT → re-read + retry).
- Injection-seams paragraph: dropped the "setForcesaveHook installs…" sentence.
- Forcesave seam deleted (was ~lines 75–93): `let forcesaveHook`, `export function setForcesaveHook(...)`.
  `__resetToolsForTests()` now only resets `cfg` (line ~76). Import of `loadSettings` removed (no other user in this file).
- `office_edit` tool description (~line 328): rewritten — "You are a CO-EDITOR alongside any human who has the document
  open — there is no session check and no switch… if the document moved on since (for example a co-editor's save) NOTHING
  is written and you hear a CONFLICT with the fresh revision — re-read and retry."
- The old `if (loadSettings(...).coEdit && usersOf(...).length > 0) { …session_open refusals… }` block (~370–381 in the
  pre-change file) is GONE. In its place, a comment (lines 354–356) stating presence neither allows nor blocks; the gate
  alone decides.
- Stale-message now an explicit CONFLICT (`stale()` closure, lines 357–362): code stays `revision_mismatch`; message is
  `CONFLICT: "<title>" is at revision <fresh>, not <base>: it changed since you read it. Nothing was written.` + when
  `usersOf(docId).length > 0` an appended `openEditorNote`: "A human editor (names) still has the document open…".
- New catch around `persistBytes` (lines 379–392): if the strict final gate throws `{code:"revision_mismatch"}` (file moved
  between the pre-gate read and the write), office_edit re-throws a loud CONFLICT `Refusal("revision_mismatch", …)` with the
  FRESH `currentMtimeMs`, base revision, open-editor note when `usersOf(docId).length > 0`, and the re-read-and-retry
  instruction. All other errors propagate unchanged (so `failed()`'s generic coding still applies everywhere else).

## 2) forcesave hook removed from the server — `extensions/office/src/server.ts`

- Header item 3 (line 9): replaced with a note that there is NO co-editing switch and NO hook to wire (co-editor model).
- Boot: `setForcesaveHook(makeForcesaveHook())` call deleted; import now `import { registerTools } from "./tools"` (line 49);
  a NOTE comment at the seams (lines ~517–518) documents that no flush-before-write hook exists.
- `makeForcesaveHook()` function + its audit line deleted (was ~lines 137–152); section header is now just "settleKept"
  (~line 126).

## 3) coEdit setting removed end-to-end

- `src/settings.ts`: `OfficeSettings` = `{ enabled, imageTag }` (line 13); `DEFAULT_SETTINGS` without `coEdit` (line 16);
  `loadSettings` returns only the two fields. LEGACY tolerance is structural: `field()` only reads known keys, so an
  existing settings.json carrying `"coEdit": …` loads fine and the value is ignored; doc comment at line 25 says exactly this.
  `saveSettings` already dropped unknown/absent keys, so a re-save rewrites legacy files clean (covered by tests).
- `src/server.ts`: GET /state payload no longer carries `coEdit` (`res.json({ enabled, imageTag, container, docs, locks })`,
  ~line 290); POST /settings: the `if ("coEdit" in body)` branch + `invalid_coedit` are deleted — a body of only `{coEdit}`
  falls through to the existing 400 path (error text updated to `send { enabled?, imageTag? }`, line 441); audit line at
  line 444 no longer logs coEdit; route doc comment notes there is no co-editing switch (line 424).
- `src/web/api.ts`: `OfficeState.coEdit`, `SettingsPatch.coEdit` and `SettingsAnswer.settings.coEdit` removed.
- `src/web/settings.tsx`: the "Live co-editing between agent and editor" `SwitchRow` + tooltip deleted; header comment
  (lines 8–10) updated to state there is no switch. Surrounding layout untouched.
- The remaining "co-editing **keys**" strings in settings.tsx/server.ts (`:latest` warnings, lines 51/52/118 and the
  `invalid_image_tag` error text) are a DIFFERENT concept — the DS JWT key — and were intentionally kept (behavior + tests
  depend on that wording).

## 4) Docs rewritten to the co-editor model

- `src/tools.ts` module header (see §1): "The agent is a CO-EDITOR alongside human editor sessions (live.ts) -- like Office
  365 there is NO switch and NO session check: the edit proceeds under that gate regardless of who else has the document
  open… loud CONFLICT (error:revision_mismatch), naming the open editor session when one stands — re-read and retry."
- `src/server.ts` header + boot NOTE (see §2).
- `README.md` line 11 ("Co-edit protection, on by default (`coEdit`)") replaced with "**Co-editor model (no switch)**: …
  Conflicts are surfaced, not prevented by refusal. Open editors learn about external changes through the existing 5 s
  polling loop (`live.ts pollState`). Every agent revision is recorded for the editor's version history."
- README Deferred item "Co-editing refresh handshake / M0 browser-reach decision" (line 35) kept VERBATIM — live in-editor
  refresh of agent changes is still deferred and the entry stays accurate.
- `src/live.ts` comments fixed where they described the removed refusal: line ~29 (TTL no longer "refuses every office_edit";
  it keeps DS lock + badge honest), lines ~31–34 ("does NOT change lock/badge semantics… Agent edits are gated purely on
  the revision, never on who is present — an open editor neither allows nor blocks office_edit"), line ~85 (usersOf doc).
  **No behavior change in live.ts** (presence, TTL, `pollState`, `setLocked` untouched).

## 5) Tests changed/added

- `test/tools.test.mts`:
  - Import of `setForcesaveHook` removed; header comment + `bumpRevision` doc updated. `bumpRevision` now mirrors the stat
    READBACK into the index (this guest fs reports utimes'd mtimes ~1 µs low — otherwise the zero-tolerance gate is flaky).
  - The old "forcesave-first" test (4 hook-based cases, incl. `error:session_open`) replaced by
    **"office_edit co-editor model: a live human session neither blocks nor gates; a stale revision is refused with a loud CONFLICT"**
    (~lines 294–340): Case A **INVERTED** — matching revision + open `live.setUser` session → edit SUCCEEDS; Case B — after an
    external save advanced the mtime, the same edit is REFUSED: `/^error:revision_mismatch /`, contains `CONFLICT`, contains
    the fresh mtime, names the open editor ("human editor (Ada)"), nothing written; Case C — same stale revision with no
    session → still refused, no human-editor note (the gate, not presence, is the safety mechanism); Case D — re-read (fresh
    base) → retry succeeds.
- `test/server.test.mts`:
  - `makeForcesaveHook` removed from imports; its unit test deleted (settleKept test in that section kept).
  - GET /state: payload keys asserted as `["container","docs","enabled","imageTag","locks"]` — no coEdit.
  - POST /settings test: seeds a LEGACY settings.json with `"coEdit": true` before any request (loads without crashing);
    new assertion block — `POST /settings {coEdit:true}` → 400 "no known setting…", and the follow-up GET /state payload
    contains no `coEdit`.
- `test/settings.test.mts`: expectations updated to the 2-field shape; NEW test "a LEGACY file carrying the removed
  'coEdit' key loads without crashing and simply ignores it" (load returns clean shape, and a save rewrites the file
  without the key); round-trip test now patches `imageTag` + a bogus key instead of coEdit.
- `test/integration.test.mts` (docker-gated, still must load/type): `setForcesaveHook` import removed; header item 3 and
  scenario rewritten — Scenario A: open session + matching revision → edit SUCCEEDS alongside it; Scenario B: an external
  co-editor save (`store.persistBytes`, the same path the DS callback persist takes) lands a newer revision after the agent
  read → refused `/^error:revision_mismatch /` with `CONFLICT`, human bytes stay on disk. Revisions pinned via utimes +
  index mirror for determinism (same fs µs drift as above).
- `test/container.test.mts`: fixture settings files no longer write a `coEdit` key.

## Verification (from /root/repos/pithagoras)

- `env -u NODE_ENV node --import tsx --test "extensions/office/test/*.test.mts"` → **138 tests: 135 pass / 0 fail /
  3 skipped** (the same 3 docker-gated integration skips; OFFICE_IT_DOCKER unset). Ran repeatedly (6+ runs) after the fs
  drift fix — stable.
- `npx tsc --noEmit -p extensions/office` → **No errors found** (strict).
- `node scripts/build-extensions.mjs` → exit 0; regenerated the gitignored `web/` + `server.js`.

## Grep proof — no coEdit / forcesave references remain for the removed mechanism

Scope: `extensions/office/{src,web (regenerated bundle),README.md,test}`.

```
$ grep -rn "coEdit|session_open|setForcesaveHook|makeForcesaveHook" src/web/ README.md test/  (excluding the 3 legacy-tolerance tests)
src/settings.ts:26   doc comment explaining LEGACY "coEdit" key tolerance (intentional; names the on-disk key)
(nothing else — zero hits in src/web/**, README.md, and all other src + tests)
```

Intentional remaining `"coEdit"` literals are ONLY the legacy-tolerance material itself:
- `src/settings.ts:25` (comment), `test/settings.test.mts:28/30/35/59-60`, `test/server.test.mts:486/524/529`.

Regenerated `web/` bundle: **zero** matches for `coEdit|session_open|setForcesaveHook|makeForcesaveHook`.

"forcesave" survives ONLY as the OnlyOffice DS wire protocol, which was never ours to remove (kept per "keep all of
live.ts / existing callback persist behavior"):
- `src/callback.ts:16/133/139/230(forcesavetype field)/361/363/383/413` — status-1 forcesave action + status-7 handling.
- `test/callback.test.mts:258/262/275/283/441/452` — tests of that same DS behavior.

"co-editing keys" (JWT pinning warning) strings in `src/web/settings.tsx:51,52,118`, `src/server.ts:452` and
`src/office-ui.ts:19` are the DS JWT-key concept, not the removed switch — kept (behavior + existing tests depend on it).

## Git state / hygiene

- No commit/push/checkout/stash/reset. 12 tracked files modified under `extensions/office/` (list via `git status`):
  README.md; src/{live,server,settings,tools}.ts; src/web/{api.ts,settings.tsx}; test/{container,integration,server,settings,tools}.test.mts.
- Untracked files (tasks/, PLAN-office-280.md, .office-contracts.md, .pi/, .reports/) untouched. No temp files created in
  the tree (one /tmp probe + /tmp logs, deleted). `web/` and `server.js` are gitignored build output, regenerated by the build.
