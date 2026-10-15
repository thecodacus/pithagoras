import { type Page } from '@playwright/test';
import { test, expect, mockPortal } from './portal-mock';

/**
 * The agent's ask_question questions: every kind in one card, drawn in the chat above the message box rather than
 * over the page, kept by the server until they end (so the page draws them again from the chat's events after a
 * reload), and left in the transcript as a record of what was asked and answered.
 */
const at = new Date().toISOString();
const chat = { id: 'a', title: 'Chat A', workspace: '/w/site', status: 'idle', kind: 'task', pinned: false, updated_at: at, created_at: at, provider: null, model: null, thinking_level: null };
const other = { ...chat, id: 'b', title: 'Chat B' };

// A conversation started on the Agent page: not in the sidebar's tasks, fetched on its own.
const agentChat = { ...chat, id: 'g', title: 'Chat G', kind: 'agent', channel_slug: 'browser' };

async function portal(page: Page) {
  const answered: any[] = [];
  await mockPortal(page, ({ path, json }) => {
    if (path === '/api/sessions') return { sessions: [chat, other], executor: 'host' };
    if (path === '/api/sessions/g') return agentChat;
    if (path === '/api/sessions/b') return other;
    if (/^\/api\/sessions\/\w+$/.test(path)) return chat;
    if (path.endsWith('/ui-response')) { answered.push(json()); return { ok: true }; }
    if (path.endsWith('/config')) return { live: false, state: null, stats: null, thinking: { levels: [] }, models: { models: [] }, named: { provider: null, model: null } };
  }, { streams: 'open', settings: true });
  return { answered };
}

const questions = [
  { id: 'db', question: 'Which database?', kind: 'single', options: [{ label: 'SQLite', description: 'one file' }, { label: 'Postgres' }], other: true, optional: false },
  { id: 'features', question: 'Which features?', kind: 'multiple', options: [{ label: 'Search' }, { label: 'Export' }], other: false, optional: false },
  { id: 'why', question: 'Anything else?', kind: 'text', options: [], other: false, optional: true },
  { id: 'order', question: 'Rank them', kind: 'ranking', options: [{ label: 'Speed' }, { label: 'Cost' }, { label: 'Safety' }], other: false, optional: false },
];

const ev = (seq: number, type: string, payload: unknown) => ({ seq, type, at: Date.now(), payload });
/** A chat in which the agent has asked, as the server stores it: the message, the tool call, the question. */
const asked = (qs: unknown[] = questions, title: string | undefined = 'A few questions') => [
  ev(1, 'portal_prompt', { message: 'Set it up' }),
  ev(2, 'tool_execution_start', { toolCallId: 'c1', toolName: 'ask_question', args: { title, questions: qs } }),
  ev(3, 'portal_question', { id: 'q1', ...(title ? { title } : {}), questions: qs }),
];
const ended = (outcome: string, answers?: unknown) => ev(4, 'portal_question_end', { of: 'q1', outcome, ...(answers ? { answers } : {}) });

/** What the server sends a stream that opens: the chat's stored events, then that it has caught up. */
async function replay(page: Page, events: unknown[]) {
  await expect.poll(() => page.evaluate(() => (window as any).streams.filter((s: any) => !s.closed).length)).toBeGreaterThan(0);
  await page.evaluate((events) => {
    const stream = (window as any).streams.filter((s: any) => !s.closed).at(-1);
    stream.emit('live-reset', {});
    for (const e of events) stream.emit('message', e);
    stream.emit('caught-up', {});
  }, events);
}
const openStreams = (page: Page) => page.evaluate(() => (window as any).streams.filter((s: any) => !s.closed).map((s: any) => s.url));
/** An event that comes live on the open stream. */
const live = (page: Page, event: unknown) =>
  page.evaluate((event) => (window as any).streams.filter((s: any) => !s.closed).at(-1).emit('message', event), event);

async function open(page: Page, events = asked()) {
  await page.goto('/s/a');
  await replay(page, events);
  const card = page.getByRole('region', { name: 'A few questions' });
  await expect(card).toBeVisible();
  return card;
}

