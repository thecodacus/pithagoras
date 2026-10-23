import { type Page } from '@playwright/test';
import { test, expect, mockPortal, reply } from './portal-mock';

/**
 * A page whose first read fails: after a restart of the portal, or while it is
 * not reachable. It used to keep its placeholder for ever, or draw "Nobody yet"
 * and "0 refused" as if they were so. Over canned answers where the paths in
 * `down` answer with an error until `up` says otherwise.
 */
const settings = {
  settings: { provider: 'llama-swap', model: 'model-a', thinkingLevel: 'medium' }, stored: {}, defaults: { provider: 'llama-swap', model: 'model-a', thinkingLevel: 'medium' },
  piSettingsPath: '/a/settings.json', compaction: { keepRecentTokens: 20000 }, compactionDefaults: { keepRecentTokens: 20000 }, contextDefault: null, executor: 'host', workspaceRoot: '/w',
};
const answers: Record<string, unknown> = {
  '/api/settings': settings,
  '/api/models': { models: [{ provider: 'llama-swap', id: 'model-a', name: 'Model A', contextWindow: 65536, reasoning: true }], providers: { 'llama-swap': 'llama-swap' } },
  '/api/routines/report-targets': { targets: [], default: null },
  '/api/extensions': { settingsPath: '/a/settings.json', extensions: [] },
  '/api/pi-settings': { path: '/a/settings.json', content: '{ "theme": "dark" }' },
  '/api/providers': { presets: [], apis: [], hosted: [], providers: [{ id: 'llama-swap', kind: 'llama-swap', label: 'llama-swap', baseUrl: 'http://gpu:8080/v1', key: { set: false }, models: [{ id: 'model-a', name: 'Model A' }], endpoint: true }] },
  '/api/providers/status': { status: {} },
  '/api/mcp': { path: '/a/mcp.json', exists: true, adapterInstalled: true, adapterSpec: 'npm:pi-mcp-adapter', settings: {}, raw: '{}', parseError: null, servers: [{ name: 'notes', entry: { command: 'notes-mcp' }, transport: 'stdio', disabled: false }] },
  '/api/people': { people: [{ key: 'telegram:1', name: 'Ada', role: 'primary', channel: 'telegram' }] },
  '/api/tool-rules': { rules: [] },
  '/api/channels': { channels: [], kinds: [], agentHome: '/a/home' },
  '/api/skills': { skills: [{ name: 'release-notes', description: 'How releases are cut', editable: true, enabled: true, source: 'user', path: '/a/skills/release-notes' }], diagnostics: [], root: '/a/skills' },
  '/api/voice': { provider: '', ready: false, speech: true, voices: [], enabled: false },
  '/api/features/subagent': { subagent: { available: true, installed: false, enabled: false, source: null, mode: 'interrupt', maxParallel: 1, model: 'auto' } },
  '/api/audit': { entries: [{ id: 2, at: '2026-10-01T09:00:00Z', kind: 'refused', tool: 'bash', subject: 'rm -rf /', reason: 'on the list', person_key: null, person_name: null, session_id: null }] },
  '/api/projects': { root: '/w', home: '/h', projects: [{ name: 'demo', path: '/w/demo', isGit: false, hasInstructions: false, hasTools: false, sessions: 0, lastActive: null }] },
  '/api/tools': { tools: [{ name: 'web_search', source: 'pi-web-access', defaultOn: true }], off: [], names: {} },
  '/api/agents': { agents: [{ id: 'home', name: 'Home', home: '/a', first: true, initialised: true, chats: 0, channels: [], orb: { avatar: 'orb', personality: 'balanced', palette: 'aurora', colors: { idle: '#82bcff', input: '#7fe0b4', output: '#c9a2ff', muted: '#8a91a0' }, speed: 1, reactivity: 1, glow: 1, pattern: 'ribbons', finish: 'glossy', eyes: 'none', eyeColor: '#111111', hat: 'none', hatColor: 'auto', prop: 'none', propColor: 'auto' }, voice: '', heartbeat: { minutes: 0, quietStart: '', quietEnd: '', timeZone: 'UTC', last: null, status: null, running: false, watching: false, available: true }, unread: 0 }] },
  '/api/agent/sessions': { sessions: [], agentHome: '/a' },
  '/api/agents/home/setup': { home: '/a', initialised: true, files: [{ name: 'SOUL.md', exists: true, content: 'Kind.', mtime: 1 }] },
};

