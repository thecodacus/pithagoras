import { type Locator, type Page } from '@playwright/test';
import { test, expect, mockPortal, reply, HANG } from './portal-mock';
import { DEFAULT_ORB } from '../../server/src/orb-style';
import { unnamed } from './a11y';

/**
 * What a screen reader is told about the controls: that each field, button and slider has a name, and that what opens
 * something says so. Each page is drawn with something in it (a channel, a server, a routine) because an empty page
 * has hardly a field to name.
 */

const channels = {
  channels: [{ id: 'c1', slug: 'tg', kind: 'telegram', name: 'My bot', enabled: true, config: { chatId: '' }, secretsSet: ['botToken'], instructions: '', relayProgress: false, relayTools: false, agentId: 'home', sessionCount: 0, state: 'running', since: null, created_at: '', updated_at: '', log: [], error: null }],
  kinds: [{ id: 'telegram', label: 'Telegram', blurb: 'A bot', fields: [{ key: 'botToken', label: 'Bot token', secret: true, required: true }, { key: 'chatId', label: 'Chat id' }], packageName: 'x', builtin: true, runnable: true }],
  broken: [], agentHome: '/a', channelsDir: '/c',
};
const agent = { id: 'home', name: 'Home', home: '/a', first: true, initialised: true, chats: 0, channels: [], orb: DEFAULT_ORB, voice: '', heartbeat: { minutes: 0, quietStart: '', quietEnd: '', timeZone: 'UTC', last: null, status: null, running: false, watching: false, available: true }, unread: 0 };
const skill = { name: 'review', description: 'Reviews', path: '/s/review', scope: 'user', editable: true, manualOnly: false, broken: false, enabled: true, source: null, content: '---\nname: review\n---\nBody' };
const person = (key: string, name: string, role: string) => ({ key, name, role, notes: '', first_seen: '', last_seen: null, announced_at: null, renamed: 0 });
const mcp = { path: '/a/mcp.json', exists: true, adapterInstalled: true, adapterSpec: 'npm:pi-mcp-adapter', settings: {}, raw: '{}', parseError: null, servers: [{ name: 'notes', entry: { command: 'notes-mcp' }, transport: 'stdio', disabled: false }] };
const extension = { spec: 'npm:ext', name: 'Ext', version: '1', description: '', enabled: true, settings: [{ key: 'apiKey', value: '', configured: false }], skills: [], tools: [] };
const routine = { id: 'r1', slug: 'morning', name: 'Morning', enabled: true, schedule: '0 9 * * *', runAt: null, mode: 'repeats', done: false, instructions: 'Say hello', freshSession: true, guard: true, browser: false, workspace: null, reportChannel: null, reportTarget: null, lastReportAt: null, lastRun: null, lastStatus: null, lastOutput: null, lastMs: null, nextRun: null, createdAt: '' };

async function portal(page: Page) {
  await mockPortal(page, ({ path: p, method }) => {
    if (method !== 'GET') return;
    if (p === '/api/channels') return channels;
    if (p === '/api/agents') return { agents: [agent] };
    if (p === '/api/skills') return { root: '/s', skills: [skill], diagnostics: [] };
    if (p === '/api/people') return { people: [person('tg:o', 'Sam', 'primary'), person('tg:k', 'Kim', 'colleague')] };
    if (p === '/api/tool-rules') return { rules: [] };
    if (p === '/api/mcp') return mcp;
    if (p === '/api/extensions') return { settingsPath: '/a/settings.json', extensions: [extension] };
    if (p === '/api/routines') return { routines: [routine] };
    if (p === '/api/routines/preview') return { runs: [] };
    // A routine's and an agent's own tool switches: the list of checkboxes the page draws, which have to be named too.
    if (p === '/api/routines/r1/tools' || p === '/api/agents/home/tools') {
      return { tools: [{ name: 'bash', source: 'built in', enabled: true, defaultOn: true }, { name: 'notes_search', source: 'notes', enabled: false, defaultOn: true, cached: true }], live: false, off: ['notes_search'], names: {} };
    }
    if (p === '/api/workspaces') return { root: '/w', workspaces: [{ name: 'site', path: '/w/site', isGit: true }] };
    if (p === '/api/projects') return { root: '/w', home: '/h', projects: [{ name: 'site', path: '/w/site', isGit: true, sessions: 0, hasInstructions: false, hasTools: false }] };
    if (p === '/api/pi-settings') return { path: '/a/settings.json', content: '{}' };
    if (p === '/api/agents/home/sessions') return { sessions: [] };
    if (p === '/api/agents/home/setup') return { initialised: true, home: '/a', files: [{ name: 'SOUL.md', content: 'x', exists: true, mtime: 1 }] };
  }, { settings: true });
}

