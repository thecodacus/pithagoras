import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VoiceClips } from '../server/src/voice-clips.js';
import { fillerPhrases } from '../server/src/voice-phrases.js';

const root = mkdtempSync(join(tmpdir(), 'pithagoras-clips-'));
after(() => rmSync(root, { recursive: true, force: true }));
const pcm = Buffer.from([0, 0, 255, 127]);
function store(patch: Partial<ConstructorParameters<typeof VoiceClips>[0]> = {}) {
  const rendered: string[] = [];
  let version = 'a'.repeat(32);
  const clips = new VoiceClips({ root, version: () => version, enabled: () => true, quietMs: 0,
    render: async text => { rendered.push(text); return pcm; }, ...patch });
  return { clips, rendered, setVersion: (v: string) => { version = v; } };
}

test('clips render once per voice and language and survive a new store', async () => {
  const first = store();
  assert.ok((await first.clips.list('de')).clips.every(clip => !clip.ready));
  await first.clips.warm('de');
  assert.equal(first.rendered.length, fillerPhrases('de').length);
  const list = await first.clips.list('de');
  assert.ok(list.clips.every(clip => clip.ready));
  assert.deepEqual(await first.clips.read(list.version, list.clips[0].hash), pcm);
  assert.equal(list.notices.compactionDone, 'Die Zusammenfassung ist fertig. Ich kann weitermachen.');
  // A restarted portal finds them on disk and renders nothing.
  const restarted = store();
  await restarted.clips.warm('de');
  assert.deepEqual(restarted.rendered, []);
});

test('rendering waits for live speech to finish', async () => {
  const { clips, rendered } = store({ version: () => 'b'.repeat(32), quietMs: 50 });
  const done = clips.liveRequest();
  const warming = clips.warm('en');
  await new Promise(r => setTimeout(r, 300));
  assert.equal(rendered.length, 0);
  done(); await warming;
  assert.equal(rendered.length, fillerPhrases('en').length);
  clips.close();
});

test('a voice change mid-batch renders the rest in the new voice; disabled renders nothing', async () => {
  const s = store();
  s.setVersion('c'.repeat(32));
  let switched = false;
  const clips = new VoiceClips({ root, version: () => switched ? 'd'.repeat(32) : 'c'.repeat(32), enabled: () => true, quietMs: 0,
    render: async () => { switched = true; return pcm; } });
  await clips.warm('de');
  assert.equal(readdirSync(join(root, 'c'.repeat(32))).length, 1);
  assert.ok((await clips.list('de')).clips.every(clip => clip.ready));
  let calls = 0;
  const off = new VoiceClips({ root, version: () => 'e'.repeat(32), enabled: () => false, render: async () => { calls++; return pcm; } });
  await off.warm('en');
  assert.equal(calls, 0);
});

test('invalid ids cannot read outside the store, and old voices are pruned', async () => {
  const { clips } = store();
  assert.equal(await clips.read('../x', 'a'.repeat(64)), undefined);
  for (const v of ['1', '2', '3', '4', '5']) mkdirSync(join(root, v.repeat(32)), { recursive: true });
  mkdirSync(join(root, 'f'.repeat(32)), { recursive: true });
  writeFileSync(join(root, 'f'.repeat(32), `${'0'.repeat(64)}.pcm`), pcm);
  const pruned = new VoiceClips({ root, version: () => 'f'.repeat(32), enabled: () => true, quietMs: 0, keep: 2, render: async () => pcm });
  await pruned.warm('en');
  const kept = readdirSync(root).filter(name => /^[0-9a-f]{32}$/.test(name));
  assert.equal(readdirSync(join(root, 'f'.repeat(32))).length, fillerPhrases('en').length);
  assert.equal(kept.length, 2); assert.ok(kept.includes('f'.repeat(32)));
});

test('clients asking for a language are remembered for the next warm-up', async () => {
  const { clips } = store();
  await clips.remember('de'); await clips.remember('fr'); await clips.remember('de');
  assert.deepEqual(await clips.known(), ['de', 'fr']);
});
