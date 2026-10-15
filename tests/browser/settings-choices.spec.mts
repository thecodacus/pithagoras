import { type Page } from '@playwright/test';
import { test, expect, mockPortal } from './portal-mock';
import { DEFAULT_ORB } from '../../core/server/src/orb-style';

/**
 * What the Settings pages and the audit page say to a screen reader about their
 * choices and switches: which one holds, and whether a switch is on. Over canned answers.
 */
async function portal(page: Page, answers: Record<string, unknown>) {
  await mockPortal(page, ({ path }) => answers[path], { settings: true });
}

const entry = (id: number, kind: string) => ({ id, at: '2026-10-01T09:00:00Z', kind, tool: 'bash', subject: 'rm -rf x', reason: 'on the list', person_key: null, person_name: null, session_id: null });

test('the audit page\'s filter is a radio group, and the one that holds is checked', async ({ page }) => {
  await portal(page, { '/api/audit': { entries: [entry(1, 'refused'), entry(2, 'allowed-by-rule')] } });
  await page.goto('/audit');
  const filter = page.getByRole('radiogroup', { name: 'Which decisions to show' });
  await expect(filter.getByRole('radio', { name: 'Everything' })).toHaveAttribute('aria-checked', 'true');
  await expect(filter.getByRole('radio', { name: 'Refused' })).toHaveAttribute('aria-checked', 'false');
  await filter.getByRole('radio', { name: 'Refused' }).click();
  await expect(filter.getByRole('radio', { name: 'Refused' })).toHaveAttribute('aria-checked', 'true');
  await expect(filter.getByRole('radio', { name: 'Everything' })).toHaveAttribute('aria-checked', 'false');
});

test('the transport of an MCP server is a radio group', async ({ page }) => {
  await portal(page, { '/api/mcp': { path: '/a/mcp.json', exists: true, adapterInstalled: true, adapterSpec: 'npm:pi-mcp-adapter', servers: [], settings: {}, raw: '{}', parseError: null } });
  await page.goto('/settings/mcp');
  await page.getByRole('dialog', { name: 'Settings' }).getByRole('button', { name: 'Add server' }).click();
  const transport = page.getByRole('radiogroup', { name: 'Transport' });
  // Named by what it is, not also by the label around it.
  await expect(transport.getByRole('radio', { name: 'Local process', exact: true })).toHaveAttribute('aria-checked', 'true');
  await transport.getByRole('radio', { name: 'HTTP' }).click();
  await expect(transport.getByRole('radio', { name: 'HTTP' })).toHaveAttribute('aria-checked', 'true');
  await expect(transport.getByRole('radio', { name: 'Local process' })).toHaveAttribute('aria-checked', 'false');
  // A click on the word "Transport" is not a click on the first choice.
  await page.getByText('Transport', { exact: true }).click();
  await expect(transport.getByRole('radio', { name: 'HTTP' })).toHaveAttribute('aria-checked', 'true');
});

const SKILL = { name: 'notes', description: 'Take notes', path: '/agent/skills/notes/SKILL.md', scope: 'user', editable: true, manualOnly: false, broken: false, enabled: true, source: null, content: '---\nname: notes\n---\nTake notes.' };

test('a skill\'s switch says which skill it switches and whether it is on, in the list and in the skill', async ({ page }) => {
  await portal(page, { '/api/skills': { root: '/agent/skills', skills: [SKILL], diagnostics: [] } });
  await page.goto('/settings/skills');
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await expect(dialog.getByRole('switch', { name: 'notes' })).toHaveAttribute('aria-checked', 'true');
  await dialog.getByRole('button', { name: /Take notes/ }).click();
  await expect(dialog.getByRole('switch', { name: 'notes' })).toHaveAttribute('aria-checked', 'true');
});

test('the skills an import will take are ticked boxes that say so', async ({ page }) => {
  await portal(page, {
    '/api/skills': { root: '/agent/skills', skills: [], diagnostics: [] },
    '/api/skills/preview-import': { spec: 'team/skills', sha: 'a'.repeat(40), found: [{ name: 'pdf', description: 'Read a PDF', installed: false, from: 'skills/pdf' }, { name: 'xls', description: 'Read a sheet', installed: false, from: 'skills/xls' }], skipped: [] },
  });
  await page.goto('/settings/skills');
  await page.getByRole('button', { name: 'Import from GitHub' }).click();
  await page.getByPlaceholder('anthropics/skills').fill('team/skills');
  await page.getByRole('button', { name: 'Look' }).click();
  const pdf = page.getByRole('checkbox', { name: /pdf/ });
  const xls = page.getByRole('checkbox', { name: /xls/ });
  // Everything found is ticked to begin with.
  await expect(pdf).toHaveAttribute('aria-checked', 'true');
  await xls.click();
  await expect(xls).toHaveAttribute('aria-checked', 'false');
  await expect(pdf).toHaveAttribute('aria-checked', 'true');
  // The empty box has an edge in the theme's own colour, which is not white.
  await expect(xls.locator('span').first()).not.toHaveClass(/border-white/);
});

