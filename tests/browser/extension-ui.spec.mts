import { readFileSync } from 'node:fs';
import { type Page } from '@playwright/test';
import { test, expect, mockPortal, DONE } from './portal-mock';

/**
 * An extension that draws in the portal: the Notes extension's own browser
 * half (extensions/notes/web), loaded into the app as the portal serves it.
 */
const NAME = 'pithagoras-notes';
const web = (file: string) => readFileSync(new URL(`../../extensions/notes/web/${file}`, import.meta.url), 'utf8');
const address = (name: string, file: string) => `/api/extension-ui/${name}/${file}`;

async function portal(page: Page, module = web('client.js')) {
  const at = new Date().toISOString();
  const sessions = [
    { id: 'a', title: 'First chat', workspace: '/w/site', status: 'idle', kind: 'task', pinned: false, updated_at: at, provider: null, model: null, thinking_level: null },
    { id: 'b', title: 'Second chat', workspace: '/w/site', status: 'idle', kind: 'task', pinned: false, updated_at: at, provider: null, model: null, thinking_level: null },
  ];
  const model = { id: 'model-a', name: 'Model A', provider: 'llama-swap' };
  const state = { installed: true, revision: 1 };
  /** What the browser half said to its extension, by chat. */
  const said: { chat: string; extension: string; data: any }[] = [];
  await mockPortal(page, async ({ path: p, method, route, json }) => {
    if (p === '/api/extension-ui') {
      const v = `?v=${state.revision}`;
      return { extensions: state.installed ? [{ name: NAME, version: '0.1.0', entry: address(NAME, 'client.js') + v, style: address(NAME, 'client.css') + v }] : [] };
    }
    if (p === address(NAME, 'client.js')) { await route.fulfill({ contentType: 'text/javascript', body: module }); return DONE; }
    if (p === address(NAME, 'client.css')) { await route.fulfill({ contentType: 'text/css', body: web('client.css') }); return DONE; }
    if (p === '/api/sessions') return { sessions, executor: 'host' };
    const told = /^\/api\/sessions\/(\w+)\/extension-ui$/.exec(p);
    if (told && method === 'POST') { said.push({ chat: told[1], ...json() }); return { ok: true }; }
    if (/^\/api\/sessions\/\w+$/.test(p)) return sessions.find((s) => p.endsWith('/' + s.id));
    if (/^\/api\/sessions\/\w+\/(config|models)$/.test(p)) return { live: false, state: { model, thinkingLevel: 'medium' }, stats: null, thinking: { levels: ['off', 'medium'] }, models: { models: [model] }, named: { provider: null, model: null } };
    if (p.endsWith('/canvases')) return [];
    if (p === '/api/models') return { models: [], providers: {} };
  }, { streams: 'open', settings: true });
  /** What the extension in a chat says to its browser half, as the chat's stream carries it. */
  const hears = (chat: string, data: unknown) =>
    page.evaluate(([chat, extension, data]) => {
      const stream = (window as any).streams.find((s: any) => !s.closed && s.url.includes(`/api/sessions/${chat}/events`));
      stream.emit('message', { seq: -1, type: 'portal_extension_ui', payload: { type: 'portal_extension_ui', extension, data } });
    }, [chat, NAME, data] as const);
  /** What is installed changed, as Settings says when it installs, removes or switches a package. */
  const changed = (to: Partial<typeof state>) => {
    Object.assign(state, to);
    return page.evaluate(() => window.dispatchEvent(new Event('pithagoras:extensions-changed')));
  };
  return { said, hears, changed };
}

/** What was said besides asking where things stand: development React draws each part twice, and each asks. */
const acts = (said: { data: any }[]) => said.map((s) => s.data).filter((data) => data.type !== 'ready');
const header = (page: Page) => page.locator('.chat-header');
const panel = (page: Page) => page.locator('.chat-aside').filter({ has: page.locator('.chat-aside-head', { hasText: 'Notes' }) });
const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Destinations' });

