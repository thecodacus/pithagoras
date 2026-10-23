import { type Page } from '@playwright/test';
import { test, expect, mockPortal, reply } from './portal-mock';

interface Portal {
  models?: boolean;
  slow?: number;
  /** Only /api/settings is slow. */
  slowSettings?: number;
  stored?: Record<string, string>;
  /** What a server at an address lists, or undefined when nothing answers there. */
  probe?: (baseUrl: string) => (string | { id: string; name?: string })[] | undefined;
  /** How long a server at an address takes to answer. */
  probeDelay?: (baseUrl: string) => number;
  homepage?: string;
  openRouterFromEnv?: boolean;
  installBringsModels?: boolean;
  /** A model that does not think, beside Model A. */
  plainModel?: boolean;
  /** How long the nth save of the defaults takes, from 0. */
  settingsSaveDelay?: (n: number) => number;
  /** What the server says came of saving a provider, besides. */
  providerNote?: string;
  /** A portal with a password, and what its status says of it. */
  login?: { shortPassword?: boolean; sso?: boolean; endSession?: string };
  /** The password the portal takes as the current one when it is changed. */
  currentPassword?: string;
}

/** The portal with no server: Settings, its search, and the setup assistant, over canned answers. */
async function portal(page: Page, { models = true, slow = 0, slowSettings = 0, stored = {}, probe, probeDelay, homepage, openRouterFromEnv = false, installBringsModels = false, plainModel = false, settingsSaveDelay, providerNote, login, currentPassword = 'the current one' }: Portal = {}) {
  const calls: string[] = [];
  const passwordChanges: unknown[] = [];
  const providerSaves: { id: string; body: any }[] = [];
  const settingsSaves: unknown[] = [];
  const extensionSaves: unknown[] = [];
  let savingNow = 0, savingMost = 0;
  // A provider package, once installed, brings its models.
  const available = () => (models || (installBringsModels && installed.length) ? [
    { provider: 'llama-swap', id: 'model-a', name: 'Model A', contextWindow: 65536, reasoning: true },
    ...(plainModel ? [{ provider: 'llama-swap', id: 'Plain', name: 'Plain 1', contextWindow: 32768, reasoning: false }] : []),
  ] : []);
  let saved: unknown = null;
  let installed: string[] = [];
  await mockPortal(page, async ({ path: p, method, json }) => {
    calls.push(`${method} ${p}`);
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    if (p === '/api/auth/status') return { authed: true, authRequired: Boolean(login), ...(login?.shortPassword ? { shortPassword: true } : {}), ...(login?.sso ? { oidc: { name: 'Example ID', only: true } } : {}) };
    if (p === '/api/auth/logout') return { ok: true, ...(login?.endSession ? { endSession: login.endSession } : {}) };
    if (p === '/api/auth/sso' && method === 'GET') return { mode: login ? 'password' : 'open', callbackPath: '/api/auth/oidc/callback', settings: null, only: false };
    if (p === '/api/auth/password' && method === 'POST') {
      const sent = json();
      if (sent.current !== currentPassword) return reply(403, { error: 'The current password is wrong.' });
      if (sent.password === 'change-me') return reply(400, { error: 'That is the example password, which everybody knows. Choose another.' });
      passwordChanges.push(sent);
      return { ok: true };
    }
    if (p === '/api/sessions' && method === 'POST') return { id: 'new', title: 'New', workspace: '/w', status: 'idle', kind: 'task', pinned: false };
    if (p === '/api/settings' && method === 'PUT') {
      const sent = json();
      savingMost = Math.max(savingMost, ++savingNow);
      await wait(settingsSaveDelay?.(settingsSaves.length) ?? 0);
      savingNow--;
      // What the server ends on: the save that landed last.
      settingsSaves.push(sent);
      saved = sent;
      return { settings: {}, compaction: { keepRecentTokens: 20000 }, refreshed: 0, note: '' };
    }
    if (p === '/api/settings') {
      await wait(slow + slowSettings);
      return {
        settings: { provider: 'llama-swap', model: 'model-a', thinkingLevel: 'medium' }, stored, defaults: { provider: 'llama-swap', model: 'model-a', thinkingLevel: 'medium' },
        piSettingsPath: '/a/settings.json', compaction: { keepRecentTokens: 20000 }, compactionDefaults: { keepRecentTokens: 20000 }, contextDefault: null, executor: 'host', workspaceRoot: '/w',
      };
    }
    if (p === '/api/models') { await wait(slow * 2); return { models: available(), providers: { 'llama-swap': 'llama-swap' } }; }
    if (p === '/api/routines/report-targets') { await wait(slow); return { targets: [], default: null }; }
    if (p === '/api/providers') return {
      presets: [
        { kind: 'llama-cpp', label: 'llama.cpp', description: 'One llama-server', id: 'llama-server', endpoint: true, baseUrl: 'http://127.0.0.1:8080/v1', key: 'optional' },
        { kind: 'llama-swap', label: 'llama-swap', description: 'Several models, swapped in', id: 'llama-swap', endpoint: true, baseUrl: 'http://127.0.0.1:8080/v1', key: 'optional' },
        { kind: 'custom', label: 'Custom', description: 'Any OpenAI-compatible server', id: 'custom', endpoint: true, key: 'optional' },
        { kind: 'openrouter', label: 'OpenRouter', description: 'Hundreds of hosted models', id: 'openrouter', endpoint: false, key: 'required' },
      ],
      apis: ['openai-completions'], hosted: [],
      providers: [
        ...(models ? [{ id: 'llama-swap', kind: 'llama-swap', label: 'llama-swap', baseUrl: 'http://gpu:8080/v1', key: { set: false }, models: [{ id: 'model-a', name: 'Model A' }, { id: 'Gone' }], endpoint: true }] : []),
        ...(openRouterFromEnv ? [{ id: 'openrouter', kind: 'openrouter', label: 'OpenRouter', key: { set: true, source: 'environment' }, models: [], endpoint: false }] : []),
      ],
    };
    if (p === '/api/providers/status') return { status: { 'llama-swap': { state: 'up', ms: 12, listed: 1, missing: ['Gone'], loaded: ['model-a'] } } };
    if (p === '/api/extensions') { await wait(slow * 3); return { settingsPath: '/a/settings.json', extensions: [{ spec: 'npm:pi-web-access', name: 'pi-web-access', settings: [{ key: 'braveApiKey', value: '', configured: false }, { key: 'safeSearch', value: true, configured: true }, { key: 'enableCache', value: '', configured: false }] }] }; }
    if (p === '/api/extensions/settings' && method === 'PUT') { extensionSaves.push(json()); return { ok: true }; }
    if (p === '/api/packages/catalog') return { packages: [
      { name: 'pi-web-access', version: '0.31.0', description: 'Web search for pi', weekly: 198311, keywords: ['pi-package'], provider: false, homepage },
      { name: 'pi-subagents', version: '0.71.0', description: 'Delegate to helpers', weekly: 100713, keywords: ['pi-package'], provider: false, date: new Date(Date.now() - 2 * 86400_000).toISOString() },
    ] };
    if (p === '/api/packages' && method === 'POST') { installed.push(json().spec); return { ok: true, output: '' }; }
    if (p === '/api/providers/probe' && probe) {
      const asked: string = json().baseUrl;
      await wait(probeDelay?.(asked) ?? 0);
      const listed = probe(asked);
      if (!listed) return reply(502, { error: 'Nothing answered there.' });
      // As the server says it: with its scheme and its /v1.
      const at = /\/v\d/.test(asked) ? asked : `${/^https?:/.test(asked) ? '' : 'http://'}${asked.replace(/\/+$/, '')}/v1`;
      return { baseUrl: at, models: listed.map((m) => (typeof m === 'string' ? { id: m } : m)) };
    }
    if (p.startsWith('/api/providers/') && method === 'PUT') { providerSaves.push({ id: decodeURIComponent(p.split('/').pop()!), body: json() }); return { ok: true, ...(providerNote ? { note: providerNote } : {}) }; }
    if (p === '/api/providers/probe') return reply(502, { error: 'Nothing answered at 127.0.0.1:8080 — is the server running, and reachable from here?' });
  }, { setup: 'fresh', settings: true });
  return { calls, passwordChanges, saved: () => saved, installed: () => installed, providerSaves, settingsSaves, extensionSaves, savingMost: () => savingMost };
}

