import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countFiles, treeOfEntries, treeOfPaths, uploadTree, type Entry, type TreeApi } from '../src/tree.ts';

/** A file as the folder picker gives it: with its path from the picked folder. */
const picked = (rel: string, body = 'x') => {
  const file = new File([body], rel.split('/').pop()!);
  Object.defineProperty(file, 'webkitRelativePath', { value: rel });
  return file;
};

/** The server's side of the two calls: folders and files by path, a taken folder name refused as the folder route does. */
function fakeServer(options: { taken?: string[]; failing?: string[] } = {}) {
  const folders = new Set<string>(options.taken ?? []);
  const files: string[] = [];
  const calls: string[] = [];
  const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);
  const api: TreeApi = {
    async createFolder(dir, name) {
      calls.push(`folder ${join(dir, name)}`);
      if (folders.has(join(dir, name))) throw Object.assign(new Error('taken'), { taken: true });
      folders.add(join(dir, name));
      return { path: join(dir, name) };
    },
    async uploadFile(dir, file) {
      calls.push(`file ${join(dir, file.name)}`);
      if (options.failing?.includes(file.name)) throw new Error(`Could not upload ${file.name} (500)`);
      files.push(join(dir, file.name));
    },
  };
  const isTaken = (e: unknown) => (e as { taken?: boolean }).taken === true;
  return { api, isTaken, folders, files, calls };
}

test('a picked folder becomes a tree with each folder once and its files in them', () => {
  const tree = treeOfPaths([picked('proj/a.txt'), picked('proj/src/b.txt'), picked('proj/src/deep/c.txt'), picked('proj/src/d.txt')]);
  assert.deepEqual(tree.problems, []);
  assert.equal(tree.files.length, 0);
  assert.equal(tree.dirs.length, 1);
  const [proj] = tree.dirs;
  assert.equal(proj.name, 'proj');
  assert.deepEqual(proj.files.map((f) => f.name), ['a.txt']);
  assert.deepEqual(proj.dirs.map((d) => d.name), ['src']);
  assert.deepEqual(proj.dirs[0].files.map((f) => f.name), ['b.txt', 'd.txt']);
  assert.deepEqual(proj.dirs[0].dirs.map((d) => d.name), ['deep']);
  assert.equal(countFiles(tree), 4);
});

test('files without a relative path are plain files', () => {
  const tree = treeOfPaths([new File(['x'], 'one.txt'), new File(['y'], 'two.txt')]);
  assert.deepEqual(tree.files.map((f) => f.name), ['one.txt', 'two.txt']);
  assert.equal(tree.dirs.length, 0);
});

test('a path with a way out is left out and said, and nothing of it is sent', async () => {
  const paths = ['../evil.txt', 'proj/../../evil.txt', 'proj/./a.txt', '/etc/passwd', 'proj//a.txt', 'proj\\..\\evil.txt', 'proj/a\0.txt'];
  const files = paths.map((rel) => {
    const file = new File(['x'], 'f.txt');
    Object.defineProperty(file, 'webkitRelativePath', { value: rel });
    return file;
  });
  const tree = treeOfPaths([...files, picked('proj/ok.txt')]);
  assert.deepEqual(tree.problems.sort(), [...paths].sort());
  assert.equal(countFiles(tree), 1);
  const server = fakeServer();
  await uploadTree(server.api, server.isTaken, '', tree, () => {});
  assert.deepEqual(server.calls, ['folder proj', 'file proj/ok.txt']);
});

test('a file whose own name is a way out is left out', () => {
  const file = new File(['x'], '..');
  Object.defineProperty(file, 'webkitRelativePath', { value: 'proj/a' });
  assert.deepEqual(treeOfPaths([file]).problems, ['proj/a']);
});

test('the tree is made folder by folder and each file goes into its own', async () => {
  const server = fakeServer();
  const tree = treeOfPaths([picked('proj/a.txt'), picked('proj/src/b.txt'), picked('proj/src/deep/c.txt')]);
  const done: string[] = [];
  const result = await uploadTree(server.api, server.isTaken, 'inbox', tree, (f) => done.push(f.name));
  assert.deepEqual(result.problems, []);
  assert.deepEqual(server.files, ['inbox/proj/a.txt', 'inbox/proj/src/b.txt', 'inbox/proj/src/deep/c.txt']);
  assert.deepEqual(done.sort(), ['a.txt', 'b.txt', 'c.txt']);
});

