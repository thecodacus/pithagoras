import { test, expect } from './portal-mock';

test("the model menu's providers link goes through the router, as any other link", async ({ page }) => {
  await page.goto('/tests/chat.html?phase=model');
  await page.getByTitle('Model A', { exact: true }).click();
  await page.getByRole('button', { name: 'Add or change providers…' }).click();
  await expect(page).toHaveURL(/\/s\/preview\/settings\/models$/);
  // An entry the router made itself: it knows where it is in history, so back and forward keep their order.
  expect(await page.evaluate(() => typeof history.state?.idx)).toBe('number');
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
