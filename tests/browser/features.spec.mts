import { type Page } from '@playwright/test';
import { test, expect, mockPortal, reply } from './portal-mock';

/** The portal with no server: Settings → Add-ons, over canned answers for the opt-in features. */
async function portal(page: Page, { reachable = true, available = true, docker = false, llm = { source: 'auto' } as any, autoPossible = true, dreamFails = false, container = 'absent' } = {}) {
  const sent: { path: string; body: any }[] = [];
  const state = {
    subagent: { available, installed: false, enabled: false, source: null as string | null, mode: 'interrupt', maxParallel: 1, model: 'auto' },
    understory: {
      enabled: false, url: 'http://localhost:3800/mcp', tokenSet: false, adapterInstalled: false, reachable,
      managed: {
        available: docker, image: false, container, pulling: { active: false, line: '' }, url: 'http://127.0.0.1:3800/mcp',
        config: { llm, dreamInterval: '', dreamAt: '' }, autoPossible,
        providers: [{ id: 'llama-swap', models: ['model-a', 'Small'] }, { id: 'vllm', models: ['model-b'] }],
        dreaming: false, lastDream: null as any, nextDream: null as string | null, timeZone: 'Europe/Berlin',
      },
    },
  };
  await mockPortal(page, async ({ path: p, method, url, json }) => {
    if (p === '/api/settings') return {
      settings: { provider: 'p', model: 'm', thinkingLevel: 'medium' }, stored: {}, defaults: { provider: 'p', model: 'm', thinkingLevel: 'medium' },
      piSettingsPath: '/a/settings.json', compaction: { keepRecentTokens: 20000 }, compactionDefaults: { keepRecentTokens: 20000 }, contextDefault: null, executor: 'host', workspaceRoot: '/w',
    };
    if (p === '/api/models') return { models: [{ provider: 'p', id: 'm', name: 'M', contextWindow: 65536 }, { provider: 'llama-swap', id: 'model-b', name: 'Model B' }], providers: { p: 'p' } };
    if (p === '/api/features/subagent' && method === 'GET') return { subagent: state.subagent };
    if (p === '/api/features/flags') return { subagent: { enabled: state.subagent.enabled }, understory: { enabled: state.understory.enabled } };
    if (p === '/api/features') return state;
    if (p === '/api/features/subagent' && method === 'PUT') {
      const patch = json();
      sent.push({ path: p, body: patch });
      if (patch.mode) state.subagent.mode = patch.mode;
      if (patch.maxParallel) state.subagent.maxParallel = patch.maxParallel;
      if (patch.model) state.subagent.model = patch.model;
      if (patch.enabled !== undefined) Object.assign(state.subagent, { enabled: patch.enabled, installed: patch.enabled, source: patch.enabled ? '/app/extensions/subagent' : null });
      return { subagent: state.subagent, reloaded: 1, waiting: 1 };
    }
    if (p === '/api/features/understory/config' && method === 'PUT') {
      const patch = json();
      sent.push({ path: p, body: patch });
      const { apiKey, ...llm } = patch.llm;
      state.understory.managed.config = { llm: llm.source === 'custom' ? { ...llm, hasKey: Boolean(apiKey) || state.understory.managed.config.llm?.hasKey } : llm, dreamInterval: patch.dreamInterval, dreamAt: patch.dreamAt };
      state.understory.managed.nextDream = patch.dreamAt ? '2026-09-29T01:00:00.000Z' : null;
      return { understory: state.understory };
    }
    if (p === '/api/features/understory/install' && method === 'POST') {
      sent.push({ path: p, body: null });
      Object.assign(state.understory.managed, { container: 'running', image: true });
      Object.assign(state.understory, { enabled: true, adapterInstalled: true, tokenSet: true, url: state.understory.managed.url });
      return { understory: state.understory, reloaded: 1, waiting: 0 };
    }
    if (p === '/api/features/understory/install' && method === 'DELETE') {
      sent.push({ path: `${p}${url.search}`, body: null });
      Object.assign(state.understory.managed, { container: 'absent' });
      Object.assign(state.understory, { enabled: false });
      return { understory: state.understory, reloaded: 1, waiting: 0 };
    }
    if (p === '/api/features/understory/dream' && method === 'POST' && dreamFails) {
      return reply(502, { error: 'fetch failed', run: { ok: false, said: 'fetch failed' }, understory: state.understory });
    }
    if (p === '/api/features/understory/dream' && method === 'POST') {
      sent.push({ path: p, body: null });
      state.understory.managed.lastDream = { at: '2026-09-28T12:00:00.000Z', ok: true, ran: true, said: '2 files changed — merged two notes' };
      return { understory: state.understory };
    }
    if (p === '/api/features/understory/stop' && method === 'POST') {
      sent.push({ path: p, body: null });
      state.understory.managed.container = 'stopped';
      return { understory: state.understory };
    }
    if (p === '/api/features/understory' && method === 'PUT') {
      const patch = json();
      sent.push({ path: p, body: patch });
      Object.assign(state.understory, { enabled: patch.enabled, adapterInstalled: state.understory.adapterInstalled || patch.enabled, ...(patch.url ? { url: patch.url } : {}) });
      return { understory: state.understory, reloaded: 0, waiting: 0 };
    }
  }, { settings: true });
  return { sent };
}

