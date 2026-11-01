import { type Locator, type Page } from '@playwright/test';
import { test, expect, mockPortal } from './portal-mock';

/**
 * Text that is scrolled by a fraction of a pixel moves as one piece. On a screen that is not a whole number of
 * pixels per CSS pixel (125 %) Chromium otherwise drew a box's text again at each offset and rounded every line to
 * the screen on its own, so that lines of one paragraph stepped a pixel apart from each other while scrolling: the
 * text wobbled (#310). Measured on what is drawn: the box is scrolled in small steps, and every row of text must
 * have moved by the same number of screen pixels as every other.
 */
test.use({ deviceScaleFactor: 1.25, viewport: { width: 900, height: 520 } });

/** Offsets in CSS px that fall between two screen pixels now and then. */
const OFFSETS = [0, 0.3, 0.6, 0.9, 1.2, 1.5, 1.8, 2.1, 2.4, 2.7, 3, 3.3, 3.6, 3.9, 4.2, 4.5];

/**
 * Lines of text that sit at every fraction of a screen pixel, at the end of the box and scrolled into view: which way a
 * line is rounded depends on where it is, so that a box whose lines all sit alike would not show the step. Real text
 * does not (a line is 22.75 px, a gap 6 or 12).
 */
async function spread(box: Locator) {
  await box.evaluate((el) => {
    const block = document.createElement('div');
    block.style.padding = '8px 16px';
    for (let i = 0; i < 80; i++) {
      const line = document.createElement('p');
      line.textContent = `Line ${i + 1} of the spread, long enough to be text and not a dot.`;
      line.style.cssText = 'margin:0;height:17.7px;font:13px/17.7px system-ui;color:rgb(var(--fg))';
      block.appendChild(line);
    }
    block.id = 'spread';
    el.appendChild(block);
  });
  // A conversation that was at its end goes on following it as this grows; scrolled up from there it lets go.
  await box.page().evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await box.evaluate((el) => { el.scrollTop = document.getElementById('spread')!.offsetTop - el.offsetTop + 200; });
}

/** How far each picture of the box is moved against the first, in screen pixels, for every row of text that is found again exactly. */
async function moves(page: Page, box: Locator): Promise<number[][]> {
  // The part of the box that is on the screen, in screen pixels. The whole page is photographed and cut out here: a
  // photograph of a clip is drawn afresh and does not show what the screen would.
  const area = await box.evaluate((el) => {
    const r = el.getBoundingClientRect(), k = devicePixelRatio;
    const left = Math.max(r.left, 0), top = Math.max(r.top, 0), right = Math.min(r.right - 12, innerWidth), bottom = Math.min(r.bottom, innerHeight);
    return { x: Math.ceil(left * k), y: Math.ceil(top * k), width: Math.floor((right - left) * k), height: Math.floor((bottom - top) * k) };
  });
  const base = await box.evaluate((el) => el.scrollTop);
  const pictures: string[] = [];
  for (const offset of OFFSETS) {
    await box.evaluate((el, top) => { el.scrollTop = top; }, base + offset);
    // Drawn again at this offset, which takes the compositor a moment after the frames.
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    await page.waitForTimeout(150);
    pictures.push((await page.screenshot()).toString('base64'));
  }
  return page.evaluate(async ({ shots, area }) => {
    const grey = async (b64: string) => {
      const image = new Image();
      image.src = `data:image/png;base64,${b64}`;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.width;
      canvas.height = image.height;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(image, 0, 0);
      const { data, width, height } = ctx.getImageData(area.x, area.y, area.width, area.height);
      const out = new Uint8Array(width * height);
      for (let i = 0; i < out.length; i++) out[i] = data[i * 4];
      return { out, width, height };
    };
    const first = await grey(shots[0]);
    const BAND = 12, SPAN = 16;
    const result: number[][] = [];
    for (const shot of shots.slice(1)) {
      const next = await grey(shot);
      const found = new Set<number>();
      for (let y = 0; y + BAND + SPAN < next.height; y += BAND + 2) {
        // Rows with something drawn in them: text, not the plain ground between.
        let low = 255, high = 0;
        for (let i = y * next.width; i < (y + BAND) * next.width; i++) { low = Math.min(low, next.out[i]); high = Math.max(high, next.out[i]); }
        if (high - low < 40) continue;
        for (let s = 0; s <= SPAN; s++) {
          let same = true;
          for (let i = 0; same && i < BAND * next.width; i++) same = first.out[(y + s) * first.width + i] === next.out[y * next.width + i];
          if (same) { found.add(s); break; }
        }
      }
      result.push([...found].sort((a, b) => a - b));
    }
    return result;
  }, { shots: pictures, area });
}

/** Every picture shows the text moved as one piece, and enough of it was found to say so. */
function expectOnePiece(found: number[][]) {
  for (const shifts of found) expect(shifts.length, `moved by ${JSON.stringify(found)}`).toBe(1);
}

