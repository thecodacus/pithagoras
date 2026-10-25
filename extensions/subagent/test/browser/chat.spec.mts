import path from 'node:path';
import { type Page } from '@playwright/test';
import { test, expect, extensionOnDisk } from '../../../../tests/browser/portal-mock';

/**
 * What the subagent extension draws beside a chat (src/client.tsx, src/Panel.tsx, src/ModelRow.tsx), on the portal's
 * own test page of a chat (core/web/tests/chat.html): the panel of its subagents and its button, a chip in the running
 * tray for each at work, Watch on the call that started one, and the row in the model menu. `?phase=agents` has two
 * subagents of the protocol: this extension's "Deploy audit", running, and "Changelog", another extension's, done.
 */
test.use({ installed: ['extensions/subagent'] });

const tray = (page: Page) => page.getByRole('group', { name: 'Running beside the conversation' });
const panel = (page: Page) => page.locator('.sub-panel');
const card = (page: Page, text: string) => page.locator('.chat-tool').filter({ hasText: text });

test('every subagent of the protocol is in the panel beside the chat, a running one in the tray, and Watch is on the call that started each', async ({ page }) => {
  await page.setViewportSize({ width: 1300, height: 800 });
  await page.goto('/tests/chat.html?phase=agents');
  // The header's button, while the chat has any; the tray, only the one at work.
  await expect(page.locator('.chat-header').getByRole('button', { name: 'Subagents', exact: true })).toBeVisible();
  await expect(tray(page).getByRole('button', { name: /Deploy audit/ })).toBeVisible();
  await expect(tray(page).getByRole('button', { name: /Changelog/ })).toHaveCount(0);
  // Watch while it runs, Open once it is over, without opening the card; nothing on a tool that only reports as it runs.
  await expect(card(page, 'subagent').getByRole('button', { name: 'Watch' })).toBeVisible();
  await expect(card(page, 'delegate').getByRole('button', { name: 'Open' })).toBeVisible();
  await expect(card(page, 'deep_research').getByRole('button', { name: /Watch|Open/ })).toHaveCount(0);

  await tray(page).getByRole('button', { name: /Deploy audit/ }).click();
  await expect(panel(page).locator('.sub-head')).toContainText('Deploy audit');
  await expect(panel(page).getByRole('tab')).toHaveText(['Deploy audit', 'Changelog']);
  await expect(panel(page).getByRole('tab', { name: 'Deploy audit' })).toHaveAttribute('aria-selected', 'true');
  // Its run, as the chat draws its own: what it was asked, its reply, its tool call.
  await expect(panel(page).locator('.side-transcript-prompt')).toHaveText('Audit the deploy script for anything that could lose data.');
  await expect(panel(page).getByText('before checking that the new build started', { exact: false })).toBeVisible();
  await expect(panel(page).locator('.chat-tool')).toContainText('read');

  // The other extension's, from its call's Open.
  await card(page, 'delegate').getByRole('button', { name: 'Open' }).click();
  await expect(panel(page).locator('.sub-head')).toContainText('Changelog');
  await expect(panel(page).locator('.sub-head')).toContainText('Finished');
  await expect(panel(page).getByText('The changelog lists three fixes.')).toBeVisible();
  // Over: nothing to tell it, nor to stop.
  await expect(panel(page).getByRole('textbox')).toHaveCount(0);
  await expect(panel(page).getByRole('button', { name: 'Stop' })).toHaveCount(0);
});

test('a message for a running subagent goes to it, and Stop stops it, through the portal\'s routes', async ({ page }) => {
  await page.setViewportSize({ width: 1300, height: 800 });
  const sent: { path: string; body: unknown }[] = [];
  await page.route('**/api/sessions/preview/subagents/**', async (route) => {
    sent.push({ path: new URL(route.request().url()).pathname, body: route.request().postDataJSON() });
    await route.fulfill({ json: { ok: true } });
  });
  await page.goto('/tests/chat.html?phase=agents');
  await card(page, 'subagent').getByRole('button', { name: 'Watch' }).click();
  const box = panel(page).getByRole('textbox', { name: 'Message for Deploy audit' });
  await box.fill('Check the restart step too.');
  await box.press('Enter');
  await expect(panel(page).getByText('Sent: “Check the restart step too.”')).toBeVisible();
  await expect(box).toHaveValue('');
  await panel(page).getByRole('button', { name: 'Stop' }).click();
  await expect.poll(() => sent).toEqual([
    { path: '/api/sessions/preview/subagents/sub1/input', body: { text: 'Check the restart step too.' } },
    { path: '/api/sessions/preview/subagents/sub1/stop', body: null },
  ]);
});

