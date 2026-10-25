import { type Page } from '@playwright/test';
import { test, expect, mockPortal } from './portal-mock';

/** The portal with no server: Settings → Tools, over canned answers for its tools. */
async function portal(page: Page) {
  await mockPortal(page, async ({ path: p, method }) => {
    if (p === '/api/settings') return {
      settings: { provider: 'p', model: 'm', thinkingLevel: 'medium' }, stored: {}, defaults: { provider: 'p', model: 'm', thinkingLevel: 'medium' },
      piSettingsPath: '/a/settings.json', compaction: { keepRecentTokens: 20000 }, compactionDefaults: { keepRecentTokens: 20000 }, contextDefault: null, executor: 'host', workspaceRoot: '/w',
    };
    if (p === '/api/models') return { models: [{ provider: 'p', id: 'm', name: 'M', contextWindow: 65536 }], providers: { p: 'p' } };
    if (p === '/api/tools' && method === 'GET') return { tools: [], off: [], names: {} };
  }, { settings: true });
}

const settings = (page: Page) => page.getByRole('dialog', { name: 'Settings' });

test('Settings has no Add-ons page, and Tools has no subagent tool of its own, which is an extension, and fits a phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await portal(page);
  // Nothing on the page asks the portal for the subagent's settings: they are its extension's.
  const asked: string[] = [];
  page.on('request', (request) => request.url().includes('/api/features/subagent') && asked.push(request.url()));
  await page.goto('/settings/tools');
  await expect(settings(page).getByRole('heading', { name: 'Questions from the agent' })).toBeVisible();
  await expect(settings(page).getByRole('switch', { name: 'Subagent tool' })).toHaveCount(0);
  await expect(settings(page).getByRole('group', { name: 'Subagents at once' })).toHaveCount(0);
  await expect(settings(page).getByText('Add-ons', { exact: true })).toHaveCount(0);
  expect(asked).toEqual([]);
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(width).toBeLessThanOrEqual(390);
});
