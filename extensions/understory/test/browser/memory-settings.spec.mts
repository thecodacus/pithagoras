import { type Page } from '@playwright/test';
import { test, expect, mockPortal, reply } from '../../../../tests/browser/portal-mock';

/**
 * Understory's page in Settings (src/web/MemorySettings.tsx), over what its server half would answer: run here, with the
 * model that keeps the memory and when it tidies up, or one run elsewhere at an address; the switch that makes it the
 * agent's memory; and the sidebar's Memory, which follows it.
 */
test.use({ installed: ['extensions/docker', 'extensions/understory'] });

/** Where Understory's server half answers: its routes, under the address the portal gives the package. */
const BASE = '/api/x/pithagoras-understory';

/** The portal with Understory installed, its server half answering over canned state, and Settings listing it. */
async function portal(page: Page, { reachable = true, docker = false, llm = { source: 'auto' } as any, autoPossible = true, dreamFails = false, container = 'absent', down = false } = {}) {
  const sent: { path: string; body: any }[] = [];
  let failing = down;
  const state = {
    enabled: false, url: 'http://localhost:3800/mcp', tokenSet: false, reachable,
    managed: {
      available: docker, image: false, container, pulling: { active: false, line: '' }, url: 'http://127.0.0.1:3800/mcp',
      config: { llm, dreamInterval: '', dreamAt: '' }, autoPossible,
      providers: [{ id: 'llama-swap', models: ['model-a', 'Small'] }, { id: 'vllm', models: ['model-b'] }],
      dreaming: false, lastDream: null as any, nextDream: null as string | null, timeZone: 'Europe/Berlin',
    },
  };
  await mockPortal(page, async ({ path: p, method, url, json }) => {
    if (p === '/api/extensions' && method === 'GET') return { settingsPath: '/a/settings.json', extensions: [
      { spec: 'extensions/docker', name: 'pithagoras-docker', version: '1.1.0', settings: [] },
      { spec: 'extensions/understory', name: 'pithagoras-understory', version: '0.1.0', settings: [] },
    ] };
    if (p === `${BASE}/state` && failing) return reply(500, { error: 'The portal is starting up' });
    if (p === `${BASE}/state`) return state;
    if (p === `${BASE}/config` && method === 'PUT') {
      const patch = json();
      sent.push({ path: p, body: patch });
      const { apiKey, ...llm } = patch.llm;
      state.managed.config = { llm: llm.source === 'custom' ? { ...llm, hasKey: Boolean(apiKey) || state.managed.config.llm?.hasKey } : llm, dreamInterval: patch.dreamInterval, dreamAt: patch.dreamAt };
      state.managed.nextDream = patch.dreamAt ? '2026-09-29T01:00:00.000Z' : null;
      return { understory: state };
    }
    if (p === `${BASE}/install` && method === 'POST') {
      sent.push({ path: p, body: null });
      Object.assign(state.managed, { container: 'running', image: true });
      Object.assign(state, { enabled: true, tokenSet: true, url: state.managed.url });
      return { understory: state, reloaded: 1, waiting: 0 };
    }
    if (p === `${BASE}/install` && method === 'DELETE') {
      sent.push({ path: `${p}${url.search}`, body: null });
      Object.assign(state.managed, { container: 'absent' });
      Object.assign(state, { enabled: false });
      return { understory: state, reloaded: 1, waiting: 0 };
    }
    if (p === `${BASE}/dream` && method === 'POST' && dreamFails) {
      return reply(502, { error: 'fetch failed', run: { ok: false, said: 'fetch failed' }, understory: state });
    }
    if (p === `${BASE}/dream` && method === 'POST') {
      sent.push({ path: p, body: null });
      state.managed.lastDream = { at: '2026-09-28T12:00:00.000Z', ok: true, ran: true, said: '2 files changed — merged two notes' };
      return { understory: state };
    }
    if (p === `${BASE}/stop` && method === 'POST') {
      sent.push({ path: p, body: null });
      state.managed.container = 'stopped';
      return { understory: state };
    }
    if (p === `${BASE}/use` && method === 'PUT') {
      const patch = json();
      sent.push({ path: p, body: patch });
      Object.assign(state, { enabled: patch.enabled, ...(patch.url ? { url: patch.url } : {}) });
      return { understory: state, reloaded: 0, waiting: 0 };
    }
  }, { settings: true });
  return { sent, up: () => void (failing = false) };
}