test('a running subagent is timed from its start in the panel, and its run is not drawn again for each second', async ({ page }) => {
  await page.setViewportSize({ width: 1300, height: 800 });
  await page.clock.install();
  await page.goto('/tests/chat.html?phase=agents&count=1');
  await tray(page).getByRole('button', { name: /Deploy audit/ }).click();
  const head = panel(page).locator('.sub-head');
  // Started forty seconds before the page was made, and the page takes a moment to come.
  await expect(head).toContainText(/· 4\ds/);
  await expect.poll(async () => (await page.evaluate(() => (window as any).drawn)).ChildItem ?? 0).toBeGreaterThan(0);
  // Settled: the clock stands still until it is run.
  await page.clock.runFor(200);
  const seconds = async () => Number((await head.textContent())!.match(/· (\d+)s/)![1]);
  const [before, at] = [await page.evaluate(() => ({ ...(window as any).drawn })), await seconds()];
  await page.clock.runFor(3000);
  await expect.poll(seconds).toBe(at + 3);
  expect((await page.evaluate(() => (window as any).drawn)).ChildItem).toBe(before.ChildItem);
});

/** The child chat `kid1` (`?phase=child-agent`) as the portal serves it: its stream, and the chat itself, `asking` or not. */
async function serveChild(page: Page, { asking = false } = {}) {
  const streams: string[] = [];
  const said = (seq: number, type: string, payload: unknown) => `id: ${seq}\ndata: ${JSON.stringify({ seq, type, at: Date.now() - 20_000, payload })}\n\n`;
  await page.route('**/api/sessions/kid1/events**', async (route) => {
    streams.push(new URL(route.request().url()).search);
    await route.fulfill({
      headers: { 'content-type': 'text/event-stream' },
      body:
        'event: live-reset\ndata: {}\n\n' +
        said(1, 'portal_prompt', { message: 'Check that last night\'s backup can be restored.' }) +
        said(2, 'tool_execution_start', { toolCallId: 'k1', toolName: 'bash', args: { command: 'restic snapshots' } }) +
        said(3, 'tool_execution_end', { toolCallId: 'k1', toolName: 'bash', result: { content: [{ type: 'text', text: 'snapshot 4f2a' }] } }) +
        said(4, 'message_end', { message: { role: 'assistant', content: [{ type: 'text', text: 'The latest snapshot is from 02:00.' }] } }) +
        'event: caught-up\ndata: {"seq":4}\n\n',
    });
  });
  await page.route('**/api/sessions/kid1', (route) => route.fulfill({ json: { id: 'kid1', title: 'Backup check', parent: 'preview', listed: false, status: 'running', ...(asking ? { asking: true } : {}) } }));
  return streams;
}

test('a subagent that works in a child chat is drawn from that chat\'s own transcript, and opens as that chat', async ({ page }) => {
  await page.setViewportSize({ width: 1300, height: 800 });
  const streams = await serveChild(page);
  await page.goto('/tests/chat.html?phase=child-agent');
  await card(page, 'subagent').getByRole('button', { name: 'Watch' }).click();
  await expect(panel(page).locator('.sub-head')).toContainText('Backup check');
  await expect(panel(page).locator('.side-transcript-prompt')).toHaveText("Check that last night's backup can be restored.");
  await expect(panel(page).locator('.chat-tool')).toContainText('restic snapshots');
  await expect(panel(page).getByText('The latest snapshot is from 02:00.')).toBeVisible();
  // Read from the start, as a page that opens a chat reads it.
  expect(streams[0]).toBe('?since=0');
  await expect(panel(page).locator('.sub-head')).not.toContainText('Waiting for you');
  await panel(page).getByRole('button', { name: 'Open as chat' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).navigated)).toEqual(['/s/kid1']);
});

