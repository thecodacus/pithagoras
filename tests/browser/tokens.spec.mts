import { readFileSync } from 'node:fs';
import path from 'node:path';
import { type Page } from '@playwright/test';
import { test, expect, extensionOnDisk, mockPortal } from './portal-mock';

/**
 * A theme and the person's own choices set the look beyond colour: the variables of index.css, which the preset's
 * utilities read. The portal's classes name a step (`rounded-lg`, `p-4`, `text-sm`), and what a step is comes from
 * the page, so a theme that says another radius or font changes every element that uses one.
 */

const session = { id: 'a', title: 'First chat', workspace: '/w/site', status: 'idle', kind: 'task', pinned: false, updated_at: '2026-11-10T12:00:00Z', created_at: '2026-11-10T12:00:00Z', provider: null, model: null, thinking_level: null };

/** The portal with the look in the browser's storage, as a chosen theme and the person's controls leave it. */
async function portal(page: Page, kept: { tokens?: Record<string, string>; appearance?: { text: number; density: number } }, url = '/sessions') {
  await mockPortal(page, ({ path: p }) => {
    if (p === '/api/sessions') return { sessions: [session], executor: 'host' };
    // The theme the browser has kept is one the portal still has, as it was kept, or it would be put away as one whose extension is gone, or painted as the extension has it now.
    if (p === '/api/extension-ui') return { extensions: [{ name: 'test', version: '1', themes: [{ id: 'look', name: 'Look', dark: { accent: '#0a141e' }, ...(kept.tokens ? { tokens: kept.tokens } : {}) }] }] };
  }, { settings: true });
  await page.addInitScript(({ tokens, appearance }) => {
    localStorage.setItem('pithagoras.theme', 'dark');
    if (tokens) localStorage.setItem('pithagoras.palette', JSON.stringify({ id: 'test/look', name: 'Look', dark: { accent: '10 20 30' }, tokens }));
    if (appearance) localStorage.setItem('pithagoras.appearance', JSON.stringify(appearance));
  }, kept);
  await page.goto(url);
}

const css = (page: Page, selector: string, property: string) => page.locator(selector).first().evaluate((el, name) => getComputedStyle(el).getPropertyValue(name), property);

test('a theme can set the radius of every step, and the font', async ({ page }) => {
  await portal(page, { tokens: { 'radius-lg': '0px', 'radius-xl': '1.5rem', 'font-sans': '"Fixture Face", serif', 'font-mono': 'monospace' } });
  const item = '.nav-item';
  await expect(page.locator(item).first()).toBeVisible();
  expect(await css(page, item, 'border-top-left-radius')).toBe('0px');
  expect(await css(page, 'body', 'font-family')).toBe('"Fixture Face", serif');
  const radius = (step: string) => page.evaluate((name) => { const probe = document.createElement('i'); probe.className = name; document.body.append(probe); return getComputedStyle(probe).borderTopLeftRadius; }, step);
  expect(await radius('rounded-xl')).toBe('24px');
  // The steps that were not said keep the portal's own.
  expect(await radius('rounded-md')).toBe('6px');
  expect(await radius('rounded-2xl')).toBe('16px');
});

test('density is the unit of padding and gaps, and of nothing else', async ({ page }) => {
  await portal(page, { appearance: { text: 100, density: 140 } });
  await expect(page.locator('.nav-item').first()).toBeVisible();
  // px-2.5 py-1.5 gap-2.5 of the sidebar's rows: a unit of 0.35rem instead of 0.25rem.
  expect(await css(page, '.nav-item', 'padding-left')).toBe('14px');
  expect(await css(page, '.nav-item', 'padding-top')).toBe('8.4px');
  expect(await css(page, '.nav-item', 'column-gap')).toBe('14px');
  // Sizes of boxes and icons are not the unit's: the sidebar is 16rem wide, the icons 16px.
  expect(await css(page, 'aside[aria-label="Sidebar"]', 'width')).toBe('256px');
  expect(await css(page, '.nav-item svg', 'width')).not.toBe('22.4px');
});

