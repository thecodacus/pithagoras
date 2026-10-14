import test from 'node:test';
import assert from 'node:assert/strict';
import { inProcessHome } from './helpers.mts';
inProcessHome('pitha-voice-model-');
const { SdkPiClient } = await import('../core/server/src/pi/sdk-client.ts');
const { getDb, putSetting, createSession, getSession, keepChatModel } = await import('../core/server/src/db.ts');
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

/**
 * A client over a session that runs like pi's: prompt() takes the message,
 * starts a run (not idle, on whatever model is in the agent's state then) and
 * holds until the test ends it. Ending it marks the session idle and then
 * emits agent_settled to the client, as the subscription in create() does.
 * `refuse` makes prompt() throw before it takes the message.
 */
function running(refuse = false) {
  const { client, session } = clientOn();
  const ran: string[] = [];
  let finish: (error?: Error) => void = () => {};
  session.prompt = (_text: string, options: any) =>
    new Promise<void>((resolve, reject) => {
      if (refuse) return reject(new Error('refused'));
      options.preflightResult(true);
      session.isIdle = false;
      ran.push(session.agent.state.model.id);
      finish = (error) => (error ? reject(error) : resolve());
    });
  /** The run ends: pi is idle first, then it settles; a failed run throws after that. */
  const end = async (error?: Error) => {
    session.isIdle = true;
    client.noteRun({ type: 'agent_settled' });
    finish(error);
    await new Promise((r) => setImmediate(r));
  };
  return { client, session, ran, end };
}
const save = (voiceModel: string) => putSetting('voice', JSON.stringify({ voiceModel }));

test('a spoken turn runs on the voice model and the chat gets its own back once the run has settled', async () => {
  const { client, session, ran, end } = running();
  save('fast/small');
  assert.equal((await client.prompt('hi', { voice: true })).outcome, 'started');
  // The run is on the voice model; the chat's pick is not touched.
  assert.deepEqual(ran, ['small']);
  assert.equal(session.agent.state.model.id, 'small');
  await end();
  assert.equal(session.agent.state.model, chat);
});

test('the chat gets its own model back when a spoken run is stopped', async () => {
  const { client, session, end } = running();
  save('fast/small');
  await client.prompt('hi', { voice: true });
  // Stop: pi settles from the finally of the aborted run.
  session.abort = async () => end(new Error('aborted'));
  await client.abort();
  assert.equal(session.agent.state.model, chat);
});

test('the chat gets its own model back when a spoken run fails', async () => {
  const { client, session, end } = running();
  save('fast/small');
  const events: any[] = [];
  client.on('event', (e: any) => events.push(e));
  await client.prompt('hi', { voice: true });
  await end(new Error('model gone'));
  assert.equal(session.agent.state.model, chat);
  assert.ok(events.some((e) => e.type === 'portal_failed'));
});

test('a spoken message pi refuses leaves the chat on its model', async () => {
  const { client, session } = running(true);
  save('fast/small');
  await assert.rejects(client.prompt('hi', { voice: true }), /refused/);
  assert.equal(session.agent.state.model, chat);
  assert.equal(client.displaced, undefined);
});

test('a spoken message an extension handles leaves the chat on its model', async () => {
  const { client, session } = clientOn();
  session.prompt = async (_text: string, options: any) => options.preflightResult(true);
  save('fast/small');
  assert.equal((await client.prompt('/cmd', { voice: true })).outcome, 'handled');
  assert.equal(session.agent.state.model, chat);
});

test('a typed message, or no voice model, keeps the run on the chat model', async () => {
  const typed = running();
  save('fast/small');
  await typed.client.prompt('hi');
  assert.deepEqual(typed.ran, ['big']);
  const plain = running();
  save('');
  await plain.client.prompt('hi', { voice: true });
  assert.deepEqual(plain.ran, ['big']);
});

test('a spoken message into a run that is going keeps the run on its model', async () => {
  const { client, session, ran, end } = running();
  save('');
  await client.prompt('first');
  save('fast/small');
  session.prompt = (_t: string, options: any) => { options.preflightResult(true); ran.push(session.agent.state.model.id); return Promise.resolve(); };
  await client.prompt('then speaking', { voice: true });
  assert.deepEqual(ran, ['big', 'big']);
  await end();
});

test('a model the person picks during the run stays, the voice model itself included', async () => {
  for (const pick of ['fast/small', 'slow/big']) {
    const { client, session, end } = running();
    session.setModel = async (m: any) => { session.agent.state.model = m; };
    save('fast/small');
    await client.prompt('hi', { voice: true });
    const [provider, id] = pick.split('/');
    await client.setModel(provider, id);
    const picked = session.agent.state.model;
    await end();
    assert.equal(session.agent.state.model, picked);
    assert.equal(session.agent.state.model.id, id);
  }
});

test('a model the person picked that is neither stays too', async () => {
  const { client, session, end } = running();
  save('fast/small');
  await client.prompt('hi', { voice: true });
  const picked = { provider: 'other', id: 'pick', contextWindow: 1000 };
  session.agent.state.model = picked;
  await end();
  assert.equal(session.agent.state.model, picked);
});

test('the chat goes back even when the voice model was changed in the settings during the run', async () => {
  const { client, session, end } = running();
  save('fast/small');
  await client.prompt('hi', { voice: true });
  save('');
  await end();
  assert.equal(session.agent.state.model, chat);
});

test('a spoken message between pi going idle and its settle is not undone by that settle', async () => {
  const { client, session, ran, end } = running();
  save('fast/small');
  await client.prompt('one', { voice: true });
  // pi is idle, and has not settled yet.
  session.isIdle = true;
  await client.prompt('two', { voice: true });
  assert.deepEqual(ran, ['small', 'small']);
  // The first run's settle arrives while the second is going.
  client.noteRun({ type: 'agent_settled' });
  assert.equal(session.agent.state.model.id, 'small');
  // The second run's own settle puts the chat back.
  await end();
  assert.equal(session.agent.state.model, chat);
});

test('a typed message between pi going idle and its settle runs on the chat model', async () => {
  const { client, session, ran } = running();
  save('fast/small');
  await client.prompt('one', { voice: true });
  session.isIdle = true;
  await client.prompt('two');
  assert.deepEqual(ran, ['small', 'big']);
  client.noteRun({ type: 'agent_settled' });
  assert.equal(session.agent.state.model, chat);
});

test('the chat model is handed on when a spoken turn borrows another, for a chat that names none', async () => {
  const { client, end } = running();
  const told: string[] = [];
  client.rememberChatModel = (provider: string, id: string) => told.push(`${provider}/${id}`);
  save('fast/small');
  await client.prompt('hi', { voice: true });
  assert.deepEqual(told, ['slow/big']);
  await end();
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

test('a chat that names no model anywhere keeps its own, and one that names one is left alone', () => {
  createSession({ id: 'none', title: 't', workspace: '/w', executor: 'host' });
  keepChatModel('none', 'slow', 'big');
  assert.equal(getSession('none')?.provider, 'slow');
  assert.equal(getSession('none')?.model, 'big');
  // Named already: not overwritten by the later borrow.
  keepChatModel('none', 'other', 'pick');
  assert.equal(getSession('none')?.model, 'big');
  // Named by the portal's defaults: pi opens it on those, never on the last answer.
  createSession({ id: 'default', title: 't', workspace: '/w', executor: 'host' });
  putSetting('model', 'dflt');
  keepChatModel('default', 'slow', 'big');
  assert.equal(getSession('default')?.model ?? '', '');
  putSetting('model', '');
  keepChatModel('missing', 'slow', 'big');
});
