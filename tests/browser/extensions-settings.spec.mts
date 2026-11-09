import { type Page } from '@playwright/test';
import { test, expect, mockPortal } from './portal-mock';

/**
 * Settings → Extensions in its two views: what is installed, narrowed by what a
 * package brings, and what there is to install. And the Settings dialog itself,
 * which takes the room a screen has. Over canned answers.
 */
const ext = (o: Record<string, unknown>) => ({ settings: [], enabled: true, scope: 'user', ...o });
const web = ext({ spec: 'npm:pi-web-access', name: 'pi-web-access', version: '1.4.2', kinds: ['pi'], description: 'Web search for pi.' });
const notes = ext({ spec: '/app/extensions/notes', name: 'pithagoras-notes', version: '0.2.0', kinds: ['pi', 'pithagoras'], description: 'Notes pinned to a chat.' });
const colours = ext({ spec: '/app/extensions/themes', name: 'pithagoras-themes', version: '0.1.0', kinds: ['themes'], description: 'More colours.' });
const shipped = [
  { name: 'pithagoras-notes', version: '0.2.0', kinds: ['pi', 'pithagoras'], spec: '/app/extensions/notes', description: 'Notes pinned to a chat.' },
  { name: 'pithagoras-themes', version: '0.1.0', kinds: ['themes'], spec: '/app/extensions/themes', description: 'More colours.' },
];
const long = 'A long description that runs over two lines at the width of a card, so that it is cut where the second line ends, and that says a good deal more than that before it is done: '.repeat(3).trim();
const official = [
  { name: '@pithagoras/office', description: 'Word and Excel documents.', kinds: ['pithagoras'], repository: 'prometheion/pithagoras-extensions', spec: 'npm:@pithagoras/office' },
  { name: '@pithagoras/blender', description: long, kinds: ['pithagoras'], repository: 'prometheion/pithagoras-extensions', spec: 'npm:@pithagoras/blender' },
  { name: '@pithagoras/flair-avatar', description: 'A 3D avatar for voice mode.', kinds: ['pithagoras'], repository: 'prometheion/pithagoras-flair', spec: 'npm:@pithagoras/flair-avatar' },
];
const catalog = [{ name: 'pi-subagents', version: '1.1.0', description: 'Helpers for pi.', keywords: ['pi-package'], provider: false }];

async function portal(page: Page, installed: unknown[]) {
  const posts: string[] = [];
  await mockPortal(page, ({ path, method, json }) => {
    if (path === '/api/extensions' && method === 'GET') return { settingsPath: '/a/settings.json', extensions: installed };
    if (path === '/api/extensions/shipped') return { extensions: shipped };
    if (path === '/api/extensions/official') return { extensions: official };
    if (path === '/api/packages/catalog') return { packages: catalog };
    if (path === '/api/packages' && method === 'POST') {
      const spec: string = json().spec;
      posts.push(spec);
      installed.push(spec.startsWith('npm:') ? ext({ spec, name: spec.slice(4), version: '1.0.0', kinds: ['pithagoras'] }) : colours);
      return { ok: true, output: '' };
    }
    return undefined;
  }, { settings: true });
  return posts;
}

const cards = (page: Page) => page.getByRole('tabpanel', { name: /Installed/ }).getByRole('listitem');
const chip = (page: Page, name: string | RegExp) => page.getByRole('group', { name: 'Show' }).getByRole('button', { name });

