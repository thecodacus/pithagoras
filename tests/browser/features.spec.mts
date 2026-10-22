import { type Page } from '@playwright/test';
import { test, expect, mockPortal } from './portal-mock';

/** The portal with no server: Settings → Tools, over canned answers for its tools and the subagent tool. */
async function portal(page: Page, { available = true } = {}) {
  const sent: { path: string; body: any }[] = [];
  const state = {
    subagent: { available, installed: false, enabled: false, source: null as string | null, mode: 'interrupt', maxParallel: 1, model: 'auto' },
  };
  await mockPortal(page, async ({ path: p, method, json }) => {
    if (p === '/api/settings') return {
      settings: { provider: 'p', model: 'm', thinkingLevel: 'medium' }, stored: {}, defaults: { provider: 'p', model: 'm', thinkingLevel: 'medium' },
      piSettingsPath: '/a/settings.json', compaction: { keepRecentTokens: 20000 }, compactionDefaults: { keepRecentTokens: 20000 }, contextDefault: null, executor: 'host', workspaceRoot: '/w',
    };
    if (p === '/api/models') return { models: [{ provider: 'p', id: 'm', name: 'M', contextWindow: 65536 }, { provider: 'llama-swap', id: 'model-b', name: 'Model B' }], providers: { p: 'p' } };
    if (p === '/api/tools' && method === 'GET') return { tools: [], off: [], names: {} };
    if (p === '/api/features/subagent' && method === 'GET') return { subagent: state.subagent };
    if (p === '/api/features/flags') return { subagent: { enabled: state.subagent.enabled }, memory: { held: false, by: null } };
    if (p === '/api/features/subagent' && method === 'PUT') {
      const patch = json();
      sent.push({ path: p, body: patch });
      if (patch.mode) state.subagent.mode = patch.mode;
      if (patch.maxParallel) state.subagent.maxParallel = patch.maxParallel;
      if (patch.model) state.subagent.model = patch.model;
      if (patch.enabled !== undefined) Object.assign(state.subagent, { enabled: patch.enabled, installed: patch.enabled, source: patch.enabled ? '/app/extensions/subagent' : null });
      return { subagent: state.subagent, reloaded: 1, waiting: 1 };
    }
  }, { settings: true });
  return { sent };
}

const settings = (page: Page) => page.getByRole('dialog', { name: 'Settings' });

test('a fresh install has no subagent tool; switching it on installs it, and the mode is its own choice', async ({ page }) => {
  const { sent } = await portal(page);
  await page.goto('/settings/tools');
  const tool = settings(page).getByRole('switch', { name: 'Subagent tool' });
  await expect(tool).toHaveAttribute('aria-checked', 'false');
  await expect(settings(page).getByText('Off: the agent has no subagent tool.')).toBeVisible();
  await expect(settings(page).getByRole('radio', { name: /^Interrupt/ })).toBeChecked();

  await tool.click();
  await expect(tool).toHaveAttribute('aria-checked', 'true');
  await expect(settings(page).getByText('Installed as a pi package (/app/extensions/subagent).')).toBeVisible();
  await expect(settings(page).getByText(/one busy chat has it from its next step/)).toBeVisible();

  await settings(page).getByRole('radio', { name: /^Background/ }).check();
  await expect(settings(page).getByRole('radio', { name: /^Background/ })).toBeChecked();
  expect(sent.map((s) => s.body)).toEqual([{ enabled: true }, { mode: 'background' }]);
  await expect(settings(page).getByText(/two model calls at the same time/)).toBeVisible();
});

test('one subagent at a time unless more are allowed, up and down by one', async ({ page }) => {
  const { sent } = await portal(page);
  await page.goto('/settings/tools');
  const at = settings(page).getByRole('group', { name: 'Subagents at once' });
  await expect(at.locator('output')).toHaveText('1');
  await expect(at.getByRole('button', { name: 'Fewer at once' })).toBeDisabled();
  await at.getByRole('button', { name: 'More at once' }).click();
  await expect(at.locator('output')).toHaveText('2');
  await expect(at.getByRole('button', { name: 'Fewer at once' })).toBeEnabled();
  await at.getByRole('button', { name: 'Fewer at once' }).click();
  await expect(at.locator('output')).toHaveText('1');
  expect(sent.map((s) => s.body)).toEqual([{ maxParallel: 2 }, { maxParallel: 1 }]);
});

test('an install without the subagent tool cannot switch it on', async ({ page }) => {
  await portal(page, { available: false });
  await page.goto('/settings/tools');
  await expect(settings(page).getByRole('switch', { name: 'Subagent tool' })).toBeDisabled();
  await expect(settings(page).getByText('This install does not carry the subagent tool.')).toBeVisible();
});

test('subagents run on the chat\'s model unless one is named', async ({ page }) => {
  const { sent } = await portal(page);
  await page.goto('/settings/tools');
  const model = settings(page).getByRole('combobox', { name: 'Subagent model' });
  await expect(model).toContainText('Same as the chat');
  await model.click();
  await page.getByRole('option', { name: /Model B/ }).click();
  await expect(model).toContainText('Model B');
  expect(sent.at(-1)!.body).toEqual({ model: 'llama-swap/model-b' });
});

test('the search of Settings finds the subagent tool in Tools', async ({ page }) => {
  await portal(page);
  await page.goto('/settings/general');
  const dialog = settings(page);
  await expect(dialog.getByLabel('Default model')).toBeVisible();
  await dialog.getByLabel('Search settings').fill('teilagenten');
  await dialog.getByRole('option').first().click();
  await expect(dialog.getByRole('switch', { name: 'Subagent tool' })).toBeVisible();
  await expect(dialog.locator('[data-setting="Subagents"]')).toHaveClass(/setting-flash/);
});

test('Settings has no Add-ons page, and Tools with the subagent tool fits a phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await portal(page);
  await page.goto('/settings/tools');
  await expect(settings(page).getByRole('switch', { name: 'Subagent tool' })).toBeVisible();
  await expect(settings(page).getByText('Add-ons', { exact: true })).toHaveCount(0);
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(width).toBeLessThanOrEqual(390);
});
