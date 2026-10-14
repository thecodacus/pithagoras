import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { inProcessHome } from './server-harness.mjs';

// A database from before chats could wait for a name: the column has to appear
// without giving those chats one to be overwritten.
const dataDir = inProcessHome('pithagoras-title-');
const old = new Database(join(dataDir, 'portal.db'));
old.exec(`CREATE TABLE sessions (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, workspace TEXT NOT NULL,
  executor TEXT NOT NULL DEFAULT 'host', status TEXT NOT NULL DEFAULT 'idle',
  created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_error TEXT, provider TEXT, model TEXT, thinking_level TEXT, pinned INTEGER NOT NULL DEFAULT 0,
  pi_session_file TEXT, kind TEXT NOT NULL DEFAULT 'task', channel_slug TEXT, channel_key TEXT, routine_slug TEXT);
  INSERT INTO sessions (id, title, workspace) VALUES ('before', 'New chat', '/w');`);
old.close();

const { createSession, getSession, updateSession, getDb } = await import('../dist/db.js');
test.after(() => getDb().close());

test('a chat from before is not waiting for a name, even one that is called New chat', () => {
  assert.equal(getSession('before').auto_title, 0);
});

test('a chat waits for a name only when it was made to', () => {
  createSession({ id: 'a', title: 'New chat', workspace: '/w', executor: 'host', auto_title: 1 });
  createSession({ id: 'b', title: 'Mine', workspace: '/w', executor: 'host' });
  assert.equal(getSession('a').auto_title, 1);
  assert.equal(getSession('b').auto_title, 0);
  updateSession('a', { title: 'Fix the login', auto_title: 0 });
  assert.equal(getSession('a').auto_title, 0);
  assert.equal(getSession('a').title, 'Fix the login');
});
