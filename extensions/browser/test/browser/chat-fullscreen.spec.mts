import { test, expect } from '../../../../tests/browser/portal-mock';
import { BASE, browserState } from './state';

/**
 * The browser beside a chat, with the panels of extensions' beside it: the portal's tests' stand-ins for them. Its
 * Fullscreen is its own panel's, through the handle every panel has.
 */
test.use({ installed: ['extensions/docker', 'extensions/browser', 'tests/fixtures/extensions/console', 'tests/fixtures/extensions/viewer'] });

test.beforeEach(async ({ page }) => {
  await page.route(`**${BASE}/state`, route => route.fulfill({ json: browserState({ running: true, install: { available: true, mode: 'docker', image: true, container: 'running', pulling: { active: false, line: '' } } }) }));
  await page.route(`**${BASE}/ui/`, route => route.fulfill({ contentType: 'text/html', body: '<body style="background:#171a20;color:#d1d8e3">A browser, in view.</body>' }));
  await page.goto('/tests/chat.html?phase=model');
  await page.getByRole('button', { name: 'Browser', exact: true }).click();
  await page.getByRole('button', { name: 'Console', exact: true }).click();
  await page.getByRole('button', { name: 'Fullscreen' }).click();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement?.querySelector('iframe') ? 'browser' : document.fullscreenElement?.tagName ?? null)).toBe('browser');
});

test('only the browser goes fullscreen, not the panel beside it', async ({ page }) => {
  expect(await page.evaluate(() => !!document.fullscreenElement?.querySelector('[role=tablist][aria-label=Consoles]'))).toBe(false);
  await page.getByRole('button', { name: 'Close Browser' }).click();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement)).toBeNull();
});

test('the browser closed for a third panel takes fullscreen with it', async ({ page }) => {
  await page.keyboard.press('Shift');
  await page.evaluate(() => (document.querySelector('[title="What the viewer shows"]') as HTMLElement).click());
  await expect(page.getByRole('button', { name: 'Close Browser' })).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => document.fullscreenElement)).toBeNull();
});