const CHANNEL = {
  id: 'c1', slug: 'ops', kind: 'bot', name: 'Ops bot', enabled: true, config: {}, secretsSet: [], instructions: '', relayProgress: true, relayTools: false,
  agentId: 'home', sessionCount: 0, state: 'running', log: [], created_at: '', updated_at: '1',
};

test('a channel\'s switches say what they switch and whether they are on, and the kind being added is pressed', async ({ page }) => {
  await portal(page, {
    '/api/channels': { channels: [CHANNEL], kinds: [{ id: 'bot', label: 'Chat bot', blurb: 'A bot', fields: [], packageName: 'pi-bot', builtin: true, runnable: true }], broken: [], channelsDir: '/a/channels' },
    '/api/agents': { agents: [{ id: 'home', name: 'Home', home: '/a', first: true, initialised: true, chats: 0, channels: [], orb: {}, voice: '', unread: 0 }] },
  });
  await page.goto('/settings/channels');
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  const add = dialog.getByRole('button', { name: 'Chat bot', exact: true });
  await expect(add).toHaveAttribute('aria-pressed', 'false');
  await add.click();
  await expect(add).toHaveAttribute('aria-pressed', 'true');

  await dialog.getByRole('button', { name: /Ops bot/ }).click();
  await expect(dialog.getByRole('switch', { name: 'Ops bot' })).toHaveAttribute('aria-checked', 'true');
  await expect(dialog.getByRole('switch', { name: /^Progress/ })).toHaveAttribute('aria-checked', 'true');
  await expect(dialog.getByRole('switch', { name: /^Tool activity/ })).toHaveAttribute('aria-checked', 'false');
  await dialog.getByRole('switch', { name: /^Tool activity/ }).click();
  await expect(dialog.getByRole('switch', { name: /^Tool activity/ })).toHaveAttribute('aria-checked', 'true');
});

test('the auto-compact switch in the context card says it is a switch, and its state', async ({ page }) => {
  const at = new Date().toISOString();
  const chat = { id: 'a', title: 'First chat', workspace: '/w/site', status: 'idle', kind: 'task', pinned: false, updated_at: at, provider: 'p', model: 'M', thinking_level: null };
  const config = {
    live: true, state: { model: { id: 'M', name: 'M', provider: 'p' }, thinkingLevel: 'medium', autoCompactionEnabled: true }, thinking: { levels: ['off', 'medium'] },
    models: { models: [{ id: 'M', name: 'M', provider: 'p' }] }, named: { provider: 'p', model: 'M' },
    stats: { tokens: { input: 10, output: 5, total: 15 }, cost: 0, contextUsage: { tokens: 1000, contextWindow: 65536, percent: 1.5 }, toolCalls: 0, totalMessages: 2 },
  };
  await portal(page, {
    '/api/sessions': { sessions: [chat], executor: 'host' },
    '/api/sessions/a': chat,
    '/api/sessions/a/config': config,
    '/api/sessions/a/models': config,
    '/api/workspaces': { root: '/w', workspaces: [] },
    '/api/models': { models: [], providers: {} },
  });
  // One message said, so that the chat has started and shows its context.
  await page.addInitScript(() => {
    (window as any).EventSource = class {
      onmessage: any; onopen: any; onerror: any; listeners: Record<string, ((e: any) => void)[]> = {};
      constructor() {
        setTimeout(() => {
          this.onopen?.();
          this.onmessage?.({ data: JSON.stringify({ seq: 1, type: 'portal_prompt', payload: { message: 'Hello there' } }) });
          (this.listeners['caught-up'] ?? []).forEach((fn) => fn({ data: JSON.stringify({ seq: 1 }) }));
        }, 0);
      }
      addEventListener(name: string, fn: (e: any) => void) { (this.listeners[name] ??= []).push(fn); }
      close() {}
    };
  });
  await page.goto('/s/a');
  await page.getByTitle(/^Context 1\.5% full/).click();
  const auto = page.getByRole('switch', { name: /^Auto-compact/ });
  await expect(auto).toHaveAttribute('aria-checked', 'true');
});

