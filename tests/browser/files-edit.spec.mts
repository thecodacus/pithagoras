import { type Page, type Route } from '@playwright/test';
import { test, expect } from './portal-mock';

type Put = { content: string; mtime?: number };

/**
 * The chat page with its Files panel, over two chats (`first`, then `second`)
 * that each have a notes.md. `put` answers a save; what was sent is returned,
 * and `disk` is what a read finds, which a test can change under the panel.
 */
async function files(page: Page, put: (n: number) => Parameters<Route['fulfill']>[0] | null = () => null) {
  const saves: Put[] = [];
  const disk = { content: 'one\n', mtime: 1 };
  await page.route('**/api/sessions/*/file*', (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/files')) {
      return route.fulfill({ json: { path: '', entries: [{ name: 'notes.md', type: 'file', size: 4, mtime: 1 }], truncated: false } });
    }
    if (route.request().method() === 'PUT') {
      saves.push(JSON.parse(route.request().postData() ?? '{}'));
      const refused = put(saves.length);
      if (refused) return route.fulfill(refused);
      disk.mtime++;
      return route.fulfill({ json: { ok: true, size: 4, mtime: disk.mtime } });
    }
    return route.fulfill({ json: { content: disk.content, binary: false, size: disk.content.length, mtime: disk.mtime } });
  });
  await page.setViewportSize({ width: 1300, height: 800 });
  await page.goto('/tests/chat.html?phase=switch');
  await page.getByRole('button', { name: 'Files', exact: true }).click();
  await row(page).click();
  await expect(box(page)).toHaveValue('one\n');
  return { saves, disk };
}

// The row in the list; its rename and delete buttons name the file as well.
const row = (page: Page) => page.getByRole('button', { name: /^notes\.md( \d+ B)?$/ });
const box = (page: Page) => page.getByRole('textbox', { name: 'Contents of notes.md' });
const save = (page: Page) => page.getByRole('button', { name: 'Save', exact: true });
const second = (page: Page) => page.getByRole('button', { name: 'Open the second chat' }).click();
const first = (page: Page) => page.getByRole('button', { name: 'Open the first chat' }).click();

test('a failed save says so above the editor, and the text and the Save button stay', async ({ page }) => {
  const { saves } = await files(page, (n) => (n === 1 ? { status: 500, json: { error: 'No space left on device', code: 'failed' } } : null));
  await box(page).fill('two\n');
  await save(page).click();
  await expect(page.getByRole('alert')).toHaveText('No space left on device');
  // Nothing was replaced by the message: it can be copied, and tried again.
  await expect(box(page)).toHaveValue('two\n');
  await expect(save(page)).toBeEnabled();
  await save(page).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(save(page)).toBeDisabled();
  expect(saves.map((s) => s.content)).toEqual(['two\n', 'two\n']);
});

test('a save that finds the file changed is told by the code, whatever the server words it as', async ({ page }) => {
  const { saves } = await files(page, (n) => (n === 1 ? { status: 409, json: { error: 'Somebody else wrote this file first', code: 'conflict' } } : null));
  await box(page).fill('two\n');
  await save(page).click();
  const bar = page.getByRole('alert').filter({ hasText: 'This file changed after you opened it.' });
  await expect(bar).toBeVisible();
  await expect(box(page)).toHaveValue('two\n');
  await bar.getByRole('button', { name: 'Save mine anyway' }).click();
  await expect(bar).toHaveCount(0);
  // The second save carries no time, so that it replaces whatever is there.
  expect(saves.map((s) => s.mtime)).toEqual([1, undefined]);
});

test('another 409 is an error of its own, not the bar about a changed file', async ({ page }) => {
  await files(page, () => ({ status: 409, json: { error: 'Something with that name is already here', code: 'exists' } }));
  await box(page).fill('two\n');
  await save(page).click();
  await expect(page.getByRole('alert')).toHaveText('Something with that name is already here');
  await expect(page.getByText('This file changed after you opened it.')).toHaveCount(0);
  await expect(box(page)).toHaveValue('two\n');
});

test('an edit that is not saved is still there when the chat is left and come back to', async ({ page }) => {
  const { saves } = await files(page);
  await box(page).fill('two, not saved\n');
  await expect(page.getByTitle('Not saved')).toBeVisible();
  await second(page);
  // The other chat has its own folder and nothing open in it.
  await expect(row(page)).toBeVisible();
  await expect(box(page)).toHaveCount(0);
  await first(page);
  await expect(box(page)).toHaveValue('two, not saved\n');
  await expect(page.getByTitle('Not saved')).toBeVisible();
  await expect(save(page)).toBeEnabled();
  await save(page).click();
  await expect(save(page)).toBeDisabled();
  expect(saves).toEqual([{ content: 'two, not saved\n', mtime: 1 }]);
});

test('an edit given up with "Discard" is not brought back', async ({ page }) => {
  await files(page);
  await box(page).fill('two\n');
  await page.getByRole('button', { name: 'Files', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Discard' }).click();
  await expect(box(page)).toHaveCount(0);
  await second(page);
  await first(page);
  await page.getByRole('button', { name: 'Files', exact: true }).click();
  await expect(row(page)).toBeVisible();
  await expect(box(page)).toHaveCount(0);
});

test('an edit brought back for a file that changed meanwhile asks what to do, as a save would', async ({ page }) => {
  const { saves, disk } = await files(page);
  await box(page).fill('two\n');
  await second(page);
  disk.content = 'one, by the agent\n';
  disk.mtime = 5;
  await first(page);
  const bar = page.getByRole('alert').filter({ hasText: 'This file changed after you opened it.' });
  await expect(bar).toBeVisible();
  await expect(box(page)).toHaveValue('two\n');
  await bar.getByRole('button', { name: 'Load the new version' }).click();
  await expect(box(page)).toHaveValue('one, by the agent\n');
  expect(saves).toEqual([]);
});

test('an edit survives a reload of the page', async ({ page }) => {
  await files(page);
  await box(page).fill('two\n');
  await expect(page.getByTitle('Not saved')).toBeVisible();
  // Reloading with an edit asks first; the answer here is yes.
  page.on('dialog', (d) => void d.accept());
  await page.reload();
  await page.getByRole('button', { name: 'Files', exact: true }).click();
  await expect(box(page)).toHaveValue('two\n');
  await expect(page.getByTitle('Not saved')).toBeVisible();
});

test('a markdown file can be shown as a page and back, following what is typed, and the choice is kept', async ({ page }) => {
  await files(page);
  await box(page).fill('# Title\n\n- item\n');
  await page.getByRole('button', { name: 'Show the rendered page' }).click();
  const shown = page.getByRole('region', { name: 'Rendered notes.md' });
  await expect(shown.getByRole('heading', { name: 'Title' })).toBeVisible();
  await expect(shown.getByRole('listitem')).toHaveText('item');
  await expect(box(page)).toHaveCount(0);
  // Unsaved text is what the page shows, and Save is still there for it.
  await expect(save(page)).toBeEnabled();
  // Saved first, so that no unsaved text brings the file back open by itself.
  await save(page).click();
  await expect(save(page)).toBeDisabled();
  await page.reload();
  await page.getByRole('button', { name: 'Files', exact: true }).click();
  await row(page).click();
  await expect(page.getByRole('region', { name: 'Rendered notes.md' })).toBeVisible();
  await page.getByRole('button', { name: 'Show the source' }).click();
  await expect(box(page)).toBeVisible();
});
