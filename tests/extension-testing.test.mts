import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mockPortal, scratch } from '../packages/extension-api/testing.mjs';

/**
 * The portal a test of an extension's server half calls it with (`@pithagoras/extension-api/testing`): it does what the
 * portal does, so that a test written against it shows what the real one would.
 */

const MESSAGE = { text: 'The person asked you in a comment', type: 'ping' };

test('chats.followUp hands the message over and resolves, as the portal\'s does; a pi that refuses it is a failure the chat\'s events tell', async () => {
  const mock = await mockPortal({ extension: 'ext-a', chats: { a: scratch() }, sendThrows: 'The runtime is not ready' });
  try {
    const events: [string, Record<string, unknown>][] = [];
    mock.portal.chats.onEvent((chat, event) => events.push([chat, event]));
    // The real call does not wait for pi, so it cannot know pi refused: it resolves true.
    assert.equal(await mock.portal.chats.followUp('a', MESSAGE), true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(events, [['a', { type: 'portal_failed', error: 'A message from ext-a could not be delivered: The runtime is not ready' }]]);
    assert.deepEqual(mock.said('a'), []);
    assert.equal(mock.followedUp.length, 1);
  } finally {
    await mock.stop();
  }
});

test('chats.followUp puts the message in the conversation as the package\'s own, and answers false where pi does not run in the portal\'s process', async () => {
  const mock = await mockPortal({ extension: 'ext-a', chats: { a: scratch() } });
  const elsewhere = await mockPortal({ extension: 'ext-a', executor: 'docker', chats: { a: scratch() } });
  try {
    assert.equal(await mock.portal.chats.followUp('a', MESSAGE), true);
    assert.deepEqual(mock.said('a').map((s) => [s.message.customType, s.message.content, s.options]), [['ext-a:ping', MESSAGE.text, { deliverAs: 'followUp', triggerTurn: true }]]);
    await assert.rejects(() => mock.portal.chats.followUp('nope', MESSAGE), /No such chat/);
    await assert.rejects(() => mock.portal.chats.followUp('a', { text: ' ' }), TypeError);
    assert.equal(await elsewhere.portal.chats.followUp('a', MESSAGE), false, 'the agent cannot be reached');
    assert.deepEqual(elsewhere.said('a'), []);
  } finally {
    await mock.stop();
    await elsewhere.stop();
  }
});

test('chats.inFolder gives the sessions of every kind that work in a folder, chats.list the tasks alone, and the folder is resolved as it is asked', async () => {
  const mine = scratch();
  const other = scratch();
  const elsewhere: Record<string, string> = {};
  const mock = await mockPortal({
    extension: 'ext-a',
    chats: { t: mine, r: mine, o: other },
    kinds: { r: 'routine' },
    folderOf: (id) => elsewhere[id] ?? mine,
  });
  try {
    const { chats } = mock.portal;
    assert.deepEqual(chats.list().map((chat) => chat.id), ['t', 'o'], 'the tasks');
    assert.deepEqual(chats.inFolder(mine).map((chat) => chat.id).sort(), ['o', 'r', 't'], 'folderOf says where each leads: all of them here');
    elsewhere.o = other;
    assert.deepEqual(chats.inFolder(mine).map((chat) => chat.id).sort(), ['r', 't']);
    assert.deepEqual(chats.inFolder(other).map((chat) => chat.id), ['o']);
    assert.equal(chats.folder('o'), other);
    assert.throws(() => chats.folder('nobody'), /No such chat/);
    assert.deepEqual(chats.inFolder(path.join(mine, 'nope')), []);
  } finally {
    await mock.stop();
  }
  // Without folderOf a chat works in the folder it was made for.
  const plain = await mockPortal({ extension: 'ext-a', chats: { a: mine, b: other } });
  try {
    assert.deepEqual(plain.portal.chats.inFolder(mine).map((chat) => chat.id), ['a']);
  } finally {
    await plain.stop();
  }
});

test('a copy of the testing entry that has no portal beside it says so, rather than naming a package that is missing', async () => {
  const outside = mkdtempSync(path.join(process.env.TMPDIR ?? tmpdir(), 'extension-testing-'));
  try {
    const here = path.join(outside, 'node_modules', '@pithagoras', 'extension-api');
    mkdirSync(here, { recursive: true });
    copyFileSync(new URL('../packages/extension-api/testing.mjs', import.meta.url), path.join(here, 'testing.mjs'));
    const { mockPortal: lonely } = await import(path.join(here, 'testing.mjs'));
    await assert.rejects(() => lonely(), /folder-files|extension-push/);
    await assert.rejects(() => lonely(), /is needed by @pithagoras\/extension-api\/testing, and is not beside it/);
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});