async function portal(page: Page, down: string[], { replies = {}, fresh = false }: { replies?: Record<string, unknown>; fresh?: boolean } = {}) {
  const failing = new Set(down);
  const asked: string[] = [];
  await mockPortal(page, ({ path: p }) => {
    asked.push(p);
    if (failing.has(p)) return reply(500, { error: 'The portal is starting up' });
    return replies[p] ?? answers[p];
  }, { setup: fresh ? 'fresh' : 'done', settings: true });
  return { up: (...paths: string[]) => paths.forEach((p) => failing.delete(p)), asked };
}

const settingsDialog = (page: Page) => page.getByRole('dialog', { name: 'Settings' });
const FAILED = 'Could not load this: The portal is starting up';

/**
 * Opens a Settings page and checks that it says what failed, then that "Try again" brings the page once the portal is up.
 * `prefetched`: the page reads what the shell reads ahead of time, a moment after it has drawn (see prefetchSettings).
 */
async function failsThenRecovers(page: Page, tab: string, down: string[], { shown, gone = shown, prefetched = false }: { shown: string; gone?: string; prefetched?: boolean }) {
  const { up, asked } = await portal(page, down);
  await page.goto(`/settings/${tab}`);
  const alert = settingsDialog(page).getByRole('alert');
  await expect(alert).toContainText(FAILED);
  // What the page said before: an empty list, or a placeholder, as if it were so.
  await expect(settingsDialog(page).getByText(gone)).toHaveCount(0);
  // The shell's own read of it, which fails as well while the portal is down, is waited for: once the portal is up it would
  // bring the list by itself, and "Try again" would be a click on a button that is gone. This way it is the only thing that can.
  if (prefetched) await expect.poll(() => asked.filter((p) => p === down[0]).length, { timeout: 15_000 }).toBeGreaterThanOrEqual(2);
  up(...down);
  await alert.getByRole('button', { name: 'Try again' }).click();
  await expect(settingsDialog(page).getByText(shown).first()).toBeVisible();
  await expect(settingsDialog(page).getByRole('alert')).toHaveCount(0);
}

test('Settings → General says it could not be read, instead of a placeholder for ever', async ({ page }) => {
  await failsThenRecovers(page, 'general', ['/api/settings'], { shown: 'For new chats', prefetched: true });
});

test('Settings → About says it could not be read, and shows the portal once it can', async ({ page }) => {
  await failsThenRecovers(page, 'about', ['/api/settings'], { shown: 'Where the agent runs', prefetched: true });
});

test('Settings → Extensions does not say nothing is installed when the list could not be read', async ({ page }) => {
  await failsThenRecovers(page, 'extensions', ['/api/extensions'], { shown: 'Nothing installed yet.', prefetched: true });
});

test('Settings → Advanced offers to read the file again', async ({ page }) => {
  const { up } = await portal(page, ['/api/pi-settings']);
  await page.goto('/settings/advanced');
  await expect(settingsDialog(page).getByRole('alert')).toContainText(FAILED);
  up('/api/pi-settings');
  await settingsDialog(page).getByRole('button', { name: 'Try again' }).click();
  await expect(settingsDialog(page).getByRole('textbox')).toHaveValue('{ "theme": "dark" }');
});

test('Settings → Models offers to read the providers again', async ({ page }) => {
  await failsThenRecovers(page, 'models', ['/api/providers'], { shown: 'Add a provider', prefetched: true });
});

test('Settings → MCP does not spin for ever', async ({ page }) => {
  await failsThenRecovers(page, 'mcp', ['/api/mcp'], { shown: 'notes' });
});

test('Settings → People does not say nobody has written when the list could not be read', async ({ page }) => {
  await failsThenRecovers(page, 'people', ['/api/people'], { shown: 'Ada', gone: 'Nobody yet.' });
});

test('Settings → Channels does not say there are none when the list could not be read', async ({ page }) => {
  await failsThenRecovers(page, 'channels', ['/api/channels'], { shown: 'No channels yet.' });
});

test('Settings → Skills does not say there are none when the list could not be read', async ({ page }) => {
  await failsThenRecovers(page, 'skills', ['/api/skills'], { shown: 'release-notes', gone: 'None yet.' });
});

test('Settings → Tools: the subagent tool says what it could not read, and reads it again', async ({ page }) => {
  await failsThenRecovers(page, 'tools', ['/api/features/subagent'], { shown: 'Off: the agent has no subagent tool.' });
});