type Scene = { name: string; url: string; open?: (page: Page) => Promise<unknown>; shows: (page: Page) => Locator };
const field = (name: string | RegExp) => (page: Page) => page.getByRole('textbox', { name });
/** Where to go, what to press to get a form or an editor on the page, and what is there to be named when it has come. */
const scenes: Scene[] = [
  { name: 'general settings', url: '/settings/general', shows: (page) => page.getByRole('dialog', { name: 'Settings' }) },
  { name: 'models', url: '/settings/models', shows: (page) => page.getByRole('dialog', { name: 'Settings' }) },
  { name: 'channels', url: '/settings/channels', shows: field('GitHub repo of a channel package') },
  { name: 'a channel', url: '/settings/channels', open: (page) => page.getByRole('button', { name: /My bot/ }).click(), shows: field('Channel name') },
  { name: 'a new channel', url: '/settings/channels', open: (page) => page.getByRole('button', { name: /Telegram/ }).first().click(), shows: field('Bot token') },
  { name: 'people', url: '/settings/people', open: (page) => page.getByRole('button', { name: /Kim/ }).click(), shows: field('Pattern') },
  { name: 'skills', url: '/settings/skills', shows: (page) => page.getByText('review').first() },
  { name: 'a skill', url: '/settings/skills', open: (page) => page.getByRole('button', { name: /review/ }).first().click(), shows: field("The skill's file") },
  { name: 'MCP servers', url: '/settings/mcp', shows: (page) => page.getByText('notes').first() },
  { name: 'an MCP server', url: '/settings/mcp', open: (page) => page.getByRole('button', { name: /notes/ }).first().click(), shows: (page) => page.getByPlaceholder('filesystem', { exact: true }) },
  { name: 'a new MCP server', url: '/settings/mcp', open: (page) => page.getByRole('button', { name: 'Add server' }).click(), shows: (page) => page.getByPlaceholder('filesystem', { exact: true }) },
  { name: 'extensions', url: '/settings/extensions', shows: field('Install by name') },
  { name: 'advanced', url: '/settings/advanced', shows: field('settings.json') },
  { name: 'sessions', url: '/sessions', shows: field(/Search by name/) },
  { name: 'agents', url: '/agents', shows: (page) => page.getByText('Home').first() },
  { name: "an agent's tools", url: '/agents?agent=home&tab=tools', open: (page) => page.getByRole('button', { name: /^notes/ }).click(), shows: (page) => page.getByRole('checkbox').first() },
  { name: 'an agent', url: '/agents?agent=home&tab=files', open: (page) => page.getByRole('button', { name: 'SOUL.md' }).click(), shows: field('SOUL.md') },
  { name: 'routines', url: '/routines', shows: (page) => page.getByText('Morning').first() },
  { name: 'a routine', url: '/routines', open: (page) => page.getByRole('button', { name: /Morning/ }).first().click(), shows: field('Routine name') },
  { name: 'a new routine', url: '/routines', open: (page) => page.getByRole('button', { name: 'New routine' }).click(), shows: field('Schedule') },
  { name: 'browser', url: '/browser', shows: field('Where it may go') },
];
for (const { name, url, open, shows } of scenes) {
  test(`every field and button on ${name} has a name`, async ({ page }) => {
    await portal(page);
    await page.goto(url);
    // The button that opens it waits for the page by itself; and what is named is there before it is looked at.
    if (open) await open(page);
    await expect(shows(page)).toBeVisible();
    expect(await unnamed(page)).toEqual([]);
  });
}

