import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDiff, unquote } from '../src/git-diff.ts';

test('a file diff is read into numbered lines: removed ones by where they were, added ones by where they are', () => {
  const [file] = parseDiff(
    'diff --git a/src/a.ts b/src/a.ts\nindex 1..2 100644\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -3,4 +3,5 @@ function f() {\n keep\n-old line\n+new line\n+another\n same\n\\ No newline at end of file\n',
  );
  assert.equal(file.path, 'src/a.ts');
  assert.equal(file.status, 'modified');
  assert.deepEqual([file.added, file.removed], [2, 1]);
  assert.deepEqual(
    file.rows.map((r) => [r.kind, r.old, r.new, r.text]),
    [
      ['hunk', undefined, undefined, '@@ -3,4 +3,5 @@ function f() {'],
      ['ctx', 3, 3, 'keep'],
      ['del', 4, undefined, 'old line'],
      ['add', undefined, 4, 'new line'],
      ['add', undefined, 5, 'another'],
      ['ctx', 5, 6, 'same'],
      ['note', undefined, undefined, 'No newline at end of file'],
    ],
  );
});

test("a pull request's diff is split into its files: new, deleted, renamed, binary", () => {
  const files = parseDiff(
    [
      'diff --git a/new.md b/new.md',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/new.md',
      '@@ -0,0 +1 @@',
      '+hello',
      'diff --git a/gone.txt b/gone.txt',
      'deleted file mode 100644',
      '--- a/gone.txt',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-bye',
      'diff --git a/old name.txt b/new name.txt',
      'similarity index 90%',
      'rename from old name.txt',
      'rename to new name.txt',
      'diff --git a/logo.png b/logo.png',
      'Binary files a/logo.png and b/logo.png differ',
      '',
    ].join('\n'),
  );
  assert.deepEqual(
    files.map((f) => [f.path, f.status, f.from, f.binary, f.added, f.removed]),
    [
      ['new.md', 'added', undefined, false, 1, 0],
      ['gone.txt', 'deleted', undefined, false, 0, 1],
      ['new name.txt', 'renamed', 'old name.txt', false, 0, 0],
      ['logo.png', 'modified', undefined, true, 0, 0],
    ],
  );
  // A line that starts like a header, inside a hunk, is a line of the file.
  const [odd] = parseDiff('diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n--- a/looks like a header\n+++ b/so does this\n');
  assert.deepEqual(odd.rows.slice(1).map((r) => [r.kind, r.text]), [['del', '-- a/looks like a header'], ['add', '++ b/so does this']]);
  assert.equal(odd.path, 'x');
});

test('a name git put in quotes is read back as it is', () => {
  assert.equal(unquote('"tab\\there.txt"'), 'tab\there.txt');
  assert.equal(unquote('"\\303\\244rger.txt"'), 'ärger.txt');
  assert.equal(unquote('plain.txt'), 'plain.txt');
  const [file] = parseDiff('diff --git "a/we\\"ird" "b/we\\"ird"\n--- "a/we\\"ird"\n+++ "b/we\\"ird"\n@@ -1 +1 @@\n-a\n+b\n');
  assert.equal(file.path, 'we"ird');
});

test("a file in conflict, as git shows it — a column per parent — is read column by column", () => {
  // `git diff` of a conflicted a.txt, verbatim: ours added "TWO main" and
  // "four", theirs "TWO side", and git's markers are new against both.
  const [file] = parseDiff(
    'diff --cc a.txt\nindex 2d33e85,2339517..0000000\n--- a/a.txt\n+++ b/a.txt\n@@@ -1,4 -1,3 +1,8 @@@\n  one\n++<<<<<<< HEAD\n +TWO main\n++=======\n+ TWO side\n++>>>>>>> side\n  three\n +four\n',
  );
  assert.equal(file.path, 'a.txt');
  assert.equal(file.combined, true);
  assert.deepEqual(
    file.rows.slice(1).map((r) => [r.mark, r.kind, r.old, r.new, r.text]),
    [
      ['  ', 'ctx', 1, 1, 'one'],
      ['++', 'add', undefined, 2, '<<<<<<< HEAD'],
      [' +', 'add', 2, 3, 'TWO main'],
      ['++', 'add', undefined, 4, '======='],
      ['+ ', 'add', undefined, 5, 'TWO side'],
      ['++', 'add', undefined, 6, '>>>>>>> side'],
      ['  ', 'ctx', 3, 7, 'three'],
      [' +', 'add', 4, 8, 'four'],
    ],
  );
  // A line both sides had and the result does not.
  const [gone] = parseDiff('diff --cc b.txt\n--- a/b.txt\n+++ b/b.txt\n@@@ -1,2 -1,2 +1,1 @@@\n--old\n  kept\n');
  assert.deepEqual(gone.rows.slice(1).map((r) => [r.kind, r.old, r.new, r.text]), [['del', 1, undefined, 'old'], ['ctx', 2, 1, 'kept']]);
});

test('a name with a space is one name, whether or not the diff has ---/+++ lines to say so', async () => {
  const [text] = parseDiff('diff --git a/my file.txt b/my file.txt\nindex 1..2 100644\n--- a/my file.txt\n+++ b/my file.txt\n@@ -1 +1 @@\n-a\n+b\n');
  assert.deepEqual([text.path, text.from, text.status], ['my file.txt', undefined, 'modified']);
  // A binary one has no ---/+++: the header is all there is.
  const [picture] = parseDiff('diff --git a/pic one.png b/pic one.png\nindex 1..2 100644\nBinary files a/pic one.png and b/pic one.png differ\n');
  assert.deepEqual([picture.path, picture.from, picture.binary], ['pic one.png', undefined, true]);
  // A rename with spaces on both sides: the rename lines have the last word.
  const [moved] = parseDiff('diff --git a/old name.txt b/new name.txt\nsimilarity index 100%\nrename from old name.txt\nrename to new name.txt\n');
  assert.deepEqual([moved.path, moved.from, moved.status], ['new name.txt', 'old name.txt', 'renamed']);
  // A mode change only, with a space: no rename made up from half the name.
  const [mode] = parseDiff('diff --git a/run me.sh b/run me.sh\nold mode 100644\nnew mode 100755\n');
  assert.deepEqual([mode.path, mode.from], ['run me.sh', undefined]);
});
