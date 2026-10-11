import test from 'node:test';
import assert from 'node:assert/strict';
import { inProcessHome } from './helpers.mts';
inProcessHome('pitha-voice-model-');
const { SdkPiClient } = await import('../server/src/pi/sdk-client.ts');
const { getDb, putSetting } = await import('../server/src/db.ts');
test.after(() => getDb().close());

const chat = { provider: 'slow', id: 'big', name: 'Big', contextWindow: 1000 };
const fast = { provider: 'fast', id: 'small', name: 'Small', contextWindow: 1000 };

/** A client over a session that records what it was asked, with a model of each kind known to the registry. */
function clientOn(idle = true) {
  const session: any = { model: chat, isIdle: idle, agent: { state: { model: chat } } };
  Object.defineProperty(session, 'model', { get: () => session.agent.state.model });
  const runtime = { getModel: (provider: string, id: string) => [chat, fast].find((m) => m.provider === provider && m.id === id) };
  const client: any = new (SdkPiClient as any)(session, runtime, () => {});
  return { client, session };
}
const save = (voiceModel: string) => putSetting('voice', JSON.stringify({ voiceModel }));

test('a spoken turn runs on the voice model and the chat gets its own back once the run has settled', () => {
  const { client, session } = clientOn();
  save('fast/small');
  client.useVoiceModel();
  assert.equal(session.agent.state.model.id, 'small');
  // The chat's pick is not touched: that is what the model picker reads.
  client.restoreChatModel();
  assert.equal(session.agent.state.model, chat);
  // Nothing left to put back.
  client.restoreChatModel();
  assert.equal(session.agent.state.model, chat);
});

test('no voice model, or one the chat is on already, changes nothing', () => {
  const { client, session } = clientOn();
  save('');
  client.useVoiceModel();
  assert.equal(session.agent.state.model, chat);
  save('slow/big');
  client.useVoiceModel();
  assert.equal(session.agent.state.model, chat);
  assert.equal(client.displaced, undefined);
});

test('a voice model the registry does not know leaves the chat on its model', (t) => {
  t.mock.method(console, 'error', () => {});
  const { client, session } = clientOn();
  save('gone/missing');
  client.useVoiceModel();
  assert.equal(session.agent.state.model, chat);
  assert.equal(client.displaced, undefined);
});

test('a spoken message into a run that is going keeps the run on its model', () => {
  const { client, session } = clientOn(false);
  save('fast/small');
  client.useVoiceModel();
  assert.equal(session.agent.state.model, chat);
});

test('a model the person picked during the run stays', () => {
  const { client, session } = clientOn();
  save('fast/small');
  client.useVoiceModel();
  const picked = { provider: 'other', id: 'pick', contextWindow: 1000 };
  session.agent.state.model = picked;
  client.restoreChatModel();
  assert.equal(session.agent.state.model, picked);
});

test('the chat goes back even when the voice model was changed in the settings during the run', () => {
  const { client, session } = clientOn();
  save('fast/small');
  client.useVoiceModel();
  save('');
  client.restoreChatModel();
  assert.equal(session.agent.state.model, chat);
});