test("the person's text size scales the steps of the type, and the line heights with them", async ({ page }) => {
  await portal(page, { appearance: { text: 120, density: 100 } });
  await expect(page.locator('.nav-item').first()).toBeVisible();
  // text-sm is 14px with a line of 20px, and text-xs 12px.
  expect(await css(page, '.nav-item', 'font-size')).toBe('16.8px');
  expect(await css(page, '.nav-item', 'line-height')).toBe('24px');
  expect(await page.evaluate(() => { const probe = document.createElement('i'); probe.className = 'text-2xs'; document.body.append(probe); return getComputedStyle(probe).fontSize; })).toBe('13.2px');
  expect(await css(page, 'body', 'font-size')).toBe('19.2px');
});

test("the sidebar's width and the conversation's are the theme's to set", async ({ page }) => {
  await portal(page, { tokens: { 'nav-width': '20rem', 'chat-max': '40rem' } }, '/s/a');
  await expect(page.locator('.nav-item').first()).toBeVisible();
  expect(await css(page, 'aside[aria-label="Sidebar"]', 'width')).toBe('320px');
  expect(await css(page, '.chat-list', 'max-width')).toBe('640px');
});

test('what a layer is above is a variable, with the stock order', async ({ page }) => {
  await portal(page, {}, '/settings');
  const backdrop = page.locator('.ui-backdrop').first();
  await expect(backdrop).toBeVisible();
  expect(await backdrop.evaluate((el) => getComputedStyle(el).zIndex)).toBe('50');
  // The stock order, from what is over what: a confirmation over a viewer over a dialog over the sidebar's backdrop over a panel over what is raised.
  const layers = await page.evaluate(() => ['raised', 'panel', 'panel-top', 'backdrop', 'nav', 'dialog', 'viewer', 'confirm'].map((name) => {
    const probe = document.createElement('i');
    probe.style.cssText = `position: fixed; z-index: var(--z-${name})`;
    document.body.append(probe);
    return Number(getComputedStyle(probe).zIndex);
  }));
  expect(layers).toEqual([10, 20, 21, 40, 50, 50, 55, 60]);
});

test('the look is there before the app: painted by the script in the page, with the app not started', async ({ page }) => {
  await page.route('**/src/main.tsx*', (route) => route.abort());
  await page.addInitScript(() => {
    localStorage.setItem('pithagoras.theme', 'dark');
    localStorage.setItem('pithagoras.palette', JSON.stringify({ id: 'test/look', name: 'Look', dark: { accent: '10 20 30' }, tokens: { 'radius-lg': '0.75rem', pad: '0.2rem' } }));
    localStorage.setItem('pithagoras.appearance', JSON.stringify({ text: 110, density: 90 }));
  });
  await page.goto('/sessions');
  const style = await page.evaluate(() => ['--accent', '--radius-lg', '--pad', '--gap', '--text-base'].map((name) => document.documentElement.style.getPropertyValue(name)));
  expect(style).toEqual(['10 20 30', '0.75rem', 'calc(0.2rem * 0.9)', 'calc(0.25rem * 0.9)', 'calc(1rem * 1.1)']);
});

test('a theme with a value that is not one is not painted, and the app says the same as the page did', async ({ page }) => {
  await portal(page, { tokens: { 'radius-lg': '0px', 'font-sans': 'x; background: red' } });
  await expect(page.locator('.nav-item').first()).toBeVisible();
  // Refused whole: the radius it also said is not painted, and the font is the portal's.
  expect(await css(page, '.nav-item', 'border-top-left-radius')).toBe('8px');
  expect(await css(page, 'body', 'font-family')).toContain('ui-sans-serif');
});

