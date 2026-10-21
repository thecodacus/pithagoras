import { type Page } from '@playwright/test';
import { test, expect } from './portal-mock';

// Two extensions' panels: the portal's tests' stand-ins for them.
test.use({ installed: ['tests/fixtures/extensions/console', 'tests/fixtures/extensions/viewer'] });

const box = async (page: Page, selector: string) => (await page.locator(selector).first().boundingBox())!;
/** The panels in one place; with all of them in one place, the panels. */
const panels = (page: Page) => page.locator('.chat-aside');
const placeAt = (page: Page, place: string) => page.locator(`.chat-aside[data-dock="${place}"]`);
const body = async (page: Page) => (await page.locator('.chat-body').boundingBox())!;
type Panel = 'Viewer' | 'Console';
/** A panel's header, which carries it. */
const head = (page: Page, panel: Panel) => page.locator(panel === 'Console' ? '.chat-aside-head:has([aria-label="Consoles"])' : `.chat-aside-head:has-text("${panel}")`);
/** Where in the chat to let the panels go for each place. */
const spots: Record<string, (b: { x: number; y: number; width: number; height: number }) => [number, number]> = {
  Right: (b) => [b.x + b.width - 20, b.y + b.height / 2],
  Left: (b) => [b.x + 20, b.y + b.height / 2],
  Bottom: (b) => [b.x + b.width / 2, b.y + b.height - 20],
  Floating: (b) => [b.x + b.width / 2, b.y + 90],
  // Where the top was: floating there, not docked.
  Top: (b) => [b.x + b.width / 2, b.y + 12],
};
const DOCK: Record<string, string> = { Right: 'right', Left: 'left', Bottom: 'bottom', Floating: 'float', Top: 'float' };
/** A panel's header's grip: the viewer's, unless another is asked for. */
const grip = async (page: Page, panel: Panel = 'Viewer') => (await head(page, panel).locator('span[title]').boundingBox())!;
/** Carries a panel by its header to `where`, in steps as a hand would; `during` looks while it is held there. */
const carry = async (page: Page, where: string, during?: () => Promise<void>, panel: Panel = 'Viewer') => {
  // Not while they are still sliding in from the last place: the grip is not where it is going.
  await settled(page);
  const g = await grip(page, panel);
  await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
  await page.mouse.down();
  const [x, y] = spots[where](await body(page));
  await page.mouse.move(x, y, { steps: 10 });
  await during?.();
  await page.mouse.up();
  await expect(page.locator('.dock-zones')).toBeHidden();
};
const place = async (page: Page, where: string, panel: Panel = 'Viewer') => {
  await carry(page, where, undefined, panel);
  // Coming in from the side it sits on.
  const at = placeAt(page, DOCK[where]);
  await expect(at).toBeVisible();
  if (where !== 'Floating' && where !== 'Top') expect(await at.evaluate((e) => getComputedStyle(e).animationName)).toBe(SLIDE[where]);
  await settled(page);
};
/** Both panels carried to an edge, one after the other: where all of them went at once before. */
const placeBoth = async (page: Page, where: string) => {
  await place(page, where, 'Viewer');
  await place(page, where, 'Console');
  await expect(panels(page)).toHaveCount(1);
};
const frames = (page: Page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
const SLIDE: Record<string, string> = { Right: 'aside-in', Left: 'aside-in-left', Bottom: 'aside-up', Floating: 'aside-up' };
/** Done coming in: measured on the way, they are where they are going plus the slide. */
const settled = (page: Page) =>
  page.evaluate(() =>
    Promise.all(
      [...document.querySelectorAll('.chat-aside')].flatMap((e) => e.getAnimations({ subtree: true }).filter((a) => a.effect?.getTiming().iterations !== Infinity).map((a) => a.finished)),
    ),
  );
/** The one floating window, or of two, the one a panel is in. */
const floating = (page: Page, panel?: Panel) => (panel ? placeAt(page, 'float').filter({ has: head(page, panel) }) : placeAt(page, 'float'));
const reopen = async (page: Page, ...which: Panel[]) => {
  await page.reload();
  for (const panel of which) await page.getByRole('button', { name: panel, exact: true }).click();
  await expect(panels(page).first()).toBeVisible();
  await settled(page);
};

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1300, height: 800 });
  await page.goto('/tests/chat.html?phase=tools');
  await page.getByRole('button', { name: 'Console', exact: true }).click();
  await page.getByRole('button', { name: 'Viewer', exact: true }).click();
  await expect(panels(page)).toBeVisible();
  await settled(page);
});

