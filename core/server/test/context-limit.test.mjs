import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import { inProcessHome } from './server-harness.mjs';

const dataDir = inProcessHome('pithagoras-ctx-');
const { getContextLimit, setContextLimit, getDefaultContextLimit, setDefaultContextLimit, contextWindowFor, contextLimitProblem, noteServerWindow, getDb } =
  await import('../dist/db.js');
const { SdkPiClient } = await import('../dist/pi/sdk-client.js');
test.after(() => getDb().close());

/** A client around a stand-in session: only what applyContextLimit touches. */
function clientFor(model, declared) {
  const session = {
    agent: { state: { model } },
    get model() { return this.agent.state.model; },
  };
  const client = Object.create(SdkPiClient.prototype);
  client.session = session;
  client.definitionWindows = new Map();
  // `registry.gone` stands for a provider that is no longer there to look the model up in.
  const registry = { gone: false };
  client.modelRuntime = { getModel: () => (registry.gone ? undefined : { ...model, contextWindow: declared }) };
  return { client, session, registry };
}

test('a limit belongs to one model, and can be taken away', () => {
  assert.equal(getContextLimit('llama-swap', 'big'), undefined);
  setContextLimit('llama-swap', 'big', 131072);
  assert.equal(getContextLimit('llama-swap', 'big'), 131072);
  assert.equal(getContextLimit('llama-swap', 'small'), undefined);
  assert.equal(getContextLimit('other', 'big'), undefined);
  setContextLimit('llama-swap', 'big', 65536);
  assert.equal(getContextLimit('llama-swap', 'big'), 65536);
  setContextLimit('llama-swap', 'big', null);
  assert.equal(getContextLimit('llama-swap', 'big'), undefined);
});

test('the session runs on the limit, not on what the model definition says', () => {
  setContextLimit('p', 'm', 131072);
  const model = { provider: 'p', id: 'm', name: 'M', contextWindow: 262144 };
  const { client, session } = clientFor(model, 262144);
  client.applyContextLimit();
  assert.equal(session.model.contextWindow, 131072);
  assert.equal(session.model.id, 'm');
  assert.equal(model.contextWindow, 262144, 'the definition itself is not touched');
});

test('taking the limit away puts the definition back, in a session that is already open', () => {
  setContextLimit('p', 'm2', 131072);
  const { client, session } = clientFor({ provider: 'p', id: 'm2', contextWindow: 262144 }, 262144);
  client.applyContextLimit();
  assert.equal(session.model.contextWindow, 131072);
  setContextLimit('p', 'm2', null);
  client.applyContextLimit();
  assert.equal(session.model.contextWindow, 262144);
});

test('a model with no limit is left exactly as it was', () => {
  const model = { provider: 'p', id: 'none', contextWindow: 200000 };
  const { client, session } = clientFor(model, 200000);
  client.applyContextLimit();
  assert.equal(session.agent.state.model, model);
});

test('the default is a ceiling: it lowers a model, never raises one, and a model of its own beats it', () => {
  assert.equal(getDefaultContextLimit(), undefined);
  assert.equal(contextWindowFor('p', 'a', 262144), 262144, 'no default: what the model says');
  setDefaultContextLimit(131072);
  assert.equal(getDefaultContextLimit(), 131072);
  assert.equal(contextWindowFor('p', 'a', 262144), 131072, 'a bigger model is held to it');
  assert.equal(contextWindowFor('p', 'a', 32768), 32768, 'a smaller one keeps its own');
  assert.equal(contextWindowFor('p', 'a', undefined), 131072, 'a model that says nothing gets it');
  setContextLimit('p', 'a', 200000);
  assert.equal(contextWindowFor('p', 'a', 262144), 200000, 'the setting for the model wins, even above the default');
  setContextLimit('p', 'a', null);
  setDefaultContextLimit(null);
  assert.equal(contextWindowFor('p', 'a', 262144), 262144);
  assert.equal(contextWindowFor('p', 'a', undefined), undefined);
});

test('a session follows the default, and lets go of it when it is removed', () => {
  const { client, session } = clientFor({ provider: 'p', id: 'd', contextWindow: 262144 }, 262144);
  setDefaultContextLimit(131072);
  client.applyContextLimit();
  assert.equal(session.model.contextWindow, 131072);
  setDefaultContextLimit(null);
  client.applyContextLimit();
  assert.equal(session.model.contextWindow, 262144);
});

test('only whole numbers in range are accepted as a window', () => {
  assert.equal(contextLimitProblem(131072), undefined);
  for (const bad of [0, 1023, 10_000_001, 1.5, '131072', NaN, null, undefined, {}]) {
    assert.match(contextLimitProblem(bad), /whole number between 1,024 and 10,000,000/, String(bad));
  }
});

test('a model pi puts back, as it does on /reload, is given the window again', () => {
  setContextLimit('p', 'r', 65536);
  const { client, session } = clientFor({ provider: 'p', id: 'r', contextWindow: 131072 }, 131072);
  client.applyContextLimit();
  assert.equal(session.model.contextWindow, 65536);
  // pi swaps in the registry's own object when a provider registers again.
  session.agent.state.model = { provider: 'p', id: 'r', contextWindow: 131072 };
  client.applyContextLimit();
  assert.equal(session.model.contextWindow, 65536);
  setContextLimit('p', 'r', null);
});

test('Reset works when the registry can no longer say what the model declares', () => {
  setContextLimit('p', 'g', 65536);
  const { client, session, registry } = clientFor({ provider: 'p', id: 'g', contextWindow: 131072 }, 131072);
  client.applyContextLimit();
  assert.equal(session.model.contextWindow, 65536);
  registry.gone = true;
  setContextLimit('p', 'g', null);
  client.applyContextLimit();
  assert.equal(session.model.contextWindow, 131072, 'back to what it declared, not left lowered');
});

