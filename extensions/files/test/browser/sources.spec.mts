import { type Page, type Route } from '@playwright/test';
import { test, expect } from '../../../../tests/browser/portal-mock';

// Files, as a portal that ships it has it.
test.use({ installed: ['extensions/files'] });

type Source = { id: string; label: string; writable: boolean };
type Entry = { name: string; type: 'file' | 'dir'; size: number; mtime: number };

const nextcloud: Source = { id: 'cloud', label: 'Nextcloud', writable: false };
const notes: Source = { id: 'notes', label: 'Notes', writable: true };

/**
 * The chat page with its Files panel, over a chat folder that holds work.txt, and the sources there are (none unless a test says). A source's
 * tree is `trees[id]`: its folders by path, and `texts[id]` its files by path. `answer[id]` overrides how its routes answer (a failure, or
 * a wait). Every request to Files' server half is kept in `asked` so that a test can show what was asked of whom.
 */
async function open(
  page: Page,
  {
    sources = [] as Source[],
    sourcesList,
    answer = {} as Record<string, (route: Route, what: 'files' | 'file') => Promise<void> | void>,
  }: { sources?: Source[]; sourcesList?: (route: Route) => Promise<void> | void; answer?: Record<string, (route: Route, what: 'files' | 'file') => Promise<void> | void> } = {},
) {
  const asked: string[] = [];
  const saved: { source: string; path: string; body: { content: string; mtime?: number } }[] = [];
  const trees: Record<string, Record<string, Entry[]>> = {
    cloud: {
      '': [
        { name: 'Photos', type: 'dir', size: 0, mtime: 1 },
        { name: 'todo.md', type: 'file', size: 9, mtime: 5 },
        { name: 'scan.pdf', type: 'file', size: 4, mtime: 6 },
      ],
      Photos: [{ name: 'beach.txt', type: 'file', size: 4, mtime: 7 }],
    },
    notes: { '': [{ name: 'idea.txt', type: 'file', size: 4, mtime: 3 }] },
  };
  const texts: Record<string, Record<string, { content?: string; binary?: true; mtime: number }>> = {
    cloud: { 'todo.md': { content: '# Todo\n', mtime: 5 }, 'Photos/beach.txt': { content: 'sand', mtime: 7 }, 'scan.pdf': { binary: true, mtime: 6 } },
    notes: { 'idea.txt': { content: 'idea', mtime: 3 } },
  };
  await page.route('**/api/x/pithagoras-files/chats/*/files*', (route) => {
    const dir = new URL(route.request().url()).searchParams.get('path') ?? '';
    asked.push(`folder list ${dir}`);
    return route.fulfill({ json: { path: dir, entries: [{ name: 'work.txt', type: 'file', size: 4, mtime: 1 }], truncated: false } });
  });
  await page.route('**/api/x/pithagoras-files/chats/*/file?*', (route) => {
    asked.push(`folder read ${new URL(route.request().url()).searchParams.get('path')}`);
    return route.fulfill({ json: { content: 'work', binary: false, size: 4, mtime: 1 } });
  });
  await page.route('**/api/x/pithagoras-files/chats/*/sources', (route) => (sourcesList ? sourcesList(route) : route.fulfill({ json: { sources } })));
  await page.route('**/api/x/pithagoras-files/chats/*/sources/*/**', async (route) => {
    const url = new URL(route.request().url());
    // /api/x/pithagoras-files/chats/<chat>/sources/<source>/<files|file>
    const parts = url.pathname.split('/');
    const id = parts[7];
    const what = parts[8] as 'files' | 'file';
    const at = url.searchParams.get('path') ?? '';
    asked.push(`${id} ${route.request().method()} ${what} ${at}`);
    if (answer[id]) return answer[id](route, what);
    if (route.request().method() === 'PUT') {
      const body = JSON.parse(route.request().postData() ?? '{}');
      saved.push({ source: id, path: at, body });
      return route.fulfill({ json: { ok: true, size: body.content.length, mtime: 99 } });
    }
    if (what === 'files') return route.fulfill({ json: { path: at, entries: trees[id]?.[at] ?? [], truncated: false } });
    const file = texts[id]?.[at];
    if (!file) return route.fulfill({ status: 404, json: { error: 'There is no such file', code: 'missing' } });
    return route.fulfill({ json: file.binary ? { binary: true, size: 4, mtime: file.mtime } : { binary: false, content: file.content, size: file.content!.length, mtime: file.mtime } });
  });
  await page.addInitScript(() => Object.defineProperty(document, 'visibilityState', { get: () => 'hidden' }));
  await page.setViewportSize({ width: 1300, height: 800 });
  await page.goto('/tests/chat.html?phase=switch');
  await page.getByRole('button', { name: 'Files', exact: true }).click();
  await expect(page.getByRole('button', { name: /^work\.txt/ })).toBeVisible();
  return { asked, saved };
}

