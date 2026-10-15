import { fileURLToPath } from 'node:url';
import { type Page } from '@playwright/test';
import { buildExtension } from '../../packages/extension-api/build.mjs';
import { test, expect, mockPortal, extensionOnDisk, DONE } from './portal-mock';

/**
 * An extension written in TypeScript and JSX, bundled with
 * @pithagoras/extension-api/build (tests/fixtures/extensions/bundled): its
 * components use React's hooks as they import them, which only works with the
 * portal's own React, its stylesheet is its own, and a part of it is fetched
 * only when it is asked for.
 */
const DIR = fileURLToPath(new URL('../fixtures/extensions/bundled/', import.meta.url));

test.beforeAll(async () => {
  await buildExtension({ dir: DIR, minify: false });
});

async function portal(page: Page) {
  const at = new Date().toISOString();
  const session = { id: 'a', title: 'First chat', workspace: '/w/site', status: 'idle', kind: 'task', pinned: false, updated_at: at, provider: null, model: null, thinking_level: null };
  const model = { id: 'model-a', name: 'Model A', provider: 'llama-swap' };
  const sample = extensionOnDisk(DIR);
  await mockPortal(page, async ({ path: p, route }) => {
    if (p === '/api/extension-ui') return { extensions: [sample.listing] };
    if (await sample.serve(p, route)) return DONE;
    if (p === '/api/sessions') return { sessions: [session], executor: 'host' };
    if (p === '/api/sessions/a') return session;
    if (/^\/api\/sessions\/a\/(config|models)$/.test(p)) return { live: false, state: { model, thinkingLevel: 'medium' }, stats: null, thinking: { levels: ['off', 'medium'] }, models: { models: [model] }, named: { provider: null, model: null } };
    if (p === '/api/models') return { models: [], providers: {} };
  }, { streams: 'open', settings: true });
}

test('a bundled extension draws with the portal\'s React, its own stylesheet, and a part fetched only when asked for', async ({ page }) => {
  const chunks: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/api/extension-ui/bundled-sample/chunks/')) chunks.push(request.url());
  });
  await portal(page);
  await page.goto('/s/a');
  await page.getByRole('button', { name: 'Bundled', exact: true }).click();
  const panel = page.locator('.bundled-sample');
  // useState, imported from "react" by the bundle, keeps its count: the hooks are the portal's.
  await panel.getByRole('button', { name: 'Count 0' }).click();
  await expect(panel.getByRole('button', { name: 'Count 1' })).toBeVisible();
  expect(chunks).toEqual([]);

  await panel.getByRole('button', { name: 'Load the rest' }).click();
  await expect(panel.getByText('Loaded later')).toBeVisible();
  expect(chunks).toHaveLength(1);
  // Its own stylesheet, imported by its code and served beside its module.
  await expect(panel.getByText('Loaded later')).toHaveCSS('color', 'rgb(1, 2, 3)');
});
