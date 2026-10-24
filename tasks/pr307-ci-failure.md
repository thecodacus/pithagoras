# PR #307 CI failure — `extensions/docs` rename-recovery test

**Task:** explain the single failing test of CI run 40036094127 on branch `office/280-pithagoras-office` (`fee666ce`):

```
not ok 366 - a rename that was cut off between its halves is finished only for the file it was decided for:
             a file with the two names that is another one is left as it is
location: extensions/docs/test/rename.test.mts (line 759)
error: 'neither name of the other file was taken away'   (deepStrictEqual; expected ['after.md','plan.md'], actual ['after.md'])
```

## Scope

- Branch `office/280-pithagoras-office` at `fee666ce`, base = local `main` = merge-base `138738f5` (branch is on current main; PR adds `extensions/office`, +8703 lines, and touches exactly one core test line — it **does not touch `extensions/docs` at all**).
- The failing file: `extensions/docs/test/rename.test.mts:740` (subtest), under test: `resume("rename")` / `#carryRename` in `extensions/docs/store.js`, descriptor handling in `core/server/src/workspace-files.ts`. Area introduced by `fc6d396c` ("Documents on portal.files: … descriptor-based file handling").
- CI model (GitHub Actions, job `server`, ubuntu-latest): one `node --test` invocation over all files; each test **file** runs in its own child process, and the 32 subtests of this file run **sequentially in one process**. "not ok 366" is the global TAP number across the whole suite, not a per-file index.

## Method

- Read the subtest (`rename.test.mts:740–771`) and the implementation it covers (`store.js` `recover()` at :501–510, `#carryRename` at :1086–1137, `sameId` at :91, `files.js removeDocument` :140–143, `workspace-files.ts removeFile` :1222).
- Reproduced on the branch and on a clean worktree of the merge-base (no PR code): 5 full-file runs each, plus an isolated-subtest loop (`--test-name-pattern`).
- Instrumented a scratch copy of the merge-base (`/tmp/pithagoras-trace`, removed after use; per-run logs kept in `/tmp/tr`) with stderr traces of every `recover()`, `#carryRename` entry (full `old`/`now`/pending stats), pending write, and step execution.
- Ran an inode-reuse micro-benchmark on this machine's ext4, and a 100-run full-file campaign **with concurrent file-system churn** (a filler process allocating/freeing files) so the allocator would hand the original inode back to the recreated file.

Reproduction tally (one full-file run = all 32 subtests):

| Setting | Runs | Result |
|---|---|---|
| Branch, quiet host | 5 | 0 failures |
| Merge-base worktree (no PR code), quiet host | 5 | **1 failure — this subtest, exactly CI's assertion** |
| Instrumented merge-base copy, quiet host | ~64 | 0 failures; the recreated file got `origIno − 11` every time (ext4 "inode goal" slot), so the bug branch never armed |
| Isolated subtest (`--test-name-pattern`), quiet host | 90 | 0 failures — without allocator luck the subtest cannot trigger |
| Instrumented merge-base copy, **with fs churn** | 100 | **21 failures of this subtest**, every one with proven inode reuse; plus 6 failures of a sibling deletion subtest (Finding 5); run 97's 18 failures are an infra artifact (the scratch tree was removed mid-run by something outside this investigation — `git: fatal: Unable to read current working directory`) |

Micro-benchmark (ext4, `/dev/mapper/pve-vm--122--disk--0`): create→unlink→create re-used the same inode in **~99%** of 3000 trials on a quiet host; churn varies which freed slot comes back — that is what arms the bug branch.

## Findings

1. 🔴 **The failure reproduces on `main` without any PR code — pre-existing, not PR-caused.** Full-file run on the merge-base worktree (`138738f5`, no `extensions/office`): failed exactly this subtest with exactly CI's assertion (expected `['after.md','plan.md']`, actual `['after.md']`, "neither name of the other file was taken away").

