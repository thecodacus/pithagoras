import { type Locator, type Page } from '@playwright/test';
import { test, expect } from '../../../../tests/browser/portal-mock';
import zlib from 'node:zlib';

test.use({ installed: ['extensions/media'] });

/**
 * A picture being made, made and not made, as the extension's cards draw it in the portal's preview
 * (src/web/PictureCall.tsx): in the chat, from pictures.page.tsx, and as the tile on a card in voice mode, from
 * voice.page.tsx.
 */

/** A plain picture of this size, as the chat's folder would serve one; `shade` is its grey, from 0 (black) to 255 (white). */
function picture(width: number, height: number, shade = 150): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const head = Buffer.alloc(13);
  head.writeUInt32BE(width, 0);
  head.writeUInt32BE(height, 4);
  head[8] = 8;
  head[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, shade)]);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', head), chunk('IDAT', zlib.deflateSync(Buffer.concat(Array.from({ length: height }, () => row)))), chunk('IEND', Buffer.alloc(0))]);
}

/** The pictures the folder has, by path, in pixels; `held` keeps every answer back until it is settled. */
const SIZES: Record<string, [number, number]> = {
  'generated-images/lighthouse.png': [192, 128],
  'generated-images/harbour.png': [128, 192],
  'photos/dog.png': [200, 100],
};

async function folder(page: Page, sessionId: string, held?: Promise<void>) {
  await page.route(`**/api/sessions/${sessionId}/picture?**`, async (route) => {
    const size = SIZES[new URL(route.request().url()).searchParams.get('path') ?? ''] ?? SIZES['generated-images/harbour.png'];
    await held;
    // As the portal's own route answers: the browser may keep the file in the page, but is to ask again for it in another.
    await route.fulfill({ body: picture(...size), contentType: 'image/png', headers: { 'cache-control': 'private, no-cache' } });
  });
}

const preview = (page: Page, text: string) => page.locator('.image-preview', { hasText: text });
/** The call under the preview, which is what its Details open. */
const call = (page: Page, of: Locator) => page.locator('.picture-call', { has: of });
const shapeOf = async (frame: Locator) => {
  const box = (await frame.boundingBox())!;
  return box.width / box.height;
};

/**
 * The fixture, once the extension draws its calls: the page is loaded after the document, and the extension after
 * the page, and until then a call is the portal's plain card.
 */
async function open(page: Page) {
  await page.goto('/tests/extension.html?page=media/pictures');
  await expect(page.locator('.picture-call').first()).toBeAttached();
}

