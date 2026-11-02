import { type Locator, type Page } from '@playwright/test';
import { test, expect, mockPortal } from '../../../../tests/browser/portal-mock';

test.use({ installed: ['extensions/media'] });

/** The image model of Media's page in Settings (src/web/MediaAddons.tsx, ImagesAddon) over a portal whose image settings are made up. */
async function portal(page: Page) {
  const sent: { path: string; body: any }[] = [];
  const images = { enabled: false, baseUrl: '', model: '', size: '', keySet: false, editEnabled: false, editBaseUrl: '', editModel: '', editMultiple: false, editMaxSize: '', editKeySet: false, timeoutSeconds: 300, sdExtras: false, ready: false, editReady: false };
  await mockPortal(page, async ({ path: p, method, json }) => {
    // Settings lists the extension as the portal has it installed.
    if (p === '/api/extensions') return { settingsPath: '/a/settings.json', extensions: [{ spec: 'extensions/media', name: 'pithagoras-media', version: '0.1.0', settings: [] }] };
    // As the server half says it: pictures can be made or changed.
    if (p === '/api/x/pithagoras-media/state') return { images: { enabled: images.ready || images.editReady }, videos: { enabled: false } };
    // The page has the video model beside the image model: here it is not set up.
    if (p === '/api/x/pithagoras-media/settings/videos' && method === 'GET') return { videos: { enabled: false, backend: 'sdcpp', backends: [{ id: 'sdcpp', label: 'stable-diffusion.cpp' }], baseUrl: '', model: '', size: '', frames: null, fps: null, keySet: false, timeoutSeconds: 1800, storageLimitMb: 0, ready: false } };
    if (p === '/api/x/pithagoras-media/settings/images' && method === 'GET') return { images };
    if (p === '/api/x/pithagoras-media/settings/images' && method === 'PUT') {
      const patch = json();
      sent.push({ path: p, body: patch });
      // The shape of the edit tool counts as a change only while there is an edit tool.
      const changed = (patch.enabled !== undefined && patch.enabled !== images.enabled) || (patch.editEnabled !== undefined && patch.editEnabled !== images.editEnabled)
        || (patch.editMultiple !== undefined && patch.editMultiple !== images.editMultiple && images.editReady);
      const { apiKey, editApiKey, ...rest } = patch;
      Object.assign(images, rest);
      // null takes a saved limit away: the default again.
      if (patch.timeoutSeconds === null) images.timeoutSeconds = 300;
      if (apiKey !== undefined) images.keySet = apiKey !== '';
      if (editApiKey !== undefined) images.editKeySet = editApiKey !== '';
      images.ready = images.enabled && images.baseUrl !== '';
      images.editReady = images.editEnabled && (images.editBaseUrl || images.baseUrl) !== '';
      return { images, changed, reloaded: 1, waiting: 1 };
    }
  }, { settings: true });
  return { sent };
}

const addons = (page: Page) => page.getByRole('dialog', { name: 'Settings' });
/** The image model's half of Media's page in Settings: the video model's has fields of the same names. */
const imagePanel = (page: Page) => addons(page).getByRole('region', { name: 'Image model' });
/** A group inside the image model's section ("Editing endpoint", "More options"), opened if it is closed. */
async function openGroup(panel: Locator, name: string) {
  const group = panel.locator(`details:has(> summary:has-text("${name}"))`);
  if (!(await group.evaluate((el: HTMLDetailsElement) => el.open))) await group.locator('summary').click();
  await expect(group).toHaveAttribute('open', '');
}

