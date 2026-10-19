import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { mockPortal, scratch } from "@pithagoras/extension-api/testing";
import files, { watchFolders } from "../src/server.ts";
import { folderTopic } from "../src/files-api.ts";

/**
 * The folder a page has open, watched (watchFolders, src/server.ts) on the portal's own `files.watch`: a page that listens to
 * the folder's topic is told that something in it changed, whatever changed it, and is not told anything else.
 */

/** A chat "a" working in a new folder with a folder `sub` in it, and a folder `outside` beside it. */
async function setup(half: (portal: any) => unknown = files) {
  const top = scratch("files-watch-");
  const work = path.join(top, "work");
  mkdirSync(path.join(work, "sub"), { recursive: true });
  mkdirSync(path.join(top, "outside"));
  const mock = await mockPortal({ extension: "pithagoras-files", chats: { a: work } });
  await mock.start(half);
  return { top, work, sub: path.join(work, "sub"), outside: path.join(top, "outside"), mock };
}
const changes = (page: { heard(): [string, unknown][] }, topic: string) => page.heard().filter(([t, data]) => t === topic && (data as { changed?: true }).changed).length;

test("a page that has a folder open is told when something in it changes, by anything that is not the agent's tools", async () => {
  const { work, sub, mock } = await setup();
  try {
    const page = mock.page();
    const root = folderTopic("a", "")!;
    const inSub = folderTopic("a", "sub")!;
    assert.equal(await page.listen(root), "listening");
    assert.equal(await page.listen(inSub), "listening");
    await page.until(() => page.heard().length === 2, "where things stand, for each");
    assert.deepEqual(page.heard().map(([topic, data]) => [topic, data]), [[root, { first: true }], [inSub, { first: true }]]);
    // A file made by hand, as a shell does it.
    writeFileSync(path.join(work, "by-hand.txt"), "hello");
    await page.until(() => changes(page, root) === 1, "told that the folder changed");
    assert.equal(changes(page, inSub), 0, "a change in a folder is not a change in the one below it");
    // A burst is one telling, and a file made in the folder below is that folder's own.
    writeFileSync(path.join(sub, "a.txt"), "1");
    writeFileSync(path.join(sub, "b.txt"), "2");
    renameSync(path.join(sub, "b.txt"), path.join(sub, "c.txt"));
    await page.until(() => changes(page, inSub) >= 1, "told that the folder below changed");
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(changes(page, inSub), 1, "once for the burst");
    assert.equal(changes(page, root), 1);
    // It says nothing of what changed.
    assert.deepEqual(page.heard().filter(([, data]) => JSON.stringify(data) !== '{"first":true}' && JSON.stringify(data) !== '{"changed":true}'), []);
  } finally {
    await mock.stop();
  }
});

test("a page is turned away from a folder that is not the chat's: another chat's, a path out of it, a link out of it", async () => {
  const { work, outside, mock } = await setup();
  try {
    symlinkSync(outside, path.join(work, "escape"));
    const page = mock.page();
    for (const topic of [folderTopic("nope", "")!, folderTopic("a", "..")!, folderTopic("a", "../outside")!, folderTopic("a", "escape")!, "dir", "folder/a/", "other"]) {
      assert.equal(await page.listen(topic), "refused", topic);
    }
    writeFileSync(path.join(outside, "x"), "1");
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.deepEqual(page.heard(), []);
  } finally {
    await mock.stop();
  }
});

test("a folder watched by two pages is told to both, and to the one that stays when the other leaves", async () => {
  const { sub, mock } = await setup();
  try {
    const topic = folderTopic("a", "sub")!;
    const [one, two] = [mock.page(), mock.page()];
    assert.equal(await one.listen(topic), "listening");
    assert.equal(await two.listen(topic), "listening");
    writeFileSync(path.join(sub, "x"), "1");
    await one.until(() => changes(one, topic) === 1, "the first told");
    await two.until(() => changes(two, topic) === 1, "the second told");
    one.leave(topic);
    writeFileSync(path.join(sub, "y"), "2");
    await two.until(() => changes(two, topic) === 2, "the one that stayed is told again");
    assert.equal(changes(one, topic), 1, "the one that left is not");
    two.leave(topic);
    // Nothing is watched for nobody: a page that listens anew is told where things stand, and the watch is made anew.
    const three = mock.page();
    assert.equal(await three.listen(topic), "listening");
    writeFileSync(path.join(sub, "z"), "3");
    await three.until(() => changes(three, topic) === 1, "a watch made anew");
  } finally {
    await mock.stop();
  }
});

test("a folder that is removed and made again is watched again, and the page is told each time", async () => {
  const { work, sub, mock } = await setup((portal) => watchFolders(portal, 40));
  try {
    const topic = folderTopic("a", "sub")!;
    const page = mock.page();
    assert.equal(await page.listen(topic), "listening");
    rmSync(sub, { recursive: true });
    await page.until(() => changes(page, topic) >= 1, "told that the folder is gone");
    // Not there for now: the page listens all the same, and hears the folder when it is back.
    const before = changes(page, topic);
    mkdirSync(sub);
    await page.until(() => changes(page, topic) > before, "told that the folder is there again");
    const after = changes(page, topic);
    writeFileSync(path.join(sub, "new.txt"), "1");
    await page.until(() => changes(page, topic) > after, "told of a file in the folder that was made again");
    // A folder that was not there when the page began to listen.
    const later = folderTopic("a", "later")!;
    assert.equal(await page.listen(later), "listening");
    mkdirSync(path.join(work, "later"));
    await page.until(() => changes(page, later) >= 1, "told that the folder appeared");
  } finally {
    await mock.stop();
  }
});

test("a path too long for a topic is not watched, and the topic is a plain ASCII name whatever the folder is called", () => {
  assert.equal(folderTopic("a", "x".repeat(300)), undefined);
  const odd = folderTopic("a", "päth/with space\n/and%");
  assert.ok(odd && /^[\x21-\x7e]+$/.test(odd), odd);
  assert.equal(folderTopic("a", ""), "dir/a/");
});
