import { type Page } from '@playwright/test';
import { test, expect, mockPortal } from '../../../../tests/browser/portal-mock';

test.use({ installed: ['extensions/media'] });

/**
 * The picture and video tools in the tool lists. The extension's server half registers show_image, generate_image,
 * edit_image, generate_video and show_video, which the portal files under its package's name as any server half's;
 * every list with groups shows them in one box, pithagoras-media. An extension's tool of one of those names stays
 * with its extension.
 */
const MEDIA = ['show_image', 'generate_image', 'edit_image', 'generate_video', 'show_video'].map((name) => ({ name, source: 'pithagoras-media', inline: true }));
const others = [{ name: 'web_search', source: 'pi-web-access' }, { name: 'todo', source: 'pi-todo' }];

/** The portal with no server: Settings → Tools and a project's Tools, over canned answers. */
async function portal(page: Page, { extension = '', path = '/settings/tools' } = {}) {
  const puts: string[][] = [];
  // An extension's tool of the extension's name: it replaces the extension's, which is not registered then.
  const seen = [...MEDIA.filter((tool) => tool.name !== extension), ...(extension ? [{ name: extension, source: `my-${extension}` }] : []), ...others];
  await mockPortal(page, async ({ path: p, method, json }) => {
    if (p === '/api/projects') return { root: '/w', home: '/h', projects: [{ name: 'demo', path: '/w/demo', isGit: false, hasInstructions: false, hasTools: false, sessions: 0, lastActive: null }] };
    if (p === '/api/tools' && method === 'GET') return { tools: seen.map((tool) => ({ ...tool, defaultOn: true })), off: [], names: {} };
    if (p === '/api/tools' && method === 'PUT') {
      const { off } = json();
      puts.push(off);
      return { off, applied: 0 };
    }
    if (p === '/api/projects/demo/tools' && method === 'PUT') {
      const { off } = json();
      puts.push(off);
      return { off, applied: 0 };
    }
    if (p === '/api/projects/demo/tools') return { live: false, off: [], names: {}, tools: seen.map((tool) => ({ ...tool, enabled: true, defaultOn: true })) };
  }, { settings: true });
  await page.addInitScript(() => localStorage.removeItem('toolGroupsOpen'));
  await page.goto(path);
  return { puts };
}

/** Every box of the list, by its heading, and what a box holds once opened. */
const box = (page: Page, name: RegExp) => page.getByRole('button', { name, expanded: false }).or(page.getByRole('button', { name, expanded: true }));

test("Settings → Tools shows the three picture tools and the two video tools in one box, the extension's", async ({ page }) => {
  const { puts } = await portal(page);
  await expect(page.getByRole('button', { name: /^pi-web-access/ })).toBeVisible();
  const media = box(page, /^pithagoras-media/);
  await expect(media).toHaveCount(1);
  await expect(media).toContainText('5 on');
  // No Images or Videos box beside it.
  await expect(box(page, /^Images/)).toHaveCount(0);
  await expect(box(page, /^Videos/)).toHaveCount(0);
  await media.click();
  for (const name of ['show_image', 'generate_image', 'edit_image', 'generate_video', 'show_video']) await expect(page.getByRole('checkbox', { name })).toBeVisible();
  // The box's switch takes all five along.
  await media.locator('xpath=..').getByRole('button', { name: 'all off' }).click();
  await expect.poll(() => puts.at(-1)?.length).toBeGreaterThan(0);
  expect([...puts.at(-1)!].sort()).toEqual(['edit_image', 'generate_image', 'generate_video', 'show_image', 'show_video']);
});

for (const name of ['generate_image', 'generate_video']) {
  test(`an extension's ${name} stays in its own box, and the Media extension's box keeps the other four`, async ({ page }) => {
    await portal(page, { extension: name });
    const media = box(page, /^pithagoras-media/);
    await expect(media).toContainText('4 on');
    await expect(box(page, new RegExp(`^my-${name}`))).toContainText('1 on');
    await media.click();
    for (const other of ['show_image', 'edit_image', 'generate_video', 'show_video'].filter((n) => n !== name)) await expect(page.getByRole('checkbox', { name: other })).toBeVisible();
    await expect(page.getByRole('checkbox', { name })).toBeHidden();
    await box(page, new RegExp(`^my-${name}`)).click();
    await expect(page.getByRole('checkbox', { name })).toBeVisible();
  });
}

test('Projects → Tools shows them in the same one box', async ({ page }) => {
  const { puts } = await portal(page, { path: '/projects' });
  await page.getByRole('button', { name: 'Tools for demo' }).click();
  const dialog = page.getByRole('dialog');
  const media = dialog.getByRole('button', { name: /^pithagoras-media/ });
  await expect(media).toHaveCount(1);
  await expect(media).toContainText('5 on');
  await media.click();
  await dialog.getByRole('checkbox', { name: 'show_image' }).uncheck();
  await expect.poll(() => puts).toEqual([['show_image']]);
  await expect(media).toContainText('1 of 5 off');
});

test("a chat's tools control shows them in the same one box", async ({ page }) => {
  // The chat of pictures.page.tsx, which has not been told its tools: the picture tools, as a chat reports them, beside others.
  const sent: string[][] = [];
  let off: string[] = [];
  await page.route('**/api/sessions/preview/tools', async (route) => {
    if (route.request().method() === 'PUT') {
      off = route.request().postDataJSON().off;
      sent.push(off);
      return route.fulfill({ json: { off } });
    }
    return route.fulfill({ json: { live: false, off, names: {}, tools: [
      { name: 'web_search', source: 'pi-web-access', description: 'Search the web', enabled: !off.includes('web_search'), defaultOn: true },
      { name: 'web_fetch', source: 'pi-web-access', enabled: !off.includes('web_fetch'), defaultOn: true },
      { name: 'bash', source: 'builtin', enabled: true, defaultOn: true },
      ...MEDIA.slice(0, 3).map((tool) => ({ ...tool, enabled: !off.includes(tool.name), defaultOn: true })),
    ] } });
  });
  await page.setViewportSize({ width: 1300, height: 800 });
  await page.goto('/tests/extension.html?page=media/pictures');
  await page.getByRole('button', { name: 'Which tools this conversation may use' }).click();
  const menu = page.locator('.composer-menu');
  const media = menu.getByRole('button', { name: /^pithagoras-media/ });
  await expect(media).toHaveCount(1);
  await expect(media).toContainText('3 on');
  await media.click();
  for (const name of ['show_image', 'generate_image', 'edit_image']) await expect(menu.getByRole('checkbox', { name })).toBeVisible();
  await menu.getByRole('checkbox', { name: 'show_image' }).uncheck();
  await expect.poll(() => sent).toEqual([['show_image']]);
  await expect(media).toContainText('1 of 3 off');
});

for (const scheme of ['light', 'dark'] as const) {
  test(`the extension's box fits a phone, ${scheme}`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await page.emulateMedia({ colorScheme: scheme });
    await portal(page);
    const media = box(page, /^pithagoras-media/);
    await media.click();
    await expect(page.getByRole('checkbox', { name: 'edit_image' })).toBeVisible();
    await expect(page.getByRole('checkbox', { name: 'generate_video' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  });
}
