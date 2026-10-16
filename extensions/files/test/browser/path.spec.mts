import { test, expect } from '../../../../tests/browser/portal-mock';

// Files, as a portal that ships it has it.
test.use({ installed: ['extensions/files'] });

test("a chat's full path is not drawn under its title, and the Files panel shows it on request", async ({ page }) => {
  await page.route('**/api/x/pithagoras-files/chats/*/files*', (route) =>
    route.fulfill({ json: { path: '', entries: [{ name: 'notes.md', type: 'file', size: 4, mtime: 1 }], truncated: false } }),
  );
  await page.setViewportSize({ width: 1300, height: 800 });
  await page.goto('/tests/chat.html?phase=switch');
  await expect(page.locator('header .chat-title')).toBeVisible();
  // The chat's header does not carry the path. (The sidebar is mounted only by the full app: hidden-paths.spec and mobile.spec check it.)
  await expect(page.getByText('/workspaces/pithagoras', { exact: true })).toHaveCount(0);

  await page.getByRole('button', { name: 'Files', exact: true }).click();
  await expect(page.getByRole('button', { name: 'notes.md 4 B' })).toBeVisible();
  await expect(page.getByTestId('files-full-path')).toHaveCount(0);

  const toggle = page.getByRole('button', { name: 'Show the full path', exact: true });
  await toggle.click();
  await expect(page.getByTestId('files-full-path')).toHaveText('/workspaces/pithagoras');
  await expect(page.getByRole('button', { name: 'Hide the full path', exact: true })).toHaveAttribute('aria-pressed', 'true');

  await page.getByRole('button', { name: 'Hide the full path', exact: true }).click();
  await expect(page.getByTestId('files-full-path')).toHaveCount(0);
});
