import { test, expect } from '../../../../tests/browser/portal-mock';

test.use({ installed: ['extensions/media'] });

/** The agent's generate_image in voice mode, from voice.page.tsx: its picture in the chat, on its card and in the picture window. */

// A 2×2 PNG, as a picture from the folder would be.
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==', 'base64');

test.beforeEach(async ({ page }) => {
  await page.route('**/api/sessions/test/commands', route => route.fulfill({ json: { commands: [] } }));
  await page.route('**/api/sessions/test/config', route => route.fulfill({ status: 503, json: {} }));
  await page.route('**/api/voice', route => route.fulfill({ json: { enabled: true } }));
  // A short phrase of silence, as the portal answers one: 24 kHz PCM.
  await page.route('**/voice/speech', route => route.fulfill({ body: Buffer.alloc(4800), headers: { 'content-type': 'audio/pcm', 'x-sample-rate': '24000' } }));
  await page.route('**/api/sessions/test/picture?**', route => route.fulfill({ body: png, contentType: 'image/png' }));
});

async function start(page: import('@playwright/test').Page) {
  await page.goto('/tests/extension.html?page=media/voice');
  await page.getByRole('button', { name: 'Turn on hands-free voice' }).click();
  await expect(page.getByRole('button', { name: 'End voice mode' })).toBeVisible({ timeout: 25000 });
}

test('a picture the agent had generated is drawn in the chat as a preview, and in the voice picture window', async ({ page }) => {
  const failures: string[] = [];
  page.on('pageerror', e => failures.push(e.message));
  const asked: string[] = [];
  await page.route('**/api/sessions/test/picture?**', route => { asked.push(new URL(route.request().url()).searchParams.get('path') ?? ''); return route.fulfill({ body: png, contentType: 'image/png' }); });
  await page.goto('/tests/extension.html?page=media/voice');
  // In the chat: the picture in its preview, fetched from the chat's folder like one that was shown.
  await page.getByRole('button', { name: 'Generate picture' }).click();
  const thumbnail = page.getByTestId('workspace').getByRole('img', { name: 'A lighthouse at dusk' });
  await expect(thumbnail).toBeVisible();
  await expect.poll(() => asked).toContain('generated-images/image-20261001-101500-a1b2c3.png');
  // In place of the tool card, with the call under Details.
  await expect(page.getByTestId('workspace').getByRole('button', { name: 'Details' })).toBeVisible();
  await expect(page.getByTestId('workspace').getByRole('button', { name: /^generate_image/ })).toHaveCount(0);

  // In voice mode: the picture window opens on the next one, and keeps the earlier.
  await page.getByRole('button', { name: 'Turn on hands-free voice' }).click();
  await expect(page.getByRole('button', { name: 'End voice mode' })).toBeVisible({ timeout: 25000 });
  await page.getByRole('button', { name: 'Generate picture' }).click();
  const window = page.getByRole('region', { name: 'Pictures' });
  await expect(window.getByRole('img', { name: 'A lighthouse at dusk' })).toBeVisible();
  await expect(window).toContainText('A lighthouse at dusk');
  await expect(window).toContainText('2 / 2');
  expect(failures).toEqual([]);
});

test("a generate_image card is the same element from its start to its end, only a button once its picture is there", async ({ page }) => {
  await start(page);
  // The real order: the call starts, the model works, and some time later the picture arrives.
  await page.getByRole('button', { name: 'Start generating a picture' }).click();
  const card = page.locator('.voice-tool-float', { hasText: 'A foggy harbour at first light' });
  await expect(card).toContainText('Making a picture');
  await expect(card).not.toHaveAttribute('role', 'button');
  await expect(card).not.toHaveAttribute('title', /.+/);
  // The element is marked, so that a new one drawn in its place would be told by not having the mark.
  await card.evaluate(element => { element.setAttribute('data-first-element', 'yes'); });

  await page.getByRole('button', { name: 'Finish generating the picture' }).click();
  await expect(card).toHaveAttribute('role', 'button');
  await expect(card).toHaveAttribute('title', 'Show the picture');
  await expect(card).toHaveAttribute('data-first-element', 'yes');
  // And the card works as a button, by keyboard too.
  await expect(page.getByRole('region', { name: 'Pictures' })).toBeVisible();
  await page.getByRole('region', { name: 'Pictures' }).getByRole('button', { name: 'Minimize pictures' }).click();
  await card.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('region', { name: 'Pictures' }).getByRole('img', { name: 'A foggy harbour' })).toBeVisible();
});
