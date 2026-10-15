import { type Page } from '@playwright/test';
import { test, expect, mockPortal } from './portal-mock';

/**
 * A message sent again, or edited, has versions: the page shows which one is
 * on screen and switches between them, and loads the chat again when one
 * comes back.
 */
async function portal(page: Page, { second = false } = {}) {
  const at = new Date().toISOString();
  const session = { id: 'a', title: 'Circle constants', workspace: '/w/site', status: 'idle', kind: 'task', pinned: false, updated_at: at };
  // A chat to go to, for a test of what an answer for the one that was left does.
  const other = { ...session, id: 'b', title: 'Chat B' };
  const state = { versions: { 5: [2, 5] } as Record<number, number[]>, switched: [] as { path: string; body: any }[] };
  await mockPortal(page, async ({ path: p, json }) => {
    if (p === '/api/sessions') return { sessions: second ? [session, other] : [session], executor: 'host' };
    // Versions come with the stream; this is here for a page that asks anyway (and a test counts that it does not).
    if (p === '/api/sessions/a/versions') return { versions: state.versions };
    if (p.endsWith('/version')) {
      state.switched.push({ path: p, body: json() });
      return { ok: true };
    }
  }, { streams: 'open', settings: true });
  return state;
}

const ev = (seq: number, type: string, payload: unknown) => ({ seq, type, at: Date.now(), payload });
const turn = (seq: number, question: string, answer: string) => [
  ev(seq, 'portal_prompt', { message: question }),
  ev(seq + 1, 'message_end', { message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: answer }] } }),
];

/**
 * Sends a replay down the newest open stream the page has for the chat, and
 * says it has caught up: first, as the server does, how often the chat was
 * loaded again (`reloads`).
 */
async function replay(page: Page, events: unknown[], reloads = 0, versions: Record<number, number[]> = {}) {
  await expect.poll(() => page.evaluate(() => (window as any).streams.filter((s: any) => !s.closed).length)).toBeGreaterThan(0);
  await page.evaluate(([events, reloads, versions]) => {
    const s = (window as any).streams.filter((x: any) => !x.closed).at(-1);
    s.emit('reloads', { reloads });
    s.emit('versions', { versions });
    s.emit('live-reset', {});
    for (const e of events as unknown[]) s.emit('message', e);
    s.emit('caught-up', {});
  }, [events, reloads, versions] as const);
}
/** The newest open stream drops. */
const drop = (page: Page) => page.evaluate(() => (window as any).streams.filter((s: any) => !s.closed).at(-1).onerror());

const openStreams = (page: Page) => page.evaluate(() => (window as any).streams.filter((s: any) => !s.closed).map((s: any) => s.url));

test('a message sent again shows which version it is, and switches to the other', async ({ page }) => {
  const state = await portal(page);
  await page.goto('/s/a');
  await replay(page, turn(5, 'What is tau?', 'About 6.28.'), 0, { 5: [2, 5] });
  const versions = page.getByRole('group', { name: 'Versions of this message' });
  await expect(versions).toContainText('2 / 2');
  await expect(versions.getByRole('button', { name: 'Next version' })).toBeDisabled();
  await versions.getByRole('button', { name: 'Previous version' }).click();
  await expect.poll(() => state.switched).toEqual([{ path: '/api/sessions/a/messages/5/version', body: { to: 2 } }]);

  // The server brought the old version back, under the seqs it had: the page is told to load the chat again.
  await page.evaluate(() => (window as any).streams.filter((s: any) => !s.closed).at(-1).emit('message', { seq: -1, type: 'portal_reload', at: Date.now(), payload: { reloads: 1 } }));
  await expect.poll(() => openStreams(page)).toEqual(['/api/sessions/a/events?since=0']);
  // What comes replaces what was there.
  await replay(page, turn(2, 'What is pi?', 'About 3.14.'), 1, { 2: [2, 5] });
  await expect(page.getByText('What is pi?')).toBeVisible();
  await expect(page.getByText('About 3.14.')).toBeVisible();
  await expect(page.getByText('What is tau?')).toHaveCount(0);
  await expect(page.getByText('About 6.28.')).toHaveCount(0);
  await expect(versions).toContainText('1 / 2');
  await expect(versions.getByRole('button', { name: 'Previous version' })).toBeDisabled();
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => (window as any).streams.length)).toBeLessThanOrEqual(4);
  expect(await openStreams(page)).toEqual(['/api/sessions/a/events?since=0']);
});