2. 🟡 **The only code path that can produce the observed disk state is `#carryRename`'s recovery branch at `extensions/docs/store.js:1108–1109`.** After the test recreates both names as a *new* hard-linked pair, the second portal's `GET /folders` → `Store.open`/`recover()` → `resume("rename")`. The branches of `#carryRename`:
   - :1107 `old?.isFile() && !now` — impossible (`after.md` exists);
   - :1108 `recovering && old.isFile && now.isFile && same ino && nlink > 1 && sameId(old, file)` → `removeDocument(dir, 'plan.md', { shared: true })` — **unlinks the name `plan.md`**. This is the *only* statement anywhere that can remove `plan.md` here (`takeIn` never unlinks; `sweepTemp` only matches `.name.hex.tmp` at `workspace-files.ts:1494`; delete-pending is not armed in this subtest; commit/gc act only in the store's own git dir under `DATA/<folderId>`). Trace run 7 shows exactly this branch's stat signature followed by the file gone (Finding 4).
   - :1112 otherwise → Refused "taken" → dropped, disk untouched (the designed behavior the test asserts).
   If :1108 fires, `#carryRename` then commits a rename revision and clears pending — leaving exactly `['after.md']`, i.e. **CI's exact observable state**.

3. 🔴 **Root cause (data-loss class): file identity is decided from `{ dev, ino }` alone, and inode numbers are reused after a file is deleted.**
   - The decision stores `file: idOf(was)` where `idOf = { dev: String, ino: String }` (`store.js:88`, captured at :1007/:1014) — no size, no mtime. `sameId` (:91) compares only those two strings. The window between capture and recovery spans the whole crash/stop gap plus **arbitrary activity by other actors**, so a *different* file made at either name can legitimately hold the same `{ dev, ino }`.
   - On ext4 this is not hypothetical: ~99% immediate reuse in the micro-benchmark; under churn it happened in 21 of 96 subtest attempts. The test's own recreation (`rename.test.mts:752–755`: unlink both names → `writeFileSync` new `plan.md` → `linkSync` to `after.md`) lands back on the original inode whenever the allocator hands it out; then :1108 sees "same dev+ino, nlink 2", mistakes the agent's file for the store's own half-finished rename, unlinks `plan.md`, and commits a bogus rename revision.
   - The design *knows* this danger: `workspace-files.ts`'s `linkOver` comment explicitly says "a folder swapped onto the name can have it (ext4 does)" and defends with a same-call re-stat + nlink check; `#carryRename`'s recovery branch has no equivalent defense because its reference stat is from the decision time, not milliseconds ago.
   - The other use of `sameId` (`store.js:1164`, `#carryDelete`) matches in the opposite branch direction — a match *authorizes* deletion — so inode reuse has the same harmful effect there (Finding 5).

4. 🔴 **Direct trace proof of the mechanism (churn-campaign run 7; runs 11 and 12 identical):**

   ```
   T-origIno ino=697244                              ← original plan.md's inode O
   setPending {op:rename, from:plan.md, to:after.md, file:{dev:64522,ino:697244}}   ← the decision
   T-recreated ino=697244 reused=true listing=[.keep, after.md, plan.md]            ← ext4 hands O back to the agent's new hard-linked pair
   carryRename recovering=true file{ino:697244} old{ino:697244,nlink:2} now{ino:697244,nlink:2} → stepRun
                                                                                        ← store.js:1108 conditions all true; the step is removeDocument(dir,'plan.md',{shared:true})
   T-afterGet listing=[.keep, after.md]              ← plan.md taken away; CI's exact state
   ```

   In every one of the 21 red runs `T-origIno == T-recreated` (inode reuse); in every green run they differ and `plan.md` survives. A counter-example run with different inodes behaved correctly — the file was left alone.

5. 🟡 **A sibling test fails through the same rule: `#carryDelete` (`store.js:1164–1183`).** Its guard is `if (there?.isFile() && !sameId(there, file)) { /* leave it */ } else { removeDocument(...) }`. When the file system re-assigns the decided inode to another actor's file at the name, `sameId` is true and recovery deletes that other file. Subtest `a deletion that is not known to have removed the file does not remove another file that is at the name, whatever it is called by then` (`rename.test.mts:866`) failed 6× in the churn campaign with `ENOENT … documents/plan.md` — its recreated file was taken away. Same root cause (dev+ino identity re-validated across a stop); the fix below covers both paths.

6. 🟢 **Why it looks like a rare flake:** whether the recreation re-gets the original inode depends on the file system's allocator state (ext4 allocates with an "inode goal" near the creating directory; free slots elsewhere in the group are taken first). On a quiet host the recreated file consistently got `origIno − 11`, so the branch never armed (0/64 + 0/90); under churn it armed in 21/96 attempts (~22%) — matching the 1/5 seen on the plain merge-base worktree. A shared CI runner is exactly the noisy allocator state. **The tests are deterministic in their *intent* but allocator-dependent in their power to catch the bug.**

## Verdict

**Not PR-caused. A pre-existing latent bug in `extensions/docs` rename/deletion recovery, surfaced as a flaky CI failure by inode reuse after a deleted file's number is re-allocated.**

- The PR could not cause it: it changes nothing in `extensions/docs` or the shared `core/server/src/workspace-files.ts`, and each test file runs in its own process (`node --test`) with per-run scratch dirs — there is no cross-file, cross-extension state. And the identical failure was reproduced on a worktree at the merge-base containing none of the PR's commits.
- Severity: 🟡 leaning 🔴 — the store can silently take away a name of a file that belongs to another actor (data loss), but the trigger needs an interrupted rename *or* deletion **and** both names being re-made by someone else on the same reused inode as a hard-linked pair; rare in practice.
- For PR #307: this failure is unrelated; a rerun is the right short-term action, and the underlying issue should be filed separately against `extensions/docs`.

### Suggested fix (store.js)

Treat "same file" as identity-plus-unchanged, not dev+ino alone:

1. Widen the decision's fingerprint: at `rename()`/`delete()` capture `{ dev, ino, size, mtimeNs }` (all present on the `statOf` result; `idOf` :88 already receives it) and store it as `file`.
2. Require *all four* to match at `#carryRename` :1108 **and** at `#carryDelete` :1164 (`sameId` extended accordingly). A real half-finished rename or delete left the file untouched (content/mtime unchanged), so recovery still completes; a reused-inode impostor has a fresh mtime (and usually a different size) and is left alone. Residual TOCTOU (an attacker rewriting exactly the original bytes + mtime) is out of scope for this layer, as with `linkOver`.
3. Optionally also compare `blobId(readBytes(from)) === row.blob` in :1108 before unlinking (the store already reads the text a few lines later) — content-identical impostors would still pass dev+ino+mtime on some fs clocks; this is the strongest practical check available by name.

### Suggested test hardening

- Keep `rename.test.mts:740` as is — it documents the intended behavior and *does* catch the bug when the allocator cooperates (which it did in CI).
- With fix (1) above the recreation in the test has a different size **and** mtime from the original, so both affected subtests become deterministic with respect to the fixed implementation regardless of inode allocation.
- Add one more subtest that cannot depend on allocation luck: drive `#carryRename` recovery against a stubbed `files` where `statOf`/identity says "same dev+ino" but `readBytes` returns different content, and assert the old name is kept (content check of fix 3). A matching deletion-recovery subtest should pin the same invariant for `#carryDelete`.

## Open questions

- The one open loose end: run 97 of the churn campaign lost its scratch tree mid-run to something outside this investigation (an external `/tmp` cleaner on this host — it also removed both working copies after the loop finished); that run's failures are infra artifacts and excluded above. If that cleaner recurs, future reproduction campaigns should keep code outside `/tmp`.
- Whether `overlayfs` upper-layer behavior on CI runners changes reuse odds vs plain ext4 (direction unclear; the CI failure proves a matching dev+ino with nlink 2 occurred there).