test('the fields of a heartbeat are the sizes they were written for: 8rem for the hours, the short height for the command', async ({ page }) => {
  const heartbeat = { minutes: 30, quietStart: '22:00', quietEnd: '07:00', timeZone: 'Europe/Berlin', last: null, status: null, running: false, watching: false, available: true };
  await portal(page, {
    '/api/agents': { agents: [{ id: 'home', name: 'Nova', home: '/a', first: true, initialised: true, chats: 0, channels: [], orb: DEFAULT_ORB, voice: '', unread: 0, heartbeat }] },
    '/api/agents/home/setup': { initialised: true, home: '/a', files: [] },
    '/api/agent/sessions': { sessions: [], agentHome: '/a' },
    '/api/tool-rules': { rules: [] },
  });
  await page.goto('/agents?agent=home&tab=heartbeat');
  const from = page.getByLabel('Quiet from');
  await expect(from).toHaveValue('22:00');
  // Classes appended to the shared field's own do not win over it: `w-32` and `py-1.5` were both lost.
  expect((await from.boundingBox())!.width).toBeCloseTo(128, 0);
  expect((await page.getByLabel('Quiet until').boundingBox())!.width).toBeCloseTo(128, 0);
  // Text of 12px on a 16px line, 6px above and below, and the border: 30px, not the 34px of a roomy field.
  expect((await page.getByLabel('Command it may run').boundingBox())!.height).toBeCloseTo(30, 0);
});

test('the quiet hours of a heartbeat say whose clock they are on', async ({ page }) => {
  const heartbeat = { minutes: 30, quietStart: '22:00', quietEnd: '07:00', timeZone: 'Pacific/Auckland', last: null, status: null, running: false, watching: false, available: true };
  await portal(page, {
    '/api/agents': { agents: [{ id: 'home', name: 'Nova', home: '/a', first: true, initialised: true, chats: 0, channels: [], orb: DEFAULT_ORB, voice: '', unread: 0, heartbeat }] },
    '/api/agents/home/setup': { initialised: true, home: '/a', files: [] },
    '/api/agent/sessions': { sessions: [], agentHome: '/a' },
    '/api/tool-rules': { rules: [] },
  });
  await page.goto('/agents?agent=home&tab=heartbeat');
  // The inputs are filled in the browser's own time, so the page has to say that the server reads them on another.
  await expect(page.getByText('the portal\'s time (Pacific/Auckland)')).toBeVisible();
});

test('switching a channel on or off does not take back what was typed in it and not yet saved', async ({ page }) => {
  const channel = { ...CHANNEL };
  const patches: unknown[] = [];
  await portal(page, {
    '/api/channels': { channels: [channel], kinds: [{ id: 'bot', label: 'Chat bot', blurb: 'A bot', fields: [], packageName: 'pi-bot', builtin: true, runnable: true }], broken: [], channelsDir: '/a/channels' },
    '/api/agents': { agents: [{ id: 'home', name: 'Home', home: '/a', first: true, initialised: true, chats: 0, channels: [], orb: DEFAULT_ORB, voice: '', unread: 0 }] },
  });
  // A save answers with the channel as it is now, stamped as changed, and the list does too.
  await page.route('**/api/channels/c1', async (route) => {
    const body = route.request().postDataJSON();
    patches.push(body);
    Object.assign(channel, body, { updated_at: String(Date.now()) });
    await route.fulfill({ json: channel });
  });
  await page.goto('/settings/channels');
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await dialog.getByRole('button', { name: /Ops bot/ }).click();
  const name = dialog.getByRole('textbox').first();
  await name.fill('Ops bot, renamed');
  const save = dialog.getByRole('button', { name: 'Save', exact: true });
  await expect(save).toBeEnabled();
  await dialog.getByRole('switch', { name: 'Ops bot' }).click();
  await expect.poll(() => patches.length).toBe(1);
  expect(patches[0]).toEqual({ enabled: false });
  await expect(dialog.getByRole('switch', { name: 'Ops bot' })).toHaveAttribute('aria-checked', 'false');
  await expect(name).toHaveValue('Ops bot, renamed');
  await expect(save).toBeEnabled();
});

