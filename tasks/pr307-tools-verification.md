# PR #307 review slice — agent tools + verification runs

Branch `office/280-pithagoras-office` @ `fee666ce`, reviewed 2026-01 (see dates in repo). Slice: PART A = the five agent tools in `extensions/office/src/tools.ts` and their dependencies (`ooxml.ts`, `store.ts`, `ping.ts`, `live.ts`, `callback.ts` lock model); PART B = test / typecheck / build / docker runs.

## Scope
- `extensions/office/src/tools.ts` (446 lines, read in full): `office_list`, `office_create`, `office_read`, `office_edit`, `office_comments`, plus the mention-wake drain (`hearOfficePings`).
- Deps actually exercised by those tools: `ooxml.ts` quote-edit engine, `store.ts` (docsForHome/createDoc/persistBytes/getDoc), `ping.ts` (mention grammar, grant persistence, wake queue), `live.ts` (presence/lock model).
- Test corpus `extensions/office/test/*.test.mts` for coverage assessment.

## Method
- Static read of all listed files; traced gate ordering in `office_edit`, the quote-matching virtual-text algorithm, and the mention regex/grant path end to end.
- Empirical probes via a throwaway `/tmp/office-scratch.mts` (imported the real `editDocx`/`writeZip`; deleted after use — no leftovers): cross-paragraph quote result re-extraction, and 9 mention-regex samples (`@agent`, `@Agent`, `@AGENT`, email, `a@b`, `.@x`, `@project:Finance Team`, `cc @billing.`, Cyrillic `@аgent`).
- Ran the full prescribed PART B verification in `/root/repos/pithagoras`; exact outputs captured below.

## Findings

### 🔴 blocking
None found in this slice.

### 🟡 important

1. **Mention grants are permanent and there is no revocation path — an incidental mention permanently opens read+edit of a document to another agent home.**
   `extensions/office/src/ping.ts:168` (`grants.push({ chatId, commentId, at })`) persists the grant with only an `at` timestamp; expiry is explicitly deferred. `store.docsForHome` (via `doc.owner === homeChatId || doc.grants.some(...)`, `extensions/office/src/store.ts:204-213`) then makes the granted home see the doc in `office_list`, read it fully, AND edit it with `office_edit` — forever. But the wake text says `"You have edit access to this document for this task"` (`ping.ts:71-79`, `officeWakeMessage`) — "for this task", which the persistence does not honor. Worse, any comment that merely *mentions* a matching folder name ("we talked about this with @billing last sprint") grants permanent access even when no task is being requested; there is no revoke tool (owner can see grants via `office_comments` but cannot remove them).
   **Why it matters:** grant semantics silently outlive the interaction; over time each doc accumulates standing co-editors across agent homes based on casual text. Deferred decision, so discuss rather than block — but "permanent" contradicts the message handed to the woken agent and is worth a product call before merge.
   **Fix:** at minimum (a) change the wake wording to state access is standing until revoked, or (b) keep the deferral explicit in README *and* add an `office_revoke`/owner-side grant removal so permanence is controllable. Longer term: implement per-comment grant expiry (already on the deferred list).

2. **`office_comments` output is uncapped — inconsistent with `office_read`'s deliberate context guards.**
   `extensions/office/src/tools.ts:418-423`: comment bodies are embedded in full into the tool text and also passed whole in `details` (which lands in the portal tool-event store and transcript). `office_read` goes to obvious lengths to bound this (`MAX_READ_CHARS = 200_000` at `tools.ts:293/304/314`, comments capped to 100×500 chars with `commentCount` kept, `tools.ts:317`). A docx with many or long comments (Word allows thousands of comment words each) will blow the agent's context through `office_comments` with no truncation marker at all.
   **Fix:** reuse the same caps for `office_comments` — e.g. truncate per-comment text to 500 chars in the listing, cap at 100 comments, and report `commentCount`.

### 🟢 nit / 💡 suggestion