test('search finds a setting on another page and lights it up', async ({ page }) => {
  await portal(page);
  await page.addInitScript(() => localStorage.setItem('pithagoras.setup', 'done'));
  await page.goto('/settings/general');
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await expect(dialog.getByLabel('Default model')).toBeVisible();

  // "/" reaches the search from anywhere that is not a field.
  await page.keyboard.press('/');
  await expect(dialog.getByLabel('Search settings')).toBeFocused();
  await page.keyboard.type('dunkel');
  await expect(dialog.getByRole('option').first()).toContainText('Theme');
  await page.keyboard.press('Enter');
  await expect(dialog.getByRole('radiogroup', { name: 'Theme' })).toBeInViewport();
  await expect(dialog.locator('[data-setting="Appearance"]')).toHaveClass(/setting-flash/);

  // An extension's own keys are found too, by their readable names.
  await dialog.getByLabel('Search settings').fill('safe search');
  await dialog.getByRole('option').first().click();
  await expect(dialog.getByRole('switch', { name: 'Safe search' })).toBeVisible();

  // Escape clears the search before it closes the dialog.
  await dialog.getByLabel('Search settings').fill('context');
  await dialog.getByLabel('Search settings').press('Escape');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('Search settings')).toHaveValue('');
});

test('Defaults draws once, whole: nothing moves after it appears', async ({ page }) => {
  await portal(page, { slow: 250 });
  await page.addInitScript(() => localStorage.setItem('pithagoras.setup', 'done'));
  await page.goto('/settings/general');
  const context = page.locator('[data-setting="Context"]');
  await expect(context).toBeVisible();
  const first = await context.evaluate((el) => el.getBoundingClientRect().top);
  await page.waitForTimeout(900);
  const later = await context.evaluate((el) => el.getBoundingClientRect().top);
  expect(Math.abs(later - first)).toBeLessThan(8); // no more than its own rise
  await expect(page.getByLabel('Default model')).toContainText('Model A');

  // Opened a second time, it is there at once, from what was kept.
  await page.getByRole('button', { name: 'Close' }).click();
  await expect(page.getByRole('dialog', { name: 'Settings' })).toBeHidden();
  await page.getByRole('button', { name: /settings/i }).first().click();
  await expect(page.getByLabel('Default model')).toContainText('Model A', { timeout: 150 });
});

test('the rail keeps its extension pages from last time, and a provider says it is online', async ({ page }) => {
  await portal(page, { slow: 400 });
  await page.addInitScript(() => {
    localStorage.setItem('pithagoras.setup', 'done');
    localStorage.setItem('pithagoras.settings.extension-rail', JSON.stringify([{ spec: 'npm:pi-web-access', name: 'pi-web-access' }]));
  });
  await page.goto('/settings/models');
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  // There before the slow list of extensions has answered.
  await expect(dialog.getByRole('button', { name: 'pi-web-access' })).toBeVisible({ timeout: 800 });
  await expect(dialog.getByText('Online · 12 ms')).toBeVisible();
  await expect(dialog.getByText('Gone is not listed by the server any more.')).toBeVisible();
  await expect(dialog.getByTitle('model-a — loaded now')).toBeVisible();
});

