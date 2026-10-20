import { type Locator, type Page } from '@playwright/test';
import { test, expect, mockPortal } from '../../../../tests/browser/portal-mock';
import { kanbanServer, realisticBoard } from './kanban-server';

test.use({ installed: ['extensions/kanban'] });

/**
 * Kanban in a chat (chat.page.tsx): the cards of the agent's kanban calls, and the board in a panel beside the
 * conversation, over Kanban's own server half running in the spec's process (kanban-server.ts). An agent's call is
 * made as a chat makes it: the tool runs on the server half, and its start and end come to the page as events.
 */

let server: Awaited<ReturnType<typeof kanbanServer>>;
test.beforeEach(async ({ page }) => {
  server = await kanbanServer({ preview: 'Plan the release' });
  await mockPortal(page);
  await server.serve(page);
  await page.setViewportSize({ width: 1300, height: 800 });
});
test.afterEach(() => server.close());

let calls = 0;
/** The chat's agent calls a kanban tool: the call starts on the page, runs on the server half, and ends on the page. */
async function agent(page: Page, tool: string, params: Record<string, unknown>) {
  const id = `call-${++calls}`;
  await page.evaluate(([id, tool, params]) => (window as any).emit('tool_execution_start', { toolCallId: id, toolName: tool, args: params }), [id, tool, params] as const);
  const result = await server.tools('preview')[tool].execute(id, params);
  await page.evaluate(([id, tool, result]) => (window as any).emit('tool_execution_end', { toolCallId: id, toolName: tool, result }), [id, tool, result] as const);
  return result;
}
const panels = (page: Page) => page.getByRole('complementary', { name: 'Panels' });
const switcher = (page: Page) => panels(page).getByRole('combobox', { name: 'Board' });
const column = (page: Page, name: string) => panels(page).getByRole('region', { name: `Column ${name}` });
const cardsOf = (page: Page, name: string) => column(page, name).locator('[data-kb-card] .kb-card-title');
const card = (scope: Locator, title: string) => scope.locator('[data-kb-card]').filter({ has: scope.page().locator('.kb-card-title', { hasText: title }) });
/** The panel has come in: measured on its way, what is in it is not where it is going. */
const settled = (page: Page) =>
  page.evaluate(() => Promise.all([...document.querySelectorAll('.chat-aside')].flatMap((e) => e.getAnimations({ subtree: true }).filter((a) => a.effect?.getTiming().iterations !== Infinity).map((a) => a.finished))));
const open = async (page: Page) => {
  await page.goto('/tests/extension.html?page=kanban/chat');
  await expect(page.getByText('I will move the card as I go.')).toBeVisible();
};

test('a kanban call in the chat says what it did and on which board, and opens that board beside the chat', async ({ page }) => {
  const release = await realisticBoard(server);
  await server.call('POST', '/boards', { name: 'Homelab' });
  const flaky = release.cards.find((c: { title: string }) => c.title === 'Fix the flaky login test');
  await open(page);
  await agent(page, 'kanban_move_card', { card: flaky.id, column: 'Review', note: 'Fixed; the pull request is up.' });
  const call = page.locator('.kb-call');
  await expect(call).toHaveCount(1);
  await expect(call).toContainText('Moved “Fix the flaky login test” from In progress to Review');
  await expect(call).toContainText('Release 0.2');
  await expect(call).toContainText(flaky.id);
  // What it was given and what it answered, under Details.
  await call.getByRole('button', { name: 'Details' }).click();
  await expect(call.getByRole('button', { name: 'Details' })).toHaveAttribute('aria-expanded', 'true');
  await expect(call.locator('.kb-call-card')).toContainText('kanban_move_card');

  await call.getByRole('button', { name: 'Open the board' }).click();
  await expect(switcher(page)).toHaveText(/Release 0\.2/);
  await expect(cardsOf(page, 'Review')).toHaveText(['Faster prefill on llama.cpp', 'Fix the flaky login test']);

  // A call that failed is the portal's own card, with why.
  await page.evaluate(() => {
    (window as any).emit('tool_execution_start', { toolCallId: 'bad', toolName: 'kanban_board', args: { board: 'Nope' } });
    (window as any).emit('tool_execution_end', { toolCallId: 'bad', toolName: 'kanban_board', isError: true, result: { content: [{ type: 'text', text: 'There is no board "Nope".' }] } });
  });
  await expect(page.locator('.kb-call')).toHaveCount(1);
  await expect(page.locator('.chat-tool.is-error')).toHaveCount(1);
});