/** A chat with a model, its levels and some use of its context, which has had a message: the composer shows what it has used. */
async function chat(page: Page, answer: Parameters<typeof mockPortal>[1] = () => undefined) {
  const at = new Date().toISOString();
  const model = { id: 'model-a', name: 'Model A', provider: 'llama-swap' };
  const session = { id: 'a', title: 'First chat', workspace: '/w/site', status: 'idle', kind: 'task', pinned: false, updated_at: at, created_at: at, provider: null, model: null, thinking_level: null };
  const config = {
    live: true, state: { model, thinkingLevel: 'medium' }, thinking: { levels: ['off', 'low', 'medium', 'high'] }, models: { models: [model] }, named: { provider: null, model: null },
    stats: { tokens: { input: 1000, output: 500, total: 1500 }, cost: 0.01, contextUsage: { tokens: 1500, contextWindow: 10000, percent: 15 }, toolCalls: 2, totalMessages: 4 },
  };
  await mockPortal(page, async (ask) => {
    const own = await answer(ask);
    if (own !== undefined) return own;
    const { path: p, method } = ask;
    if (method !== 'GET') return;
    if (p === '/api/sessions') return { sessions: [session], executor: 'host' };
    if (p === '/api/sessions/a') return session;
    if (p === '/api/sessions/a/config' || p === '/api/sessions/a/models') return config;
    if (p === '/api/sessions/a/canvases') return [];
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

test('the pills of the composer are named, and say whether what they open is open', async ({ page }) => {
  await chat(page);
  const toolbar = page.locator('.composer-settings');
  const model = toolbar.getByRole('button', { name: 'Model: Model A' });
  await expect(model).toHaveAttribute('aria-haspopup', 'true');
  await expect(model).toHaveAttribute('aria-expanded', 'false');
  await model.click();
  await expect(model).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('group', { name: 'Models' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(model).toHaveAttribute('aria-expanded', 'false');
  const tools = toolbar.getByRole('button', { name: 'Which tools this conversation may use' });
  await expect(tools).toHaveAttribute('aria-haspopup', 'true');
  await expect(toolbar.getByRole('button', { name: /^Context 15/ })).toHaveAttribute('aria-haspopup', 'true');
  expect(await unnamed(page)).toEqual([]);
});

test('the effort slider says the level it is at', async ({ page }) => {
  // A change that is never answered keeps the slider where it was moved to.
  await chat(page, ({ path: p, method }) => (p === '/api/sessions/a/config' && method === 'POST' ? HANG : undefined));
  await page.locator('.composer-settings').getByRole('button', { name: /^Effort: medium/i }).click();
  const slider = page.getByRole('slider', { name: 'Effort' });
  await expect(slider).toHaveAttribute('aria-valuetext', /medium/i);
  await slider.press('Home');
  await expect(slider).toHaveAttribute('aria-valuetext', /off/i);
});

test('a change of effort that was refused says so, and the slider goes back to where it was', async ({ page }) => {
  await chat(page, ({ path: p, method }) => (p === '/api/sessions/a/config' && method === 'POST' ? reply(500, { error: 'The model server is down' }) : undefined));
  await page.locator('.composer-settings').getByRole('button', { name: /^Effort: medium/i }).click();
  const slider = page.getByRole('slider', { name: 'Effort' });
  await slider.press('ArrowRight');
  await expect(page.getByRole('alert')).toContainText('The model server is down');
  await expect(slider).toHaveAttribute('aria-valuetext', /medium/i);
});

test('a button with only a title keeps its name while the tooltip has lifted the title', async ({ page }) => {
  await mockPortal(page);
  await page.goto('/');
  // One of each: an icon with a title, and a button that is named by its text.
  await page.evaluate(() => {
    for (const [id, html, left] of [['icon', '<svg width="16" height="16"></svg>', 300], ['text', 'Save', 400]] as const) {
      const b = document.createElement('button');
      b.id = id;
      b.title = `The ${id} button`;
      b.innerHTML = html;
      b.style.cssText = `position:fixed;top:300px;left:${left}px;width:60px;height:40px`;
      document.body.appendChild(b);
    }
  });
  const icon = page.locator('#icon');
  await expect(icon).toHaveAccessibleName('The icon button');
  await icon.hover();
  // The native tooltip is held back by emptying the title, and the name is what the title said.
  await expect(icon).toHaveAttribute('title', '');
  await expect(icon).toHaveAccessibleName('The icon button');
  await page.mouse.move(700, 100);
  await expect(icon).toHaveAttribute('title', 'The icon button');
  await expect(icon).not.toHaveAttribute('aria-label');
  // A name of its own is not replaced by it.
  await page.locator('#text').hover();
  await expect(page.locator('#text')).toHaveAttribute('title', '');
  await expect(page.locator('#text')).not.toHaveAttribute('aria-label');
});

test('a page that is still loading says so as a status, and a folder says how many chats it holds in words', async ({ page }) => {
  const at = new Date().toISOString();
  const session = (id: string) => ({ id, title: `Chat ${id}`, workspace: '/w/site', status: 'idle', kind: 'task', pinned: false, updated_at: at, created_at: at, provider: null, model: null, thinking_level: null });
  await mockPortal(page, ({ path: p, method }) => {
    if (method !== 'GET') return;
    if (p === '/api/providers') return HANG;
    if (p === '/api/sessions') return { sessions: [session('a'), session('b')], executor: 'host' };
    if (p === '/api/projects') return { root: '/w', home: '/h', projects: [{ name: 'site', path: '/w/site', isGit: true, sessions: 2, hasInstructions: false, hasTools: false }] };
    if (p === '/api/workspaces') return { root: '/w', workspaces: [{ name: 'site', path: '/w/site', isGit: true }] };
  }, { settings: true });
  await page.goto('/sessions');
  // The number is what is seen; what is read is the number with its noun.
  await expect(page.getByRole('main').getByText('2 chats', { exact: true })).toBeAttached();
  await page.goto('/settings/models');
  await expect(page.getByRole('status').filter({ hasText: 'Loading providers' })).toBeAttached();
});
