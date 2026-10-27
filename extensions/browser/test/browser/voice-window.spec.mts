import { type Page } from '@playwright/test';
import { test, expect } from '../../../../tests/browser/portal-mock';
import { settled } from '../../../../tests/browser/settled';
import { BASE, browserState } from './state';

/**
 * The browser in voice mode (src/web/BrowserScreen.tsx, and src/calls.ts for which calls drive it): a window at the
 * side, or in the middle beside the conversation, that opens as the agent drives the browser, from the card of such a
 * call, by its button and by B, and says so when there is no browser to show.
 */
test.use({ installed: ['extensions/docker', 'extensions/browser'] });

const RUNNING = { running: true, connected: true, install: { available: true, mode: 'docker', image: true, container: 'running', pulling: { active: false, line: '' } } };

/** Voice mode on the voice fixture, with the browser as `state` says, and its web UI answering through the server half. */
async function voice(page: Page, state: Record<string, unknown> = RUNNING) {
  await page.addInitScript(() => {
    // Streams, which have no server behind them here.
    (window as any).EventSource = class { onmessage: any; onopen: any; close() {} };
  });
  await page.route('**/api/sessions/test/commands', (route) => route.fulfill({ json: { commands: [] } }));
  await page.route('**/api/sessions/test/config', (route) => route.fulfill({ status: 503, json: {} }));
  await page.route('**/api/voice', (route) => route.fulfill({ json: { enabled: true } }));
  await page.route(`**${BASE}/state`, (route) => route.fulfill({ json: browserState(state) }));
  await page.route(`**${BASE}/ui/`, (route) => route.fulfill({ contentType: 'text/html', body: '<body style="margin:0;background:#171a20;color:#d1d8e3;padding:36px">A browser, in view.</body>' }));
  await page.setViewportSize({ width: 1400, height: 860 });
  await page.goto('/tests/voice.html');
  await page.getByRole('button', { name: 'Turn on hands-free voice' }).click();
  await expect(page.getByRole('status')).toHaveText('Listening', { timeout: 25000 });
}

const windowOf = (page: Page) => page.locator('.voice-extension-window[data-extension="pithagoras-browser"]');

test('the agent driving the browser opens it at the side, its web UI through the server half, and its card says what it does', async ({ page }) => {
  await voice(page);
  const browser = windowOf(page);
  await expect(browser).toHaveCount(0);
  // A Playwright MCP's tool, behind the MCP adapter.
  await page.getByRole('button', { name: 'Use browser', exact: true }).click();
  await expect(browser).toHaveClass(/is-open/);
  // Alone it stands at the side, as every window opened alone does, beside the orb.
  await expect(browser).toHaveClass(/as-side/);
  await expect(browser.locator('iframe')).toHaveAttribute('src', `${BASE}/ui/`);
  await expect(browser.frameLocator('iframe').locator('body')).toHaveText('A browser, in view.');
  const card = page.getByLabel('Tool activity').getByRole('button', { name: /Opening a page/ });
  await expect(card).toContainText('example.com');
  await expect(card).toHaveAttribute('title', 'Show Browser');

  // Minimized, the card opens it again: kept loaded, its frame is the one it had.
  await page.evaluate(() => ((window as any).frameKept = document.querySelector('.voice-extension-window[data-extension="pithagoras-browser"] iframe')));
  await page.getByRole('button', { name: 'Minimize Browser' }).click();
  await expect(browser).not.toHaveClass(/is-open/);
  await card.click();
  await expect(browser).toHaveClass(/is-open/);
  expect(await page.evaluate(() => (window as any).frameKept === document.querySelector('.voice-extension-window[data-extension="pithagoras-browser"] iframe'))).toBe(true);
});