test('panels carried to the right, left or bottom of the conversation sit together there, side by side at the bottom', async ({ page }) => {
  const composer = () => box(page, '.prompt-shell');
  const halves = async () => [await box(page, '.chat-aside-panel:nth-of-type(1)'), (await page.locator('.chat-aside-panel').nth(1).boundingBox())!];

  // At the right, as they always were: one above the other.
  let a = (await panels(page).boundingBox())!;
  expect(a.x).toBeGreaterThan((await composer()).x + (await composer()).width);
  let [one, two] = await halves();
  expect(two.y).toBeGreaterThan(one.y + one.height - 1);
  // No button for it: carried, not chosen from a menu.
  await expect(panels(page).getByRole('button', { name: 'Where the panels go' })).toHaveCount(0);

  // Held over the left edge: that edge lit, and where it would go shown.
  await carry(page, 'Left', async () => {
    await expect(page.locator('.dock-edge.is-active')).toHaveClass(/is-left/);
    const preview = (await page.locator('.dock-preview').boundingBox())!, b = await body(page);
    expect(preview.x).toBeCloseTo(b.x, 0);
    expect(Math.abs(preview.height - b.height)).toBeLessThan(1);
  });
  await place(page, 'Left', 'Console');
  await expect(panels(page)).toHaveCount(1);
  a = (await panels(page).boundingBox())!;
  expect(a.x + a.width).toBeLessThanOrEqual((await composer()).x);

  await placeBoth(page, 'Bottom');
  a = (await panels(page).boundingBox())!;
  expect(a.y).toBeGreaterThanOrEqual((await composer()).y + (await composer()).height);
  expect(a.width).toBeGreaterThan(1200);
  [one, two] = await halves();
  // Side by side: the width is what there is here, not the height.
  expect(two.x).toBeGreaterThan(one.x + one.width - 1);
  expect(two.y).toBeCloseTo(one.y, 0);

  // Kept: opened again, they are where they were put.
  await reopen(page, 'Console');
  a = (await panels(page).boundingBox())!;
  expect(a.y).toBeGreaterThanOrEqual((await composer()).y + (await composer()).height);

  // Not at the top, between the chat's title and the conversation: carried there, it floats.
  await place(page, 'Top', 'Console');
  await expect(panels(page)).toHaveAttribute('data-dock', 'float');
  // Nor where an earlier version put them all.
  await page.evaluate(() => { localStorage.setItem('panelDock', 'top'); localStorage.removeItem('panelPlaces'); });
  await reopen(page, 'Console');
  await expect(panels(page)).toHaveAttribute('data-dock', 'right');
});

test('a press on the header that goes nowhere, or on a button in it, carries nothing', async ({ page }) => {
  const before = (await panels(page).boundingBox())!;
  const g = await grip(page);
  await page.mouse.move(g.x + 4, g.y + 4);
  await page.mouse.down();
  await page.mouse.move(g.x + 6, g.y + 5);
  await expect(page.locator('.dock-zones')).toBeHidden();
  await page.mouse.up();
  await page.getByRole('tab', { name: 'Jobs' }).click();
  expect(await panels(page).boundingBox()).toEqual(before);
  await expect(panels(page)).toHaveAttribute('data-dock', 'right');
});

test('each edge between the conversation and the panels sizes them the way it is dragged', async ({ page }) => {
  const edge = page.locator('.chat-aside-edge');
  const drag = async (dx: number, dy: number) => {
    const e = (await edge.boundingBox())!;
    await page.mouse.move(e.x + e.width / 2, e.y + e.height / 2);
    await page.mouse.down();
    await page.mouse.move(e.x + e.width / 2 + dx, e.y + e.height / 2 + dy, { steps: 6 });
    await page.mouse.up();
  };
  for (const [where, dx, dy, grows] of [['Left', 100, 0, 'width'], ['Right', -100, 0, 'width'], ['Bottom', 0, -80, 'height']] as const) {
    await placeBoth(page, where);
    const before = (await panels(page).boundingBox())![grows];
    await drag(dx, dy);
    // Towards the conversation is larger, wherever the panels are.
    expect((await panels(page).boundingBox())![grows]).toBeCloseTo(before + Math.abs(dx || dy), -1);
  }
});

