import { type Locator, type Page } from '@playwright/test';
import { test, expect, mockPortal } from '../../../../tests/browser/portal-mock';
import { kanbanServer, realisticBoard } from './kanban-server';

test.use({ installed: ['extensions/kanban'] });

/**
 * The Boards page (src/web/BoardsPage.tsx and Board.tsx), over Kanban's own server half running in the spec's process
 * (kanban-server.ts): what the page sends is what the server half answers, and an agent's tool changes the same boards.
 */

let server: Awaited<ReturnType<typeof kanbanServer>>;
test.beforeEach(async ({ page }) => {
  server = await kanbanServer({ 'chat-1': 'Fix the flaky test' });
  await mockPortal(page);
  await server.serve(page);
  await page.setViewportSize({ width: 1280, height: 800 });
});
test.afterEach(() => server.close());

const column = (page: Page, name: string) => page.getByRole('region', { name: `Column ${name}` });
const cardsOf = (page: Page, name: string) => column(page, name).locator('[data-kb-card] .kb-card-title');
const card = (page: Page, title: string) => page.locator('[data-kb-card]').filter({ has: page.locator('.kb-card-title', { hasText: title }) });
const switcher = (page: Page) => page.getByRole('combobox', { name: 'Board' });
const pick = async (page: Page, board: string) => {
  await switcher(page).click();
  await page.getByRole('option', { name: board }).click();
};
const boardActions = async (page: Page, item: string) => {
  await page.getByRole('button', { name: 'Board actions' }).click();
  await page.getByRole('menuitem', { name: item }).click();
};
/** Drags with the mouse, as a hand would: pressed on `from`, carried in steps to (x, y), held there while `during` looks. */
async function drag(page: Page, from: Locator, x: number, y: number, during?: () => Promise<void>) {
  const box = (await from.boundingBox())!;
  await page.mouse.move(box.x + 30, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 40, box.y + box.height / 2 + 6, { steps: 3 });
  await page.mouse.move(x, y, { steps: 12 });
  await during?.();
  await page.mouse.up();
}

test('Boards is a page among the extensions\' in the sidebar, and keeps the board it shows in its address', async ({ page }) => {
  const release = await realisticBoard(server);
  const home = await server.call('POST', '/boards', { name: 'Homelab' });
  await page.goto('/sessions');
  const sidebar = page.getByRole('complementary', { name: 'Sidebar' });
  await sidebar.getByRole('group', { name: 'Extensions' }).getByRole('button', { name: 'Boards' }).click();
  // The first board, put in the address in place of none.
  await expect(page).toHaveURL(new RegExp(`/x/pithagoras-kanban/boards\\?board=${release.id}$`));
  await expect(page.getByRole('heading', { name: 'Release 0.2' })).toBeVisible();
  await expect(page.getByText('Everything that has to land before the 0.2 release goes out.')).toBeVisible();
  await expect(cardsOf(page, 'To do')).toHaveText(['Write the upgrade notes', 'Check the voice add-on on a 6 GB card', 'Rotate the signing key']);
  // Overdue, said in words.
  await expect(card(page, 'Rotate the signing key').locator('.kb-card-due.is-late')).toContainText('Overdue');
  await expect(card(page, 'Write the upgrade notes').locator('.kb-card-due.is-late')).toHaveCount(0);

  await pick(page, 'Homelab');
  await expect(page).toHaveURL(new RegExp(`board=${home.id}$`));
  await expect(page.getByRole('heading', { name: 'Homelab' })).toBeVisible();
  await expect(page.getByRole('region', { name: /^Column / })).toHaveCount(3);
  await page.goBack();
  await expect(page.getByRole('heading', { name: 'Release 0.2' })).toBeVisible();
  // Opened again without one, it is on the board last opened here.
  await page.goto(`/x/pithagoras-kanban/boards?board=${home.id}`);
  await expect(page.getByRole('heading', { name: 'Homelab' })).toBeVisible();
  await page.goto('/x/pithagoras-kanban/boards');
  await expect(page).toHaveURL(new RegExp(`board=${home.id}$`));
});

