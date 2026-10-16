import { type Locator, type Page } from '@playwright/test';
import { test, expect, mockPortal, DONE } from './portal-mock';

/**
 * The picture viewer in the chat (core/web/src/components/ImageViewer.tsx) over the fixture's
 * four pictures (core/web/tests/chat.tsx, `phase=pictures`): one the person sent, one the agent
 * made, one it made from that, and one it showed without a title.
 */

const svg = (w: number, h: number, fill: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="100%" height="100%" fill="${fill}"/><circle cx="${w / 2}" cy="${h / 2}" r="${Math.min(w, h) / 4}" fill="white"/></svg>`;
/** The size each picture has, so that what is fitted and what is real size are not the same. */
const folder: Record<string, [number, number, string]> = {
  'generated-images/lighthouse.png': [1600, 1000, '#335'],
  'generated-images/lighthouse-edited.png': [800, 500, '#35a'],
  'docs/diagram.png': [400, 300, '#363'],
};

const URL = '/tests/chat.html?phase=pictures';

async function open(page: Page, { broken = [] as string[], held = [] as string[], until = Promise.resolve() } = {}) {
  await page.route('**/api/sessions/preview/picture?**', async (route) => {
    const path = new globalThis.URL(route.request().url()).searchParams.get('path')!;
    if (broken.includes(path)) return route.fulfill({ status: 404, body: 'gone' });
    // A slow link: these arrive when the test lets them.
    if (held.includes(path)) await until;
    const [w, h, fill] = folder[path];
    return route.fulfill({ body: svg(w, h, fill), contentType: 'image/svg+xml' }).catch(() => {});
  });
  await page.route('**/api/sessions/preview/images/**', (route) => route.fulfill({ body: svg(300, 300, '#a53'), contentType: 'image/svg+xml' }));
  await page.goto(URL);
}

/** A picture of the conversation, by what it shows. */
const thumb = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
const viewer = (page: Page) => page.getByRole('dialog', { name: 'Picture viewer' });
const shown = (page: Page) => viewer(page).locator('img[data-picture]');

async function loaded(image: Locator) {
  await expect.poll(() => image.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth > 0)).toBe(true);
}

/** Where the picture lies once it has stopped moving: the stage is measured again as the page behind it stops scrolling. */
async function settled(image: Locator) {
  let last = '';
  await expect.poll(async () => {
    const now = JSON.stringify(await image.boundingBox());
    const same = now === last;
    last = now;
    return same;
  }).toBe(true);
  return (await image.boundingBox())!;
}

/** A finger drawn sideways across the stage, quick: left is the next picture, right the one before. */
const swipe = (page: Page, dx: number) =>
  page.evaluate((dx) => {
    const stage = document.querySelector('.image-viewer-stage')!;
    const r = stage.getBoundingClientRect();
    const [x, y] = [r.left + r.width / 2, r.top + r.height / 2];
    const fire = (type: string, clientX: number) => stage.dispatchEvent(new PointerEvent(type, { pointerId: 7, pointerType: 'touch', isPrimary: true, bubbles: true, clientX, clientY: y, button: 0 }));
    fire('pointerdown', x);
    fire('pointermove', x + dx / 2);
    fire('pointermove', x + dx);
    fire('pointerup', x + dx);
  }, dx);

/** A button that turns disabled, or goes, loses focus to the page when the browser next draws. */
const afterDraw = (page: Page) => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));

/** The pictures drawn in the chat, loaded: the page loads them as they come near. */
async function drawn(page: Page) {
  for (const name of ['A lighthouse at dusk', 'The lighthouse, in blue', 'docs/diagram.png', 'A picture sent with this message']) {
    const img = thumb(page, name).locator('img');
    await img.scrollIntoViewIfNeeded();
    await loaded(img);
  }
}

test('a click on a picture opens it over the chat, whole and captioned, and no tab of its own', async ({ page, context }) => {
  const tabs: string[] = [];
  context.on('page', (p) => tabs.push(p.url()));
  page.on('popup', (p) => tabs.push(p.url()));
  await open(page);
  await drawn(page);
  await expect(viewer(page)).toBeHidden();
  await thumb(page, 'A lighthouse at dusk').click();
  const dialog = viewer(page);
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute('aria-modal', 'true');
  // The picture itself, from the same address as in the conversation, and its title under it.
  await expect(shown(page)).toHaveAttribute('src', /\/api\/sessions\/preview\/picture\?path=generated-images%2Flighthouse\.png/);
  await expect(dialog).toContainText('A lighthouse at dusk');
  await expect(dialog.getByText('2 / 4', { exact: true })).toBeVisible();
  await loaded(shown(page));
  // Fitted to the screen: all of it inside the window, with room to spare for the controls.
  const box = (await shown(page).boundingBox())!;
  const win = page.viewportSize()!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(win.width);
  expect(box.y + box.height).toBeLessThan(win.height);
  expect(Math.abs(box.width / box.height - 1.6)).toBeLessThan(0.01);
  // Still on the chat, and nothing opened beside it.
  expect(new globalThis.URL(page.url()).pathname).toBe('/tests/chat.html');
  await page.waitForTimeout(300);
  expect(tabs).toEqual([]);
  // A picture the person sent opens the same way.
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await thumb(page, 'A picture sent with this message').click();
  await expect(shown(page)).toHaveAttribute('src', /\/images\/sketch\.png/);
  await expect(dialog.getByText('1 / 4', { exact: true })).toBeVisible();
});

test('it closes with Escape, the close button and a click beside the picture, and focus goes back to the picture', async ({ page }) => {
  await open(page);
  await drawn(page);
  const lighthouse = thumb(page, 'A lighthouse at dusk');

  await lighthouse.click();
  await expect(viewer(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(viewer(page)).toBeHidden();
  await expect(lighthouse).toBeFocused();

  await lighthouse.click();
  await viewer(page).getByRole('button', { name: 'Close' }).click();
  await expect(viewer(page)).toBeHidden();
  await expect(lighthouse).toBeFocused();

  // On the empty stage beside the picture.
  await lighthouse.click();
  const stage = (await viewer(page).locator('.image-viewer-stage').boundingBox())!;
  const picture = await settled(shown(page));
  // The corner of the stage: the picture is wider than tall here, and the arrows are at the sides, in the middle.
  const beside = { x: stage.x + 5, y: stage.y + 5 };
  expect(picture.x).toBeGreaterThan(beside.x + 20);
  // On the picture itself, a click leaves it open.
  await page.mouse.click(picture.x + picture.width / 2, picture.y + picture.height / 2);
  await expect(viewer(page)).toBeVisible();
  await page.mouse.click(beside.x, beside.y);
  await expect(viewer(page)).toBeHidden();
  await expect(lighthouse).toBeFocused();
  // And the click did not go through to what was under it.
  await page.waitForTimeout(200);
  await expect(viewer(page)).toBeHidden();
});

test("the browser's back button closes it on a phone, and the chat stays; any other way out leaves no step behind", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('about:blank');
  await open(page);
  await drawn(page);
  await thumb(page, 'A lighthouse at dusk').click();
  await expect(viewer(page)).toBeVisible();
  await page.goBack();
  await expect(viewer(page)).toBeHidden();
  // Not the page before the chat: the chat, as it was.
  expect(new globalThis.URL(page.url()).pathname).toBe('/tests/chat.html');
  await expect(thumb(page, 'A lighthouse at dusk')).toBeVisible();

  // Closed by the button, the step it made is taken off again: back now leaves the chat.
  await thumb(page, 'A lighthouse at dusk').click();
  await viewer(page).getByRole('button', { name: 'Close' }).click();
  await expect(viewer(page)).toBeHidden();
  await expect.poll(() => page.evaluate(() => history.state?.pithagorasOverlay ?? null)).toBeNull();
  await page.goBack();
  await expect.poll(() => page.url()).toBe('about:blank');
});

test('reloaded with a picture open, one press of back leaves the chat', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('about:blank');
  await open(page);
  await drawn(page);
  await thumb(page, 'A lighthouse at dusk').click();
  await expect(viewer(page)).toBeVisible();
  await page.reload();
  await expect(thumb(page, 'A lighthouse at dusk')).toBeVisible();
  await expect(viewer(page)).toBeHidden();
  // What the viewer had pushed is not left behind to be pressed through (the page may load once more as it is taken off).
  await expect.poll(() => page.evaluate(() => history.state?.pithagorasOverlay ?? null).catch(() => 'loading')).toBeNull();
  await expect(thumb(page, 'A lighthouse at dusk')).toBeVisible();
  await page.goBack();
  await expect.poll(() => page.url()).toBe('about:blank');
});

test('Left and Right, the arrows and a swipe step through the pictures, and stop at the ends', async ({ page }) => {
  await open(page);
  await drawn(page);
  await thumb(page, 'A lighthouse at dusk').click();
  const dialog = viewer(page);
  const prev = dialog.getByRole('button', { name: 'Previous picture' });
  const next = dialog.getByRole('button', { name: 'Next picture' });
  await expect(dialog.getByText('2 / 4', { exact: true })).toBeVisible();

  await page.keyboard.press('ArrowRight');
  await expect(dialog.getByText('3 / 4', { exact: true })).toBeVisible();
  await expect(shown(page)).toHaveAttribute('src', /lighthouse-edited\.png/);
  await expect(dialog).toContainText('The lighthouse, in blue');
  // A picture without a title has no caption, and is told by its path.
  await next.click();
  await expect(dialog.getByText('4 / 4', { exact: true })).toBeVisible();
  await expect(shown(page)).toHaveAttribute('alt', 'docs/diagram.png');
  await expect(next).toBeDisabled();
  await page.keyboard.press('ArrowRight');
  await expect(dialog.getByText('4 / 4', { exact: true })).toBeVisible();

  await prev.click();
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await expect(dialog.getByText('1 / 4', { exact: true })).toBeVisible();
  await expect(prev).toBeDisabled();
  await expect(shown(page)).toHaveAttribute('src', /\/images\/sketch\.png/);

  // A swipe with a finger, sideways: left for the next, right for the one before.
  await expect(dialog.getByRole('button', { name: 'Show the picture at full size' })).toHaveText(/\d+%/);
  await swipe(page, -160);
  await expect(dialog.getByText('2 / 4', { exact: true })).toBeVisible();
  await swipe(page, 160);
  await expect(dialog.getByText('1 / 4', { exact: true })).toBeVisible();
  // Too short to be one.
  await swipe(page, -20);
  await expect(dialog.getByText('1 / 4', { exact: true })).toBeVisible();

  // Closed after stepping, focus is on the picture that was last shown.
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect(dialog.getByText('3 / 4', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(thumb(page, 'The lighthouse, in blue')).toBeFocused();
});

test('a swipe goes on from a picture that is still coming, or never came', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  // The edited picture is slow, and the last is gone.
  let arrive!: () => void;
  const late = new Promise<void>((resolve) => (arrive = resolve));
  await open(page, { broken: ['docs/diagram.png'], held: ['generated-images/lighthouse-edited.png'], until: late });
  const first = thumb(page, 'A lighthouse at dusk').locator('img');
  await first.scrollIntoViewIfNeeded();
  await loaded(first);
  await thumb(page, 'A lighthouse at dusk').click();
  const dialog = viewer(page);
  await expect(dialog.getByRole('button', { name: 'Show the picture at full size' })).toHaveText(/\d+%/);

  await swipe(page, -160);
  await expect(dialog.getByText('3 / 4', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Show the picture at full size' })).toHaveText('');
  // Still coming, and the next swipe is not lost on it.
  await swipe(page, -160);
  await expect(dialog.getByText('4 / 4', { exact: true })).toBeVisible();
  await expect(dialog).toContainText('The picture could not be loaded.');
  // Nor on the one that did not come.
  await swipe(page, 160);
  await expect(dialog.getByText('3 / 4', { exact: true })).toBeVisible();
  await swipe(page, 160);
  await expect(dialog.getByText('2 / 4', { exact: true })).toBeVisible();
  arrive();
});

test('focus stays in the dialog when an arrow is used up at an end of the list', async ({ page }) => {
  await open(page);
  await drawn(page);
  await thumb(page, 'The lighthouse, in blue').click();
  const dialog = viewer(page);
  const prev = dialog.getByRole('button', { name: 'Previous picture' });
  const next = dialog.getByRole('button', { name: 'Next picture' });
  await expect(dialog.getByText('3 / 4', { exact: true })).toBeVisible();

  await next.focus();
  await page.keyboard.press('Enter');
  await expect(dialog.getByText('4 / 4', { exact: true })).toBeVisible();
  await expect(next).toBeDisabled();
  await afterDraw(page);
  await expect(dialog).toBeFocused();
  // Still the keyboard's: Tab goes on from there.
  await page.keyboard.press('Tab');
  await expect(dialog.locator(':focus')).toHaveCount(1);

  await prev.focus();
  for (let i = 0; i < 3; i++) await page.keyboard.press('Enter');
  await expect(dialog.getByText('1 / 4', { exact: true })).toBeVisible();
  await expect(prev).toBeDisabled();
  await afterDraw(page);
  await expect(dialog).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});

test('focus stays in the dialog when the control that has it is disabled or goes away', async ({ page }) => {
  await open(page);
  await drawn(page);
  await thumb(page, 'A lighthouse at dusk').click();
  const dialog = viewer(page);
  const button = (name: string) => dialog.getByRole('button', { name });
  await expect(button('Show the picture at full size')).toHaveText(/\d+%/);

  // Zoomed in with the keyboard and out again: the picture is whole, and Zoom out is no more to be used.
  await button('Zoom in').focus();
  await page.keyboard.press('Enter');
  await expect(button('Zoom out')).toBeEnabled();
  await button('Zoom out').focus();
  await page.keyboard.press('Enter');
  await expect(button('Zoom out')).toBeDisabled();
  await afterDraw(page);
  await expect(dialog).toBeFocused();

  // Original and Edited version are there only for a picture that has one.
  await page.keyboard.press('ArrowRight');
  await expect(dialog.getByText('3 / 4', { exact: true })).toBeVisible();
  await button('Show the original').focus();
  await page.keyboard.press('Enter');
  await expect(dialog.getByText('2 / 4', { exact: true })).toBeVisible();
  await expect(button('Show the original')).toHaveCount(0);
  await afterDraw(page);
  await expect(dialog).toBeFocused();

  await button('Show the edited version').focus();
  await page.keyboard.press('ArrowLeft');
  await expect(dialog.getByText('1 / 4', { exact: true })).toBeVisible();
  await expect(button('Show the edited version')).toHaveCount(0);
  await afterDraw(page);
  await expect(dialog).toBeFocused();
});

test('an edit and the picture it was made from reach each other', async ({ page }) => {
  await open(page);
  await drawn(page);
  await thumb(page, 'The lighthouse, in blue').click();
  const dialog = viewer(page);
  await expect(dialog.getByText('3 / 4', { exact: true })).toBeVisible();
  // Given as an absolute path in the folder, and found all the same.
  await dialog.getByRole('button', { name: 'Show the original' }).click();
  await expect(dialog.getByText('2 / 4', { exact: true })).toBeVisible();
  await expect(dialog).toContainText('A lighthouse at dusk');
  await expect(dialog.getByRole('button', { name: 'Show the original' })).toBeHidden();
  await dialog.getByRole('button', { name: 'Show the edited version' }).click();
  await expect(dialog.getByText('3 / 4', { exact: true })).toBeVisible();
  // The others are tied to nothing.
  await page.keyboard.press('ArrowRight');
  await expect(dialog.getByRole('button', { name: /original|edited version/i })).toHaveCount(0);
});

test('the wheel, a double click and the buttons zoom; a drag moves a zoomed picture; Zoom out and 0 fit it again', async ({ page }) => {
  await open(page);
  await drawn(page);
  await thumb(page, 'A lighthouse at dusk').click();
  const dialog = viewer(page);
  const image = shown(page);
  await loaded(image);
  const percent = dialog.getByRole('button', { name: /^(Fit the picture|Show the picture at full size)$/ });
  const fit = await settled(image);
  // The picture is 1600 wide: whole, it is shown smaller than it is.
  expect(fit.width).toBeLessThan(1600);
  await expect(percent).toHaveAccessibleName('Show the picture at full size');
  await expect(dialog.getByRole('button', { name: 'Zoom out' })).toBeDisabled();

  // The wheel zooms in on the spot it is over.
  await page.mouse.move(fit.x + fit.width * 0.75, fit.y + fit.height / 2);
  await page.mouse.wheel(0, -300);
  await expect.poll(async () => (await image.boundingBox())!.width).toBeGreaterThan(fit.width * 1.3);
  await expect(percent).toHaveAccessibleName('Fit the picture');
  await expect(dialog.getByRole('button', { name: 'Zoom out' })).toBeEnabled();

  // A double click goes back to whole, and the next to the picture's own size, one pixel to one.
  const middle = { x: fit.x + fit.width / 2, y: fit.y + fit.height / 2 };
  await page.mouse.dblclick(middle.x, middle.y);
  await expect.poll(async () => Math.round((await image.boundingBox())!.width)).toBe(Math.round(fit.width));
  await page.mouse.dblclick(middle.x, middle.y);
  await expect.poll(async () => Math.round((await image.boundingBox())!.width)).toBe(1600);
  await expect(percent).toHaveText('100%');

  // At its own size it is bigger than the stage: a drag moves it, and only as far as its edge.
  const before = (await image.boundingBox())!;
  await page.mouse.move(middle.x, middle.y);
  await page.mouse.down();
  await page.mouse.move(middle.x + 60, middle.y + 30, { steps: 4 });
  await page.mouse.up();
  const after = (await image.boundingBox())!;
  expect(Math.round(after.x - before.x)).toBe(60);
  expect(Math.round(after.y - before.y)).toBe(30);
  // A drag is not a click beside the picture: the viewer is still there.
  await expect(dialog).toBeVisible();
  await page.mouse.move(middle.x, middle.y);
  await page.mouse.down();
  await page.mouse.move(middle.x + 500, middle.y, { steps: 2 });
  await page.mouse.up();
  expect((await image.boundingBox())!.x).toBeCloseTo((await dialog.locator('.image-viewer-stage').boundingBox())!.x, 0);

  // The buttons and the keys.
  await dialog.getByRole('button', { name: 'Fit the picture' }).click();
  await expect.poll(async () => Math.round((await image.boundingBox())!.width)).toBe(Math.round(fit.width));
  await dialog.getByRole('button', { name: 'Zoom in' }).click();
  await expect.poll(async () => (await image.boundingBox())!.width).toBeCloseTo(fit.width * 1.5, 0);
  await page.keyboard.press('+');
  await expect.poll(async () => (await image.boundingBox())!.width).toBeCloseTo(fit.width * 2.25, 0);
  await page.keyboard.press('-');
  await expect.poll(async () => (await image.boundingBox())!.width).toBeCloseTo(fit.width * 1.5, 0);
  await page.keyboard.press('0');
  await expect.poll(async () => Math.round((await image.boundingBox())!.width)).toBe(Math.round(fit.width));
});

test('a pinch zooms and the second tap of a double tap goes to the picture\'s own size', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page);
  await drawn(page);
  await thumb(page, 'A lighthouse at dusk').click();
  const image = shown(page);
  await loaded(image);
  const fit = await settled(image);
  // The whole 1600 pixels in 390: fitted, a double tap shows it as it is.
  expect(fit.width).toBeLessThanOrEqual(390);
  const touch = (type: string, id: number, x: number, y: number) =>
    page.evaluate(([type, id, x, y]) => {
      // What a finger would have touched: the picture, or the stage beside it.
      const touched = document.elementFromPoint(x as number, y as number)!;
      touched.dispatchEvent(new PointerEvent(type as string, { pointerId: id as number, pointerType: 'touch', isPrimary: id === 1, bubbles: true, clientX: x as number, clientY: y as number, button: 0 }));
    }, [type, id, x, y] as const);
  const [cx, cy] = [fit.x + fit.width / 2, fit.y + fit.height / 2];
  // Two fingers moving apart.
  await touch('pointerdown', 1, cx - 30, cy);
  await touch('pointerdown', 2, cx + 30, cy);
  await touch('pointermove', 1, cx - 90, cy);
  await touch('pointermove', 2, cx + 90, cy);
  await touch('pointerup', 1, cx - 90, cy);
  await touch('pointerup', 2, cx + 90, cy);
  await expect.poll(async () => (await image.boundingBox())!.width).toBeGreaterThan(fit.width * 2.5);
  // Fitted again with the button; then a double tap.
  await viewer(page).getByRole('button', { name: 'Fit the picture' }).click();
  await expect.poll(async () => Math.round((await image.boundingBox())!.width)).toBe(Math.round(fit.width));
  await touch('pointerdown', 3, cx, cy);
  await touch('pointerup', 3, cx, cy);
  await touch('pointerdown', 3, cx, cy);
  await touch('pointerup', 3, cx, cy);
  await expect.poll(async () => Math.round((await image.boundingBox())!.width)).toBe(1600);
});

test('it is a dialog: the keyboard stays inside it, the page behind does not scroll, and what has it is told', async ({ page }) => {
  await open(page);
  await drawn(page);
  const scroll = () => page.evaluate(() => [getComputedStyle(document.documentElement).overflow, getComputedStyle(document.body).overflow]);
  const [htmlBefore, bodyBefore] = await scroll();
  await thumb(page, 'A lighthouse at dusk').click();
  const dialog = viewer(page);
  await expect(dialog).toBeFocused();
  expect(await scroll()).toEqual(['hidden', 'hidden']);
  // The dialog is on its own, not inside the chat, so that nothing of the chat is over it.
  expect(await dialog.evaluate((d) => d.closest('#root') === null)).toBe(true);
  // Tab goes round, both ways, and never out into the chat behind.
  const inside = () => page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'));
  for (let i = 0; i < 14; i++) {
    await page.keyboard.press('Tab');
    expect(await inside()).toBe(true);
  }
  for (let i = 0; i < 14; i++) {
    await page.keyboard.press('Shift+Tab');
    expect(await inside()).toBe(true);
  }
  // Something outside that takes focus is not allowed to keep it.
  await page.evaluate(() => (document.querySelector('textarea') as HTMLTextAreaElement | null)?.focus());
  expect(await inside()).toBe(true);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  expect(await scroll()).toEqual([htmlBefore, bodyBefore]);
});

test('the pictures in the conversation are in the middle of the column, with the same room above and below, wide and narrow', async ({ page }) => {
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await open(page);
    await drawn(page);
    const column = (await page.locator('.chat-list').boundingBox())!;
    for (const name of ['A lighthouse at dusk', 'The lighthouse, in blue', 'docs/diagram.png']) {
      const picture = thumb(page, name);
      await picture.scrollIntoViewIfNeeded();
      const box = (await picture.boundingBox())!;
      // Whole in the column, and its middle on the column's.
      expect(box.x, `${name} at ${width}`).toBeGreaterThanOrEqual(column.x - 0.5);
      expect(box.x + box.width, `${name} at ${width}`).toBeLessThanOrEqual(column.x + column.width + 0.5);
      expect(Math.abs(box.x + box.width / 2 - (column.x + column.width / 2)), `${name} at ${width}`).toBeLessThan(1);
      // Between what is above it and what is below it, the same room.
      const [above, below] = await picture.evaluate((el) => {
        const row = el.closest('.chat-picture');
        // A picture the agent made or changed is a preview (ImagePreview), whose room is the chat's own spacing; it is in the middle, which is checked above.
        if (!row) return [NaN, NaN];
        const [before, after] = [row.previousElementSibling!.getBoundingClientRect(), (row.parentElement!.nextElementSibling ?? row).getBoundingClientRect()];
        const own = row.getBoundingClientRect();
        return [own.top - before.bottom, after === own ? NaN : after.top - own.bottom];
      });
      if (!Number.isNaN(below)) expect(Math.abs(above - below), `${name} at ${width}`).toBeLessThan(1.5);
      if (!Number.isNaN(above)) expect(above, `${name} at ${width}`).toBeGreaterThanOrEqual(8);
    }
    // Contained, not cropped: a picture 1600 wide is not wider than the column.
    const wide = (await thumb(page, 'A lighthouse at dusk').locator('img').boundingBox())!;
    expect(wide.width).toBeLessThanOrEqual(column.width + 0.5);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
});

test('the viewer is as wide as the window on a phone, with the controls inside it', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 640 });
  await open(page);
  await drawn(page);
  await thumb(page, 'A lighthouse at dusk').click();
  const dialog = viewer(page);
  await loaded(shown(page));
  const win = page.viewportSize()!;
  const card = (await dialog.boundingBox())!;
  expect([card.x, card.y, card.width, card.height]).toEqual([0, 0, win.width, win.height]);
  // Every control is on the screen, and big enough for a finger.
  for (const button of await dialog.getByRole('button').all()) {
    const b = (await button.boundingBox())!;
    expect(b.x).toBeGreaterThanOrEqual(0);
    expect(b.x + b.width).toBeLessThanOrEqual(win.width);
    expect(b.y + b.height).toBeLessThanOrEqual(win.height);
    expect(Math.min(b.width, b.height)).toBeGreaterThanOrEqual(39);
  }
  for (const link of await dialog.getByRole('link').all()) {
    const b = (await link.boundingBox())!;
    expect(b.x + b.width).toBeLessThanOrEqual(win.width);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('Open in a new tab and Download are there for the file itself, and are the only way a tab opens', async ({ page }) => {
  await open(page);
  await drawn(page);
  await thumb(page, 'A lighthouse at dusk').click();
  const dialog = viewer(page);
  const tab = dialog.getByRole('link', { name: 'Open in a new tab' });
  await expect(tab).toHaveAttribute('target', '_blank');
  await expect(tab).toHaveAttribute('href', /picture\?path=generated-images%2Flighthouse\.png/);
  const save = dialog.getByRole('link', { name: 'Download the picture' });
  await expect(save).toHaveAttribute('download', 'lighthouse.png');
  await expect(save).toHaveAttribute('href', /picture\?path=generated-images%2Flighthouse\.png/);
});

test('a picture that cannot be loaded says so, and the viewer still closes', async ({ page }) => {
  await open(page, { broken: ['docs/diagram.png'] });
  await thumb(page, 'docs/diagram.png').click();
  await expect(viewer(page)).toContainText('The picture could not be loaded.');
  await page.keyboard.press('Escape');
  await expect(viewer(page)).toBeHidden();
});

/**
 * The whole app over canned answers: the chats `ids`, each with the one picture the agent made. The dev server
 * runs React's strict mode, which opens what it draws, closes it and opens it again at once, and the router
 * is there to be left by the back button.
 */
async function openApp(page: Page, ids: string[], { collapsed = true } = {}) {
  const at = new Date().toISOString();
  const chats = ids.map((id) => ({ id, title: `Lighthouses ${id}`, workspace: `/w/${id}`, status: 'idle', kind: 'task', pinned: false, updated_at: at, provider: null, model: null, thinking_level: null }));
  let seq = 0;
  const ev = (type: string, payload: object = {}) => ({ seq: ++seq, type, at: Date.now() - 60_000 + seq * 1000, payload });
  const events = [
    ev('portal_prompt', { message: 'Paint a lighthouse.' }),
    ev('tool_execution_start', { toolCallId: 'g1', toolName: 'generate_image', args: { prompt: 'A lighthouse' } }),
    ev('tool_execution_end', { toolCallId: 'g1', toolName: 'generate_image', result: { content: [{ type: 'text', text: 'Generated' }], details: { files: [{ path: 'generated-images/lighthouse.png', title: 'A lighthouse at dusk' }] } }, portalFiles: [{ path: 'generated-images/lighthouse.png', kind: 'picture', title: 'A lighthouse at dusk' }] }),
    ev('message_end', { message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] } }),
    ev('agent_end'),
  ];
  const tabs: string[] = [];
  page.on('popup', (p) => tabs.push(p.url()));
  // React says what it did not like (a key, an effect that ran twice) on the console.
  const failures: string[] = [];
  page.on('pageerror', (e) => failures.push(e.message));
  page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && failures.push(m.text()));
  await mockPortal(page, async ({ path: p, route }) => {
    if (p === '/api/sessions') return { sessions: chats, executor: 'host' };
    if (/^\/api\/sessions\/\w+$/.test(p)) return chats.find((c) => p.endsWith(`/${c.id}`)) ?? {};
    if (/^\/api\/sessions\/\w+\/picture$/.test(p)) {
      await route.fulfill({ body: svg(1600, 1000, '#335'), contentType: 'image/svg+xml' });
      return DONE;
    }
    if (/^\/api\/sessions\/\w+\/(config|models)$/.test(p)) return { live: false, state: { model: { id: 'm', name: 'Model', provider: 'x' }, thinkingLevel: 'medium' }, stats: null, thinking: { levels: ['off', 'medium'] }, models: { models: [] }, named: { provider: null, model: null } };
  }, { streams: 'none', settings: true });
  await page.addInitScript(({ events, collapsed }) => {
    if (collapsed) localStorage.setItem('sidebarCollapsed', 'true');
    (window as any).EventSource = class {
      closed = false; onmessage: any; onopen: any; listeners: Record<string, ((e: any) => void)[]> = {};
      constructor() {
        setTimeout(() => {
          if (this.closed) return;
          this.onopen?.();
          for (const e of events) this.onmessage?.({ data: JSON.stringify(e) });
          (this.listeners['caught-up'] ?? []).forEach((fn) => fn({ data: JSON.stringify({ seq: events.at(-1)!.seq }) }));
        }, 30);
      }
      addEventListener(n: string, fn: (e: any) => void) { (this.listeners[n] ??= []).push(fn); }
      close() { this.closed = true; }
    };
  }, { events, collapsed });
  return { tabs, failures };
}

/** Back is the way out of a picture on a phone, and in the app the router and strict mode are both in the way. */
test('in the app on a phone, the viewer opens over the chat and the back button closes it without leaving the chat', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { tabs, failures } = await openApp(page, ['a']);
  await page.goto('/s/a');
  const picture = thumb(page, 'A lighthouse at dusk');
  await expect(picture).toBeVisible();
  await loaded(picture.locator('img'));
  await picture.click();
  await expect(viewer(page)).toBeVisible();
  await expect(viewer(page)).toContainText('A lighthouse at dusk');
  // The chat is where it was, and no tab was opened.
  expect(tabs).toEqual([]);
  expect(new globalThis.URL(page.url()).pathname).toBe('/s/a');
  await page.goBack();
  await expect(viewer(page)).toBeHidden();
  expect(new globalThis.URL(page.url()).pathname).toBe('/s/a');
  await expect(picture).toBeVisible();
  await expect(picture).toBeFocused();
  // Opened again, and closed by Escape: one back from here leaves the chat, not a leftover step of the viewer's.
  const before = await page.evaluate(() => history.length);
  await picture.click();
  await expect(viewer(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(viewer(page)).toBeHidden();
  await expect.poll(() => page.evaluate(() => history.state?.pithagorasOverlay ?? null)).toBeNull();
  expect(await page.evaluate(() => history.length)).toBeLessThanOrEqual(before + 1);
  expect(failures).toEqual([]);
});

test('left for another chat with the viewer open, it is not open again on coming back', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  // The entries the viewer puts on the history.
  await page.addInitScript(() => {
    (window as any).overlays = 0;
    const push = history.pushState.bind(history);
    history.pushState = (state, ...rest) => {
      if (state?.pithagorasOverlay) (window as any).overlays++;
      return push(state, ...rest);
    };
  });
  const { failures } = await openApp(page, ['a', 'b'], { collapsed: false });
  await page.goto('/s/a');
  const picture = thumb(page, 'A lighthouse at dusk');
  await loaded(picture.locator('img'));
  await picture.click();
  await expect(viewer(page)).toBeVisible();
  // The way a notification takes you to a chat that finished: the router goes there, and no back button is pressed.
  const go = (id: string) => page.evaluate((id) => (document.querySelector(`[data-flip="${id}"]`) as HTMLElement).click(), id);
  await go('b');
  await expect(page).toHaveURL(/\/s\/b$/);
  await expect(viewer(page)).toBeHidden();
  await go('a');
  await expect(page).toHaveURL(/\/s\/a$/);
  await expect(picture).toBeVisible();
  await page.waitForTimeout(400);
  await expect(viewer(page)).toBeHidden();
  expect(await page.evaluate(() => (window as any).overlays)).toBe(1);
  expect(failures).toEqual([]);
});

test.describe('motion', () => {
  const animated = { cookies: [], origins: [{ origin: 'http://127.0.0.1:5191', localStorage: [{ name: 'animations', value: 'on' }] }] };
  const frame = (page: Page) => viewer(page).locator('.image-viewer-frame');
  const play = (page: Page) => frame(page).evaluate((el) => [getComputedStyle(el).animationName, getComputedStyle(el.closest('.ui-backdrop')!).animationName]);

  test('with the Animations switch off it opens as quietly as a dialog does, and nothing flies away when it closes', async ({ page }) => {
    await open(page);
    await drawn(page);
    await thumb(page, 'A lighthouse at dusk').click();
    expect(await play(page)).toEqual(['viewer-in', 'ui-backdrop-in']);
    expect(await page.evaluate(() => document.documentElement.dataset.motion)).toBeUndefined();
    await page.keyboard.press('Escape');
    await expect(viewer(page)).toBeHidden();
    await expect(page.locator('[data-ghost]')).toHaveCount(0);
  });

  test.describe('on', () => {
    test.use({ storageState: animated });

    test('with the switch on it swings up like a dialog and sinks away when it closes', async ({ page }) => {
      await open(page);
      await drawn(page);
      await thumb(page, 'A lighthouse at dusk').click();
      expect((await play(page))[0]).toBe('fx-viewer-in');
      // Nobody has seen it in less than this, and then nothing is made to leave (motion.ts).
      await page.waitForTimeout(250);
      await page.keyboard.press('Escape');
      await expect(page.locator('[data-ghost]')).toHaveCount(1);
      await expect(viewer(page)).toBeHidden();
    });

    test('and prefers-reduced-motion wins over the switch: nothing moves, in or out', async ({ page }) => {
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await open(page);
      await drawn(page);
      await thumb(page, 'A lighthouse at dusk').click();
      expect(await play(page)).toEqual(['none', 'none']);
      await page.keyboard.press('Escape');
      await expect(viewer(page)).toBeHidden();
      await expect(page.locator('[data-ghost]')).toHaveCount(0);
    });
  });
});