test('the conversation slides over to stay in the middle when a panel docks at a side, moves to the other or goes; an edge being dragged moves it with no slide', async ({ page }) => {
  await page.getByRole('button', { name: 'Close Viewer' }).click();
  await page.getByRole('button', { name: 'Close Console' }).click();
  await expect(panels(page)).toHaveCount(0);
  const column = page.locator('.chat-column');
  /** Where each slide of the conversation going on starts: its first transform. */
  const slides = () => column.evaluate((el) => el.getAnimations().map((a) => String((a.effect as KeyframeEffect).getKeyframes()[0].transform)));
  const from = (transform: string) => Number(/^translateX\((-?[\d.]+)px\)$/.exec(transform)?.[1]);
  const middle = async () => {
    const b = (await page.locator('.chat-list').boundingBox())!;
    return b.x + b.width / 2;
  };
  await expect.poll(slides).toEqual([]);
  const alone = await middle();
  // Docked at the right: it starts where it was, and slides left into the middle of what is left.
  await page.getByRole('button', { name: 'Viewer', exact: true }).click();
  const [opening] = await slides();
  expect(from(opening)).toBeGreaterThan(50);
  await expect.poll(slides).toEqual([]);
  expect(await middle()).toBeLessThan(alone - 50);
  // Carried to the other side, where it is as wide, and back: the conversation is no narrower or wider, and it slides each way.
  const atRight = await middle();
  await carry(page, 'Left');
  const [toRight] = await slides();
  expect(from(toRight)).toBeLessThan(-50);
  await expect.poll(slides).toEqual([]);
  expect(await middle()).toBeGreaterThan(alone + 50);
  await carry(page, 'Right');
  const [toLeft] = await slides();
  expect(from(toLeft)).toBeGreaterThan(50);
  await expect.poll(slides).toEqual([]);
  expect(Math.abs((await middle()) - atRight)).toBeLessThan(2);
  // The edge dragged: the conversation follows it as it goes, and nothing slides.
  const edge = (await page.locator('.chat-aside-edge').boundingBox())!;
  await page.mouse.move(edge.x + edge.width / 2, edge.y + edge.height / 2);
  await page.mouse.down();
  await page.mouse.move(edge.x + edge.width / 2 - 80, edge.y + edge.height / 2, { steps: 6 });
  expect(await slides()).toEqual([]);
  await page.mouse.up();
  expect(await slides()).toEqual([]);
  // Taken away: it slides back right, to the middle of the whole chat.
  await page.getByRole('button', { name: 'Close Viewer' }).click();
  const [closing] = await slides();
  expect(from(closing)).toBeLessThan(-50);
  await expect.poll(slides).toEqual([]);
  expect(Math.abs((await middle()) - alone)).toBeLessThan(2);
  // With reduced motion it is where it goes at once.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.getByRole('button', { name: 'Viewer', exact: true }).click();
  await expect(panels(page)).toHaveCount(1);
  expect(await slides()).toEqual([]);
});

test('floating, a panel is a window carried by its header, sized by its corner, kept inside the chat, and docked again at an edge', async ({ page }) => {
  await page.getByRole('button', { name: 'Close Viewer' }).click();
  // Let go in the middle: a window, held by its header where it was let go.
  await place(page, 'Floating', 'Console');
  const window = floating(page);
  const area = await body(page);
  const [x, y] = spots.Floating(area);
  const at = (await window.boundingBox())!;
  expect(at.width).toBeLessThan(area.width / 2);
  const g = await grip(page, 'Console');
  expect(Math.abs(g.x + g.width / 2 - x)).toBeLessThan(40);
  expect(Math.abs(g.y + g.height / 2 - y)).toBeLessThan(20);
  // Over the conversation, not beside it: the composer keeps its width.
  expect((await box(page, '.prompt-shell')).x + (await box(page, '.prompt-shell')).width).toBeGreaterThan(at.x);

  // Carried again, it goes along with the pointer.
  const h = await grip(page, 'Console');
  await page.mouse.move(h.x + 4, h.y + 4);
  await page.mouse.down();
  await page.mouse.move(h.x + 4 - 200, h.y + 4 + 50, { steps: 8 });
  expect((await window.boundingBox())!.x).toBeCloseTo(at.x - 200, 0);
  await page.mouse.up();
  let now = (await window.boundingBox())!;
  expect(now.x).toBeCloseTo(at.x - 200, 0);
  expect(now.y).toBeCloseTo(at.y + 50, 0);

  // Sized by its corner, down to what is still of use and no smaller.
  const corner = (await page.locator('.chat-aside-grip').boundingBox())!;
  await page.mouse.move(corner.x + 8, corner.y + 8);
  await page.mouse.down();
  await page.mouse.move(corner.x - 2000, corner.y - 2000, { steps: 8 });
  await page.mouse.up();
  now = (await window.boundingBox())!;
  expect(now.width).toBeCloseTo(320, 0);
  expect(now.height).toBeCloseTo(200, 0);
  expect(now.x).toBeGreaterThanOrEqual(area.x - 0.5);

  // A tab in the header is a tab, not a place to carry the window from.
  await page.getByRole('tab', { name: 'Jobs' }).click();
  await expect(page.getByRole('tab', { name: 'Jobs' })).toHaveAttribute('aria-selected', 'true');
  expect((await window.boundingBox())!.x).toBeCloseTo(now.x, 0);

  // Where it was put and how large, kept.
  await page.reload();
  await page.getByRole('button', { name: 'Console', exact: true }).click();
  // Rising into place, not coming in from the right as the docked panels do.
  expect(await panels(page).evaluate((e) => getComputedStyle(e).animationName)).toBe('aside-up');
  await settled(page);
  const again = (await panels(page).boundingBox())!;
  expect(again.x).toBeCloseTo(now.x, 0);
  expect(again.width).toBeCloseTo(now.width, 0);

  // Carried to an edge, docked there again.
  await place(page, 'Right', 'Console');
  await expect(panels(page)).toHaveAttribute('data-dock', 'right');
  expect(Math.abs((await panels(page).boundingBox())!.height - area.height)).toBeLessThan(1);
});

test('on a phone the panels cover the chat wherever they were put', async ({ page }) => {
  await place(page, 'Floating');
  await place(page, 'Left', 'Console');
  await page.setViewportSize({ width: 390, height: 780 });
  // Together, as one.
  await expect(panels(page)).toHaveCount(1);
  await expect.poll(async () => (await panels(page).boundingBox())!.x).toBe(0);
  expect((await panels(page).boundingBox())!.width).toBe(390);
  // Nothing to carry them by there.
  await expect(page.locator('.chat-aside-head span[title]').first()).toBeHidden();
});