test('a model that declares less than the default is not raised when the registry has lost it', () => {
  setDefaultContextLimit(131072);
  const { client, session, registry } = clientFor({ provider: 'p', id: 's', contextWindow: 32768 }, 32768);
  client.applyContextLimit();
  registry.gone = true;
  client.applyContextLimit();
  assert.equal(session.model.contextWindow, 32768);
  setDefaultContextLimit(null);
});

test('one chat that cannot take the window does not stop the others getting it', async () => {
  const { sessions } = await import('../dist/session-manager.js');
  const got = [];
  const errors = [];
  const log = console.error;
  console.error = (m) => errors.push(m);
  sessions.live.set('bad', { client: { applyContextLimit() { throw new Error('torn down'); } } });
  sessions.live.set('good', { client: { applyContextLimit() { got.push('good'); } } });
  try {
    assert.doesNotThrow(() => sessions.applyContextLimits());
  } finally {
    console.error = log;
    sessions.live.clear();
  }
  assert.deepEqual(got, ['good']);
  assert.match(errors.join(), /bad.*torn down/);
});

test('a window that cannot be applied costs the run and the config nothing', () => {
  const { client } = clientFor({ provider: 'p', id: 'q', contextWindow: 1000 }, 1000);
  client.session = { get model() { throw new Error('agent is gone'); } };
  const errors = [];
  const log = console.error;
  console.error = (m) => errors.push(m);
  try {
    assert.throws(() => client.applyContextLimit(), /agent is gone/, 'the plain call still says so');
    assert.doesNotThrow(() => client.applyLimitQuietly());
  } finally {
    console.error = log;
  }
  assert.match(errors.join(), /could not apply the context window: agent is gone/);
});

test('what the server says it holds caps the window, whatever was set, until a window is set by hand', () => {
  const { client, session } = clientFor({ provider: 'p', id: 'served', contextWindow: 131072 }, 131072);
  setContextLimit('p', 'served', 200000);
  client.applyContextLimit();
  assert.equal(session.model.contextWindow, 200000);
  assert.equal(noteServerWindow('p', 'served', 32768), true);
  client.applyContextLimit();
  assert.equal(session.model.contextWindow, 32768, 'a window set for the model that the server cannot hold was a mistake');
  assert.equal(contextWindowFor('p', 'served', 131072), 32768);
  // Said again, or said to be bigger: nothing new. Another model's is its own.
  assert.equal(noteServerWindow('p', 'served', 32768), false);
  assert.equal(noteServerWindow('p', 'served', 65536), false);
  assert.equal(contextWindowFor('p', 'other', 131072), 131072);
  assert.equal(noteServerWindow('p', 'served', 16384), true, 'a smaller one goes on');
  assert.equal(contextWindowFor('p', 'served', 131072), 16384);
  // A person's window for the model is the last word.
  setContextLimit('p', 'served', 65536);
  assert.equal(contextWindowFor('p', 'served', 131072), 65536);
  setContextLimit('p', 'served', null);
});

test('the server\'s window never raises a smaller one, and a number that is no window is ignored', () => {
  assert.equal(noteServerWindow('p', 'roomy', 262144), true);
  assert.equal(contextWindowFor('p', 'roomy', 32768), 32768, 'the model declares less');
  assert.equal(contextWindowFor('p', 'roomy', undefined), 262144, 'and one that says nothing has the server\'s');
  for (const bad of [0, 100, -5, 1.5, NaN]) assert.equal(noteServerWindow('p', 'junk', bad), false, String(bad));
  assert.equal(contextWindowFor('p', 'junk', 4096), 4096);
});

test('a chat learns the window of its server from the refusal, is told, and compacts to fit it', async () => {
  const { sessions } = await import('../dist/session-manager.js');
  const { createSession, eventsSince } = await import('../dist/db.js');
  const model = { provider: 'p', id: 'refused', contextWindow: 131072 };
  const { client, session } = clientFor(model, 131072);
  session.settingsManager = (await import('@earendil-works/pi-coding-agent')).SettingsManager.inMemory({});
  client.getState = async () => ({ model: { ...session.model, name: 'refused' } });
  client.applyContextLimit();
  createSession({ id: 'refused-chat', title: 'refused', workspace: dataDir, executor: 'host' });
  sessions.live.set('refused-chat', { client });
  try {
    await sessions.reportServerWindow('refused-chat', 'refused', 14000);
    assert.equal(session.model.contextWindow, 14000);
    const compaction = session.settingsManager.getCompactionSettings(session.model);
    assert.ok(compaction.keepRecentTokens < 14000 / 2, 'what is kept leaves room in the window the server has');
    const notices = eventsSince('refused-chat').filter((r) => r.type === 'portal_notice').map((r) => JSON.parse(r.payload));
    assert.equal(notices.length, 1);
    assert.match(notices[0].text, /holds 14,000 tokens of context for a chat, not the 131,072 this chat counted on/);
    // Said again by the next refusal: not told again.
    await sessions.reportServerWindow('refused-chat', 'refused', 14000);
    assert.equal(eventsSince('refused-chat').filter((r) => r.type === 'portal_notice').length, 1);
    // Another model of the chat is none of its business.
    await sessions.reportServerWindow('refused-chat', 'someone-else', 5000);
    assert.equal(session.model.contextWindow, 14000);
  } finally {
    sessions.live.delete('refused-chat');
  }
});