test('Settings → Defaults → Voice mode says what it could not read, and reads it again', async ({ page }) => {
  const { up } = await portal(page, ['/api/voice']);
  await page.goto('/settings/general');
  const dialog = settingsDialog(page);
  // The rest of the page is there: only the section says what failed.
  await expect(dialog.getByText('For new chats')).toBeVisible();
  await expect(dialog.getByRole('alert')).toContainText(FAILED);
  up('/api/voice');
  await dialog.getByRole('button', { name: 'Try again' }).click();
  await expect(dialog.getByText('Nothing listens and speaks for voice mode.', { exact: false })).toBeVisible();
  await expect(dialog.getByRole('alert')).toHaveCount(0);
});

test('the Audit page does not say nothing was recorded, with "0 refused", when it could not be read', async ({ page }) => {
  const { up } = await portal(page, ['/api/audit']);
  await page.goto('/audit');
  await expect(page.getByRole('alert')).toContainText(FAILED);
  await expect(page.getByText('Nothing recorded')).toHaveCount(0);
  await expect(page.getByText('refused', { exact: true })).toHaveCount(0);
  up('/api/audit');
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByText('rm -rf /')).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('a filter that shows nothing says so, and is not "Nothing recorded"', async ({ page }) => {
  await portal(page, []);
  await page.goto('/audit');
  await expect(page.getByText('rm -rf /')).toBeVisible();
  await page.getByRole('radio', { name: 'Strangers' }).click();
  await expect(page.getByText('Nothing matches this filter.')).toBeVisible();
  await expect(page.getByText('Nothing recorded')).toHaveCount(0);
});

test('the Projects page offers to read the list again instead of a placeholder for ever', async ({ page }) => {
  const { up } = await portal(page, ['/api/projects']);
  await page.goto('/projects');
  await expect(page.getByRole('alert')).toContainText(FAILED);
  up('/api/projects');
  await page.getByRole('button', { name: 'Try again' }).click();
  // The list shows a project by its name; the folder's path is not drawn (issue #120).
  await expect(page.getByRole('main').getByText('demo', { exact: true })).toBeVisible();
  await expect(page.getByText('/w/demo')).toHaveCount(0);
});

test('Settings → Tools tells a deployment without tool switches from a portal that did not answer', async ({ page }) => {
  const { up } = await portal(page, ['/api/tools']);
  await page.goto('/settings/tools');
  await expect(settingsDialog(page).getByRole('alert')).toContainText(FAILED);
  up('/api/tools');
  await settingsDialog(page).getByRole('button', { name: 'Try again' }).click();
  await expect(settingsDialog(page).getByText('pi-web-access')).toBeVisible();
});

test('Settings → Tools says it as the portal does when tools cannot be switched here', async ({ page }) => {
  await portal(page, []);
  await page.route('**/api/tools', (route) => route.fulfill({ status: 400, json: { error: 'Tools cannot be switched with EXECUTOR=container', code: 'tools-unsupported' } }));
  await page.goto('/settings/tools');
  await expect(settingsDialog(page).getByText('Tools cannot be switched with EXECUTOR=container')).toBeVisible();
  await expect(settingsDialog(page).getByRole('alert')).toHaveCount(0);
});

test('the setup assistant offers to read the providers again', async ({ page }) => {
  // No model can be used, so it opens by itself.
  const { up } = await portal(page, ['/api/providers'], { fresh: true, replies: { '/api/models': { models: [], providers: {} } } });
  await page.goto('/');
  const assistant = page.getByRole('dialog', { name: 'Set up Pithagoras' });
  await expect(assistant.getByRole('alert')).toContainText(FAILED);
  up('/api/providers');
  await assistant.getByRole('button', { name: 'Try again' }).click();
  await expect(assistant.getByRole('alert')).toHaveCount(0);
  await expect(assistant.getByText('llama-swap').first()).toBeVisible();
});

test('an agent whose conversations could not be read does not say that nothing has reached it', async ({ page }) => {
  const { up } = await portal(page, ['/api/agent/sessions']);
  await page.goto('/agents?agent=home');
  await expect(page.getByRole('alert')).toContainText(FAILED);
  await expect(page.getByText('Nothing has reached the agent yet.')).toHaveCount(0);
  up('/api/agent/sessions');
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByText('Nothing has reached the agent yet.')).toBeVisible();
});

test("an agent's files that could not be read say so, and are read again", async ({ page }) => {
  const { up } = await portal(page, ['/api/agents/home/setup']);
  await page.goto('/agents?agent=home');
  await page.getByRole('tab', { name: 'Files' }).click();
  await expect(page.getByRole('alert')).toContainText(FAILED);
  up('/api/agents/home/setup');
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
});
