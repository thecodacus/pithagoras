import { type Page } from '@playwright/test';
import { test, expect } from '../../../../tests/browser/portal-mock';
import { BASE, browserState } from './state';

/**
 * The browser beside a chat (src/web/BrowserScreen.tsx): its button in the chat's header while there is a browser to
 * watch here, and its web UI through the server half, black from edge to edge.
 */
test.use({ installed: ['extensions/docker', 'extensions/browser'] });

const RUNNING = { running: true, connected: true, install: { available: true, mode: 'docker', image: true, container: 'running', pulling: { active: false, line: '' } } };

/** The chat fixture, with the browser as `state` says. */
async function chat(page: Page, state: Record<string, unknown>) {
  await page.route(`**${BASE}/state`, (route) => route.fulfill({ json: browserState(state) }));
  await page.route(`**${BASE}/ui/`, (route) => route.fulfill({ contentType: 'text/html', body: '<body style="margin:0;background:#171a20;color:#d1d8e3">A browser, in view.</body>' }));
  await page.goto('/tests/chat.html?phase=model');
}

const toggle = (page: Page) => page.getByRole('button', { name: 'Browser', exact: true });

test('a browser that runs is watched beside the chat: its web UI through the server half, black from edge to edge', async ({ page }) => {
  await chat(page, RUNNING);
  await expect(toggle(page)).toHaveAttribute('title', 'Watch the browser the agent is driving');
  await toggle(page).click();
  const frame = page.locator('.chat-aside iframe');
  await expect(frame).toHaveAttribute('src', `${BASE}/ui/`);
  await expect(frame).toHaveAttribute('title', "The agent's browser");
  await expect(page.frameLocator('.chat-aside iframe').locator('body')).toHaveText('A browser, in view.');
  const body = await frame.evaluate((el) => {
    const box = el.closest<HTMLElement>('.chat-aside-head ~ div')!;
    // As laid out, not as drawn: it is switched on like a screen, from a line.
    return { background: getComputedStyle(box).backgroundColor, filled: (el as HTMLElement).offsetWidth === box.clientWidth };
  });
  expect(body).toEqual({ background: 'rgb(0, 0, 0)', filled: true });
  await page.getByRole('button', { name: 'Close Browser' }).click();
  await expect(frame).toHaveCount(0);
});

test('with no browser running, or over plain HTTP where its frame would not start, the chat has no button for it', async ({ page }) => {
  const answered = () => page.waitForResponse((response) => new URL(response.url()).pathname === `${BASE}/state`);
  let asked = answered();
  await chat(page, { connected: true });
  await asked;
  await expect(page.locator('.chat-header')).toBeVisible();
  await expect(toggle(page)).toHaveCount(0);

  await page.addInitScript(() => Object.defineProperty(window, 'isSecureContext', { value: false }));
  await page.route(`**${BASE}/state`, (route) => route.fulfill({ json: browserState(RUNNING) }));
  asked = answered();
  await page.reload();
  await asked;
  await expect(page.locator('.chat-header')).toBeVisible();
  await expect(toggle(page)).toHaveCount(0);
});

test('its screen switches on like an old tube only while the portal\'s animations play', async ({ page }) => {
  await chat(page, RUNNING);
  await toggle(page).click();
  const frame = page.locator('.chat-aside iframe');
  const html = page.locator('html');
  // The tests start with the switch off, as Settings would leave it.
  await expect(html).not.toHaveAttribute('data-motion', /.+/);
  expect(await frame.evaluate((el) => getComputedStyle(el).animationName)).toBe('none');

  await page.evaluate(() => { localStorage.setItem('animations', 'on'); window.dispatchEvent(new StorageEvent('storage', { key: 'animations' })); });
  await expect(html).toHaveAttribute('data-motion', 'fancy');
  expect(await frame.evaluate((el) => getComputedStyle(el).animationName)).toBe('browser-power-on');

  // The system's own wish for less motion wins over the switch.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(html).not.toHaveAttribute('data-motion', /.+/);
  expect(await frame.evaluate((el) => getComputedStyle(el).animationName)).toBe('none');
});
