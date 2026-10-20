import { test, expect } from '../../../../tests/browser/portal-mock';
import { browserState, withBrowser } from './state';

test.use({ installed: ['extensions/docker', 'extensions/browser'] });

/**
 * What the Browser page offers when the portal is not on HTTPS and so cannot embed the browser. The direct link goes to the
 * browser's own port, which answers other machines only if it was set up to; and a browser installed before that port was
 * kept to one address is told so. Over canned answers.
 */
async function open(page: import('@playwright/test').Page, ui: { uiExposed: boolean; uiOutdated: boolean }) {
  // Plain HTTP as seen from another machine: the dev server is on localhost, which counts as secure.
  await page.addInitScript(() => Object.defineProperty(window, 'isSecureContext', { value: false }));
  await withBrowser(page, () =>
    browserState({
      running: true, connected: true, version: 'Chrome/1', ...ui,
      install: { available: true, mode: 'docker', image: true, container: 'running', pulling: { active: false, line: '' } },
    }),
  );
  await page.goto('/x/pithagoras-browser/browser');
  await expect(page.getByText('The portal is on plain HTTP')).toBeVisible();
}

test('a browser whose port answers only this machine has no link from a portal that cannot embed it', async ({ page }) => {
  await open(page, { uiExposed: false, uiOutdated: false });
  await expect(page.getByRole('link', { name: 'Open browser' })).toHaveCount(0);
  await expect(page.getByText('answers this machine only')).toBeVisible();
  await expect(page.getByText('BROWSER_BIND')).toBeVisible();
  await expect(page.getByText('installed before its own port was kept')).toHaveCount(0);
});

test('a browser whose port is open to other machines keeps the link to it', async ({ page }) => {
  await open(page, { uiExposed: true, uiOutdated: false });
  await expect(page.getByRole('link', { name: 'Open browser' })).toHaveAttribute('href', /^https:\/\/[^/]+:3011\/$/);
  await expect(page.getByText('answers this machine only')).toHaveCount(0);
});

test('a browser installed before its port was kept to one address is told to be installed again', async ({ page }) => {
  await open(page, { uiExposed: true, uiOutdated: true });
  await expect(page.getByText('installed before its own port was kept to this machine')).toBeVisible();
  await expect(page.getByText('Remove it and install it again')).toBeVisible();
});