3. **🟢 A quote spanning a paragraph break leaves a stray line break inside the replaced region (verified empirically).**
   `extensions/office/src/ooxml.ts:315-367` (`applyEdit`): the virtual text joins paragraphs with `"\n"` that has "no XML behind it", so when an op's quote crosses a paragraph boundary, the join survives the rewrite. Verified with the real code: quoting `"end.\nSecond"` and replacing with `"combined"` in two paragraphs extracts afterward as `"First line combined\n line start here."` — i.e. the agent's replacement is split by a newline it didn't ask for, and a quote that fully consumes a paragraph leaves an empty `w:p` (blank line). Exact-substring semantics on extracted text don't round-trip to exact-substring result. Fails loudly? No — this silently produces slightly-off text, which then makes the agent's *next* quote harder (it must re-read and account for the stray break).
   **Fix:** either document in the `office_edit` description ("quotes crossing paragraph breaks keep the line break") or have `applyEdit` drop now-empty `w:p` elements / coalesce when a quote consumed an entire paragraph's runs.

4. **🟢 `@Agent` does not mean "the owner" — case variants of `@agent` silently reroute to folder-name matching (verified).**
   `extensions/office/src/ping.ts:112`: the `agent(?![\w-])` alternative is case-sensitive (no `/i`), so `@Agent` / `@AGENT` fall through to the bare-name group. Verified: `@Agent -> ["Agent"]`, resolved by `resolveMention` *case-insensitively against folder display names* (`ping.ts:180-196`). If a folder is named "Agent" (plausible), a human typing `@Agent` intending the doc's owner wakes that other home instead — and gets it a permanent grant (see finding 1). Unicode lookalikes fail safely (`@аgent` → no match, verified). Emails in realistic spelling are safe (`user@example.com`: the `(?<![\w.])` lookbehind blocks the `@` preceded by a word char — verified `a@b`, `.@x`, `user@…` all no-match).
   **Fix:** lowercase the owner check too (treat `@agent` case-insensitively as the owner token), or document that only lowercase `@agent` addresses the owner.

5. **🟢 Non-ASCII folder names can never be mentioned.**
   `extensions/office/src/ping.ts:112`: bare names are `[A-Za-z0-9_][\w-]*`, so an agent/project named e.g. "Übersicht" or "café" is unreachable by mention (unresolvable → logged, no wake). Documented-ish ("names are non-whitespace runs, spaces excluded") but the ASCII restriction isn't called out in the module comment. **Fix:** note it as a v1 limitation next to the spaces one; optionally widen to Unicode word chars.

6. **💡 `office_edit` has no size bound on ops.**
   `extensions/office/src/tools.ts:350-357` validates shape but not count or replacement length. Realistically bounded by LLM output, and read-backs are capped — so low risk — but a cap (e.g. ≤ 100 ops, total replacement ≤ N KB) would keep the written `word/document.xml` predictable.

7. **🟢 forcesave gate keys on presence only (`usersOf`), not the explicit lock flag (speculative).**
   `extensions/office/src/tools.ts:371`: `if (loadSettings(...).coEdit && usersOf(doc.docId).length > 0)`. Per the live.ts lock model (`live.ts:16-20`, callback statuses set both presence and an explicit flag), a residual explicit-lock-with-no-presence state (e.g. after a portal restart, or leave-handling edge) would let `office_edit` skip forcesave entirely. Silent clobbering is still impossible — the strict mtime gate in `persistBytes` (`store.ts:440-448`, `st.mtimeMs !== doc.mtimeMs`) makes the human's next save fail loudly — but the *forcesave-first* promise is weaker than it reads under that edge. Low confidence this state occurs often; flagged for awareness.

### 📚 learning / 🎉
- The refusal convention is well executed: every failure path routes through `failed()` (`tools.ts:148-162`) into `error:<code> <message>` with *actionable* text — `revision_mismatch` carries the fresh mtime and the re-read instruction twice (gate path at `tools.ts:363` and store path via `currentMtimeMs` injection in `failed()`); `quote_not_found`/`quote_ambiguous`, `session_open` (both flavors: no hook / hook returned non-true, `tools.ts:372-374`), `not_found` for out-of-scope ids are indistinguishable from nonexistent ones (no enumeration leak, `visibleDoc` `tools.ts:219-225`). The suite even pins the contract (`tools.test.mts:382` "every refusal the agent reads starts with error:<code> ").
- Stale-revision guarantee is genuinely layered: gate-first at `tools.ts:365`, re-gate after forcesave at `tools.ts:377`, strict zero-tolerance re-stat in `persistBytes`. Note the agent-side gates use `Math.abs(meta.mtimeMs - base) > 1` (±1 ms, both directions) while `persistBytes` is exact — the final strict gate closes any drift, so "nobody clobbers a newer revision" holds.
- 💡 The "no document with that id" refusal for out-of-scope docs is a deliberate docs-convention choice (`tools.ts:219-224`); fine, just noting an agent guessing ids can't distinguish "doesn't exist" from "not yours" by design.

