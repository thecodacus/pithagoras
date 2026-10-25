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