test('what is installed is narrowed by what it brings: something for pi, something for the portal, colours', async ({ page }) => {
  await portal(page, [web, notes, colours]);
  await page.goto('/settings/extensions');
  await expect(page.getByRole('tab', { name: /Installed/ })).toHaveAttribute('aria-selected', 'true');
  await expect(cards(page)).toHaveCount(3);
  // Each chip says how many it would leave.
  await expect(chip(page, /^All/)).toHaveText('All3');
  await expect(chip(page, /^pi/)).toHaveText('pi2');
  await expect(chip(page, /^Pithagoras/)).toHaveText('Pithagoras1');
  await expect(chip(page, /^Themes/)).toHaveText('Themes1');

  await chip(page, /^Pithagoras/).click();
  await expect(chip(page, /^Pithagoras/)).toHaveAttribute('aria-pressed', 'true');
  await expect(cards(page)).toHaveText([/pithagoras-notes/]);
  await chip(page, /^Themes/).click();
  await expect(cards(page)).toHaveText([/pithagoras-themes/]);
  await chip(page, /^pi/).click();
  await expect(cards(page)).toHaveText([/pi-web-access/, /pithagoras-notes/]);
  await chip(page, /^All/).click();
  await expect(cards(page)).toHaveCount(3);
  // A card says what its package brings, in the same words.
  await expect(cards(page).filter({ hasText: 'pithagoras-notes' })).toContainText('piPithagoras');
});

test('a kind nothing installed brings says so, in place of an empty list', async ({ page }) => {
  await portal(page, [web]);
  await page.goto('/settings/extensions');
  await chip(page, /^Themes/).click();
  await expect(page.getByText('Nothing installed brings colours for the portal.')).toBeVisible();
  await expect(cards(page)).toHaveCount(0);
});

test('the second view lists what can be installed: what comes with the portal, what is on npm, and anything by name', async ({ page }) => {
  const posts = await portal(page, [web, notes]);
  await page.goto('/settings/extensions');
  // Nothing of it is asked for before it is looked at.
  await expect(page.getByRole('textbox', { name: 'Install by name' })).toHaveCount(0);
  await page.getByRole('tab', { name: 'Discover' }).click();
  const view = page.getByRole('tabpanel', { name: 'Discover' });
  await expect(view.getByRole('textbox', { name: 'Install by name' })).toBeVisible();
  await expect(view.getByRole('textbox', { name: 'Search packages' })).toBeVisible();
  await expect(view.getByRole('button', { name: 'Install pi-subagents' })).toBeVisible();

  // What comes with the portal: one already installed says so, the other is installed from its folder with one click.
  const own = view.locator('[data-setting="Comes with Pithagoras"]');
  await expect(own.getByRole('listitem').filter({ hasText: 'pithagoras-notes' })).toContainText('Installed');
  await own.getByRole('button', { name: 'Install pithagoras-themes' }).click();
  await expect(own.getByRole('listitem').filter({ hasText: 'pithagoras-themes' })).toContainText('Installed');
  expect(posts).toEqual(['/app/extensions/themes']);

  // And it is among the installed, counted on the tab.
  await page.getByRole('tab', { name: /Installed/ }).click();
  await expect(page.getByRole('tab', { name: /Installed/ })).toHaveText('Installed3');
  await expect(cards(page)).toHaveCount(3);
});

test('the two views are tabs: the arrow keys go from one to the other', async ({ page }) => {
  await portal(page, [web]);
  await page.goto('/settings/extensions');
  await page.getByRole('tab', { name: /Installed/ }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'Discover' })).toBeFocused();
  await expect(page.getByRole('tabpanel', { name: 'Discover' })).toBeVisible();
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByRole('tabpanel', { name: /Installed/ })).toBeVisible();
});

test('with nothing installed the page says so and leads to what there is', async ({ page }) => {
  await portal(page, []);
  await page.goto('/settings/extensions');
  await expect(page.getByText('Nothing installed yet.')).toBeVisible();
  await page.getByRole('button', { name: 'See what there is' }).click();
  await expect(page.getByRole('tabpanel', { name: 'Discover' }).getByRole('textbox', { name: 'Install by name' })).toBeVisible();
});