const tab = (page: Page, name: string) => page.getByRole('tab', { name });
const hold = () => {
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  return { held, release };
};

test('without a source there is only the chat folder: no tabs, and nothing else changes', async ({ page }) => {
  await open(page);
  await expect(page.getByRole('tablist')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'New file', exact: true })).toBeVisible();
});

test('a source whose list cannot be had leaves no tabs and no error over the chat folder', async ({ page }) => {
  await open(page, { sourcesList: (route) => route.fulfill({ status: 500, json: { error: 'boom' } }) });
  await expect(page.getByRole('tablist')).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('a source is a second root beside the chat folder, read-only without write, and its file opens in the same view', async ({ page }) => {
  const { asked } = await open(page, { sources: [nextcloud, notes] });
  await expect(page.getByRole('tablist', { name: 'What to look at' })).toBeVisible();
  await expect(tab(page, 'Nextcloud')).toHaveAttribute('aria-selected', 'false');
  await expect(page.getByRole('tab', { selected: true })).toHaveCount(1);
  await tab(page, 'Nextcloud').click();
  await expect(tab(page, 'Nextcloud')).toHaveAttribute('aria-selected', 'true');
  // Its own tree: not the chat folder's work.txt.
  await expect(page.getByRole('button', { name: /^todo\.md/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Photos$/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /^work\.txt/ })).toHaveCount(0);
  // Nothing of the chat folder's is on offer: no making, uploading, renaming or deleting, no archive, no path.
  for (const name of ['New file', 'New folder', 'Upload files', 'Upload a folder', 'Download this folder', 'Show the full path']) await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Download this folder' })).toHaveCount(0);
  await page.getByRole('button', { name: /^todo\.md/ }).hover();
  await expect(page.getByRole('button', { name: 'Rename todo.md' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Delete todo.md' })).toHaveCount(0);
  // The download is the source's route.
  await expect(page.getByRole('link', { name: 'Download todo.md' })).toHaveAttribute('href', /\/sources\/cloud\/file\?path=todo\.md&download=1$/);
  // A folder in it, and back by the path at the top.
  await page.getByRole('button', { name: /^Photos$/ }).click();
  await expect(page.getByRole('button', { name: /^beach\.txt/ })).toBeVisible();
  await page.getByRole('navigation', { name: 'Folder' }).getByRole('button', { name: 'Nextcloud' }).click();
  // The file view: read-only.
  await page.getByRole('button', { name: /^todo\.md/ }).click();
  await expect(page.getByRole('region', { name: 'Rendered todo.md' })).toBeVisible();
  await page.getByRole('button', { name: 'Show the source' }).click();
  const box = page.getByRole('textbox', { name: 'Contents of todo.md' });
  await expect(box).toHaveValue('# Todo\n');
  await expect(box).not.toBeEditable();
  await expect(page.getByText('Read-only', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Download this file' })).toHaveAttribute('href', /\/sources\/cloud\/file\?path=todo\.md&download=1$/);
  // A file that is not text gets the note.
  await page.getByRole('button', { name: 'Back to the folder' }).click();
  await page.getByRole('button', { name: /^scan\.pdf/ }).click();
  await expect(page.getByText('Not text, or too large to show. Download it to open it.')).toBeVisible();
  // Each tree is asked its own paths only: a source path never went to the chat folder, nor the other way round.
  expect(asked.filter((a) => a.startsWith('folder')).every((a) => !/Photos|todo|scan/.test(a))).toBe(true);
});

test('the chat folder stays what it was beside a source: its controls, its files, and the agent is not followed into the source', async ({ page }) => {
  const { asked } = await open(page, { sources: [nextcloud] });
  await tab(page, 'Nextcloud').click();
  await expect(page.getByRole('button', { name: /^todo\.md/ })).toBeVisible();
  // The agent reads a file of the chat folder while a source is shown: the source stays, its paths are not the agent's.
  await page.evaluate(() => {
    const emit = (window as any).emit;
    emit('tool_execution_start', { toolCallId: 'c1', toolName: 'read', args: { path: 'work.txt' } });
    emit('tool_execution_end', { toolCallId: 'c1', toolName: 'read', result: { content: [{ type: 'text', text: 'work' }] } });
  });
  await page.waitForTimeout(300);
  await expect(tab(page, 'Nextcloud')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('button', { name: /^todo\.md/ })).toBeVisible();
  expect(asked.filter((a) => a.startsWith('folder read'))).toEqual([]);
  // Back to the folder: everything is there again.
  await page.getByRole('tab', { name: /^(?!Nextcloud)/ }).first().click();
  await expect(page.getByRole('button', { name: /^work\.txt/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'New file', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Upload a folder', exact: true })).toBeVisible();
});

test('a source with write can be edited and saved, with the time it was read at', async ({ page }) => {
  const { saved } = await open(page, { sources: [nextcloud, notes] });
  await tab(page, 'Notes').click();
  await page.getByRole('button', { name: /^idea\.txt/ }).click();
  const box = page.getByRole('textbox', { name: 'Contents of idea.txt' });
  await expect(box).toBeEditable();
  await expect(page.getByText('Read-only', { exact: true })).toHaveCount(0);
  await box.fill('better idea');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  expect(saved).toEqual([{ source: 'notes', path: 'idea.txt', body: { content: 'better idea', mtime: 3 } }]);
});

test('a source that fails says so in its own root, and the chat folder is untouched and usable', async ({ page }) => {
  await open(page, {
    sources: [nextcloud, { id: 'down', label: 'Broken', writable: false }],
    answer: { down: (route) => route.fulfill({ status: 502, json: { error: 'Broken: connection refused', code: 'source' } }) },
  });
  await tab(page, 'Broken').click();
  await expect(page.getByRole('alert')).toContainText('Broken: connection refused');
  // The other source and the chat folder are not affected.
  await tab(page, 'Nextcloud').click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^todo\.md/ })).toBeVisible();
  await page.getByRole('tab', { name: /^(?!Nextcloud|Broken)/ }).first().click();
  await expect(page.getByRole('button', { name: /^work\.txt/ })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.getByRole('button', { name: /^work\.txt/ }).click();
  await expect(page.getByRole('textbox', { name: 'Contents of work.txt' })).toHaveValue('work');
});

test('a slow source shows loading in its own root only, and its late answer does not replace the chat folder', async ({ page }) => {
  const { held, release } = hold();
  await open(page, {
    sources: [nextcloud, { id: 'slow', label: 'Slow cloud', writable: false }],
    answer: {
      slow: async (route) => {
        await held;
        await route.fulfill({ json: { path: '', entries: [{ name: 'late.txt', type: 'file', size: 1, mtime: 1 }], truncated: false } }).catch(() => {});
      },
    },
  });
  await tab(page, 'Slow cloud').click();
  await expect(page.getByText('Loading…')).toBeVisible();
  // The folder is one click away, and shows at once.
  await page.getByRole('tab', { name: /^(?!Nextcloud|Slow cloud)/ }).first().click();
  await expect(page.getByRole('button', { name: /^work\.txt/ })).toBeVisible();
  await expect(page.getByText('Loading…')).toHaveCount(0);
  release();
  await page.waitForTimeout(300);
  // The answer for the other root is not drawn here.
  await expect(page.getByRole('button', { name: /^late\.txt/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^work\.txt/ })).toBeVisible();
});

test('files dropped on a source are not uploaded, and the browser is not left to open them', async ({ page }) => {
  const uploads: string[] = [];
  await page.route('**/api/sessions/*/upload*', (route) => (uploads.push(route.request().url()), route.fulfill({ json: { path: 'x', size: 1 } })));
  await open(page, { sources: [nextcloud] });
  await tab(page, 'Nextcloud').click();
  await expect(page.getByRole('button', { name: /^todo\.md/ })).toBeVisible();
  const prevented = await page.getByTestId('files-list').evaluate((list) => {
    const dt = new DataTransfer();
    dt.items.add(new File(['x'], 'dropped.txt'));
    const event = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt });
    list.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(prevented).toBe(true);
  await page.waitForTimeout(200);
  expect(uploads).toEqual([]);
});
