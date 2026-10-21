import { type Page } from '@playwright/test';
import { test, expect } from '../../../../tests/browser/portal-mock';
import { BASE, browserState, withBrowser } from './state';

test.use({ installed: ['extensions/docker', 'extensions/browser'] });

/**
 * The Browser page's "Who may drive it": the default, the chats that have it otherwise, each said on or off, and the
 * routines whose own switches give their runs another answer. And the sidebar lists the page while there is a browser,
 * the agent has its tools, or a routine is given them otherwise, following what the page changes.
 */
async function portal(page: Page, overrides: Record<string, unknown>) {
  const state = { ...overrides };
  const calls: string[] = [];
  await withBrowser(
    page,
    () => browserState({ install: { available: true, mode: 'docker', image: true, container: 'stopped', binary: null, pulling: { active: false, line: '' } }, ...state }),
    ({ path, method }) => {
      if (path === `${BASE}/connect`) {
        calls.push(`${method} /connect`);
        state.connected = method === 'POST';
        return { connected: state.connected };
      }
    },
  );
  return { state, calls };
}

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Destinations' });

test('the chats that differ from the default are each said on or off, and the routines given another answer are listed with it', async ({ page }) => {
  await portal(page, {
    connected: true,
    chats: [{ id: 's1', title: 'Shopping', kind: 'task', allowed: false }],
    routines: [{ slug: 'nightly', name: 'Nightly digest', allowed: true }],
  });
  await page.goto('/x/pithagoras-browser/browser');
  await expect(page.getByText(/^Every conversation, unless its own tools say otherwise/)).toBeVisible();
  const shopping = page.getByRole('button', { name: /Shopping/ });
  await expect(shopping).toContainText('off');
  await expect(shopping).toContainText('task');
  const nightly = page.getByRole('listitem').filter({ hasText: 'Nightly digest' });
  await expect(nightly).toContainText('routine');
  await expect(nightly).toContainText('on');
  // A chat opens from here.
  await shopping.click();
  await expect(page).toHaveURL(/\/s\/s1$/);
});

test('with the browser off by default, a routine that has it is listed, and the sidebar lists the page for it', async ({ page }) => {
  await portal(page, { byDefault: false, routines: [{ slug: 'shop', name: 'Shop check', allowed: true }] });
  await page.goto('/x/pithagoras-browser/browser');
  await expect(page.getByText(/^No conversation, unless its own tools say otherwise/)).toBeVisible();
  await expect(page.getByRole('listitem').filter({ hasText: 'Shop check' })).toContainText('routine');
  await expect(sidebar(page).getByRole('button', { name: 'Browser' })).toBeVisible();
});

test('a routine given it lists the page, where nothing else is set up; with none, it is not listed', async ({ page }) => {
  const { state } = await portal(page, { routines: [{ slug: 'nightly', name: 'Nightly digest', allowed: true }] });
  await page.goto('/');
  await expect(sidebar(page).getByRole('button', { name: 'Browser' })).toBeVisible();
  state.routines = [];
  const asked = page.waitForResponse((response) => new URL(response.url()).pathname === `${BASE}/state`);
  await page.goto('/');
  await asked;
  await expect(sidebar(page).getByRole('button', { name: 'Routines' })).toBeVisible();
  await expect(sidebar(page).getByRole('button', { name: 'Browser' })).toHaveCount(0);
});

test('the sidebar follows what the page changes: the agent disconnected from a browser that is not running takes the page out of it', async ({ page }) => {
  const { calls } = await portal(page, { connected: true });
  await page.goto('/x/pithagoras-browser/browser');
  await expect(sidebar(page).getByRole('button', { name: 'Browser' })).toBeVisible();
  await expect(page.getByText(/^The agent still holds the browser tools for a browser that is not running/)).toBeVisible();
  await page.getByRole('button', { name: 'Disconnect' }).click();
  await expect(sidebar(page).getByRole('button', { name: 'Browser' })).toHaveCount(0);
  expect(calls).toEqual(['DELETE /connect']);
});

test('a browser that runs with the agent not connected says so, and Connect the agent asks for that and nothing else', async ({ page }) => {
  const { calls } = await portal(page, { running: true, version: 'Chrome/141', install: { available: true, mode: 'docker', image: true, container: 'running', pulling: { active: false, line: '' } } });
  await page.goto('/x/pithagoras-browser/browser');
  await expect(page.getByText('Chrome/141')).toBeVisible();
  await page.getByRole('button', { name: 'Connect the agent' }).click();
  await expect(page.getByRole('button', { name: 'Connect the agent' })).toHaveCount(0);
  expect(calls).toEqual(['POST /connect']);
});

test('where it may go is said on the page, and changed in Settings → Guard, the one place it is edited', async ({ page }) => {
  await portal(page, { connected: true });
  await page.goto('/x/pithagoras-browser/browser');
  await expect(page.getByText(/^The sites the browser may reach are the list in .* An empty list means any site\.$/)).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Where it may go' })).toHaveCount(0);
  await page.getByRole('link', { name: 'Settings → Guard' }).click();
  await expect(page).toHaveURL(/\/settings\/guard$/);
});