const addons = (page: Page) => page.getByRole('dialog', { name: 'Settings' });

test('a fresh install has no subagent tool; switching it on installs it, and the mode is its own choice', async ({ page }) => {
  const { sent } = await portal(page);
  await page.goto('/settings/add-ons');
  await addons(page).getByRole('tab', { name: 'Subagents' }).click();
  const tool = addons(page).getByRole('switch', { name: 'Subagent tool' });
  await expect(tool).toHaveAttribute('aria-checked', 'false');
  await expect(addons(page).getByText('Off: the agent has no subagent tool.')).toBeVisible();
  await expect(addons(page).getByRole('radio', { name: /^Interrupt/ })).toBeChecked();

  await tool.click();
  await expect(tool).toHaveAttribute('aria-checked', 'true');
  await expect(addons(page).getByText('Installed as a pi package (/app/extensions/subagent).')).toBeVisible();
  await expect(addons(page).getByText(/one busy chat has it from its next step/)).toBeVisible();

  await addons(page).getByRole('radio', { name: /^Background/ }).check();
  await expect(addons(page).getByRole('radio', { name: /^Background/ })).toBeChecked();
  expect(sent.map((s) => s.body)).toEqual([{ enabled: true }, { mode: 'background' }]);
  await expect(addons(page).getByText(/two model calls at the same time/)).toBeVisible();
});

test('one subagent at a time unless more are allowed, up and down by one', async ({ page }) => {
  const { sent } = await portal(page);
  await page.goto('/settings/add-ons');
  await addons(page).getByRole('tab', { name: 'Subagents' }).click();
  const at = addons(page).getByRole('group', { name: 'Subagents at once' });
  await expect(at.locator('output')).toHaveText('1');
  await expect(at.getByRole('button', { name: 'Fewer at once' })).toBeDisabled();
  await at.getByRole('button', { name: 'More at once' }).click();
  await expect(at.locator('output')).toHaveText('2');
  await expect(at.getByRole('button', { name: 'Fewer at once' })).toBeEnabled();
  await at.getByRole('button', { name: 'Fewer at once' }).click();
  await expect(at.locator('output')).toHaveText('1');
  expect(sent.map((s) => s.body)).toEqual([{ maxParallel: 2 }, { maxParallel: 1 }]);
});

test('an install without the subagent tool cannot switch it on', async ({ page }) => {
  await portal(page, { available: false });
  await page.goto('/settings/add-ons');
  await addons(page).getByRole('tab', { name: 'Subagents' }).click();
  await expect(addons(page).getByRole('switch', { name: 'Subagent tool' })).toBeDisabled();
  await expect(addons(page).getByText('This install does not carry the subagent tool.')).toBeVisible();
});