test('Back with a card open goes to the board before, and leaves the card behind', async ({ page }) => {
  const release = await realisticBoard(server);
  const home = await server.call('POST', '/boards', { name: 'Homelab' });
  await page.goto(`/x/pithagoras-kanban/boards?board=${home.id}`);
  await expect(page.getByRole('heading', { name: 'Homelab' })).toBeVisible();
  await pick(page, 'Release 0.2');
  await card(page, 'Kanban extension').locator('.kb-card-open').click();
  await expect(page.getByRole('dialog', { name: 'Kanban extension' })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('heading', { name: 'Homelab' })).toBeVisible();
  await expect(page.getByRole('region', { name: /^Column / })).toHaveCount(3);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  // Forward: the board again, with nothing open on it.
  await page.goForward();
  await expect(page).toHaveURL(new RegExp(`board=${release.id}$`));
  await expect(cardsOf(page, 'In progress')).toHaveText(['Fix the flaky login test', 'Kanban extension']);
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('a board is made from the board\'s menu and opens, and with no board at all the page offers to make one', async ({ page }) => {
  await page.goto('/x/pithagoras-kanban/boards');
  await expect(page.getByText('No boards yet.')).toBeVisible();
  await page.getByRole('textbox', { name: 'Name of the board' }).fill('Groceries');
  await page.getByRole('button', { name: 'Make the board' }).click();
  await expect(page.getByRole('heading', { name: 'Groceries' })).toBeVisible();
  await expect(page.getByRole('region', { name: /^Column / })).toHaveText([/^To do/, /^In progress/, /^Done/]);

  await boardActions(page, 'New board');
  const dialog = page.getByRole('dialog', { name: 'New board' });
  await dialog.getByLabel('Name').fill('Trip to Lisbon');
  await dialog.getByRole('button', { name: 'Make the board' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Trip to Lisbon' })).toBeVisible();
  const { boards } = await server.call('GET', '/boards');
  await expect(page).toHaveURL(new RegExp(`board=${boards[1].id}$`));
  expect(server.asked.filter((a) => a.method === 'POST' && a.path === '/boards').map((a) => a.body)).toEqual([{ name: 'Groceries' }, { name: 'Trip to Lisbon' }]);
  // A name that is taken is said, and the dialog stays.
  await boardActions(page, 'New board');
  await page.getByRole('dialog', { name: 'New board' }).getByLabel('Name').fill('groceries');
  await page.getByRole('dialog', { name: 'New board' }).getByRole('button', { name: 'Make the board' }).click();
  await expect(page.getByText('There is a board called "Groceries" already')).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'New board' })).toBeVisible();
});

test('a board is renamed, and deleted after the portal\'s question, which is one about deleting', async ({ page }) => {
  const release = await realisticBoard(server);
  const home = await server.call('POST', '/boards', { name: 'Homelab' });
  await page.goto(`/x/pithagoras-kanban/boards?board=${home.id}`);
  await boardActions(page, 'Rename the board');
  const dialog = page.getByRole('dialog', { name: 'Rename the board' });
  await dialog.getByLabel('Name').fill('Homelab rack');
  await dialog.getByLabel('Description').fill('The rack in the cupboard.');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('heading', { name: 'Homelab rack' })).toBeVisible();
  await expect(page.getByText('The rack in the cupboard.')).toBeVisible();

  await boardActions(page, 'Delete the board');
  const question = page.getByRole('alertdialog');
  await expect(question).toContainText('Delete the board “Homelab rack”?');
  await question.getByRole('button', { name: 'Cancel' }).click();
  expect(server.asked.some((a) => a.method === 'DELETE')).toBe(false);
  await boardActions(page, 'Delete the board');
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete' }).click();
  await expect(page).toHaveURL(new RegExp(`board=${release.id}$`));
  expect(server.asked.filter((a) => a.method === 'DELETE').map((a) => a.path)).toEqual([`/boards/${home.id}`]);
});

