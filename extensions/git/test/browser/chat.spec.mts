import { test, expect } from '../../../../tests/browser/portal-mock';

// Git, Files to open a file in, and a third panel to open beside them: the portal's tests' stand-in.
test.use({ installed: ['extensions/git', 'extensions/files', 'tests/fixtures/extensions/console'] });

test.beforeEach(async ({ page }) => {
  // Git's routes for the chat: a repository with a file changed and one new, and no gh.
  await page.route('**/api/x/pithagoras-git/chats/*/gh*', (route) => route.fulfill({ json: { installed: false, authed: false, repo: null, url: null, defaultBranch: null, note: 'Install gh' } }));
  await page.route(/\/api\/x\/pithagoras-git\/chats\/[^/?]+(\?.*)?$/, (route) =>
    route.fulfill({ json: { repo: true, root: '/workspaces/pithagoras', prefix: '', branch: 'main', head: 'a'.repeat(40), upstream: 'origin/main', ahead: 0, behind: 0, stashes: 0, operation: null, truncated: false, remotes: [], files: [{ path: 'README.md', x: '.', y: 'M', kind: 'changed', unstaged: { added: 2, removed: 1, binary: false } }, { path: 'notes.txt', x: '?', y: '?', kind: 'untracked' }] } }),
  );
  // A file opened from Git is looked at as its source (markdown opens as a page unless the source was chosen).
  await page.addInitScript(() => {
    if (localStorage.getItem('filesMarkdownRendered') === null) localStorage.setItem('filesMarkdownRendered', '0');
  });
  await page.setViewportSize({ width: 1300, height: 800 });
  await page.goto('/tests/chat.html?phase=files');
});

test('Git is a panel of its own beside the chat, with its tabs in its header, and a file opens from it in Files', async ({ page }) => {
  await page.getByRole('button', { name: 'Git', exact: true }).click();
  const panels = page.getByRole('complementary', { name: 'Panels' });
  const tabs = panels.getByRole('tablist', { name: 'Git' });
  await expect(tabs.getByRole('tab')).toHaveText(['Changes2', 'History', 'Branches', 'Pull requests']);
  await expect(panels.getByText('notes.txt')).toBeVisible();

  await panels.getByRole('button', { name: 'Open README.md in Files' }).click();
  // Files opens beside it, on that file.
  await expect(panels.getByRole('textbox', { name: 'Contents of README.md' })).toHaveValue('# Pithagoras\n');
  await expect(tabs).toBeVisible();
  // Asked once: Files closed and opened again shows the folder, not the file again.
  await panels.getByRole('button', { name: 'Close Files' }).click();
  await page.getByRole('button', { name: 'Files', exact: true }).click();
  await expect(panels.getByRole('button', { name: /README\.md/ }).first()).toBeVisible();
  await expect(panels.getByRole('textbox', { name: 'Contents of README.md' })).toHaveCount(0);

  await tabs.getByRole('tab', { name: 'Pull requests' }).click();
  await expect(panels.getByText('Install gh')).toBeVisible();
  await panels.getByRole('button', { name: 'Close Git' }).click();
  await expect(tabs).toHaveCount(0);
});

test('a file opened in Files from Git leaves Git open: the other panel makes room', async ({ page }) => {
  await page.getByRole('button', { name: 'Git', exact: true }).click();
  await page.getByRole('button', { name: 'Console', exact: true }).click();
  const panels = page.getByRole('complementary', { name: 'Panels' });
  await expect(panels.getByRole('tablist', { name: 'Consoles' })).toBeVisible();
  await panels.getByRole('button', { name: 'Open README.md in Files' }).click();
  await expect(panels.getByRole('textbox', { name: 'Contents of README.md' })).toBeVisible();
  await expect(panels.getByRole('tablist', { name: 'Git' })).toBeVisible();
  await expect(panels.getByRole('tablist', { name: 'Consoles' })).toHaveCount(0);
});

test('an edit not saved in Files outweighs keeping Git open: a third panel closes Git, not the edit', async ({ page }) => {
  await page.getByRole('button', { name: 'Files', exact: true }).click();
  await page.getByRole('button', { name: 'Git', exact: true }).click();
  const panels = page.getByRole('complementary', { name: 'Panels' });
  await panels.getByRole('button', { name: 'Open README.md in Files' }).click();
  const text = panels.getByRole('textbox', { name: 'Contents of README.md' });
  await text.fill('# Pithagoras\nnot saved yet\n');
  await page.getByRole('button', { name: 'Console', exact: true }).click();
  await expect(text).toHaveValue('# Pithagoras\nnot saved yet\n');
  await expect(panels.getByRole('tablist', { name: 'Git' })).toHaveCount(0);
  await expect(panels.getByRole('tablist', { name: 'Consoles' })).toBeVisible();
});

test.describe('without Files', () => {
  // Files is an extension of its own, which may be switched off or removed.
  test.use({ installed: ['extensions/git'] });

  test('Git offers no way to open a file in Files', async ({ page }) => {
    await page.getByRole('button', { name: 'Git', exact: true }).click();
    const panels = page.getByRole('complementary', { name: 'Panels' });
    await expect(panels.getByText('notes.txt')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Files', exact: true })).toHaveCount(0);
    await expect(panels.getByRole('button', { name: /in Files/ })).toHaveCount(0);
  });
});