test('a subagent whose chat waits for the person says so in the panel and the tray, with the way to its chat', async ({ page }) => {
  await page.setViewportSize({ width: 1300, height: 800 });
  await serveChild(page, { asking: true });
  await page.goto('/tests/chat.html?phase=child-agent');
  await expect(tray(page).getByRole('button', { name: /Backup check/ })).toContainText('waiting for you');
  await tray(page).getByRole('button', { name: /Backup check/ }).click();
  await expect(panel(page).locator('.sub-head')).toContainText('Waiting for you');
  await expect(panel(page).getByRole('status')).toContainText('It waits for you in its chat.');
  await panel(page).getByRole('button', { name: 'Open it to answer' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).navigated)).toEqual(['/s/kid1']);
});

test('a subagent whose chat is gone says so, and offers no way to it', async ({ page }) => {
  await page.setViewportSize({ width: 1300, height: 800 });
  await page.route('**/api/sessions/kid1/events**', (route) => route.fulfill({ status: 404, json: { error: 'Not found' } }));
  await page.route('**/api/sessions/kid1', (route) => route.fulfill({ status: 404, json: { error: 'Not found' } }));
  await page.goto('/tests/chat.html?phase=child-agent');
  await card(page, 'subagent').getByRole('button', { name: 'Watch' }).click();
  await expect(panel(page).getByText('Its chat is gone: it was deleted, or the subagent was stopped before it started.')).toBeVisible();
  await expect(panel(page).getByRole('button', { name: 'Open as chat' })).toHaveCount(0);
});

/** What the portal sends of an event of `kid1`'s stream. */
const told = (seq: number, type: string, payload: unknown) => `id: ${seq}\ndata: ${JSON.stringify({ seq, type, at: Date.now() - 20_000, payload })}\n\n`;
const run = (task: string, answer: string, from = 1) =>
  told(from, 'portal_prompt', { message: task }) + told(from + 1, 'message_end', { message: { role: 'assistant', content: [{ type: 'text', text: answer }] } });

/**
 * `kid1`'s stream, one answer for each time the page connects (`answers[n](since)` is the body of the n-th; the last
 * serves any later one), and the `since` of each. The page's clock is its own, so a reconnect does not wait for two
 * seconds of the test's.
 */
async function serveStream(page: Page, answers: ((since: number) => string)[]) {
  const connects: string[] = [];
  await page.clock.install();
  await page.route('**/api/sessions/kid1/events**', async (route) => {
    const since = new URL(route.request().url()).searchParams.get('since') ?? '';
    connects.push(since);
    await route.fulfill({ headers: { 'content-type': 'text/event-stream' }, body: answers[Math.min(connects.length, answers.length) - 1](Number(since)) });
  });
  await page.route('**/api/sessions/kid1', (route) => route.fulfill({ json: { id: 'kid1', title: 'Backup check', parent: 'preview', listed: false, status: 'running' } }));
  /** Lets the page's clock run until it has connected `n` times. */
  const connected = (n: number) =>
    expect
      .poll(async () => {
        await page.clock.runFor(2500);
        return connects.length;
      })
      .toBeGreaterThanOrEqual(n);
  return { connects, connected };
}
const head = (reloads: number) => `event: reloads\ndata: ${JSON.stringify({ reloads })}\n\nevent: live-reset\ndata: {}\n\n`;
const caughtUp = (seq: number) => `event: caught-up\ndata: {"seq":${seq}}\n\n`;

test('a reload of the child chat that happened while its stream was down is read again from the start', async ({ page }) => {
  await page.setViewportSize({ width: 1300, height: 800 });
  const { connects, connected } = await serveStream(page, [
    () => head(0) + run('Old task', 'Old answer') + caughtUp(2),
    // The portal has put events back under seqs the page read past: nothing is newer than seq 2.
    () => head(1) + caughtUp(0),
    () => head(1) + run('New task', 'New answer') + caughtUp(2),
  ]);
  await page.goto('/tests/chat.html?phase=child-agent');
  await card(page, 'subagent').getByRole('button', { name: 'Watch' }).click();
  await expect(panel(page).getByText('Old answer')).toBeVisible();
  await connected(3);
  await expect(panel(page).getByText('New answer')).toBeVisible();
  await expect(panel(page).getByText('Old answer')).toHaveCount(0);
  expect(connects).toEqual(['0', '2', '0']);
});