/** Where the rail keeps which of its groups were folded, by their English names. */
const FOLDED = 'pithagoras.settings.rail-closed';
const folded = (page: Page) => page.evaluate((key) => localStorage.getItem(key), FOLDED);

test("the rail's groups fold under their headings, with the keys too, and stay as they were left after a reload", async ({ page }) => {
  await portal(page);
  await page.addInitScript(() => localStorage.setItem('pithagoras.setup', 'done'));
  await page.goto('/settings/models');
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  const reach = dialog.getByRole('button', { name: 'Reach', exact: true });
  const extensions = dialog.getByRole('button', { name: 'Extension settings', exact: true });
  // Every group is open until somebody folds one, and its heading says which part of the rail it opens.
  for (const name of ['Models', 'Agent', 'Reach', 'Portal', 'Extension settings']) {
    const heading = dialog.getByRole('button', { name, exact: true });
    await expect(heading).toHaveAttribute('aria-expanded', 'true');
    await expect(heading).toHaveAttribute('aria-controls', (await dialog.getByRole('group', { name, exact: true }).getAttribute('id'))!);
  }
  await expect(dialog.getByRole('button', { name: 'pi-web-access' })).toBeVisible();
  expect(await folded(page)).toBeNull();

  await reach.click();
  await expect(reach).toHaveAttribute('aria-expanded', 'false');
  await expect(dialog.getByRole('button', { name: 'Channels' })).toBeHidden();
  await expect(dialog.getByRole('button', { name: 'People' })).toBeHidden();
  await extensions.click();
  await expect(dialog.getByRole('button', { name: 'pi-web-access' })).toBeHidden();
  expect(JSON.parse((await folded(page))!)).toEqual(['Reach', 'Extension settings']);
  // The page showing is not left for the fold.
  await expect(dialog.getByText('Online · 12 ms')).toBeVisible();

  await page.reload();
  await expect(reach).toHaveAttribute('aria-expanded', 'false');
  await expect(extensions).toHaveAttribute('aria-expanded', 'false');
  await expect(dialog.getByRole('button', { name: 'Channels' })).toBeHidden();
  await expect(dialog.getByRole('button', { name: 'pi-web-access' })).toBeHidden();
  await expect(dialog.getByRole('button', { name: 'Tools', exact: true })).toBeVisible();

  // Enter and Space open and fold it as a click does, and the focus stays on the heading.
  await reach.focus();
  await page.keyboard.press('Enter');
  await expect(reach).toHaveAttribute('aria-expanded', 'true');
  await expect(dialog.getByRole('button', { name: 'Channels' })).toBeVisible();
  await expect(reach).toBeFocused();
  await page.keyboard.press('Space');
  await expect(reach).toHaveAttribute('aria-expanded', 'false');
  await expect(dialog.getByRole('button', { name: 'Channels' })).toBeHidden();
  await page.keyboard.press('Enter');
  await expect(reach).toHaveAttribute('aria-expanded', 'true');
  expect(JSON.parse((await folded(page))!)).toEqual(['Extension settings']);
  await page.reload();
  await expect(reach).toHaveAttribute('aria-expanded', 'true');
  await expect(extensions).toHaveAttribute('aria-expanded', 'false');
});

