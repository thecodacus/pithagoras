import { test, expect, mockPortal, listeningTo, pushed } from '../../../../tests/browser/portal-mock';

// Files, as a portal that ships it has it.
test.use({ installed: ['extensions/files'] });

const NAME = 'pithagoras-files';

/**
 * The folder on screen is listened to on the portal's pushes stream (the page's own EventSource, which the test drives by hand,
 * as the server half's watch would): a push to its topic is a look at the folder again, whatever changed it.
 */
async function open(page: import('@playwright/test').Page, dirs: Record<string, { name: string; type: 'file' | 'dir' }[]>) {
  const listed: string[] = [];
  const listing = (dir: string) => ({ path: dir, entries: (dirs[dir] ?? []).map((e) => ({ ...e, size: 4, mtime: 1 })), truncated: false });
  await mockPortal(page, ({ path, url }) => {
    if (/^\/api\/x\/pithagoras-files\/chats\/[^/]+\/files$/.test(path)) {
      const dir = url.searchParams.get('path') ?? '';
      listed.push(dir);
      return listing(dir);
    }
  }, { streams: 'open' });
  await page.setViewportSize({ width: 1300, height: 800 });
  await page.goto('/tests/chat.html?phase=switch');
  await page.getByRole('button', { name: 'Files', exact: true }).click();
  return listed;
}

test('a change to the folder on screen, from anything, makes the list look at the folder again, and a folder opened is listened to in its turn', async ({ page }) => {
  const dirs: Record<string, { name: string; type: 'file' | 'dir' }[]> = { '': [{ name: 'src', type: 'dir' }, { name: 'a.txt', type: 'file' }], src: [{ name: 'in-src.txt', type: 'file' }] };
  const listed = await open(page, dirs);
  await expect(page.getByRole('button', { name: /^a\.txt/ })).toBeVisible();
  // The folder is listened to by the topic the server half's watch is told by, on the chat the panel is for.
  await expect.poll(() => listeningTo(page).map(([, topic]) => topic)).toEqual([expect.stringMatching(/^dir\/[^/]+\/$/)]);
  const topic = listeningTo(page)[0][1];
  const asked = listed.length;
  // A file made by hand: the server half says so, and the list is asked for again and shows it.
  dirs[''].push({ name: 'by-hand.txt', type: 'file' });
  await pushed(page, NAME, topic, { changed: true });
  await expect(page.getByRole('button', { name: /^by-hand\.txt/ })).toBeVisible();
  expect(listed.length).toBeGreaterThan(asked);
  // Into a folder: that one is listened to, and the one left is not.
  await page.getByRole('button', { name: /^src/ }).click();
  await expect(page.getByRole('button', { name: /^in-src\.txt/ })).toBeVisible();
  await expect.poll(() => listeningTo(page).map(([, t]) => t)).toEqual([topic.replace(/\/$/, '/src')]);
  dirs.src.push({ name: 'also-by-hand.txt', type: 'file' });
  // What is said of the folder left is not heard.
  await pushed(page, NAME, topic, { changed: true });
  const before = listed.length;
  await page.waitForTimeout(150);
  expect(listed.length).toBe(before);
  await pushed(page, NAME, topic.replace(/\/$/, '/src'), { changed: true });
  await expect(page.getByRole('button', { name: /^also-by-hand\.txt/ })).toBeVisible();
});
