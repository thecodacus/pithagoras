# PR #307 review — slice: OOXML + sync zip codec correctness

PR: "Office documents in the portal: OnlyOffice Document Server extension" (branch `office/280-pithagoras-office` @ fee666ce, base main).
Slice scope: `extensions/office/src/ooxml.ts`, `scripts/make-fixtures.mjs`, `fixtures/sample.{docx,xlsx}`, `test/ooxml.test.mts`, `test/fixtures.test.mts`.

## Scope

1. Sync zip reader/writer over `node:zlib`: stored vs deflated entries, CRC32, LFH + central directory + EOCD scan, endianness, name edge cases (UTF-8 flag bit 11, leading slash, case), zip64 handling, truncation/corruption, bad-CRC behavior, zip-bomb bounds.
2. OOXML primitives: docx/xlsx parsing, quote-based `editDocx`, sharedStrings vs inline strings, XML escaping, entity decoding, namespace/structure robustness.
3. Robustness of untrusted input and memory bounds; downstream trust assumptions (parts served to OnlyOffice DS / browser).
4. Reuse audit: existing zip/OOXML utilities in the repo; validity of the "jszip is async-only" claim.
5. Fixture determinism of `make-fixtures.mjs`.

## Method

- Read `src/ooxml.ts` (512 lines) in full, plus `scripts/make-fixtures.mjs`, `test/ooxml.test.mts`, `test/fixtures.test.mts`; grepped `core/` and `extensions/` for existing `zlib`/zip utilities; checked `package.json`/`deps.js` for the jszip claim.
- Empirical scratch (under `/tmp`, deleted before finishing): round-tripped both committed fixtures through the codec's `rewriteZip` and validated with python `zipfile.testzip()` (strict CRC + structure check); built zips with python (`ZIP_STORED` entries, leading-slash names) and read them with the codec; corrupted a stored-entry byte (bad CRC) and a deflate stream byte; hand-crafted sentinel zip64 EOCDs, truncated buffers, and a hostile central directory advertising a 300 MiB entry; built non-ASCII/emoji entry names; ran crafted docx bodies with nested `w:p` in `wps:txbxContent` and body-level `mc:AlternateContent`; measured heap/CPU of `parseXlsx` on a ~1.7 KB xlsx whose cells reference row 20000 × column 500 per sheet (3 sheets).
- Ran the repo's own suite for this slice: `node --import tsx --test extensions/office/test/ooxml.test.mts extensions/office/test/fixtures.test.mts` → **17/17 pass**.

## Findings

### 🔴 [blocking] Dense-grid allocation in `parseXlsx` scales with cell *coordinates*, not file size — a ~1.7 KB upload can allocate > 500 MB and burn ~18 s of CPU (multiple GB possible)

- **Where:** `extensions/office/src/ooxml.ts:437-438` (`MAX_GRID_ROWS = 20000`, `MAX_GRID_COLS = 500`) and the dense fill at `src/ooxml.ts:461-470`; per-sheet loop `src/ooxml.ts:419-432` (no bound on sheet count); caller `extensions/office/src/tools.ts:296` (`office_read`, user/agent-triggered).
- **Why it matters:** The caps bound each *axis* per sheet, but the materialized grid is the **product** `maxRow × maxCol` of the farthest *kept* coordinates. A worksheet containing just two cells — one at column 500 and one at row 20000 — forces a 20000×500 = 10 M-cell array (~80-170 MB) per sheet, and there is no cap on the number of sheets. Measured: a **1671-byte** xlsx (3 tiny sheets) consumed **+523 MB heap and ~18 s CPU** in `parseXlsx`. 50 such sheets fit comfortably under any import size limit (`store.ts:6-7` explicitly states >1 MB Office files are allowed and there is no per-file parse guard) and would push several GB — an OOM of the shared portal process from one legitimate `office_read` call (and it is reachable from project-chat agents, i.e. by more principals than just the file owner).
- **Fix:** Bound the *materialized* work, not just the axes: pass a total-cell budget across all sheets (e.g. 100k cells) into `parseSheet`, stop densifying past it and report the sheet as truncated in `truncatedSheets` (the plumbing for this flag already exists). Alternatively keep rows sparse (`Map<number,string[]>`) and materialize only up to the `MAX_READ_CHARS` output budget at `tools.ts:297`. A per-sheet product cap (`maxRow * maxCol > N → truncation, early out before allocating`) is the minimal change.

### 🟡 [important] No CRC-32 validation on read — corrupt archives parse silently and get re-persisted with their original (wrong) CRC

