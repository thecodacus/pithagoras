import { type Page } from '@playwright/test';
import { test, expect } from '../../../../tests/browser/portal-mock';

// Files, as a portal that ships it has it.
test.use({ installed: ['extensions/files'] });

type Unsaved = { changed: number; unpushed: number; stashes: number; unknown?: true };

/**
 * The chat page with its Files panel, over a folder "api" and a file "notes.md".
 * `unsaved` is what asking first says the folder holds; `found` is what DELETE
 * finds without ?discard=1, which answers 409 while it holds any. Returns what
 * was asked and what DELETE was sent, as their queries.
 */
async function files(page: Page, opts: { unsaved?: Unsaved | null; found?: Unsaved; asks?: boolean; hold?: Promise<void> } = {}) {
  const asked: string[] = [];
  const deletes: string[] = [];
  const gone = new Set<string>();
  await page.route('**/api/x/pithagoras-files/chats/preview/files**', (route) => {
    const at = new URL(route.request().url()).searchParams.get('path') ?? '';
    if (gone.has(at)) return route.fulfill({ status: 404, json: { error: 'There is no such folder' } });
    const entries = at === 'other'
      ? [{ name: 'inside.txt', type: 'file', size: 1, mtime: 1 }]
      : at === 'api'
      ? [{ name: 'src', type: 'dir', size: 0, mtime: 1 }]
      : [{ name: 'api', type: 'dir', size: 0, mtime: 1 }, { name: 'other', type: 'dir', size: 0, mtime: 1 }, { name: 'notes.md', type: 'file', size: 3, mtime: 1 }].filter((e) => !gone.has(e.name));
    return route.fulfill({ json: { path: at, entries, truncated: false } });
  });
  await page.route('**/api/x/pithagoras-files/chats/preview/unsaved?**', async (route) => {
    asked.push(new URL(route.request().url()).search);
    await opts.hold;
    return route.fulfill({ json: { unsaved: opts.unsaved ?? null } });
  });
  await page.route('**/api/x/pithagoras-files/chats/preview/file?**', (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() !== 'DELETE') return route.fulfill({ status: 404, json: {} });
    deletes.push(url.search);
    const found = opts.found ?? opts.unsaved;
    const held = found && (found.changed || found.unpushed || found.stashes || found.unknown);
    if (held && url.searchParams.get('path') === 'api' && url.searchParams.get('discard') !== '1') {
      return route.fulfill({ status: 409, json: { error: 'This folder holds work that exists nowhere else. Delete it only when that is meant.', code: 'unsaved-work', unsaved: found } });
    }
    gone.add(url.searchParams.get('path')!);
    return route.fulfill({ json: { ok: true } });
  });
  await page.addInitScript((asks) => {
    if (!asks) localStorage.setItem('confirmDeletes', 'off');
  }, opts.asks ?? true);
  await page.setViewportSize({ width: 1300, height: 800 });
  await page.goto('/tests/chat.html?phase=tools');
  await page.getByRole('button', { name: 'Files', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Delete api' })).toBeAttached();
  return { asked, deletes };
}

const dialog = (page: Page) => page.getByRole('alertdialog');
const deleteRow = (page: Page, name = 'api') => page.getByRole('button', { name: `Delete ${name}` }).click();

test('a folder with nothing of its own to lose is deleted after the one plain question', async ({ page }) => {
  const { asked, deletes } = await files(page, { unsaved: { changed: 0, unpushed: 0, stashes: 0 } });
  await deleteRow(page);
  await expect(dialog(page)).toContainText('Delete "api"?');
  await expect(dialog(page)).toContainText('Files git ignores, such as .env, are not looked at.');
  await dialog(page).getByRole('button', { name: 'Delete', exact: true }).click();
  await expect.poll(() => deletes).toEqual(['?path=api']);
  expect(asked).toEqual(['?path=api']);
  await expect(page.getByRole('button', { name: 'Delete api' })).toHaveCount(0);
});

test('git work that nothing else has is named in the one question, and goes only with ?discard=1', async ({ page }) => {
  const { deletes } = await files(page, { unsaved: { changed: 0, unpushed: 5, stashes: 1 } });
  await deleteRow(page);
  await expect(dialog(page)).toContainText('Delete "api" and its unsaved work?');
  await expect(dialog(page)).toContainText('This folder holds git work that exists nowhere else: 5 commits that no remote has, 1 stash.');
  await dialog(page).getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog(page)).toHaveCount(0);
  expect(deletes).toEqual([]);

  await deleteRow(page);
  await dialog(page).getByRole('button', { name: 'Delete anyway' }).click();
  await expect.poll(() => deletes).toEqual(['?path=api&discard=1']);
  await expect(dialog(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Delete api' })).toHaveCount(0);
});

test('the question is asked even when Settings says not to ask before deleting', async ({ page }) => {
  const { deletes } = await files(page, { unsaved: { changed: 2, unpushed: 0, stashes: 0 }, asks: false });
  await deleteRow(page);
  await expect(dialog(page)).toContainText('2 uncommitted changes');
  expect(deletes).toEqual([]);
  await dialog(page).getByRole('button', { name: 'Delete anyway' }).click();
  await expect.poll(() => deletes).toEqual(['?path=api&discard=1']);
});

test('what could not be read is not said as a fact, and not in the plain words', async ({ page }) => {
  await files(page, { unsaved: { changed: 0, unpushed: 0, stashes: 0, unknown: true } });
  await deleteRow(page);
  await expect(dialog(page)).toContainText('Delete "api" anyway?');
  await expect(dialog(page)).toContainText('Whether the folder holds git work that exists nowhere else could not be told.');
  await expect(dialog(page)).not.toContainText('ignores');
  await expect(dialog(page).getByRole('button', { name: 'Delete anyway' })).toBeVisible();
});

test('work that turns up after the question is asked about, not shown as an error', async ({ page }) => {
  // Nothing when asked, and "ask before deleting" off: no question, until the server finds work.
  const { deletes } = await files(page, { unsaved: null, found: { changed: 0, unpushed: 4, stashes: 0 }, asks: false });
  await deleteRow(page);
  await expect(dialog(page)).toContainText('4 commits that no remote has');
  await expect(page.getByText('Delete it only when that is meant')).toHaveCount(0);
  await dialog(page).getByRole('button', { name: 'Delete anyway' }).click();
  await expect.poll(() => deletes).toEqual(['?path=api', '?path=api&discard=1']);
});

test('a file is not asked about: it holds no repository', async ({ page }) => {
  const { asked, deletes } = await files(page);
  await deleteRow(page, 'notes.md');
  await expect(dialog(page)).toContainText('This removes the file.');
  await dialog(page).getByRole('button', { name: 'Delete', exact: true }).click();
  await expect.poll(() => deletes).toEqual(['?path=notes.md']);
  expect(asked).toEqual([]);
});

test('a delete still asking is not started twice, and afterwards the folder shown is the one moved to', async ({ page }) => {
  let release!: () => void;
  const hold = new Promise<void>((r) => (release = r));
  const { asked, deletes } = await files(page, { unsaved: { changed: 0, unpushed: 0, stashes: 0 }, hold });
  await deleteRow(page);
  const trash = page.getByRole('button', { name: 'Delete api' });
  await expect(trash).toBeDisabled();
  await expect(trash).toHaveAttribute('aria-busy', 'true');
  await trash.click({ force: true });
  // Moved on while it was being asked.
  await page.getByRole('button', { name: 'other', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Delete inside.txt' })).toBeAttached();
  release();
  await dialog(page).getByRole('button', { name: 'Delete', exact: true }).click();
  await expect.poll(() => deletes).toEqual(['?path=api']);
  expect(asked).toEqual(['?path=api']);
  await expect(dialog(page)).toHaveCount(0);
  // Still the folder moved to, not the one the delete started in.
  await expect(page.getByRole('button', { name: 'Delete inside.txt' })).toBeAttached();
  await expect(page.getByRole('button', { name: 'Delete notes.md' })).toHaveCount(0);
});

test('a folder opened while its delete was asked, and gone after it, is left for the one it was in', async ({ page }) => {
  let release!: () => void;
  const hold = new Promise<void>((r) => (release = r));
  const { deletes } = await files(page, { unsaved: { changed: 0, unpushed: 0, stashes: 0 }, hold });
  await deleteRow(page);
  await page.getByRole('button', { name: 'api', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Delete src' })).toBeAttached();
  release();
  await dialog(page).getByRole('button', { name: 'Delete', exact: true }).click();
  await expect.poll(() => deletes).toEqual(['?path=api']);
  await expect(page.getByRole('button', { name: 'Delete notes.md' })).toBeAttached();
  await expect(page.getByRole('button', { name: 'Delete api' })).toHaveCount(0);
  await expect(page.getByText('There is no such folder')).toHaveCount(0);
});

test('cancelling a delete gives focus back to the row\'s Delete button, whether the question was the first or the second', async ({ page }) => {
  // The button is marked busy from the click, while the question is open as well: a disabled one would keep no focus.
  await files(page, { unsaved: null, found: { changed: 2, unpushed: 0, stashes: 0 } });
  for (const name of ['notes.md', 'api']) {
    const button = page.getByRole('button', { name: `Delete ${name}` });
    await button.focus();
    await page.keyboard.press('Enter');
    await expect(dialog(page)).toContainText(`Delete "${name}"?`);
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toHaveCount(0);
    await expect(button).toBeFocused();
  }

  // The folder holds work the first question did not know of: the server refuses, and the second question starts from the button too.
  const folder = page.getByRole('button', { name: 'Delete api' });
  await folder.focus();
  await page.keyboard.press('Enter');
  await dialog(page).getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(dialog(page)).toContainText('and its unsaved work?');
  await dialog(page).getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(folder).toBeFocused();
});

test('two questions that came one after the other keep focus in the second, and the last answer gives it back to the row that was asked first', async ({ page }) => {
  let release!: () => void;
  const hold = new Promise<void>((r) => (release = r));
  await files(page, { unsaved: { changed: 0, unpushed: 0, stashes: 0 }, hold });
  // The folder's check is still out when a file is deleted: its question comes up while the file's is open.
  await page.getByRole('button', { name: 'Delete api' }).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Delete notes.md' }).focus();
  await page.keyboard.press('Enter');
  await expect(dialog(page)).toContainText('Delete "notes.md"?');
  // Until the folder's check has answered, and the page has had its frames to put the question behind the file's.
  const answered = page.waitForEvent('requestfinished', (r) => r.url().includes('/unsaved?'));
  release();
  await answered;
  await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toContainText('Delete "api"?');
  // Not sent back behind the backdrop to the row the first question came from.
  await expect(dialog(page).getByRole('button', { name: 'Cancel' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Delete notes.md' })).toBeFocused();
});

test('clicking beside a delete question answers no and gives focus back to the row, like Escape', async ({ page }) => {
  await files(page, { unsaved: null });
  const button = page.getByRole('button', { name: 'Delete notes.md' });
  await button.focus();
  await page.keyboard.press('Enter');
  await expect(dialog(page)).toContainText('Delete "notes.md"?');
  // The backdrop, as the press that follows would otherwise clear the focus that was just given back.
  await page.mouse.click(3, 3);
  await expect(dialog(page)).toHaveCount(0);
  await expect(button).toBeFocused();
});
