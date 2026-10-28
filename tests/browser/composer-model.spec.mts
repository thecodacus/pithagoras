import { type Page } from '@playwright/test';
import { test, expect, mockPortal, reply } from './portal-mock';

/**
 * The model picker of the composer: which provider a pick goes to, and which
 * chat an answer is drawn for.
 */
const at = new Date().toISOString();
const chat = (id: string, title: string, provider: string, model: string) =>
  ({ id, title, workspace: '/w/site', status: 'idle', kind: 'task', pinned: false, updated_at: at, provider, model, thinking_level: null });
const model = (provider: string, id: string, name = id) => ({ id, name, provider });
const catalogue = [model('prov-a', 'Alpha'), model('prov-a', 'Shared'), model('prov-b', 'Beta'), model('prov-b', 'Shared')];
const config = (current: ReturnType<typeof model>) =>
  ({ live: true, state: { model: current, thinkingLevel: 'medium' }, stats: null, thinking: { levels: ['off', 'medium'] }, models: { models: catalogue }, named: { provider: current.provider, model: current.id } });

type Portal = { posts: unknown[]; failWith: { error: string } | null; hold: { a: Promise<void> | null; post: Promise<void> | null } };

async function portal(page: Page): Promise<Portal> {
  const state: Portal = { posts: [], failWith: null, hold: { a: null, post: null } };
  const sessions = [chat('a', 'First chat', 'prov-a', 'Alpha'), chat('b', 'Second chat', 'prov-b', 'Beta')];
  await mockPortal(page, async ({ path: p, method, json }) => {
    if (p === '/api/sessions') return { sessions, executor: 'host' };
    if (/^\/api\/sessions\/\w+$/.test(p)) return sessions.find((s) => p.endsWith('/' + s.id));
    if (p === '/api/sessions/a/config' && method === 'POST') {
      state.posts.push(json());
      await state.hold.post;
      if (state.failWith) return reply(500, { ...state.failWith, applied: [] });
      return { ok: true, applied: ['model'], state: config(model('prov-b', 'Beta')).state };
    }
    if (p === '/api/sessions/a/config') {
      await state.hold.a;
      return config(model('prov-a', 'Alpha'));
    }
    if (p === '/api/sessions/b/config') return config(model('prov-b', 'Beta'));
    if (p.endsWith('/models')) return config(model('prov-a', 'Alpha'));
    if (p === '/api/workspaces') return { root: '/w', workspaces: [] };
    if (p === '/api/models') return { models: [], providers: {} };
  }, { streams: 'open', settings: true });
  return state;
}

const modelPill = (page: Page) => page.locator('.composer-settings button').first();
/**
 * A model in the full list, by its name. Not by its title: the list opens under the pointer, and the title of the model it
 * comes to rest on is lifted into the portal's own tooltip (tooltips.ts), so a title would find nothing.
 */
const listed = (page: Page, name: string) => page.getByRole('group', { name: 'Models' }).getByRole('button', { name });

test('a model of another provider is picked with its provider, and a pick that fails says so in the menu', async ({ page }) => {
  const state = await portal(page);
  await page.goto('/s/a');
  await expect(modelPill(page)).toHaveText('Alpha');
  await modelPill(page).click();
  await page.getByRole('button', { name: 'More models' }).click();
  state.failWith = { error: 'Model not found: prov-a/Beta' };
  await listed(page, 'Beta').click();
  await expect(page.getByRole('alert')).toHaveText('Model not found: prov-a/Beta');
  // The menu stays, so the pick can be made again.
  await expect(page.getByRole('button', { name: 'Refresh models' })).toBeVisible();
  state.failWith = null;
  await listed(page, 'Beta').click();
  await expect(page.getByRole('button', { name: 'Refresh models' })).toHaveCount(0);
  expect(state.posts).toEqual([{ provider: 'prov-b', modelId: 'Beta' }, { provider: 'prov-b', modelId: 'Beta' }]);
});

