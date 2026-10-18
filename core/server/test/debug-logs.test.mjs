import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const { default: express } = await import('express');
const { logsRouter } = await import('../dist/api/logs.js');
const {
  LOG_CHARS_MAX, LOG_KEEP, debugLog, debugText, installLogCapture, logLevel, logSettings, readLogs, recordLog, resetLogs, scrubSecrets, setLogLevel,
} = await import('../dist/logs.js');

const app = express();
app.use('/api', logsRouter());
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}/api`;
test.after(() => server.close());

installLogCapture();

/** What a call printed on stdout and stderr, and the level the server ran at meanwhile. */
function printed(level, fn) {
  const out = process.stdout.write.bind(process.stdout);
  const err = process.stderr.write.bind(process.stderr);
  const seen = [];
  process.stdout.write = (chunk) => { seen.push(String(chunk)); return true; };
  process.stderr.write = (chunk) => { seen.push(String(chunk)); return true; };
  const before = logLevel();
  setLogLevel(level);
  try {
    fn();
  } finally {
    setLogLevel(before);
    process.stdout.write = out;
    process.stderr.write = err;
  }
  return seen.join('');
}

test('at info a debug line prints nothing and is not kept, and at debug it is both, marked as debug', () => {
  resetLogs();
  const quiet = printed('info', () => {
    debugLog('tool', 'start', { tool: 'bash' });
    console.debug('raw debug output', { a: 1 });
    console.log('an ordinary line');
  });
  assert.doesNotMatch(quiet, /tool=bash|raw debug output/, 'nothing of it reaches stdout below debug');
  assert.match(quiet, /an ordinary line/);
  assert.deepEqual(readLogs().map((l) => [l.level, l.text]), [['info', 'an ordinary line']]);

  resetLogs();
  const loud = printed('debug', () => {
    debugLog('tool', 'end', { tool: 'bash', outcome: 'ok', ms: 1520, session: 'abc' });
    console.debug('raw debug output', { a: 1 });
  });
  assert.match(loud, /\[tool\] end tool=bash outcome=ok ms=1520 session=abc/);
  assert.match(loud, /raw debug output \{ a: 1 \}/);
  assert.deepEqual(readLogs().map((l) => [l.level, l.text]), [
    ['debug', '[tool] end tool=bash outcome=ok ms=1520 session=abc'],
    ['debug', 'raw debug output { a: 1 }'],
  ]);
});

test('readLogs keeps every level by default, and a level keeps that and worse', () => {
  resetLogs();
  recordLog('debug', 'd');
  recordLog('info', 'i');
  recordLog('warn', 'w');
  recordLog('error', 'e');
  assert.deepEqual(readLogs().map((l) => l.text), ['d', 'i', 'w', 'e']);
  assert.deepEqual(readLogs({ min: 'info' }).map((l) => l.text), ['i', 'w', 'e']);
  assert.deepEqual(readLogs({ min: 'warn' }).map((l) => l.text), ['w', 'e']);
});

test('the fields of a debug line are one line of key=value, with the empty ones left out', () => {
  assert.equal(debugText('tool', 'end', { tool: 'bash', ms: 0, ok: false, subagent: undefined, none: null }), '[tool] end tool=bash ms=0 ok=false');
  // A value with a space or a quote is quoted, one with a line break is flattened, a long one is cut.
  assert.equal(debugText('x', 'y', { note: 'two words' }), '[x] y note="two words"');
  assert.equal(debugText('x', 'a\nb', { n: 1 }), '[x] a b n=1', 'the message is one line too');
  assert.equal(debugText('x', 'y', { note: 'a\nb\r\n\tc\u001b[31m' }), '[x] y note="a b c [31m"');
  const long = debugText('x', 'y', { note: 'w'.repeat(500) });
  assert.ok(long.length < 200, `cut, not ${long.length} characters`);
  assert.match(long, /…$/);
  // A key that is not a plain name could forge another field.
  assert.equal(debugText('x', 'y', { 'a b=c': 'forged', fine: 1 }), '[x] y fine=1');
  assert.equal(debugText('x', 'y', { note: 'a=b c' }), '[x] y note="a=b c"');
});

test('a field named like a secret is never printed, whatever it holds', () => {
  for (const key of ['token', 'access_token', 'apiKey', 'api_key', 'password', 'secret', 'authorization', 'cookie', 'Credentials', 'private_key']) {
    const text = debugText('x', 'y', { [key]: 'hunter2hunter2', fine: 'ok' });
    assert.doesNotMatch(text, /hunter2/, key);
    assert.match(text, new RegExp(`${key}=\\[redacted\\]`), key);
    assert.match(text, /fine=ok/);
  }
});

const SECRETS = [
  'Bearer abcdefghijklmnop1234567890',
  'Authorization: Basic dXNlcjpwYXNzd29yZDEyMzQ=',
  'authorization=Bearer abcdefghijklmnop1234567890 and more',
  'Cookie: sid=abcdef123456; other=1',
  'Set-Cookie: connect.sid=s%3Aabcdef123456',
  'https://user:p4ssw0rd-long@example.com/repo.git',
  'https://ghp_abcdefghijklmnopqrstuvwxyz0123456789@github.com/x/y',
  'GET /api/x?access_token=abcdef123456&q=1',
  'token=abcdef123456',
  '{"apiKey": "abcdef123456"}',
  '{"accessToken":"abcdef123456"}',
  'clientSecret=abcdef123456',
  'db.password: abcdef123456',
  "{'password':'abcdef123456'}",
  'PASSWORD: abcdef123456',
  'client_secret=abcdef123456',
  'sk-ant-api03-abcdefghijklmnopqrstuvwx',
  'sk-proj-abcdefghijklmnopqrstuvwx',
  'https://user:p@ss@host/path',
  'http://bob:Winter@2026!@proxy:3128',
  'https://api.example.com/v1?key=AbCdEf1234567890xyz',
  'pass=hunter2hunter2',
  'https://example.com/x?sig=abcdefghijklmnop1234&se=1',
  ['sk','live','a'.repeat(30)].join('_'),
  ['rk','live','a'.repeat(30)].join('_'),
  'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
  'github_pat_11ABCDEFG0abcdefghijklmnopqrstuv',
  'glpat-abcdefghijklmnopqrstu',
  'xoxb-123456789012-abcdefghijkl',
  'AKIAABCDEFGHIJKLMNOP',
  'AIzaSyabcdefghijklmnopqrstuvwxyz0123456',
  'hf_abcdefghijklmnopqrstuvwxyz01234567',
  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnopqrstuvwxyz',
  '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmU\n-----END OPENSSH PRIVATE KEY-----',
];
// What is left of each once scrubbed must not hold the part that makes it a secret.
const GIVEAWAY = /abcdef123456|abcdefghijklmnop|dXNlcjpwYXNz|p4ssw0rd|s%3Aabcdef|b3BlbnNzaC1r|eyJhbGci|ghp_|github_pat_|glpat-|xoxb-|AKIA|AIza|hf_abc|sk-|p@ss|Winter|hunter2|AbCdEf|sk_live|rk_live|aaaaaaaaaa/;

test('what looks like a secret is taken out of a debug line, in a field, in the message and in the scope', () => {
  for (const secret of SECRETS) {
    assert.doesNotMatch(scrubSecrets(secret), GIVEAWAY, secret);
    assert.doesNotMatch(debugText('x', 'y', { note: secret }), GIVEAWAY, `as a field: ${secret}`);
    assert.doesNotMatch(debugText('x', `failed: ${secret}`), GIVEAWAY, `in the message: ${secret}`);
    assert.doesNotMatch(debugText(secret, 'y'), GIVEAWAY, `in the scope: ${secret}`);
  }
  // A secret long enough to be cut in the field is recognised before it is cut.
  const padded = `${'x'.repeat(110)} sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789`;
  assert.doesNotMatch(debugText('x', 'y', { note: padded }), /sk-|abcdefghij/);
});

test('what is not a secret is left alone, ids and counts and paths among it', () => {
  assert.equal(scrubSecrets('[tool] end tool=mcp outcome=ok ms=1520 session=k3Vx9aPq_zLm'), '[tool] end tool=mcp outcome=ok ms=1520 session=k3Vx9aPq_zLm');
  assert.equal(scrubSecrets('workspace=/home/me/repos/app/src/index.ts'), 'workspace=/home/me/repos/app/src/index.ts');
  assert.equal(scrubSecrets('a basic setup that was not bearer-checked'), 'a basic setup that was not bearer-checked');
  assert.equal(scrubSecrets('author=bob tokens_used=5 max_tokens=100 authority=x'), 'author=bob tokens_used=5 max_tokens=100 authority=x');
  assert.equal(scrubSecrets('monkey=1 passage=2 signal=3 keys=4 sort_key=5'), 'monkey=1 passage=2 signal=3 keys=4 sort_key=5');
  assert.equal(scrubSecrets('https://example.com/a/b@c?q=1'), 'https://example.com/a/b@c?q=1');
});

test('a long text is scrubbed in a moment, however it is built', () => {
  // The processor's time, not the clock's: a machine busy with other tests lets this wait for its turn for seconds, and a
  // pattern that backtracks is slow by orders of magnitude, in the time it takes and not in the time it waited.
  const began = process.cpuUsage();
  for (const text of ['a-'.repeat(20_000), 'token'.repeat(20_000), 'a'.repeat(100_000), 'x://'.repeat(20_000), 'Bearer ' + 'a'.repeat(100_000), '-----BEGIN PRIVATE KEY-----'.repeat(2000)]) {
    scrubSecrets(text);
    debugText('x', 'y', { note: text });
  }
  const out = printed('debug', () => console.debug('a-'.repeat(2_000_000)));
  assert.ok(out.length <= 16_100, `a raw debug line is cut before it is scanned, not ${out.length} characters`);
  const { user, system } = process.cpuUsage(began);
  assert.ok((user + system) / 1000 < 3000, `took ${Math.round((user + system) / 1000)} ms of processor time`);
});

test('the values of the process\'s own secret environment variables are taken out wherever they stand', () => {
  const names = ['PITHAGORAS_TEST_SECRET', 'MEMORY_TEST_AUTH_TOKEN', 'SOME_PASSWORD'];
  process.env.PITHAGORAS_TEST_SECRET = 'plain-value-with-no-shape-1';
  process.env.MEMORY_TEST_AUTH_TOKEN = 'another unshaped value 2';
  process.env.SOME_PASSWORD = 'short';
  try {
    const text = debugText('x', 'got plain-value-with-no-shape-1', { path: '/a/another unshaped value 2/b', word: 'short' });
    assert.doesNotMatch(text, /plain-value-with-no-shape-1|another unshaped value 2/);
    assert.match(text, /word=short/, 'a value under eight characters could be any word, and is left');
    const raw = printed('debug', () => console.debug('seen', process.env.PITHAGORAS_TEST_SECRET));
    assert.doesNotMatch(raw, /plain-value-with-no-shape-1/, 'console.debug passes the same filter');
    assert.doesNotMatch(readLogs().map((l) => l.text).join('\n'), /plain-value-with-no-shape-1/);
  } finally {
    for (const n of names) delete process.env[n];
  }
});

test('nothing a debug line was given reaches stdout or the list with a secret in it', () => {
  resetLogs();
  const out = printed('debug', () => {
    for (const secret of SECRETS) debugLog('x', 'y', { note: secret, other: `before ${secret} after` });
  });
  assert.doesNotMatch(out, GIVEAWAY);
  assert.doesNotMatch(readLogs().map((l) => l.text).join('\n'), GIVEAWAY);
  assert.equal(readLogs().length, SECRETS.length);
});

test('the environment sets the level and the size of the buffer, and says what it could not use', () => {
  assert.deepEqual(logSettings({}), { level: 'info', keep: 2000, chars: 2_000_000, problems: [] });
  assert.equal(logSettings({ PITHAGORAS_LOG_LEVEL: 'debug' }).level, 'debug');
  assert.equal(logSettings({ PITHAGORAS_LOG_LEVEL: ' DEBUG ' }).level, 'debug');
  assert.equal(logSettings({ PITHAGORAS_LOG_LEVEL: '' }).level, 'info');
  const odd = logSettings({ PITHAGORAS_LOG_LEVEL: 'loud' });
  assert.equal(odd.level, 'info');
  assert.match(odd.problems[0], /PITHAGORAS_LOG_LEVEL="loud" is not info or debug/);

  const sized = logSettings({ PITHAGORAS_LOG_LINES: '500', PITHAGORAS_LOG_CHARS: '1000000' });
  assert.deepEqual([sized.keep, sized.chars, sized.problems], [500, 1_000_000, []]);
  const bad = logSettings({ PITHAGORAS_LOG_LINES: 'many', PITHAGORAS_LOG_CHARS: '-5' });
  assert.deepEqual([bad.keep, bad.chars, bad.problems.length], [2000, 2_000_000, 2]);
  const out = logSettings({ PITHAGORAS_LOG_LINES: '5', PITHAGORAS_LOG_CHARS: '99999999999' });
  assert.deepEqual([out.keep, out.chars], [100, 20_000_000]);
  assert.match(out.problems.join('\n'), /PITHAGORAS_LOG_LINES=5 is outside 100 to 50000; using 100/);
});

test('a server started with the variables keeps what they say, prints at debug, and says what it ignored', () => {
  const logs = fileURLToPath(new URL('../dist/logs.js', import.meta.url));
  const script = `
    const logs = await import(${JSON.stringify(logs)});
    logs.installLogCapture();
    for (let i = 0; i < 300; i++) logs.recordLog('info', 'line ' + i);
    logs.debugLog('t', 'hello', { n: 1 });
    process.stderr.write(JSON.stringify({ keep: logs.LOG_KEEP, chars: logs.LOG_CHARS_MAX, level: logs.logLevel(), held: logs.readLogs().length, texts: logs.readLogs({ limit: 3 }).map((l) => [l.level, l.text]) }));
  `;
  const run = (env) => spawnSync(process.execPath, ['--input-type=module', '-e', script], { env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' });

  const sized = run({ PITHAGORAS_LOG_LEVEL: 'debug', PITHAGORAS_LOG_LINES: '150', PITHAGORAS_LOG_CHARS: '300000' });
  const answer = JSON.parse(sized.stderr.slice(sized.stderr.lastIndexOf('{')));
  assert.equal(answer.keep, 150);
  assert.equal(answer.chars, 300_000);
  assert.equal(answer.level, 'debug');
  assert.equal(answer.held, 150, 'the buffer is the size it was given');
  assert.match(sized.stdout, /\[t\] hello n=1/, 'the debug line is on stdout');
  assert.deepEqual(answer.texts.at(-1), ['debug', '[t] hello n=1']);

  const plain = run({});
  const answer2 = JSON.parse(plain.stderr.slice(plain.stderr.lastIndexOf('{')));
  assert.deepEqual([answer2.keep, answer2.chars, answer2.level, answer2.held], [2000, 2_000_000, 'info', 300]);
  assert.doesNotMatch(plain.stdout, /\[t\] hello/, 'and without the variable it prints nothing of it');
  assert.equal(answer2.texts.some(([level]) => level === 'debug'), false);

  const wrong = run({ PITHAGORAS_LOG_LEVEL: 'loud', PITHAGORAS_LOG_LINES: 'many' });
  assert.match(wrong.stderr, /\[logs\] PITHAGORAS_LOG_LEVEL="loud" is not info or debug; using info/);
  assert.match(wrong.stderr, /\[logs\] PITHAGORAS_LOG_LINES="many" is not a whole number; using 2000/);
});

test('GET /api/logs names the level and the limits, keeps the debug lines unless asked for less, and knows the debug level', async () => {
  resetLogs();
  recordLog('debug', 'fine detail');
  recordLog('info', 'plain');
  const all = await (await fetch(`${base}/logs`)).json();
  assert.equal(all.level, 'info', 'what the server runs at, not what its list holds');
  assert.equal(all.keep, LOG_KEEP);
  assert.equal(all.chars, LOG_CHARS_MAX);
  assert.deepEqual(all.lines.map((l) => [l.level, l.text]), [['debug', 'fine detail'], ['info', 'plain']]);
  const info = await (await fetch(`${base}/logs?level=info`)).json();
  assert.deepEqual(info.lines.map((l) => l.text), ['plain']);
  const debug = await (await fetch(`${base}/logs?level=debug`)).json();
  assert.equal(debug.lines.length, 2);

  setLogLevel('debug');
  try {
    assert.equal((await (await fetch(`${base}/logs`)).json()).level, 'debug');
  } finally {
    setLogLevel('info');
  }
  const download = await (await fetch(`${base}/logs/download`)).text();
  assert.match(download, /Z DEBUG fine detail\n/);
});
