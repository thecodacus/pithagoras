import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';

// What the page's requests do when the portal does not answer, or no longer knows this browser.
const heard: string[] = [];
const events = new EventTarget();
events.addEventListener('pithagoras:signed-out', () => heard.push('signed-out'));
(globalThis as any).window = Object.assign(events, { localStorage: { getItem: () => null, setItem() {}, removeItem() {} } });
const { api, json, ApiError, SIGNED_OUT } = await import('../core/web/src/api.ts');

type Answer = Response | Error;
const answer = (what: Answer) => {
  (globalThis as any).fetch = async (url: string, init?: RequestInit) => {
    seen.push({ url, init });
    if (what instanceof Error) throw what;
    return what;
  };
};
const seen: { url: string; init?: RequestInit }[] = [];
beforeEach(() => { heard.length = 0; seen.length = 0; });
const reply = (status: number, body: string, headers: Record<string, string> = {}) => new Response(body, { status, headers });

test('a portal that does not answer is said in words, not in what the browser calls it', async () => {
  for (const text of ['Failed to fetch', 'Load failed', 'NetworkError when attempting to fetch resource.']) {
    answer(new TypeError(text));
    await assert.rejects(json('/api/sessions'), (e: any) => e instanceof ApiError && e.status === 0 && e.message === 'Cannot reach the portal');
  }
});

test('an aborted request says so itself', async () => {
  answer(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
  await assert.rejects(json('/api/sessions'), (e: any) => e.name === 'AbortError');
});

test('speech sent to be transcribed goes through the same path: a login that is gone is heard, a page that is not JSON is not parsed', async () => {
  answer(reply(401, '{"error":"Unauthorized"}'));
  await assert.rejects(api.transcribe('s1', new Float32Array(160)), (e: any) => e instanceof ApiError && e.status === 401 && e.message === 'Unauthorized');
  assert.deepEqual(heard, ['signed-out']);
  answer(reply(502, '<h1>Bad Gateway</h1>'));
  await assert.rejects(api.transcribe('s1', new Float32Array(160)), (e: any) => e instanceof ApiError && e.status === 502 && e.message === 'Transcription failed');
  answer(new TypeError('Failed to fetch'));
  await assert.rejects(api.transcribe('s1', new Float32Array(160)), (e: any) => e.message === 'Cannot reach the portal');
  answer(reply(200, '{"text":"Hello there"}', { 'server-timing': 'stt;dur=12' }));
  assert.deepEqual(await api.transcribe('s1', new Float32Array(160)), { text: 'Hello there', serverTiming: 'stt;dur=12' });
  assert.equal(seen.at(-1)!.url, '/api/sessions/s1/voice/transcribe');
  assert.equal((seen.at(-1)!.init!.headers as any)['Content-Type'], 'audio/wav');
  answer(reply(200, '{"text":"Hello there"}'));
  await api.transcribe('s1', new Float32Array(160), undefined, 'dictation');
  assert.equal(seen.at(-1)!.url, '/api/sessions/s1/voice/transcribe?purpose=dictation');
});

test('a file sent from this computer is as much a request: a gone login is heard, the portal being away is said, a refusal is an ApiError', async () => {
  const file = new File(['x'], 'notes.txt');
  answer(reply(401, '{}'));
  await assert.rejects(api.uploadFile('s1', '', file), (e: any) => e instanceof ApiError && e.status === 401);
  assert.deepEqual(heard, ['signed-out']);
  answer(reply(502, '<h1>Bad Gateway</h1>'));
  await assert.rejects(api.uploadFile('s1', '', file), (e: any) => e instanceof ApiError && e.message === 'Could not upload notes.txt (502)');
  answer(reply(413, '{"error":"File too large"}'));
  await assert.rejects(api.uploadFile('s1', '', file), (e: any) => e instanceof ApiError && e.status === 413 && e.message === 'File too large');
  answer(new TypeError('Load failed'));
  await assert.rejects(api.uploadFile('s1', '', file), (e: any) => e.message === 'Cannot reach the portal');
  answer(reply(200, '{"path":"notes.txt","size":1}'));
  assert.deepEqual(await api.uploadFile('s1', '', file), { path: 'notes.txt', size: 1 });
  assert.equal(seen.at(-1)!.url, '/api/sessions/s1/upload?path=&name=notes.txt');
  assert.equal(SIGNED_OUT, 'pithagoras:signed-out');
});