test('on a phone a kanban call\'s card says what it did whole', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const release = await realisticBoard(server);
  const flaky = release.cards.find((c: { title: string }) => c.title === 'Fix the flaky login test');
  await open(page);
  await agent(page, 'kanban_move_card', { card: flaky.id, column: 'Review' });
  const text = page.locator('.kb-call .kb-call-text');
  await expect(text).toHaveText('Moved “Fix the flaky login test” from In progress to Review');
  // Nothing of it is cut off: it goes on to another line.
  expect(await text.evaluate((el) => el.scrollWidth <= el.clientWidth && el.getBoundingClientRect().right <= window.innerWidth)).toBe(true);
  await expect(page.locator('.kb-call .kb-call-id')).toBeInViewport();
});

test('the panel\'s button in the chat\'s header opens it on the board this chat\'s agent worked on last, else on the one last opened on the page', async ({ page }) => {
  const release = await realisticBoard(server);
  const home = await server.call('POST', '/boards', { name: 'Homelab' });
  await page.addInitScript((id) => localStorage.setItem('pithagoras-kanban.board', id), home.id);
  await open(page);
  const button = page.getByRole('button', { name: 'Board', exact: true });
  await expect(button).toHaveAttribute('title', "A kanban board beside the chat: the agent's work as it goes");
  await button.click();
  await expect(switcher(page)).toHaveText(/Homelab/);
  await expect(page.getByRole('button', { name: 'Board', exact: true })).toHaveAttribute('aria-expanded', 'true');
  await panels(page).getByRole('button', { name: 'Close Board' }).click();

  // The agent read the release board, in a call the page did not see: the server half remembers it for the chat.
  await server.tools('preview').kanban_board.execute('x', { board: 'Release 0.2' });
  await button.click();
  await expect(switcher(page)).toHaveText(/Release 0\.2/);
  await expect(cardsOf(page, 'In progress')).toHaveText(['Fix the flaky login test', 'Kanban extension']);
  expect(server.asked.some((a) => a.path === '/chats/preview/board')).toBe(true);
  // Narrow, the columns are one under another.
  expect(await panels(page).locator('.kb-columns').evaluate((el) => getComputedStyle(el).flexDirection)).toBe('column');
  expect(release.id).toBeTruthy();
});

test('in the panel a card is moved by dragging it and from its menu, and opened in its dialog', async ({ page }) => {
  const release = await realisticBoard(server);
  await server.tools('preview').kanban_board.execute('x', { board: release.id });
  await open(page);
  await page.getByRole('button', { name: 'Board', exact: true }).click();
  await expect(cardsOf(page, 'To do')).toHaveCount(3);
  await settled(page);

  // Dragged from the backlog into To do, above its first card.
  const target = (await card(column(page, 'To do'), 'Write the upgrade notes').boundingBox())!;
  const from = (await card(column(page, 'Backlog'), 'Export a board as Markdown').boundingBox())!;
  await page.mouse.move(from.x + 30, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + 40, from.y + from.height / 2 + 6, { steps: 3 });
  await page.mouse.move(target.x + target.width / 2, target.y + 6, { steps: 10 });
  await expect(column(page, 'To do').locator('.kb-drop')).toHaveCount(1);
  await page.mouse.up();
  await expect(cardsOf(page, 'To do')).toHaveText(['Export a board as Markdown', 'Write the upgrade notes', 'Check the voice add-on on a 6 GB card', 'Rotate the signing key']);
  await expect(cardsOf(page, 'Backlog')).toHaveText(['Dark mode for the settings page']);
  const exported = release.cards.find((c: { title: string }) => c.title === 'Export a board as Markdown');
  expect(server.asked.filter((a) => a.path.endsWith('/move')).map((a) => [a.path, a.body])).toEqual([[`/boards/${release.id}/cards/${exported.id}/move`, { column: release.columns[1].id, index: 0 }]]);

  // From its menu, by the keyboard.
  const menu = panels(page).getByRole('button', { name: 'Actions for card Kanban extension' });
  await menu.focus();
  await page.keyboard.press('Enter');
  await page.getByRole('menuitem', { name: 'Move to Done' }).focus();
  await page.keyboard.press('Enter');
  await expect(cardsOf(page, 'Done')).toHaveText(['Media is an extension', 'Docker settings page', 'Kanban extension']);
  await expect(panels(page).getByRole('button', { name: 'Actions for card Kanban extension' })).toBeFocused();

  // The dialog, over the page as from the Boards page.
  await card(panels(page), 'Write the upgrade notes').locator('.kb-card-open').click();
  const dialog = page.getByRole('dialog', { name: 'Write the upgrade notes' });
  await expect(dialog.getByLabel('Assignee')).toHaveValue('Anirban');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);
});