test('a child chat whose stream broke in the middle of its replay is read again from the start', async ({ page }) => {
  await page.setViewportSize({ width: 1300, height: 800 });
  const { connects, connected } = await serveStream(page, [
    // Cut off before it caught up: the first message has been read, the second has not.
    () => head(0) + told(1, 'portal_prompt', { message: 'The whole task' }),
    (since) => head(0) + (since === 0 ? run('The whole task', 'The whole answer') : told(2, 'message_end', { message: { role: 'assistant', content: [{ type: 'text', text: 'Only the end' }] } })) + caughtUp(2),
  ]);
  await page.goto('/tests/chat.html?phase=child-agent');
  await card(page, 'subagent').getByRole('button', { name: 'Watch' }).click();
  await connected(2);
  await expect(panel(page).getByText('The whole answer')).toBeVisible();
  await expect(panel(page).locator('.side-transcript-prompt')).toHaveText('The whole task');
  expect(connects).toEqual(['0', '0']);
});

test('a message taken out of the child chat leaves its stream, and the count it brings is not a missed reload', async ({ page }) => {
  await page.setViewportSize({ width: 1300, height: 800 });
  const { connects, connected } = await serveStream(page, [
    () => head(0) + run('First task', 'First answer') + caughtUp(2) + told(3, 'portal_prompt', { message: 'Second task' }) + told(4, 'message_end', { message: { role: 'assistant', content: [{ type: 'text', text: 'Second answer' }] } }) + told(5, 'portal_removed', { from: 3, to: null, reloads: 1 }),
    () => head(1) + caughtUp(5),
  ]);
  await page.goto('/tests/chat.html?phase=child-agent');
  await card(page, 'subagent').getByRole('button', { name: 'Watch' }).click();
  await expect(panel(page).getByText('First answer')).toBeVisible();
  await expect(panel(page).getByText('Second answer')).toHaveCount(0);
  await connected(2);
   // Read on from where it was, not from the start: it had heard the reload that the count says.
  expect(connects).toEqual(['0', '4']);
  await expect(panel(page).getByText('First answer')).toBeVisible();
  await expect(panel(page).getByText('Second answer')).toHaveCount(0);
});

test('the stream of a child chat is closed with the panel that draws it, and opened again with the next', async ({ page }) => {
  await page.setViewportSize({ width: 1300, height: 800 });
  const { connects, connected } = await serveStream(page, [() => head(0) + run('Task', 'Answered') + caughtUp(2)]);
  await page.goto('/tests/chat.html?phase=child-agent');
  await card(page, 'subagent').getByRole('button', { name: 'Watch' }).click();
  await expect(panel(page).getByText('Answered')).toBeVisible();
  // The body of a stream here ends at once, so an open one reconnects every few seconds.
  await connected(2);
  await page.locator('.chat-header').getByRole('button', { name: 'Subagents', exact: true }).click();
  await expect(panel(page)).toHaveCount(0);
  const before = connects.length;
  for (let i = 0; i < 4; i++) await page.clock.runFor(5000);
  expect(connects.length).toBe(before);
  await card(page, 'subagent').getByRole('button', { name: 'Watch' }).click();
  await expect(panel(page).getByText('Answered')).toBeVisible();
  expect(connects.length).toBe(before + 1);
});

test('a subagent whose chat asks, and is answered, stops saying it waits for the person', async ({ page }) => {
  await page.setViewportSize({ width: 1300, height: 800 });
  let asking = false;
  await page.clock.install();
  await page.route('**/api/sessions/kid1/events**', (route) => route.fulfill({ headers: { 'content-type': 'text/event-stream' }, body: head(0) + run('Check', 'Checked') + caughtUp(2) }));
  await page.route('**/api/sessions/kid1', (route) => route.fulfill({ json: { id: 'kid1', title: 'Backup check', parent: 'preview', listed: false, status: 'running', ...(asking ? { asking: true } : {}) } }));
  await page.goto('/tests/chat.html?phase=child-agent');
  const chip = tray(page).getByRole('button', { name: /Backup check/ });
  await expect(chip).toBeVisible();
  await expect(chip).not.toContainText('waiting for you');
  asking = true;
  await expect.poll(async () => { await page.clock.runFor(4500); return chip.textContent(); }).toContain('waiting for you');
  asking = false;
  await expect.poll(async () => { await page.clock.runFor(4500); return chip.textContent(); }).not.toContain('waiting for you');
});