## Verification results (PART B, all in /root/repos/pithagoras)

1. **Unit tests:** `env -u NODE_ENV node --import tsx --test "extensions/office/test/*.test.mts"` →
   ```
   # tests 123
   # pass 120
   # fail 0
   # cancelled 0
   # skipped 3
   # duration_ms 3577.896591
   ```
   **Discrepancy vs PR body:** the PR claims "120 tests / 117 pass / 3 skip". Reality is **123 total / 120 pass / 3 skip / 0 fail** (off by exactly +3 passing tests — consistent with head commit `fee666ce "fix(office): baseline imported comments at import time"` adding tests). The PR body's verification numbers are stale; zero failures confirmed.

2. **TypeScript:** repo root has **no tsconfig.json** (`npx tsc --noEmit -p .` → `error TS5057: Cannot find a tsconfig.json file at the specified directory: '.'`). As instructed, tried the extension project: `npx tsc --noEmit -p extensions/office` → **`TypeScript: No errors found`, exit 0** (strict mode, `include: ["src"]`). Clean as claimed — with the caveat that test files are not covered by any tsconfig include.

3. **Build:** `node scripts/build-extensions.mjs` → for the relevant line:
   ```
   pithagoras-office: built web/ and server.js
   ```
   (all six other extensions also built, exit 0). Build artifacts land in the repo tree (`extensions/office/web/*`, `extensions/office/server.js`) but are **gitignored** — `git check-ignore` confirms both paths. Post-build `git status --short`: only the four pre-existing untracked items from checkout time (`.office-contracts.md`, `.pi/`, `.reports/`, `PLAN-office-280.md`, plus this review's `tasks/`) — **no tracked-file pollution**.

4. **Docker:** `docker info` → daemon present and answering. `docker images --format '{{.Repository}}' | grep -i onlyoffice` → **no DS image locally**, so per instructions no pull was attempted; the 3 docker-gated integration tests remain skipped. Their exact names (from `test/integration.test.mts`, gate at lines 55-60, requires `OFFICE_IT_DOCKER=1` + operator-started container):
   - "ticketed GET on the real loopback listener serves a >1 MB document byte-for-byte and rejects an expired ticket"
   - "synthetic status-2 callback WITHOUT any session cookie: persist happened (bytes changed, index bumped, history zip written) and the lock cleared"
   - "office_edit with a live session: the forcesave hook is AWAITED before the edit persists; a revision bump during the hook surfaces as revision_mismatch"

## Coverage gaps
- **Quote editing across paragraphs** (stray-break behavior of finding 3), the "covers no text runs (paragraph breaks only)" branch (`ooxml.ts:365`), and literal CRLF inside `w:t` content are untested — `test/ooxml.test.mts` covers single-run, multi-run, sequential-ops, ambiguous/not-found only.
- **`office_read` truncation paths** (200k text cap, 100×500 detail cap) and the xlsx `truncatedSheets` notice: no test drives a >200k doc or an out-of-grid worksheet through the *tool* surface.
- **`office_comments`**: only the happy path is tested (`tools.test.mts:350`) — its unbounded output (finding 2) is therefore unpinned.
- **Mention grammar edges** (case variants, Unicode names/lookalikes, punctuation-heavy `@project:` targets): `test/ping.test.mts` covers case-insensitivity, unmatched, ambiguous, dedupe, baselines — not the ASCII-only/case-sensitive-literal corners above.
- The 3 docker-gated ITs above remain unverified here (no OnlyOffice image; not pulled). Notably IT #3 (forcesave ordering) has a unit twin (`tools.test.mts:294`) so coverage exists, just not against a real DS loopback.

## Open questions
- Should the PR body's verification numbers be updated to 123/120 before merge, or was "120 tests" meant as "120 pass" (in which case only "117 pass" is wrong)?
- Finding 1: is permanent grant semantics an accepted v1 deferral (it's on the README deferred list) — but should the wake message at least stop promising "for this task"?
- Does any root-level CI typecheck/build gate exist for the repo that this extension expects? (`tsc -p .` has nothing to check at root.)