test('a card is added at the bottom of a column, and the field stays for the next one', async ({ page }) => {
  const board = await realisticBoard(server);
  await page.goto(`/x/pithagoras-kanban/boards?board=${board.id}`);
  await column(page, 'Review').getByRole('button', { name: 'Add a card to Review' }).click();
  const field = page.getByRole('textbox', { name: 'Title of the new card in Review' });
  await field.fill('Read the release diff');
  await field.press('Enter');
  await expect(cardsOf(page, 'Review')).toHaveText(['Faster prefill on llama.cpp', 'Read the release diff']);
  await expect(field).toHaveValue('');
  await expect(field).toBeFocused();
  await field.fill('Check the changelog');
  await page.getByRole('button', { name: 'Add card' }).click();
  await expect(cardsOf(page, 'Review')).toHaveText(['Faster prefill on llama.cpp', 'Read the release diff', 'Check the changelog']);
  const review = board.columns[3].id;
  expect(server.asked.filter((a) => a.method === 'POST' && a.path.endsWith('/cards')).map((a) => a.body)).toEqual([
    { column: review, title: 'Read the release diff' },
    { column: review, title: 'Check the changelog' },
  ]);
  await field.press('Escape');
  await expect(field).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add a card to Review' })).toBeFocused();
});

test('a card dragged with the mouse to another column goes there, with a line where it will go while it is held', async ({ page }) => {
  const board = await realisticBoard(server);
  await page.goto(`/x/pithagoras-kanban/boards?board=${board.id}`);
  const doing = column(page, 'In progress');
  const first = (await doing.locator('[data-kb-card]').first().boundingBox())!;
  const before = server.asked.length;
  // Over the top half of the first card in progress: it would go first.
  await drag(page, card(page, 'Write the upgrade notes'), first.x + first.width / 2, first.y + 8, async () => {
    await expect(doing.locator('.kb-drop')).toHaveCount(1);
    await expect(page.locator('.kb-drop')).toHaveCount(1);
    await expect(page.locator('.kb-ghost')).toContainText('Write the upgrade notes');
    await expect(card(page, 'Write the upgrade notes').first()).toHaveClass(/is-dragged/);
  });
  await expect(page.locator('.kb-drop')).toHaveCount(0);
  await expect(page.locator('.kb-ghost')).toHaveCount(0);
  await expect(cardsOf(page, 'In progress')).toHaveText(['Write the upgrade notes', 'Fix the flaky login test', 'Kanban extension']);
  await expect(cardsOf(page, 'To do')).toHaveText(['Check the voice add-on on a 6 GB card', 'Rotate the signing key']);
  const moved = board.cards.find((c: { title: string }) => c.title === 'Write the upgrade notes');
  const sent = server.asked.slice(before).filter((a) => a.path.endsWith('/move'));
  expect(sent.map((a) => [a.path, a.body])).toEqual([[`/boards/${board.id}/cards/${moved.id}/move`, { column: board.columns[2].id, index: 0 }]]);
  // Letting go is not a click: no dialog opened.
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // Within its column, below the last card: it goes to the bottom. Let go outside the columns: it stays where it was.
  const last = (await doing.locator('[data-kb-card]').last().boundingBox())!;
  await drag(page, card(page, 'Write the upgrade notes'), last.x + last.width / 2, last.y + last.height - 4);
  await expect(cardsOf(page, 'In progress')).toHaveText(['Fix the flaky login test', 'Kanban extension', 'Write the upgrade notes']);
  const heading = (await page.getByRole('heading', { name: 'Release 0.2' }).boundingBox())!;
  const asked = server.asked.length;
  await drag(page, card(page, 'Kanban extension'), heading.x + 10, heading.y + 5);
  await expect(cardsOf(page, 'In progress')).toHaveText(['Fix the flaky login test', 'Kanban extension', 'Write the upgrade notes']);
  expect(server.since(asked).filter((a) => a.endsWith('/move'))).toEqual([]);
  // Escape while it is held puts it back.
  const done = (await column(page, 'Done').boundingBox())!;
  await drag(page, card(page, 'Kanban extension'), done.x + 40, done.y + 60, () => page.keyboard.press('Escape'));
  await expect(cardsOf(page, 'Done')).toHaveText(['Media is an extension', 'Docker settings page']);
});

