import { type Page } from '@playwright/test';
import { test, expect } from './portal-mock';

/**
 * What any extension can hook into, beyond drawing in a slot: a panel opened by
 * a name of its own, an action on the portal's card of a tool call, a voice
 * window that says where it goes and opens itself and from a card, a voice
 * shortcut listed with the portal's own, and the running tray's jobs. Over the
 * voice fixture (core/web/tests/voice.tsx, `?hooks=1`), which registers one of
 * each as the loader registers an extension's, under the name "hooks".
 */

async function fixture(page: Page, { jobs = [] as unknown[] } = {}) {
  await page.addInitScript(() => {
    (window as any).EventSource = class { onmessage: any; onopen: any; addEventListener() {} close() {} };
  });
  await page.route('**/api/sessions/test/commands', (route) => route.fulfill({ json: { commands: [] } }));
  await page.route('**/api/sessions/test/config', (route) => route.fulfill({ status: 503, json: {} }));
  await page.route('**/api/sessions/test/background', (route) => route.fulfill({ json: { supported: true, jobs, statuses: [], widgets: [] } }));
  await page.route('**/api/voice', (route) => route.fulfill({ json: { enabled: true } }));
  await page.setViewportSize({ width: 1400, height: 860 });
  await page.goto('/tests/voice.html?hooks=1');
}

test('a panel is opened by the name its extension gave it, and from an action on the card of a call', async ({ page }) => {
  await fixture(page);
  await page.getByRole('button', { name: 'Open by name' }).click();
  await expect(page.getByTestId('hooks-panel')).toHaveText('Opened with {"said":"by name"}');

  // The action is on the card of a call of the tool it is for, once the card is opened.
  await page.getByRole('button', { name: 'Use terminal' }).click();
  await page.locator('.chat-tool-head', { hasText: 'bash' }).click();
  await page.getByRole('button', { name: 'Open in Hooks' }).click();
  await expect(page.getByTestId('hooks-panel')).toHaveText('Opened with {"call":"terminal-demo","cut":false}');
});

test('a job in the running tray is shown by whatever answers to jobs.show, told which chat and which job', async ({ page }) => {
  await fixture(page, { jobs: [{ key: 'j1', sid: 1, pids: [1], command: 'npm run dev', startedAt: Date.now() - 5000, state: 'running', hasOutput: true, attached: false }] });
  await page.getByRole('button', { name: /npm run dev/ }).click();
  await expect.poll(() => page.evaluate(() => (window as any).hooksSaid)).toEqual([{ chat: 'test', job: 'j1' }]);
});

test('in voice mode an extension\'s window goes where it asks, opens itself and from the card of a call, and has a shortcut of its own', async ({ page }) => {
  await fixture(page);
  await page.getByRole('button', { name: 'Turn on hands-free voice' }).click();
  await expect(page.getByRole('status')).toHaveText('Listening', { timeout: 25000 });
  const pinned = page.locator('.voice-extension-window', { has: page.getByTestId('pinned-window') });

  // It asked for the middle, which is free: it has it, where an extension's window otherwise starts at the side.
  await page.getByRole('button', { name: 'Show Pinned' }).click();
  await expect(pinned).toHaveClass(/as-main/);
  await pinned.getByRole('button', { name: 'Done' }).click();
  await expect(pinned).toHaveCount(0);

  // Its count grows: it opens by itself.
  await page.evaluate(() => (window as any).hooksGrow());
  await expect(pinned).toHaveClass(/is-open/);
  await pinned.getByRole('button', { name: 'Done' }).click();

  // The card of a call it says it is for opens it when tapped.
  await page.getByRole('button', { name: 'Use note' }).click();
  const card = page.getByRole('log', { name: 'Tool activity' }).getByRole('button').filter({ hasText: 'Using note' });
  await expect(card).toHaveAttribute('title', 'Show Pinned');
  await card.click();
  await expect(pinned).toHaveClass(/is-open/);
  await pinned.getByRole('button', { name: 'Done' }).click();

  // Its shortcut, N, shows and hides it.
  await page.locator('body').press('n');
  await expect(pinned).toHaveClass(/is-open/);
  await page.locator('body').press('n');
  await expect(pinned).toHaveCount(0);
});

test('an extension\'s shortcut is listed with the portal\'s own, by its label and its extension, and can be changed', async ({ page }) => {
  await fixture(page);
  await page.getByRole('button', { name: 'Toggle shortcuts' }).click();
  const row = page.getByRole('listitem', { name: 'Show or hide what is pinned' });
  await expect(row).toContainText('hooks');
  await expect(row.locator('kbd')).toHaveText('N');
  await row.getByRole('button', { name: 'Change' }).click();
  await page.keyboard.press('KeyJ');
  await expect(row.locator('kbd')).toHaveText('J');
  await row.getByRole('button', { name: 'Reset' }).click();
  await expect(row.locator('kbd')).toHaveText('N');
});
