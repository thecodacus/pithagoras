import { type Page } from '@playwright/test';
import { test, expect } from './portal-mock';

/**
 * The terminal is an extension like any other: a fresh portal installs it, and
 * it can be removed or replaced. Without it a chat has no terminal anywhere and
 * works as before; another extension in its place has every way in that it had.
 * Over the chat fixture with a background job (core/web/tests/chat.tsx,
 * `?phase=agents`), which loads the installed extensions as the app does.
 */

/** The chat, with what is installed answered by the test, settled: the list was read and what it names is loaded. */
async function chat(page: Page, extensions: unknown[], module?: string) {
  await page.route('**/api/extension-ui', (route) => route.fulfill({ json: { extensions } }));
  if (module) await page.route('**/api/extension-ui/my-terminal/client.js*', (route) => route.fulfill({ contentType: 'text/javascript', body: module }));
  await page.setViewportSize({ width: 1300, height: 800 });
  const listed = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/extension-ui');
  await page.goto('/tests/chat.html?phase=agents');
  await listed;
  await expect(page.getByText('Let me run the build first.')).toBeVisible();
}

const tray = (page: Page) => page.getByLabel('Running beside the conversation');

test('without the terminal a chat has no terminal anywhere, and a job left running is listed but leads nowhere', async ({ page }) => {
  await chat(page, []);
  await expect(page.getByRole('button', { name: 'Terminal', exact: true })).toHaveCount(0);
  await page.locator('.chat-tool-head', { hasText: 'npm run build' }).click();
  await expect(page.getByText('✓ built in 6.12s')).toBeVisible();
  await expect(page.getByRole('button', { name: /terminal/i })).toHaveCount(0);
  // The job is there to see, and nothing answers to showing it.
  await expect(tray(page)).toContainText('npm run dev');
  await expect(tray(page).getByRole('button', { name: /npm run dev/ })).toHaveCount(0);
});

/** Someone's own terminal: a panel by the name "terminal", a way into it from a command's card, and where jobs are shown. */
const MINE = `export default function (portal) {
  const h = portal.React.createElement;
  portal.slots.register("chat.panel", {
    id: "mine", name: "terminal", title: "My terminal",
    component: ({ panel }) => h("div", { "data-testid": "my-terminal" }, "Showing " + JSON.stringify(panel.params ?? null)),
  });
  portal.slots.register("chat.tool.action", {
    id: "open", tool: /^bash$/,
    component: ({ call, chat, panels }) => (chat && call.callId ? h(portal.ui.ToolLink, { onClick: () => panels.open("mine", { callId: call.callId }) }, "Open in my terminal") : null),
  });
  portal.commands.register("jobs.show", ({ job }) => portal.panels.open("terminal", { job }));
}`;

test('another extension in its place has every way in: the header, a command\'s card, the running tray, and its name', async ({ page }) => {
  await chat(page, [{ name: 'my-terminal', version: '1.0.0', entry: '/api/extension-ui/my-terminal/client.js?v=1' }], MINE);
  const mine = page.getByTestId('my-terminal');
  await page.getByRole('button', { name: 'My terminal', exact: true }).click();
  await expect(mine).toHaveText('Showing null');

  await page.locator('.chat-tool-head', { hasText: 'npm run build' }).click();
  await page.getByRole('button', { name: 'Open in my terminal' }).click();
  await expect(mine).toHaveText('Showing {"callId":"b1"}');

  await tray(page).getByRole('button', { name: /npm run dev/ }).click();
  await expect(mine).toHaveText('Showing {"job":"j1"}');
});