test('panels leave the conversation and its composer room when the chat gets smaller', async ({ page }) => {
  await placeBoth(page, 'Bottom');
  // Made as tall as they may be.
  const edge = (await page.locator('.chat-aside-edge').boundingBox())!;
  await page.mouse.move(edge.x + edge.width / 2, edge.y + 1);
  await page.mouse.down();
  await page.mouse.move(edge.x + edge.width / 2, 0, { steps: 6 });
  await page.mouse.up();
  // Shorter, as the keyboard makes it on a tablet: the composer was squeezed to nothing under them.
  await page.setViewportSize({ width: 1300, height: 480 });
  await expect.poll(async () => (await box(page, '.prompt-shell')).y + (await box(page, '.prompt-shell')).height).toBeLessThanOrEqual((await panels(page).boundingBox())!.y + 1);
  // And a few lines of the conversation above it.
  expect((await page.locator('.chat-list').locator('..').boundingBox())!.height).toBeGreaterThan(40);

  // Narrower, docked at a side: the conversation keeps its width.
  await page.setViewportSize({ width: 1300, height: 800 });
  await placeBoth(page, 'Left');
  await page.setViewportSize({ width: 800, height: 800 });
  await expect.poll(async () => (await page.locator('.chat-list').locator('..').locator('..').boundingBox())!.width).toBeGreaterThanOrEqual(315);
});

test('a carry the browser takes over drops nothing, and a touch on the header is the carry\'s, not a pan', async ({ page }) => {
  expect(await page.locator('.chat-aside-head').first().evaluate((e) => getComputedStyle(e).touchAction)).toBe('none');
  const g = await grip(page);
  await page.mouse.move(g.x + 6, g.y + 6);
  await page.mouse.down();
  const [x, y] = spots.Floating(await body(page));
  await page.mouse.move(x, y, { steps: 8 });
  await expect(page.locator('.dock-zones')).toBeVisible();
  // A pan or a system gesture: the browser cancels the pointer.
  await page.locator('.chat-aside-head').first().evaluate((e) => e.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1, bubbles: true })));
  await page.mouse.up();
  await expect(page.locator('.dock-zones')).toBeHidden();
  // Where it was: it jumped into a floating window nobody let go.
  await expect(panels(page)).toHaveCount(1);
  await expect(panels(page)).toHaveAttribute('data-dock', 'right');
});

test('a floating window moved or sized is drawn along without the chat, and kept once', async ({ page }) => {
  await place(page, 'Floating');
  const writes = () => page.evaluate(() => (window as any).floatWrites as number);
  await page.evaluate(() => {
    (window as any).floatWrites = 0;
    const set = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key: string, value: string) { if (key === 'panelFloats') (window as any).floatWrites++; return set.call(this, key, value); };
  });
  const g = await grip(page);
  await page.mouse.move(g.x + 6, g.y + 6);
  await page.mouse.down();
  await page.mouse.move(g.x - 200, g.y + 60, { steps: 10 });
  // Along with the pointer already, before it is let go.
  expect((await grip(page)).x).toBeLessThan(g.x - 150);
  // It was written at every move.
  expect(await writes()).toBe(0);
  await page.mouse.up();
  expect(await writes()).toBe(1);
  const corner = (await page.locator('.chat-aside-grip').boundingBox())!;
  await page.mouse.move(corner.x + 8, corner.y + 8);
  await page.mouse.down();
  await page.mouse.move(corner.x + 60, corner.y + 40, { steps: 10 });
  expect(await writes()).toBe(1);
  await page.mouse.up();
  expect(await writes()).toBe(2);
});

test('a height or width kept from before that is too small to draw opens at the usual size', async ({ page }) => {
  // What a drag in a short chat could keep: a height below the least, or below nothing.
  for (const height of ['40', '-40']) {
    await page.evaluate((h) => { localStorage.setItem('panelDock', 'bottom'); localStorage.setItem('panelHeight', h); }, height);
    await page.reload();
    await page.getByRole('button', { name: 'Console', exact: true }).click();
    await settled(page);
    expect((await panels(page).boundingBox())!.height).toBeGreaterThanOrEqual(159);
  }
});

