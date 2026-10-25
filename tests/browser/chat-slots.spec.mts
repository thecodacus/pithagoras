import { test, expect } from './portal-mock';

/**
 * What an extension draws beside the conversation besides a panel: chips in the running tray (`chat.tray`, with
 * `ui.TrayChip`), a row in the model menu (`chat.model.menu`), a link beside a call card's head (`chat.tool.action`
 * with `head`), and a conversation drawn as the chat draws its own (`ui.Transcript`). Over the portal's tests' stand-in
 * for such an extension (tests/fixtures/extensions/tray), so that none of these needs the subagent extension the portal
 * ships.
 */
test.use({ installed: ['tests/fixtures/extensions/tray'] });

const tray = (page: import('@playwright/test').Page) => page.getByRole('group', { name: 'Running beside the conversation' });

test("an extension's chip is in the running tray while it draws one, timed from the start it gives, and opens what it says", async ({ page }) => {
  await page.setViewportSize({ width: 1300, height: 800 });
  await page.clock.install();
  // A shell command started twelve seconds ago is running.
  await page.goto('/tests/chat.html?phase=tools');
  const chip = tray(page).getByRole('button', { name: /Following/ });
  await expect(chip).toContainText('for i in $(seq 1 40)');
  await expect(chip.locator('.running-chip-time')).toHaveText('12s');
  await expect(chip.locator('.chat-ring')).toHaveCount(1);
  await page.clock.runFor(2000);
  await expect(chip.locator('.running-chip-time')).toHaveText('14s');
  await chip.click();
  await expect(page.getByTestId('replay')).toBeVisible();
});

test('a tray whose extensions draw nothing now, with no job or status in it, is not shown', async ({ page }) => {
  // Nothing of the shell's is running: the stand-in draws no chip.
  await page.goto('/tests/chat.html?phase=stream');
  await expect(page.getByText('The last step')).toBeVisible();
  // The stand-in is in the page, its chip in the tray with nothing to draw.
  await expect(page.getByRole('button', { name: 'Replay', exact: true })).toBeVisible();
  await expect(page.locator('.running-tray')).toBeAttached();
  await expect(page.locator('.running-tray')).toBeHidden();
  await expect(tray(page)).toHaveCount(0);
});

test("an extension's row in the model menu is drawn under the models, told the chat and the models the menu lists", async ({ page }) => {
  await page.route('**/api/sessions/preview/models', (route) =>
    route.fulfill({ json: { live: true, stats: null, thinking: { levels: ['off', 'medium'] }, state: { model: { id: 'Model A', name: 'Model A', provider: 'llama-server' }, thinkingLevel: 'medium' }, models: { models: [{ id: 'model-a', name: 'Model A', provider: 'p' }, { id: 'model-b', name: 'Model B', provider: 'p' }] } } }),
  );
  await page.goto('/tests/chat.html?phase=model');
  await page.getByTitle('Model A', { exact: true }).click();
  const menu = page.getByRole('group', { name: 'Models' });
  await expect(menu.getByTestId('menu-row')).toHaveText('Replays of preview run on one of 2 models');
  // Under the models, above the way to the providers.
  const [row, providers] = await Promise.all([menu.getByTestId('menu-row').boundingBox(), menu.getByRole('button', { name: 'Add or change providers…' }).boundingBox()]);
  expect(row!.y).toBeLessThan(providers!.y);
});

test("an extension's link beside a call card's head is there with the card folded, on the calls it is for", async ({ page }) => {
  await page.setViewportSize({ width: 1300, height: 800 });
  await page.goto('/tests/chat.html?phase=tools');
  const cards = page.locator('.chat-tool');
  const shell = cards.filter({ hasText: 'npm run build -w web' });
  await expect(shell.getByRole('button', { name: 'Follow' })).toBeVisible();
  await expect(shell.locator('.chat-tool-head')).toHaveAttribute('aria-expanded', 'false');
  // Not on a call of another tool, nor in an empty place beside its head.
  const read = cards.filter({ hasText: 'web/src/main.tsx' });
  await expect(read.getByRole('button', { name: 'Follow' })).toHaveCount(0);
  await expect(read.locator('.chat-tool-heads')).toBeHidden();
  await shell.getByRole('button', { name: 'Follow' }).click();
  await expect(page.getByTestId('replay')).toBeVisible();
});

test('ui.Transcript draws a conversation from its events as the chat draws its own', async ({ page }) => {
  await page.setViewportSize({ width: 1300, height: 800 });
  await page.goto('/tests/chat.html?phase=tools');
  await page.getByRole('button', { name: 'Replay', exact: true }).click();
  const replay = page.getByTestId('replay');
  await expect(replay.locator('.side-transcript-prompt')).toHaveText('Find out why the build fails and fix it.');
  await expect(replay.getByText('Let me run the build first.')).toBeVisible();
  // Each call on its card, as in the chat, and the compaction's marker.
  await expect(replay.locator('.chat-tool')).toHaveCount(4);
  await expect(replay.locator('.chat-tool').filter({ hasText: 'npm run build -w web' })).toBeVisible();
  await expect(replay.getByText(/compacted|Compacted/).first()).toBeVisible();
});

test("ui.Transcript draws an extension's card for a call where it is given the chat, and the portal's where it is not", async ({ page }) => {
  await page.setViewportSize({ width: 1300, height: 800 });
  await page.goto('/tests/chat.html?phase=tools');
  await page.getByRole('button', { name: 'Replay', exact: true }).click();
  const replay = page.getByTestId('replay');
  // The stand-in marks the cards of the three shell calls (the fourth is a read): each marker has the portal's card in it.
  await expect(replay.locator('.chat-tool')).toHaveCount(4);
  await expect(replay.getByTestId('tool-card')).toHaveCount(3);
  await expect(replay.getByTestId('tool-card').first().locator('.chat-tool')).toHaveCount(1);

  await page.getByRole('button', { name: 'Bare replay', exact: true }).click();
  const bare = page.getByTestId('bare');
  await expect(bare.locator('.chat-tool')).toHaveCount(4);
  await expect(bare.getByTestId('tool-card')).toHaveCount(0);
});