test('the questions show in the chat above the message box, not as a dialog over the page, and Esc closes nothing', async ({ page }) => {
  const { answered } = await portal(page);
  const card = await open(page);
  await expect(page.locator('[role="dialog"][aria-modal="true"]')).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const message = page.getByRole('textbox', { name: 'Message' });
  const cardBox = (await card.boundingBox())!;
  const messageBox = (await message.boundingBox())!;
  expect(cardBox.y + cardBox.height).toBeLessThanOrEqual(messageBox.y);
  // The rest of the page is there to use: the message box takes the keyboard, and Esc leaves the questions be.
  await message.click();
  await page.keyboard.type('hello');
  await expect(message).toHaveValue('hello');
  await page.keyboard.press('Escape');
  await card.getByRole('radio', { name: /SQLite/ }).focus();
  await page.keyboard.press('Escape');
  await expect(card).toBeVisible();
  expect(answered).toEqual([]);
  // Open, it is not also drawn in the transcript.
  await expect(page.getByRole('group', { name: 'A few questions' })).toHaveCount(0);
});

test('the questions are answered together: one, several, typed, and a ranking put in order', async ({ page }) => {
  const { answered } = await portal(page);
  const card = await open(page);
  const submit = card.getByRole('button', { name: 'Submit' });
  await expect(submit).toBeDisabled();
  await expect(card.locator('select')).toHaveCount(0);

  await card.getByRole('radio', { name: /SQLite/ }).check();
  await expect(submit).toBeDisabled();
  await card.getByRole('checkbox', { name: 'Export' }).check();
  await expect(submit).toBeDisabled();
  await card.getByRole('checkbox', { name: 'Search' }).check();
  await card.getByRole('checkbox', { name: 'Search' }).uncheck();
  await card.getByRole('textbox', { name: 'Anything else?' }).fill('  soon  ');
  await card.getByRole('button', { name: 'Move Safety up' }).click();
  await card.getByRole('button', { name: 'Move Speed down' }).click();
  await expect(card.getByRole('button', { name: 'Move Speed up' })).toBeEnabled();
  await expect(submit).toBeEnabled();

  await submit.click();
  await expect(card).toBeHidden();
  expect(answered).toEqual([{ id: 'q1', value: { db: 'SQLite', features: ['Export'], why: 'soon', order: ['Safety', 'Speed', 'Cost'] } }]);
});

test('answering sends the answers, and their record stays in the transcript, also after a reload', async ({ page }) => {
  const { answered } = await portal(page);
  const card = await open(page, asked(questions.slice(0, 2)));
  await card.getByRole('radio', { name: /Postgres/ }).check();
  await card.getByRole('checkbox', { name: 'Export' }).check();
  await card.getByRole('button', { name: 'Submit' }).click();
  await expect(card).toBeHidden();
  expect(answered).toEqual([{ id: 'q1', value: { db: 'Postgres', features: ['Export'] } }]);

  // The server writes the record down and sends it on the stream.
  const end = ended('answered', { db: 'Postgres', features: ['Export'] });
  await live(page, end);
  const record = page.getByRole('group', { name: 'A few questions' });
  await expect(record).toBeVisible();
  await expect(record).toContainText('Which database?');
  await expect(record).toContainText('Postgres');
  await expect(record).toContainText('Which features?');
  await expect(record).toContainText('Export');

  await page.reload();
  await replay(page, [...asked(questions.slice(0, 2)), end]);
  await expect(page.getByRole('group', { name: 'A few questions' })).toContainText('Postgres');
  await expect(page.getByRole('region', { name: 'A few questions' })).toHaveCount(0);
});