test.describe('without the extension', () => {
  test.use({ installed: [] });

  test('a chat with subagents of the protocol has no button for them, no chip in the tray and no Watch', async ({ page }) => {
    await page.setViewportSize({ width: 1300, height: 800 });
    await page.goto('/tests/chat.html?phase=agents');
    await expect(card(page, 'subagent')).toBeVisible();
    // What the tray has besides, the chat's jobs and statuses, is there all the same.
    await expect(tray(page).getByText('npm run dev -- --port 5173')).toBeVisible();
    await expect(tray(page).getByRole('button', { name: /Deploy audit/ })).toHaveCount(0);
    await expect(page.locator('.chat-header').getByRole('button', { name: 'Subagents', exact: true })).toHaveCount(0);
    await expect(card(page, 'subagent').getByRole('button', { name: 'Watch' })).toHaveCount(0);
  });
});

test.describe("the row in the chat's model menu", () => {
  const model = '**/api/x/pithagoras-subagent/chats/preview/model';

  test("says what this chat's subagents run on, and a choice there is kept for the chat", async ({ page }) => {
    const saved: unknown[] = [];
    await page.route(model, async (route) => {
      if (route.request().method() === 'PUT') {
        const { model } = route.request().postDataJSON();
        saved.push(model);
        return route.fulfill({ json: { model, default: 'auto' } });
      }
      await route.fulfill({ json: { model: null, default: 'auto' } });
    });
    await page.goto('/tests/chat.html?phase=model');
    await page.getByTitle('Model A', { exact: true }).click();
    const picker = page.getByRole('combobox', { name: 'Subagents in this chat run on' });
    await expect(picker).toContainText("Default — this chat's model");
    await picker.click();
    await page.getByRole('option', { name: /This chat's model/ }).click();
    // The menu stays open across the choice made in it.
    await expect(picker).toContainText("This chat's model");
    expect(saved).toEqual(['auto']);
  });

  test('is asked for with the chat, so the model menu opens with it already there', async ({ page }) => {
    let asked = 0;
    await page.route(model, async (route) => {
      asked++;
      await new Promise((r) => setTimeout(r, 300));
      await route.fulfill({ json: { model: 'llama-swap/model-b', default: 'auto' } });
    });
    await page.goto('/tests/chat.html?phase=model');
    await expect.poll(() => asked).toBe(1);
    await page.waitForTimeout(400);
    await page.getByTitle('Model A', { exact: true }).click();
    // There in the first frame: nothing arrives after the menu to push it about.
    await expect(page.getByRole('combobox', { name: 'Subagents in this chat run on' })).toContainText('llama-swap/model-b', { timeout: 150 });
  });

  test('a choice the server half refuses goes back, and says why', async ({ page }) => {
    await page.route(model, async (route) => {
      if (route.request().method() === 'PUT') return route.fulfill({ status: 400, json: { error: 'model must be null, "auto" or provider/model' } });
      await route.fulfill({ json: { model: null, default: 'llama-swap/model-b' } });
    });
    await page.goto('/tests/chat.html?phase=model');
    await page.getByTitle('Model A', { exact: true }).click();
    const picker = page.getByRole('combobox', { name: 'Subagents in this chat run on' });
    await expect(picker).toContainText('Default — llama-swap/model-b');
    await picker.click();
    await page.getByRole('option', { name: /This chat's model/ }).click();
    await expect(page.getByRole('alert')).toContainText('model must be null');
    await expect(picker).toContainText('Default — llama-swap/model-b');
  });

  test('with the extension\'s server half not running, the chat opens without the row and the extension is not reported as failed', async ({ page }) => {
    // The page's list of extensions without the `server` of this one, as while its half is crashed or held off.
    const { server: _, ...listing } = extensionOnDisk(path.resolve('extensions/subagent')).listing as { server?: string };
    await page.route('**/api/extension-ui', (route) => route.fulfill({ json: { extensions: [listing] } }));
    const failures: unknown[] = [];
    await page.route('**/api/extension-ui/failures', async (route) => {
      failures.push(route.request().postDataJSON());
      await route.fulfill({ json: { ok: true } });
    });
    await page.goto('/tests/chat.html?phase=model');
    await page.getByTitle('Model A', { exact: true }).click();
    // The menu is there, the row is not, and nothing was told the portal.
    await expect(page.getByRole('button', { name: 'Refresh models' })).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Subagents in this chat run on' })).toHaveCount(0);
    await page.waitForTimeout(500);
    expect(failures).toEqual([]);
  });
});
