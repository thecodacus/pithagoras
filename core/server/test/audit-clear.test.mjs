import assert from 'node:assert/strict';
import test from 'node:test';
import { inProcessHome } from './server-harness.mjs';

const dataDir = inProcessHome('pithagoras-audit-');

const { default: express } = await import('express');
const { peopleRouter } = await import('../dist/api/people.js');
const { recordAudit, listAudit, clearAudit, getDb, AUDIT_KEEP } = await import('../dist/db.js');

const app = express();
app.use(express.json());
app.use('/api', peopleRouter());
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}/api`;
test.after(() => { server.close(); getDb().close(); });

const reset = () => getDb().prepare('DELETE FROM audit').run();
const entries = () => fetch(`${base}/audit`).then((r) => r.json()).then((r) => r.entries);

test('DELETE /api/audit removes every entry, says how many, and leaves only a note that it did', async () => {
  reset();
  recordAudit({ kind: 'refused', tool: 'bash', subject: 'rm -rf /' });
  recordAudit({ kind: 'stranger', reason: 'unknown sender' });
  assert.equal((await entries()).length, 2);
  const r = await fetch(`${base}/audit`, { method: 'DELETE' });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { removed: 2 });
  const left = await entries();
  assert.deepEqual(left.map((e) => [e.kind, e.reason]), [['cleared', '2']]);
});

test('with ?through, entries recorded after that id survive the clear', async () => {
  reset();
  recordAudit({ kind: 'refused', subject: 'seen' });
  const [seen] = await entries();
  recordAudit({ kind: 'refused', subject: 'recorded while asking' });
  const r = await fetch(`${base}/audit?through=${seen.id}`, { method: 'DELETE' });
  assert.deepEqual(await r.json(), { removed: 1 });
  const left = await entries();
  assert.deepEqual(left.map((e) => e.kind), ['cleared', 'refused']);
  assert.equal(left[1].subject, 'recorded while asking');
});

test('clearing an empty log removes nothing and leaves no note', async () => {
  reset();
  const r = await fetch(`${base}/audit`, { method: 'DELETE' });
  assert.deepEqual(await r.json(), { removed: 0 });
  assert.deepEqual(await entries(), []);
});

test('a second clear keeps the note of the first', async () => {
  reset();
  recordAudit({ kind: 'refused' });
  recordAudit({ kind: 'refused' });
  clearAudit();
  recordAudit({ kind: 'stranger' });
  assert.equal(clearAudit(), 1);
  assert.deepEqual((await entries()).map((e) => [e.kind, e.reason]), [['cleared', '1'], ['cleared', '2']]);
});

test('a through that is not an entry id is refused, and nothing is deleted', async () => {
  reset();
  recordAudit({ kind: 'refused' });
  for (const q of ['abc', '12.5', '-1', '', '5&through=9']) {
    const r = await fetch(`${base}/audit?through=${q}`, { method: 'DELETE' });
    assert.equal(r.status, 400, q);
  }
  assert.equal((await entries()).length, 1);
});

test('the log keeps recording after a clear, and still keeps only the newest entries', () => {
  reset();
  recordAudit({ kind: 'refused' });
  clearAudit();
  for (let i = 0; i < AUDIT_KEEP + 5; i++) recordAudit({ kind: 'browsed', subject: String(i) });
  const all = listAudit(AUDIT_KEEP + 10);
  assert.equal(all.length, AUDIT_KEEP);
  assert.equal(all[0].subject, String(AUDIT_KEEP + 4));
});
