import { type Page, type Route } from '@playwright/test';
import { test, expect } from '../../../../tests/browser/portal-mock';

// Files, as a portal that ships it has it.
test.use({ installed: ['extensions/files'] });

type Put = { content: string; mtime?: number };
type Entry = { name: string; type: 'file' | 'dir'; size: number; mtime: number };

/**
 * The chat page with its Files panel, over a folder that lists `listed`
 * (notes.md at first), with notes.md opened by hand unless `open` is false.
 * `disk` is what a read of the file finds, which a test changes under the
 * panel: while `gone` is set the read finds no file, and from `hold()` until
 * what it returns is called a read waits. What a read finds is taken when it
 * arrives, as the server reads the file then, so a read that waits answers
 * with the file as it was before what happened meanwhile. A save `put` refuses is answered
 * with that; otherwise what was saved is on disk. A markdown file opens as a
 * page unless the source was chosen before, so the tests start with that
 * choice made; `shown: 'page'` leaves it out. Returned: what was saved, and
 * how often the file was read and the folder listed.
 */
async function files(
  page: Page,
  { content = 'one\n', shown = 'source', open = true, put = () => null }: { content?: string; shown?: 'source' | 'page'; open?: boolean; put?: (n: number) => Parameters<Route['fulfill']>[0] | null } = {},
) {
  const saves: Put[] = [];
  const disk = { content, mtime: 1, gone: false };
  const listed: Entry[] = [{ name: 'notes.md', type: 'file', size: 4, mtime: 1 }];
  let reads = 0;
  let lists = 0;
  let held: Promise<void> | null = null;
  await page.route('**/api/x/pithagoras-files/chats/*/file*', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/files')) {
      lists++;
      return route.fulfill({ json: { path: '', entries: listed, truncated: false } });
    }
    if (route.request().method() === 'PUT') {
      saves.push(JSON.parse(route.request().postData() ?? '{}'));
      const refused = put(saves.length);
      if (refused) return route.fulfill(refused);
      disk.content = saves.at(-1)!.content;
      disk.mtime++;
      return route.fulfill({ json: { ok: true, size: disk.content.length, mtime: disk.mtime } });
    }
    reads++;
    const found = { ...disk };
    if (held) await held;
    if (found.gone) return route.fulfill({ status: 404, json: { error: 'There is no such file' } });
    return route.fulfill({ json: { content: found.content, binary: false, size: found.content.length, mtime: found.mtime } });
  });
  if (shown === 'source') await page.addInitScript(() => localStorage.setItem('filesMarkdownRendered', '0'));
  await page.setViewportSize({ width: 1300, height: 800 });
  await page.goto('/tests/chat.html?phase=switch');
  await page.getByRole('button', { name: 'Files', exact: true }).click();
  await expect(row(page)).toBeVisible();
  if (open) await row(page).click();
  const hold = () => {
    let release!: () => void;
    held = new Promise((r) => (release = r));
    return () => {
      held = null;
      release();
    };
  };
  return { saves, disk, listed, hold, reads: () => reads, lists: () => lists };
}

let calls = 0;
/** The agent's read, write or edit of `path`, as pi reports it: a read is noticed when it starts, a write or an edit when it ends. */
const agent = (page: Page, tool: 'read' | 'write' | 'edit', path: string) =>
  page.evaluate(
    ([tool, path, id]) => {
      const emit = (window as any).emit;
      emit('tool_execution_start', { toolCallId: id, toolName: tool, args: { path } });
      emit('tool_execution_end', { toolCallId: id, toolName: tool, result: { content: [{ type: 'text', text: 'Done.' }] } });
    },
    [tool, path, `call${++calls}`],
  );

// The row in the list; its rename and delete buttons name the file as well.
const row = (page: Page) => page.getByRole('button', { name: /^notes\.md( \d+ B)?$/ });
const box = (page: Page) => page.getByRole('textbox', { name: 'Contents of notes.md' });
const rendered = (page: Page) => page.getByRole('region', { name: 'Rendered notes.md' });
const save = (page: Page) => page.getByRole('button', { name: 'Save', exact: true });
const refresh = (page: Page) => page.getByRole('button', { name: 'Refresh', exact: true });
const bar = (page: Page) => page.getByRole('alert').filter({ hasText: 'This file changed after you opened it.' });
/** The Refresh button has stopped turning: the read it asked for is answered, and what it found is shown. */
const answered = (page: Page) => expect(refresh(page).locator('svg')).not.toHaveClass(/animate-spin/);