test('a taken folder name gets a number, in a subfolder too, and its files go into the numbered one', async () => {
  const server = fakeServer({ taken: ['proj', 'proj (2)', 'proj (3)/src'] });
  const tree = treeOfPaths([picked('proj/a.txt'), picked('proj/src/b.txt')]);
  const result = await uploadTree(server.api, server.isTaken, '', tree, () => {});
  assert.deepEqual(result.problems, []);
  // "proj" and "proj (2)" were taken; "proj (3)/src" is taken, so its src is "src (2)".
  assert.deepEqual(server.files, ['proj (3)/a.txt', 'proj (3)/src (2)/b.txt']);
});

test('a folder with a dot in its name is numbered after the whole name', async () => {
  const server = fakeServer({ taken: ['v1.2'] });
  await uploadTree(server.api, server.isTaken, '', treeOfPaths([picked('v1.2/a.txt')]), () => {});
  assert.deepEqual(server.files, ['v1.2 (2)/a.txt']);
});

test('one file that fails does not stop the rest, and every file is counted', async () => {
  const server = fakeServer({ failing: ['bad.txt'] });
  const tree = treeOfPaths([picked('proj/a.txt'), picked('proj/bad.txt'), picked('proj/src/c.txt')]);
  const done: string[] = [];
  const result = await uploadTree(server.api, server.isTaken, '', tree, (f) => done.push(f.name));
  assert.deepEqual(server.files, ['proj/a.txt', 'proj/src/c.txt']);
  assert.deepEqual(result.problems, ['Could not upload bad.txt (500)']);
  assert.equal(done.length, 3);
});

test('a folder that cannot be made counts its files as failed and the rest goes on', async () => {
  const server = fakeServer();
  const make = server.api.createFolder;
  server.api.createFolder = async (dir, name) => {
    if (name === 'locked') throw new Error('Not allowed');
    return make(dir, name);
  };
  const tree = treeOfPaths([picked('locked/a.txt'), picked('locked/sub/b.txt'), picked('open/c.txt')]);
  const done: string[] = [];
  const result = await uploadTree(server.api, server.isTaken, '', tree, (f) => done.push(f.name));
  assert.deepEqual(server.files, ['open/c.txt']);
  assert.ok(result.problems.length >= 1 && result.problems.every((p) => p === 'Not allowed'));
  assert.deepEqual(done.sort(), ['a.txt', 'b.txt', 'c.txt']);
});

/** A directory of the entries API, whose reader gives its children a few at a time. */
const entryFile = (name: string, body = 'x'): Entry => ({ isFile: true, isDirectory: false, name, file: (ok) => ok(new File([body], name)) });
const entryDir = (name: string, children: Entry[], batch = 2): Entry => ({
  isFile: false,
  isDirectory: true,
  name,
  createReader() {
    let at = 0;
    return {
      readEntries(ok) {
        const part = children.slice(at, at + batch);
        at += batch;
        ok(part);
      },
    };
  },
});

test('a dropped folder is walked to its end, in batches, and an empty folder is kept', async () => {
  const tree = await treeOfEntries([
    entryFile('loose.txt'),
    entryDir('proj', [entryFile('a.txt'), entryFile('b.txt'), entryFile('c.txt'), entryDir('empty', []), entryDir('src', [entryFile('d.txt'), entryFile('e.txt'), entryFile('f.txt')])]),
  ]);
  assert.deepEqual(tree.problems, []);
  assert.deepEqual(tree.files.map((f) => f.name), ['loose.txt']);
  const [proj] = tree.dirs;
  assert.deepEqual(proj.files.map((f) => f.name), ['a.txt', 'b.txt', 'c.txt']);
  assert.deepEqual(proj.dirs.map((d) => d.name), ['empty', 'src']);
  assert.equal(proj.dirs[1].files.length, 3);
  assert.equal(countFiles(tree), 7);
  const server = fakeServer();
  await uploadTree(server.api, server.isTaken, '', tree, () => {});
  assert.deepEqual(server.calls.filter((c) => c.startsWith('folder')), ['folder proj', 'folder proj/empty', 'folder proj/src']);
});

test('an entry that cannot be read, or has a hostile name, is a problem and the others are kept', async () => {
  const broken: Entry = { isFile: true, isDirectory: false, name: 'broken.txt', file: (_ok, fail) => fail(new Error('gone')) };
  const tree = await treeOfEntries([entryDir('proj', [entryFile('ok.txt'), broken, entryFile('..')])]);
  assert.deepEqual(tree.problems.sort(), ['proj/..', 'proj/broken.txt']);
  assert.deepEqual(tree.dirs[0].files.map((f) => f.name), ['ok.txt']);
});