test('a page in a folded group, reached by a search or its address, is shown with its group held open, and folded again once it is left', async ({ page }) => {
  await portal(page);
  await page.addInitScript((key) => {
    localStorage.setItem('pithagoras.setup', 'done');
    if (!sessionStorage.getItem('seeded')) { sessionStorage.setItem('seeded', '1'); localStorage.setItem(key, JSON.stringify(['Agent', 'Portal', 'Extension settings'])); }
  }, FOLDED);
  await page.goto('/settings/general');
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  const portalGroup = dialog.getByRole('button', { name: 'Portal', exact: true });
  const extensions = dialog.getByRole('button', { name: 'Extension settings', exact: true });
  await expect(dialog.getByLabel('Default model')).toBeVisible();
  await expect(portalGroup).toHaveAttribute('aria-expanded', 'false');
  await expect(dialog.getByRole('button', { name: 'This browser' })).toBeHidden();
  // The group of the page showing is held open: its heading says so, and does nothing.
  const models = dialog.getByRole('button', { name: 'Models', exact: true });
  await expect(models).toHaveAttribute('aria-expanded', 'true');
  await expect(models).toHaveAttribute('aria-disabled', 'true');
  await expect(models).toHaveAttribute('title', 'Open while one of its pages is showing');

  // What is in a folded group is found all the same, and picking it opens its group with its page marked.
  await dialog.getByLabel('Search settings').fill('dunkel');
  await expect(dialog.getByRole('option').first()).toContainText('Theme');
  await dialog.getByLabel('Search settings').press('Enter');
  await expect(dialog.getByRole('radiogroup', { name: 'Theme' })).toBeInViewport();
  // What was found stays listed in the rail's place until the search is cleared.
  await expect(portalGroup).toBeHidden();
  await dialog.getByLabel('Search settings').press('Escape');
  await expect(portalGroup).toHaveAttribute('aria-expanded', 'true');
  await expect(dialog.getByRole('button', { name: 'This browser' })).toHaveAttribute('aria-current', 'page');
  // Held open, a press on its heading neither folds it nor changes what is kept.
  await expect(portalGroup).toHaveAttribute('aria-disabled', 'true');
  await portalGroup.focus();
  await page.keyboard.press('Enter');
  await expect(portalGroup).toHaveAttribute('aria-expanded', 'true');
  await portalGroup.click({ force: true });
  await expect(portalGroup).toHaveAttribute('aria-expanded', 'true');
  await expect(models).not.toHaveAttribute('aria-disabled', /.+/);
  expect(JSON.parse((await folded(page))!)).toEqual(['Agent', 'Portal', 'Extension settings']);

  // An extension's page too; the group left behind is folded again, as it was left.
  await dialog.getByLabel('Search settings').fill('safe search');
  await dialog.getByRole('option').first().click();
  await expect(dialog.getByRole('switch', { name: 'Safe search' })).toBeVisible();
  await dialog.getByLabel('Search settings').press('Escape');
  await expect(extensions).toHaveAttribute('aria-expanded', 'true');
  await expect(dialog.getByRole('button', { name: 'pi-web-access' })).toHaveAttribute('aria-current', 'page');
  await expect(portalGroup).toHaveAttribute('aria-expanded', 'false');
  await expect(dialog.getByRole('button', { name: 'This browser' })).toBeHidden();

  // Opened at a page's address.
  await page.goto('/settings/extensions');
  const agent = dialog.getByRole('button', { name: 'Agent', exact: true });
  await expect(agent).toHaveAttribute('aria-expanded', 'true');
  await expect(dialog.getByRole('button', { name: 'Extensions', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(extensions).toHaveAttribute('aria-expanded', 'false');
  // Left for a page of another group, the one it was in is folded as it was kept.
  await dialog.getByRole('button', { name: 'Providers' }).click();
  await expect(agent).toHaveAttribute('aria-expanded', 'false');
  await expect(dialog.getByRole('button', { name: 'Extensions', exact: true })).toBeHidden();
});

test("on a phone the rail's groups fold in the rail, without turning to a page, and a page picked in one is shown", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await portal(page);
  await page.addInitScript(() => localStorage.setItem('pithagoras.setup', 'done'));
  await page.goto('/settings/general');
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  const portalGroup = dialog.getByRole('button', { name: 'Portal', exact: true });
  await expect(dialog.getByLabel('Search settings')).toBeVisible();
  await portalGroup.click();
  await expect(portalGroup).toHaveAttribute('aria-expanded', 'false');
  await expect(dialog.getByRole('button', { name: 'This browser' })).toBeHidden();
  // Still the rail: no page in its place, and no way back.
  await expect(dialog.getByLabel('Search settings')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Back', exact: true })).toBeHidden();
  await portalGroup.click();
  await dialog.getByRole('button', { name: 'This browser' }).click();
  await expect(dialog.getByRole('button', { name: 'Back', exact: true })).toBeVisible();
  await expect(dialog.getByLabel('Search settings')).toBeHidden();
  await expect(dialog.getByRole('radiogroup', { name: 'Theme' })).toBeVisible();
});

test("in German no heading of the rail is cut off, the long one of the extensions' group included", async ({ page }) => {
  await portal(page);
  await page.addInitScript(() => {
    localStorage.setItem('pithagoras.setup', 'done');
    localStorage.setItem('pithagoras.language', 'de');
  });
  await page.goto('/settings/models');
  const dialog = page.getByRole('dialog', { name: 'Einstellungen' });
  await expect(dialog.getByRole('button', { name: 'pi-web-access' })).toBeVisible();
  // None of a name runs past the room it is given, where it would be cut off.
  for (const name of ['Modelle', 'Agent', 'Erreichbarkeit', 'Portal', 'Einstellungen der Erweiterungen']) {
    const label = dialog.getByRole('button', { name, exact: true }).locator('span');
    expect(await label.evaluate((el) => el.scrollWidth <= el.clientWidth), name).toBe(true);
  }
});

test('with no model yet, the setup assistant walks through provider, model and packages', async ({ page }) => {
  const api = await portal(page, { models: false });
  await page.goto('/');
  const setup = page.getByRole('dialog', { name: 'Set up Pithagoras' });
  await expect(setup).toBeVisible({ timeout: 5000 });
  await expect(setup.getByLabel('Kind of provider')).toBeVisible();
  await expect(setup.getByRole('button', { name: 'Next' })).toBeDisabled();

  // "From a package" shows provider packages rather than an address.
  await setup.getByLabel('Kind of provider').click();
  await page.getByRole('option', { name: /From a package/ }).click();
  await expect(setup.getByText('pi-web-access')).toBeVisible();

  // Skipped, it stays away after a reload.
  await setup.getByRole('button', { name: 'Set up later' }).click();
  await expect(setup).toBeHidden();
  await page.reload();
  await page.waitForTimeout(2000);
  await expect(setup).toBeHidden();
  expect(api.calls.some((c) => c === 'GET /api/models')).toBe(true);
});

test('with models, the assistant saves the model and effort, then offers packages to install', async ({ page }) => {
  const api = await portal(page);
  await page.goto('/settings/models');
  await page.getByRole('button', { name: 'Setup assistant' }).click();
  const setup = page.getByRole('dialog', { name: 'Set up Pithagoras' });
  await expect(setup.getByText('llama-swap').first()).toBeVisible();
  await setup.getByRole('button', { name: 'Next' }).click();
  await expect(setup.getByLabel('Model for new chats')).toContainText('Model A');
  await setup.getByRole('radio', { name: 'high', exact: true }).click();
  await setup.getByRole('button', { name: 'Next' }).click();
  await expect.poll(() => api.saved()).toEqual({ provider: 'llama-swap', model: 'model-a', thinkingLevel: 'high' });
  await expect(setup.getByText('pi-subagents')).toBeVisible();
  await setup.getByRole('button', { name: 'Install pi-subagents' }).click();
  await page.getByRole('button', { name: 'Install', exact: true }).click();
  // Its own row: pi-web-access above it is installed already and says the same.
  await expect(setup.getByRole('listitem').filter({ hasText: 'pi-subagents' }).getByText('Installed')).toBeVisible();
  await expect.poll(() => api.installed()).toEqual(['npm:pi-subagents']);
  await setup.getByRole('button', { name: 'Done' }).click();
  await expect(setup).toBeHidden();
});

test('Back leads to the step before on every step after the first, and leaving says where the assistant is found again', async ({ page }) => {
  await portal(page);
  await page.goto('/settings/models');
  await page.getByRole('button', { name: 'Setup assistant' }).click();
  const setup = page.getByRole('dialog', { name: 'Set up Pithagoras' });
  const current = setup.locator('.setup-step[aria-current="step"]');
  // Said where every device shows it, whichever way the assistant is left.
  await expect(setup.getByText('Settings → Providers opens this assistant again.')).toBeInViewport({ ratio: 1 });
  // The first step has nothing before it: what leaves is named for what it does, not as a skip.
  await expect(current).toContainText('1. Provider');
  await expect(setup.getByRole('button', { name: 'Back' })).toHaveCount(0);
  await expect(setup.getByRole('button', { name: 'Set up later' })).toBeVisible();
  await setup.getByRole('button', { name: 'Next' }).click();
  await expect(current).toContainText('2. Model');
  await setup.getByRole('button', { name: 'Next' }).click();
  await expect(current).toContainText('3. Agent');
  await setup.getByRole('button', { name: 'Back' }).click();
  await expect(current).toContainText('2. Model');
  await setup.getByRole('button', { name: 'Back' }).click();
  await expect(current).toContainText('1. Provider');
});

test('on a phone the way forward stays at the right of the assistant, away from the way back', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await portal(page);
  await page.goto('/settings/models');
  await page.getByRole('button', { name: 'Setup assistant' }).click();
  const setup = page.getByRole('dialog', { name: 'Set up Pithagoras' });
  const later = (await setup.getByRole('button', { name: 'Set up later' }).boundingBox())!;
  const next = (await setup.getByRole('button', { name: 'Next' }).boundingBox())!;
  const later2next = next.x - (later.x + later.width);
  expect(later2next).toBeGreaterThan(100);
  // Where it is found again is said in full, not cut off as the one-line subtitle would.
  const hint = setup.getByText('Settings → Providers opens this assistant again.');
  expect(await hint.evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true);
  await expect(hint).toBeInViewport({ ratio: 1 });
});

test('while the model saves, Back and the choice wait: the save would land on the step before, or miss the change', async ({ page }) => {
  const api = await portal(page, { settingsSaveDelay: () => 800 });
  await page.goto('/settings/models');
  await page.getByRole('button', { name: 'Setup assistant' }).click();
  const setup = page.getByRole('dialog', { name: 'Set up Pithagoras' });
  await setup.getByRole('button', { name: 'Next' }).click();
  await expect(setup.getByLabel('Model for new chats')).toContainText('Model A');
  await setup.getByRole('button', { name: 'Next' }).click();
  await expect(setup.getByRole('button', { name: 'Back' })).toBeDisabled();
  await expect(setup.getByLabel('Model for new chats')).toBeDisabled();
  await expect(setup.locator('.setup-step[aria-current="step"]')).toContainText('3. Agent');
  await expect(setup.getByRole('button', { name: 'Back' })).toBeEnabled();
  expect(api.settingsSaves).toHaveLength(1);
});

test('a stored model no one offers any more is not kept: the assistant offers one that is, and saves it', async ({ page }) => {
  const api = await portal(page, { stored: { provider: 'gone', model: 'foo' } });
  await page.goto('/settings/models');
  await page.getByRole('button', { name: 'Setup assistant' }).click();
  const setup = page.getByRole('dialog', { name: 'Set up Pithagoras' });
  await setup.getByRole('button', { name: 'Next' }).click();
  await expect(setup.getByLabel('Model for new chats')).toContainText('Model A');
  await setup.getByRole('button', { name: 'Next' }).click();
  await expect.poll(() => api.saved()).toMatchObject({ provider: 'llama-swap', model: 'model-a' });
});

test('a new provider keeps only the models its current address lists', async ({ page }) => {
  const api = await portal(page, { probe: (url) => (url.includes('9090') ? ['B'] : url.includes('8080') ? ['A'] : undefined) });
  await page.addInitScript(() => localStorage.setItem('pithagoras.setup', 'done'));
  // A model list cached by the chat's model menu, from before this provider.
  await page.addInitScript(() => { if (!sessionStorage.getItem('seeded')) { localStorage.setItem('modelCatalogue.v2', JSON.stringify({ at: Date.now(), models: [{ id: 'A', name: 'A', provider: 'x' }] })); sessionStorage.setItem('seeded', '1'); } });
  await page.goto('/settings/models');
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await dialog.getByRole('button', { name: 'Add a provider' }).click();
  // The preset's address is asked at once: something answers there.
  await expect(dialog.getByLabel('Use A')).toBeChecked();
  await dialog.getByLabel('Server address').fill('http://gpu:9090/v1');
  await expect(dialog.getByLabel('Use B')).toBeChecked();
  await expect(dialog.getByLabel('Use A')).toHaveCount(0);
  // One named by hand stays, whatever the address.
  await dialog.getByLabel('Model id to add').fill('Mine');
  await dialog.getByLabel('Model id to add').press('Enter');
  await dialog.getByLabel('Server address').fill('http://gpu:9090/v1/');
  await expect(dialog.getByLabel('Use Mine')).toBeChecked();
  await dialog.getByRole('button', { name: 'Add', exact: true }).click();
  await expect.poll(() => api.providerSaves.length).toBe(1);
  expect((api.providerSaves[0].body as { models: { id: string }[] }).models.map((m) => m.id)).toEqual(['B', 'Mine']);
  // Saved: the cached list goes, so the next model menu opened fetches the new one.
  await expect.poll(() => page.evaluate(() => localStorage.getItem('modelCatalogue.v2'))).toBeNull();
});

test("a package's link that is not a web page is not made a link", async ({ page }) => {
  await portal(page, { homepage: 'javascript:alert(1)' });
  await page.addInitScript(() => localStorage.setItem('pithagoras.setup', 'done'));
  await page.goto('/settings/models');
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await dialog.getByRole('button', { name: 'Add a provider' }).click();
  await dialog.getByLabel('Kind of provider').click();
  await page.getByRole('option', { name: /From a package/ }).click();
  // Drawn: its description is there, and so would its link be.
  await expect(dialog.getByText('Web search for pi')).toBeVisible();
  await expect(dialog.getByText('Delegate to helpers')).toBeVisible();
  await expect(dialog.locator('a[href^="javascript:"]')).toHaveCount(0);
  await expect(dialog.getByRole('link', { name: 'more' })).toHaveCount(0);
});

test('a click on the word beside a dropdown, or on its hint, does not open it', async ({ page }) => {
  await portal(page, { probe: () => ['A'] });
  await page.addInitScript(() => localStorage.setItem('pithagoras.setup', 'done'));
  await page.goto('/settings/models');
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await dialog.getByRole('button', { name: 'Add a provider' }).click();
  const kind = dialog.getByLabel('Kind of provider');
  await expect(kind).toBeVisible();
  // Inside a label, either would be passed on to the button and open its list.
  await dialog.getByText('Kind', { exact: true }).click();
  await expect(page.getByRole('listbox')).toHaveCount(0);
  await kind.locator('xpath=following-sibling::p').click();
  await expect(page.getByRole('listbox')).toHaveCount(0);
  await kind.click();
  await expect(page.getByRole('listbox')).toBeVisible();
});

test('a new provider cannot take a name already set up', async ({ page }) => {
  await portal(page, { probe: () => ['A'] });
  await page.addInitScript(() => localStorage.setItem('pithagoras.setup', 'done'));
  await page.goto('/settings/models');
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await dialog.getByRole('button', { name: 'Add a provider' }).click();
  await expect(dialog.getByLabel('Use A')).toBeChecked();
  const add = dialog.getByRole('button', { name: 'Add', exact: true });
  await expect(add).toBeEnabled();
  await dialog.getByLabel('Provider name').fill('llama-swap');
  await expect(add).toBeDisabled();
  await expect(dialog.getByText('“llama-swap” is set up already — edit it in the list, or pick another name.')).toBeVisible();
});

test('OpenRouter keyed from the environment is given a stored key under its own name', async ({ page }) => {
  const api = await portal(page, { openRouterFromEnv: true });
  await page.addInitScript(() => localStorage.setItem('pithagoras.setup', 'done'));
  await page.goto('/settings/models');
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await dialog.getByRole('button', { name: 'Add a provider' }).click();
  await dialog.getByLabel('Kind of provider').click();
  await page.getByRole('option', { name: /OpenRouter/ }).click();
  await dialog.getByLabel('API key').fill('sk-or-v1-0123456789');
  await dialog.getByRole('button', { name: 'Add', exact: true }).click();
  await expect.poll(() => api.providerSaves.map((s) => s.id)).toEqual(['openrouter']);
  expect(api.providerSaves[0].body).toMatchObject({ kind: 'openrouter', adding: true, apiKey: 'sk-or-v1-0123456789' });
});

test('a provider package installed in the assistant brings its models, and Next with them', async ({ page }) => {
  await portal(page, { models: false, installBringsModels: true });
  await page.goto('/');
  const setup = page.getByRole('dialog', { name: 'Set up Pithagoras' });
  await expect(setup.getByRole('button', { name: 'Next' })).toBeDisabled();
  await setup.getByLabel('Kind of provider').click();
  await page.getByRole('option', { name: /From a package/ }).click();
  await setup.getByRole('button', { name: 'Install pi-subagents' }).click();
  await page.getByRole('button', { name: 'Install', exact: true }).click();
  await expect(setup.getByRole('button', { name: 'Next' })).toBeEnabled();
});

test('quick changes to the defaults are saved one at a time, ending on the last', async ({ page }) => {
  // The first save is slow: sent side by side, the second would land first and the first win.
  const api = await portal(page, { stored: { provider: 'llama-swap', model: 'model-a' }, settingsSaveDelay: (n) => (n === 0 ? 600 : 20) });
  await page.addInitScript(() => localStorage.setItem('pithagoras.setup', 'done'));
  await page.goto('/settings/general');
  const effort = page.getByRole('radiogroup', { name: 'Default effort' });
  await effort.getByRole('radio', { name: 'high', exact: true }).click();
  await effort.getByRole('radio', { name: 'low', exact: true }).click();
  await expect.poll(() => api.settingsSaves.length).toBe(2);
  expect(api.savingMost()).toBe(1);
  expect(api.saved()).toMatchObject({ thinkingLevel: 'low' });
});

test('the assistant keeps the effort stored for thinking models when the model picked does not think', async ({ page }) => {
  const api = await portal(page, { plainModel: true, stored: { provider: 'llama-swap', model: 'Plain', thinkingLevel: 'high' } });
  await page.goto('/settings/models');
  await page.getByRole('button', { name: 'Setup assistant' }).click();
  const setup = page.getByRole('dialog', { name: 'Set up Pithagoras' });
  await setup.getByRole('button', { name: 'Next' }).click();
  await expect(setup.getByLabel('Model for new chats')).toContainText('Plain 1');
  await setup.getByRole('button', { name: 'Next' }).click();
  await expect.poll(() => api.saved()).toEqual({ provider: 'llama-swap', model: 'Plain', thinkingLevel: 'high' });
});

test('the assistant waits for what is stored before it saves a model', async ({ page }) => {
  const api = await portal(page, { plainModel: true, slowSettings: 2500, stored: { provider: 'llama-swap', model: 'Plain', thinkingLevel: 'high' } });
  await page.goto('/settings/models');
  await page.getByRole('button', { name: 'Setup assistant' }).click();
  const setup = page.getByRole('dialog', { name: 'Set up Pithagoras' });
  await setup.getByRole('button', { name: 'Next' }).click();
  // Clicked before the stored model is known: nothing is saved over it.
  await setup.getByRole('button', { name: 'Next' }).click({ force: true });
  await expect(setup.getByLabel('Model for new chats')).toContainText('Plain 1');
  await setup.getByRole('button', { name: 'Next' }).click();
  await expect.poll(() => api.saved()).toEqual({ provider: 'llama-swap', model: 'Plain', thinkingLevel: 'high' });
  expect(api.settingsSaves).toHaveLength(1);
});

test('a password the portal only keeps because it was in use is said in Settings, where the login is', async ({ page }) => {
  await portal(page, { login: { shortPassword: true } });
  await page.addInitScript(() => localStorage.setItem('pithagoras.setup', 'done'));
  await page.goto('/settings/browser');
  const signedIn = page.getByRole('dialog').locator('section', { hasText: 'Signed in' });
  await expect(signedIn.getByRole('button', { name: 'Sign out' })).toBeVisible();
  await expect(signedIn.getByRole('note')).toContainText('shorter than 8 characters');
});

test('a password of the right length says nothing about it', async ({ page }) => {
  await portal(page, { login: {} });
  await page.addInitScript(() => localStorage.setItem('pithagoras.setup', 'done'));
  await page.goto('/settings/browser');
  const signedIn = page.getByRole('dialog').locator('section', { hasText: 'Signed in' });
  await expect(signedIn.getByRole('button', { name: 'Sign out' })).toBeVisible();
  await expect(signedIn.getByRole('note')).toHaveCount(0);
});

test('signing out of a portal set up to end the session at the provider goes on to the provider', async ({ page }) => {
  const endSession = 'https://id.example.test/logout?client_id=portal';
  await portal(page, { login: { sso: true, endSession } });
  await page.route('https://id.example.test/**', (route) => route.fulfill({ contentType: 'text/html', body: '<h1>Signed out at the provider</h1>' }));
  await page.addInitScript(() => localStorage.setItem('pithagoras.setup', 'done'));
  await page.goto('/settings/browser');
  const signedIn = page.getByRole('dialog').locator('section', { hasText: 'Signed in' });
  await expect(signedIn).toContainText('Signing out asks you to sign in here again.');
  await signedIn.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: 'Signed out at the provider' })).toBeVisible();
  expect(page.url()).toBe(endSession);
});

