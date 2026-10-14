import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acceptPrompt } from '../core/server/src/pi/accept-prompt.js';
const tick = () => new Promise(resolve => setImmediate(resolve));
test('voice prompt resolves at preflight acceptance without waiting for generation', async () => {
  let finish!: () => void; let running = true;
  await acceptPrompt(async accepted => { accepted(true); await new Promise<void>(resolve => { finish = resolve; }); running = false; }, () => {});
  assert.equal(running, true); finish(); await tick(); assert.equal(running, false);
});
test('preflight errors reject and later generation errors remain observable', async () => {
  await assert.rejects(acceptPrompt(async accepted => { accepted(false); throw new Error('Rejected'); }, () => {}), /Rejected/);
  const errors: unknown[] = []; let fail!: (error: Error) => void;
  await acceptPrompt(async accepted => { accepted(true); await new Promise<void>((_, reject) => { fail = reject; }); }, error => errors.push(error));
  fail(new Error('Late failure')); await tick(); assert.equal((errors[0] as Error).message, 'Late failure');
});