test('the edge moves the panels from the size they are drawn at, and a drop shows that size', async ({ page }) => {
  // Narrower than the three quarters a drag allowed: what was kept was wider than could be drawn.
  await page.setViewportSize({ width: 1000, height: 800 });
  // One panel: carried to the other side, nothing is left at this one to give way to.
  await page.getByRole('button', { name: 'Close Viewer' }).click();
  const edge = page.locator('.chat-aside-edge');
  const drag = async (to: number) => {
    const e = (await edge.boundingBox())!;
    await page.mouse.move(e.x + e.width / 2, e.y + 200);
    await page.mouse.down();
    await page.mouse.move(to, e.y + 200, { steps: 6 });
    await page.mouse.up();
  };
  await drag(0);
  const widest = (await panels(page).boundingBox())!.width;
  // The conversation's 320px, and the edge beside it.
  expect(widest).toBeCloseTo(1000 - 320 - 4, 0);
  // Back by 50: it went nowhere for the first 70.
  const e = (await edge.boundingBox())!;
  await drag(e.x + e.width / 2 + 50);
  expect((await panels(page).boundingBox())!.width).toBeCloseTo(widest - 50, 0);
  // Held over the left edge: the preview is the width it will have there — the left's own.
  let shown = 0;
  await carry(page, 'Left', async () => {
    shown = (await page.locator('.dock-preview').boundingBox())!.width;
  }, 'Console');
  await settled(page);
  expect((await placeAt(page, 'left').boundingBox())!.width).toBeCloseTo(shown, 0);
  expect(shown).toBeCloseTo(560, 0);
  // And back at the right, the width it was made there.
  await place(page, 'Right', 'Console');
  expect((await panels(page).boundingBox())!.width).toBeCloseTo(widest - 50, 0);
});

test('a floating window carried while the chat changes size stays under the pointer', async ({ page }) => {
  await place(page, 'Floating');
  const g = await grip(page);
  await page.mouse.move(g.x + 6, g.y + 6);
  await page.mouse.down();
  await page.mouse.move(g.x - 200, g.y + 40, { steps: 8 });
  const held = (await floating(page).boundingBox())!;
  // The chat gets much shorter meanwhile, as the keyboard makes it: it was put back where it was taken from.
  await page.setViewportSize({ width: 1300, height: 420 });
  await frames(page);
  const now = (await floating(page).boundingBox())!;
  expect(now.x).toBeCloseTo(held.x, 0);
  expect(now.y).toBeCloseTo(held.y, 0);
  await page.mouse.up();
});

test('a floating window is fitted to the chat again after a press on its corner with another button', async ({ page }) => {
  await place(page, 'Floating');
  const corner = (await page.locator('.chat-aside-grip').boundingBox())!;
  await page.mouse.move(corner.x + 8, corner.y + 8);
  await page.mouse.down({ button: 'right' });
  await page.mouse.up({ button: 'right' });
  // Narrower: it was left where the wider chat had it, past the chat's right edge.
  await page.setViewportSize({ width: 900, height: 800 });
  await expect.poll(async () => { const a = (await floating(page).boundingBox())!, b = await body(page); return a.x + a.width - (b.x + b.width); }).toBeLessThanOrEqual(0.5);
});

test('a floating window nudged by the right end of its header moves, rather than docking at the right', async ({ page }) => {
  // Floating where it first goes, at the top right: its header's right end is within the right edge's reach.
  await page.evaluate(() => { localStorage.setItem('panelDock', 'float'); localStorage.removeItem('panelFloat'); localStorage.removeItem('panelFloats'); });
  await page.reload();
  await page.getByRole('button', { name: 'Console', exact: true }).click();
  await settled(page);
  const head = (await page.locator('.chat-aside-head').first().boundingBox())!, b = await body(page);
  const x = head.x + head.width - 60, y = head.y + head.height / 2;
  expect(x).toBeGreaterThan(b.x + b.width - 96);
  const before = (await panels(page).boundingBox())!;
  await page.mouse.move(x, y);
  await page.mouse.down();
  // Still within that reach.
  await page.mouse.move(x - 10, y + 30, { steps: 5 });
  expect(x - 10).toBeGreaterThan(b.x + b.width - 96);
  await page.mouse.up();
  await expect(panels(page)).toHaveCount(1);
  await expect(panels(page)).toHaveAttribute('data-dock', 'float');
  const after = (await panels(page).boundingBox())!;
  expect(after.x).toBeCloseTo(before.x - 10, 0);
  // Out of that edge and back into it: then it is meant, and it docks.
  const h2 = (await page.locator('.chat-aside-head').first().boundingBox())!;
  await page.mouse.move(h2.x + h2.width - 60, h2.y + h2.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, h2.y + 40, { steps: 5 });
  await page.mouse.move(b.x + b.width - 10, h2.y + 40, { steps: 5 });
  await page.mouse.up();
  await expect(panels(page)).toHaveAttribute('data-dock', 'right');
});

test('floating where it first goes, the window leaves Stop and Send uncovered', async ({ page }) => {
  await page.evaluate(() => { localStorage.setItem('panelDock', 'float'); localStorage.removeItem('panelFloat'); localStorage.removeItem('panelFloats'); });
  await page.reload();
  await page.getByRole('button', { name: 'Console', exact: true }).click();
  await settled(page);
  // It reached down over the composer's right end, where Stop and Send are.
  const w = (await panels(page).boundingBox())!, c = await box(page, '.prompt-shell');
  expect(w.y + w.height).toBeLessThanOrEqual(c.y);
  await expect(page.getByRole('button', { name: 'Stop generation' })).toBeVisible();
});