test('the password is changed under Settings → Authentication: the current one once, the new one twice, and the form is clear afterwards', async ({ page }) => {
  const api = await portal(page, { login: {} });
  await page.addInitScript(() => localStorage.setItem('pithagoras.setup', 'done'));
  await page.goto('/settings/authentication');
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  // The password's part of the page: single sign-on, beside it, has a current password and messages of its own.
  const pane = dialog.locator('[data-setting="Change password"]');
  const change = pane.getByRole('button', { name: 'Change password' });
  const current = pane.getByLabel('Current password');
  const fresh = pane.getByLabel(/^New password/);
  const repeat = pane.getByLabel('Repeat the new password');
  await expect(current).toBeVisible();
  await expect(change).toBeDisabled();

  // Typed twice, differently, or too short: said in the page, and nothing is sent.
  await current.fill('the current one');
  await fresh.fill('a new password');
  await repeat.fill('another password');
  await change.click();
  await expect(pane.getByRole('alert')).toHaveText('The two passwords are not the same.');
  await fresh.fill('short');
  await repeat.fill('short');
  await change.click();
  await expect(pane.getByRole('alert')).toHaveText('The password has to be at least 8 characters.');
  expect(api.passwordChanges).toEqual([]);

  // The server's own refusal of a password the page cannot tell is bad.
  await fresh.fill('change-me');
  await repeat.fill('change-me');
  await change.click();
  await expect(pane.getByRole('alert')).toContainText('example password');

  // A wrong current password is told as that, and what was typed stays to be corrected.
  await current.fill('not it');
  await fresh.fill('a new password');
  await repeat.fill('a new password');
  await change.click();
  await expect(pane.getByRole('alert')).toHaveText('The current password is wrong.');
  await expect(fresh).toHaveValue('a new password');
  expect(api.passwordChanges).toEqual([]);

  await current.fill('the current one');
  await change.click();
  await expect(pane.getByRole('status')).toHaveText('The password is changed.');
  expect(api.passwordChanges).toEqual([{ current: 'the current one', password: 'a new password' }]);
  await expect(pane.getByRole('alert')).toHaveCount(0);
  await expect(current).toHaveValue('');
  await expect(fresh).toHaveValue('');
  await expect(repeat).toHaveValue('');
});

