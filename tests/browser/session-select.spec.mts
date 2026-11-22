import { type Page } from '@playwright/test';
import { test, expect, mockPortal, reply } from './portal-mock';

/** Deleting several chats at once, on the Sessions page: choosing them, the one question, and what a refusal leaves. */

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
const chat = (id: string, title: string, days: number, extra: Record<string, unknown> = {}) => ({
  id, title, workspace: `/w/${id}`, status: 'idle', kind: 'task', pinned: false, updated_at: daysAgo(days), created_at: daysAgo(days),
  provider: null, model: null, thinking_level: null, ...extra,
});

/** Four chats; what is deleted is gone from the next list, and `refuse` names one the server will not delete. */
async function portal(page: Page, refuse?: string) {
  const deleted: string[] = [];
  const all = [chat('new', 'Fresh chat', 1), chat('stale', 'Stale chat', 40), chat('ancient', 'Ancient chat', 100), chat('pin', 'Starred chat', 100, { pinned: true })];
  await mockPortal(page, ({ path, method }) => {
    if (path === '/api/sessions' && method === 'GET') return { sessions: all.filter((s) => !deleted.includes(s.id)), executor: 'host' };
    if (path === '/api/projects') return { root: '/w', home: '/h', projects: [] };
    const del = /^\/api\/sessions\/([^/]+)$/.exec(path);
    if (del && method === 'DELETE') {
      if (del[1] === refuse) return reply(500, { error: 'The disk is full' });
      deleted.push(del[1]);
      return { ok: true };
    }
  });
  return deleted;
}

const list = (page: Page) => page.locator('.sessions-list');
const row = (page: Page, title: string) => list(page).getByRole('listitem').filter({ hasText: title });
const dialog = (page: Page) => page.getByRole('alertdialog');

test('chats chosen on the Sessions page are deleted together, after one question', async ({ page }) => {
  const deleted = await portal(page);
  await page.goto('/sessions');
  await list(page).getByRole('button', { name: 'Select', exact: true }).click();
  // Choosing, a row's buttons are not offered and a click on a row chooses it instead of opening it.
  await expect(row(page, 'Fresh chat').getByRole('button', { name: 'Delete Fresh chat' })).toHaveCount(0);
  await row(page, 'Stale chat').click();
  await row(page, 'Ancient chat').getByRole('checkbox', { name: 'Select Ancient chat' }).check();
  await expect(page).toHaveURL(/\/sessions$/);
  await expect(list(page).getByRole('status')).toHaveText('2 selected');
  await list(page).getByRole('button', { name: 'Delete 2 chats' }).click();
  await expect(dialog(page)).toContainText('Delete 2 chats?');
  await expect(dialog(page)).toContainText('"Stale chat", "Ancient chat"');
  await dialog(page).getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(row(page, 'Stale chat')).toHaveCount(0);
  await expect(row(page, 'Ancient chat')).toHaveCount(0);
  await expect(row(page, 'Fresh chat')).toBeVisible();
  expect(deleted.sort()).toEqual(['ancient', 'stale']);
  // Done: the page is back to listing chats.
  await expect(list(page).getByRole('checkbox')).toHaveCount(0);
});

test('"older than" selects the chats not touched for that long, but never a pinned one', async ({ page }) => {
  await portal(page);
  await page.goto('/sessions');
  await list(page).getByRole('button', { name: 'Select', exact: true }).click();
  await list(page).getByRole('combobox', { name: 'Select the chats older than' }).click();
  await page.getByRole('option', { name: '30 days' }).click();
  await expect(list(page).getByRole('status')).toHaveText('2 selected');
  await expect(row(page, 'Stale chat').getByRole('checkbox')).toBeChecked();
  await expect(row(page, 'Ancient chat').getByRole('checkbox')).toBeChecked();
  await expect(row(page, 'Fresh chat').getByRole('checkbox')).not.toBeChecked();
  await expect(row(page, 'Starred chat').getByRole('checkbox')).not.toBeChecked();
  const bar = page.getByRole('group', { name: 'Delete several chats' });
  await bar.getByRole('button', { name: 'Select all shown' }).click();
  await expect(list(page).getByRole('status')).toHaveText('4 selected');
  await bar.getByRole('button', { name: 'Select none' }).click();
  await expect(list(page).getByRole('status')).toHaveText('0 selected');
});