test('the panel follows the agent: its calls show at once, and it goes to the board the agent works on until the person chooses one', async ({ page }) => {
  const release = await realisticBoard(server);
  await server.tools('preview').kanban_board.execute('x', { board: release.id });
  await open(page);
  await page.getByRole('button', { name: 'Board', exact: true }).click();
  await expect(cardsOf(page, 'Review')).toHaveText(['Faster prefill on llama.cpp']);

  // A call that ends has the board asked for again at once: it ends just after a look, and shows well before the next.
  const prefill = release.cards.find((c: { title: string }) => c.title === 'Faster prefill on llama.cpp');
  await page.waitForRequest((r) => r.url().includes(`/boards/${release.id}?have=`));
  await agent(page, 'kanban_move_card', { card: prefill.id, column: 'Done', position: 1 });
  await expect(cardsOf(page, 'Done')).toHaveText(['Faster prefill on llama.cpp', 'Media is an extension', 'Docker settings page'], { timeout: 1500 });

  // A change made where the page saw no call (another chat, the Boards page) comes with the next look.
  await server.call('POST', `/boards/${release.id}/cards`, { title: 'Made on the Boards page', column: release.columns[0].id });
  await expect(cardsOf(page, 'Backlog')).toContainText(['Made on the Boards page'], { timeout: 8000 });

  // A board the agent made is shown...
  const made = await agent(page, 'kanban_create_board', { name: 'Release 0.3' });
  await expect(switcher(page)).toHaveText(/Release 0\.3/);
  // ...until the person chooses one here: then it stays on theirs.
  await switcher(page).click();
  await page.getByRole('option', { name: 'Release 0.2' }).click();
  await agent(page, 'kanban_add_card', { board: made.details.board.id, title: 'Plan 0.3' });
  await page.waitForTimeout(500);
  await expect(switcher(page)).toHaveText(/Release 0\.2/);
  // The card of the call opens the panel on the call's board all the same.
  await page.locator('.kb-call').last().getByRole('button', { name: 'Open the board' }).click();
  await expect(switcher(page)).toHaveText(/Release 0\.3/);
  await expect(cardsOf(page, 'To do')).toHaveText(['Plan 0.3']);
});

test('a card open in the panel stays open while the agent works on another board, and the panel goes there once it is closed', async ({ page }) => {
  const release = await realisticBoard(server);
  const home = await server.call('POST', '/boards', { name: 'Homelab' });
  await server.tools('preview').kanban_board.execute('x', { board: release.id });
  await open(page);
  await page.getByRole('button', { name: 'Board', exact: true }).click();
  await expect(switcher(page)).toHaveText(/Release 0\.2/);
  await card(panels(page), 'Write the upgrade notes').locator('.kb-card-open').click();
  const dialog = page.getByRole('dialog', { name: 'Write the upgrade notes' });
  await dialog.getByLabel('Assignee').fill('Someone else');
  const before = server.asked.length;
  await agent(page, 'kanban_add_card', { board: home.id, title: 'Replace the fan' });
  // The call is seen (the board shown is asked for at once), and the board it was on is not shown under the dialog.
  await expect.poll(() => server.since(before)).toContain(`GET /boards/${release.id}`);
  await page.waitForTimeout(1000);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('Assignee')).toHaveValue('Someone else');
  await expect(page.getByRole('dialog', { name: 'Card' })).toHaveCount(0);
  await expect(switcher(page)).toHaveText(/Release 0\.2/);
  expect(server.asked.some((a) => a.path.startsWith(`/boards/${home.id}`))).toBe(false);
  // Closed, the panel goes to the board the agent worked on.
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(switcher(page)).toHaveText(/Homelab/);
  await expect(cardsOf(page, 'To do')).toHaveText(['Replace the fan']);
});