test('a question asked while the chat is open, and answered there, leaves its record in the open tab, as a running chat sends it', async ({ page }) => {
  const { answered } = await portal(page);
  const qs = questions.slice(0, 2);
  const args = { title: 'A few questions', questions: qs };
  const assistant = (content: unknown[], stopReason: string) => ({ role: 'assistant', content, stopReason, provider: 'p', model: 'm' });
  await page.goto('/s/a');
  // The tab is open before the agent asks: the chat is running, and everything after the prompt comes live.
  await replay(page, [ev(1, 'portal_status', { status: 'running' }), ev(2, 'portal_prompt', { message: 'Set it up' })]);
  for (const e of [
    ev(3, 'agent_start', { type: 'agent_start' }),
    ev(4, 'message_start', { type: 'message_start', message: assistant([], 'stop') }),
    { seq: -10, type: 'message_update', at: Date.now(), payload: { type: 'message_update', streamId: 's1', assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: 'I will ask.' } } },
    ev(5, 'message_end', { type: 'message_end', streamId: 's1', message: assistant([{ type: 'thinking', thinking: 'I will ask.' }, { type: 'toolCall', id: 'c1', name: 'ask_question', arguments: args }], 'toolUse') }),
    ev(6, 'tool_execution_start', { type: 'tool_execution_start', toolCallId: 'c1', toolName: 'ask_question', args }),
    ev(7, 'portal_question', { id: 'q1', ...args }),
  ]) await live(page, e);
  const card = page.getByRole('region', { name: 'A few questions' });
  await expect(card).toBeVisible();
  await card.getByRole('radio', { name: /Postgres/ }).check();
  await card.getByRole('checkbox', { name: 'Export' }).check();
  await card.getByRole('button', { name: 'Submit' }).click();
  await expect(card).toBeHidden();
  expect(answered).toEqual([{ id: 'q1', value: { db: 'Postgres', features: ['Export'] } }]);

  // What the server then sends, in the order it stores it: the record, the tool's end, and the agent's reply.
  for (const e of [
    ev(8, 'portal_question_end', { of: 'q1', outcome: 'answered', answers: { db: 'Postgres', features: ['Export'] } }),
    ev(9, 'tool_execution_end', { type: 'tool_execution_end', toolCallId: 'c1', toolName: 'ask_question', result: { content: [{ type: 'text', text: 'The person answered: …' }] }, isError: false }),
    ev(10, 'message_start', { type: 'message_start', message: { role: 'toolResult' } }),
    ev(11, 'message_end', { type: 'message_end', message: { role: 'toolResult' } }),
    ev(12, 'message_start', { type: 'message_start', message: assistant([], 'stop') }),
    { seq: -11, type: 'message_update', at: Date.now(), payload: { type: 'message_update', streamId: 's2', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Postgres it is.' } } },
    ev(13, 'message_end', { type: 'message_end', streamId: 's2', message: assistant([{ type: 'text', text: 'Postgres it is.' }], 'stop') }),
    ev(14, 'agent_end', { type: 'agent_end' }),
    ev(15, 'portal_status', { status: 'idle' }),
  ]) await live(page, e);
  await expect(page.getByText('Postgres it is.')).toBeVisible();
  const record = page.getByRole('group', { name: 'A few questions' });
  await expect(record).toBeVisible();
  await expect(record).toContainText('Which database?');
  await expect(record).toContainText('Postgres');
  await expect(record).toContainText('Export');
});

test('a question still waiting is back after the page is reloaded', async ({ page }) => {
  const { answered } = await portal(page);
  const card = await open(page);
  await card.getByRole('radio', { name: /SQLite/ }).check();
  await page.reload();
  await replay(page, asked());
  await expect(card).toBeVisible();
  await card.getByRole('radio', { name: /Postgres/ }).check();
  await card.getByRole('checkbox', { name: 'Search' }).check();
  await card.getByRole('button', { name: 'Keep this order' }).click();
  await card.getByRole('button', { name: 'Submit' }).click();
  await expect(card).toBeHidden();
  expect(answered).toEqual([{ id: 'q1', value: { db: 'Postgres', features: ['Search'], order: ['Speed', 'Cost', 'Safety'] } }]);
});

test('a question still waiting is there again after a visit to another chat', async ({ page }) => {
  const { answered } = await portal(page);
  const card = await open(page);
  await page.getByText('Chat B').first().click();
  await expect(page).toHaveURL(/\/s\/b$/);
  await expect.poll(() => openStreams(page)).toEqual(['/api/sessions/b/events?since=0']);
  await replay(page, [ev(1, 'portal_prompt', { message: 'Something else' })]);
  await expect(page.getByText('Something else')).toBeVisible();
  await expect(card).toHaveCount(0);
  await page.getByText('Chat A').first().click();
  await expect(page).toHaveURL(/\/s\/a$/);
  // A stream of its own, from the start: what the page draws comes from the chat's events again.
  await expect.poll(() => openStreams(page)).toEqual(['/api/sessions/a/events?since=0']);
  await replay(page, asked());
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: 'Cancel' }).click();
  await expect(card).toBeHidden();
  expect(answered).toEqual([{ id: 'q1', cancelled: true }]);
});