test('a search of Settings opens the view its section is in', async ({ page }) => {
  await portal(page, [web]);
  await page.goto('/settings/general');
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await dialog.getByLabel('Search settings').fill('install a package');
  await dialog.getByRole('option', { name: /Install a package/ }).click();
  await expect(dialog.getByRole('tab', { name: 'Discover' })).toHaveAttribute('aria-selected', 'true');
  await expect(dialog.locator('[data-setting="Install by name"]')).toHaveClass(/setting-flash/);
  await expect(dialog.getByRole('textbox', { name: 'Install by name' })).toBeInViewport();

  await dialog.getByLabel('Search settings').fill('official extensions');
  await dialog.getByRole('option', { name: /Official extensions/ }).click();
  await expect(dialog.getByRole('tab', { name: 'Discover' })).toHaveAttribute('aria-selected', 'true');
  await expect(dialog.locator('[data-setting="Official extensions"]')).toHaveClass(/setting-flash/);

  await dialog.getByLabel('Search settings').fill('installed packages');
  await dialog.getByRole('option', { name: /Installed packages/ }).click();
  await expect(dialog.getByRole('tab', { name: /Installed/ })).toHaveAttribute('aria-selected', 'true');
  await expect(cards(page)).toHaveCount(1);
});

test("a package from an extension's folder says which, with its note", async ({ page }) => {
  const madeIt = ext({
    spec: '../../extension-data/test-maker/made/moon', name: 'moon', version: '0.1.0', kinds: ['pithagoras'],
    installedFrom: { extension: 'test-maker', note: 'Moon chat · extensions/moon', at: '2026-10-23T09:00:00Z' },
  });
  // A folder of the extension's that the person installed by path: from it, with no note and no time.
  const byHand = ext({ spec: '/data/extension-data/test-maker/made/sun', name: 'sun', version: '0.1.0', kinds: ['pithagoras'], installedFrom: { extension: 'test-maker' } });
  await portal(page, [web, madeIt, byHand]);
  await page.goto('/settings/extensions');
  const moon = cards(page).filter({ hasText: 'moon' });
  await expect(moon.getByText('From test-maker', { exact: true })).toHaveAttribute('title', /2026/);
  await expect(moon.getByText('Moon chat · extensions/moon', { exact: true })).toBeVisible();
  const sun = cards(page).filter({ hasText: 'sun' });
  await expect(sun.getByText('From test-maker', { exact: true })).toBeVisible();
  await expect(sun.getByText('From test-maker', { exact: true })).not.toHaveAttribute('title');
  await expect(cards(page).filter({ hasText: 'pi-web-access' })).not.toContainText('From ');

  await page.evaluate(() => localStorage.setItem('pithagoras.language', 'de'));
  await page.reload();
  // The tab is "Installiert" now.
  await expect(page.getByRole('listitem').filter({ hasText: 'moon' }).getByText('Von test-maker', { exact: true })).toBeVisible();
});

const box = async (page: Page, of: ReturnType<Page['locator']>) => (await of.boundingBox())!;
/** Whether the second of two cards is beside the first, once the page has come to rest at its new size. */
const beside = (page: Page, a: number, b: number) =>
  expect.poll(async () => {
    const [first, second] = [await box(page, cards(page).nth(a)), await box(page, cards(page).nth(b))];
    return Math.abs(second.y - first.y) < 1 && second.x >= first.x + first.width;
  });

