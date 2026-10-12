import { type Page } from '@playwright/test';
import { test, expect, mockPortal } from './portal-mock';

/**
 * The video tools in the tool lists. The portal registers generate_video and show_video from two extensions of its
 * own, so two labels reach the page; every list with groups shows them in one box, called Videos, apart from the
 * Images box. An extension's tool of one of those names stays with its extension.
 */
const videos = [
  { name: 'generate_video', source: 'video-generation', inline: true },
  { name: 'show_video', source: 'videos', inline: true },
];
const pictures = [{ name: 'show_image', source: 'pictures', inline: true }];
const others = [{ name: 'web_search', source: 'pi-web-access' }];

/** The portal with no server: Settings → Tools and a project's Tools, over canned answers. */
async function portal(page: Page, { extension = false, path = '/settings/tools' } = {}) {
  const puts: string[][] = [];
  const seen = [...videos.filter((tool) => !(extension && tool.name === 'generate_video')), ...(extension ? [{ name: 'generate_video', source: 'my-videos' }] : []), ...pictures, ...others];
  await mockPortal(page, async ({ path: p, method, json }) => {
    if (p === '/api/projects') return { root: '/w', home: '/h', projects: [{ name: 'demo', path: '/w/demo', isGit: false, hasInstructions: false, hasTools: false, sessions: 0, lastActive: null }] };
    if (p === '/api/tools' && method === 'GET') return { tools: seen.map((tool) => ({ ...tool, defaultOn: true })), off: [], names: {} };
    if (p === '/api/tools' && method === 'PUT') {
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

const box = (page: Page, name: RegExp) => page.getByRole('button', { name, expanded: false }).or(page.getByRole('button', { name, expanded: true }));

test('Settings → Tools shows the two video tools in one box called Videos, apart from the picture tools', async ({ page }) => {
  const { puts } = await portal(page);
  await expect(page.getByRole('button', { name: /^pi-web-access/ })).toBeVisible();
  const group = box(page, /^Videos/);
  await expect(group).toHaveCount(1);
  await expect(group).toContainText('2 on');
  await expect(box(page, /^Images/)).toContainText('1 on');
  // Not a box of their own, whichever extension registered each.
  for (const label of ['video-generation', 'videos']) await expect(page.getByText(label, { exact: true })).toHaveCount(0);
  await group.click();
  for (const name of ['generate_video', 'show_video']) await expect(page.getByRole('checkbox', { name })).toBeVisible();
  // The box's switch takes both along.
  await group.locator('xpath=..').getByRole('button', { name: 'all off' }).click();
  await expect.poll(() => puts.at(-1)?.length).toBeGreaterThan(0);
  expect([...puts.at(-1)!].sort()).toEqual(['generate_video', 'show_video']);
});

test("an extension's generate_video stays in its own box, and Videos keeps the portal's other one", async ({ page }) => {
  await portal(page, { extension: true });
  const group = box(page, /^Videos/);
  await expect(group).toContainText('1 on');
  await expect(box(page, /^my-videos/)).toContainText('1 on');
  await group.click();
  await expect(page.getByRole('checkbox', { name: 'show_video' })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: 'generate_video' })).toBeHidden();
  await box(page, /^my-videos/).click();
  await expect(page.getByRole('checkbox', { name: 'generate_video' })).toBeVisible();
});

test('Projects → Tools shows them in the same one box', async ({ page }) => {
  await portal(page, { path: '/projects' });
  await page.getByRole('button', { name: 'Tools for demo' }).click();
  const dialog = page.getByRole('dialog');
  const group = dialog.getByRole('button', { name: /^Videos/ });
  await expect(group).toHaveCount(1);
  await expect(group).toContainText('2 on');
  for (const label of ['video-generation', 'videos']) await expect(dialog.getByText(label, { exact: true })).toHaveCount(0);
});
