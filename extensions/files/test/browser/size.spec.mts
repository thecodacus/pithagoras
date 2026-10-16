import { test, expect } from '../../../../tests/browser/portal-mock';

// Files, as a portal that ships it has it.
test.use({ installed: ['extensions/files'] });

/** A file's size reads in the unit it is nearest, up to gigabytes: the same words as the project pages use. */
test('the size of a file in Files goes up to gigabytes', async ({ page }) => {
  await page.route('**/api/x/pithagoras-files/chats/preview/files**', (route) =>
    route.fulfill({
      json: {
        path: '',
        entries: [
          { name: 'tiny.txt', type: 'file', size: 700, mtime: 1 },
          { name: 'small.txt', type: 'file', size: 1536, mtime: 1 },
          { name: 'medium.bin', type: 'file', size: 5 * 1024 ** 2, mtime: 1 },
          { name: 'big.iso', type: 'file', size: 3 * 1024 ** 3, mtime: 1 },
        ],
        truncated: false,
      },
    }),
  );
  await page.setViewportSize({ width: 1300, height: 800 });
  await page.goto('/tests/chat.html?phase=tools');
  await page.getByRole('button', { name: 'Files', exact: true }).click();
  const row = (name: string) => page.getByRole('button', { name: new RegExp(`^${name}`) });
  await expect(row('tiny.txt')).toContainText('700 B');
  await expect(row('small.txt')).toContainText('1.5 KB');
  await expect(row('medium.bin')).toContainText('5.0 MB');
  await expect(row('big.iso')).toContainText('3.0 GB');
});
