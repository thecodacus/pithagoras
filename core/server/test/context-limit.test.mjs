import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import { inProcessHome } from './server-harness.mjs';

const dataDir = inProcessHome('pithagoras-ctx-');
const { getContextLimit, setContextLimit, getDefaultContextLimit, setDefaultContextLimit, contextWindowFor, contextLimitProblem, getDb } =
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