test('a list of another page stands two abreast where there is room, as the packages do', async ({ page }) => {
  const person = (key: string, name: string) => ({ key, name, role: 'colleague', notes: '', first_seen: '', last_seen: null, announced_at: null, renamed: 0 });
  await mockPortal(page, ({ path }) => {
    if (path === '/api/people') return { people: [person('tg:a', 'Asha'), person('tg:b', 'Ben'), person('tg:c', 'Chen')] };
    if (path === '/api/tool-rules') return { rules: [] };
    return undefined;
  }, { settings: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/settings/people');
  const row = (name: string) => page.getByRole('dialog', { name: 'Settings' }).getByRole('button', { name: new RegExp(name) });
  await expect(row('Chen')).toBeVisible();
  await expect.poll(async () => Math.abs((await box(page, row('Ben'))).y - (await box(page, row('Asha'))).y)).toBeLessThan(1);
  expect((await box(page, row('Chen'))).y).toBeGreaterThan((await box(page, row('Asha'))).y);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(async () => (await box(page, row('Ben'))).y).toBeGreaterThan((await box(page, row('Asha'))).y);
});

test('Settings takes the room a screen has: nearly all of a laptop, most of a wide one, and a phone as before', async ({ page }) => {
  await portal(page, [web, notes, colours]);
  const dialog = page.getByRole('dialog', { name: 'Settings' });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/settings/extensions');
  await expect(cards(page)).toHaveCount(3);
  let size = await box(page, dialog);
  expect(size.width).toBeGreaterThan(1380);
  expect(size.height).toBeGreaterThan(800);
  // Room for two packages side by side.
  await beside(page, 0, 1).toBe(true);
  await beside(page, 1, 2).toBe(false);

  await page.setViewportSize({ width: 2560, height: 1440 });
  size = await box(page, dialog);
  expect(size.width).toBeGreaterThan(1900);
  expect(size.width).toBeLessThan(2000);
  expect(size.height).toBeGreaterThan(1300);
  // And for three.
  await beside(page, 1, 2).toBe(true);

  // Every page takes the width, not only this one: on a screen this wide a form's sections stand two abreast.
  await page.goto('/settings/general');
  await expect(dialog.getByLabel('Default model')).toBeVisible();
  const whole = (await box(page, dialog.locator('.settings-page'))).width;
  expect(whole).toBeGreaterThan(1500);
  const section = (name: string) => dialog.locator(`[data-setting="${name}"]`);
  await expect.poll(async () => Math.abs((await box(page, section('Context'))).y - (await box(page, section('For new chats'))).y)).toBeLessThan(1);
  expect((await box(page, section('Context'))).x).toBeGreaterThan((await box(page, section('For new chats'))).x + 600);

  // On a laptop the same page is one column, the width of the dialog's page.
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect.poll(async () => (await box(page, section('Context'))).y).toBeGreaterThan((await box(page, section('For new chats'))).y + 50);
  expect((await box(page, section('For new chats'))).width).toBeGreaterThan(1050);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/settings/extensions');
  await expect(cards(page)).toHaveCount(3);
  size = await box(page, dialog);
  expect(size.width).toBeLessThanOrEqual(390);
  await beside(page, 0, 1).toBe(false);
});

test('the official extensions that do not come with the portal are listed between the shipped ones and the search, each with its repository', async ({ page }) => {
  const posts = await portal(page, [web, notes]);
  await page.goto('/settings/extensions');
  await page.getByRole('tab', { name: 'Discover' }).click();
  const view = page.getByRole('tabpanel', { name: 'Discover' });
  const headings = await view.getByRole('heading', { level: 3 }).allTextContents();
  expect(headings).toEqual(['Comes with Pithagoras', 'Official extensions', 'Find packages', 'Install by name']);

  const section = view.locator('[data-setting="Official extensions"]');
  await expect(section.getByRole('listitem')).toHaveCount(3);
  // The pill names the repository and links to it.
  const office = section.getByRole('listitem').filter({ hasText: '@pithagoras/office' });
  await expect(office.getByRole('link', { name: 'pithagoras-extensions' })).toHaveAttribute('href', 'https://github.com/prometheion/pithagoras-extensions');
  await expect(office).toContainText('Pithagoras');
  await expect(section.getByRole('listitem').filter({ hasText: 'flair-avatar' }).getByRole('link', { name: 'pithagoras-flair' })).toHaveAttribute('href', 'https://github.com/prometheion/pithagoras-flair');

  // Install goes through the install path every extension takes, by the package's npm name.
  await section.getByRole('button', { name: 'Install @pithagoras/office' }).click();
  await expect(office).toContainText('Installed');
  expect(posts).toEqual(['npm:@pithagoras/office']);
  await expect(section.getByRole('button', { name: 'Install @pithagoras/blender' })).toBeVisible();
});

test('an official extension that is installed already says so', async ({ page }) => {
  await portal(page, [web, ext({ spec: 'npm:@pithagoras/blender', name: '@pithagoras/blender', version: '0.1.1', kinds: ['pithagoras'] })]);
  await page.goto('/settings/extensions');
  await page.getByRole('tab', { name: 'Discover' }).click();
  const section = page.getByRole('tabpanel', { name: 'Discover' }).locator('[data-setting="Official extensions"]');
  await expect(section.getByRole('listitem').filter({ hasText: '@pithagoras/blender' })).toContainText('Installed');
  await expect(section.getByRole('button', { name: 'Install @pithagoras/blender' })).toHaveCount(0);
  await expect(section.getByRole('button', { name: 'Install @pithagoras/office' })).toBeVisible();
});

test('a description that is cut off opens with More and closes with Less, on every card of Discover', async ({ page }) => {
  await portal(page, [web]);
  await page.goto('/settings/extensions');
  await page.getByRole('tab', { name: 'Discover' }).click();
  const section = page.getByRole('tabpanel', { name: 'Discover' }).locator('[data-setting="Official extensions"]');
  const blender = section.getByRole('listitem').filter({ hasText: '@pithagoras/blender' });
  const text = blender.getByText(/^A long description/);
  const height = async () => (await text.boundingBox())!.height;
  // A short one is not cut, and has no button.
  await expect(section.getByRole('listitem').filter({ hasText: '@pithagoras/office' }).getByRole('button', { name: 'More' })).toHaveCount(0);

  await expect(blender.getByRole('button', { name: 'More' })).toHaveAttribute('aria-expanded', 'false');
  const cut = await height();
  await blender.getByRole('button', { name: 'More' }).click();
  await expect(blender.getByRole('button', { name: 'Less' })).toHaveAttribute('aria-expanded', 'true');
  expect(await height()).toBeGreaterThan(cut + 10);
  await blender.getByRole('button', { name: 'Less' }).click();
  await expect(blender.getByRole('button', { name: 'More' })).toBeVisible();
  expect(await height()).toBeLessThanOrEqual(cut);
});

test('a card of what comes with the portal, and one of the packages on npm, open their descriptions too', async ({ page }) => {
  shipped.push({ name: 'pithagoras-long', version: '1.0.0', kinds: ['pi'], spec: '/app/extensions/long', description: long });
  catalog.push({ name: 'pi-long', version: '1.0.0', description: long, keywords: ['pi-package'], provider: false });
  try {
    await portal(page, [web]);
    await page.goto('/settings/extensions');
    await page.getByRole('tab', { name: 'Discover' }).click();
    const view = page.getByRole('tabpanel', { name: 'Discover' });
    for (const name of ['pithagoras-long', 'pi-long']) {
      const card = view.getByRole('listitem').filter({ hasText: name });
      await card.getByRole('button', { name: 'More' }).click();
      await expect(card.getByRole('button', { name: 'Less' })).toBeVisible();
    }
  } finally {
    shipped.pop();
    catalog.pop();
  }
});

test('an installed extension opens its cut-off description too', async ({ page }) => {
  await portal(page, [ext({ spec: '/app/extensions/long', name: 'pithagoras-long', version: '1.0.0', kinds: ['pithagoras'], description: long })]);
  await page.goto('/settings/extensions');
  const card = page.getByRole('tabpanel', { name: 'Installed' }).getByRole('listitem').filter({ hasText: 'pithagoras-long' });
  await card.getByRole('button', { name: 'More' }).click();
  await expect(card.getByRole('button', { name: 'Less' })).toBeVisible();
});