test.describe('in the chat', () => {
  test.beforeEach(async ({ page }) => {
    await folder(page, 'preview');
  });

  test('a picture being made is a preview in the shape of the coming picture, not a tool card', async ({ page }) => {
    await open(page);
    const making = preview(page, 'A foggy harbour');
    await expect(making).toHaveClass(/is-making/);
    await expect(making.getByRole('status')).toContainText('Making a picture');
    // The size the agent asked for, 1024x1536, is the shape of the frame, with nothing there yet.
    expect(await shapeOf(making.locator('.image-preview-frame'))).toBeCloseTo(2 / 3, 1);
    await expect(making.locator('img')).toHaveCount(0);

    // An edit shows the picture it is changing, in that picture's shape.
    const editing = preview(page, 'The dog in the snow');
    await expect(editing.getByRole('status')).toContainText('Editing a picture');
    await expect(editing.locator('.image-preview-before')).toHaveAttribute('src', /photos%2Fdog\.png/);
    await expect.poll(() => shapeOf(editing.locator('.image-preview-frame'))).toBeCloseTo(2, 1);

    // In place of the card, whose call is a click away: its name and what it was given.
    await expect(call(page, making)).toHaveCount(1);
    await making.getByRole('button', { name: 'Details' }).click();
    await expect(call(page, making).locator('.chat-tool-body')).toContainText('generate_image');
    await expect(call(page, making).locator('.chat-tool-body')).toContainText('A foggy harbour at first light');
    await expect(call(page, making).locator('.chat-tool-body')).toContainText('1024x1536');
  });

  test('the seconds of an edit are on a plate of their own, to be read over a picture that is bright or dark, in the light theme and the dark', async ({ page }) => {
    // WCAG's relative luminance and contrast, for colours as `rgb()` or `rgba()` says them.
    const channels = (css: string) => (css.match(/[\d.]+/g) ?? []).map(Number);
    const luminance = ([r, g, b]: number[]) => [r, g, b].map((c) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)).reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
    const contrast = (a: number[], b: number[]) => (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05);
    for (const scheme of ['light', 'dark'] as const) {
      for (const shade of [255, 0]) {
        // The original under the wait is as bright, or as dark, as a picture can be: the worst a plate has to hold against.
        await page.route('**/api/sessions/preview/picture?path=photos%2Fdog.png*', (route) => route.fulfill({ body: picture(200, 100, shade), contentType: 'image/png', headers: { 'cache-control': 'no-store' } }));
        await open(page);
        // The fixture has no theme of its own: the page's switch is the attribute the styles read.
        await page.evaluate((theme) => { document.documentElement.dataset.theme = theme; }, scheme);
        const editing = preview(page, 'The dog in the snow');
        await expect(editing.locator('.image-preview-frame')).toHaveClass(/has-before/);
        await expect(editing.locator('.image-preview-before')).toBeVisible();
        const seconds = editing.locator('.image-preview-making > small');
        await expect(seconds).toHaveText(/^\d+s$|^\d+:\d\d$/);
        const look = await seconds.evaluate((el) => {
          const css = getComputedStyle(el);
          return { color: css.color, background: css.backgroundColor, radius: parseFloat(css.borderTopLeftRadius), padding: parseFloat(css.paddingLeft) };
        });
        const name = `${scheme} theme over ${shade ? 'a white' : 'a black'} picture`;
        const [r, g, b, alpha = 1] = channels(look.background);
        // A surface of its own, nearly opaque, and a pill: not text on the picture.
        expect(alpha, name).toBeGreaterThanOrEqual(0.85);
        expect(look.padding, name).toBeGreaterThan(0);
        expect(look.radius, name).toBeGreaterThan(8);
        // What the plate comes to over the picture, and the text on that, as a reader of small text needs it.
        const plate = [r, g, b].map((c) => c * alpha + shade * (1 - alpha));
        expect(contrast(channels(look.color).slice(0, 3), plate), name).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  test('a picture that is made fills the frame it was given, and is a button for the viewer', async ({ page }) => {
    let release!: () => void;
    await folder(page, 'preview', new Promise<void>((resolve) => (release = resolve)));
    await open(page);
    const done = preview(page, 'A lighthouse at dusk');
    const frame = done.locator('.image-preview-frame');
    await expect(done).toHaveClass(/is-done/);
    // The size that was asked for holds its place while the picture is on its way.
    const before = (await frame.boundingBox())!;
    expect(before.width / before.height).toBeCloseTo(1.5, 1);
    await expect(frame).not.toHaveClass(/is-loaded/);

    release();
    await expect(frame).toHaveClass(/is-loaded/);
    await expect(done.getByRole('img', { name: 'A lighthouse at dusk' })).toBeVisible();
    // Where the guess was right, nothing moved.
    expect(await frame.boundingBox()).toEqual(before);
    await expect(done.getByRole('button', { name: 'A lighthouse at dusk' })).toHaveAttribute('aria-haspopup', 'dialog');
    await expect(done.getByRole('link')).toHaveCount(0);
    // From the history: it is there, it does not arrive.
    await expect(frame).not.toHaveClass(/is-arriving/);
  });

  test('a click on a finished picture opens it in the viewer, from the one download, and not in a tab of its own', async ({ page, context }) => {
    const asked: string[] = [];
    const tabs: string[] = [];
    page.on('request', (request) => { if (request.url().includes('picture?path=generated-images%2F')) asked.push(request.url()); });
    context.on('page', (tab) => tabs.push(tab.url()));
    await open(page);
    const done = preview(page, 'A lighthouse at dusk');
    await expect(done.locator('.image-preview-frame')).toHaveClass(/is-loaded/);
    const opener = done.locator('[data-picture-id]');
    await opener.click();
    const viewer = page.getByRole('dialog', { name: 'Picture viewer' });
    await expect(viewer).toBeVisible();
    // The preview's own address: the file is in the page already, and is not fetched again for the viewer.
    const shown = viewer.locator('img[data-picture]');
    await expect(shown).toHaveAttribute('src', (await done.locator('.image-preview-img').getAttribute('src'))!);
    await expect.poll(() => shown.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
    expect(asked.filter((url) => url.includes('lighthouse')), 'one download of the file').toHaveLength(1);
    expect(tabs).toEqual([]);

    // Out of the viewer, back to the picture it was opened from.
    await page.keyboard.press('Escape');
    await expect(viewer).toHaveCount(0);
    await expect(opener).toBeFocused();

    // One that was watched being made is the same once it has arrived, and the viewer has it with the others.
    await page.evaluate(() => (window as any).emit('tool_execution_end', (window as any).madePayload('making', 'generated-images/harbour.png', 'A foggy harbour')));
    const making = preview(page, 'A foggy harbour');
    await expect(making.locator('.image-preview-frame')).toHaveClass(/is-loaded/);
    await making.locator('[data-picture-id]').click();
    await expect(viewer.locator('img[data-picture]')).toHaveAttribute('alt', 'A foggy harbour');
    await expect(viewer.getByRole('button', { name: 'Previous picture' })).toBeEnabled();
    expect(asked.filter((url) => url.includes('harbour')), 'one download of the file').toHaveLength(1);
    expect(tabs).toEqual([]);
  });

  test('a call that made no picture says so quietly, with the reason, in place of the card', async ({ page }) => {
    await open(page);
    const failed = preview(page, 'A cat on a sofa');
    await expect(failed).toHaveClass(/is-failed/);
    await expect(failed.getByRole('status')).toContainText('No picture was made');
    await expect(failed).toContainText('The image endpoint answered 401: the key was refused');
    // A run that ended with the call open never heard of its end.
    const cut = preview(page, 'A castle in the clouds');
    await expect(cut).toHaveClass(/is-failed/);
    await expect(cut).toContainText('Interrupted before the picture arrived');

    // What was said is whole under Details.
    await failed.getByRole('button', { name: 'Details' }).click();
    await expect(call(page, failed).locator('pre.chat-tool-output')).toHaveText('The image endpoint answered 401: the key was refused');
  });

  test('the picture arrives in the place of the wait, and nothing under it moves', async ({ page }) => {
    await open(page);
    const making = preview(page, 'A foggy harbour');
    await expect(making).toHaveClass(/is-making/);
    await making.evaluate((el) => el.setAttribute('data-first', 'yes'));
    // How far the next thing in the chat is from it: where the chat is scrolled to is not what is asked.
    const next = preview(page, 'The dog in the snow');
    await expect.poll(() => shapeOf(next.locator('.image-preview-frame'))).toBeCloseTo(2, 1);
    const apart = async () => (await next.boundingBox())!.y - (await making.boundingBox())!.y;
    const was = await apart();

    await page.evaluate(() => (window as any).emit('tool_execution_end', (window as any).madePayload('making', 'generated-images/harbour.png', 'A foggy harbour')));
    // The same element, now with its picture, as high as the wait was.
    await expect(making).toHaveClass(/is-done/);
    await expect(making).toHaveAttribute('data-first', 'yes');
    await expect(making.locator('.image-preview-frame')).toHaveClass(/is-loaded/);
    await expect(making.getByRole('img', { name: 'A foggy harbour' })).toBeVisible();
    expect(await apart()).toBeCloseTo(was, 0);
    // The wait is taken away once the picture is there.
    await expect(making.locator('.image-preview-making, .image-preview-loading')).toHaveCount(0);
  });

  test('a picture whose call has ended is loading, not being made, however long the file takes to come', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('animations', 'on'));
    let release!: () => void;
    await folder(page, 'preview', new Promise<void>((resolve) => (release = resolve)));
    const asked = page.waitForRequest(/picture\?path=generated-images%2Fharbour\.png/);
    await open(page);
    await expect(page.locator('html')).toHaveAttribute('data-motion', 'fancy');
    const making = preview(page, 'A foggy harbour');
    await expect(making).toHaveClass(/is-making/);
    await expect(making.locator('.image-preview-making')).toHaveCount(1);

    // The call ends, as pi's does, and the turn does not: no agent_end comes, the file is held back.
    await page.evaluate(() => (window as any).emit('tool_execution_end', (window as any).madePayload('making', 'generated-images/harbour.png', 'A foggy harbour')));
    await expect(making).toHaveClass(/is-done/, { timeout: 1500 });
    // From that moment the wait is not "being made" any more, and nothing moves in it.
    await expect(making.locator('.image-preview-making')).toHaveCount(0);
    await expect(making.getByText('Making a picture')).toHaveCount(0);
    const loading = making.locator('.image-preview-loading');
    await expect(loading).toContainText('Loading the picture');
    await expect(making).toHaveAttribute('aria-busy', 'true');
    expect(await loading.evaluate((el) => getComputedStyle(el, '::before').animationName)).toBe('none');
    expect(await making.evaluate((el) => el.getAnimations({ subtree: true }).filter((a) => a.playState === 'running').length)).toBe(0);
    expect(await shapeOf(making.locator('.image-preview-frame'))).toBeCloseTo(2 / 3, 1);
    // The picture is asked for at once, not when the browser sees fit: the chat is waiting on it.
    await asked;
    await expect(making.locator('.image-preview-img')).toHaveAttribute('loading', 'eager');

    release();
    await expect(making.locator('.image-preview-frame')).toHaveClass(/is-loaded/);
    await expect(making.getByRole('img', { name: 'A foggy harbour' })).toBeVisible();
    await expect(making).toHaveAttribute('aria-busy', 'false');
    await expect(making.locator('.image-preview-loading')).toHaveCount(0);
    // One out of the history is not waited for: the browser may fetch it when it is near.
    await expect(preview(page, 'A lighthouse at dusk').locator('.image-preview-img')).toHaveAttribute('loading', 'lazy');
  });

  test('a picture that cannot be fetched after the call says so, and is not called gone from the folder', async ({ page }) => {
    await page.route('**/api/sessions/preview/picture?path=generated-images%2Fbroken.png**', (route) => route.abort());
    await page.route('**/api/sessions/preview/picture?path=generated-images%2Flighthouse.png**', (route) => route.abort());
    await open(page);
    const making = preview(page, 'A foggy harbour');
    await expect(making).toHaveClass(/is-making/);
    await page.evaluate(() => (window as any).emit('tool_execution_end', (window as any).madePayload('making', 'generated-images/broken.png', 'A foggy harbour')));
    await expect(making).toHaveClass(/is-failed/);
    await expect(making.getByRole('status')).toHaveText('The picture could not be loaded.');
    await expect(making).not.toContainText('no longer in the folder');
    await expect(making.locator('.image-preview-loading')).toHaveCount(0);

    // A picture from the history that is not there any more is gone from the folder.
    const old = preview(page, 'A lighthouse at dusk');
    await expect(old).toHaveClass(/is-failed/);
    await expect(old.getByRole('status')).toHaveText('This picture is no longer in the folder.');
  });

  test('what a screen reader is told is one status that stays, and changes with the picture', async ({ page }) => {
    let release!: () => void;
    await folder(page, 'preview', new Promise<void>((resolve) => (release = resolve)));
    await open(page);
    const making = preview(page, 'A foggy harbour');
    const status = making.locator('[role=status]');
    await expect(status).toHaveCount(1);
    await expect(status).toHaveText('Making a picture');
    await status.evaluate((el) => el.setAttribute('data-first', 'yes'));

    await page.evaluate(() => (window as any).emit('tool_execution_end', (window as any).madePayload('making', 'generated-images/harbour.png', 'A foggy harbour')));
    await expect(making).toHaveClass(/is-done/);
    release();
    // The same node, so that the change is read out: a status that comes with its words is not.
    await expect(status).toHaveText('The picture is ready');
    await expect(status).toHaveAttribute('data-first', 'yes');
    await expect(making.locator('[role=status]')).toHaveCount(1);
    // What the eye sees in the frame is not read twice.
    await expect(making.locator('.image-preview-frame [role=status]')).toHaveCount(0);
  });

  test('the way to a call\'s details is readable in both themes', async ({ page }) => {
    await open(page);
    const more = preview(page, 'A lighthouse at dusk').getByRole('button', { name: 'Details' });
    await expect(more).toBeVisible();
    // The colour against what it is drawn on, as WCAG measures them.
    const contrast = () => more.evaluate((el) => {
      const rgb = (css: string) => (css.match(/[\d.]+/g) ?? []).map(Number);
      const luminance = ([r, g, b]: number[]) => [r, g, b].map((c) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
      let back: number[] = [];
      for (let node: Element | null = el; node; node = node.parentElement) {
        const color = rgb(getComputedStyle(node).backgroundColor);
        if (color.length >= 3 && (color[3] ?? 1) > 0.99) { back = color; break; }
      }
      const a = luminance(rgb(getComputedStyle(el).color));
      const b = luminance(back);
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    });
    for (const theme of ['dark', 'light']) {
      await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
      // The colours ease over from the other theme's.
      await expect.poll(contrast, { message: theme }).toBeGreaterThanOrEqual(4.5);
    }
  });

  test('the calls of the picture tools are previews: made, not made, cut off, being made, and one that starts later from that moment', async ({ page }) => {
    await open(page);
    await expect(page.locator('.image-preview')).toHaveCount(5);
    await page.evaluate(() => (window as any).emit('tool_execution_start', (window as any).startPayload('late', 'generate_image', { prompt: 'A river at noon' })));
    await expect(preview(page, 'A river at noon')).toHaveClass(/is-making/);
  });

  test('a call of a picture tool through the tools tool, as a lazy one is made, is the preview a direct one is', async ({ page }) => {
    await open(page);
    const lazy = (toolCallId: string, args: unknown) =>
      page.evaluate(([id, call]) => (window as any).emit('tool_execution_start', (window as any).startPayload(id, 'tools', call)), [toolCallId, { action: 'call', ...(args as object) }] as const);
    await lazy('lazy-made', { name: 'generate_image', args: { prompt: 'A lighthouse at night', size: '1024x1536' } });
    // The gateway takes the arguments as the JSON text of an object as well.
    await lazy('lazy-text', { name: 'generate_image', args: JSON.stringify({ prompt: 'A lighthouse at noon', size: '1024x1536' }) });
    await lazy('lazy-edit', { name: 'edit_image', args: { path: 'photos/dog.png', prompt: 'Make it rain' } });
    for (const title of ['A lighthouse at night', 'A lighthouse at noon']) {
      const making = preview(page, title);
      await expect(making).toHaveClass(/is-making/);
      await expect(making.getByRole('status')).toContainText('Making a picture');
      expect(await shapeOf(making.locator('.image-preview-frame')), title).toBeCloseTo(2 / 3, 1);
    }
    const editing = preview(page, 'Make it rain');
    await expect(editing.getByRole('status')).toContainText('Editing a picture');
    await expect(editing.locator('.image-preview-before')).toHaveAttribute('src', /photos%2Fdog\.png/);
    await expect.poll(() => shapeOf(editing.locator('.image-preview-frame'))).toBeCloseTo(2, 1);
  });

  test('a picture of another shape than was asked for takes its own shape when it arrives', async ({ page }) => {
    await open(page);
    const editing = preview(page, 'The dog in the snow');
    await expect.poll(() => shapeOf(editing.locator('.image-preview-frame'))).toBeCloseTo(2, 1);
    // The result is square, whatever shape the original was.
    await page.route('**/api/sessions/preview/picture?path=generated-images%2Fdog-edited.png**', (route) => route.fulfill({ body: picture(120, 120), contentType: 'image/png' }));
    await page.evaluate(() => (window as any).emit('tool_execution_end', (window as any).madePayload('editing', 'generated-images/dog-edited.png', 'The dog in the snow')));
    await expect(editing.locator('.image-preview-frame')).toHaveClass(/is-loaded/);
    expect(await shapeOf(editing.locator('.image-preview-frame'))).toBeCloseTo(1, 1);
  });

  test('the animation of a picture being made plays only while the animations are on, and the placeholder is the same without it', async ({ page }) => {
    await open(page);
    const making = preview(page, 'A foggy harbour');
    await expect(making).toHaveClass(/is-making/);
    const look = () => making.evaluate((el) => {
      const wait = el.querySelector('.image-preview-making')!;
      const frame = el.querySelector('.image-preview-frame')!.getBoundingClientRect();
      return {
        light: getComputedStyle(wait, '::before').animationName,
        sheen: getComputedStyle(wait, '::after').animationName,
        mark: getComputedStyle(wait.querySelector('svg')!).animationName,
        going: el.getAnimations({ subtree: true }).filter((a) => a.playState === 'running').length,
        label: (wait.querySelector('span') as HTMLElement).textContent,
        shape: [Math.round(frame.width), Math.round(frame.height)],
      };
    });
    const html = page.locator('html');

    // The tests start with the switch off, as Settings would leave it: a still frame with its words.
    await expect(html).not.toHaveAttribute('data-motion', /.+/);
    const off = await look();
    expect(off).toMatchObject({ light: 'none', sheen: 'none', mark: 'none', going: 0, label: 'Making a picture' });

    // Switched on in this browser while the page is open: the same frame, moving.
    await page.evaluate(() => { localStorage.setItem('animations', 'on'); window.dispatchEvent(new StorageEvent('storage', { key: 'animations' })); });
    await expect(html).toHaveAttribute('data-motion', 'fancy');
    const on = await look();
    expect(on).toMatchObject({ light: 'fx-preview-drift', sheen: 'fx-preview-sheen', mark: 'fx-preview-breathe', label: 'Making a picture', shape: off.shape });
    expect(on.going).toBeGreaterThan(0);

    // The system's own wish for less motion wins over the switch.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect(html).not.toHaveAttribute('data-motion', /.+/);
    expect(await look()).toMatchObject({ light: 'none', sheen: 'none', mark: 'none', going: 0, label: 'Making a picture', shape: off.shape });
  });

  test('a picture arrives with a transition only while the animations are on, and only one that was watched being made', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('animations', 'on'));
    await open(page);
    await expect(page.locator('html')).toHaveAttribute('data-motion', 'fancy');
    const fade = (frame: Locator) => frame.locator('.image-preview-img').evaluate((img) => getComputedStyle(img).transitionDuration);
    // Out of the history: it is there.
    const old = preview(page, 'A lighthouse at dusk').locator('.image-preview-frame');
    await expect(old).toHaveClass(/is-loaded/);
    expect(await fade(old)).toBe('0s');
    // Made while it was watched: it fades in over the wait.
    const making = preview(page, 'A foggy harbour').locator('.image-preview-frame');
    await expect(making).toHaveClass(/is-arriving/);
    await page.evaluate(() => (window as any).emit('tool_execution_end', (window as any).madePayload('making', 'generated-images/harbour.png', 'A foggy harbour')));
    await expect(making.locator('.image-preview-img')).toHaveCount(1);
    expect(await fade(making)).toBe('0.7s, 0.9s');
    await expect(making).toHaveClass(/is-loaded/);
    // The wait stays under it for the fade, and then goes.
    await expect(making.locator('.image-preview-making, .image-preview-loading')).toHaveCount(0);
  });
});

/** Voice mode on the voice fixture, with the extension's cards. */
async function voiceMode(page: Page) {
  await page.route('**/api/sessions/test/commands', (route) => route.fulfill({ json: { commands: [] } }));
  await page.route('**/api/sessions/test/config', (route) => route.fulfill({ status: 503, json: {} }));
  await page.route('**/api/voice', (route) => route.fulfill({ json: { enabled: true } }));
  // A short phrase of silence, as the portal answers one: 24 kHz PCM.
  await page.route('**/voice/speech', (route) => route.fulfill({ body: Buffer.alloc(4800), headers: { 'content-type': 'audio/pcm', 'x-sample-rate': '24000' } }));
  await folder(page, 'test');
  await page.goto('/tests/extension.html?page=media/voice');
  await page.getByRole('button', { name: 'Turn on hands-free voice' }).click();
  await expect(page.getByRole('button', { name: 'End voice mode' })).toBeVisible({ timeout: 25000 });
}

test.describe('in voice mode', () => {
  test.beforeEach(async ({ page }) => voiceMode(page));

  test('the card of a picture shows the same preview as a tile: being made, made, not made', async ({ page }) => {
    await page.getByRole('button', { name: 'Start generating a picture' }).click();
    const card = page.locator('.voice-tool-float', { hasText: 'A foggy harbour at first light' });
    const tile = card.locator('.image-preview');
    await expect(tile).toHaveClass(/is-compact/);
    await expect(tile).toHaveClass(/is-making/);
    // The tile is where the card's mark was; with the animations off it is still.
    await expect(card.locator(':scope > svg')).toHaveCount(0);
    const light = () => tile.locator('.image-preview-making').evaluate((wait) => getComputedStyle(wait, '::before').animationName);
    expect(await light()).toBe('none');
    // As high as the card's text, not a picture's size: the card does not grow with it.
    expect((await tile.boundingBox())!.height).toBeLessThanOrEqual(48);
    // And it moves when the animations are on, as the one in the chat.
    await page.evaluate(() => { document.documentElement.dataset.motion = 'fancy'; });
    expect(await light()).toBe('fx-preview-drift');

    await page.getByRole('button', { name: 'Finish generating the picture' }).click();
    await expect(tile).toHaveClass(/is-done/);
    await expect(tile.locator('.image-preview-frame')).toHaveClass(/is-loaded/);
    // The card is the same card, and a tap on it still shows the picture.
    await expect(card).toHaveAttribute('title', 'Show the picture');

    await page.getByRole('button', { name: 'Fail generating a picture' }).click();
    const failed = page.locator('.voice-tool-float', { hasText: 'A castle in the clouds' });
    await expect(failed.locator('.image-preview')).toHaveClass(/is-failed/);
    await expect(failed).toContainText('Failed: The image endpoint answered 401');
  });

  test('the picture of a call that ends is fetched once in voice mode, for the chat behind the stage, the card and the picture window', async ({ page }) => {
    // Three places draw it, and the browser shares one download between them only when they ask for the same address. On a slow link three at once is a picture three times later, and the speech requests queued behind them.
    const asked: string[] = [];
    page.on('request', (request) => { if (request.url().includes('picture?path=generated-images%2Fimage-20261001-101600-d4e5f6.png')) asked.push(request.url()); });
    await page.getByRole('button', { name: 'Start generating a picture' }).click();
    await page.getByRole('button', { name: 'Finish generating the picture' }).click();
    const tile = page.locator('.voice-tool-float', { hasText: 'A foggy harbour at first light' }).locator('.image-preview');
    await expect(tile.locator('.image-preview-frame')).toHaveClass(/is-loaded/);
    // The others have had their time to ask.
    await page.waitForTimeout(700);
    expect(asked).toHaveLength(1);
  });
});
