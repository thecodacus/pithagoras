import { type Page } from '@playwright/test';
import { test, expect } from './portal-mock';

/**
 * What a tool call gave the person, under its card: any tool's, as the portal found the files by their bytes
 * (file-outputs.ts). Over the chat fixture (core/web/tests/chat.tsx, `?phase=outputs`), whose plot_sales call
 * gave a picture, a clip and a CSV file.
 */

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');

async function chat(page: Page, extensions: unknown[] = [], module?: string) {
  await page.route('**/api/sessions/preview/picture?**', (route) => route.fulfill({ body: PNG, contentType: 'image/png' }));
  // A clip that is still on its way: an empty one would fail to play, and be said to be gone.
  await page.route('**/api/sessions/preview/video?**', () => {});
  await page.route('**/api/extension-ui', (route) => route.fulfill({ json: { extensions } }));
  if (module) await page.route('**/api/extension-ui/my-plots/client.js*', (route) => route.fulfill({ contentType: 'text/javascript', body: module }));
  const listed = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/extension-ui');
  await page.goto('/tests/chat.html?phase=outputs');
  await listed;
  await expect(page.getByText('Sales doubled.')).toBeVisible();
}

test('any tool\'s files are under its card: a picture that opens in the viewer, a clip in its player, and any other file to save', async ({ page }) => {
  await chat(page);
  const row = page.locator('.tool-row', { has: page.locator('.chat-tool-head', { hasText: 'plot_sales' }) });
  // The picture, by the end that gave it, as every other place asks for it.
  const picture = row.getByRole('img', { name: 'Sales by month' });
  await expect(picture).toHaveAttribute('src', /^\/api\/sessions\/preview\/picture\?path=plots%2Fsales\.png&v=\d+$/);
  await expect(row.locator('video')).toHaveAttribute('src', /^\/api\/sessions\/preview\/video\?path=plots%2Fsales\.mp4&v=\d+$/);
  await expect(row.locator('video')).toHaveAttribute('aria-label', 'Sales, month by month');
  const file = row.getByRole('link', { name: 'plots/sales.csv' });
  await expect(file).toHaveAttribute('href', /^\/api\/sessions\/preview\/file\?path=plots%2Fsales\.csv&v=\d+$/);
  await expect(file).toHaveAttribute('download', '');
  // A picture opens in the chat's viewer, with its title.
  await picture.click();
  const viewer = page.getByRole('dialog');
  await expect(viewer).toBeVisible();
  await expect(viewer).toContainText('Sales by month');
});

/** An extension's own card for plot_sales: one that draws the files its own way, from what it is told of the call. */
const MINE = `export default function (portal) {
  const h = portal.React.createElement;
  portal.slots.register("chat.tool", {
    id: "plots", tool: "plot_sales",
    component: ({ call }) => h("ul", { "data-testid": "my-card" }, (call.files ?? []).map((f) => h("li", { key: f.path }, f.kind + " " + f.path + " " + f.url))),
  });
}`;

test('a tool with a card of its own draws its files its own way, told what each is and where it is fetched from', async ({ page }) => {
  await chat(page, [{ name: 'my-plots', version: '1.0.0', entry: '/api/extension-ui/my-plots/client.js?v=1' }], MINE);
  const card = page.getByTestId('my-card');
  await expect(card.locator('li')).toHaveText([
    /^picture plots\/sales\.png \/api\/sessions\/preview\/picture\?path=plots%2Fsales\.png&v=\d+$/,
    /^video plots\/sales\.mp4 \/api\/sessions\/preview\/video\?path=plots%2Fsales\.mp4&v=\d+$/,
    /^file plots\/sales\.csv \/api\/sessions\/preview\/file\?path=plots%2Fsales\.csv&v=\d+$/,
  ]);
  // The portal's card, and the portal's drawing of the files with it, are not there: the extension's card is in their place.
  await expect(page.locator('.chat-tool-head', { hasText: 'plot_sales' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'plots/sales.csv' })).toHaveCount(0);
});

/** One that draws the call's picture with the portal's preview, and says when the call started. */
const PREVIEW = `export default function (portal) {
  const h = portal.React.createElement;
  portal.slots.register("chat.tool", {
    id: "plots", tool: "plot_sales",
    component: ({ call }) => h("div", { "data-testid": "my-card" },
      h("p", { "data-testid": "since" }, typeof call.since),
      h(portal.ui.ImagePreview, { state: "done", file: (call.files ?? []).find((f) => f.kind === "picture"), title: "Sales by month" })),
  });
}`;

test('an extension\'s card shows a picture its call gave with the portal\'s preview, which opens the chat\'s viewer at it', async ({ page }) => {
  await chat(page, [{ name: 'my-plots', version: '1.0.0', entry: '/api/extension-ui/my-plots/client.js?v=1' }], PREVIEW);
  const card = page.getByTestId('my-card');
  await expect(card.getByTestId('since')).toHaveText('number');
  const picture = card.getByRole('img', { name: 'Sales by month' });
  await expect(picture).toHaveAttribute('src', /^\/api\/sessions\/preview\/picture\?path=plots%2Fsales\.png&v=\d+$/);
  await card.getByRole('button', { name: 'Sales by month' }).click();
  const viewer = page.getByRole('dialog');
  await expect(viewer).toBeVisible();
  await expect(viewer).toContainText('Sales by month');
  // Closed, it gives the focus back to the picture it was opened from.
  await page.keyboard.press('Escape');
  await expect(viewer).toHaveCount(0);
  await expect(card.getByRole('button', { name: 'Sales by month' })).toBeFocused();
});