test('an extension\'s panel is opened from the chat\'s header, talks to its extension in that chat, and closes like the portal\'s own', async ({ page }) => {
  await page.setViewportSize({ width: 1300, height: 800 });
  const { said, hears } = await portal(page);
  await page.goto('/s/a');
  const toggle = header(page).getByRole('button', { name: 'Notes', exact: true });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  // Its button, and the extension's own control beside it, are the size of the portal's.
  const sizes = await header(page).getByRole('button').evaluateAll((items) => Object.fromEntries(items.map((b) => [b.getAttribute('aria-label'), [b.getBoundingClientRect().height, b.querySelector('svg')?.getBoundingClientRect().width]])));
  expect(sizes.Notes).toEqual(sizes.Files);
  expect(sizes["Pin the agent's last reply to Notes"]).toEqual(sizes.Files);
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(panel(page)).toBeVisible();
  // Drawn, it asks its extension where things stand.
  await expect(panel(page)).toContainText('Loading…');
  await expect.poll(() => said[0]).toEqual({ chat: 'a', extension: NAME, data: { type: 'ready' } });
  await hears('a', { type: 'notes', notes: [{ id: 1, text: 'Ship on Friday', by: 'agent' }] });
  await expect(panel(page).getByRole('listitem')).toHaveText(['AgentShip on Friday✕']);
  // In the portal's own colours, from the stylesheet it brought.
  await expect(page.locator(`link[data-extension="${NAME}"]`)).toHaveCount(1);
  expect(await panel(page).locator('.pn-list li').evaluate((li) => getComputedStyle(li).borderTopLeftRadius)).toBe('10px');

  await panel(page).getByRole('textbox', { name: 'New note' }).fill('Call the printer');
  await panel(page).getByRole('button', { name: 'Pin', exact: true }).click();
  await panel(page).getByRole('button', { name: 'Remove this note' }).click();
  await expect.poll(() => acts(said)).toEqual([{ type: 'add', text: 'Call the printer' }, { type: 'remove', id: 1 }]);
  // What another extension is told is not this one's.
  await page.evaluate(() => (window as any).streams.find((s: any) => !s.closed && s.url.includes('/api/sessions/a/events')).emit('message', { seq: -2, type: 'portal_extension_ui', payload: { extension: 'another', data: { type: 'notes', notes: [] } } }));
  await expect(panel(page).getByRole('listitem')).toHaveCount(1);

  // Two panels beside the conversation is what fits: a third closes the one open longest, whoever brought it.
  await header(page).getByRole('button', { name: 'Terminal', exact: true }).click();
  await header(page).getByRole('button', { name: 'Files', exact: true }).click();
  await expect(panel(page)).toHaveCount(0);
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();
  await panel(page).getByRole('button', { name: 'Close Notes' }).click();
  await expect(panel(page)).toHaveCount(0);
});

test('an extension\'s control in the header acts on the chat it is in, and opens the extension\'s own panel', async ({ page }) => {
  await page.setViewportSize({ width: 1300, height: 800 });
  const { said, hears } = await portal(page);
  await page.goto('/s/a');
  await header(page).getByRole('button', { name: "Pin the agent's last reply to Notes" }).click();
  await expect(panel(page)).toBeVisible();
  await expect.poll(() => acts(said)).toEqual([{ type: 'pin-last' }]);
  expect(said.every((s) => s.chat === 'a' && s.extension === NAME)).toBe(true);
  await hears('a', { type: 'nothing-to-pin' });
  await expect(header(page).getByRole('button', { name: 'The agent has not replied yet' })).toBeVisible();

  // In another chat it is that chat's: drawn anew, asking that chat's extension.
  await hears('a', { type: 'notes', notes: [{ id: 1, text: 'Only in the first chat', by: 'you' }] });
  await expect(panel(page)).toContainText('Only in the first chat');
  await page.getByRole('complementary', { name: 'Sidebar' }).getByText('Second chat', { exact: true }).click();
  await expect(page).toHaveURL(/\/s\/b$/);
  await expect(panel(page)).toContainText('Loading…');
  await expect.poll(() => said.at(-1)).toEqual({ chat: 'b', extension: NAME, data: { type: 'ready' } });
});