test('the edge and the divider are drawn along as they are dragged, and kept once', async ({ page }) => {
  await page.evaluate(() => {
    (window as any).writes = {};
    const set = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key: string, value: string) { (window as any).writes[key] = ((window as any).writes[key] ?? 0) + 1; return set.call(this, key, value); };
  });
  const writes = (key: string) => page.evaluate((k) => (window as any).writes[k] ?? 0, key);
  const pull = async (handle: import('@playwright/test').Locator, dx: number, dy: number, during: () => Promise<void>) => {
    const h = (await handle.boundingBox())!;
    await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
    await page.mouse.down();
    await page.mouse.move(h.x + h.width / 2 + dx, h.y + h.height / 2 + dy, { steps: 10 });
    await during();
    await page.mouse.up();
  };
  const before = (await panels(page).boundingBox())!.width;
  await pull(page.locator('.chat-aside-edge'), -100, 0, async () => {
    expect((await panels(page).boundingBox())!.width).toBeCloseTo(before + 100, 0);
    // Written at every move, and the chat drawn again each time.
    expect(await writes('panelSizes')).toBe(0);
  });
  expect(await writes('panelSizes')).toBe(1);
  const first = page.locator('.chat-aside-panel').first();
  const top = (await first.boundingBox())!.height;
  await pull(page.locator('.chat-aside [title="Drag to resize"]'), 0, 60, async () => {
    expect((await first.boundingBox())!.height).toBeCloseTo(top + 60, -1);
    expect(await writes('panelSplit')).toBe(0);
  });
  expect(await writes('panelSplit')).toBe(1);
});

test('one panel docked at the left and another at the right at once, each kept where it was put, neither made anew by the carry', async ({ page }) => {
  // Something that is in the console's header only while it is the same one.
  await head(page, 'Console').evaluate((e) => { (e as HTMLElement).dataset.mark = 'kept'; });
  await place(page, 'Left', 'Console');
  await expect(panels(page)).toHaveCount(2);
  await expect(placeAt(page, 'left').getByRole('tablist', { name: 'Consoles' })).toBeVisible();
  await expect(placeAt(page, 'right').locator('.chat-aside-head')).toHaveText(/Viewer/);
  await expect(head(page, 'Console')).toHaveAttribute('data-mark', 'kept');
  // The conversation between them, whole: the one left alone at the right takes its height.
  const left = (await placeAt(page, 'left').boundingBox())!, right = (await placeAt(page, 'right').boundingBox())!, composer = await box(page, '.prompt-shell'), b = await body(page);
  expect(left.x + left.width).toBeLessThanOrEqual(composer.x);
  expect(composer.x + composer.width).toBeLessThanOrEqual(right.x);
  expect(Math.abs(left.height - b.height)).toBeLessThan(1);
  expect(Math.abs(right.height - b.height)).toBeLessThan(1);

  await reopen(page, 'Console', 'Viewer');
  await expect(placeAt(page, 'left').getByRole('tablist', { name: 'Consoles' })).toBeVisible();
  await expect(placeAt(page, 'right').locator('.chat-aside-head')).toHaveText(/Viewer/);
});

test('at both sides at once the panels give way together, and the conversation keeps its room', async ({ page }) => {
  await place(page, 'Left', 'Console');
  await page.setViewportSize({ width: 1000, height: 800 });
  // 560 each, as they were made: 1120 where less than 1000 is all there is.
  const conversation = page.locator('.chat-list').locator('..').locator('..');
  await expect.poll(async () => (await conversation.boundingBox())!.width).toBeGreaterThanOrEqual(310);
  const left = (await placeAt(page, 'left').boundingBox())!, right = (await placeAt(page, 'right').boundingBox())!;
  expect(left.width).toBeCloseTo(right.width, -1);
  // Made wide again, as they were made.
  await page.setViewportSize({ width: 1800, height: 800 });
  await expect.poll(async () => (await placeAt(page, 'left').boundingBox())!.width).toBeCloseTo(560, 0);
  expect((await placeAt(page, 'right').boundingBox())!.width).toBeCloseTo(560, 0);

  // One side made as wide as it goes: the other gives way, as far as the least of use, and the conversation keeps its room.
  const edge = (await placeAt(page, 'right').locator('xpath=preceding-sibling::*[1]').boundingBox())!;
  await page.mouse.move(edge.x + edge.width / 2, edge.y + 200);
  await page.mouse.down();
  await page.mouse.move(0, edge.y + 200, { steps: 6 });
  await page.mouse.up();
  await frames(page);
  const b = await body(page);
  expect((await placeAt(page, 'left').boundingBox())!.width).toBeCloseTo(320, 0);
  // Less the conversation's 320px and the two edges.
  expect((await placeAt(page, 'right').boundingBox())!.width).toBeCloseTo(b.width - 320 - 320 - 8, 0);
  // Given way, not made narrower: with room again, the left is as it was made.
  await page.setViewportSize({ width: 2600, height: 800 });
  await expect.poll(async () => (await placeAt(page, 'left').boundingBox())!.width).toBeCloseTo(560, 0);
});