test('maximized, Escape from inside the page in it restores it; in a field of the viewer\'s own it is that field\'s, in the one it passes keys on through it restores', async ({ page }) => {
  await voice(page);
  await page.getByRole('button', { name: 'Use browser', exact: true }).click();
  const browser = windowOf(page);
  await page.getByRole('button', { name: 'Maximize Browser' }).click();
  await expect(browser).toHaveClass(/is-maximized/);
  // Where it ends up, switched on: a click in it while it slides there lands beside it.
  await settled(page);
  const frame = browser.frameLocator('iframe');
  await frame.locator('body').click();
  await page.keyboard.press('Escape');
  await expect(browser).not.toHaveClass(/is-maximized/);
  await expect(page.getByRole('button', { name: 'End voice mode' })).toBeVisible();

  await page.getByRole('button', { name: 'Maximize Browser' }).click();
  await settled(page);
  await frame.locator('body').evaluate((b) => { b.insertAdjacentHTML('beforeend', '<input aria-label="Search settings"><input id="overlayInput" type="search" aria-label="Keys">'); });
  await frame.getByLabel('Search settings').click();
  await page.keyboard.press('Escape');
  await expect(browser).toHaveClass(/is-maximized/);
  await frame.getByLabel('Keys').click();
  await page.keyboard.press('Escape');
  await expect(browser).not.toHaveClass(/is-maximized/);
});

test('its button in the toolbar watches the browser the agent drives, and B shows and hides it', async ({ page }) => {
  await voice(page);
  const browser = windowOf(page);
  const show = page.getByRole('button', { name: 'Show Browser' });
  await expect(show).toHaveAttribute('title', 'Watch the browser the agent is driving');
  await page.keyboard.press('b');
  await expect(browser).toHaveClass(/is-open/);
  await expect(show).toHaveCount(0);
  await page.keyboard.press('b');
  await expect(browser).not.toHaveClass(/is-open/);
  await show.click();
  await expect(browser).toHaveClass(/is-open/);
});

test('with no browser running there is no button for it, and the agent driving one opens the window to say so', async ({ page }) => {
  await voice(page, { connected: true });
  await expect(page.getByRole('button', { name: 'Show Browser' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Use browser', exact: true }).click();
  const browser = windowOf(page);
  await expect(browser).toHaveClass(/is-open/);
  await expect(browser).toContainText('The browser viewer is unavailable.');
  await expect(browser.locator('iframe')).toHaveCount(0);

  // Started since: opened again, kept loaded as it is, it asks again, and shows it.
  await page.route(`**${BASE}/state`, (route) => route.fulfill({ json: browserState(RUNNING) }));
  await page.getByRole('button', { name: 'Minimize Browser' }).click();
  await expect(browser).not.toHaveClass(/is-open/);
  await page.getByRole('button', { name: 'Use browser', exact: true }).click();
  await expect(browser).toHaveClass(/is-open/);
  await expect(browser.frameLocator('iframe').locator('body')).toHaveText('A browser, in view.');
});

test('a server half that does not answer when the window opens is said in it', async ({ page }) => {
  await voice(page);
  // Asked again as the window opens: the answer that comes now is no answer.
  await page.route(`**${BASE}/state`, (route) => route.fulfill({ status: 500, json: { error: 'down' } }));
  await page.getByRole('button', { name: 'Use browser', exact: true }).click();
  await expect(windowOf(page)).toContainText('Could not connect to the browser viewer.');
});

test('alone at the side, it moves to the middle when the conversation opens, and back when it closes', async ({ page }) => {
  await voice(page);
  const browser = windowOf(page);
  await page.getByRole('button', { name: 'Use browser', exact: true }).click();
  await expect(browser).toHaveClass(/as-side/);
  await page.getByRole('button', { name: 'Show the conversation' }).click();
  await expect(page.locator('.voice-conversation-window')).toHaveClass(/as-side/);
  await expect(browser).toHaveClass(/as-main/);
  await page.getByRole('button', { name: 'Close the conversation' }).click();
  await expect(browser).toHaveClass(/as-side/);
});
