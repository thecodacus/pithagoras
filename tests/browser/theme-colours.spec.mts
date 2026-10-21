import { type Page } from '@playwright/test';
import { test, expect, mockPortal } from './portal-mock';

/**
 * Colours that follow the theme: what was written as a fixed colour for the dark theme is read from the same tokens
 * as the rest of the page, so that it is as legible on the light one.
 */

/** What a token is in the page's theme, as the browser writes a colour. */
const token = (page: Page, name: string) =>
  page.evaluate((n) => {
    const probe = document.createElement('i');
    probe.style.color = `rgb(var(--${n}))`;
    document.body.append(probe);
    const colour = getComputedStyle(probe).color;
    probe.remove();
    return colour;
  }, name);

/** A chat that has had a message, with `percent` of its context used. */
async function chat(page: Page, theme: 'light' | 'dark', percent: number) {
  const at = new Date().toISOString();
  const model = { id: 'model-a', name: 'Model A', provider: 'llama-swap' };
  const session = { id: 'a', title: 'First chat', workspace: '/w/site', status: 'idle', kind: 'task', pinned: false, updated_at: at, created_at: at, provider: null, model: null, thinking_level: null };
  const config = {
    live: true, state: { model, thinkingLevel: 'medium' }, thinking: { levels: ['off', 'low', 'medium', 'high'] }, models: { models: [model] }, named: { provider: null, model: null },
    stats: { tokens: { input: 1000, output: 500, total: 1500 }, cost: 0.01, contextUsage: { tokens: percent * 100, contextWindow: 10000, percent }, toolCalls: 2, totalMessages: 4 },
  };
  await page.addInitScript((value) => localStorage.setItem('pithagoras.theme', value), theme);
  await mockPortal(page, ({ path: p, method }) => {
    if (method !== 'GET') return;
    if (p === '/api/sessions') return { sessions: [session], executor: 'host' };
    if (p === '/api/sessions/a') return session;
    if (p === '/api/sessions/a/config' || p === '/api/sessions/a/models') return config;
  }, { streams: 'open', settings: true });
  await page.goto('/s/a');
  await expect.poll(() => page.evaluate(() => (window as any).streams.some((s: any) => !s.closed))).toBe(true);
  await page.evaluate(() => {
    const s = (window as any).streams.find((s: any) => !s.closed);
    s.emit('message', { seq: 1, type: 'portal_prompt', payload: { message: 'Hello there' } });
    s.emit('caught-up', { seq: 1 });
  });
  await expect(page.getByText('Hello there')).toBeVisible();
}

for (const theme of ['light', 'dark'] as const) {
  test(`${theme}: the context donut is drawn in the theme's own green`, async ({ page }) => {
    await chat(page, theme, 20);
    const ring = page.locator('.composer-settings').getByRole('button', { name: /^Context/ }).locator('circle').nth(1);
    await expect(ring).toBeVisible();
    expect(await ring.evaluate((el) => getComputedStyle(el).stroke)).toBe(await token(page, 'ok'));
    // The track behind it is the text colour, faint: not a grey that is only right on the dark one.
    const track = page.locator('.composer-settings').getByRole('button', { name: /^Context/ }).locator('circle').first();
    expect(await track.evaluate((el) => getComputedStyle(el).stroke)).not.toBe('rgb(63, 63, 70)');
  });
  test(`${theme}: the donut turns to the theme's red as the context fills`, async ({ page }) => {
    await chat(page, theme, 95);
    const ring = page.locator('.composer-settings').getByRole('button', { name: /^Context/ }).locator('circle').nth(1);
    expect(await ring.evaluate((el) => getComputedStyle(el).stroke)).toBe(await token(page, 'danger'));
  });
  test(`${theme}: the voice stage's focus ring uses the theme's accent`, async ({ page }) => {
    await mockPortal(page);
    await page.addInitScript((value) => localStorage.setItem('pithagoras.theme', value), theme);
    await page.goto('/sessions');
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    const ring = await page.evaluate(() => {
      document.body.insertAdjacentHTML('beforeend', '<div class="voice-stage"><button id="stage-button">b</button></div>');
      const button = document.querySelector<HTMLButtonElement>('#stage-button')!;
      button.focus();
      return getComputedStyle(button).outlineColor;
    });
    expect(ring).toBe(await token(page, 'accent'));
  });
}

test('the "Run at" field follows the theme, and is not forced to the dark colour scheme', async ({ page }) => {
  const routine = { id: 'r1', slug: 'once', name: 'Once', enabled: true, schedule: '', runAt: '2026-10-10T10:00', mode: 'once', done: false, instructions: 'Say hello', freshSession: true, guard: true, exempt: [], workspace: null, reportChannel: null, reportTarget: null, lastReportAt: null, lastRun: null, lastStatus: null, lastOutput: null, lastMs: null, nextRun: null, createdAt: '' };
  await mockPortal(page, ({ path: p, method }) => {
    if (method !== 'GET') return;
    if (p === '/api/routines') return { routines: [routine] };
    if (p === '/api/routines/preview') return { runs: [] };
    if (p === '/api/workspaces') return { root: '/w', workspaces: [] };
    if (p === '/api/projects') return { root: '/w', home: '/h', projects: [] };
  }, { settings: true });
  await page.addInitScript(() => localStorage.setItem('pithagoras.theme', 'light'));
  await page.goto('/routines');
  await page.getByRole('button', { name: /Once/ }).first().click();
  const field = page.getByLabel('Run at');
  await expect(field).toBeVisible();
  expect(await field.evaluate((el) => getComputedStyle(el).colorScheme)).toBe('light');
});