/** Settings, on Understory's page. */
const open = async (page: Page) => {
  await page.goto('/settings/x/pithagoras-understory');
  return page.getByRole('dialog', { name: 'Settings' });
};
const sidebar = (page: Page) => page.getByRole('complementary', { name: 'Sidebar' });

test('Understory is off until switched on, then points the agent at the address given and replaces MEMORY.md', async ({ page }) => {
  const { sent } = await portal(page);
  const settings = await open(page);
  const memory = settings.getByRole('switch', { name: "Use Understory as the agent's memory" });
  await expect(memory).toHaveAttribute('aria-checked', 'false');
  await expect(settings.getByText("Off: the agent's memory is MEMORY.md. Switching on also installs pi-mcp-adapter where it is not, which makes MCP servers into tools.")).toBeVisible();
  await expect(settings.getByText('Something answers there')).toBeVisible();

  await settings.getByLabel("Understory's MCP address").fill('http://understory:3800/mcp');
  await memory.click();
  await expect(memory).toHaveAttribute('aria-checked', 'true');
  expect(sent).toEqual([{ path: `${BASE}/use`, body: { enabled: true, url: 'http://understory:3800/mcp' } }]);
  await expect(settings.getByText(/On: MEMORY\.md is not read while it is/)).toBeVisible();
  await expect(settings.getByRole('link', { name: 'Read the memory' })).toHaveAttribute('href', '/x/pithagoras-understory/memory');

  await memory.click();
  await expect(memory).toHaveAttribute('aria-checked', 'false');
  expect(sent.at(-1)!.body).toEqual({ enabled: false });
});

test("the sidebar's Memory follows the switch, among the extensions' pages", async ({ page }) => {
  await portal(page);
  const settings = await open(page);
  const memory = settings.getByRole('switch', { name: "Use Understory as the agent's memory" });
  await memory.click();
  await expect(memory).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape');
  await expect(settings).toBeHidden();
  await expect(sidebar(page).getByRole('group', { name: 'Extensions' }).getByRole('button', { name: 'Memory' })).toBeVisible();

  await page.goto('/settings/x/pithagoras-understory');
  await memory.click();
  await expect(memory).toHaveAttribute('aria-checked', 'false');
  await page.keyboard.press('Escape');
  await expect(settings).toBeHidden();
  await expect(sidebar(page).getByRole('button', { name: 'Sessions' }).first()).toBeVisible();
  await expect(sidebar(page).getByRole('button', { name: 'Memory' })).toHaveCount(0);
});

test('Understory that does not answer is said so before it is switched on', async ({ page }) => {
  await portal(page, { reachable: false });
  const settings = await open(page);
  await expect(settings.getByText('Nothing answers at http://localhost:3800 — start Understory first')).toBeVisible();
});

test('a page that could not read how Understory stands says so, and reads it again', async ({ page }) => {
  const { up } = await portal(page, { down: true });
  const settings = await open(page);
  await expect(settings.getByRole('alert')).toContainText('Could not load this: The portal is starting up');
  up();
  await settings.getByRole('button', { name: 'Try again' }).click();
  await expect(settings.getByRole('switch', { name: "Use Understory as the agent's memory" })).toBeVisible();
  await expect(settings.getByRole('alert')).toHaveCount(0);
});

