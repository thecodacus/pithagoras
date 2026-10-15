import { test, expect, mockPortal } from './portal-mock';

const session = { id: 'phone', title: 'Typing on a phone', workspace: '/workspaces/demo', status: 'idle', kind: 'task', pinned: false };

const open = async (page: import('@playwright/test').Page) => {
  await page.setViewportSize({ width: 390, height: 780 });
  await mockPortal(page, ({ path: p }) => {
    if (p === '/api/sessions') return { sessions: [session], executor: 'host' };
    if (p === `/api/sessions/${session.id}`) return session;
    if (p.endsWith('/commands')) return { commands: [] };
  });
  await page.addInitScript(() => {
    localStorage.setItem('sidebarCollapsed', 'true');
    // Safari's keyboard: the page keeps its height, the visual viewport above the keyboard gets shorter.
    const visual = Object.assign(new EventTarget(), { height: innerHeight, width: innerWidth, offsetTop: 0, offsetLeft: 0, pageTop: 0, pageLeft: 0, scale: 1 });
    Object.defineProperty(window, 'visualViewport', { value: visual, configurable: true });
    // `pan`: how far Safari pushed the page up to show the box.
    (window as any).keyboard = (px: number, pan = 0) => { visual.height = innerHeight - px; visual.offsetTop = pan; visual.dispatchEvent(new Event('resize')); };
  });
  await page.goto('/s/phone');
};

test('the keyboard opening moves the composer up to it, and nothing else', async ({ page }) => {
  await open(page);
  const title = page.getByRole('button', { name: 'Typing on a phone' }).first();
  const composer = page.getByLabel('Message', { exact: true });
  await expect(composer).toBeVisible();
  await composer.focus();
  // Settled: the composer comes in with a short slide.
  await page.waitForTimeout(800);
  const before = { title: (await title.boundingBox())!, composer: (await composer.boundingBox())! };
  expect(await page.locator('meta[name=viewport]').getAttribute('content')).toContain('interactive-widget=resizes-content');

  await page.evaluate(() => (window as any).keyboard(320));
  // The composer sits on the keyboard; it was under it, the whole page left where it was.
  await expect.poll(async () => { const b = (await composer.boundingBox())!; return b.y + b.height; }).toBeLessThanOrEqual(780 - 320);
  expect((await composer.boundingBox())!.y).toBeLessThan(before.composer.y - 250);
  // The header stays where it was.
  expect(Math.abs((await title.boundingBox())!.y - before.title.y)).toBeLessThan(2);
  expect(await page.evaluate(() => scrollY)).toBe(0);

  // Closed again: all back.
  await page.evaluate(() => (window as any).keyboard(0));
  await expect.poll(async () => (await composer.boundingBox())!.y).toBeCloseTo(before.composer.y, 0);
});

test('with the page pushed up to show the box, the app is still made as short as the keyboard leaves it', async ({ page }) => {
  await open(page);
  const composer = page.getByLabel('Message', { exact: true });
  await composer.focus();
  // Safari pushes the page up by the keyboard's height: none of it was taken off, and the header stayed off the top.
  await page.evaluate(() => (window as any).keyboard(320, 320));
  await expect.poll(async () => { const b = (await composer.boundingBox())!; return b.y + b.height; }).toBeLessThanOrEqual(780 - 320);
});

test('a box in a dialog, or outside the app, stays where the page was pushed to show it', async ({ page }) => {
  await open(page);
  await expect(page.getByLabel('Message', { exact: true })).toBeVisible();
  const scrolled = page.evaluate(async () => {
    // Room to scroll, as the login screen or a dialog low on the page has when Safari pushes it up.
    document.body.style.height = '3000px';
    document.body.style.overflow = 'visible';
    document.documentElement.style.overflow = 'visible';
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.innerHTML = '<input aria-label="In a dialog">';
    document.querySelector('[data-fits-keyboard]')!.appendChild(dialog);
    const outside = document.createElement('input');
    outside.setAttribute('aria-label', 'Outside the app');
    document.body.appendChild(outside);
    const seen: number[] = [];
    for (const field of [dialog.querySelector('input')!, outside]) {
      field.focus({ preventScroll: true });
      scrollTo(0, 300);
      (window as any).keyboard(320);
      await new Promise((r) => requestAnimationFrame(r));
      seen.push(scrollY);
      (window as any).keyboard(0);
    }
    return seen;
  });
  // Put back to the top, which left the field under the keyboard.
  expect(await scrolled).toEqual([300, 300]);
});

test('zoomed in on a small field as the keyboard opens, the app is still made as short as the keyboard leaves it', async ({ page }) => {
  await open(page);
  const composer = page.getByLabel('Message', { exact: true });
  await composer.focus();
  // Safari zooms in twice on the terminal's small field: the visual viewport is half as tall again.
  await page.evaluate(() => {
    const v = window.visualViewport as any;
    v.scale = 2; v.height = (innerHeight - 320) / 2; v.dispatchEvent(new Event('resize'));
  });
  await expect.poll(async () => { const b = (await composer.boundingBox())!; return b.y + b.height; }).toBeLessThanOrEqual(780 - 320);
});