test('a page whose loaded end does not reach back to the question still draws it, from the copy sent with the stream', async ({ page }) => {
  await portal(page);
  await page.goto('/s/a');
  const [, , question] = asked();
  await replay(page, [ev(90, 'portal_prompt', { message: 'Much later' }), { ...question, seq: -5 }]);
  await expect(page.getByRole('region', { name: 'A few questions' })).toBeVisible();
});

test('cancelling answers the question as cancelled, and the record says it was not answered', async ({ page }) => {
  const { answered } = await portal(page);
  const card = await open(page);
  await card.getByRole('button', { name: 'Cancel' }).click();
  await expect(card).toBeHidden();
  expect(answered).toEqual([{ id: 'q1', cancelled: true }]);
  await live(page, ended('cancelled'));
  const record = page.getByRole('group', { name: 'A few questions' });
  await expect(record).toContainText('Which database?');
  await expect(record).toContainText('Cancelled, not answered');
});

test('a question whose wait ran out, or whose run was stopped, goes, and its record says why it was not answered', async ({ page }) => {
  await portal(page);
  const card = await open(page);
  await live(page, ended('expired'));
  await expect(card).toBeHidden();
  await expect(page.getByRole('group', { name: 'A few questions' })).toContainText('Not answered: the time for answering ran out');

  await page.reload();
  await replay(page, [...asked(), ended('stopped')]);
  await expect(page.getByRole('group', { name: 'A few questions' })).toContainText('Not answered: the run was stopped');
  await expect(card).toHaveCount(0);
});

test('a question may be answered in the person\'s own words, and an optional one may be left', async ({ page }) => {
  const { answered } = await portal(page);
  const card = await open(page);
  await card.getByRole('textbox', { name: 'Type your own answer' }).fill('MySQL');
  await expect(card.getByRole('radio', { name: 'Another answer' })).toBeChecked();
  await card.getByRole('checkbox', { name: 'Search' }).check();
  // A ranking nobody touched is not an answer: it is the order the model listed them in.
  const submit = card.getByRole('button', { name: 'Submit' });
  await expect(submit).toBeDisabled();
  await card.getByRole('button', { name: 'Keep this order' }).click();
  await expect(card.getByRole('button', { name: 'Keep this order' })).toBeHidden();
  await submit.click();
  await expect(card).toBeHidden();
  expect(answered).toEqual([{ id: 'q1', value: { db: 'MySQL', features: ['Search'], order: ['Speed', 'Cost', 'Safety'] } }]);
});

test('an optional ranking may be left alone, and is then not reported as chosen', async ({ page }) => {
  const { answered } = await portal(page);
  const optional = [{ id: 'order', question: 'Rank them', kind: 'ranking', options: [{ label: 'Speed' }, { label: 'Cost' }], other: false, optional: true }];
  const card = await open(page, asked(optional));
  await expect(card.getByRole('button', { name: 'Submit' })).toBeEnabled();
  await card.getByRole('button', { name: 'Submit' }).click();
  await expect(card).toBeHidden();
  expect(answered).toEqual([{ id: 'q1', value: {} }]);
});