/** A package that brings a theme with new tokens beside its colours, and one whose tokens are hostile, as the portal's server lists them. */
const SOFT = { id: 'soft', name: 'Soft', dark: { accent: '#7aa2f7' }, tokens: { 'radius-lg': '1.25rem', 'radius-md': '0px', 'font-sans': '"Fixture Face", serif', pad: '0.35rem', gap: '0.5rem', 'text-base': '1.125rem' } };
const HOSTILE = { id: 'hostile', name: 'Hostile', dark: { accent: '#ff0000' }, tokens: { 'radius-lg': '0px', 'font-sans': 'x; background: url(https://example.test/x.png)' } };

async function themed(page: Page, themes: unknown[], more: unknown[] = []) {
  await mockPortal(page, ({ path: p }) => {
    if (p === '/api/sessions') return { sessions: [session], executor: 'host' };
    if (p === '/api/extension-ui') return { extensions: [{ name: 'look-pkg', version: '1', themes }, ...more] };
  }, { settings: true });
  await page.addInitScript(() => localStorage.setItem('pithagoras.theme', 'dark'));
  await page.goto('/settings/browser');
}

test('a theme with new tokens, chosen in Settings, changes the radius, the font and the density of the whole page, and goes with the theme', async ({ page }) => {
  await themed(page, [SOFT]);
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  const colours = dialog.getByRole('combobox', { name: 'Colours' });
  const rows = '.nav-item';
  await expect(page.locator(rows).first()).toBeVisible();
  // As the portal ships.
  expect(await css(page, rows, 'border-top-left-radius')).toBe('8px');
  expect(await css(page, rows, 'padding-left')).toBe('10px');
  await colours.click();
  await page.getByRole('option', { name: /Soft/ }).click();
  // rounded-lg is the theme's, rounded-md too, the font is its stack, a row's px-2.5 is 2.5 of its unit and gap-2.5 as well.
  await expect.poll(() => css(page, rows, 'border-top-left-radius')).toBe('20px');
  expect(await css(page, 'body', 'font-family')).toBe('"Fixture Face", serif');
  expect(await css(page, rows, 'padding-left')).toBe('14px');
  expect(await css(page, rows, 'column-gap')).toBe('20px');
  expect(await css(page, 'body', 'font-size')).toBe('18px');
  // Kept whole, painted again at the next start.
  await page.reload();
  await expect(page.locator(rows).first()).toBeVisible();
  expect(await css(page, rows, 'border-top-left-radius')).toBe('20px');
  // Back to the portal's own: all of it is.
  await colours.click();
  await page.getByRole('option', { name: "The portal's own" }).click();
  await expect.poll(() => css(page, rows, 'border-top-left-radius')).toBe('8px');
  expect(await css(page, rows, 'padding-left')).toBe('10px');
  expect(await css(page, 'body', 'font-family')).toContain('ui-sans-serif');
});

