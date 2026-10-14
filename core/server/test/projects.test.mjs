import assert from 'node:assert/strict';
import { existsSync, linkSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { scratch } from './server-harness.mjs';
const P = await import('../dist/projects.js');

const root = () => scratch('projects-');
const code = (fn) => { try { fn(); } catch (e) { return e instanceof P.ProjectError ? e.code : `other:${e.message}`; } return 'none'; };

test('the projects are the folders under the root, by name, without hidden ones or files', () => {
  const r = root();
  mkdirSync(path.join(r, 'zeta')); mkdirSync(path.join(r, 'alpha')); mkdirSync(path.join(r, '.hidden'));
  writeFileSync(path.join(r, 'a-file'), 'x');
  assert.deepEqual(P.listProjects(r).map((p) => p.name), ['alpha', 'zeta']);
});

test('a project is named like a folder and starts with its instructions', () => {
  const r = root();
  const p = P.createProject(r, 'Cool Project', '  Answer in German.  \n\n');
  assert.equal(p.name, 'cool-project');
  assert.equal(p.hasInstructions, true);
  assert.equal(readFileSync(path.join(r, 'cool-project', 'AGENTS.md'), 'utf8'), '  Answer in German.\n');
  assert.equal(P.readInstructions(r, 'cool-project').text, '  Answer in German.\n');
});

test('a project without instructions has no file, and blank instructions remove it', () => {
  const r = root();
  const p = P.createProject(r, 'plain');
  assert.equal(p.hasInstructions, false);
  assert.deepEqual(P.readInstructions(r, 'plain'), { text: '', mtime: 0 });
  P.writeInstructions(r, 'plain', 'be brief');
  assert.equal(P.getProject(r, 'plain').hasInstructions, true);
  P.writeInstructions(r, 'plain', '   \n');
  assert.equal(P.getProject(r, 'plain').hasInstructions, false);
});

test('names that are taken, reserved or unusable are refused', () => {
  const r = root();
  P.createProject(r, 'one');
  assert.equal(code(() => P.createProject(r, 'One')), 'exists');
  // "home" is what chats start in, and would read as it.
  assert.equal(code(() => P.createProject(r, 'home')), 'invalid');
  assert.equal(code(() => P.createProject(r, 'Home')), 'invalid');
  assert.equal(code(() => P.createProject(r, '???')), 'invalid');
  assert.equal(code(() => P.createProject(r, '../escape')), 'none'); // becomes "escape": nothing to escape with
  assert.ok(!existsSync(path.join(path.dirname(r), 'escape')));
});

test('a name from outside cannot reach beyond the root', () => {
  const r = root();
  const outside = scratch('outside-');
  writeFileSync(path.join(outside, 'precious'), 'keep');
  symlinkSync(outside, path.join(r, 'link'));
  mkdirSync(path.join(r, 'real'));
  for (const bad of ['../x', 'a/b', '..', '.', '.hidden', 'a\\b', '']) {
    assert.equal(code(() => P.getProject(r, bad)), 'invalid', `getProject(${JSON.stringify(bad)})`);
    assert.equal(code(() => P.deleteProjectFolder(r, bad)), 'invalid', `deleteProjectFolder(${JSON.stringify(bad)})`);
  }
  // A symlink to somewhere else is not a project, so it is not deleted through.
  assert.equal(code(() => P.deleteProjectFolder(r, 'link')), 'invalid');
  assert.equal(code(() => P.writeInstructions(r, 'link', 'x')), 'invalid');
  assert.ok(existsSync(path.join(outside, 'precious')));
  assert.equal(code(() => P.getProject(r, 'nope')), 'missing');
});

test('deleting a project removes its folder', () => {
  const r = root();
  P.createProject(r, 'gone', 'x');
  writeFileSync(path.join(r, 'gone', 'work.txt'), 'abc');
  mkdirSync(path.join(r, 'gone', 'sub'));
  writeFileSync(path.join(r, 'gone', 'sub', 'deep.txt'), 'defg');
  const d = P.describeProject(r, 'gone');
  // AGENTS.md ("x\n"), work.txt and sub/deep.txt.
  assert.deepEqual(d, { files: 3, bytes: 2 + 3 + 4, complete: true });
  P.deleteProjectFolder(r, 'gone');
  assert.ok(!existsSync(path.join(r, 'gone')));
});

test('instructions have a size limit', () => {
  const r = root();
  P.createProject(r, 'big');
  assert.equal(code(() => P.writeInstructions(r, 'big', 'x'.repeat(100_001))), 'invalid');
});

test('a chat is named after its first line, briefly, and never after a command', () => {
  assert.equal(P.titleFrom('  Fix the login\nbug in auth.ts '), 'Fix the login');
  assert.equal(P.titleFrom('\n\n  second line only'), 'second line only');
  assert.equal(P.titleFrom('x'.repeat(80)), 'x'.repeat(47) + '…');
  assert.equal(P.titleFrom('/compact now'), undefined);
  assert.equal(P.titleFrom('   \n  '), undefined);
  assert.equal(P.NEW_CHAT_TITLE, 'New chat');
});

test('a link in the root is not listed as a project, since every operation on it would refuse', () => {
  const r = root(); const outside = root();
  mkdirSync(path.join(r, 'real'));
  symlinkSync(outside, path.join(r, 'linked'));
  assert.deepEqual(P.listProjects(r).map((p) => p.name), ['real']);
});

test('instructions that are too long are refused before the folder is made, so the name stays free', () => {
  const r = root();
  assert.equal(code(() => P.createProject(r, 'big', 'x'.repeat(100_001))), 'invalid');
  assert.equal(existsSync(path.join(r, 'big')), false);
  assert.equal(P.createProject(r, 'big', 'short').name, 'big');
});

test('the limit message uses the same digits wherever the server runs', () => {
  const r = root();
  try { P.createProject(r, 'big', 'x'.repeat(100_001)); assert.fail('should have refused'); }
  catch (e) { assert.match(e.message, /100,000 characters/); }
});

test('saving a long run of blanks is quick', () => {
  const r = root();
  P.createProject(r, 'blanks');
  const started = Date.now();
  P.writeInstructions(r, 'blanks', ' '.repeat(99_999) + 'x');
  assert.ok(Date.now() - started < 500, `took ${Date.now() - started} ms`);
  P.writeInstructions(r, 'blanks', 'x' + ' '.repeat(99_998) + '\n');
  assert.ok(Date.now() - started < 1000);
});

test('a link in place of AGENTS.md is neither read nor written through', () => {
  const r = root(); const outside = root();
  P.createProject(r, 'linked');
  const target = path.join(outside, 'secret');
  writeFileSync(target, 'not yours');
  symlinkSync(target, path.join(r, 'linked', 'AGENTS.md'));
  assert.equal(code(() => P.readInstructions(r, 'linked')), 'invalid');
  assert.equal(code(() => P.writeInstructions(r, 'linked', 'overwritten')), 'invalid');
  assert.equal(readFileSync(target, 'utf8'), 'not yours');
  // Clearing removes the link itself, and leaves what it pointed at.
  P.writeInstructions(r, 'linked', '');
  assert.equal(existsSync(path.join(r, 'linked', 'AGENTS.md')), false);
  assert.equal(readFileSync(target, 'utf8'), 'not yours');
});

test('a second name for a file elsewhere is not written to either', () => {
  const r = root(); const outside = root();
  P.createProject(r, 'shared');
  const target = path.join(outside, 'other');
  writeFileSync(target, 'not yours');
  linkSync(target, path.join(r, 'shared', 'AGENTS.md'));
  assert.equal(code(() => P.writeInstructions(r, 'shared', 'overwritten')), 'invalid');
  assert.equal(readFileSync(target, 'utf8'), 'not yours');
});

test('an AGENTS.md far larger than the editor takes is refused rather than read into memory', () => {
  const r = root();
  P.createProject(r, 'huge');
  writeFileSync(path.join(r, 'huge', 'AGENTS.md'), 'x'.repeat(400_001));
  assert.equal(code(() => P.readInstructions(r, 'huge')), 'invalid');
  writeFileSync(path.join(r, 'huge', 'AGENTS.md'), 'y'.repeat(100_000));
  assert.equal(P.readInstructions(r, 'huge').text.length, 100_000);
});

test('a title is cut between characters, not through one', () => {
  const t = P.titleFrom('😀'.repeat(60));
  assert.equal(t, '😀'.repeat(47) + '…');
  assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])/.test(t));
});
