import { readFileSync } from 'node:fs';
import { type Locator, type Page } from '@playwright/test';
import { test, expect } from '../../../../tests/browser/portal-mock';

test.use({ installed: ['extensions/media'] });

/**
 * A clip the agent makes or shows, in the chat (src/web/VideoCall.tsx): the frame that holds its place while it is
 * made, the player once it is there, and a failure in the frame's own words. From videos.page.tsx.
 */

const WEBM = readFileSync(new URL('../../../../tests/fixtures/clip.webm', import.meta.url));
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

/**
 * The fixture, once the extension draws its calls: the page is loaded after the document, and the extension after
 * the page, and until then a call is the portal's plain card.
 */
async function open(page: Page) {
  await page.goto('/tests/extension.html?page=media/videos');
  await expect(page.locator('.video-call').first()).toBeAttached();
}

test('a clip being made is a frame in the shape of the coming clip, not a tool card', async ({ page }) => {
  await open(page);
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
  await open(page);
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
  await open(page);
  const failed = preview(page, 'A cat on a sofa');
  await expect(failed).toHaveClass(/is-failed/);
  await expect(failed).toContainText('No video was made');
  await expect(failed).toContainText('The video endpoint answered 400: invalid generation parameters');
  // One cut off by the run that ended says that.
  const cut = preview(page, 'A castle in the clouds');
  await expect(cut).toContainText('No video was made');
  await expect(cut).toContainText('Interrupted before the video arrived');
});

test('a clip that was made but that a browser cannot play is saved, said so with its format, and points to the gallery; no player is drawn for it', async ({ page }) => {
  await open(page);
  await page.evaluate(() => {
    (window as any).emit('tool_execution_start', { toolCallId: 'avi', toolName: 'generate_video', args: { prompt: 'An old format of a lighthouse', title: 'Old format' } });
    (window as any).emit('tool_execution_end', {
      toolCallId: 'avi',
      toolName: 'generate_video',
      result: { content: [{ type: 'text', text: 'Generated and saved: generated-videos/video-1.avi.' }], details: { files: [{ path: 'generated-videos/video-1.avi', title: 'Old format' }], notPlayable: 'AVI' } },
      // A file a browser does not play, as the portal finds it by its bytes.
      portalFiles: [{ path: 'generated-videos/video-1.avi', kind: 'file', title: 'Old format' }],
    });
  });
  const card = page.locator('.video-call-player', { hasText: 'Old format' });
  await expect(card).toContainText('Its format is AVI, which a browser cannot play here.');
  await expect(card.getByRole('link', { name: 'Media gallery' })).toHaveAttribute('href', '/x/pithagoras-media/media');
  await expect(card.locator('video')).toHaveCount(0);
  // The call is still under Details.
  await card.getByRole('button', { name: 'Details' }).click();
  await expect(call(page, card).locator('.chat-tool-body')).toContainText('generate_video');
  // Nothing asked the chat's folder for it as a clip.
  expect(asked).not.toContain('generated-videos/video-1.avi');
});

test('a clip that was not made shows its whole message in its frame, which is not cut at a few lines or a few characters', async ({ page }) => {
  await open(page);
  const message = 'What the video endpoint sent is not a WebM or MP4 video, which is what a browser plays. It says output_format avi, mime_type video/x-msvideo; the file starts with 52 49 46 46 10 20 30 40; frame_count 49, resolution 832x480, and then a good deal more that the server said about how it came to that.';
  expect(message.length).toBeGreaterThan(240);
  await page.evaluate((text) => {
    (window as any).emit('tool_execution_start', { toolCallId: 'avi', toolName: 'generate_video', args: { prompt: 'An avi of a lighthouse' } });
    (window as any).emit('tool_execution_end', { toolCallId: 'avi', toolName: 'generate_video', isError: true, result: { content: [{ type: 'text', text }] } });
  }, message);
  const reason = preview(page, 'An avi of a lighthouse').locator('.image-preview-failed p');
  await expect(reason).toHaveText(message);
  expect(await reason.evaluate((el) => el.scrollHeight <= el.clientHeight + 1)).toBe(true);
});

test('the calls of generate_video in a chat are frames and players: made, not made, cut off, being made', async ({ page }) => {
  await open(page);
  await expect(page.locator('.video-call')).toHaveCount(4);
});

test('a clip shown with show_video plays under its tool line', async ({ page }) => {
  await open(page);
  const video = page.locator('.chat-picture video');
  await expect(video).toHaveAttribute('src', /path=clips%2Fharbour\.mp4/);
  await expect(video).toHaveAccessibleName('The harbour');
  expect(await video.evaluate((v: HTMLVideoElement) => v.controls)).toBe(true);
});

test('the clip takes the place of the frame when the call ends, and a clip that is gone from the folder says so', async ({ page }) => {
  await open(page);
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