test('a portal that runs without a login has no password to change, and says why', async ({ page }) => {
  await portal(page);
  await page.addInitScript(() => localStorage.setItem('pithagoras.setup', 'done'));
  await page.goto('/settings/authentication');
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await expect(dialog.getByText('runs without a login')).toBeVisible();
  await expect(dialog.getByLabel('Current password')).toHaveCount(0);
});

test('search finds the password page, by its English word or the German one', async ({ page }) => {
  await portal(page, { login: {} });
  await page.addInitScript(() => localStorage.setItem('pithagoras.setup', 'done'));
  await page.goto('/settings/general');
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await dialog.getByLabel('Search settings').fill('passwort');
  await dialog.getByRole('option', { name: /Change password/ }).click();
  await expect(dialog.locator('[data-setting="Change password"]').getByLabel('Current password')).toBeVisible();
});

test('About draws from what Settings already has', async ({ page }) => {
  const api = await portal(page);
  await page.addInitScript(() => localStorage.setItem('pithagoras.setup', 'done'));
  await page.goto('/settings/general');
  await expect(page.getByLabel('Default model')).toBeVisible();
  const asked = api.calls.filter((c) => c === 'GET /api/settings').length;
  await page.getByRole('dialog', { name: 'Settings' }).getByRole('button', { name: 'About', exact: true }).click();
  await expect(page.getByText('/w', { exact: true })).toBeVisible({ timeout: 150 });
  expect(api.calls.filter((c) => c === 'GET /api/settings').length).toBe(asked);
});

