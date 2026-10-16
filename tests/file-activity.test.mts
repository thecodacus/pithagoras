import { test } from 'node:test';
import assert from 'node:assert/strict';
import { insideFolder } from '../core/web/src/file-activity.js';

const folder = '/workspaces/proj';

test('a path is taken as inside the folder, whether it was written relative or absolute', () => {
  assert.equal(insideFolder(folder, 'src/a.ts'), 'src/a.ts');
  assert.equal(insideFolder(folder, './src/../a.ts'), 'a.ts');
  assert.equal(insideFolder(folder, '/workspaces/proj/src/a.ts'), 'src/a.ts');
  assert.equal(insideFolder(folder + '/', '/workspaces/proj/a.ts'), 'a.ts');
});

test('a path somewhere else, or the folder itself, is not a file in it', () => {
  assert.equal(insideFolder(folder, '/etc/passwd'), undefined);
  assert.equal(insideFolder(folder, '/workspaces/proj-other/a.ts'), undefined);
  assert.equal(insideFolder(folder, '../other/a.ts'), undefined);
  assert.equal(insideFolder(folder, 'a/../../x'), undefined);
  assert.equal(insideFolder(folder, '.'), undefined);
  assert.equal(insideFolder(folder, '/workspaces/proj'), undefined);
});