test('a package with a theme whose tokens are hostile fails alone: none of its themes is offered, nothing of it reaches the page, and another package is not touched', async ({ page }) => {
  const requested: string[] = [];
  page.on('request', (request) => requested.push(request.url()));
  await themed(page, [HOSTILE, { ...SOFT, id: 'good', name: 'Good' }], [{ name: 'fine-pkg', version: '1', themes: [{ id: 'ok', name: 'Fine', dark: { accent: '#00ff00' } }] }]);
  const colours = page.getByRole('dialog', { name: 'Settings' }).getByRole('combobox', { name: 'Colours' });
  // The package that is fine is on offer, which says the list was gone through; the hostile one's themes are not, not even its good one.
  await expect(colours).toBeVisible();
  await colours.click();
  await expect(page.getByRole('option')).toHaveText([/^The portal's own/, /^Fine/]);
  await page.keyboard.press('Escape');
  expect(await css(page, '.nav-item', 'border-top-left-radius')).toBe('8px');
  expect(await page.evaluate(() => document.documentElement.getAttribute('style') ?? '')).not.toMatch(/url|example\.test|background/);
  expect(requested.filter((url) => url.includes('example.test'))).toEqual([]);
});

test("the person's text size and spacing sliders change what is made of text and of padding, and are kept", async ({ page }) => {
  await themed(page, [SOFT]);
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  const colours = dialog.getByRole('combobox', { name: 'Colours' });
  await expect(colours).toBeVisible();
  const size = dialog.getByRole('slider', { name: 'Text size' });
  const spacing = dialog.getByRole('slider', { name: 'Spacing' });
  await expect(size).toHaveValue('100');
  await expect(spacing).toHaveValue('100');
  // The select is set in the stylesheet in px (13px), not by a utility: it follows the text size as well.
  expect(await css(page, '.ui-select-md', 'font-size')).toBe('13px');
  await size.fill('120');
  await spacing.fill('140');
  await expect(dialog.getByText('120 %')).toBeVisible();
  await expect.poll(() => css(page, '.nav-item', 'padding-left')).toBe('14px');
  expect(await css(page, 'body', 'font-size')).toBe('19.2px');
  expect(await css(page, '.ui-select-md', 'font-size')).toBe('15.6px');
  // Over a theme's own unit: its 0.35rem with the person's 90 %.
  await colours.click();
  await page.getByRole('option', { name: /Soft/ }).click();
  await spacing.fill('90');
  await expect.poll(() => css(page, '.nav-item', 'padding-left')).toBe('12.6px');
  // Kept in this browser, and back with one click.
  await page.reload();
  await expect(dialog.getByRole('slider', { name: 'Text size' })).toHaveValue('120');
  expect(await css(page, 'body', 'font-size')).toBe('21.6px');
  await dialog.getByRole('button', { name: 'Back to 100 %' }).click();
  await expect(dialog.getByRole('slider', { name: 'Text size' })).toHaveValue('100');
  await expect(dialog.getByRole('slider', { name: 'Spacing' })).toHaveValue('100');
  await expect(dialog.getByRole('button', { name: 'Back to 100 %' })).toHaveCount(0);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('pithagoras.appearance') ?? '{}'))).toEqual({ text: 100, density: 100 });
});

test("a theme's font is a file its extension ships and its stylesheet declares: the theme names the family, and the portal serves the file", async ({ page }) => {
  const font = readFileSync(new URL('../../node_modules/katex/dist/fonts/KaTeX_Main-Regular.woff2', import.meta.url));
  const served: string[] = [];
  await mockPortal(page, ({ path: p }) => {
    if (p === '/api/sessions') return { sessions: [session], executor: 'host' };
  }, { settings: true });
  // The extension as it is on disk, listed as the portal lists it; its font is a file of its own that the test stands in for.
  const ext = extensionOnDisk(path.resolve(import.meta.dirname, '../fixtures/extensions/typeface'));
  await page.route('**/api/extension-ui**', async (route) => {
    const { pathname } = new URL(route.request().url());
    if (pathname === '/api/extension-ui') return route.fulfill({ json: { extensions: [ext.listing] } });
    if (pathname.endsWith('/assets/face.woff2')) return served.push(pathname), route.fulfill({ body: font, contentType: 'font/woff2' });
    if (await ext.serve(pathname, route)) return;
    return route.fulfill({ status: 404, json: { error: 'Not found' } });
  });
  await page.addInitScript(() => localStorage.setItem('pithagoras.theme', 'dark'));
  await page.goto('/settings/browser');
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await dialog.getByRole('combobox', { name: 'Colours' }).click();
  await page.getByRole('option', { name: /Face/ }).click();
  expect(await css(page, 'body', 'font-family')).toBe('"Shipped Face", sans-serif');
  // The stylesheet came with the extension, and so did the file: the family is a face the page has loaded, from the portal itself.
  await expect.poll(() => page.evaluate(async () => (await document.fonts.load('16px "Shipped Face"')).length)).toBe(1);
  expect(served).toEqual(['/api/extension-ui/test-typeface/assets/face.woff2']);
  expect(await page.evaluate(() => [...document.fonts].filter((face) => face.family.includes('Shipped Face')).map((face) => face.status))).toEqual(['loaded']);
});