test('only what a search shows is deleted, and Select all shown means those', async ({ page }) => {
  const deleted = await portal(page);
  await page.goto('/sessions');
  await list(page).getByRole('button', { name: 'Select', exact: true }).click();
  await list(page).getByRole('button', { name: 'Select all shown' }).click();
  await expect(list(page).getByRole('status')).toHaveText('4 selected');
  await list(page).getByPlaceholder('Search by name or folder…').fill('ancient');
  // "Ancient chat" only: the chats the search hides are not counted, and not deleted.
  await expect(list(page).getByRole('status')).toHaveText('1 selected');
  await list(page).getByRole('button', { name: 'Delete 1 chat' }).click();
  await dialog(page).getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(row(page, 'Ancient chat')).toHaveCount(0);
  expect(deleted).toEqual(['ancient']);
});

test('a chat the server refuses stays, chosen, with the reason; the others are gone', async ({ page }) => {
  const deleted = await portal(page, 'stale');
  await page.goto('/sessions');
  await list(page).getByRole('button', { name: 'Select', exact: true }).click();
  await row(page, 'Stale chat').click();
  await row(page, 'Ancient chat').click();
  await list(page).getByRole('button', { name: 'Delete 2 chats' }).click();
  await dialog(page).getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(list(page).getByRole('alert')).toHaveText('Could not delete "Stale chat": The disk is full');
  await expect(row(page, 'Ancient chat')).toHaveCount(0);
  await expect(row(page, 'Stale chat').getByRole('checkbox')).toBeChecked();
  expect(deleted).toEqual(['ancient']);
});

test('Select all shown leaves out the chats of a folder that is shut, and the question counts a lone sub-chat right', async ({ page }) => {
  const deleted: string[] = [];
  const all = [
    chat('a1', 'Alpha one', 1, { workspace: '/w/alpha' }),
    chat('a2', 'Alpha two', 2, { workspace: '/w/alpha' }),
    chat('a2s', 'Alpha helper', 2, { workspace: '/w/alpha', parent: 'a2', listed: true }),
    chat('b1', 'Beta one', 3, { workspace: '/w/beta' }),
    chat('b2', 'Beta two', 4, { workspace: '/w/beta' }),
  ];
  await mockPortal(page, ({ path, method }) => {
    if (path === '/api/sessions' && method === 'GET') return { sessions: all.filter((s) => !deleted.includes(s.id)), executor: 'host' };
    if (path === '/api/projects') {
      return { root: '/w', home: '/h', projects: ['alpha', 'beta'].map((name) => ({ name, path: `/w/${name}`, isGit: false, hasInstructions: false, hasTools: false, sessions: 0, lastActive: null })) };
    }
    const del = /^\/api\/sessions\/([^/]+)$/.exec(path);
    if (del && method === 'DELETE') {
      deleted.push(del[1]);
      return { ok: true };
    }
  });
  await page.goto('/sessions');
  const main = page.getByRole('main');
  await expect(main.getByRole('button', { name: 'beta', exact: true })).toHaveAttribute('aria-expanded', 'true');
  await main.getByRole('button', { name: 'beta', exact: true }).click();
  await expect(main.getByRole('button', { name: 'beta', exact: true })).toHaveAttribute('aria-expanded', 'false');
  await expect(row(page, 'Beta one')).toHaveCount(0);
  await list(page).getByRole('button', { name: 'Select', exact: true }).click();
  await list(page).getByRole('button', { name: 'Select all shown' }).click();
  // Alpha's two chats are on screen; Beta's are not, so they are neither counted nor named nor deleted.
  await expect(list(page).getByRole('status')).toHaveText('2 selected');
  await list(page).getByRole('button', { name: 'Delete 2 chats' }).click();
  await expect(dialog(page)).toContainText('"Alpha one", "Alpha two"');
  await expect(dialog(page)).not.toContainText('Beta');
  await expect(dialog(page)).toContainText('One sub-chat is deleted with them.');
  await dialog(page).getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(row(page, 'Alpha one')).toHaveCount(0);
  expect(deleted.sort()).toEqual(['a1', 'a2']);
});
