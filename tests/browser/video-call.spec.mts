import { readFileSync } from 'node:fs';
import { type Locator, type Page } from '@playwright/test';
import { test, expect } from './portal-mock';

/**
 * A clip the agent makes or shows, in the chat (VideoCall.tsx): the frame that holds its place while it is made, the
 * player once it is there, and a failure in the frame's own words. From web/tests/videos.tsx.
 */

const WEBM = readFileSync(new URL('../fixtures/clip.webm', import.meta.url));
const asked: string[] = [];

async function folder(page: Page) {
  asked.length = 0;
  await page.route('**/api/sessions/preview/video?**', async (route) => {
    const url = new URL(route.request().url());
    asked.push(url.searchParams.get('path') ?? '');
    // As the portal's own route answers: the whole clip with the type its bytes say, to be asked for again in another page.
    await route.fulfill({ body: WEBM, contentType: 'video/webm', headers: { 'cache-control': 'private, no-cache', 'accept-ranges': 'bytes' } });
  });
}

const preview = (page: Page, text: string) => page.locator('.image-preview', { hasText: text });
/** The call under the player or the preview, which is what its Details open. */
const call = (page: Page, of: Locator) => page.locator('.video-call', { has: of });
const shapeOf = async (frame: Locator) => {
  const box = (await frame.boundingBox())!;
  return box.width / box.height;
};

test.beforeEach(async ({ page }) => {
  await folder(page);
});

test('a clip being made is a frame in the shape of the coming clip, not a tool card', async ({ page }) => {
  await page.goto('/tests/videos.html');
  const making = preview(page, 'A foggy harbour');
  await expect(making).toHaveClass(/is-making/);
  await expect(making.getByRole('status')).toContainText('Making a video');
  expect(await shapeOf(making.locator('.image-preview-frame'))).toBeCloseTo(832 / 480, 1);
  await expect(making.locator('img, video')).toHaveCount(0);
  // In place of the card, whose call is a click away: its name and what it was given.
  await making.getByRole('button', { name: 'Details' }).click();
  await expect(call(page, making).locator('.chat-tool-body')).toContainText('generate_video');
  await expect(call(page, making).locator('.chat-tool-body')).toContainText('A foggy harbour at first light');
  await expect(call(page, making).locator('.chat-tool-body')).toContainText('832x480');
});

test('a clip that was made plays in the chat, with its title, fetched from the chat\'s folder by its path', async ({ page }) => {
  await page.goto('/tests/videos.html');
  const player = page.locator('.video-call-player', { hasText: 'A fox in the snow' });
  const video = player.locator('video');
  await expect(video).toHaveAttribute('src', /\/api\/sessions\/preview\/video\?path=generated-videos%2Ffox\.webm&v=\d+$/);
  await expect(video).toHaveAttribute('controls', '');
  await expect(video).toHaveAttribute('preload', 'metadata');
  await expect(video).toHaveAccessibleName('A fox in the snow');
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState)).toBeGreaterThanOrEqual(1);
  expect(asked).toContain('generated-videos/fox.webm');
  // It does not play by itself.
  await expect(video).toHaveJSProperty('paused', true);
  await expect(video).toHaveJSProperty('autoplay', false);
  // The call is under Details, as the picture's is.
  await player.getByRole('button', { name: 'Details' }).click();
  await expect(call(page, player).locator('.chat-tool-body')).toContainText('generate_video');
  await expect(call(page, player).locator('.chat-tool-body')).toContainText('832x480');
});

test('a clip that was not made says so in its frame, with the endpoint\'s words', async ({ page }) => {
  await page.goto('/tests/videos.html');
  const failed = preview(page, 'A cat on a sofa');
  await expect(failed).toHaveClass(/is-failed/);
  await expect(failed).toContainText('No video was made');
  await expect(failed).toContainText('The video endpoint answered 400: invalid generation parameters');
  // One cut off by the run that ended says that.
  const cut = preview(page, 'A castle in the clouds');
  await expect(cut).toContainText('No video was made');
  await expect(cut).toContainText('Interrupted before the video arrived');
});

test('a generate_video that an extension brings is a plain tool card, running or failed', async ({ page }) => {
  await page.goto('/tests/videos.html');
  const cards = page.locator('.chat-tool', { hasText: 'generate_video' });
  await expect(cards).toHaveCount(2);
  for (const prompt of ['A dragon over the sea', 'A robot in a garden']) await expect(preview(page, prompt)).toHaveCount(0);
  await expect(cards.first()).toContainText('A dragon over the sea');
  await expect(cards.nth(1)).toContainText('A robot in a garden');
  // The portal's calls, in the same chat, are frames and players: made, not made, cut off, being made.
  await expect(page.locator('.video-call')).toHaveCount(4);
});

test('a clip shown with show_video plays under its tool line', async ({ page }) => {
  await page.goto('/tests/videos.html');
  const video = page.locator('.chat-picture video');
  await expect(video).toHaveAttribute('src', /path=clips%2Fharbour\.mp4/);
  await expect(video).toHaveAccessibleName('The harbour');
  expect(await video.evaluate((v: HTMLVideoElement) => v.controls)).toBe(true);
});

test('the clip takes the place of the frame when the call ends, and a clip that is gone from the folder says so', async ({ page }) => {
  await page.goto('/tests/videos.html');
  const making = preview(page, 'A foggy harbour');
  await expect(making).toBeVisible();
  await page.evaluate(() => (window as any).emit('tool_execution_end', (window as any).madePayload('making', 'generated-videos/harbour.webm', 'A foggy harbour')));
  await expect(making).toHaveCount(0);
  const video = page.locator('.video-call-player', { hasText: 'A foggy harbour' }).locator('video');
  await expect(video).toHaveAttribute('src', /generated-videos%2Fharbour\.webm/);

  // The folder no longer has it.
  await page.unroute('**/api/sessions/preview/video?**');
  await page.route('**/api/sessions/preview/video?**', (route) => route.fulfill({ status: 404, json: { error: 'There is no such file or folder' } }));
  await page.reload();
  await expect(page.locator('.video-call-player', { hasText: 'A fox in the snow' })).toContainText('This video is no longer in the folder.');
});