test('moving a ranking row with the keyboard keeps the focus on the same button', async ({ page }) => {
  await portal(page);
  const card = await open(page);
  const down = card.getByRole('button', { name: 'Move Speed down' });
  await down.focus();
  await page.keyboard.press('Enter');
  // Speed is second now: the same button is still where the focus is, and it works again.
  await expect(card.getByRole('button', { name: 'Move Speed down' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(card.getByRole('button', { name: 'Move Speed down' })).toBeDisabled();
  // Last in the list: the focus goes to the other arrow rather than to the page.
  await expect(card.getByRole('button', { name: 'Move Speed up' })).toBeFocused();
});

test('a required question whose id is an inherited object key is not answered until something is picked', async ({ page }) => {
  const { answered } = await portal(page);
  const qs = [{ id: 'constructor', question: 'Pick one', kind: 'single', options: [{ label: 'A' }, { label: 'B' }], other: false, optional: false }];
  await page.goto('/s/a');
  await replay(page, asked(qs, 'One question'));
  const card = page.getByRole('region', { name: 'One question' });
  const submit = card.getByRole('button', { name: 'Submit' });
  await expect(submit).toBeDisabled();
  await card.getByRole('radio', { name: 'B' }).check();
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(card).toBeHidden();
  expect(answered).toEqual([{ id: 'q1', value: { constructor: 'B' } }]);
});

test('keeping a ranking\'s order with the keyboard leaves the focus inside the card', async ({ page }) => {
  await portal(page);
  const card = await open(page);
  const keep = card.getByRole('button', { name: 'Keep this order' });
  await keep.focus();
  await page.keyboard.press('Enter');
  await expect(keep).toBeHidden();
  // On the first row's arrow, not on the page.
  await expect(card.getByRole('button', { name: 'Move Speed down' })).toBeFocused();
});

test('a conversation started on the Agent page is asked in the chat the same way', async ({ page }) => {
  const { answered } = await portal(page);
  await page.goto('/s/g');
  await replay(page, asked(questions.slice(0, 1)));
  const card = page.getByRole('region', { name: 'A few questions' });
  await card.getByRole('radio', { name: /Postgres/ }).check();
  await card.getByRole('button', { name: 'Submit' }).click();
  await expect(card).toBeHidden();
  expect(answered).toEqual([{ id: 'q1', value: { db: 'Postgres' } }]);
});

test('an extension\'s dialog still opens over the page beside a question in the chat', async ({ page }) => {
  const { answered } = await portal(page);
  const card = await open(page);
  await live(page, { seq: -1, type: 'extension_ui_request', payload: { id: 'c1', method: 'confirm', title: 'Sure?', message: 'Really' } });
  await expect(page.getByRole('dialog', { name: 'Sure?' })).toBeVisible();
  await expect(card).toBeVisible();
  expect(answered).toEqual([]);
});

test('Settings → Tools sets how long a question waits: until answered by default, and the choice is stored', async ({ page }) => {
  const puts: any[] = [];
  await mockPortal(page, ({ path, method, json }) => {
    if (path === '/api/tools' && method === 'GET') return { tools: [], off: [], names: {}, questionWaitMinutes: 15 };
    if (path === '/api/ask-question' && method === 'PUT') { puts.push(json()); return { waitMinutes: json().waitMinutes }; }
  }, { settings: true });
  await page.goto('/settings/tools');
  const wait = page.getByRole('combobox', { name: 'Wait for an answer' });
  await expect(wait).toContainText('15 minutes');
  await expect(page.locator('select')).toHaveCount(0);
  await wait.click();
  await expect(page.getByRole('option')).toHaveText(['Until answered', '5 minutes', '15 minutes', '30 minutes', '60 minutes']);
  await page.getByRole('option', { name: 'Until answered' }).click();
  await expect.poll(() => puts).toEqual([{ waitMinutes: 0 }]);
  await expect(wait).toContainText('Until answered');
});

test('the wait for a question is Until answered where the portal sends none', async ({ page }) => {
  await mockPortal(page, ({ path, method }) => {
    if (path === '/api/tools' && method === 'GET') return { tools: [], off: [], names: {} };
  }, { settings: true });
  await page.goto('/settings/tools');
  await expect(page.getByRole('combobox', { name: 'Wait for an answer' })).toContainText('Until answered');
  await expect(page.locator('select')).toHaveCount(0);
});