test("an extension's setting not set before is stored as a switch or a number when it is one", async ({ page }) => {
  const api = await portal(page);
  await page.addInitScript(() => localStorage.setItem('pithagoras.setup', 'done'));
  await page.goto('/settings/models');
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await dialog.getByRole('button', { name: 'pi-web-access' }).click();
  await dialog.getByLabel('Enable cache').fill('false');
  await dialog.getByLabel('Enable cache').press('Enter');
  await expect.poll(() => api.extensionSaves).toEqual([{ key: 'enableCache', value: false }]);
});

test('an answer from an address typed over is not taken', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('pithagoras.setup', 'done'));
  await portal(page, { probe: (url) => (url.includes('host-a') ? ['FromA'] : url.includes('host-b') ? ['FromB'] : undefined), probeDelay: (url) => (url.includes('host-a') ? 400 : 0) });
  await page.goto('/settings/models');
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await dialog.getByRole('button', { name: 'Add a provider' }).click();
  const address = dialog.getByLabel('Server address');
  // Typed bare: the server's answer says it whole, which is put in the field.
  await address.fill('host-a:8080');
  // Asked a moment after the last key; typed over while it is on its way.
  await page.waitForTimeout(800);
  await address.fill('host-b:8080');
  await expect(dialog.getByLabel('Use FromB')).toBeChecked();
  await expect(address).toHaveValue('http://host-b:8080/v1');
  await expect(dialog.getByLabel('Use FromA')).toHaveCount(0);
});