test('an extension\'s page is in the sidebar, at an address of its own, and can go to the portal\'s pages', async ({ page }) => {
  await portal(page);
  // Opened by its address, before the extension is in the page.
  await page.goto(`/x/${NAME}/notes`);
  await expect(page.getByRole('heading', { name: 'Notes' })).toBeVisible();
  await expect(sidebar(page).getByRole('button', { name: 'Notes' })).toHaveAttribute('aria-current', 'page');
  // Its icon is a bare <svg>: the portal gives it the size its own icons have.
  const icons = await sidebar(page).getByRole('button').evaluateAll((items) => Object.fromEntries(items.map((b) => [b.textContent!.trim(), b.querySelector('svg')!.getBoundingClientRect().width])));
  expect(icons.Notes).toBeGreaterThan(0);
  expect(icons.Notes).toBe(icons.Audit);
  await page.locator('.pn-chats').getByRole('button', { name: 'Second chat' }).click();
  await expect(page).toHaveURL(/\/s\/b$/);
  await sidebar(page).getByRole('button', { name: 'Notes' }).click();
  await expect(page).toHaveURL(new RegExp(`/x/${NAME}/notes$`));
});

test('an extension removed, or changed, is taken out of the page and loaded again without a reload of the portal', async ({ page }) => {
  await page.setViewportSize({ width: 1300, height: 800 });
  const { changed } = await portal(page);
  await page.goto('/s/a');
  const toggle = header(page).getByRole('button', { name: 'Notes', exact: true });
  await toggle.click();
  await expect(panel(page)).toBeVisible();

  await changed({ installed: false });
  await expect(toggle).toHaveCount(0);
  await expect(panel(page)).toHaveCount(0);
  await expect(sidebar(page).getByRole('button', { name: 'Notes' })).toHaveCount(0);
  await expect(page.locator(`link[data-extension="${NAME}"]`)).toHaveCount(0);
  await page.goto(`/x/${NAME}/notes`);
  await expect(page.getByRole('alert')).toHaveText("This page's extension is not installed, or is switched off.");

  // Installed again, under another revision: its module is fetched anew.
  await changed({ installed: true, revision: 2 });
  await expect(page.getByRole('heading', { name: 'Notes' })).toBeVisible();
  await expect(sidebar(page).getByRole('button', { name: 'Notes' })).toHaveCount(1);
});

test('an extension that fails to load, or to draw, fails alone', async ({ page }) => {
  const broken = `export default function (portal) {
    portal.slots.register("nav.page", { id: "fine", title: "Registered first", component: () => null });
    portal.slots.register("no.such.slot", { id: "x", component: () => null });
  }`;
  await portal(page, broken);
  await page.goto(`/x/${NAME}/fine`);
  const failed = page.getByRole('alert');
  await expect(failed).toContainText("This page's extension could not be loaded.");
  await expect(failed).toContainText('There is no slot called "no.such.slot"');
  // What it registered before it failed is gone with it, and the portal is as it was.
  await expect(sidebar(page).getByRole('button', { name: 'Registered first' })).toHaveCount(0);
  await expect(sidebar(page).getByRole('button', { name: 'Sessions' })).toBeVisible();

  const { changed } = await portal(page, `export default function (portal) {
    portal.slots.register("nav.page", { id: "fine", title: "Draws badly", component: () => { throw new Error("drew badly"); } });
  }`);
  await changed({ revision: 3 });
  await expect(page.getByRole('alert')).toContainText('drew badly');
  await expect(sidebar(page).getByRole('button', { name: 'Draws badly' })).toBeVisible();
});
