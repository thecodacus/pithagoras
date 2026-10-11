import assert from 'node:assert/strict';
import test from 'node:test';

const { default: express } = await import('express');
const { logsRouter } = await import('../dist/api/logs.js');
const { LOG_BOOT, LOG_KEEP, LOG_LINE_MAX, installLogCapture, readLogs, recordLog, resetLogs } = await import('../dist/logs.js');

const app = express();
app.use('/api', logsRouter());
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}/api`;
test.after(() => server.close());

// The console is wrapped once for the whole file; what it printed is still printed, so the runner shows it.
installLogCapture();

test('the console is copied into the log with its level, and still prints', () => {
  resetLogs();
  const printed = [];
  const out = process.stdout.write.bind(process.stdout);
  const err = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk) => { printed.push(String(chunk)); return true; };
  process.stderr.write = (chunk) => { printed.push(String(chunk)); return true; };
  try {
    console.log('started on port %d', 3000);
    console.warn('careful', { a: 1 });
    console.error(new Error('broke'));
  } finally {
    process.stdout.write = out;
    process.stderr.write = err;
  }
  const lines = readLogs();
  assert.deepEqual(lines.map((l) => l.level), ['info', 'warn', 'error']);
  assert.equal(lines[0].text, 'started on port 3000');
  assert.equal(lines[1].text, "careful { a: 1 }");
  assert.match(lines[2].text, /^Error: broke\n\s+at /);
  assert.ok(printed.some((p) => p.includes('started on port 3000')), 'the original console still prints');
  assert.ok(printed.some((p) => p.includes('broke')), 'and so does its error');
});

test('only the newest LOG_KEEP lines are held, and a line that is too long is cut', () => {
  resetLogs();
  for (let i = 0; i < LOG_KEEP + 5; i++) recordLog('info', `line ${i}`);
  const all = readLogs();
  assert.equal(all.length, LOG_KEEP);
  assert.equal(all[0].text, 'line 5');
  const long = recordLog('error', 'x'.repeat(LOG_LINE_MAX + 100));
  assert.ok(long.text.length < LOG_LINE_MAX + 100);
  assert.match(long.text, /… \(100 more characters\)$/);
});

test('since returns what came after, oldest first; without it the newest ones; a level keeps that and worse', () => {
  resetLogs();
  const a = recordLog('info', 'a');
  recordLog('warn', 'b');
  recordLog('error', 'c');
  recordLog('info', 'd');
  assert.deepEqual(readLogs({ since: a.id }).map((l) => l.text), ['b', 'c', 'd']);
  assert.deepEqual(readLogs({ since: a.id, limit: 2 }).map((l) => l.text), ['b', 'c']);
  assert.deepEqual(readLogs({ limit: 2 }).map((l) => l.text), ['c', 'd']);
  assert.deepEqual(readLogs({ min: 'warn' }).map((l) => l.text), ['b', 'c']);
  assert.deepEqual(readLogs({ min: 'error' }).map((l) => l.text), ['c']);
  assert.deepEqual(readLogs({ since: 99 }), []);
});

test('GET /api/logs answers with the boot, the newest id and the lines; since and level narrow them', async () => {
  resetLogs();
  recordLog('info', 'one');
  recordLog('error', 'two');
  const all = await (await fetch(`${base}/logs`)).json();
  assert.equal(all.boot, LOG_BOOT);
  assert.equal(all.last, 2);
  assert.deepEqual(all.lines.map((l) => [l.id, l.level, l.text]), [[1, 'info', 'one'], [2, 'error', 'two']]);
  assert.match(all.lines[0].at, /^\d{4}-\d\d-\d\dT/);
  const after = await (await fetch(`${base}/logs?since=1`)).json();
  assert.deepEqual(after.lines.map((l) => l.text), ['two']);
  const none = await (await fetch(`${base}/logs?since=2`)).json();
  assert.deepEqual(none.lines, []);
  assert.equal(none.last, 2);
  const errors = await (await fetch(`${base}/logs?level=error`)).json();
  assert.deepEqual(errors.lines.map((l) => l.text), ['two']);
});

test('GET /api/logs refuses a since or a level it cannot read, rather than answering with everything', async () => {
  assert.equal((await fetch(`${base}/logs?since=abc`)).status, 400);
  assert.equal((await fetch(`${base}/logs?since=-1`)).status, 400);
  assert.equal((await fetch(`${base}/logs?level=loud`)).status, 400);
});

test('GET /api/logs/download is a text file with a line per entry', async () => {
  resetLogs();
  recordLog('warn', 'first');
  recordLog('info', 'second\nthird');
  const r = await fetch(`${base}/logs/download`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /^text\/plain/);
  assert.match(r.headers.get('content-disposition'), /^attachment; filename="pithagoras-logs-\d{4}-\d\d-\d\d\.log"$/);
  const rows = (await r.text()).trimEnd().split('\n');
  assert.match(rows[0], /^\d{4}-\d\d-\d\dT[\d:.]+Z WARN  first$/);
  assert.match(rows[1], /Z INFO  second$/);
  assert.equal(rows[2], 'third');
});