test('removing an MCP server or an installed package asks first, and names it', async ({ page }) => {
  const deleted: string[] = [];
  const mcp = { path: '/a/mcp.json', exists: true, adapterInstalled: true, adapterSpec: 'npm:pi-mcp-adapter', servers: [{ name: 'files', entry: { command: 'npx' }, transport: 'stdio', disabled: false }], settings: {}, raw: '{}', parseError: null };
  await portal(page, {
    '/api/mcp': mcp,
    '/api/extensions': { settingsPath: '/a/settings.json', extensions: [{ spec: 'npm:pi-notes', name: 'pi-notes', settings: [], enabled: true, scope: 'user' }] },
  });
  await page.route('**/api/mcp/servers/files', async (route) => {
    deleted.push(`${route.request().method()} mcp files`);
    await route.fulfill({ json: { ok: true } });
  });
  await page.route('**/api/packages', async (route) => {
    if (route.request().method() === 'DELETE') deleted.push(`DELETE package ${route.request().postDataJSON().spec}`);
    await route.fulfill({ json: { ok: true, output: '' } });
  });
  await page.goto('/settings/mcp');
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await dialog.getByRole('button', { name: 'Remove files' }).click();
  const ask = page.getByRole('alertdialog', { name: 'Remove files?' });
  await expect(ask).toContainText('There is no undo');
  await ask.getByRole('button', { name: 'Cancel' }).click();
  expect(deleted).toEqual([]);
  await dialog.getByRole('button', { name: 'Remove files' }).click();
  await ask.getByRole('button', { name: 'Remove' }).click();
  await expect.poll(() => deleted).toEqual(['DELETE mcp files']);

  await page.goto('/settings/extensions');
  await dialog.getByRole('button', { name: 'Remove pi-notes' }).click();
  const askPackage = page.getByRole('alertdialog', { name: 'Remove pi-notes?' });
  await askPackage.getByRole('button', { name: 'Cancel' }).click();
  expect(deleted).toEqual(['DELETE mcp files']);
  await dialog.getByRole('button', { name: 'Remove pi-notes' }).click();
  await askPackage.getByRole('button', { name: 'Remove' }).click();
  await expect.poll(() => deleted).toEqual(['DELETE mcp files', 'DELETE package npm:pi-notes']);
});

/** The MCP file as the page reads it: the servers, the adapter's settings and the text of the file, which a change of either rewrites. */
function mcpFile(servers: { name: string; disabled: boolean }[], settings: Record<string, unknown> = {}) {
  const raw = () => JSON.stringify({ mcpServers: Object.fromEntries(servers.map((s) => [s.name, { command: 'npx', ...(s.disabled ? { disabled: true } : {}) }])), settings }, null, 2) + '\n';
  return {
    servers, settings,
    view: () => ({ path: '/a/mcp.json', exists: true, adapterInstalled: true, adapterSpec: 'npm:pi-mcp-adapter', settings, raw: raw(), parseError: null, servers: servers.map((s) => ({ name: s.name, entry: { command: 'npx' }, transport: 'stdio', disabled: s.disabled })) }),
  };
}

test('the raw editor follows the file when the list above rewrites it, so saving it does not undo that', async ({ page }) => {
  const file = mcpFile([{ name: 'files', disabled: false }]);
  await portal(page, {});
  await page.route('**/api/mcp', (route) => route.fulfill({ json: file.view() }));
  await page.route('**/api/mcp/servers/files', (route) => {
    file.servers[0].disabled = route.request().postDataJSON().entry.disabled === true;
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto('/settings/mcp');
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await dialog.getByRole('button', { name: 'Edit the file directly' }).click();
  const raw = dialog.getByRole('textbox').last();
  await expect(raw).not.toHaveValue(/disabled/);
  // The server is switched off in the list: the file says so, and so does the editor.
  await dialog.getByRole('checkbox', { name: 'On' }).click();
  await expect(raw).toHaveValue(/"disabled": true/);
});

test('adapter settings that could not be saved stay to be saved again', async ({ page }) => {
  const file = mcpFile([]);
  const saves: unknown[] = [];
  await portal(page, {});
  await page.route('**/api/mcp', (route) => route.fulfill({ json: file.view() }));
  await page.route('**/api/mcp/settings', (route) => {
    saves.push(route.request().postDataJSON());
    return route.fulfill({ status: 500, json: { error: 'The file is read-only' } });
  });
  await page.goto('/settings/mcp');
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await dialog.getByPlaceholder('10').fill('5');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => saves.length).toBe(1);
  await expect(dialog.getByRole('alert')).toContainText('The file is read-only');
  // Still there to be tried again, with what was typed.
  await expect(dialog.getByRole('button', { name: 'Save', exact: true })).toBeVisible();
  await expect(dialog.getByPlaceholder('10')).toHaveValue('5');
});
