import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { inProcessHome } from './server-harness.mjs';

const home = inProcessHome('pithagoras-compaction-fit-');
const { getDb } = await import('../dist/db.js');
const { configuredCompaction, fitCompaction } = await import('../dist/pi-settings.js');
const { SdkPiClient } = await import('../dist/pi/sdk-client.js');
const { SettingsManager, SessionManager, findCutPoint } = await import('@earendil-works/pi-coding-agent');
test.after(() => getDb().close());

const piDefaults = { reserveTokens: 16384, keepRecentTokens: 20000 };

function settingsFile(compaction) {
  mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
  writeFileSync(join(process.env.PI_CODING_AGENT_DIR, 'settings.json'), JSON.stringify(compaction ? { compaction } : {}));
}

test('a window of 128k or more keeps pi\'s numbers, a smaller one gets what it can bear', () => {
  for (const window of [131072, 262144, 1_000_000]) assert.deepEqual(fitCompaction(window, piDefaults), piDefaults, String(window));
  assert.deepEqual(fitCompaction(65536, piDefaults), { reserveTokens: 16384, keepRecentTokens: 10922 });
  assert.deepEqual(fitCompaction(32768, piDefaults), { reserveTokens: 8192, keepRecentTokens: 5461 });
  // pi asks for no answer beyond what is left of the window less 4096 tokens: held back from there on, at least.
  assert.deepEqual(fitCompaction(16384, piDefaults), { reserveTokens: 6144, keepRecentTokens: 2730 });
  assert.deepEqual(fitCompaction(8192, piDefaults), { reserveTokens: 4096, keepRecentTokens: 1365 });
});

test('numbers chosen lower than the window allows are left as they are, and a window that is not known changes nothing', () => {
  assert.deepEqual(fitCompaction(32768, { reserveTokens: 5000, keepRecentTokens: 3000 }), { reserveTokens: 5000, keepRecentTokens: 3000 });
  for (const window of [0, NaN, -1]) assert.deepEqual(fitCompaction(window, piDefaults), piDefaults);
});

test('the numbers in pi\'s file are read the way pi reads them, a model\'s own before the ordinary setting', () => {
  settingsFile(undefined);
  assert.deepEqual(configuredCompaction('p/m'), piDefaults);
  settingsFile({ keepRecentTokens: 12000, reserveTokens: 9000, modelOverrides: { 'p/m': { keepRecentTokens: 7000 }, 'p/other': 'junk' } });
  assert.deepEqual(configuredCompaction('p/m'), { reserveTokens: 9000, keepRecentTokens: 7000 });
  assert.deepEqual(configuredCompaction('p/other'), { reserveTokens: 9000, keepRecentTokens: 12000 });
  assert.deepEqual(configuredCompaction('q/x'), { reserveTokens: 9000, keepRecentTokens: 12000 });
  // What pi would refuse is not taken.
  settingsFile({ keepRecentTokens: -5, reserveTokens: 'many' });
  assert.deepEqual(configuredCompaction('p/m'), piDefaults);
});

/** A client around a stand-in session with a real settings manager: what applyContextLimit touches. */
function clientFor(model) {
  const settingsManager = SettingsManager.inMemory({});
  const session = { settingsManager, agent: { state: { model } }, get model() { return this.agent.state.model; } };
  const client = Object.create(SdkPiClient.prototype);
  client.session = session;
  client.definitionWindows = new Map();
  client.modelRuntime = { getModel: () => model };
  return { client, session };
}

test('a session on a small window runs pi\'s compaction on numbers that window can bear', () => {
  settingsFile(undefined);
  const model = { provider: 'p', id: 'small', contextWindow: 16384 };
  const { client, session } = clientFor(model);
  assert.deepEqual(session.settingsManager.getCompactionSettings(model), { enabled: true, ...piDefaults });
  client.applyContextLimit();
  assert.deepEqual(session.settingsManager.getCompactionSettings(model), { enabled: true, reserveTokens: 6144, keepRecentTokens: 2730 });
  // Only this model's: another one in the same session is left to the file.
  assert.deepEqual(session.settingsManager.getCompactionSettings({ provider: 'p', id: 'other' }), { enabled: true, ...piDefaults });
});

test('a session on a big window is left as the file has it', () => {
  settingsFile({ keepRecentTokens: 12000 });
  const model = { provider: 'p', id: 'big', contextWindow: 262144 };
  const { client, session } = clientFor(model);
  client.applyContextLimit();
  assert.deepEqual(session.settingsManager.getCompactionSettings(model), { enabled: true, reserveTokens: 16384, keepRecentTokens: 12000 });
});

test('the numbers follow the window when it changes, and come back when the file is read again', async () => {
  settingsFile(undefined);
  const model = { provider: 'p', id: 'moving', contextWindow: 32768 };
  const { client, session } = clientFor(model);
  client.applyContextLimit();
  assert.equal(session.settingsManager.getCompactionSettings(model).keepRecentTokens, 5461);
  // A bigger window: what was held down for the small one is not kept.
  session.agent.state.model = { ...model, contextWindow: 262144 };
  client.modelRuntime = { getModel: () => session.agent.state.model };
  client.applyContextLimit();
  assert.deepEqual(session.settingsManager.getCompactionSettings(session.model), { enabled: true, ...piDefaults });
  // "Keep recent" saved in the UI reaches an open session through a re-read, which drops every override.
  session.agent.state.model = { ...model, contextWindow: 32768 };
  client.modelRuntime = { getModel: () => session.agent.state.model };
  client.applyContextLimit();
  settingsFile({ keepRecentTokens: 3000 });
  await client.refreshSettings();
  assert.equal(session.settingsManager.getCompactionSettings(session.model).keepRecentTokens, 3000);
  assert.equal(session.settingsManager.getCompactionSettings(session.model).reserveTokens, 8192);
});

test('a chat that has not outgrown pi\'s "keep recent" has nothing to compact there, and has something on the window\'s numbers', () => {
  // About 11000 tokens of conversation in a 16k window: what a chat looks like when the model has little room left.
  const sessionManager = SessionManager.inMemory();
  for (let i = 0; i < 12; i++) {
    sessionManager.appendMessage({ role: 'user', content: [{ type: 'text', text: `question ${i} ` + 'x'.repeat(1800) }], timestamp: i });
    sessionManager.appendMessage({
      role: 'assistant', content: [{ type: 'text', text: `answer ${i} ` + 'y'.repeat(1800) }], api: 'openai-completions', provider: 'p', model: 'm',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: 'stop', timestamp: i,
    });
  }
  const entries = sessionManager.getBranch();
  const kept = (keepRecentTokens) => findCutPoint(entries, 0, entries.length, keepRecentTokens).firstKeptEntryIndex;
  assert.equal(kept(piDefaults.keepRecentTokens), 0, 'pi keeps everything: nothing is left to summarise');
  assert.ok(kept(fitCompaction(16384, piDefaults).keepRecentTokens) > 0);
});
