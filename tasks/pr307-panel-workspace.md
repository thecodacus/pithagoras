# PR #307 follow-up — Office panel: shared workspace docs, compact create, sort by workspace

Branch `office/280-pithagoras-office`, base tip before this work: f6788220. All changes confined to `extensions/office/**` (+ this untracked findings file).

## What changed

### 1. Unowned docs are shared (panel + every home's tool scope)
- `src/store.ts` — `docsForHome(homeChatId)`: condition is now
  `doc.owner === null || doc.owner === homeChatId || doc.grants.some((g) => g.chatId === homeChatId)`.
  JSDoc rewritten (unowned = workspace-scanned / human docs, visible to all homes; owned/granted unchanged).
  (Also moved the JSDoc that had become orphaned above `addGrant` back onto `docsForHome`, where it belongs.)
- `src/client.tsx` — `OfficePanel` filter uses the same condition, so `/root/repos/pithagoras/.../fixtures/sample.docx`
  (already indexed at boot with `owner: null`) now shows in every chat's sidebar panel. Empty-state text no longer
  contradicts ("the workspace .docx and .xlsx files, human-made docs, and the ones this chat owns or was granted…").
- `src/tools.ts` — module comment updated: the tool scope is `docsForHome(home)`, which includes every UNOWNED doc;
  behavior follows from the store change, no per-tool code change needed.

### 2. Compact create affordance in the panel
- `src/client.tsx` — new `PanelNewDocument()` at the top of the panel: title input + word/sheet icon kind toggle
  (LuFileText/LuTable with `aria-pressed`) + Add button → same `api.createDocument({title, type})` as the page's
  `NewDocument`, no owner passed (unowned semantics kept), then `refreshOfficeState()` so the doc appears
  immediately; errors via `portal.ui.ErrorBanner` like everywhere else.
- `style.css` — slim sidebar chrome: `.po-newcompact` (one dashed row, wrapping) + `.po-kind` / `.po-kind-btn` /
  `.po-kind-on` icon toggle using the portal theme vars.

### 3. Sort by workspace
- `src/store.ts` — `DocMeta.workspace?: string`. `scanWorkspace` stamps it: FIRST path segment under whichever scan
  root contains the file, **deepest matching root wins** (nested roots label more specifically than their parents);
  a file straight in a root takes that root's OWN dir name (home-root file → home dir name; its own file name would
  be noise). Stamped at index time via `indexOne(real, rootDir, workspace)` and BACKFILLED on every rescan for
  pre-existing index entries (a backfill counts as a refresh exactly once, then idempotent). Library-created docs
  (`createDoc`) stay undefined — legal, UI shows "library". `/state` already hands back DocMeta verbatim, so no
  server route change.
- `src/web/api.ts` — `OfficeDoc.workspace?: string`.
- **new** `src/web/sort.tsx` — the sort machinery moved OUT of library.tsx and shared by page + panel:
  `SortKey = "name" | "modified" | "size" | "type" | "workspace"` (+ `SortChoice`), `loadSort`/`saveSort` under the
  SAME `"po-sort"` localStorage key (pattern unchanged; one added valid value), `workspaceLabel(doc)` →
  `doc.workspace ?? t("library")`, `compareDocs(a, b, key, dir)` with `dir` applied INSIDE so "workspace" keeps its
  undefineds LAST regardless of direction, and the `SortBar` component (now with a Workspace option) used by both.
- `src/web/library.tsx` — local sort defs/SortBar deleted in favor of the shared module; DocRow meta line now shows
  `title.ext · when · workspaceLabel(doc)` so the label ("library" for undefined) is visible on the full page.
- `src/client.tsx` — `OfficePanel` holds `[sort, setSort] = useState(loadSort)`, persists via `saveSort`, and sorts
  the filtered list with `compareDocs(a, b, sort.key, sort.dir)`; renders the shared `<SortBar>` above the rows.
  Panel and full page therefore share one persisted choice.

### 4. Copy audit
Grepped `src/web/*.tsx src/client.tsx` for user-facing "import" mentions from the removed import flow (the old
panel Empty text's "import an existing one"): the old Empty string is rewritten (above); two survivors fixed in
place — `settings.tsx` exposure line ("…import and export are copies" → workspace files indexed in place, download/
export are copies) and the settings search-words list ("import" dropped, workspace/scan/rescan added). No other
user-facing import mentions remain.

## Tests
New in `test/store.test.mts` (+3):
1. `docsForHome: UNOWNED docs (workspace-scanned and human-made) are visible to EVERY home` — scanned + human doc
   seen by every home; another home's owned doc stays private.
2. `scanWorkspace stamps DocMeta.workspace: first path segment under the DEEPEST scan root…` — nested roots,
   direct-child-of-root → root dir name, home-root file → home dir name, nested file → first segment.
3. `scanWorkspace rescan BACKFILLS DocMeta.workspace on entries indexed before the stamp` — old index entry picked
   up its label on rescan, counted as refreshed once, idempotent after.

Suite: `env -u NODE_ENV node --import tsx --test "extensions/office/test/*.test.mts"` → **146 total / 143 pass /
0 fail / 3 docker-gated skips** (baseline was 143/140/3; +3 new tests), green three consecutive runs.
`npx tsc --noEmit -p extensions/office` exit 0. `node scripts/build-extensions.mjs` exit 0 (gitignored build
outputs refreshed — portal reload is the user's to trigger).

## Notes / judgment calls
- Deepest-root-wins + root-basename-for-direct-files: both example cases in the brief ("pithagoras" under a
  `/root/repos` root; home-root file → home dir name) fall out of this single rule. Documented on `DocMeta.workspace`.
- Workspace label is displayed on the full-page row meta (`· library` for undefined); the panel row layout was kept
  as-is per the brief (label still participates in sorting there).