test('an address is asked once it is whole, and not again when the server tidies it', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('pithagoras.setup', 'done'));
  const api = await portal(page, { probe: (url) => (url.includes('11434') ? ['llama3'] : undefined) });
  await page.goto('/settings/models');
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await dialog.getByRole('button', { name: 'Add a provider' }).click();
  const address = dialog.getByLabel('Server address');
  await expect(address).toHaveValue('http://127.0.0.1:8080/v1');
  await page.waitForTimeout(1000);
  const probes = () => api.calls.filter((c) => c === 'POST /api/providers/probe').length;
  const before = probes();
  await address.fill('192.168.');
  await page.waitForTimeout(1200);
  expect(probes(), 'half an address is not asked').toBe(before);
  await address.fill('gpu:11434');
  await expect(address).toHaveValue('http://gpu:11434/v1');
  await expect(dialog.getByLabel('Use llama3')).toBeChecked();
  await page.waitForTimeout(1200);
  expect(probes(), 'asked once').toBe(before + 1);
});

test('what a save did besides is said: a copy kept of a models.json whose comments it dropped', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('pithagoras.setup', 'done'));
  await portal(page, { probe: () => ['A'], providerNote: 'models.json had comments, which saving here does not keep. It is kept as it was in models.json.before-x.bak, beside it.' });
  await page.goto('/settings/models');
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await dialog.getByRole('button', { name: 'Add a provider' }).click();
  await expect(dialog.getByLabel('Use A')).toBeChecked();
  await dialog.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('models.json.before-x.bak');
});

test("asking a saved provider's server again takes the names it gives now: a llama-swap alias once saved under its router's name", async ({ page }) => {
  // Saved as Model A; the server now lists it under no name of its own, as llama-swap's aliases are read.
  const api = await portal(page, { probe: () => [{ id: 'model-a' }, { id: 'model-c', name: 'Model C — Flash' }] });
  await page.addInitScript(() => localStorage.setItem('pithagoras.setup', 'done'));
  await page.goto('/settings/models');
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await dialog.getByRole('button', { name: 'Edit llama-swap' }).click();
  await dialog.getByRole('button', { name: 'Ask again' }).click();
  await expect(dialog.getByText('Model A')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => api.providerSaves.length).toBe(1);
  const saved = (api.providerSaves[0].body as { models: { id: string; name?: string }[] }).models;
  expect(saved.find((m) => m.id === 'model-a')?.name).toBeUndefined();
});

test('Escape with a provider being added asks before Settings closes, and an untouched editor closes at once', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('pithagoras.setup', 'done'));
  await portal(page, { probe: () => ['A'] });
  await page.goto('/settings/models');
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await dialog.getByRole('button', { name: 'Add a provider' }).click();
  await expect(dialog.getByLabel('Server address')).toBeVisible();
  // Nothing typed: the preset's own address is not a draft.
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  await page.goto('/settings/models');
  await dialog.getByRole('button', { name: 'Add a provider' }).click();
  await dialog.getByLabel('Server address').fill('http://gpu:9090/v1');
  await page.keyboard.press('Escape');
  const ask = page.getByRole('alertdialog', { name: 'Discard your changes?' });
  await expect(ask).toBeVisible();
  // Keep editing: the address is still there.
  await ask.getByRole('button', { name: 'Cancel' }).click();
  await expect(ask).toBeHidden();
  await expect(dialog.getByLabel('Server address')).toHaveValue('http://gpu:9090/v1');
  // A click beside the dialog asks the same.
  await page.mouse.click(2, 2);
  await expect(ask).toBeVisible();
  await ask.getByRole('button', { name: 'Discard' }).click();
  await expect(dialog).toBeHidden();
});
