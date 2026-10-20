import { type Page } from '@playwright/test';
import { test, expect, mockPortal } from './portal-mock';

/**
 * The Browser page's "Who may drive it": the default, the chats that have it otherwise, each said on or off, and the
 * routines whose own switch gives their runs the browser. And the sidebar lists the page for a routine given it.
 */
async function portal(page: Page, overrides: Record<string, unknown>) {
  await mockPortal(page, ({ path, method }) => {
    if (path === '/api/browser' && method === 'GET') {
      return {
        running: false, unprotected: false, connectedAs: null, version: null, pages: [], uiPort: '3011', uiExposed: false, uiOutdated: false, cursor: true, allowlist: '', configured: false, byDefault: true, sessions: [], routines: [],
        install: { available: true, mode: 'docker', image: true, container: 'stopped', binary: null, pulling: { active: false, line: '' } },
        config: { user: 'agent', hasPassword: true },
        ...overrides,
      };
    }
  });
}

test('the chats that differ from the default are each said on or off, and the routines given the browser are listed', async ({ page }) => {
  await portal(page, {
    configured: true,
    sessions: [{ id: 's1', title: 'Shopping', kind: 'task', allowed: false }],
    routines: [{ slug: 'nightly', name: 'Nightly digest', allowed: true }],
  });
  await page.goto('/browser');
  await expect(page.getByText(/^Every conversation, unless its own tools say otherwise/)).toBeVisible();
  const shopping = page.getByRole('button', { name: /Shopping/ });
  await expect(shopping).toContainText('off');
  await expect(page.getByRole('listitem').filter({ hasText: 'Nightly digest' })).toContainText('routine');
});

test('with the browser off by default, a routine that has it is listed, and the sidebar lists the page for it', async ({ page }) => {
  await portal(page, { byDefault: false, routines: [{ slug: 'shop', name: 'Shop check', allowed: true }] });
  await page.goto('/browser');
  await expect(page.getByText(/^No conversation, unless its own tools say otherwise/)).toBeVisible();
  await expect(page.getByRole('listitem').filter({ hasText: 'Shop check' })).toContainText('routine');
  await expect(page.getByRole('navigation', { name: 'Destinations' }).getByText('Browser', { exact: true }).first()).toBeAttached();
});

test('with the browser on by default too, a routine given it lists the page, where nothing else is set up; with none, it is not listed', async ({ page }) => {
  await portal(page, { routines: [{ slug: 'nightly', name: 'Nightly digest', allowed: true }] });
  await page.goto('/');
  await expect(page.getByRole('navigation', { name: 'Destinations' }).getByText('Browser', { exact: true }).first()).toBeAttached();
  await page.unroute('**/api/**');
  await portal(page, {});
  const asked = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/browser');
  await page.goto('/');
  await asked;
  await expect(page.getByRole('navigation', { name: 'Destinations' }).getByText('Routines', { exact: true }).first()).toBeAttached();
  await expect(page.getByRole('navigation', { name: 'Destinations' }).getByText('Browser', { exact: true })).toHaveCount(0);
});

test('where it may go is said on the page, and changed in Settings → Guard, the one place it is edited', async ({ page }) => {
  await portal(page, { configured: true });
  await page.goto('/browser');
  await expect(page.getByText(/^The sites the browser may reach are the list in .* An empty list means any site\.$/)).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Where it may go' })).toHaveCount(0);
  await page.getByRole('link', { name: 'Settings → Guard' }).click();
  await expect(page).toHaveURL(/\/settings\/guard$/);
});
