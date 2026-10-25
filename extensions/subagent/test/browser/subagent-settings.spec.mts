import { type Page } from '@playwright/test';
import { test, expect, mockPortal, reply } from '../../../../tests/browser/portal-mock';

/**
 * The subagent extension's page in Settings (src/web/SubagentSettings.tsx), over what its server half would answer: how
 * a subagent runs against the agent, how many run at once, the model, and whether their chats are kept, each saved as
 * it is chosen.
 */
test.use({ installed: ['extensions/subagent'] });

const BASE = '/api/x/pithagoras-subagent';

/** The server half as the page reaches it; what the page sent it, in order. */
async function portal(page: Page, { down = false } = {}) {
  const sent: unknown[] = [];
  const failing = { down };
  const state = { mode: 'interrupt', maxParallel: 1, maxParallelLimit: 16, model: 'auto', keep: false };
  await mockPortal(page, ({ path, method, json }) => {
    // Settings lists the extension as the portal has it installed.
    if (path === '/api/extensions' && method === 'GET') return { settingsPath: '/a/settings.json', extensions: [{ spec: 'extensions/subagent', name: 'pithagoras-subagent', version: '0.2.0', settings: [] }] };
    if (path === '/api/models') return { models: [{ provider: 'p', id: 'm', name: 'M' }, { provider: 'llama-swap', id: 'model-b', name: 'Model B' }], providers: { p: 'p' } };
    if (path === `${BASE}/settings` && method === 'GET') return failing.down ? reply(500, { error: 'The portal is starting up' }) : state;
    if (path === `${BASE}/settings` && method === 'PUT') {
      const change = json();
      sent.push(change);
      Object.assign(state, change);
      return { ...state, reloaded: 1, waiting: 1 };
    }
    return undefined;
  }, { settings: true });
  return { sent, up: () => void (failing.down = false) };
}

const settings = (page: Page) => page.getByRole('dialog', { name: 'Settings' });

test("Subagents is a page of Settings, listed by the extension's title and mark, and the mode is chosen there", async ({ page }) => {
  const { sent } = await portal(page);
  await page.goto('/settings/general');
  const dialog = settings(page);
  const entry = dialog.getByRole('navigation').getByRole('button', { name: 'Subagents', exact: true });
  await expect(entry.locator('svg')).toHaveCount(1);
  await entry.click();
  await expect(dialog.getByRole('radio', { name: /^Interrupt/ })).toBeChecked();
  // It is switched in Extensions, like any extension: the page has no switch of its own.
  await expect(dialog.getByRole('switch', { name: 'Subagent tool' })).toHaveCount(0);

  await dialog.getByRole('radio', { name: /^Background/ }).check();
  await expect(dialog.getByRole('radio', { name: /^Background/ })).toBeChecked();
  await expect(dialog.getByText(/one busy chat has it from its next step/)).toBeVisible();
  await expect(dialog.getByText(/two model calls at the same time/)).toBeVisible();
  expect(sent).toEqual([{ mode: 'background' }]);
});

test('a first read that fails says so, instead of a placeholder for ever, and the page comes when it is read again', async ({ page }) => {
  const { up } = await portal(page, { down: true });
  await page.goto('/settings/x/pithagoras-subagent');
  const dialog = settings(page);
  await expect(dialog.getByRole('alert')).toContainText('Could not load this: The portal is starting up');
  await expect(dialog.getByRole('radio', { name: /^Interrupt/ })).toHaveCount(0);
  up();
  await dialog.getByRole('alert').getByRole('button', { name: 'Try again' }).click();
  await expect(dialog.getByRole('radio', { name: /^Interrupt/ })).toBeChecked();
  await expect(dialog.getByRole('alert')).toHaveCount(0);
});

test('one subagent at a time unless more are allowed, up and down by one', async ({ page }) => {
  const { sent } = await portal(page);
  await page.goto('/settings/x/pithagoras-subagent');
  const at = settings(page).getByRole('group', { name: 'Subagents at once' });
  await expect(at.locator('output')).toHaveText('1');
  await expect(at.getByRole('button', { name: 'Fewer at once' })).toBeDisabled();
  await at.getByRole('button', { name: 'More at once' }).click();
  await expect(at.locator('output')).toHaveText('2');
  await expect(at.getByRole('button', { name: 'Fewer at once' })).toBeEnabled();
  await at.getByRole('button', { name: 'Fewer at once' }).click();
  await expect(at.locator('output')).toHaveText('1');
  expect(sent).toEqual([{ maxParallel: 2 }, { maxParallel: 1 }]);
});

test("subagents run on the chat's model unless one is named", async ({ page }) => {
  const { sent } = await portal(page);
  await page.goto('/settings/x/pithagoras-subagent');
  const model = settings(page).getByRole('combobox', { name: 'Subagent model' });
  await expect(model).toContainText('Same as the chat');
  await model.click();
  await page.getByRole('option', { name: /Model B/ }).click();
  await expect(model).toContainText('Model B');
  expect(sent).toEqual([{ model: 'llama-swap/model-b' }]);
});

test('the search of Settings finds the subagents on their page, and lights up the part it leads to', async ({ page }) => {
  await portal(page);
  for (const [words, part] of [['teilagenten', 'How a subagent runs against the agent'], ['parallel', 'Subagents at once'], ['unterchats', 'Keep subagent chats']]) {
    await page.goto('/settings/general');
    const dialog = settings(page);
    await expect(dialog.getByLabel('Default model')).toBeVisible();
    await dialog.getByLabel('Search settings').fill(words);
    await dialog.getByRole('option').first().click();
    await expect(dialog.getByRole('group', { name: 'Subagents at once' })).toBeVisible();
    await expect(dialog.locator(`[data-setting="${part}"]`)).toHaveClass(/setting-flash/);
  }
});

test('the page fits a phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await portal(page);
  await page.goto('/settings/x/pithagoras-subagent');
  await expect(settings(page).getByRole('group', { name: 'Subagents at once' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test('subagent chats are not kept unless switched on here', async ({ page }) => {
  const { sent } = await portal(page);
  await page.goto('/settings/x/pithagoras-subagent');
  const keep = settings(page).getByRole('switch', { name: 'Keep subagent chats' });
  await expect(keep).not.toBeChecked();
  await expect(settings(page).getByText(/listed under its chat as a sub-chat/)).toBeVisible();
  await keep.click();
  await expect(keep).toBeChecked();
  expect(sent).toEqual([{ keep: true }]);
});