test('Refresh with a file open reads it again, and the new text takes the place of the old, with no "Loading…" between', async ({ page }) => {
  const { saves, disk, hold, reads } = await files(page);
  await expect(box(page)).toHaveValue('one\n');
  disk.content = 'two\n';
  disk.mtime = 2;
  const release = hold();
  await refresh(page).click();
  await expect.poll(reads).toBe(2);
  // While it is read, the old text is still there, and the button turns.
  await expect(box(page)).toHaveValue('one\n');
  await expect(page.getByText('Loading…')).toHaveCount(0);
  await expect(refresh(page).locator('svg')).toHaveClass(/animate-spin/);
  release();
  await expect(box(page)).toHaveValue('two\n');
  await answered(page);
  // It is the file as it is now: nothing to save, and a save is checked against the new time.
  await expect(save(page)).toBeDisabled();
  await box(page).fill('three\n');
  await save(page).click();
  await expect(save(page)).toBeDisabled();
  expect(saves).toEqual([{ content: 'three\n', mtime: 2 }]);
});

test('Refresh keeps the view the file is shown in: a file being written in stays the source, a page stays a page, and a page emptied is the source', async ({ page }) => {
  const { disk } = await files(page, { shown: 'page', content: '' });
  // Empty, it opened as the source, although the page is what was chosen.
  await expect(box(page)).toHaveValue('');
  disk.content = '# Title\n';
  disk.mtime = 2;
  await refresh(page).click();
  await expect(box(page)).toHaveValue('# Title\n');
  await expect(rendered(page)).toHaveCount(0);
  await page.getByRole('button', { name: 'Show the rendered page' }).click();
  await expect(rendered(page).getByRole('heading', { name: 'Title' })).toBeVisible();
  disk.content = '# Again\n';
  disk.mtime = 3;
  await refresh(page).click();
  await expect(rendered(page).getByRole('heading', { name: 'Again' })).toBeVisible();
  await expect(box(page)).toHaveCount(0);
  // A blank page cannot be typed into.
  disk.content = '';
  disk.mtime = 4;
  await refresh(page).click();
  await expect(box(page)).toHaveValue('');
  await expect(rendered(page)).toHaveCount(0);
});

test('Refresh with changes not saved keeps them, asks only when the file changed, and "Load the new version" and "Save mine anyway" do what they say', async ({ page }) => {
  const { saves, disk, reads } = await files(page);
  await box(page).fill('mine\n');
  // Not changed on disk: nothing to ask.
  await refresh(page).click();
  await expect.poll(reads).toBe(2);
  await answered(page);
  await expect(bar(page)).toHaveCount(0);
  await expect(box(page)).toHaveValue('mine\n');

  disk.content = 'theirs\n';
  disk.mtime = 2;
  await refresh(page).click();
  await expect(bar(page)).toBeVisible();
  await expect(box(page)).toHaveValue('mine\n');
  await expect(page.getByTitle('Not saved')).toBeVisible();
  await bar(page).getByRole('button', { name: 'Load the new version' }).click();
  await expect(box(page)).toHaveValue('theirs\n');
  await expect(bar(page)).toHaveCount(0);

  await box(page).fill('mine again\n');
  disk.content = 'theirs, again\n';
  disk.mtime = 3;
  await refresh(page).click();
  await expect(bar(page)).toBeVisible();
  await expect(box(page)).toHaveValue('mine again\n');
  await bar(page).getByRole('button', { name: 'Save mine anyway' }).click();
  await expect(bar(page)).toHaveCount(0);
  await expect(save(page)).toBeDisabled();
  // Sent without a time, so that it replaces what is there.
  expect(saves).toEqual([{ content: 'mine again\n' }]);
  expect(disk.content).toBe('mine again\n');
});

test('a read that Refresh asked for before a save answered does not put back the text from before the save', async ({ page }) => {
  const { saves, disk, hold, reads } = await files(page);
  // Changes not saved, saved while the read is out: it found the file as it was before.
  await box(page).fill('mine\n');
  let release = hold();
  await refresh(page).click();
  await expect.poll(reads).toBe(2);
  await save(page).click();
  await expect(save(page)).toBeDisabled();
  expect(disk).toMatchObject({ content: 'mine\n', mtime: 2 });
  release();
  await answered(page);
  await expect(box(page)).toHaveValue('mine\n');
  await expect(page.getByTitle('Not saved')).toHaveCount(0);
  await expect(bar(page)).toHaveCount(0);

  // No changes when it was asked for, typed and saved while it is out: the same.
  release = hold();
  await refresh(page).click();
  await expect.poll(reads).toBe(3);
  await box(page).fill('typed while it was read\n');
  await box(page).press('ControlOrMeta+s');
  await expect(save(page)).toBeDisabled();
  release();
  await answered(page);
  await expect(box(page)).toHaveValue('typed while it was read\n');
  // The next save is checked against the time the last one gave, not the time the old read found.
  await box(page).fill('more\n');
  await save(page).click();
  await expect(save(page)).toBeDisabled();
  expect(saves).toEqual([
    { content: 'mine\n', mtime: 1 },
    { content: 'typed while it was read\n', mtime: 2 },
    { content: 'more\n', mtime: 3 },
  ]);
});