test('a panel carried to a place that has one takes its size; under the conversation it sits between the sides', async ({ page }) => {
  await place(page, 'Left', 'Console');
  // The viewer, alone at the right, made narrower than it is drawn.
  const was = (await placeAt(page, 'right').boundingBox())!.width;
  const edge = (await placeAt(page, 'right').locator('xpath=preceding-sibling::*[1]').boundingBox())!;
  await page.mouse.move(edge.x + edge.width / 2, edge.y + 200);
  await page.mouse.down();
  await page.mouse.move(edge.x + edge.width / 2 + 160, edge.y + 200, { steps: 6 });
  await page.mouse.up();
  const narrow = (await placeAt(page, 'right').boundingBox())!.width;
  expect(narrow).toBeCloseTo(was - 160, 0);
  // The console joins it, and the preview says so.
  await carry(page, 'Right', async () => {
    expect((await page.locator('.dock-preview').boundingBox())!.width).toBeCloseTo(narrow, 0);
  }, 'Console');
  await settled(page);
  await expect(panels(page)).toHaveCount(1);
  expect((await panels(page).boundingBox())!.width).toBeCloseTo(narrow, 0);

  // At the bottom, under the conversation only: the viewer keeps the height at the right.
  await place(page, 'Bottom', 'Console');
  const bottom = (await placeAt(page, 'bottom').boundingBox())!, right = (await placeAt(page, 'right').boundingBox())!, b = await body(page);
  expect(bottom.x).toBeCloseTo(b.x, 0);
  expect(bottom.x + bottom.width).toBeLessThanOrEqual(right.x);
  expect(Math.abs(right.height - b.height)).toBeLessThan(1);
  expect(bottom.y).toBeGreaterThanOrEqual((await box(page, '.prompt-shell')).y);
});

test('a panel not placed on its own yet goes where all of them went before', async ({ page }) => {
  await page.evaluate(() => { localStorage.setItem('panelDock', 'left'); localStorage.removeItem('panelPlaces'); });
  await reopen(page, 'Console', 'Viewer');
  await expect(panels(page)).toHaveCount(1);
  await expect(panels(page)).toHaveAttribute('data-dock', 'left');
  // One carried away: only that one moves, and the other stays where they all were.
  await place(page, 'Right');
  await reopen(page, 'Console', 'Viewer');
  await expect(placeAt(page, 'right').locator('.chat-aside-head')).toHaveText(/Viewer/);
  await expect(placeAt(page, 'left').getByRole('tablist', { name: 'Consoles' })).toBeVisible();
});

test('a place keeps the size it was made, whichever panels are opened in it', async ({ page }) => {
  await reopen(page, 'Console', 'Viewer');
  await page.getByRole('button', { name: 'Close Viewer' }).click();
  const edge = (await page.locator('.chat-aside-edge').boundingBox())!;
  await page.mouse.move(edge.x + edge.width / 2, edge.y + 200);
  await page.mouse.down();
  await page.mouse.move(edge.x + edge.width / 2 + 120, edge.y + 200, { steps: 6 });
  await page.mouse.up();
  const made = (await panels(page).boundingBox())!.width;
  // The viewer, opened again beside the console: the place keeps its size.
  await page.getByRole('button', { name: 'Viewer', exact: true }).click();
  await expect(page.locator('.chat-aside-panel')).toHaveCount(2);
  expect((await panels(page).boundingBox())!.width).toBeCloseTo(made, 0);
});

test('with both sides giving way, one sized is let go as it was drawn, and the other keeps its own width', async ({ page }) => {
  await place(page, 'Left', 'Console');
  const left = placeAt(page, 'left'), right = placeAt(page, 'right');
  const pull = async (dx: number, moves = dx) => {
    const was = (await left.boundingBox())!.width;
    const edge = (await left.locator('xpath=following-sibling::*[1]').boundingBox())!;
    await page.mouse.move(edge.x + edge.width / 2, edge.y + 200);
    await page.mouse.down();
    await page.mouse.move(edge.x + edge.width / 2 + dx, edge.y + 200, { steps: 3 });
    // Moved from where it is drawn: not with a jump to the least a panel is made.
    const drawn = { left: (await left.boundingBox())!.width, right: (await right.boundingBox())!.width };
    expect(Math.abs(drawn.left - (was + moves))).toBeLessThanOrEqual(1);
    await page.mouse.up();
    await frames(page);
    // Let go, nothing moves.
    expect(Math.abs((await left.boundingBox())!.width - drawn.left)).toBeLessThanOrEqual(1);
    expect(Math.abs((await right.boundingBox())!.width - drawn.right)).toBeLessThanOrEqual(1);
  };
  await page.setViewportSize({ width: 1000, height: 800 });
  await expect.poll(async () => (await left.boundingBox())!.width).toBeLessThan(400);
  // Narrower: the right takes back some of its own width while it is dragged.
  const before = (await right.boundingBox())!.width;
  await pull(-10);
  expect((await right.boundingBox())!.width).toBeGreaterThan(before + 5);
  // With room again, the right is as it was made — not kept at what it was given way to.
  await page.setViewportSize({ width: 2600, height: 800 });
  await expect.poll(async () => (await right.boundingBox())!.width).toBeCloseTo(560, 0);
  // Narrower than of use already: it stays there, rather than jumping to the
  // least a panel is made and taking the conversation's room.
  await page.setViewportSize({ width: 900, height: 800 });
  await expect.poll(async () => (await left.boundingBox())!.width).toBeLessThan(310);
  await pull(8, 0);
});