- **Where:** `extensions/office/src/ooxml.ts:108-111` (`readEntryData`): stored data is returned as-is, deflated data only gets a *length* check after inflate; `e.crc` is read from the central directory (`src/ooxml.ts:67`) and never compared.
- **Why it matters:** Verified empirically: flipping one byte in a stored entry's payload makes `parseDocx` return success with garbage content, and a corrupted deflate stream can still inflate to exactly the advertised length (both produced no error). This contradicts the module's fail-loud posture (`bad deflate data`, `size mismatch`, truncated payloads all throw `invalid_zip`) — the one corruption class that is most common in the wild (bit rot, partial writes) slips through. Worse, `rewriteZip` then re-embeds the corrupt bytes with their original CRC, so the portal will keep "editing" a file that Word/DS report as corrupted, masking the root cause until it is much harder to diagnose.
- **Fix:** one line per entry in `readEntryData`: `if (crc32(out) !== e.crc) throw ooxmlError(\`CRC mismatch for ${e.name}\`, "invalid_zip");` — cheap (`out` is already fully materialized), makes import/parse reject damaged files loudly.

### 🟡 [important] Nested `w:p` (text boxes, `mc:AlternateContent`) corrupts extraction and mis-targets quote edits; the doc comment describes different behavior than what happens