test('a page that was away when a version came back loads the chat again on catching up, and only then', async ({ page }) => {
  await portal(page);
  await page.goto('/s/a');
  await replay(page, turn(5, 'What is tau?', 'About 6.28.'));
  // The stream drops, and comes back from where it had read to: the count is not the one it last saw.
  await drop(page);
  await expect.poll(() => openStreams(page), { timeout: 10000 }).toEqual(['/api/sessions/a/events?since=6']);
  await page.evaluate(() => (window as any).streams.filter((s: any) => !s.closed).at(-1).emit('reloads', { reloads: 1 }));
  await expect.poll(() => openStreams(page)).toEqual(['/api/sessions/a/events?since=0']);
  await replay(page, turn(2, 'What is pi?', 'About 3.14.'), 1);
  await expect(page.getByText('What is pi?')).toBeVisible();
  await expect(page.getByText('What is tau?')).toHaveCount(0);
  // It drops again, and the count is the same: it goes on from its cursor. A stored
  // marker it never read past sent every reconnect back to the start.
  await drop(page);
  await expect.poll(() => openStreams(page), { timeout: 10000 }).toEqual(['/api/sessions/a/events?since=3']);
  await page.evaluate(() => (window as any).streams.filter((s: any) => !s.closed).at(-1).emit('reloads', { reloads: 1 }));
  await page.waitForTimeout(300);
  expect(await openStreams(page)).toEqual(['/api/sessions/a/events?since=3']);
});

test('a reload whose stream drops before anything came keeps the chat on screen', async ({ page }) => {
  await portal(page);
  await page.goto('/s/a');
  await replay(page, turn(5, 'What is tau?', 'About 6.28.'));
  await page.evaluate(() => (window as any).streams.filter((s: any) => !s.closed).at(-1).emit('message', { seq: -1, type: 'portal_reload', at: Date.now(), payload: { reloads: 1 } }));
  await expect.poll(() => openStreams(page)).toEqual(['/api/sessions/a/events?since=0']);
  await drop(page);
  // Nothing had come, and that nothing replaced the chat until the next try.
  await expect(page.getByText('What is tau?')).toBeVisible();
  await expect.poll(() => openStreams(page), { timeout: 10000 }).toEqual(['/api/sessions/a/events?since=0']);
  await replay(page, turn(2, 'What is pi?', 'About 3.14.'), 1);
  await expect(page.getByText('What is pi?')).toBeVisible();
  await expect(page.getByText('What is tau?')).toHaveCount(0);
});

test('earlier messages asked for before the chat was loaded again are not put above it', async ({ page }) => {
  await portal(page);
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let asked = 0;
  await page.route('**/api/sessions/a/events/before**', async (route) => {
    const limit = new URL(route.request().url()).searchParams.get('limit');
    // Whether there is more above: yes.
    if (limit === '1') return route.fulfill({ json: { events: [ev(1, 'portal_prompt', { message: 'x' })], more: true } });
    // The first page of it is slow, and comes after the reload; any later one finds nothing.
    if (asked++ === 0) {
      await held;
      return route.fulfill({ json: { events: turn(1, 'Ancient question', 'Ancient answer'), more: false } });
    }
    await route.fulfill({ json: { events: [], more: false } });
  });
  await page.goto('/s/a');
  await replay(page, turn(5, 'What is tau?', 'About 6.28.'));
  // Asked for on its own when the top of a short chat is in view; else by the button.
  await page.getByRole('button', { name: 'Load earlier messages' }).click({ timeout: 1500 }).catch(() => {});
  await expect.poll(() => asked).toBeGreaterThan(0);
  await page.evaluate(() => (window as any).streams.filter((s: any) => !s.closed).at(-1).emit('message', { seq: -1, type: 'portal_reload', at: Date.now(), payload: { reloads: 1 } }));
  await replay(page, turn(2, 'What is pi?', 'About 3.14.'), 1);
  await expect(page.getByText('What is pi?')).toBeVisible();
  release();
  await page.waitForTimeout(500);
  await expect(page.getByText('Ancient question')).toHaveCount(0);
});