test('what was said about the text before goes when Refresh shows the file as it is now', async ({ page }) => {
  const { disk } = await files(page, { put: () => ({ status: 500, json: { error: 'No space left on device', code: 'failed' } }) });
  await box(page).fill('two\n');
  await save(page).click();
  await expect(page.getByRole('alert')).toHaveText('No space left on device');
  disk.content = 'theirs\n';
  disk.mtime = 2;
  await refresh(page).click();
  await expect(bar(page)).toBeVisible();
  // Taken back to what was read: nothing is left that is not saved, so the next Refresh shows the file.
  await box(page).fill('one\n');
  await refresh(page).click();
  await expect(box(page)).toHaveValue('theirs\n');
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('a Refresh whose read fails shows the error where the text was, and with changes not saved asks instead', async ({ page }) => {
  const { disk } = await files(page);
  await box(page).fill('mine\n');
  disk.gone = true;
  await refresh(page).click();
  await expect(bar(page)).toBeVisible();
  await expect(box(page)).toHaveValue('mine\n');
  await box(page).fill('one\n');
  await refresh(page).click();
  await expect(page.getByRole('alert')).toHaveText('There is no such file');
  await expect(box(page)).toHaveCount(0);
  await expect(page.getByTitle('Not saved')).toHaveCount(0);
});

test('the agent writing or editing the open file shows in it while the panel is not following, and with changes not saved it asks instead', async ({ page }) => {
  const { disk } = await files(page);
  await expect(box(page)).toHaveValue('one\n');
  // Opened by hand: the panel does not follow the agent.
  const follow = page.getByRole('button', { name: 'Follow', exact: true });
  await expect(follow).toHaveAttribute('aria-pressed', 'false');
  disk.content = 'by the agent\n';
  disk.mtime = 2;
  await agent(page, 'write', 'notes.md');
  await expect(box(page)).toHaveValue('by the agent\n');
  await expect(follow).toHaveAttribute('aria-pressed', 'false');

  await box(page).fill('mine\n');
  disk.content = 'edited by the agent\n';
  disk.mtime = 3;
  await agent(page, 'edit', '/workspaces/pithagoras/notes.md');
  await expect(bar(page)).toBeVisible();
  await expect(box(page)).toHaveValue('mine\n');
  await bar(page).getByRole('button', { name: 'Load the new version' }).click();
  await expect(box(page)).toHaveValue('edited by the agent\n');
});

test('only a change of the open file reads it again: the agent reading it, or writing another file, leaves it as it is', async ({ page }) => {
  const { disk, reads, lists } = await files(page);
  await expect(box(page)).toHaveValue('one\n');
  disk.content = 'changed\n';
  disk.mtime = 2;
  // Each is seen: the folder is listed again for it.
  await agent(page, 'read', 'notes.md');
  await expect.poll(lists).toBe(2);
  await agent(page, 'write', 'other.md');
  await expect.poll(lists).toBe(3);
  await expect(box(page)).toHaveValue('one\n');
  // Read once when it was opened, and once now.
  await refresh(page).click();
  await expect(box(page)).toHaveValue('changed\n');
  expect(reads()).toBe(2);
});

test('while following, the agent changing the open file shows in place, and an edit not saved is asked about instead of being left behind', async ({ page }) => {
  const { disk, hold, reads } = await files(page, { open: false });
  await agent(page, 'read', 'notes.md');
  await expect(box(page)).toHaveValue('one\n');
  await expect(page.getByRole('button', { name: 'Following', exact: true })).toBeVisible();
  disk.content = 'by the agent\n';
  disk.mtime = 2;
  const release = hold();
  await agent(page, 'write', 'notes.md');
  // While it is read again, the old text is still there.
  await expect.poll(reads).toBe(2);
  await expect(box(page)).toHaveValue('one\n');
  await expect(page.getByText('Loading…')).toHaveCount(0);
  release();
  await expect(box(page)).toHaveValue('by the agent\n');

  await box(page).fill('mine\n');
  disk.content = 'edited by the agent\n';
  disk.mtime = 3;
  await agent(page, 'edit', 'notes.md');
  await expect(bar(page)).toBeVisible();
  await expect(box(page)).toHaveValue('mine\n');
  await expect(page.getByRole('button', { name: 'Following', exact: true })).toBeVisible();
});

test('Refresh in the folder lists it again', async ({ page }) => {
  const { listed, lists } = await files(page, { open: false });
  listed.push({ name: 'later.md', type: 'file', size: 2, mtime: 1 });
  await refresh(page).click();
  await expect(page.getByRole('button', { name: /^later\.md/ })).toBeVisible();
  expect(lists()).toBe(2);
});

test('Refresh with a file open lists the folder again as well, so that the folder is as it is now when you go back to it', async ({ page }) => {
  const { listed } = await files(page);
  await expect(box(page)).toHaveValue('one\n');
  listed.push({ name: 'later.md', type: 'file', size: 2, mtime: 1 });
  await refresh(page).click();
  await answered(page);
  await page.getByRole('button', { name: 'Back to the folder' }).click();
  await expect(page.getByRole('button', { name: /^later\.md/ })).toBeVisible();
});