test('two providers offering a model of one id are told apart, in what is sent and in what is kept as recent', async ({ page }) => {
  const state = await portal(page);
  await page.goto('/s/a');
  await modelPill(page).click();
  await page.getByRole('button', { name: 'More models' }).click();
  // The second of the two: prov-b's.
  await listed(page, 'Shared').nth(1).click();
  await expect(page.getByRole('button', { name: 'Refresh models' })).toHaveCount(0);
  expect(state.posts).toEqual([{ provider: 'prov-b', modelId: 'Shared' }]);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('pithagoras.recentModels')!))).toEqual(['prov-b/Shared']);
  // Recents kept before they named the provider are bare ids: the first model of that id.
  await page.evaluate(() => localStorage.setItem('pithagoras.recentModels', JSON.stringify(['Shared'])));
  await page.reload();
  await modelPill(page).click();
  const quick = page.locator('.composer-menu button[title]');
  await expect(quick.filter({ hasText: 'Shared' })).toHaveCount(1);
  await expect(quick.filter({ hasText: 'Shared' })).toContainText('prov-a');
});

test("an answer for the chat just left does not draw its model in the chat opened", async ({ page }) => {
  const state = await portal(page);
  let release!: () => void;
  state.hold.a = new Promise<void>((resolve) => { release = resolve; });
  await page.goto('/s/a');
  await page.getByText('Second chat').first().click();
  await expect(page).toHaveURL(/\/s\/b$/);
  await expect(modelPill(page)).toHaveText('Beta');
  // First chat's /config answers late, as it does when pi was starting.
  release();
  await page.waitForTimeout(400);
  await expect(modelPill(page)).toHaveText('Beta');
});

const thinkingPill = (page: Page) => page.getByTitle('Thinking on / off');

test("a failed effort change is not still said under the composer of the chat opened next", async ({ page }) => {
  const state = await portal(page);
  await page.goto('/s/a');
  state.failWith = { error: 'The chat is compacting' };
  await thinkingPill(page).click();
  await expect(page.getByRole('alert')).toHaveText('The chat is compacting');
  await page.getByText('Second chat').first().click();
  await expect(page).toHaveURL(/\/s\/b$/);
  await expect(modelPill(page)).toHaveText('Beta');
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test("a change that fails after its chat was left says nothing in the chat opened, and does not keep it busy", async ({ page }) => {
  const state = await portal(page);
  let release!: () => void;
  state.hold.post = new Promise<void>((resolve) => { release = resolve; });
  state.failWith = { error: 'The chat is compacting' };
  await page.goto('/s/a');
  await thinkingPill(page).click();
  await expect.poll(() => state.posts.length).toBe(1);
  await page.getByText('Second chat').first().click();
  await expect(modelPill(page)).toHaveText('Beta');
  // The other chat's own pills are not waiting on a save that is not theirs.
  await expect(thinkingPill(page)).toBeEnabled();
  release();
  await page.waitForTimeout(400);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(thinkingPill(page)).toBeEnabled();
});

test("a model pick that fails after its chat was left says nothing in the chat opened, and does not keep it busy", async ({ page }) => {
  const state = await portal(page);
  let release!: () => void;
  state.hold.post = new Promise<void>((resolve) => { release = resolve; });
  state.failWith = { error: 'Model not found: prov-a/Beta' };
  await page.goto('/s/a');
  await modelPill(page).click();
  await page.getByRole('button', { name: 'More models' }).click();
  await listed(page, 'Beta').click();
  await expect.poll(() => state.posts.length).toBe(1);
  await page.getByText('Second chat').first().click();
  await expect(page).toHaveURL(/\/s\/b$/);
  await expect(modelPill(page)).toHaveText('Beta');
  release();
  await page.waitForTimeout(400);
  // Not said in the other chat's model menu, and its pills are not waiting on a pick that is not theirs.
  await modelPill(page).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(thinkingPill(page)).toBeEnabled();
});
