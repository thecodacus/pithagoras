import { type Page } from '@playwright/test';
import { test, expect, mockPortal } from '../../../../tests/browser/portal-mock';

test.use({ installed: ['extensions/media'] });

/** Media's page in Settings: one page for the image model and the video model, over a portal where neither is set up unless the test says. */
async function portal(page: Page, { imageAddress = '', videoAddress = '', editAddress = '' } = {}) {
  const images = {
    enabled: !!imageAddress, baseUrl: imageAddress, model: imageAddress ? 'image-model' : '', size: '', keySet: false, editEnabled: false, editBaseUrl: editAddress, editModel: '', editMultiple: false, editMaxSize: '',
    editKeySet: false, timeoutSeconds: 300, sdExtras: false, ready: !!imageAddress, editReady: false,
  };
  const videos = {
    enabled: !!videoAddress, backend: 'sdcpp', backends: [{ id: 'sdcpp', label: 'stable-diffusion.cpp' }], baseUrl: videoAddress, model: videoAddress ? 'video-model' : '', size: '', frames: null, fps: null, keySet: false,
    timeoutSeconds: 1800, storageLimitMb: 0, ready: !!videoAddress,
  };
  await mockPortal(page, async ({ path: p, method }) => {
    if (method !== 'GET') return undefined;
    // Settings lists the extension as the portal has it installed.
    if (p === '/api/extensions') return { settingsPath: '/a/settings.json', extensions: [{ spec: 'extensions/media', name: 'pithagoras-media', version: '0.1.0', settings: [] }] };
    if (p === '/api/x/pithagoras-media/state') return { images: { enabled: images.ready }, videos: { enabled: videos.ready } };
    if (p === '/api/x/pithagoras-media/settings/images') return { images };
    if (p === '/api/x/pithagoras-media/settings/videos') return { videos };
  }, { settings: true });
}

const settings = (page: Page) => page.getByRole('dialog', { name: 'Settings' });

test("Media is one page of Settings, listed by the extension's title and icon, with the image model and the video model as two sections", async ({ page }) => {
  await portal(page);
  await page.goto('/settings/general');
  const dialog = settings(page);
  const entry = dialog.getByRole('navigation').getByRole('button', { name: 'Media', exact: true });
  // Its title and its own mark, not the package's name.
  await expect(entry.locator('svg')).toHaveCount(1);
  await expect(dialog.getByRole('navigation').getByRole('button', { name: 'pithagoras-media' })).toHaveCount(0);
  await entry.click();
  await expect(entry).toHaveAttribute('aria-current', 'page');
  await expect(dialog.getByRole('heading', { name: 'Image model' })).toBeVisible();
  await expect(dialog.getByRole('heading', { name: 'Video model' })).toBeVisible();
  // Each section has its own endpoint, in a region of its own, and the tab has no Images or Videos beside it.
  await expect(dialog.getByRole('region', { name: 'Image model' }).getByLabel('API address')).toBeVisible();
  await expect(dialog.getByRole('region', { name: 'Video model' }).getByLabel('API address')).toBeVisible();
  await expect(dialog.getByRole('button', { name: /^Images/ })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: /^Videos/ })).toHaveCount(0);
});

test('the search of Settings finds the image model in its section of the Media tab', async ({ page }) => {
  await portal(page);
  await page.goto('/settings/general');
  const dialog = settings(page);
  await expect(dialog.getByLabel('Default model')).toBeVisible();
  await dialog.getByLabel('Search settings').fill('bildgenerierung');
  await dialog.getByRole('option').first().click();
  await expect(dialog.getByRole('switch', { name: 'Image generation', exact: true })).toBeVisible();
  await expect(dialog.locator('[data-setting="Image model"]')).toHaveClass(/setting-flash/);
});