test('the portal runs Understory: a provider and model set up here, how often it tidies up, then installed as the memory', async ({ page }) => {
  const { sent } = await portal(page, { docker: true });
  const settings = await open(page);
  const here = settings.getByRole('region', { name: 'Understory run here' });
  const install = here.getByRole('button', { name: "Install and use as the agent's memory" });
  // The chat's own model unless told otherwise: nothing to choose before it can be installed.
  await expect(here.getByRole('radio', { name: "The chat's model" })).toHaveAttribute('aria-checked', 'true');
  await expect(install).toBeEnabled();
  await here.getByRole('radio', { name: 'A provider set up here' }).click();
  await expect(install).toBeDisabled();
  // One run elsewhere is there, and out of the way.
  await expect(settings.getByText('Or use one you run yourself')).toBeVisible();
  await expect(settings.getByLabel("Understory's MCP address")).toBeHidden();

  await here.getByRole('combobox', { name: 'Model' }).click();
  await page.getByRole('option', { name: 'Small' }).click();
  await here.getByRole('radio', { name: 'On an interval' }).click();
  await expect(here.getByLabel('Tidy up at')).toHaveCount(0);
  await expect(here.getByRole('combobox', { name: 'How often' })).toContainText('Every 6 hours');
  await here.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(install).toBeEnabled();
  await install.click();
  await expect(here.getByText('running')).toBeVisible();
  await expect(settings.getByRole('switch', { name: "Use Understory as the agent's memory" })).toHaveAttribute('aria-checked', 'true');
  expect(sent.map((s) => [s.path, s.body])).toEqual([
    [`${BASE}/config`, { llm: { source: 'provider', provider: 'llama-swap', model: 'Small' }, dreamInterval: '6h', dreamAt: '' }],
    [`${BASE}/install`, null],
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

test("the chat's model for the memory, while the server half listens for Understory", async ({ page }) => {
  const { sent } = await portal(page, { docker: true, llm: { source: 'provider', provider: 'llama-swap', model: 'model-a' } });
  const settings = await open(page);
  const here = settings.getByRole('region', { name: 'Understory run here' });
  await here.getByRole('radio', { name: "The chat's model" }).click();
  await expect(here.getByText(/The model the chat asking is on — the one already loaded/)).toBeVisible();
  await expect(here.getByText(/UNDERSTORY_LLM_PORT/)).toHaveCount(0);
  await here.getByRole('button', { name: 'Save', exact: true }).click();
  expect(sent.at(-1)!.body.llm).toEqual({ source: 'auto' });
});

test("without its port for the chat's model, the memory cannot be given the chat's model, and says why", async ({ page }) => {
  await portal(page, { docker: true, autoPossible: false });
  const settings = await open(page);
  await expect(settings.getByRole('radio', { name: "The chat's model" })).toBeDisabled();
  await expect(settings.getByText(/could not be taken\. UNDERSTORY_LLM_PORT sets another\./)).toBeVisible();
});

test("a model at an address of its own keeps its saved key unless one is typed", async ({ page }) => {
  const { sent } = await portal(page, { docker: true, llm: { source: 'custom', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', format: 'openai', hasKey: true } });
  const settings = await open(page);
  const here = settings.getByRole('region', { name: 'Understory run here' });
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
  const settings = await open(page);
  const here = settings.getByRole('region', { name: 'Understory run here' });
  await here.getByRole('button', { name: "Install and use as the agent's memory" }).click();
  await here.getByRole('button', { name: 'Remove and forget the memory' }).click();
  await page.getByRole('button', { name: 'Keep' }).or(page.getByRole('button', { name: 'Cancel' })).first().click();
  expect(sent.map((s) => s.path)).not.toContain(`${BASE}/install?memory=forget`);
  await here.getByRole('button', { name: 'Remove and forget the memory' }).click();
  await page.getByRole('button', { name: 'Forget it' }).click();
  await expect(here.getByRole('button', { name: "Install and use as the agent's memory" })).toBeVisible();
  expect(sent.at(-1)!.path).toBe(`${BASE}/install?memory=forget`);
});

test("a tidy-up that fails says why, not the status it came with", async ({ page }) => {
  await portal(page, { docker: true, dreamFails: true });
  const settings = await open(page);
  const here = settings.getByRole('region', { name: 'Understory run here' });
  await here.getByRole('button', { name: "Install and use as the agent's memory" }).click();
  await here.getByRole('button', { name: 'Tidy up now' }).click();
  await expect(page.getByText('fetch failed').first()).toBeVisible();
  await expect(page.getByText('HTTP 502')).toHaveCount(0);
});

test("a container by Understory's name that the portal did not make is left alone, and said so", async ({ page }) => {
  await portal(page, { docker: true, container: 'foreign' });
  const settings = await open(page);
  const here = settings.getByRole('region', { name: 'Understory run here' });
  await expect(here.getByRole('alert')).toContainText('the portal did not make');
  await expect(here.getByRole('button', { name: "Install and use as the agent's memory" })).toBeDisabled();
  await expect(here.getByRole('button', { name: 'Remove' })).toHaveCount(0);
});

test('Escape over the memory settings that were changed asks first, and over ones that were saved does not', async ({ page }) => {
  await portal(page, { docker: true });
  const ask = page.getByRole('alertdialog', { name: 'Discard your changes?' });
  const settings = await open(page);
  const here = settings.getByRole('region', { name: 'Understory run here' });
  await expect(here.getByRole('radio', { name: 'Never' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(settings).toBeHidden();

  await open(page);
  await here.getByRole('radio', { name: 'On an interval' }).click();
  await page.keyboard.press('Escape');
  await expect(ask).toBeVisible();
  await ask.getByRole('button', { name: 'Cancel' }).click();
  await expect(here.getByRole('radio', { name: 'On an interval' })).toBeChecked();
  await here.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(here.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(settings).toBeHidden();
});