test('a card is moved by the keyboard from its menu, and keeps the keyboard in its new place', async ({ page }) => {
  const board = await realisticBoard(server);
  await page.goto(`/x/pithagoras-kanban/boards?board=${board.id}`);
  const menu = page.getByRole('button', { name: 'Actions for card Write the upgrade notes' });
  await menu.focus();
  await page.keyboard.press('Enter');
  const items = page.getByRole('menu', { name: 'Actions for card Write the upgrade notes' }).getByRole('menuitem');
  await expect(items).toHaveText(['Open', 'Move up', 'Move down', 'Move to Backlog', 'Move to In progress', 'Move to Review', 'Move to Done', 'Archive']);
  await expect(items.first()).toBeFocused();
  // Move up is not offered for the top card: the arrows go past it.
  await expect(items.nth(1)).toBeDisabled();
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowDown');
  await expect(items.nth(4)).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(cardsOf(page, 'In progress')).toHaveText(['Fix the flaky login test', 'Kanban extension', 'Write the upgrade notes']);
  await expect(page.getByRole('button', { name: 'Actions for card Write the upgrade notes' })).toBeFocused();
  // Up, from the bottom.
  await page.keyboard.press('Enter');
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('menuitem', { name: 'Move up' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(cardsOf(page, 'In progress')).toHaveText(['Fix the flaky login test', 'Write the upgrade notes', 'Kanban extension']);
  await expect(page.getByRole('button', { name: 'Actions for card Write the upgrade notes' })).toBeFocused();
  const moved = board.cards.find((c: { title: string }) => c.title === 'Write the upgrade notes');
  expect(server.asked.filter((a) => a.path.endsWith('/move')).map((a) => a.body)).toEqual([
    { column: board.columns[2].id, index: 2 },
    { column: board.columns[2].id, index: 1 },
  ]);
  expect(moved).toBeTruthy();
  // Escape closes the menu and gives the keyboard back to its button.
  await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Actions for card Write the upgrade notes' })).toBeFocused();
});

test('a move that is not saved is said, and the card is shown back where it is', async ({ page }) => {
  const board = await realisticBoard(server);
  await page.goto(`/x/pithagoras-kanban/boards?board=${board.id}`);
  // The server half could not write it: the board there is as it was, at the version the page has.
  await page.route('**/api/x/pithagoras-kanban/boards/*/cards/*/move', (route) => route.fulfill({ status: 500, json: { error: 'The board could not be saved' } }));
  await page.getByRole('button', { name: 'Actions for card Kanban extension' }).click();
  await page.getByRole('menuitem', { name: 'Move to Done' }).click();
  await expect(page.getByRole('alert')).toContainText('The board could not be saved');
  await expect(cardsOf(page, 'In progress')).toHaveText(['Fix the flaky login test', 'Kanban extension']);
  await expect(cardsOf(page, 'Done')).toHaveText(['Media is an extension', 'Docker settings page']);
});

test('the card\'s dialog edits every field, moves and archives the card, and shows its activity with who did what', async ({ page }) => {
  const board = await realisticBoard(server);
  await page.goto(`/x/pithagoras-kanban/boards?board=${board.id}`);
  await card(page, 'Fix the flaky login test').locator('.kb-card-open').click();
  const dialog = page.getByRole('dialog', { name: 'Fix the flaky login test' });
  await expect(dialog.getByLabel('Title')).toHaveValue('Fix the flaky login test');
  await expect(dialog.getByLabel('Labels')).toHaveValue('bug, test');
  await expect(dialog.getByLabel('Assignee')).toHaveValue('agent');
  const activity = dialog.getByRole('region', { name: 'Activity' });
  await expect(activity.locator('.kb-entry')).toHaveCount(2);
  await expect(activity.locator('.kb-entry').first()).toContainText('Found it: the session cookie expires a second early.');
  await expect(activity.locator('.kb-entry').last()).toContainText('Made in In progress');

  await dialog.getByLabel('Title').fill('Fix the flaky login test for good');
  await dialog.getByLabel('Description').fill('Fails one run in five on CI.\n\nThe cookie expires early.');
  await dialog.getByLabel('Labels').fill('bug, test, ci');
  await dialog.getByLabel('Assignee').fill('Anirban');
  await dialog.getByLabel('Due date').fill('2026-12-01');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toHaveCount(0);
  const edits = server.asked.filter((a) => a.method === 'PATCH');
  expect(edits.map((a) => a.body)).toEqual([{ title: 'Fix the flaky login test for good', description: 'Fails one run in five on CI.\n\nThe cookie expires early.', labels: ['bug', 'test', 'ci'], assignee: 'Anirban', due: '2026-12-01' }]);
  const tile = card(page, 'Fix the flaky login test for good');
  await expect(tile.locator('.kb-label')).toHaveText(['bug', 'test', 'ci']);
  await expect(tile).toContainText('Anirban');

  // Moved from the dialog, a note added, then archived.
  await tile.locator('.kb-card-open').click();
  const again = page.getByRole('dialog', { name: 'Fix the flaky login test for good' });
  await again.getByRole('combobox', { name: 'Column' }).click();
  await page.getByRole('option', { name: /^Review/ }).click();
  await expect(cardsOf(page, 'Review')).toHaveText(['Faster prefill on llama.cpp', 'Fix the flaky login test for good']);
  await again.getByRole('textbox', { name: 'A note on the card' }).fill('Merged; watching CI.');
  await again.getByRole('button', { name: 'Add note' }).click();
  const entries = again.getByRole('region', { name: 'Activity' }).locator('.kb-entry');
  await expect(entries.first()).toContainText('You');
  await expect(entries.first()).toContainText('Merged; watching CI.');
  await expect(entries.nth(1)).toContainText('Moved from In progress to Review');
  await expect(entries.nth(2)).toContainText('Changed the title, description, labels, assignee, due date');
  await again.getByRole('button', { name: 'Archive' }).click();
  await expect(again).toHaveCount(0);
  await expect(card(page, 'Fix the flaky login test for good')).toHaveCount(0);

  // Archived cards are a dialog away, and come back.
  await page.getByRole('button', { name: 'Archived cards (1)' }).click();
  const archived = page.getByRole('dialog', { name: 'Archived cards' });
  await archived.getByRole('button', { name: 'Restore card Fix the flaky login test for good' }).click();
  await expect(archived.getByText('No archived cards on this board.')).toBeVisible();
  await archived.getByRole('button', { name: 'Close' }).click();
  await expect(cardsOf(page, 'Review')).toHaveText(['Faster prefill on llama.cpp', 'Fix the flaky login test for good']);
});

test('a card is deleted from its dialog after the portal\'s question, which names the card', async ({ page }) => {
  const board = await realisticBoard(server);
  await page.goto(`/x/pithagoras-kanban/boards?board=${board.id}`);
  await card(page, 'Kanban extension').locator('.kb-card-open').click();
  const dialog = page.getByRole('dialog', { name: 'Kanban extension' });
  await dialog.getByRole('button', { name: 'Delete' }).click();
  const question = page.getByRole('alertdialog');
  await expect(question).toContainText('Delete the card “Kanban extension”?');
  await question.getByRole('button', { name: 'Cancel' }).click();
  await expect(question).toHaveCount(0);
  await expect(dialog).toBeVisible();
  expect(server.asked.some((a) => a.method === 'DELETE')).toBe(false);
  await dialog.getByRole('button', { name: 'Delete' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(cardsOf(page, 'In progress')).toHaveText(['Fix the flaky login test']);
  const gone = board.cards.find((c: { title: string }) => c.title === 'Kanban extension');
  expect(server.asked.filter((a) => a.method === 'DELETE').map((a) => a.path)).toEqual([`/boards/${board.id}/cards/${gone.id}`]);
});

test('a change an agent makes elsewhere shows by itself, and a dialog open meanwhile keeps what was typed in it', async ({ page }) => {
  const board = await realisticBoard(server);
  await page.goto(`/x/pithagoras-kanban/boards?board=${board.id}`);
  await card(page, 'Fix the flaky login test').locator('.kb-card-open').click();
  const dialog = page.getByRole('dialog', { name: 'Fix the flaky login test' });
  await dialog.getByLabel('Assignee').fill('Someone new');
  // Asked again and again, it is told the board has not changed.
  await expect.poll(() => server.asked.filter((a) => a.path === `/boards/${board.id}?have=${board.version}`).length, { timeout: 10_000 }).toBeGreaterThan(0);

  const tools = server.tools('chat-1');
  const flaky = board.cards.find((c: { title: string }) => c.title === 'Fix the flaky login test');
  await tools.kanban_add_card.execute('1', { board: 'Release 0.2', title: 'Retry the CI job on a cookie error', column: 'To do', labels: ['ci'] });
  await tools.kanban_update_card.execute('2', { card: flaky.id, note: 'Opened a pull request with the fix.' });
  await expect(cardsOf(page, 'To do')).toContainText(['Retry the CI job on a cookie error'], { timeout: 10_000 });
  // The dialog is open, with what was typed, and with what the agent wrote.
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('Assignee')).toHaveValue('Someone new');
  const entry = dialog.getByRole('region', { name: 'Activity' }).locator('.kb-entry').first();
  await expect(entry).toContainText('Agent');
  await expect(entry).toContainText('Fix the flaky test');
  await expect(entry).toContainText('Opened a pull request with the fix.');
  await expect(entry.getByRole('link', { name: 'Open the chat Fix the flaky test' })).toHaveAttribute('href', '/s/chat-1');
  // Closing it asks first: what was typed is not saved.
  await page.keyboard.press('Escape');
  await expect(page.getByRole('alertdialog')).toContainText('Discard your changes?');
});

test('a page that is not visible does not look, and looks at once when it is visible again', async ({ page }) => {
  const board = await realisticBoard(server);
  await page.goto(`/x/pithagoras-kanban/boards?board=${board.id}`);
  await expect(cardsOf(page, 'Backlog')).toHaveCount(2);
  // The tab is put behind another, as the browser says it.
  const visibility = (state: 'hidden' | 'visible') =>
    page.evaluate((state) => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
      document.dispatchEvent(new Event('visibilitychange'));
    }, state);
  await visibility('hidden');
  const before = server.asked.length;
  await server.tools('chat-1').kanban_add_card.execute('1', { board: board.id, title: 'Made while the tab was away', column: 'Backlog' });
  await page.waitForTimeout(4000);
  expect(server.since(before)).toEqual([]);
  await expect(page.getByText('Made while the tab was away')).toHaveCount(0);
  await visibility('visible');
  await expect(cardsOf(page, 'Backlog')).toContainText(['Made while the tab was away'], { timeout: 1500 });
});

test('a refresh that comes while a card is held waits until it is let go', async ({ page }) => {
  const board = await realisticBoard(server);
  await page.goto(`/x/pithagoras-kanban/boards?board=${board.id}`);
  const box = (await card(page, 'Kanban extension').boundingBox())!;
  await page.mouse.move(box.x + 30, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 60, box.y + box.height / 2 + 20, { steps: 4 });
  await expect(page.locator('.kb-ghost')).toBeVisible();
  await server.tools('chat-1').kanban_add_card.execute('1', { board: board.id, title: 'Added while it was held', column: 'Backlog' });
  // Asked for and kept back: the card is still held, and the board as it was.
  await page.waitForTimeout(4000);
  await expect(page.locator('.kb-ghost')).toBeVisible();
  await expect(page.getByText('Added while it was held')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect(cardsOf(page, 'Backlog')).toContainText(['Added while it was held']);
});

test('columns are added, renamed, moved and deleted; one with cards asks where they go', async ({ page }) => {
  const board = await realisticBoard(server);
  await page.goto(`/x/pithagoras-kanban/boards?board=${board.id}`);
  await page.getByRole('button', { name: 'Add a column' }).click();
  await page.getByRole('textbox', { name: 'Name of the new column' }).fill('Blocked');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('region', { name: /^Column / })).toHaveCount(6);
  const columnMenu = async (name: string, item: string) => {
    await page.getByRole('button', { name: `Actions for column ${name}` }).click();
    await page.getByRole('menuitem', { name: item }).click();
  };
  await columnMenu('Blocked', 'Rename');
  await page.getByRole('textbox', { name: 'Name of the column' }).fill('Waiting');
  await page.keyboard.press('Enter');
  await columnMenu('Waiting', 'Move left');
  await expect(page.locator('.kb-column-name')).toHaveText(['Backlog', 'To do', 'In progress', 'Review', 'Waiting', 'Done']);
  // Empty: the portal's question.
  await columnMenu('Waiting', 'Delete column');
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete' }).click();
  await expect(page.locator('.kb-column-name')).toHaveText(['Backlog', 'To do', 'In progress', 'Review', 'Done']);
  // With cards: where they go.
  await columnMenu('Backlog', 'Delete column');
  const dialog = page.getByRole('dialog', { name: 'Delete the column “Backlog”?' });
  await expect(dialog).toContainText('It holds 2 cards');
  await dialog.getByRole('combobox', { name: 'Move the cards to' }).click();
  await page.getByRole('option', { name: 'Done' }).click();
  await dialog.getByRole('button', { name: 'Move them and delete the column' }).click();
  await expect(page.locator('.kb-column-name')).toHaveText(['To do', 'In progress', 'Review', 'Done']);
  await expect(cardsOf(page, 'Done')).toHaveText(['Media is an extension', 'Docker settings page', 'Dark mode for the settings page', 'Export a board as Markdown']);
  expect(server.asked.filter((a) => a.method === 'DELETE').map((a) => a.path)).toEqual([expect.stringMatching(/\/columns\/col-\w+$/), `/boards/${board.id}/columns/${board.columns[0].id}?to=${board.columns[4].id}`]);
});

test('the dialog that deletes a column keeps to the board as it changes elsewhere', async ({ page }) => {
  const board = await realisticBoard(server);
  await page.goto(`/x/pithagoras-kanban/boards?board=${board.id}`);
  await page.getByRole('button', { name: 'Actions for column Backlog' }).click();
  await page.getByRole('menuitem', { name: 'Delete column' }).click();
  await expect(page.getByRole('dialog', { name: 'Delete the column “Backlog”?' })).toContainText('It holds 2 cards');
  // Meanwhile an agent adds a card to it, and it is renamed on another page.
  await server.tools('chat-1').kanban_add_card.execute('1', { board: board.id, title: 'Added meanwhile', column: 'Backlog' });
  await server.call('PATCH', `/boards/${board.id}/columns/${board.columns[0].id}`, { name: 'Someday' });
  const dialog = page.getByRole('dialog', { name: 'Delete the column “Someday”?' });
  await expect(dialog).toContainText('It holds 3 cards', { timeout: 10_000 });
  // Its cards go to one of the other columns, never to itself.
  await dialog.getByRole('combobox', { name: 'Move the cards to' }).click();
  await expect(page.getByRole('option')).toHaveText(['To do', 'In progress', 'Review', 'Done']);
  await page.getByRole('option', { name: 'Review' }).click();
  await dialog.getByRole('button', { name: 'Move them and delete the column' }).click();
  await expect(page.locator('.kb-column-name')).toHaveText(['To do', 'In progress', 'Review', 'Done']);
  await expect(cardsOf(page, 'Review')).toHaveText(['Faster prefill on llama.cpp', 'Dark mode for the settings page', 'Export a board as Markdown', 'Added meanwhile']);
  expect(server.asked.filter((a) => a.method === 'DELETE').map((a) => a.path)).toEqual([`/boards/${board.id}/columns/${board.columns[0].id}?to=${board.columns[3].id}`]);
});

test('on a phone the board is one column wide, and snaps from one column to the next', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const board = await realisticBoard(server);
  await page.goto(`/x/pithagoras-kanban/boards?board=${board.id}`);
  const columns = page.locator('.kb-columns');
  await expect(column(page, 'Backlog')).toBeVisible();
  expect(await columns.evaluate((el) => getComputedStyle(el).scrollSnapType)).toBe('x mandatory');
  const room = await columns.evaluate((el) => el.clientWidth);
  const first = (await column(page, 'Backlog').boundingBox())!;
  expect(Math.abs(first.width - room)).toBeLessThanOrEqual(1);
  // The next one is off to the side, a swipe away.
  expect((await column(page, 'To do').boundingBox())!.x).toBeGreaterThanOrEqual(390);
  await columns.evaluate((el) => el.scrollBy({ left: 120 }));
  await expect.poll(async () => (await column(page, 'To do').boundingBox())!.x, { timeout: 5000 }).toBeLessThan(40);
  // Nothing of the page is wider than the phone.
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test.describe('with a finger', () => {
  test.use({ hasTouch: true });

  test('a card held still for a moment is dragged by the finger to another column; a finger that moves at once scrolls', async ({ page }) => {
    const board = await realisticBoard(server);
    await page.goto(`/x/pithagoras-kanban/boards?board=${board.id}`);
    await expect(cardsOf(page, 'To do')).toHaveCount(3);
    const cdp = await page.context().newCDPSession(page);
    const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', x = 0, y = 0) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
    const from = (await card(page, 'Write the upgrade notes').boundingBox())!;
    const to = (await card(page, 'Fix the flaky login test').boundingBox())!;
    const [x0, y0] = [from.x + 30, from.y + from.height / 2];

    // Moved at once: no drag, the card stays.
    await touch('touchStart', x0, y0);
    for (let i = 1; i <= 5; i++) await touch('touchMove', x0 + i * 12, y0);
    await touch('touchEnd');
    await expect(page.locator('.kb-ghost')).toHaveCount(0);
    await expect(cardsOf(page, 'To do')).toHaveText(['Write the upgrade notes', 'Check the voice add-on on a 6 GB card', 'Rotate the signing key']);
    // The swipe is over, its momentum too: a touch that starts while the board still glides is the browser's to scroll.
    await page.waitForTimeout(800);

    // Held, then carried over the top of the first card in progress.
    await touch('touchStart', x0, y0);
    await page.waitForTimeout(450);
    await expect(page.locator('.kb-ghost')).toBeVisible();
    const [x1, y1] = [to.x + to.width / 2, to.y + 6];
    for (let i = 1; i <= 10; i++) await touch('touchMove', x0 + ((x1 - x0) * i) / 10, y0 + ((y1 - y0) * i) / 10);
    await expect(column(page, 'In progress').locator('.kb-drop')).toHaveCount(1);
    await touch('touchEnd');
    await expect(cardsOf(page, 'In progress')).toHaveText(['Write the upgrade notes', 'Fix the flaky login test', 'Kanban extension']);
    expect(server.asked.filter((a) => a.path.endsWith('/move')).map((a) => a.body)).toEqual([{ column: board.columns[2].id, index: 0 }]);
  });

  test('on a phone a card held near the edge turns the board to the next column, and is let go there', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const board = await realisticBoard(server);
    const todo = board.columns[1].id;
    await page.goto(`/x/pithagoras-kanban/boards?board=${board.id}`);
    await expect(cardsOf(page, 'Backlog')).toHaveCount(2);
    const cdp = await page.context().newCDPSession(page);
    const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', x = 0, y = 0) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
    const room = (await page.locator('.kb-columns').boundingBox())!;
    const from = (await card(page, 'Export a board as Markdown').boundingBox())!;
    const [x0, y0] = [from.x + 40, from.y + from.height / 2];
    await touch('touchStart', x0, y0);
    await page.waitForTimeout(450);
    await expect(page.locator('.kb-ghost')).toBeVisible();
    // Carried near the right edge and held there: the board turns to the next column, To do, under the finger.
    const edge = room.x + room.width - 12;
    for (let i = 1; i <= 6; i++) await touch('touchMove', x0 + ((edge - x0) * i) / 6, y0);
    await page.waitForFunction((id) => !!document.querySelector(`[data-kb-column="${id}"] .kb-drop`), todo, { polling: 'raf', timeout: 5000 });
    // Back from the edge, it stays on To do.
    await touch('touchMove', room.x + room.width / 2, y0);
    await page.waitForTimeout(800);
    await expect(column(page, 'To do').locator('.kb-drop')).toHaveCount(1);
    expect(await page.locator('.kb-columns').evaluate((el) => getComputedStyle(el).scrollSnapType)).toBe('x mandatory');
    await touch('touchEnd');
    await expect(cardsOf(page, 'To do')).toContainText(['Export a board as Markdown']);
    await expect(cardsOf(page, 'Backlog')).toHaveText(['Dark mode for the settings page']);
    expect(server.asked.filter((a) => a.path.endsWith('/move')).map((a) => a.body.column)).toEqual([todo]);
    // To do fills the phone.
    const shown = (await column(page, 'To do').boundingBox())!;
    expect(Math.abs(shown.x - room.x)).toBeLessThanOrEqual(1);
  });
});
