import { type Locator, type Page } from '@playwright/test';
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
  const images = { enabled: false, baseUrl: '', model: '', size: '', keySet: false, editEnabled: false, editBaseUrl: '', editModel: '', editMultiple: false, editMaxSize: '', editKeySet: false, timeoutSeconds: 300, sdExtras: false, ready: false, editReady: false };
  await mockPortal(page, async ({ path: p, method, url, json }) => {
    if (p === '/api/settings') return {
      settings: { provider: 'p', model: 'm', thinkingLevel: 'medium' }, stored: {}, defaults: { provider: 'p', model: 'm', thinkingLevel: 'medium' },
      piSettingsPath: '/a/settings.json', compaction: { keepRecentTokens: 20000 }, compactionDefaults: { keepRecentTokens: 20000 }, contextDefault: null, executor: 'host', workspaceRoot: '/w',
    };
    if (p === '/api/models') return { models: [{ provider: 'p', id: 'm', name: 'M', contextWindow: 65536 }, { provider: 'llama-swap', id: 'model-b', name: 'Model B' }], providers: { p: 'p' } };
    if (p === '/api/features/subagent' && method === 'GET') return { subagent: state.subagent };
    if (p === '/api/features/flags') return { subagent: { enabled: state.subagent.enabled }, understory: { enabled: state.understory.enabled }, images: { enabled: images.enabled && images.baseUrl !== '' }, videos: { enabled: false } };
    // The Media tab has the video model beside the image model: here it is not set up.
    if (p === '/api/features/videos' && method === 'GET') return { videos: { enabled: false, backend: 'sdcpp', backends: [{ id: 'sdcpp', label: 'stable-diffusion.cpp' }], baseUrl: '', model: '', size: '', frames: null, fps: null, keySet: false, timeoutSeconds: 1800, storageLimitMb: 0, ready: false } };
    if (p === '/api/features/images' && method === 'GET') return { images };
    if (p === '/api/features/images' && method === 'PUT') {
      const patch = json();
      sent.push({ path: p, body: patch });
      // The shape of the edit tool counts as a change only while there is an edit tool.
      const changed = (patch.enabled !== undefined && patch.enabled !== images.enabled) || (patch.editEnabled !== undefined && patch.editEnabled !== images.editEnabled)
        || (patch.editMultiple !== undefined && patch.editMultiple !== images.editMultiple && images.editReady);
      const { apiKey, editApiKey, ...rest } = patch;
      Object.assign(images, rest);
      // null takes a saved limit away: the default again.
      if (patch.timeoutSeconds === null) images.timeoutSeconds = 300;
      if (apiKey !== undefined) images.keySet = apiKey !== '';
      if (editApiKey !== undefined) images.editKeySet = editApiKey !== '';
      images.ready = images.enabled && images.baseUrl !== '';
      images.editReady = images.editEnabled && (images.editBaseUrl || images.baseUrl) !== '';
      return { images, changed, reloaded: 1, waiting: 1 };
    }
    if (p === '/api/features') return { ...state, images };
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
/** The image model's half of Settings → Agent → Media: the video model's has fields of the same names. */
const imagePanel = (page: Page) => addons(page).getByRole('region', { name: 'Image model' });
/** A group inside the image model's section ("Editing endpoint", "More options"), opened if it is closed. */
async function openGroup(panel: Locator, name: string) {
  const group = panel.locator(`details:has(> summary:has-text("${name}"))`);
  if (!(await group.evaluate((el: HTMLDetailsElement) => el.open))) await group.locator('summary').click();
  await expect(group).toHaveAttribute('open', '');
}

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
  await expect(addons(page).getByText(/one busy chat picks it up/)).toBeVisible();

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

test('the four add-on tabs fit a phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await portal(page);
  await page.goto('/settings/add-ons');
  const tabs = addons(page).getByRole('tab');
  await expect(tabs).toHaveCount(4);
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(width).toBeLessThanOrEqual(390);
  for (const name of ['Browser', 'Voice', 'Subagents', 'Memory']) await expect(addons(page).getByRole('tab', { name })).toBeVisible();
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

test('Escape over the image endpoint that was typed in asks first, and over one that was saved does not', async ({ page }) => {
  const { sent } = await portal(page);
  const ask = page.getByRole('alertdialog', { name: 'Discard your changes?' });
  await page.goto('/settings/media');
  await expect(imagePanel(page).getByLabel('API address')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(addons(page)).toBeHidden();

  await page.goto('/settings/media');
  const address = imagePanel(page).getByLabel('API address');
  await address.fill('https://images.example.com/v1');
  await page.keyboard.press('Escape');
  await expect(ask).toBeVisible();
  await ask.getByRole('button', { name: 'Cancel' }).click();
  await expect(address).toHaveValue('https://images.example.com/v1');
  await imagePanel(page).getByLabel('Model', { exact: true }).fill('image-model');
  await imagePanel(page).getByRole('button', { name: 'Save', exact: true }).click();
  await expect(imagePanel(page).getByRole('button', { name: 'Save', exact: true })).toBeHidden();
  expect(sent).toHaveLength(1);
  await page.keyboard.press('Escape');
  await expect(addons(page)).toBeHidden();
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

test('image generation needs an endpoint before it can be switched on, and the key is sent once and never shown again', async ({ page }) => {
  const { sent } = await portal(page);
  await page.goto('/settings/media');
  const panel = imagePanel(page);
  const tool = panel.getByRole('switch', { name: 'Image generation', exact: true });
  await expect(tool).toHaveAttribute('aria-checked', 'false');
  await expect(tool).toBeDisabled();
  // Both switches say it: generation's is the first.
  await expect(panel.getByText('Save the address of an image endpoint first.').first()).toBeVisible();
  await expect(panel.getByText('Off: no pictures are made.')).toBeVisible();

  await panel.getByLabel('API address').fill('https://images.example.com/v1');
  await panel.getByLabel('API key').fill('sk-test-123');
  await panel.getByLabel('Model', { exact: true }).fill('image-model');
  await expect(tool).toBeDisabled();
  await expect(panel.getByText('Save or discard the changes first.')).toBeVisible();
  await panel.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Save', exact: true })).toBeHidden();
  expect(sent).toEqual([{ path: '/api/features/images', body: { baseUrl: 'https://images.example.com/v1', model: 'image-model', size: '', apiKey: 'sk-test-123' } }]);
  // The page is told only that a key is set: the field is empty and says so.
  await expect(panel.getByLabel('API key')).toHaveValue('');
  await expect(panel.getByLabel('API key')).toHaveAttribute('placeholder', 'saved — type to replace');

  await expect(tool).toBeEnabled();
  await tool.click();
  await expect(tool).toHaveAttribute('aria-checked', 'true');
  await expect(panel.getByText('On: pictures are made on the Media page and by the agent.')).toBeVisible();
  await expect(panel.getByText(/one busy chat picks it up/)).toBeVisible();
  expect(sent.at(-1)!.body).toEqual({ enabled: true });

  // Changing only the model keeps the key: it is not sent again.
  await panel.getByLabel('Model', { exact: true }).fill('another-model');
  await panel.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Save', exact: true })).toBeHidden();
  expect(sent.at(-1)!.body).toEqual({ baseUrl: 'https://images.example.com/v1', model: 'another-model', size: '' });

  await panel.getByRole('button', { name: 'Remove the saved key' }).click();
  await expect(panel.getByLabel('API key')).toHaveAttribute('placeholder', 'none needed for a local server');
  expect(sent.at(-1)!.body).toEqual({ apiKey: '' });
});

test('the Media page is in the sidebar while image generation is on, and the switch moves it at once', async ({ page }) => {
  await portal(page);
  await page.goto('/settings/media');
  const entry = page.getByRole('complementary', { name: 'Sidebar' }).getByRole('button', { name: 'Media' });
  await expect(entry).toHaveCount(0);
  const panel = imagePanel(page);
  await panel.getByLabel('API address').fill('https://images.example.com/v1');
  await panel.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Save', exact: true })).toBeHidden();
  // An address is not enough: the tool is still off.
  await expect(entry).toHaveCount(0);
  await panel.getByRole('switch', { name: 'Image generation', exact: true }).click();
  await expect(entry).toHaveCount(1);
  await panel.getByRole('switch', { name: 'Image generation', exact: true }).click();
  await expect(entry).toHaveCount(0);
});

test('the time limit of a picture is a field of the image endpoint: five minutes, whole seconds from 30 to 3600, sent only when changed', async ({ page }) => {
  const { sent } = await portal(page);
  await page.goto('/settings/media');
  const panel = imagePanel(page);
  const field = panel.getByLabel('Time limit (seconds)');
  await expect(field).toHaveValue('300');

  // Out of bounds: nothing to save.
  await field.fill('10');
  const save = panel.getByRole('button', { name: 'Save', exact: true });
  await expect(save).toBeDisabled();
  await field.fill('4000');
  await expect(save).toBeDisabled();
  // Text that is not a number is no limit either, and is not taken for the default.
  await field.fill('600s');
  await expect(save).toBeDisabled();
  await field.fill('900');
  await expect(save).toBeEnabled();
  await save.click();
  await expect(save).toBeHidden();
  expect(sent.at(-1)!.body).toEqual({ baseUrl: '', model: '', size: '', timeoutSeconds: 900 });
  await expect(field).toHaveValue('900');

  // Saving something else does not state the limit again.
  await panel.getByLabel('Model', { exact: true }).fill('image-model');
  await save.click();
  await expect(save).toBeHidden();
  expect(sent.at(-1)!.body).toEqual({ baseUrl: '', model: 'image-model', size: '' });

  // Empty is the default, which is what the placeholder says: a saved limit is taken away, not stored as 300.
  await expect(field).toHaveValue('900');
  await field.fill('');
  await expect(save).toBeEnabled();
  await save.click();
  await expect(save).toBeHidden();
  expect(sent.at(-1)!.body).toEqual({ baseUrl: '', model: 'image-model', size: '', timeoutSeconds: null });
  await expect(field).toHaveValue('300');
});

test('image editing has a switch and an endpoint of its own: it needs an address, may use the one above, and its key is sent once', async ({ page }) => {
  const { sent } = await portal(page);
  await page.goto('/settings/media');
  const panel = imagePanel(page);
  const editing = panel.getByRole('switch', { name: 'Image editing', exact: true });
  await expect(editing).toHaveAttribute('aria-checked', 'false');
  await expect(editing).toBeDisabled();
  await expect(panel.getByText('Off: no pictures are changed.')).toBeVisible();
  await openGroup(panel, 'Editing endpoint');

  // Generation's address is enough, and its key is the one used: the form says so.
  await panel.getByLabel('API address').fill('https://images.example.com/v1');
  await panel.getByLabel('API key').fill('sk-test-123');
  await panel.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Save', exact: true })).toBeHidden();
  await expect(panel.getByLabel('Editing address')).toHaveAttribute('placeholder', 'https://images.example.com/v1');
  await expect(panel.getByLabel('Editing key')).toHaveAttribute('placeholder', 'the key above is used');
  await expect(editing).toBeEnabled();
  await editing.click();
  await expect(editing).toHaveAttribute('aria-checked', 'true');
  await expect(panel.getByText('On: pictures are changed on the Media page and by the agent.')).toBeVisible();
  await expect(panel.getByText(/one busy chat picks it up/)).toBeVisible();
  expect(sent.at(-1)!.body).toEqual({ editEnabled: true });
  // Generation is its own switch: still off.
  await expect(panel.getByRole('switch', { name: 'Image generation', exact: true })).toHaveAttribute('aria-checked', 'false');

  // Its own address, model and key: another server is not given the one above, and the switch waits for the save.
  await panel.getByLabel('Editing address').fill('https://edit.example.net/v1');
  await panel.getByLabel('Editing key').fill('sk-edit-456');
  await panel.getByLabel('Editing model').fill('image-edit-model');
  await expect(editing).toBeDisabled();
  await expect(panel.getByText('Save or discard the changes first.')).toBeVisible();
  await expect(panel.getByLabel('Editing key')).toHaveAttribute('placeholder', 'none needed for a local server');
  await panel.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Save', exact: true })).toBeHidden();
  expect(sent.at(-1)!.body).toEqual({ editBaseUrl: 'https://edit.example.net/v1', editModel: 'image-edit-model', editApiKey: 'sk-edit-456' });
  await expect(panel.getByLabel('Editing key')).toHaveValue('');
  await expect(panel.getByLabel('Editing key')).toHaveAttribute('placeholder', 'saved — type to replace');
  await expect(editing).toBeEnabled();
  // The key of generation is untouched by it.
  await expect(panel.getByLabel('API key')).toHaveAttribute('placeholder', 'saved — type to replace');

  // Only the model changed: the key is not sent again.
  await panel.getByLabel('Editing model').fill('another-edit-model');
  await panel.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Save', exact: true })).toBeHidden();
  expect(sent.at(-1)!.body).toEqual({ editBaseUrl: 'https://edit.example.net/v1', editModel: 'another-edit-model' });

  await panel.getByRole('button', { name: 'Remove the saved editing key' }).click();
  await expect(panel.getByLabel('Editing key')).toHaveAttribute('placeholder', 'none needed for a local server');
  expect(sent.at(-1)!.body).toEqual({ editApiKey: '' });
  // Generation's key is still there to remove on its own.
  await expect(panel.getByRole('button', { name: 'Remove the saved key' })).toBeVisible();
});

test('image editing has a maximum picture size of its own, sent only when changed, and refuses what is no size', async ({ page }) => {
  const { sent } = await portal(page);
  await page.goto('/settings/media');
  const panel = imagePanel(page);
  await openGroup(panel, 'Editing endpoint');
  const field = panel.getByLabel('Maximum picture size');
  const save = panel.getByRole('button', { name: 'Save', exact: true });
  await expect(field).toHaveValue('');
  await expect(field).toHaveAttribute('placeholder', '2048x2048');
  await expect(panel.getByText(/The maximum picture size is the most pixels a picture sent to be edited may have/)).toBeVisible();
  // Generation's size is its own field, and is not the maximum.
  await expect(panel.getByLabel('Picture size', { exact: true })).toHaveValue('');

  // A side of zero is no limit at all, so it is refused as well.
  await field.fill('00x00');
  await expect(field).toHaveAttribute('aria-invalid', 'true');
  await expect(save).toBeDisabled();
  await field.fill('huge');
  await expect(field).toHaveAttribute('aria-invalid', 'true');
  await expect(save).toBeDisabled();
  await field.fill(' 2048x1024 ');
  await expect(field).toHaveAttribute('aria-invalid', 'false');
  await expect(save).toBeEnabled();
  await save.click();
  await expect(save).toBeHidden();
  expect(sent.at(-1)!.body).toEqual({ editBaseUrl: '', editModel: '', editMaxSize: '2048x1024' });
  await expect(field).toHaveValue('2048x1024');

  // Saving something else does not state it again; emptied, it is taken away.
  await panel.getByLabel('Editing model').fill('image-edit-model');
  await save.click();
  await expect(save).toBeHidden();
  expect(sent.at(-1)!.body).toEqual({ editBaseUrl: '', editModel: 'image-edit-model' });
  await field.fill('');
  await save.click();
  await expect(save).toBeHidden();
  expect(sent.at(-1)!.body).toEqual({ editBaseUrl: '', editModel: 'image-edit-model', editMaxSize: '' });
});

test('several pictures per edit is a switch of its own that waits for the editing address, and says what the tool takes', async ({ page }) => {
  const { sent } = await portal(page);
  await page.goto('/settings/media');
  const panel = imagePanel(page);
  await openGroup(panel, 'More options');
  await openGroup(panel, 'Editing endpoint');
  const several = panel.getByRole('switch', { name: 'Several pictures per edit' });
  await expect(several).toHaveAttribute('aria-checked', 'false');
  await expect(panel.getByText('Off: an edit takes one picture.')).toBeVisible();
  await expect(panel.getByText(/Switch it on only if the editing endpoint takes more than one picture in a request/)).toBeVisible();

  await panel.getByLabel('API address').fill('https://images.example.com/v1');
  await panel.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Save', exact: true })).toBeHidden();
  await panel.getByRole('switch', { name: 'Image editing', exact: true }).click();
  await expect(panel.getByRole('switch', { name: 'Image editing', exact: true })).toHaveAttribute('aria-checked', 'true');

  // Typing in the editing form waits for its save, as the switch above it does.
  await panel.getByLabel('Editing model').fill('image-edit-model');
  await expect(several).toBeDisabled();
  await expect(panel.getByText('Save or discard the changes first.')).toBeVisible();
  await panel.getByRole('button', { name: 'Discard' }).click();
  await expect(several).toBeEnabled();

  await several.click();
  await expect(several).toHaveAttribute('aria-checked', 'true');
  await expect(panel.getByText('On: an edit takes up to eight pictures.')).toBeVisible();
  // The tool has another shape from now on, so the chats are reloaded like for a tool that came.
  await expect(panel.getByText(/one busy chat picks it up/)).toBeVisible();
  expect(sent.at(-1)!.body).toEqual({ editMultiple: true });
  await several.click();
  await expect(several).toHaveAttribute('aria-checked', 'false');
  expect(sent.at(-1)!.body).toEqual({ editMultiple: false });
});

test('Stable Diffusion extra settings is a switch of its own, off by default, that says plainly what it does and for which servers', async ({ page }) => {
  const { sent } = await portal(page);
  await page.goto('/settings/media');
  const panel = imagePanel(page);
  await openGroup(panel, 'More options');
  await openGroup(panel, 'Editing endpoint');
  const sd = panel.getByRole('switch', { name: 'Stable Diffusion extra settings' });
  await expect(sd).toHaveAttribute('aria-checked', 'false');
  await expect(sd).toBeEnabled();
  await expect(panel.getByText('Off: the Media page shows only the settings of the OpenAI image format.')).toBeVisible();
  // What it does, and that only one kind of server understands it: any other would read the block as words of the description.
  await expect(panel.getByText(/Only for a stable-diffusion\.cpp server/)).toBeVisible();
  await expect(panel.getByText(/Any other endpoint would take the block as part of the description/)).toBeVisible();
  await expect(panel.getByText(/The agent does not use these settings/)).toBeVisible();

  // It is a setting of the endpoint, not of a tool: no address is needed to say it, and nothing reloads.
  await sd.click();
  await expect(sd).toHaveAttribute('aria-checked', 'true');
  await expect(panel.getByText('On: the Media page shows stable-diffusion.cpp settings under Advanced.')).toBeVisible();
  expect(sent.at(-1)!.body).toEqual({ sdExtras: true });
  await expect(panel.getByText(/one busy chat picks it up/)).toHaveCount(0);
  await sd.click();
  await expect(sd).toHaveAttribute('aria-checked', 'false');
  expect(sent.at(-1)!.body).toEqual({ sdExtras: false });

  // An address typed and not saved: the switch waits for the save, as the others of the endpoint do, since saving the address of another server takes it off again.
  await panel.getByLabel('API address').fill('http://sd-box.example:1234/v1');
  await expect(sd).toBeDisabled();
  await panel.getByRole('button', { name: 'Discard' }).click();
  await expect(sd).toBeEnabled();
  await panel.getByLabel('Editing model').fill('edit-model');
  await expect(sd).toBeDisabled();
  await panel.getByRole('button', { name: 'Discard' }).click();
  await expect(sd).toBeEnabled();
});

test('the Media tab holds the image settings and no switch for the tools themselves', async ({ page }) => {
  await portal(page);
  await page.goto('/settings/media');
  const here = addons(page);
  const panel = imagePanel(page);
  await expect(panel.getByRole('switch', { name: 'Image generation', exact: true })).toBeVisible();
  await expect(panel.getByRole('switch', { name: 'Image editing', exact: true })).toBeVisible();
  await openGroup(panel, 'More options');
  await expect(panel.getByRole('switch', { name: 'Several pictures per edit' })).toBeVisible();
  // The switches are the feature's, and say so: which chat's agent gets a tool is for the tool lists, in their one group.
  await expect(here.getByText(/Which chats' agents get the tools is set in the tool lists \(Settings → Agent → Tools\), in the Media group/)).toBeVisible();
  await expect(here.getByText('Picture tools', { exact: true })).toHaveCount(0);
  for (const name of ['show_image', 'generate_image', 'edit_image']) await expect(here.getByRole('switch', { name: `${name} in new chats` })).toHaveCount(0);
  // Settings → Add-ons has no Images tab.
  await page.goto('/settings/add-ons');
  await expect(here.getByRole('tab', { name: 'Images' })).toHaveCount(0);
});

test('the Media tab fits a phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await portal(page);
  await page.goto('/settings/media');
  await expect(imagePanel(page).getByRole('switch', { name: 'Image editing', exact: true })).toBeVisible();
  await expect(addons(page).getByRole('switch', { name: 'Video generation', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  expect(await addons(page).evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
});