test('the Media tab fits a phone, with both sections in it', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await portal(page);
  await page.goto('/settings/x/pithagoras-media');
  await expect(settings(page).getByRole('switch', { name: 'Video generation', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

const section = (page: Page, name: 'Image model' | 'Video model') => settings(page).getByRole('region', { name });
/** The button that opens and closes a section: its heading. */
const toggle = (page: Page, name: 'Image model' | 'Video model') => section(page, name).getByRole('button', { name: new RegExp(`^${name}`) });

test('a model that is not set up is open, with its fields, and a click on its heading closes it to a line that says so, the switch staying where it was', async ({ page }) => {
  await portal(page);
  await page.goto('/settings/x/pithagoras-media');
  for (const name of ['Image model', 'Video model'] as const) {
    await expect(toggle(page, name)).toHaveAttribute('aria-expanded', 'true');
    await expect(section(page, name).getByLabel('API address')).toBeVisible();
  }
  const image = section(page, 'Image model');
  await toggle(page, 'Image model').click();
  await expect(toggle(page, 'Image model')).toHaveAttribute('aria-expanded', 'false');
  await expect(image.getByLabel('API address')).toBeHidden();
  await expect(toggle(page, 'Image model')).toContainText('Not set up');
  // What is most used stays: both switches, with what they say, and the video model has not moved.
  await expect(image.getByRole('switch', { name: 'Image generation', exact: true })).toBeVisible();
  await expect(image.getByRole('switch', { name: 'Image editing', exact: true })).toBeVisible();
  await expect(image.getByText('Save the address of an image endpoint first.').first()).toBeVisible();
  await expect(toggle(page, 'Video model')).toHaveAttribute('aria-expanded', 'true');
  await expect(section(page, 'Video model').getByLabel('API address')).toBeVisible();

  await toggle(page, 'Image model').click();
  await expect(toggle(page, 'Image model')).toHaveAttribute('aria-expanded', 'true');
  await expect(image.getByLabel('API address')).toBeVisible();
  await expect(toggle(page, 'Image model')).not.toContainText('Not set up');
});

test('a model that is set up is closed to its address and model, and the choice is kept for the next visit', async ({ page }) => {
  await portal(page, { imageAddress: 'https://images.example.com/v1', videoAddress: 'https://video.example.com' });
  await page.goto('/settings/x/pithagoras-media');
  await expect(toggle(page, 'Image model')).toHaveAttribute('aria-expanded', 'false');
  await expect(toggle(page, 'Image model')).toContainText('images.example.com · image-model');
  await expect(toggle(page, 'Video model')).toContainText('video.example.com · video-model');
  await expect(section(page, 'Image model').getByLabel('API address')).toBeHidden();
  await expect(section(page, 'Image model').getByRole('switch', { name: 'Image generation', exact: true })).toHaveAttribute('aria-checked', 'true');
  await expect(section(page, 'Video model').getByRole('switch', { name: 'Video generation', exact: true })).toHaveAttribute('aria-checked', 'true');

  await toggle(page, 'Video model').click();
  await expect(section(page, 'Video model').getByLabel('API address')).toHaveValue('https://video.example.com');
  await page.reload();
  await expect(toggle(page, 'Video model')).toHaveAttribute('aria-expanded', 'true');
  await expect(toggle(page, 'Image model')).toHaveAttribute('aria-expanded', 'false');
});

test('the groups inside the image model open and close on their own, each with a line of what is in it', async ({ page }) => {
  await portal(page, { imageAddress: 'https://images.example.com/v1' });
  await page.goto('/settings/x/pithagoras-media');
  await toggle(page, 'Image model').click();
  const image = section(page, 'Image model');
  const editing = image.locator('details:has(> summary:has-text("Editing endpoint"))');
  const more = image.locator('details:has(> summary:has-text("More options"))');
  await expect(editing).toContainText('Uses the image endpoint');
  await expect(more).toContainText('None on');
  await expect(image.getByLabel('Editing address')).toBeHidden();
  await expect(image.getByRole('switch', { name: 'Several pictures per edit' })).toBeHidden();
  await editing.locator('summary').click();
  await expect(image.getByLabel('Editing address')).toBeVisible();
  await more.locator('summary').click();
  await expect(image.getByRole('switch', { name: 'Several pictures per edit' })).toBeVisible();
  await editing.locator('summary').click();
  await expect(image.getByLabel('Editing address')).toBeHidden();
});

test('a section with something typed in it and not saved stays open', async ({ page }) => {
  await portal(page, { imageAddress: 'https://images.example.com/v1' });
  await page.goto('/settings/x/pithagoras-media');
  await toggle(page, 'Image model').click();
  await section(page, 'Image model').getByLabel('API address').fill('https://other.example.com/v1');
  // The button says it cannot (aria-disabled), which a click that waits for it to be enabled would wait on.
  await expect(toggle(page, 'Image model')).toHaveAttribute('aria-disabled', 'true');
  await toggle(page, 'Image model').click({ force: true });
  await expect(toggle(page, 'Image model')).toHaveAttribute('aria-expanded', 'true');
  await expect(section(page, 'Image model').getByLabel('API address')).toHaveValue('https://other.example.com/v1');
  await section(page, 'Image model').getByRole('button', { name: 'Discard' }).click();
  await toggle(page, 'Image model').click();
  await expect(toggle(page, 'Image model')).toHaveAttribute('aria-expanded', 'false');
});

test('a search opens the section or the group it leads to, and lights it up', async ({ page }) => {
  await portal(page, { imageAddress: 'https://images.example.com/v1', videoAddress: 'https://video.example.com' });
  await page.goto('/settings/general');
  const dialog = settings(page);
  await expect(dialog.getByLabel('Default model')).toBeVisible();
  await dialog.getByLabel('Search settings').fill('frame rate');
  await dialog.getByRole('option').first().click();
  await expect(toggle(page, 'Video model')).toHaveAttribute('aria-expanded', 'true');
  await expect(section(page, 'Video model').getByLabel('Frame rate')).toBeVisible();
  await expect(dialog.locator('[data-setting="Video model"]')).toHaveClass(/setting-flash/);

  // A group inside a closed section: both open.
  await toggle(page, 'Image model').click();
  await toggle(page, 'Image model').click();
  await expect(toggle(page, 'Image model')).toHaveAttribute('aria-expanded', 'false');
  await dialog.getByLabel('Search settings').fill('maximum picture size');
  await dialog.getByRole('option').first().click();
  await expect(toggle(page, 'Image model')).toHaveAttribute('aria-expanded', 'true');
  await expect(section(page, 'Image model').getByLabel('Maximum picture size')).toBeVisible();
});

for (const [label, width] of [['wide', 1280], ['phone', 390]] as const) {
  test(`the switches are stacked above the heading, and what opens is directly under it, with no horizontal scroll (${label})`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await portal(page, { imageAddress: 'https://images.example.com/v1', videoAddress: 'https://video.example.com' });
    await page.goto('/settings/x/pithagoras-media');
    for (const [name, switches] of [['Image model', ['Image generation', 'Image editing']], ['Video model', ['Video generation']]] as const) {
      const region = section(page, name);
      const heading = region.getByRole('heading', { level: 3 });
      const box = async (locator: ReturnType<Page['locator']>) => (await locator.boundingBox())!;
      const opener = toggle(page, name);
      const body = region.locator(`[id="${await opener.getAttribute('aria-controls')}"]`);
      await expect(opener).toHaveAttribute('aria-expanded', 'false');
      await heading.scrollIntoViewIfNeeded();
      // Closed: where the switches are.
      // Where the switches are in the section.
      const top = (await box(region)).y;
      const closed = await Promise.all(switches.map(async (switchName) => (await box(region.getByRole('switch', { name: switchName, exact: true }))).y - top));

      await opener.click();
      await expect(body).toBeVisible();
      const head = await box(heading);
      const under = await box(body);
      // The body begins right under the heading, with nothing between them.
      expect(under.y - (head.y + head.height), `${name}: the body is under the heading`).toBeGreaterThanOrEqual(0);
      expect(under.y - (head.y + head.height), `${name}: and directly`).toBeLessThanOrEqual(24);
      for (const [i, switchName] of switches.entries()) {
        const at = await box(region.getByRole('switch', { name: switchName, exact: true }));
        // Stacked: wholly above the heading at every width, never beside it, and so never between it and the body.
        expect(at.y + at.height, `${switchName}: above the heading`).toBeLessThanOrEqual(head.y + 1);
        expect(at.x + at.width, `${switchName}: inside the page`).toBeLessThanOrEqual(width);
        // And it has not moved for the opening of the section.
        expect(at.y - (await box(region)).y, `${switchName}: stays where it was`).toBeCloseTo(closed[i], 0);
      }
      // The heading is the full width of the section under the switches, not a column beside them.
      const sectionBox = await box(region);
      expect(Math.abs(head.x - sectionBox.x), `${name}: the heading starts at the section's edge`).toBeLessThanOrEqual(1);
      expect(head.width, `${name}: and spans it`).toBeGreaterThanOrEqual(sectionBox.width - 1);
      await opener.click();
      await expect(body).toBeHidden();
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  });
}