test('Understory is off until switched on, then points the agent at the address given and replaces MEMORY.md', async ({ page }) => {
  const { sent } = await portal(page);
  await page.goto('/settings/add-ons');
  await addons(page).getByRole('tab', { name: 'Memory' }).click();
  const memory = addons(page).getByRole('switch', { name: "Use Understory as the agent's memory" });
  await expect(memory).toHaveAttribute('aria-checked', 'false');
  await expect(addons(page).getByText(/Off: the agent's memory is MEMORY\.md\. Switching on also installs pi-mcp-adapter/)).toBeVisible();
  await expect(addons(page).getByText('Something answers there')).toBeVisible();

  await addons(page).getByLabel("Understory's MCP address").fill('http://understory:3800/mcp');
  await memory.click();
  await expect(memory).toHaveAttribute('aria-checked', 'true');
  expect(sent).toEqual([{ path: '/api/features/understory', body: { enabled: true, url: 'http://understory:3800/mcp' } }]);
  await expect(addons(page).getByText(/On: MEMORY\.md is not read while it is/)).toBeVisible();
  await expect(addons(page).getByRole('link', { name: 'Read the memory' })).toHaveAttribute('href', '/memory');

  await memory.click();
  await expect(memory).toHaveAttribute('aria-checked', 'false');
  expect(sent.at(-1)!.body).toEqual({ enabled: false });
});

test('Understory that does not answer is said so before it is switched on', async ({ page }) => {
  await portal(page, { reachable: false });
  await page.goto('/settings/add-ons');
  await addons(page).getByRole('tab', { name: 'Memory' }).click();
  await expect(addons(page).getByText('Nothing answers at http://localhost:3800 — start Understory first')).toBeVisible();
});

test('the portal runs Understory: a provider and model set up here, how often it tidies up, then installed as the memory', async ({ page }) => {
  const { sent } = await portal(page, { docker: true });
  await page.goto('/settings/add-ons');
  await addons(page).getByRole('tab', { name: 'Memory' }).click();
  const here = addons(page).getByRole('region', { name: 'Understory run here' });
  const install = here.getByRole('button', { name: "Install and use as the agent's memory" });
  // The chat's own model unless told otherwise: nothing to choose before it can be installed.
  await expect(here.getByRole('radio', { name: "The chat's model" })).toHaveAttribute('aria-checked', 'true');
  await expect(install).toBeEnabled();
  await here.getByRole('radio', { name: 'A provider set up here' }).click();
  await expect(install).toBeDisabled();
  // One run elsewhere is there, and out of the way.
  await expect(addons(page).getByText('Or use one you run yourself')).toBeVisible();
  await expect(addons(page).getByLabel("Understory's MCP address")).toBeHidden();

  await here.getByRole('combobox', { name: 'Model' }).click();
  await page.getByRole('option', { name: 'Small' }).click();
  await here.getByRole('radio', { name: 'On an interval' }).click();
  await expect(here.getByLabel('Tidy up at')).toHaveCount(0);
  await expect(here.getByRole('combobox', { name: 'How often' })).toContainText('Every 6 hours');
  await here.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(install).toBeEnabled();
  await install.click();
  await expect(here.getByText('running')).toBeVisible();
  await expect(addons(page).getByRole('switch', { name: "Use Understory as the agent's memory" })).toHaveAttribute('aria-checked', 'true');
  expect(sent.map((s) => [s.path, s.body])).toEqual([
    ['/api/features/understory/config', { llm: { source: 'provider', provider: 'llama-swap', model: 'Small' }, dreamInterval: '6h', dreamAt: '' }],
    ['/api/features/understory/install', null],
  ]);

  // A change now makes it again.
  await here.getByRole('radio', { name: 'Never' }).click();
  await here.getByRole('button', { name: 'Save and restart Understory' }).click();
  await expect(here.getByRole('button', { name: 'Save and restart Understory' })).toHaveCount(0);
  expect(sent.at(-1)!.body.dreamInterval).toBe('');

  // Once a night at a set time instead, and now.
  // A time of day or an interval, never both: the interval is not sent with a time.
  await here.getByRole('radio', { name: 'At a time of day' }).click();
  await expect(here.getByRole('combobox', { name: 'How often' })).toHaveCount(0);
  await expect(here.getByLabel('Tidy up at')).toHaveValue('03:00');
  await expect(here.getByText("the portal's time (Europe/Berlin)")).toBeVisible();
  await here.getByLabel('Tidy up at').fill('02:30');
  await here.getByRole('button', { name: 'Save and restart Understory' }).click();
  expect(sent.at(-1)!.body).toMatchObject({ dreamInterval: '', dreamAt: '02:30' });
  await expect(here.getByText(/^Next: /)).toBeVisible();
  await here.getByRole('button', { name: 'Tidy up now' }).click();
  await expect(here.getByText(/Last: .* — 2 files changed — merged two notes/)).toBeVisible();

  await here.getByRole('button', { name: 'Stop' }).click();
  await expect(here.getByText('stopped')).toBeVisible();
  await expect(here.getByRole('button', { name: 'Tidy up now' })).toHaveCount(0);
});

test("the chat's model for the memory, unless the portal serves its own TLS", async ({ page }) => {
  const { sent } = await portal(page, { docker: true, llm: { source: 'provider', provider: 'llama-swap', model: 'model-a' } });
  await page.goto('/settings/add-ons');
  await addons(page).getByRole('tab', { name: 'Memory' }).click();
  const here = addons(page).getByRole('region', { name: 'Understory run here' });
  await here.getByRole('radio', { name: "The chat's model" }).click();
  await expect(here.getByText(/The model the chat asking is on — the one already loaded/)).toBeVisible();
  await here.getByRole('button', { name: 'Save', exact: true }).click();
  expect(sent.at(-1)!.body.llm).toEqual({ source: 'auto' });
});

test("over the portal's own TLS the memory cannot use the chat's model", async ({ page }) => {
  await portal(page, { docker: true, llm: { source: 'provider', provider: 'llama-swap', model: 'model-a' }, autoPossible: false });
  await page.goto('/settings/add-ons');
  await addons(page).getByRole('tab', { name: 'Memory' }).click();
  await expect(addons(page).getByRole('radio', { name: "The chat's model" })).toBeDisabled();
});

test('subagents run on the chat\'s model unless one is named', async ({ page }) => {
  const { sent } = await portal(page);
  await page.goto('/settings/add-ons');
  await addons(page).getByRole('tab', { name: 'Subagents' }).click();
  const model = addons(page).getByRole('combobox', { name: 'Subagent model' });
  await expect(model).toContainText('Same as the chat');
  await model.click();
  await page.getByRole('option', { name: /Model B/ }).click();
  await expect(model).toContainText('Model B');
  expect(sent.at(-1)!.body).toEqual({ model: 'llama-swap/model-b' });
});

test("a model at an address of its own keeps its saved key unless one is typed", async ({ page }) => {
  const { sent } = await portal(page, { docker: true, llm: { source: 'custom', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', format: 'openai', hasKey: true } });
  await page.goto('/settings/add-ons');
  await addons(page).getByRole('tab', { name: 'Memory' }).click();
  const here = addons(page).getByRole('region', { name: 'Understory run here' });
  await expect(here.getByRole('radio', { name: 'An address of its own' })).toHaveAttribute('aria-checked', 'true');
  await expect(here.getByPlaceholder('saved — type to replace')).toBeVisible();
  await here.getByLabel('Model', { exact: true }).fill('deepseek-reasoner');
  await here.getByRole('button', { name: 'Save', exact: true }).click();
  expect(sent.at(-1)!.body.llm).toEqual({ source: 'custom', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-reasoner', format: 'openai' });
  await here.getByLabel('API key', { exact: true }).fill('sk-new');
  await here.getByRole('button', { name: 'Save', exact: true }).click();
  expect(sent.at(-1)!.body.llm.apiKey).toBe('sk-new');
});

test('forgetting the memory asks first', async ({ page }) => {
  const { sent } = await portal(page, { docker: true, llm: { source: 'provider', provider: 'llama-swap', model: 'model-a' } });
  await page.goto('/settings/add-ons');
  await addons(page).getByRole('tab', { name: 'Memory' }).click();
  const here = addons(page).getByRole('region', { name: 'Understory run here' });
  await here.getByRole('button', { name: "Install and use as the agent's memory" }).click();
  await here.getByRole('button', { name: 'Remove and forget the memory' }).click();
  await page.getByRole('button', { name: 'Keep' }).or(page.getByRole('button', { name: 'Cancel' })).first().click();
  expect(sent.map((s) => s.path)).not.toContain('/api/features/understory/install?memory=forget');
  await here.getByRole('button', { name: 'Remove and forget the memory' }).click();
  await page.getByRole('button', { name: 'Forget it' }).click();
  await expect(here.getByRole('button', { name: "Install and use as the agent's memory" })).toBeVisible();
  expect(sent.at(-1)!.path).toBe('/api/features/understory/install?memory=forget');
});

test('the add-on tabs fit a phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await portal(page);
  await page.goto('/settings/add-ons');
  const tabs = addons(page).getByRole('tab');
  await expect(tabs).toHaveCount(2);
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(width).toBeLessThanOrEqual(390);
  for (const name of ['Subagents', 'Memory']) await expect(addons(page).getByRole('tab', { name })).toBeVisible();
});

test("a tidy-up that fails says why, not the status it came with", async ({ page }) => {
  await portal(page, { docker: true, dreamFails: true });
  await page.goto('/settings/add-ons');
  await addons(page).getByRole('tab', { name: 'Memory' }).click();
  const here = addons(page).getByRole('region', { name: 'Understory run here' });
  await here.getByRole('button', { name: "Install and use as the agent's memory" }).click();
  await here.getByRole('button', { name: 'Tidy up now' }).click();
  await expect(page.getByText('fetch failed').first()).toBeVisible();
  await expect(page.getByText('HTTP 502')).toHaveCount(0);
});

test("a container by Understory's name that the portal did not make is left alone, and said so", async ({ page }) => {
  await portal(page, { docker: true, container: 'foreign' });
  await page.goto('/settings/add-ons');
  await addons(page).getByRole('tab', { name: 'Memory' }).click();
  const here = addons(page).getByRole('region', { name: 'Understory run here' });
  await expect(here.getByRole('alert')).toContainText('the portal did not make');
  await expect(here.getByRole('button', { name: "Install and use as the agent's memory" })).toBeDisabled();
  await expect(here.getByRole('button', { name: 'Remove' })).toHaveCount(0);
});

test("the Subagents tab opens whatever Docker's state: it asks nothing of it", async ({ page }) => {
  await portal(page);
  await page.route('**/api/features', (route) => route.fulfill({ status: 500, json: { error: 'connect EACCES /var/run/docker.sock' } }));
  await page.goto('/settings/add-ons');
  await addons(page).getByRole('tab', { name: 'Subagents' }).click();
  await expect(addons(page).getByRole('switch', { name: 'Subagent tool' })).toBeVisible();
});

test('Escape over the memory settings that were changed asks first, and over ones that were saved does not', async ({ page }) => {
  await portal(page, { docker: true });
  const ask = page.getByRole('alertdialog', { name: 'Discard your changes?' });
  await page.goto('/settings/add-ons');
  await addons(page).getByRole('tab', { name: 'Memory' }).click();
  const here = addons(page).getByRole('region', { name: 'Understory run here' });
  await expect(here.getByRole('radio', { name: 'Never' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(addons(page)).toBeHidden();

  await page.goto('/settings/add-ons');
  await addons(page).getByRole('tab', { name: 'Memory' }).click();
  await here.getByRole('radio', { name: 'On an interval' }).click();
  await page.keyboard.press('Escape');
  await expect(ask).toBeVisible();
  await ask.getByRole('button', { name: 'Cancel' }).click();
  await expect(here.getByRole('radio', { name: 'On an interval' })).toBeChecked();
  await here.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(here.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(addons(page)).toBeHidden();
});