test('each floating panel has a window of its own, put where it was let go, carried alone, and kept', async ({ page }) => {
  await place(page, 'Floating');
  const viewer = (await floating(page, 'Viewer').boundingBox())!, b = await body(page);
  // The console let go lower down and to the left: there, in a window of its own.
  const g = await grip(page, 'Console');
  await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + 260, b.y + 330, { steps: 10 });
  await page.mouse.up();
  await settled(page);
  await expect(placeAt(page, 'float')).toHaveCount(2);
  const consoleBox = (await floating(page, 'Console').boundingBox())!;
  // Held by its header where it was let go, as far down as the chat lets it go.
  const t = await grip(page, 'Console');
  expect(Math.abs(t.x + t.width / 2 - (b.x + 260))).toBeLessThan(40);
  expect(consoleBox.x).toBeLessThan(viewer.x - 100);
  // The viewer's window is where it was.
  expect(await floating(page, 'Viewer').boundingBox()).toEqual(viewer);
  // Carried, only that window goes along.
  const h = await grip(page, 'Viewer');
  await page.mouse.move(h.x + 4, h.y + 4);
  await page.mouse.down();
  await page.mouse.move(h.x + 4 - 120, h.y + 4 + 40, { steps: 6 });
  expect((await floating(page, 'Console').boundingBox())!.x).toBeCloseTo(consoleBox.x, 0);
  await page.mouse.up();
  // The one last carried is on top; pressed in, the other comes up.
  const z = (panel: Panel) => floating(page, panel).evaluate((e) => Number(getComputedStyle(e).zIndex));
  expect(await z('Viewer')).toBeGreaterThan(await z('Console'));
  // Pressed anywhere in it, not only by its header: in what the console shows.
  await floating(page, 'Console').locator('.console-pane').first().click({ position: { x: 20, y: 20 } });
  expect(await z('Console')).toBeGreaterThan(await z('Viewer'));
  await floating(page, 'Viewer').click({ position: { x: 60, y: 120 } });
  expect(await z('Viewer')).toBeGreaterThan(await z('Console'));

  await reopen(page, 'Console', 'Viewer');
  await expect(placeAt(page, 'float')).toHaveCount(2);
  expect((await floating(page, 'Console').boundingBox())!.x).toBeCloseTo(consoleBox.x, 0);
});

test('panels that floated together before each had a window are put apart, both seen', async ({ page }) => {
  await page.evaluate(() => {
    localStorage.setItem('panelDock', 'float');
    localStorage.setItem('panelFloat', JSON.stringify({ x: 200, y: 40, w: 420, h: 360 }));
    for (const key of ['panelPlaces', 'panelFloats']) localStorage.removeItem(key);
  });
  await reopen(page, 'Console', 'Viewer');
  await expect(placeAt(page, 'float')).toHaveCount(2);
  const viewer = (await floating(page, 'Viewer').boundingBox())!, consoleBox = (await floating(page, 'Console').boundingBox())!;
  expect(viewer.width).toBeCloseTo(420, 0);
  expect(consoleBox.width).toBeCloseTo(420, 0);
  expect(Math.abs(viewer.x - consoleBox.x) + Math.abs(viewer.y - consoleBox.y)).toBeGreaterThan(40);
  // Kept where it was put aside: the other closed, it does not go back onto its place.
  await head(page, 'Viewer').click({ position: { x: 4, y: 4 } });
  await page.getByRole('button', { name: 'Close Viewer' }).click();
  await frames(page);
  expect(await floating(page, 'Console').boundingBox()).toEqual(consoleBox);
  await reopen(page, 'Console');
  expect(await floating(page, 'Console').boundingBox()).toEqual(consoleBox);
});

test('a panel carried elsewhere is moved, not taken off the page: the frame in it keeps its page', async ({ page }) => {
  await reopen(page, 'Viewer');
  const frame = () => page.frame({ name: 'viewer-pane' })!;
  await expect.poll(() => !!frame()).toBe(true);
  await frame().waitForLoadState();
  await frame().evaluate(() => { (window as any).kept = 'this page'; window.scrollTo(0, 400); });
  const kept = async () => frame().evaluate(() => [(window as any).kept, window.scrollY]);
  for (const where of ['Left', 'Bottom', 'Floating', 'Right']) {
    await place(page, where);
    expect(await kept()).toEqual(['this page', 400]);
  }
  // Across the phone's width and back, where they all go to one place and back again.
  await place(page, 'Left');
  await page.setViewportSize({ width: 390, height: 780 });
  // The left place is drawn again as the one place there is, a new element: a look at the old one, as it goes, finds no box.
  await expect(placeAt(page, 'right')).toBeVisible();
  await expect.poll(async () => (await panels(page).boundingBox())?.x).toBe(0);
  await page.setViewportSize({ width: 1300, height: 800 });
  await expect(placeAt(page, 'left')).toBeVisible();
  expect(await kept()).toEqual(['this page', 400]);
});