test('earlier messages asked for in a chat that was then left are not put above the chat that is open now, and do not hold up its own', async ({ page }) => {
  await portal(page, { second: true });
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let askedA = 0;
  let askedB = 0;
  await page.route('**/api/sessions/a/events/before**', async (route) => {
    const limit = new URL(route.request().url()).searchParams.get('limit');
    if (limit === '1') return route.fulfill({ json: { events: [ev(1, 'portal_prompt', { message: 'x' })], more: true } });
    // The page of the first chat is slow, and comes when the second is open.
    askedA++;
    await held;
    await route.fulfill({ json: { events: turn(50, 'A old question', 'A old answer'), more: false } });
  });
  await page.route('**/api/sessions/b/events/before**', async (route) => {
    const limit = new URL(route.request().url()).searchParams.get('limit');
    if (limit === '1') return route.fulfill({ json: { events: [ev(1, 'portal_prompt', { message: 'x' })], more: true } });
    askedB++;
    await route.fulfill({ json: { events: turn(150, 'B old question', 'B old answer'), more: false } });
  });
  await page.goto('/s/a');
  await replay(page, turn(100, 'A question', 'A answer'));
  // Asked for on its own when the top of a short chat is in view; else by the button.
  await page.getByRole('button', { name: 'Load earlier messages' }).click({ timeout: 1500 }).catch(() => {});
  await expect.poll(() => askedA).toBeGreaterThan(0);
  await page.getByText('Chat B').first().click();
  await expect(page).toHaveURL(/\/s\/b$/);
  await expect.poll(() => openStreams(page)).toEqual(['/api/sessions/b/events?since=0']);
  await replay(page, turn(200, 'B question', 'B answer'));
  // Its own earlier page is not held up by the one still on its way for the chat that was left.
  await page.getByRole('button', { name: 'Load earlier messages' }).click({ timeout: 1500 }).catch(() => {});
  await expect.poll(() => askedB).toBeGreaterThan(0);
  await expect(page.getByText('B old question')).toBeVisible();
  release();
  await page.waitForTimeout(500);
  await expect(page.getByText('A old question')).toHaveCount(0);
  await expect(page.getByText('A question')).toHaveCount(0);
  await expect(page.getByText('B question', { exact: true })).toBeVisible();
});

test('earlier messages of a chat that was left, answered while the open chat\'s own are on their way, neither free it to ask again nor are put above it twice', async ({ page }) => {
  await portal(page, { second: true });
  let releaseA!: () => void;
  const heldA = new Promise<void>((r) => (releaseA = r));
  let releaseB!: () => void;
  const heldB = new Promise<void>((r) => (releaseB = r));
  let askedA = 0;
  let askedB = 0;
  await page.route('**/api/sessions/a/events/before**', async (route) => {
    if (new URL(route.request().url()).searchParams.get('limit') === '1') return route.fulfill({ json: { events: [ev(1, 'portal_prompt', { message: 'x' })], more: true } });
    askedA++;
    await heldA;
    await route.fulfill({ json: { events: turn(50, 'A old question', 'A old answer'), more: false } });
  });
  await page.route('**/api/sessions/b/events/before**', async (route) => {
    if (new URL(route.request().url()).searchParams.get('limit') === '1') return route.fulfill({ json: { events: [ev(1, 'portal_prompt', { message: 'x' })], more: true } });
    askedB++;
    await heldB;
    await route.fulfill({ json: { events: turn(150, 'B old question', 'B old answer'), more: false } });
  });
  await page.goto('/s/a');
  await replay(page, turn(100, 'A question', 'A answer'));
  await page.getByRole('button', { name: 'Load earlier messages' }).click({ timeout: 1500 }).catch(() => {});
  await expect.poll(() => askedA).toBeGreaterThan(0);
  await page.getByText('Chat B').first().click();
  await expect(page).toHaveURL(/\/s\/b$/);
  await expect.poll(() => openStreams(page)).toEqual(['/api/sessions/b/events?since=0']);
  await replay(page, turn(200, 'B question', 'B answer'));
  await page.getByRole('button', { name: 'Load earlier messages' }).click({ timeout: 1500 }).catch(() => {});
  await expect.poll(() => askedB).toBeGreaterThan(0);
  // The page of the chat that was left comes first, while the open chat's own is still on its way.
  releaseA();
  await page.waitForTimeout(500);
  releaseB();
  await expect(page.getByText('B old question')).toBeVisible();
  await page.waitForTimeout(500);
  expect(askedB).toBe(1);
  await expect(page.getByText('B old question')).toHaveCount(1);
  await expect(page.getByText('A old question')).toHaveCount(0);
});

