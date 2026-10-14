import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { LlamaSessionCache } from '../core/server/src/llama-session-cache.js';
test('save and restore stay serialized with inference, and resident sessions skip restore', async () => {
 const events: string[] = [];
 const server = http.createServer((req,res) => { req.resume(); req.on('end', () => { const url = new URL(req.url!, 'http://local'); res.setHeader('Content-Type','application/json'); if (url.pathname === '/props') return res.end(JSON.stringify({ total_slots: 1 })); events.push(url.searchParams.get('action')!); res.end(JSON.stringify({ n_saved: 100, n_restored: 100 })); }); });
 await new Promise<void>(r => server.listen(0,'127.0.0.1',r));
 try {
  const origin = `http://127.0.0.1:${(server.address() as any).port}`, cache = new LlamaSessionCache(), signal = new AbortController().signal;
  const run = (session: string) => cache.run(origin,'model',session,signal,async () => { events.push(session); return true; });
  await Promise.all([run('a'),run('a'),run('b')]);
  assert.deepEqual(events,['restore','a','save','a','save','restore','b','save']);
 } finally { await new Promise<void>(r => server.close(()=>r())); }
});

// A server with more than one slot: what is saved and restored is slot 0, which may be another conversation's.
async function serverWith(props: (res: http.ServerResponse) => void) {
 const slotCalls: string[] = [];
 const server = http.createServer((req,res) => { req.resume(); req.on('end', () => { const url = new URL(req.url!, 'http://local'); if (url.pathname === '/props') return props(res); slotCalls.push(url.pathname + url.search); res.setHeader('Content-Type','application/json'); res.end(JSON.stringify({ n_saved: 100, n_restored: 100 })); }); });
 await new Promise<void>(r => server.listen(0,'127.0.0.1',r));
 return { slotCalls, origin: `http://127.0.0.1:${(server.address() as any).port}`, close: () => new Promise<void>(r => server.close(() => r())) };
}
/** Two runs on one model, the second begun while the first is still going: whether they overlapped. */
async function overlapped(origin: string) {
 const cache = new LlamaSessionCache(), signal = new AbortController().signal;
 let running = 0, most = 0;
 const work = async () => { most = Math.max(most, ++running); await new Promise(r => setTimeout(r, 40)); running--; return true; };
 await Promise.all([cache.run(origin,'model','a',signal,work), cache.run(origin,'model','b',signal,work)]);
 return most > 1;
}
test('a server with several slots runs requests side by side, and takes no snapshot', async () => {
 const many = await serverWith(res => { res.setHeader('Content-Type','application/json'); res.end(JSON.stringify({ total_slots: 4 })); });
 try {
  assert.equal(await overlapped(many.origin), true);
  assert.deepEqual(many.slotCalls, []);
 } finally { await many.close(); }
});
test('a server with one slot, or that does not say, is serialized and snapshotted as before', async () => {
 const one = await serverWith(res => { res.setHeader('Content-Type','application/json'); res.end(JSON.stringify({ total_slots: 1 })); });
 const silent = await serverWith(res => { res.statusCode = 404; res.end(); });
 try {
  assert.equal(await overlapped(one.origin), false);
  assert.ok(one.slotCalls.some(c => c.includes('action=save')));
  assert.equal(await overlapped(silent.origin), false);
  assert.ok(silent.slotCalls.some(c => c.includes('action=save')));
 } finally { await one.close(); await silent.close(); }
});