test('Escape over the image endpoint that was typed in asks first, and over one that was saved does not', async ({ page }) => {
  const { sent } = await portal(page);
  const ask = page.getByRole('alertdialog', { name: 'Discard your changes?' });
  await page.goto('/settings/x/pithagoras-media');
  await expect(imagePanel(page).getByLabel('API address')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(addons(page)).toBeHidden();

  await page.goto('/settings/x/pithagoras-media');
  const address = imagePanel(page).getByLabel('API address');
  await address.fill('https://images.example.com/v1');
  await page.keyboard.press('Escape');
  await expect(ask).toBeVisible();
  await ask.getByRole('button', { name: 'Cancel' }).click();
  await expect(address).toHaveValue('https://images.example.com/v1');
  await imagePanel(page).getByLabel('Model', { exact: true }).fill('image-model');
  await imagePanel(page).getByRole('button', { name: 'Save', exact: true }).click();
  await expect(imagePanel(page).getByRole('button', { name: 'Save', exact: true })).toBeHidden();
  expect(sent).toHaveLength(1);
  await page.keyboard.press('Escape');
  await expect(addons(page)).toBeHidden();
});


test('image generation needs an endpoint before it can be switched on, and the key is sent once and never shown again', async ({ page }) => {
  const { sent } = await portal(page);
  await page.goto('/settings/x/pithagoras-media');
  const panel = imagePanel(page);
  const tool = panel.getByRole('switch', { name: 'Image generation', exact: true });
  await expect(tool).toHaveAttribute('aria-checked', 'false');
  await expect(tool).toBeDisabled();
  // Both switches say it: generation's is the first.
  await expect(panel.getByText('Save the address of an image endpoint first.').first()).toBeVisible();
  await expect(panel.getByText('Off: no pictures are made.')).toBeVisible();

  await panel.getByLabel('API address').fill('https://images.example.com/v1');
  await panel.getByLabel('API key').fill('sk-test-123');
  await panel.getByLabel('Model', { exact: true }).fill('image-model');
  await expect(tool).toBeDisabled();
  await expect(panel.getByText('Save or discard the changes first.')).toBeVisible();
  await panel.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Save', exact: true })).toBeHidden();
  expect(sent).toEqual([{ path: '/api/x/pithagoras-media/settings/images', body: { baseUrl: 'https://images.example.com/v1', model: 'image-model', size: '', apiKey: 'sk-test-123' } }]);
  // The page is told only that a key is set: the field is empty and says so.
  await expect(panel.getByLabel('API key')).toHaveValue('');
  await expect(panel.getByLabel('API key')).toHaveAttribute('placeholder', 'saved — type to replace');

  await expect(tool).toBeEnabled();
  await tool.click();
  await expect(tool).toHaveAttribute('aria-checked', 'true');
  await expect(panel.getByText('On: pictures are made on the Media page and by the agent.')).toBeVisible();
  await expect(panel.getByText(/one busy chat has it from its next step/)).toBeVisible();
  expect(sent.at(-1)!.body).toEqual({ enabled: true });

  // Changing only the model keeps the key: it is not sent again.
  await panel.getByLabel('Model', { exact: true }).fill('another-model');
  await panel.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Save', exact: true })).toBeHidden();
  expect(sent.at(-1)!.body).toEqual({ baseUrl: 'https://images.example.com/v1', model: 'another-model', size: '' });

  await panel.getByRole('button', { name: 'Remove the saved key' }).click();
  await expect(panel.getByLabel('API key')).toHaveAttribute('placeholder', 'none needed for a local server');
  expect(sent.at(-1)!.body).toEqual({ apiKey: '' });
});

test('the Media page is in the sidebar while image generation is on, and the switch moves it at once', async ({ page }) => {
  await portal(page);
  await page.goto('/settings/x/pithagoras-media');
  const entry = page.getByRole('complementary', { name: 'Sidebar' }).getByRole('button', { name: 'Media' });
  await expect(entry).toHaveCount(0);
  const panel = imagePanel(page);
  await panel.getByLabel('API address').fill('https://images.example.com/v1');
  await panel.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Save', exact: true })).toBeHidden();
  // An address is not enough: the tool is still off.
  await expect(entry).toHaveCount(0);
  await panel.getByRole('switch', { name: 'Image generation', exact: true }).click();
  await expect(entry).toHaveCount(1);
  await panel.getByRole('switch', { name: 'Image generation', exact: true }).click();
  await expect(entry).toHaveCount(0);
});

test('the time limit of a picture is a field of the image endpoint: five minutes, whole seconds from 30 to 3600, sent only when changed', async ({ page }) => {
  const { sent } = await portal(page);
  await page.goto('/settings/x/pithagoras-media');
  const panel = imagePanel(page);
  const field = panel.getByLabel('Time limit (seconds)');
  await expect(field).toHaveValue('300');

  // Out of bounds: nothing to save.
  await field.fill('10');
  const save = panel.getByRole('button', { name: 'Save', exact: true });
  await expect(save).toBeDisabled();
  await field.fill('4000');
  await expect(save).toBeDisabled();
  // Text that is not a number is no limit either, and is not taken for the default.
  await field.fill('600s');
  await expect(save).toBeDisabled();
  await field.fill('900');
  await expect(save).toBeEnabled();
  await save.click();
  await expect(save).toBeHidden();
  expect(sent.at(-1)!.body).toEqual({ baseUrl: '', model: '', size: '', timeoutSeconds: 900 });
  await expect(field).toHaveValue('900');

  // Saving something else does not state the limit again.
  await panel.getByLabel('Model', { exact: true }).fill('image-model');
  await save.click();
  await expect(save).toBeHidden();
  expect(sent.at(-1)!.body).toEqual({ baseUrl: '', model: 'image-model', size: '' });

  // Empty is the default, which is what the placeholder says: a saved limit is taken away, not stored as 300.
  await expect(field).toHaveValue('900');
  await field.fill('');
  await expect(save).toBeEnabled();
  await save.click();
  await expect(save).toBeHidden();
  expect(sent.at(-1)!.body).toEqual({ baseUrl: '', model: 'image-model', size: '', timeoutSeconds: null });
  await expect(field).toHaveValue('300');
});

test('image editing has a switch and an endpoint of its own: it needs an address, may use the one above, and its key is sent once', async ({ page }) => {
  const { sent } = await portal(page);
  await page.goto('/settings/x/pithagoras-media');
  const panel = imagePanel(page);
  const editing = panel.getByRole('switch', { name: 'Image editing', exact: true });
  await expect(editing).toHaveAttribute('aria-checked', 'false');
  await expect(editing).toBeDisabled();
  await expect(panel.getByText('Off: no pictures are changed or used as references.')).toBeVisible();
  await openGroup(panel, 'Editing endpoint');

  // Generation's address is enough, and its key is the one used: the form says so.
  await panel.getByLabel('API address').fill('https://images.example.com/v1');
  await panel.getByLabel('API key').fill('sk-test-123');
  await panel.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Save', exact: true })).toBeHidden();
  await expect(panel.getByLabel('Editing address')).toHaveAttribute('placeholder', 'https://images.example.com/v1');
  await expect(panel.getByLabel('Editing key')).toHaveAttribute('placeholder', 'the key above is used');
  await expect(editing).toBeEnabled();
  await editing.click();
  await expect(editing).toHaveAttribute('aria-checked', 'true');
  await expect(panel.getByText('On: pictures are changed, and used as references for new ones, on the Media page and by the agent.')).toBeVisible();
  await expect(panel.getByText(/one busy chat has it from its next step/)).toBeVisible();
  expect(sent.at(-1)!.body).toEqual({ editEnabled: true });
  // Generation is its own switch: still off.
  await expect(panel.getByRole('switch', { name: 'Image generation', exact: true })).toHaveAttribute('aria-checked', 'false');

  // Its own address, model and key: another server is not given the one above, and the switch waits for the save.
  await panel.getByLabel('Editing address').fill('https://edit.example.net/v1');
  await panel.getByLabel('Editing key').fill('sk-edit-456');
  await panel.getByLabel('Editing model').fill('image-edit-model');
  await expect(editing).toBeDisabled();
  await expect(panel.getByText('Save or discard the changes first.')).toBeVisible();
  await expect(panel.getByLabel('Editing key')).toHaveAttribute('placeholder', 'none needed for a local server');
  await panel.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Save', exact: true })).toBeHidden();
  expect(sent.at(-1)!.body).toEqual({ editBaseUrl: 'https://edit.example.net/v1', editModel: 'image-edit-model', editApiKey: 'sk-edit-456' });
  await expect(panel.getByLabel('Editing key')).toHaveValue('');
  await expect(panel.getByLabel('Editing key')).toHaveAttribute('placeholder', 'saved — type to replace');
  await expect(editing).toBeEnabled();
  // The key of generation is untouched by it.
  await expect(panel.getByLabel('API key')).toHaveAttribute('placeholder', 'saved — type to replace');

  // Only the model changed: the key is not sent again.
  await panel.getByLabel('Editing model').fill('another-edit-model');
  await panel.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Save', exact: true })).toBeHidden();
  expect(sent.at(-1)!.body).toEqual({ editBaseUrl: 'https://edit.example.net/v1', editModel: 'another-edit-model' });

  await panel.getByRole('button', { name: 'Remove the saved editing key' }).click();
  await expect(panel.getByLabel('Editing key')).toHaveAttribute('placeholder', 'none needed for a local server');
  expect(sent.at(-1)!.body).toEqual({ editApiKey: '' });
  // Generation's key is still there to remove on its own.
  await expect(panel.getByRole('button', { name: 'Remove the saved key' })).toBeVisible();
});

test('image editing has a maximum picture size of its own, sent only when changed, and refuses what is no size', async ({ page }) => {
  const { sent } = await portal(page);
  await page.goto('/settings/x/pithagoras-media');
  const panel = imagePanel(page);
  await openGroup(panel, 'Editing endpoint');
  const field = panel.getByLabel('Maximum picture size');
  const save = panel.getByRole('button', { name: 'Save', exact: true });
  await expect(field).toHaveValue('');
  await expect(field).toHaveAttribute('placeholder', '2048x2048');
  await expect(panel.getByText(/The maximum picture size is the most pixels a picture sent to be edited may have/)).toBeVisible();
  // Generation's size is its own field, and is not the maximum.
  await expect(panel.getByLabel('Picture size', { exact: true })).toHaveValue('');

  // A side of zero is no limit at all, so it is refused as well.
  await field.fill('00x00');
  await expect(field).toHaveAttribute('aria-invalid', 'true');
  await expect(save).toBeDisabled();
  await field.fill('huge');
  await expect(field).toHaveAttribute('aria-invalid', 'true');
  await expect(save).toBeDisabled();
  await field.fill(' 2048x1024 ');
  await expect(field).toHaveAttribute('aria-invalid', 'false');
  await expect(save).toBeEnabled();
  await save.click();
  await expect(save).toBeHidden();
  expect(sent.at(-1)!.body).toEqual({ editBaseUrl: '', editModel: '', editMaxSize: '2048x1024' });
  await expect(field).toHaveValue('2048x1024');

  // Saving something else does not state it again; emptied, it is taken away.
  await panel.getByLabel('Editing model').fill('image-edit-model');
  await save.click();
  await expect(save).toBeHidden();
  expect(sent.at(-1)!.body).toEqual({ editBaseUrl: '', editModel: 'image-edit-model' });
  await field.fill('');
  await save.click();
  await expect(save).toBeHidden();
  expect(sent.at(-1)!.body).toEqual({ editBaseUrl: '', editModel: 'image-edit-model', editMaxSize: '' });
});

test('several pictures per edit is a switch of its own that waits for the editing address, and says what the tool takes', async ({ page }) => {
  const { sent } = await portal(page);
  await page.goto('/settings/x/pithagoras-media');
  const panel = imagePanel(page);
  await openGroup(panel, 'More options');
  await openGroup(panel, 'Editing endpoint');
  const several = panel.getByRole('switch', { name: 'Several pictures per edit' });
  await expect(several).toHaveAttribute('aria-checked', 'false');
  await expect(panel.getByText('Off: an edit takes one picture.')).toBeVisible();
  await expect(panel.getByText(/Switch it on only if the editing endpoint takes more than one picture in a request/)).toBeVisible();

  await panel.getByLabel('API address').fill('https://images.example.com/v1');
  await panel.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Save', exact: true })).toBeHidden();
  await panel.getByRole('switch', { name: 'Image editing', exact: true }).click();
  await expect(panel.getByRole('switch', { name: 'Image editing', exact: true })).toHaveAttribute('aria-checked', 'true');

  // Typing in the editing form waits for its save, as the switch above it does.
  await panel.getByLabel('Editing model').fill('image-edit-model');
  await expect(several).toBeDisabled();
  await expect(panel.getByText('Save or discard the changes first.')).toBeVisible();
  await panel.getByRole('button', { name: 'Discard' }).click();
  await expect(several).toBeEnabled();

  await several.click();
  await expect(several).toHaveAttribute('aria-checked', 'true');
  await expect(panel.getByText('On: an edit takes up to eight pictures.')).toBeVisible();
  // The tool has another shape from now on, so the chats are reloaded like for a tool that came.
  await expect(panel.getByText(/one busy chat has it from its next step/)).toBeVisible();
  expect(sent.at(-1)!.body).toEqual({ editMultiple: true });
  await several.click();
  await expect(several).toHaveAttribute('aria-checked', 'false');
  expect(sent.at(-1)!.body).toEqual({ editMultiple: false });
});

test('Stable Diffusion extra settings is a switch of its own, off by default, that says plainly what it does and for which servers', async ({ page }) => {
  const { sent } = await portal(page);
  await page.goto('/settings/x/pithagoras-media');
  const panel = imagePanel(page);
  await openGroup(panel, 'More options');
  await openGroup(panel, 'Editing endpoint');
  const sd = panel.getByRole('switch', { name: 'Stable Diffusion extra settings' });
  await expect(sd).toHaveAttribute('aria-checked', 'false');
  await expect(sd).toBeEnabled();
  await expect(panel.getByText('Off: the Media page shows only the settings of the OpenAI image format.')).toBeVisible();
  // What it does, and that only one kind of server understands it: any other would read the block as words of the description.
  await expect(panel.getByText(/Only for a stable-diffusion\.cpp server/)).toBeVisible();
  await expect(panel.getByText(/Any other endpoint would take the block as part of the description/)).toBeVisible();
  // And what it means for a new picture made with references, by the page or the agent: from noise only while it is on.
  await expect(panel.getByText(/starts from noise only while this is on: off, a stable-diffusion\.cpp server starts from the first reference/)).toBeVisible();

  // It is a setting of the endpoint, not of a tool: no address is needed to say it, and nothing reloads.
  await sd.click();
  await expect(sd).toHaveAttribute('aria-checked', 'true');
  await expect(panel.getByText('On: the Media page shows stable-diffusion.cpp settings under Advanced.')).toBeVisible();
  expect(sent.at(-1)!.body).toEqual({ sdExtras: true });
  await expect(panel.getByText(/one busy chat has it from its next step/)).toHaveCount(0);
  await sd.click();
  await expect(sd).toHaveAttribute('aria-checked', 'false');
  expect(sent.at(-1)!.body).toEqual({ sdExtras: false });

  // An address typed and not saved: the switch waits for the save, as the others of the endpoint do, since saving the address of another server takes it off again.
  await panel.getByLabel('API address').fill('http://sd-box.example:1234/v1');
  await expect(sd).toBeDisabled();
  await panel.getByRole('button', { name: 'Discard' }).click();
  await expect(sd).toBeEnabled();
  await panel.getByLabel('Editing model').fill('edit-model');
  await expect(sd).toBeDisabled();
  await panel.getByRole('button', { name: 'Discard' }).click();
  await expect(sd).toBeEnabled();
});

test("Media's page in Settings holds the image settings and no switch for the tools themselves", async ({ page }) => {
  await portal(page);
  await page.goto('/settings/x/pithagoras-media');
  const here = addons(page);
  const panel = imagePanel(page);
  await expect(panel.getByRole('switch', { name: 'Image generation', exact: true })).toBeVisible();
  await expect(panel.getByRole('switch', { name: 'Image editing', exact: true })).toBeVisible();
  await openGroup(panel, 'More options');
  await expect(panel.getByRole('switch', { name: 'Several pictures per edit' })).toBeVisible();
  // The switches are the feature's, and say so: which chat's agent gets a tool is for the tool lists, in the extension's group.
  await expect(here.getByText(/Which chats' agents get the tools is set in the tool lists \(Settings → Agent → Tools\), in the pithagoras-media group/)).toBeVisible();
  await expect(here.getByText('Picture tools', { exact: true })).toHaveCount(0);
  for (const name of ['show_image', 'generate_image', 'edit_image']) await expect(here.getByRole('switch', { name: `${name} in new chats` })).toHaveCount(0);
});

test("Media's page in Settings fits a phone", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await portal(page);
  await page.goto('/settings/x/pithagoras-media');
  await expect(imagePanel(page).getByRole('switch', { name: 'Image editing', exact: true })).toBeVisible();
  await expect(addons(page).getByRole('switch', { name: 'Video generation', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  expect(await addons(page).evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
});
