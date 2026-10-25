import { test, expect } from './portal-mock';

test("the model menu's providers link goes through the router, as any other link", async ({ page }) => {
  await page.goto('/tests/chat.html?phase=model');
  await page.getByTitle('Model A', { exact: true }).click();
  await page.getByRole('button', { name: 'Add or change providers…' }).click();
  await expect(page).toHaveURL(/\/s\/preview\/settings\/models$/);
  // An entry the router made itself: it knows where it is in history, so back and forward keep their order.
  expect(await page.evaluate(() => typeof history.state?.idx)).toBe('number');
});

/** The subagent extension's settings, as its server half answers them: what a chat's own choice falls back to. */
const extensionSettings = (model = 'auto') => ({ mode: 'interrupt', maxParallel: 1, maxParallelLimit: 16, model });

test("with the subagent tool on, the model menu says what this chat's subagents run on, and a choice there is kept", async ({ page }) => {
  const saved: unknown[] = [];
  await page.route('**/api/features/flags', (route) => route.fulfill({ json: { subagent: { enabled: true }, memory: { held: false, by: null } } }));
  await page.route('**/api/x/pithagoras-subagent/settings', (route) => route.fulfill({ json: extensionSettings() }));
  await page.route('**/api/sessions/preview/subagent-model', async (route) => {
    if (route.request().method() === 'PUT') {
      const { model } = route.request().postDataJSON();
      saved.push(model);
      return route.fulfill({ json: { model } });
    }
    await route.fulfill({ json: { model: null } });
  });
  await page.goto('/tests/chat.html?phase=model');
  await page.getByTitle('Model A', { exact: true }).click();
  const picker = page.getByRole('combobox', { name: 'Subagents in this chat run on' });
  await expect(picker).toContainText("Default — this chat's model");
  await picker.click();
  await page.getByRole('option', { name: /This chat's model/ }).click();
  // The menu stays open across the choice made in it.
  await expect(picker).toContainText("This chat's model");
  expect(saved).toEqual(['auto']);
});

test('without the subagent tool, the model menu has nothing about subagents', async ({ page }) => {
  await page.route('**/api/features/flags', (route) => route.fulfill({ json: { subagent: { enabled: false }, memory: { held: false, by: null } } }));
  await page.goto('/tests/chat.html?phase=model');
  await page.getByTitle('Model A', { exact: true }).click();
  await expect(page.getByRole('button', { name: 'Add or change providers…' })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Subagents in this chat run on' })).toHaveCount(0);
});

test("the subagents' row is asked for with the chat, so the model menu opens with it already there", async ({ page }) => {
  let asked = 0;
  await page.route('**/api/features/flags', (route) => route.fulfill({ json: { subagent: { enabled: true }, memory: { held: false, by: null } } }));
  await page.route('**/api/x/pithagoras-subagent/settings', (route) => route.fulfill({ json: extensionSettings() }));
  await page.route('**/api/sessions/preview/subagent-model', async (route) => {
    asked++;
    await new Promise((r) => setTimeout(r, 300));
    await route.fulfill({ json: { model: 'llama-swap/model-b' } });
  });
  await page.goto('/tests/chat.html?phase=model');
  await expect.poll(() => asked).toBe(1);
  await page.waitForTimeout(400);
  await page.getByTitle('Model A', { exact: true }).click();
  // There in the first frame: nothing arrives after the menu to push it about.
  await expect(page.getByRole('combobox', { name: 'Subagents in this chat run on' })).toContainText('llama-swap/model-b', { timeout: 150 });
});

const catalogue = (ids: string[]) => ({
  live: true, stats: null, thinking: { levels: ['off', 'low', 'medium', 'high'] },
  state: { model: { id: 'Model A', name: 'Model A', provider: 'llama-server' }, thinkingLevel: 'medium' },
  models: { models: ids.map((id) => ({ id, name: id, provider: 'llama-swap' })) },
});
const cached = (ago: number) => ({ at: Date.now() - ago, models: [{ id: 'Old model', name: 'Old model', provider: 'llama-swap' }] });

test('the model list cached in the browser is fetched again once it has expired, and the refresh icon fetches it at once', async ({ page }) => {
  let fetched = 0;
  await page.route('**/api/sessions/preview/models', (route) => { fetched++; return route.fulfill({ json: catalogue(['New model']) }); });
  // Cached two hours ago: older than its expiry.
  await page.addInitScript((value) => { if (!sessionStorage.getItem('seeded')) { localStorage.setItem('modelCatalogue.v2', JSON.stringify(value)); sessionStorage.setItem('seeded', '1'); } }, cached(2 * 60 * 60 * 1000));
  await page.goto('/tests/chat.html?phase=model');
  const pill = page.getByTitle('Model A', { exact: true });
  await pill.click();
  await expect.poll(() => fetched).toBe(1);
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('modelCatalogue.v2')!).models.map((m: { id: string }) => m.id))).toEqual(['New model']);
  // Fresh now: opening the menu again asks for nothing.
  await page.keyboard.press('Escape');
  await pill.click();
  await page.waitForTimeout(300);
  expect(fetched).toBe(1);
  // The icon fetches it at once, fresh or not.
  await page.getByRole('button', { name: 'Refresh models' }).click();
  await expect.poll(() => fetched).toBe(2);
});

test('a model list cached within its expiry is used as it is', async ({ page }) => {
  let fetched = 0;
  await page.route('**/api/sessions/preview/models', (route) => { fetched++; return route.fulfill({ json: catalogue(['New model']) }); });
  await page.addInitScript((value) => localStorage.setItem('modelCatalogue.v2', JSON.stringify(value)), cached(60 * 1000));
  await page.goto('/tests/chat.html?phase=model');
  await page.getByTitle('Model A', { exact: true }).click();
  await expect(page.getByRole('button', { name: 'Refresh models' })).toBeVisible();
  await page.waitForTimeout(300);
  expect(fetched).toBe(0);
});

test("a model picked in the menu is asked for with its own provider, not the one the chat was on", async ({ page }) => {
  const asked: unknown[] = [];
  // The chat is on a provider since renamed: llama-server, whose models are now llama-swap's.
  await page.route('**/api/sessions/preview/models', (route) => route.fulfill({ json: catalogue(['strata-1gpu']) }));
  await page.route('**/api/sessions/preview/config', (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    asked.push(route.request().postDataJSON());
    return route.fulfill({ json: { ok: true, applied: ['model'], state: catalogue([]).state } });
  });
  await page.goto('/tests/chat.html?phase=model');
  await page.getByTitle('Model A', { exact: true }).click();
  await page.getByRole('button', { name: 'More models' }).click();
  await page.getByTitle('strata-1gpu', { exact: true }).click();
  await expect.poll(() => asked).toEqual([{ provider: 'llama-swap', modelId: 'strata-1gpu' }]);
});