- **Where:** `extensions/office/src/ooxml.ts:241-250` (`findParagraphs`, non-greedy `/<w:p(?:\s[^>]*?)?(?:\/>|>([\s\S]*?)<\/w:p>)/g`) with the same shape used by `applyEdit` at `src/ooxml.ts:316+`.
- **Why it matters (verified empirically on a crafted docx):** an outer `<w:p>` containing a drawing whose `wps:txbxContent` holds its own `<w:p>` truncates the outer paragraph at the *first inner* `</w:p>`. Consequences observed:
  - runs after the textbox close in the same paragraph **vanish from extracted text** (`"AFTER"` absent; paragraph came out as `"BEFOREIN-BOX"` — box text glued to host text with no separator);
  - `editDocx` then answers `quote_not_found` for that visible-but-dropped text, while quoting the *box* text succeeds and splices the replacement into the host paragraph's virtual text — an agent edit can silently intermix body and shape text;
  - body-level `mc:AlternateContent` (Word's standard fallback duplication) emits **both** Choice and Fallback paragraphs, so duplicated legacy text appears twice in `parseDocx` output and will trigger spurious `quote_ambiguous` on edits.
  Text boxes and AlternateContent fallbacks are routine in real Word files (stamps, shapes, ink/SmartArt). The doc comment at `src/ooxml.ts:241-242` ("such content would be read as the outer paragraph's trailing run") does not describe actual behavior — trailing runs are dropped, and box text is *included*.
- **Fix:** make `findParagraphs` nesting-aware: when a match encounters `<w:drawing>`/`wps:txbxContent` (or an inner `<w:p`) inside the paragraph content, either skip to the corresponding close tag before continuing the outer paragraph's scan, or detect nested paragraphs and throw a specific code (e.g. `nested_paragraph_unsupported`) so callers fail loudly instead of returning wrong text. At minimum, correct the doc comment and add a regression test; also decide explicitly how `mc:AlternateContent` Fallback content should be treated (skip `<mc:Fallback>` regions when `<mc:Choice>` is present).

### 🟢 [nit] "Deterministic" fixture output is not — committed fixtures embed wall-clock timestamps, so regenerating churns the binaries

- **Where:** `extensions/office/src/ooxml.ts:138` (`writeZip` stamps `dosDateTime(new Date())` when an entry has no explicit `time`); `scripts/make-fixtures.mjs:9` and `test/fixtures.test.mts:10` both claim "deterministic output"; committed `fixtures/sample.docx`/`sample.xlsx` carry the generation time `(2026, 10, 23, 19, 49, 8)` on every entry.
- **Why it matters:** re-running the documented regeneration command produces different bytes → git churn / accidental conflicts; the determinism claim (load-bearing for "fixtures double as round-trip material") is false as written.
- **Fix:** pass a fixed `time` in `make-fixtures.mjs` — `writeZip` already accepts explicit timestamps, so pin e.g. DOS epoch (`{ time: 0, date: 0x0021 }`) per entry and regenerate once.

### 🟢 [nit] `rewriteZip` change keys that miss existing names only by case silently create shadow duplicate parts

- **Where:** `extensions/office/src/ooxml.ts:196-208` (`rewriteZip` adds any unapplied `changes` key as a new entry; matching is exact-string, zip names are case-sensitive here, consistent with jszip).
- **Why it matters (verified):** rewriting `{ "WORD/DOCUMENT.XML": ... }` over an archive containing `word/document.xml` yields a zip with *both* parts; Word/DS treat OOXML part names with filesystem-ish case tolerance in several code paths, so a shadowed part can win or confuse the engine. Current callers build keys from exact parsed names so risk is low (speculative impact).
- **Fix:** cheap guard — reject `changes` keys that differ from an existing entry name only in case (`invalid_zip`/specific error), or log/warn; and keep a test documenting the exact-match contract.

### 💡 [suggestion] Reuse audit: the sync codec is justified, but two zip implementations now have to agree by hand

- Verified the claim: jszip (v3.10.1, `extensions/office/package.json`) exposes only Promise-based `loadAsync`/`generateAsync` — no synchronous API exists, so a sync reader/writer for the inline ping/tool paths is necessary. No existing zip utility in the repo (`core/server/src/compressed-file.ts` is gzip/brotli of web assets, unrelated). The codec therefore does not reinvent anything available; keep it.
- Suggestion: `store.ts:17` and `tools.ts:40` use jszip (templates) while runtime read/rewrite goes through this codec, and behaviors are already being deliberately aligned (`src/ooxml.ts:194`: "duplicate names: last one wins (jszip behavior)"). The cross-validation tests (ooxml.test.mts vs jszip, fixtures.test.mts) are good; consider extending them into a small property suite run in CI (random entry names/sizes through both writers, read by both + python) so future divergence on either side is caught.

### 📚 [learning] Zip-bomb and format-robustness checks all hold up empirically

- Bounds are size-based, not ratio-based, and checked against **advertised** sizes before any inflate: per-entry 256 MiB (`src/ooxml.ts:90`, enforced at `103`) plus a 1 GiB archive total summed in the CD loop *before* payloads are read (`src/ooxml.ts:66-69`). A hostile central directory advertising a 300 MiB deflated entry was rejected in **0.14 ms with ~zero allocation**.
- Endianness/CRC of the writer: python `zipfile.testzip()` passes on both fixtures and on stored/deflate round-trips (CRCs exact, little-endian fields correct); UTF-8 flag bit 11 is set exactly for non-ASCII names (verified with emoji + Scandinavian entry names).
- Data-descriptor archives work (CD sizes are authoritative, `src/ooxml.ts:98` comment), zip64 sentinels rejected (`src/ooxml.ts:53`, `70`), truncation/corruption/non-zip all throw `invalid_zip`, EOCD scan window is spec-correct (22+65535).
- Trust assumption: untouched parts are preserved byte-for-byte and served to DS/browser as-is — identical trust posture to opening any uploaded docx in Word; the extension adds no new attack surface of its own, and the regex-based parser has *no* entity-expansion or DTD attack surface (structurally safer than a full XML parser). Zip names are only map keys — no path traversal. Untrusted content is worth a line in the README rather than code: imported malicious OOXML parts behave exactly as they would in a local word processor.

## What's good

- **Empirical interop is clean:** both committed fixtures round-trip through `rewriteZip` and validate under python `zipfile.testzip()`; python-built zips (stored entries, leading-slash names) read back correctly; stored+deflate content survives byte-identical.
- **`editDocx` semantics are carefully engineered:** unique-quote contract with `quote_not_found`/`quote_ambiguous`, sequential ops seeing prior results, cross-run spans handled exactly (verified `"lpha be"` → `"Amiddleta"`), quotes covering only paragraph breaks rejected (`src/ooxml.ts:352-353`), `xml:space="preserve"` added precisely for leading/trailing spaces, and replacements escaped via `escapeXmlText` so `&`/`<`/`>` (and even entity-looking text) round-trip literally. A replacement containing XML special characters cannot inject tags — verified with the `"Delta & nine"` test path.
- **Dense-grid truncation reporting already exists** (`truncatedSheets`) — the 🔴 fix slots into existing plumbing rather than a new error surface.
- **Tests cross-validate across three implementations** (own codec, jszip, python via fixtures) and include a hand-crafted hostile central directory for the archive cap; 17/17 pass under `node --import tsx --test`.
- The honest "accepted deviation" documentation around non-byte-identical recompression (module header + `rewriteZip` doc) is exactly right.

## Open questions

1. Should import (`store.importFile`) hard-reject CRC-corrupt archives once the 🟡 CRC fix lands — or accept-and-warn? Currently xlsx imports never run `parseXlsx`, so corruption is only discovered lazily at first read/edit.
2. Even after bounding the grid (🔴), is a *wall-clock* guard warranted for `office_read` on very large but legitimate workbooks (16k rows × wide)? The 20000×500 axis caps truncate far-out cells per sheet (they already surface a truncation note to the agent via `tools.ts:303-304`) — acceptable for v1, but values beyond the cap are absent from the grid while still visible in the real file; is that enough honesty for quote-based edits against such sheets?
3. For M4 (xlsx comments via `xl/commentsN.xml` + VML): will the same regex approach be reused — if so, the nested-paragraph fix pattern from the 🟡 finding may matter there too (VML anchoring overlaps cell ranges).

---
*Review environment: node v22.23.2; all scratch confined to /tmp and removed after review.*