test('the conversation scrolls as one piece: its lines do not step apart', async ({ page }) => {
  await page.goto('/tests/chat.html?phase=reasoning&turns=40');
  const box = page.locator('.chat-list').locator('..');
  await expect(page.getByText('The last step writes the bundle.')).toBeVisible();
  await spread(box);
  await page.waitForTimeout(300);
  expectOnePiece(await moves(page, box));
});

test('Settings scrolls as one piece, the extensions to discover included', async ({ page }) => {
  await mockPortal(page, ({ path, method }) => {
    if (path === '/api/extensions' && method === 'GET') return { settingsPath: '/a/settings.json', extensions: [] };
    if (path === '/api/extensions/shipped') {
      return { extensions: Array.from({ length: 8 }, (_, i) => ({ name: `pithagoras-example-${i}`, version: '0.1.0', kinds: ['pi'], spec: `/app/extensions/example-${i}`, description: 'Something that comes with the portal, in a sentence or two that takes the card a second line.' })) };
    }
    if (path === '/api/packages/catalog') return { packages: [] };
    return undefined;
  }, { settings: true });
  await page.goto('/settings/extensions');
  await page.getByRole('tab', { name: 'Discover' }).click();
  await expect(page.getByRole('button', { name: 'Install pithagoras-example-0' })).toBeVisible();
  const box = page.getByRole('dialog').locator('.scroll-steady').last();
  expect(await box.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeGreaterThan(100);
  await spread(box);
  await page.waitForTimeout(300);
  expectOnePiece(await moves(page, box));
});

/**
 * A scroller that has no ground of its own is not kept as a layer of its own at 125 %, and its text wobbles; one with an
 * opaque ground is, and keeps the sub-pixel smoothing of the page's text. `will-change` would stop the wobble too, but
 * not keep that smoothing for the sidebar, the pages, Settings and the conversation, which are all drawn over a ground.
 * So each of them has the ground it was drawn over before, as a colour of its own, and the same look.
 */
const colour = (el: Element, name: string) => {
  const probe = document.createElement('canvas').getContext('2d', { willReadFrequently: true })!;
  const read = (value: string) => {
    probe.clearRect(0, 0, 1, 1);
    probe.fillStyle = '#000';
    probe.fillStyle = value;
    probe.fillRect(0, 0, 1, 1);
    return [...probe.getImageData(0, 0, 1, 1).data];
  };
  return name === 'ground' ? read(getComputedStyle(el).backgroundColor) : read(`rgb(${getComputedStyle(document.documentElement).getPropertyValue(name)})`);
};

/** The ground of a box as drawn (all four channels), what the portal's variable `name` is, and whether the box asks for a layer by `will-change`. */
async function ground(box: Locator, over: [string, string, number][]) {
  return box.evaluate((el, { over, src }) => {
    const colour = new Function('el', 'name', `return (${src})(el, name)`) as (el: Element, name: string) => number[];
    const mine = colour(el, 'ground');
    // [variable, other variable or '', share of the first]: the colour the box used to be, laid over what was behind it.
    const [first, second, share] = over[0];
    const a = colour(el, first), b = second ? colour(el, second) : a;
    const expected = a.slice(0, 3).map((v, i) => Math.round(v * share + b[i] * (1 - share)));
    return { mine, expected, willChange: getComputedStyle(el).willChange };
  }, { over, src: colour.toString() });
}

function expectGround(found: { mine: number[]; expected: number[]; willChange: string }) {
  expect(found.mine[3], `ground ${JSON.stringify(found.mine)}`).toBe(255);
  for (let i = 0; i < 3; i++) expect(Math.abs(found.mine[i] - found.expected[i]), `ground ${JSON.stringify(found)}`).toBeLessThanOrEqual(1);
  expect(found.willChange).toBe('auto');
}

test('the conversation is scrolled over an opaque ground of the colour they were drawn over', async ({ page }) => {
  await page.goto('/tests/chat.html?phase=reasoning&turns=40');
  await expect(page.getByText('The last step writes the bundle.')).toBeVisible();
  expectGround(await ground(page.locator('.chat-list').locator('..'), [['--canvas', '', 1]]));
});

test('The sidebar, Settings, its navigation and the server log are scrolled over an opaque ground of the colour they were drawn over', async ({ page }) => {
  await mockPortal(page, ({ path }) => {
    if (path === '/api/logs') return { boot: 'a', gap: false, last: 1, lines: [{ id: 1, level: 'info', text: 'listening', at: '2026-10-01T09:00:00Z' }] };
    return undefined;
  }, { settings: true });
  await page.goto('/settings/logs');
  await expect(page.getByRole('log', { name: 'Server logs' })).toContainText('listening');
  await expect(page.locator('.sidebar-list')).toBeVisible();
  expectGround(await ground(page.locator('.sidebar-list'), [['--surface', '', 1]]));
  expectGround(await ground(page.getByRole('dialog').locator('div.scroll-steady').first(), [['--surface', '', 1]]));
  expectGround(await ground(page.getByRole('dialog').locator('nav.scroll-steady'), [['--canvas', '--surface', 0.4]]));
  expectGround(await ground(page.getByRole('log', { name: 'Server logs' }), [['--raised', '--surface', 0.4]]));
});