test('a chat loaded again while a page of earlier messages was on its way can still load its own', async ({ page }) => {
  await portal(page);
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let asked = 0;
  await page.route('**/api/sessions/a/events/before**', async (route) => {
    if (new URL(route.request().url()).searchParams.get('limit') === '1') return route.fulfill({ json: { events: [ev(1, 'portal_prompt', { message: 'x' })], more: true } });
    // The first page, of the list that was there, is slow and comes after the reload; the next is the new list's own.
    if (asked++ === 0) {
      await held;
      return route.fulfill({ json: { events: turn(1, 'Ancient question', 'Ancient answer'), more: false } });
    }
    await route.fulfill({ json: { events: turn(1, 'Earlier than the new list', 'Its answer'), more: false } });
  });
  await page.goto('/s/a');
  await replay(page, turn(5, 'What is tau?', 'About 6.28.'));
  await page.getByRole('button', { name: 'Load earlier messages' }).click({ timeout: 1500 }).catch(() => {});
  await expect.poll(() => asked).toBe(1);
  await page.evaluate(() => (window as any).streams.filter((s: any) => !s.closed).at(-1).emit('message', { seq: -1, type: 'portal_reload', at: Date.now(), payload: { reloads: 1 } }));
  await replay(page, turn(2, 'What is pi?', 'About 3.14.'), 1);
  await expect(page.getByText('What is pi?')).toBeVisible();
  release();
  await page.waitForTimeout(500);
  // Asked for on its own when the top is in view, else by the button: either way the new list's page comes, and not the old one's.
  await page.getByRole('button', { name: 'Load earlier messages' }).click({ timeout: 1500 }).catch(() => {});
  await expect(page.getByText('Earlier than the new list')).toBeVisible();
  await expect(page.getByText('Ancient question')).toHaveCount(0);
});

/**
 * A rewrite of the message in chat A is sent, and answered only when chat B is open with a message of its own half rewritten.
 * Gives B's editor.
 */
async function editAnsweredAfterLeaving(page: Page, answer: { status?: number; json: unknown }) {
  await portal(page, { second: true });
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let asked = 0;
  await page.route('**/api/sessions/a/messages/100/edit', async (route) => {
    asked++;
    await held;
    await route.fulfill(answer);
  });
  await page.goto('/s/a');
  await replay(page, turn(100, 'A question', 'A answer'));
  await page.getByRole('button', { name: /^Edit — replaces/ }).click();
  await page.getByRole('textbox', { name: 'Edit message' }).fill('A question, rewritten');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect.poll(() => asked).toBe(1);
  await page.getByText('Chat B').first().click();
  await expect(page).toHaveURL(/\/s\/b$/);
  await expect.poll(() => openStreams(page)).toEqual(['/api/sessions/b/events?since=0']);
  await replay(page, turn(200, 'B question', 'B answer'));
  await page.getByRole('button', { name: /^Edit — replaces/ }).click();
  const editor = page.getByRole('textbox', { name: 'Edit message' });
  await editor.fill('B question, half rewritten');
  release();
  await page.waitForTimeout(500);
  return editor;
}

