import { test, expect } from '../../../../tests/browser/portal-mock';

// Files, as a portal that ships it has it.
test.use({ installed: ['extensions/files'] });

test.beforeEach(async ({ page }) => {
  await page.route('**/api/sessions/test/commands', route => route.fulfill({ json: { commands: [] } }));
  await page.route('**/api/sessions/test/config', route => route.fulfill({ status: 503, json: {} }));
  await page.route('**/api/voice', route => route.fulfill({ json: { enabled: true } }));
  await page.route('**/api/x/pithagoras-files/chats/test/files?**', route => route.fulfill({ json: { path: 'src', entries: [{ name: 'app.ts', type: 'file', size: 3, mtime: 1 }], truncated: false } }));
  await page.route('**/api/x/pithagoras-files/chats/test/file?**', route => route.fulfill({ json: { binary: false, size: 3, mtime: 1, content: 'abc' } }));
});

/** The window, open or minimized: hidden, it is kept, out of reach of a reader. */
const filesWindow = (page: import('@playwright/test').Page) => page.locator('.voice-extension-window[data-extension="pithagoras-files"]');

async function start(page: import('@playwright/test').Page) {
  await page.goto('/tests/voice.html');
  await page.getByRole('button', { name: 'Turn on hands-free voice' }).click();
  await expect(page.getByRole('button', { name: 'End voice mode' })).toBeVisible({ timeout: 25000 });
}

test('the agent changing a file brings the Files window up on it, and the card of the call opens it there again', async ({ page }) => {
  await start(page);
  await page.getByRole('button', { name: 'Edit file' }).click();
  const window = filesWindow(page);
  await expect(window).toHaveClass(/is-open/);
  await expect(window.getByLabel('Contents of src/app.ts')).toHaveValue('abc');
  await window.getByRole('button', { name: 'Minimize Files' }).click();
  await expect(window).not.toHaveClass(/is-open/);
  const edit = page.getByRole('button', { name: /Editing app\.ts/ });
  await expect(edit).toHaveAttribute('title', 'Show Files');
  await edit.click();
  await expect(window).toHaveClass(/is-open/);
  await expect(window.getByLabel('Contents of src/app.ts')).toHaveValue('abc');
});

test('F shows and hides the Files window', async ({ page }) => {
  await start(page);
  const window = filesWindow(page);
  await expect(page.getByRole('button', { name: 'Show Files' })).toBeVisible();
  await page.keyboard.press('f');
  await expect(window).toHaveClass(/is-open/);
  await page.keyboard.press('f');
  await expect(window).not.toHaveClass(/is-open/);
});

test('the Files window of voice mode leaves the edit of the chat\'s own Files panel where it is', async ({ page }) => {
  await page.goto('/tests/voice.html');
  // An edit in the chat's Files panel that is not saved.
  await page.getByRole('button', { name: 'Files', exact: true }).click();
  await page.getByRole('button', { name: /^app\.ts/ }).click();
  await page.getByLabel('Contents of app.ts').fill('edited by hand');
  const kept = () => page.evaluate(() => sessionStorage.getItem('pithagoras.file-draft.test') ?? '');
  await expect.poll(kept).toContain('edited by hand');
  await page.getByRole('button', { name: 'Turn on hands-free voice' }).click();
  await expect(page.getByRole('button', { name: 'End voice mode' })).toBeVisible({ timeout: 25000 });
  // The voice stage's own window opens on the folder, ready to show what the agent does, not on a half-made edit of the other.
  await page.getByRole('button', { name: 'Show Files' }).click();
  const window = page.locator('.voice-files-window', { has: page.getByRole('button', { name: 'Minimize Files' }) });
  await expect(window.getByRole('button', { name: /^app\.ts/ })).toBeVisible();
  await expect(window.getByLabel('Contents of app.ts')).toHaveCount(0);
  await expect(window.getByRole('button', { name: 'Following' })).toBeVisible();
  // Clicking Following again lets go, and Follow takes it up again.
  await window.getByRole('button', { name: 'Following' }).click();
  await expect(window.getByRole('button', { name: 'Follow', exact: true })).toBeVisible();
  await window.getByRole('button', { name: 'Follow', exact: true }).click();
  await expect(window.getByRole('button', { name: 'Following' })).toBeVisible();
  // And it did not take the chat's edit with it when it came: that is still kept, for a reload.
  expect(await kept()).toContain('edited by hand');
  await page.getByRole('button', { name: 'End voice mode' }).click();
  await expect(page.getByLabel('Contents of app.ts')).toHaveValue('edited by hand');
});
