import { test, expect } from './portal-mock';

test.beforeEach(async ({ page }) => {
  // A file opened from Git is looked at as its source (markdown opens as a page unless the source was chosen).
  await page.addInitScript(() => {
    if (localStorage.getItem('filesMarkdownRendered') === null) localStorage.setItem('filesMarkdownRendered', '0');
  });
  await page.setViewportSize({ width: 1300, height: 800 });
  await page.goto('/tests/chat.html?phase=git');
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
  await panels.getByRole('button', { name: 'Close the files' }).click();
  await page.getByRole('button', { name: 'Files', exact: true }).click();
  await expect(panels.getByRole('button', { name: /README\.md/ }).first()).toBeVisible();
  await expect(panels.getByRole('textbox', { name: 'Contents of README.md' })).toHaveCount(0);

  await tabs.getByRole('tab', { name: 'Pull requests' }).click();
  await expect(panels.getByText('Install gh')).toBeVisible();
  await panels.getByRole('button', { name: 'Close the git panel' }).click();
  await expect(tabs).toHaveCount(0);
});

test('before the first message the tools are listed and can be switched for this chat alone', async ({ page }) => {
  await page.getByRole('button', { name: 'Which tools this conversation may use' }).click();
  const menu = page.locator('.composer-menu');
  await expect(menu.getByText('Not started yet')).toBeVisible();
  await expect(menu.getByText('the defaults stay as they are')).toBeVisible();
  await expect(menu.getByText('Send a message first')).toHaveCount(0);
  await menu.getByRole('button', { name: /pi-web-access/ }).click();
  await menu.getByRole('checkbox', { name: 'web_search' }).uncheck();
  await expect.poll(() => page.evaluate(() => (window as any).sentTools)).toEqual([['web_search']]);
  await expect(menu.getByRole('checkbox', { name: 'web_search' })).not.toBeChecked();
  await expect(menu.getByText('default on')).toBeVisible();
});

test('a file opened in Files from Git leaves Git open: the other panel makes room', async ({ page }) => {
  await page.getByRole('button', { name: 'Git', exact: true }).click();
  await page.getByRole('button', { name: 'Terminal', exact: true }).click();
  const panels = page.getByRole('complementary', { name: 'Panels' });
  await expect(panels.getByRole('tablist', { name: 'Terminals' })).toBeVisible();
  await panels.getByRole('button', { name: 'Open README.md in Files' }).click();
  await expect(panels.getByRole('textbox', { name: 'Contents of README.md' })).toBeVisible();
  await expect(panels.getByRole('tablist', { name: 'Git' })).toBeVisible();
  await expect(panels.getByRole('tablist', { name: 'Terminals' })).toHaveCount(0);
});

test('an edit not saved in Files outweighs keeping Git open: a third panel closes Git, not the edit', async ({ page }) => {
  await page.getByRole('button', { name: 'Files', exact: true }).click();
  await page.getByRole('button', { name: 'Git', exact: true }).click();
  const panels = page.getByRole('complementary', { name: 'Panels' });
  await panels.getByRole('button', { name: 'Open README.md in Files' }).click();
  const text = panels.getByRole('textbox', { name: 'Contents of README.md' });
  await text.fill('# Pithagoras\nnot saved yet\n');
  await page.getByRole('button', { name: 'Terminal', exact: true }).click();
  await expect(text).toHaveValue('# Pithagoras\nnot saved yet\n');
  await expect(panels.getByRole('tablist', { name: 'Git' })).toHaveCount(0);
  await expect(panels.getByRole('tablist', { name: 'Terminals' })).toBeVisible();
});