test('a rewrite that went through after its chat was left leaves the message being rewritten in the chat open now alone', async ({ page }) => {
  const editor = await editAnsweredAfterLeaving(page, { json: { ok: true } });
  await expect(editor).toHaveValue('B question, half rewritten');
});

test('a rewrite that failed after its chat was left is not shown in the chat open now', async ({ page }) => {
  const editor = await editAnsweredAfterLeaving(page, { status: 409, json: { error: 'A EDIT FAILED' } });
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(editor).toHaveValue('B question, half rewritten');
});

test('a message still on its way in a chat that was left does not hold up the Send of the chat open now, and its failure is not shown there', async ({ page }) => {
  await portal(page, { second: true });
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let askedA = 0;
  const sentB: unknown[] = [];
  await page.route('**/api/sessions/a/prompt', async (route) => {
    askedA++;
    await held;
    await route.fulfill({ status: 500, json: { error: 'A SEND FAILED' } });
  });
  await page.route('**/api/sessions/b/prompt', (route) => {
    sentB.push(route.request().postDataJSON());
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto('/s/a');
  await replay(page, turn(100, 'A question', 'A answer'));
  const box = page.getByRole('textbox', { name: 'Message' });
  await box.fill('to A, slowly');
  await box.press('Enter');
  await expect.poll(() => askedA).toBe(1);
  await page.getByText('Chat B').first().click();
  await expect(page).toHaveURL(/\/s\/b$/);
  await expect.poll(() => openStreams(page)).toEqual(['/api/sessions/b/events?since=0']);
  await replay(page, turn(200, 'B question', 'B answer'));
  await box.fill('to B');
  await expect(page.getByRole('button', { name: 'Send message' })).toBeEnabled();
  await box.press('Enter');
  await expect.poll(() => sentB).toEqual([{ message: 'to B' }]);
  release();
  await page.waitForTimeout(500);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('a file still being uploaded in a chat that was left does not hold up the Send of the chat open now', async ({ page }) => {
  await portal(page, { second: true });
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let asked = 0;
  await page.route('**/api/sessions/a/upload**', async (route) => {
    asked++;
    await held;
    await route.fulfill({ json: { path: 'notes.txt', size: 5 } });
  });
  await page.goto('/s/a');
  await replay(page, turn(100, 'A question', 'A answer'));
  await page.locator('input[type=file]').first().setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('notes') });
  await expect.poll(() => asked).toBe(1);
  await page.getByText('Chat B').first().click();
  await expect(page).toHaveURL(/\/s\/b$/);
  await expect.poll(() => openStreams(page)).toEqual(['/api/sessions/b/events?since=0']);
  await replay(page, turn(200, 'B question', 'B answer'));
  await page.getByRole('textbox', { name: 'Message' }).fill('to B');
  await expect(page.getByText('Adding…')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Send message' })).toBeEnabled();
  release();
});

test('the answer to whether a chat that was left has earlier messages does not decide it for the chat open now', async ({ page }) => {
  await portal(page, { second: true });
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let peeksB = 0;
  let askedB = 0;
  // The short chat's own look above it is slow, and comes when the long one is open.
  await page.route('**/api/sessions/a/events/before**', async (route) => {
    await held;
    await route.fulfill({ json: { events: [], more: false } });
  });
  await page.route('**/api/sessions/b/events/before**', async (route) => {
    if (new URL(route.request().url()).searchParams.get('limit') === '1') {
      peeksB++;
      return route.fulfill({ json: { events: [ev(1, 'portal_prompt', { message: 'x' })], more: true } });
    }
    askedB++;
    await route.fulfill({ json: { events: turn(1, 'B old question', 'B old answer'), more: false } });
  });
  await page.goto('/s/a');
  await replay(page, turn(100, 'A question', 'A answer'));
  await page.getByText('Chat B').first().click();
  await expect(page).toHaveURL(/\/s\/b$/);
  await expect.poll(() => openStreams(page)).toEqual(['/api/sessions/b/events?since=0']);
  await replay(page, Array.from({ length: 60 }, (_, i) => turn(200 + 2 * i, `B question ${i}`, `B answer ${i}`)).flat());
  await expect.poll(() => peeksB).toBeGreaterThan(0);
  release();
  await page.waitForTimeout(500);
  // Read up to the top of it: what is there is asked for, as the chat's own look above it said.
  const scroller = page.locator('.chat-list').locator('..');
  await expect.poll(async () => {
    await scroller.evaluate((el) => (el.scrollTop = 0));
    return askedB;
  }, { timeout: 5000 }).toBeGreaterThan(0);
});

test('a message with one version has no switch', async ({ page }) => {
  const state = await portal(page);
  state.versions = {};
  await page.goto('/s/a');
  await replay(page, turn(5, 'What is tau?', 'About 6.28.'));
  await expect(page.getByText('About 6.28.')).toBeVisible();
  await expect(page.getByRole('group', { name: 'Versions of this message' })).toHaveCount(0);
});

test('versions come with the chat\'s stream, and change when it says so', async ({ page }) => {
  await portal(page);
  const asked: string[] = [];
  page.on('request', (r) => r.url().includes('/versions') && r.method() === 'GET' && asked.push(r.url()));
  await page.goto('/s/a');
  await replay(page, turn(5, 'What is tau?', 'About 6.28.'), 0, { 5: [2, 5] });
  const versions = page.getByRole('group', { name: 'Versions of this message' });
  await expect(versions).toContainText('2 / 2');
  const live = (e: unknown) => page.evaluate((e) => (window as any).streams.filter((s: any) => !s.closed).at(-1).emit('message', e), e);
  for (const e of turn(7, 'And e?', 'About 2.72.')) await live(e);
  await expect(page.getByText('About 2.72.')).toBeVisible();
  // An edit of the last one: its turn goes, its replacement comes, and the server says the versions.
  await live({ seq: -1, type: 'portal_removed', at: Date.now(), payload: { from: 7, to: 11, reloads: 1 } });
  for (const e of turn(11, 'And e, roughly?', 'About 2.7.')) await live(e);
  await live({ seq: -1, type: 'portal_versions', at: Date.now(), payload: { versions: { 5: [2, 5], 11: [7, 11] } } });
  await expect(page.getByText('And e?')).toHaveCount(0);
  await expect(versions.nth(1)).toContainText('2 / 2');
  // Asked for by the page after each change, a change that did not alter which messages it held went unseen.
  expect(asked).toEqual([]);
  // A page that heard the removal has the count it brought: its next stream goes on from its cursor.
  await drop(page);
  await expect.poll(() => openStreams(page), { timeout: 10000 }).toEqual(['/api/sessions/a/events?since=12']);
  await page.evaluate(() => (window as any).streams.filter((s: any) => !s.closed).at(-1).emit('reloads', { reloads: 1 }));
  await page.waitForTimeout(300);
  expect(await openStreams(page)).toEqual(['/api/sessions/a/events?since=12']);
});

test('a second click on a version switch waits for the first', async ({ page }) => {
  const state = await portal(page);
  state.versions = { 5: [1, 3, 5] };
  await page.goto('/s/a');
  await replay(page, turn(5, 'What is tau?', 'About 3.14 times two.'), 0, { 5: [1, 3, 5] });
  const previous = page.getByRole('group', { name: 'Versions of this message' }).getByRole('button', { name: 'Previous version' });
  await expect(previous).toBeEnabled();
  // Twice, quickly: the second asked about a message on its way out, and failed after the first worked.
  await previous.click();
  await previous.click({ force: true }).catch(() => {});
  await page.waitForTimeout(400);
  expect(state.switched).toEqual([{ path: '/api/sessions/a/messages/5/version', body: { to: 3 } }]);
  await expect(previous).toBeDisabled();
  await expect(page.getByRole('alert')).toHaveCount(0);
});
