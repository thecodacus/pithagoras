import { type Page } from '@playwright/test';
import { test, expect, mockPortal, reply } from './portal-mock';

/**
 * Settings → Modes, the modes the person makes: the list, making one, its page (its texts saved with Save, the rest as
 * it is changed, its tools through the same list as a project's), deleting it; and in a chat, the picker that offers
 * them after the portal's own and leads to the page.
 */
interface Mode {
  id: string;
  label: string;
  description: string;
  codemode: boolean;
  instructions: string;
  provider: string | null;
  model: string | null;
  thinkingLevel: string | null;
  createdAt: string;
  updatedAt: string;
}

const CORE = [
  { id: 'standard', label: 'Standard mode', description: 'The agent as this chat would have it anyway: the tools that Settings → Tools, its agent and its project switch on.' },
  { id: 'code', label: 'Code mode', description: "The model works through one tool: it writes a short JavaScript script that calls the chat's tools, and is given only what the script puts out." },
];
const MODELS = {
  models: [
    { provider: 'llama-swap', id: 'model-a', name: 'Model A', reasoning: true },
    { provider: 'llama-swap', id: 'model-b', name: 'Model B', reasoning: true },
  ],
  providers: { 'llama-swap': 'llama-swap' },
};

const mode = (label: string, more: Partial<Mode> = {}): Mode => ({
  id: label.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
  label,
  description: '',
  codemode: false,
  instructions: '',
  provider: null,
  model: null,
  thinkingLevel: null,
  createdAt: '',
  updatedAt: '',
  ...more,
});

interface Portal {
  modes: Mode[];
  /** What each mode has off, by its id: the portal-wide default has the code tool off. */
  off: Record<string, string[]>;
  /** Every write, as `METHOD path` and what it sent. */
  writes: { what: string; body: unknown }[];
  /** How often a mode's tools were read. */
  toolReads: number;
  /** The chat, `a`: its mode and its model. */
  chat: { mode: string | null; model: string | null };
}

async function portal(page: Page, { modes = [] as Mode[], refuse = false } = {}): Promise<Portal> {
  const state: Portal = { modes: [...modes], off: {}, writes: [], toolReads: 0, chat: { mode: null, model: null } };
  const offOf = (id: string) => (state.off[id] ??= ['codemode']);
  const at = new Date().toISOString();
  const session = () => ({ id: 'a', title: 'A chat', workspace: '/w/site', status: 'idle', kind: 'task', pinned: false, updated_at: at, provider: null, model: state.chat.model, thinking_level: null, mode: state.chat.mode });
  const modelOf = () => MODELS.models.find((m) => m.id === (state.chat.model ?? 'model-a'))!;
  await mockPortal(page, async ({ path: p, method, json }) => {
    if (method !== 'GET') state.writes.push({ what: `${method} ${p}`, body: method === 'DELETE' ? undefined : json() });
    if (p === '/api/models') return MODELS;
    if (p.startsWith('/api/chat-modes') && refuse) {
      return reply(400, { error: 'Tools cannot be switched with EXECUTOR=container: pi runs inside the container and the portal never sees what it registered', code: 'tools-unsupported' });
    }
    if (p === '/api/chat-modes' && method === 'GET') return { modes: [...state.modes].sort((x, y) => x.label.localeCompare(y.label)) };
    if (p === '/api/chat-modes' && method === 'POST') {
      const made = mode(json().label, { description: json().description });
      state.modes.push(made);
      return made;
    }
    const one = /^\/api\/chat-modes\/([^/]+)$/.exec(p);
    if (one && method === 'PUT') {
      const i = state.modes.findIndex((m) => m.id === one[1]);
      state.modes[i] = { ...state.modes[i], ...json() };
      // As the server does: the mode works through the code tool, so it has it on; and not, it has it as the default (off).
      if (json().codemode !== undefined) state.off[one[1]] = [...offOf(one[1]).filter((name) => name !== 'codemode'), ...(json().codemode ? [] : ['codemode'])];
      return state.modes[i];
    }
    if (one && method === 'DELETE') {
      state.modes = state.modes.filter((m) => m.id !== one[1]);
      return { ok: true };
    }
    const tools = /^\/api\/chat-modes\/([^/]+)\/tools$/.exec(p);
    if (tools && method === 'GET') {
      state.toolReads++;
      const off = offOf(tools[1]);
      return {
        live: false,
        off,
        names: {},
        tools: [
          { name: 'codemode', source: 'pithagoras', inline: true, enabled: !off.includes('codemode'), defaultOn: false },
          { name: 'web_search', source: 'pi-web-access', enabled: !off.includes('web_search'), defaultOn: true },
        ],
      };
    }
    if (tools && method === 'PUT') {
      state.off[tools[1]] = json().off;
      return { off: json().off, applied: 0 };
    }
    // The chat the picker is in.
    if (p === '/api/sessions') return { sessions: [session()], executor: 'host' };
    if (p === '/api/sessions/a') return session();
    if (p === '/api/sessions/a/modes' && method === 'GET') {
      return { modes: [...CORE, ...[...state.modes].sort((x, y) => x.label.localeCompare(y.label)).map((m) => ({ id: `custom/${m.id}`, label: m.label, description: m.description }))] };
    }
    if (p === '/api/sessions/a/modes' && method === 'PUT') {
      const chosen = state.modes.find((m) => `custom/${m.id}` === json().mode);
      state.chat = { mode: json().mode === 'standard' ? null : json().mode, model: chosen?.model ?? null };
      return { mode: json().mode };
    }
    if (p === '/api/sessions/a/config' || p === '/api/sessions/a/models') {
      const model = modelOf();
      return {
        live: false, state: { model: { id: model.id, name: model.name, provider: 'llama-swap' }, thinkingLevel: 'medium' }, stats: null,
        thinking: { levels: ['off', 'medium'] }, models: { models: [] }, named: { provider: null, model: null },
      };
    }
  }, { settings: true, streams: 'open' });
  await page.addInitScript(() => localStorage.removeItem('toolGroupsOpen'));
  return state;
}

const dialog = (page: Page) => page.getByRole('dialog', { name: 'Settings' });
const writes = (state: Portal) => state.writes.map(({ what, body }) => (body === undefined ? what : `${what} ${JSON.stringify(body)}`));

test('a mode is made, its texts saved, its code tool, model and tools switched as they are changed, and it is deleted after asking', async ({ page }) => {
  const state = await portal(page, { modes: [mode('Research', { description: 'Reads first' })] });
  await page.goto('/settings/modes');
  await expect(dialog(page).getByRole('button', { name: /^Research/ })).toContainText('Reads first');

  await dialog(page).getByRole('button', { name: 'New mode' }).click();
  await dialog(page).getByLabel('Name').fill('Focus');
  await dialog(page).getByLabel('Description').fill('One thing at a time');
  await dialog(page).getByRole('button', { name: 'Create' }).click();
  await expect(dialog(page).getByLabel('Name')).toHaveValue('Focus');
  expect(writes(state)).toEqual(['POST /api/chat-modes {"label":"Focus","description":"One thing at a time"}']);

  const save = dialog(page).getByRole('button', { name: 'Save' });
  await expect(save).toBeDisabled();
  await dialog(page).getByLabel('Instructions').fill('Answer briefly.');
  await save.click();
  await expect(dialog(page).getByRole('button', { name: 'Saved' })).toBeVisible();
  expect(writes(state).at(-1)).toBe('PUT /api/chat-modes/focus {"label":"Focus","description":"One thing at a time","instructions":"Answer briefly."}');

  // The tools are read again once the switch is saved, and the code tool is on in them then.
  await dialog(page).getByRole('button', { name: /^Code mode/ }).click();
  await expect(dialog(page).getByRole('checkbox', { name: 'codemode' })).not.toBeChecked();
  const reads = state.toolReads;
  await dialog(page).getByRole('switch', { name: 'Work through the code tool' }).click();
  await expect(dialog(page).getByRole('switch', { name: 'Work through the code tool' })).toHaveAttribute('aria-checked', 'true');
  expect(writes(state).at(-1)).toBe('PUT /api/chat-modes/focus {"codemode":true}');
  await expect(dialog(page).getByRole('checkbox', { name: 'codemode' })).toBeChecked();
  expect(state.toolReads).toBeGreaterThan(reads);
  // And switched off, the code tool is off in them again.
  await dialog(page).getByRole('switch', { name: 'Work through the code tool' }).click();
  expect(writes(state).at(-1)).toBe('PUT /api/chat-modes/focus {"codemode":false}');
  await expect(dialog(page).getByRole('checkbox', { name: 'codemode' })).not.toBeChecked();

  await expect(dialog(page).getByRole('combobox', { name: 'Provider for this mode' })).toContainText('As the chat would have it');
  await dialog(page).getByRole('combobox', { name: 'Model for this mode' }).click();
  await page.getByRole('option', { name: /^Model B/ }).click();
  await expect(dialog(page).getByRole('combobox', { name: 'Model for this mode' })).toContainText('Model B');
  expect(writes(state).at(-1)).toBe('PUT /api/chat-modes/focus {"provider":null,"model":"model-b"}');
  await dialog(page).getByRole('radiogroup', { name: 'Effort for this mode' }).getByRole('radio').first().click();
  await expect.poll(() => writes(state).at(-1)).toMatch(/^PUT \/api\/chat-modes\/focus \{"thinkingLevel":"\w+"\}$/);

  await dialog(page).getByRole('button', { name: /^pi-web-access/ }).click();
  await dialog(page).getByRole('checkbox', { name: 'web_search' }).uncheck();
  await expect.poll(() => writes(state).at(-1)).toBe('PUT /api/chat-modes/focus/tools {"off":["codemode","web_search"]}');
  await expect(dialog(page).getByText('what every chat in this mode starts with')).toBeVisible();

  await dialog(page).getByRole('button', { name: 'Delete' }).click();
  const asked = page.getByRole('alertdialog');
  await expect(asked).toContainText('Delete Focus?');
  await expect(asked).toContainText('Chats in it keep it, shown as not available');
  await asked.getByRole('button', { name: 'Delete' }).click();
  await expect(dialog(page).getByRole('button', { name: /^Research/ })).toBeVisible();
  await expect(dialog(page).getByRole('button', { name: /^Focus/ })).toHaveCount(0);
  expect(writes(state).at(-1)).toBe('DELETE /api/chat-modes/focus');
});

test('a provider chosen without a model says that a model is needed too, until one is chosen', async ({ page }) => {
  const state = await portal(page, { modes: [mode('Research')] });
  await page.goto('/settings/modes');
  await dialog(page).getByRole('button', { name: /^Research/ }).click();
  const needed = dialog(page).getByText('Choose a model too: a provider alone is not written into a chat.');
  await expect(dialog(page).getByRole('combobox', { name: 'Model for this mode' })).toContainText('As the chat would have it');
  await expect(needed).toHaveCount(0);
  await dialog(page).getByRole('combobox', { name: 'Provider for this mode' }).click();
  await page.getByRole('option', { name: /^llama-swap/ }).click();
  await expect.poll(() => writes(state).at(-1)).toBe('PUT /api/chat-modes/research {"provider":"llama-swap","model":null}');
  await expect(needed).toBeVisible();
  await dialog(page).getByRole('combobox', { name: 'Model for this mode' }).click();
  await page.getByRole('option', { name: /^Model B/ }).click();
  await expect.poll(() => writes(state).at(-1)).toBe('PUT /api/chat-modes/research {"provider":"llama-swap","model":"model-b"}');
  await expect(needed).toHaveCount(0);
});

test('a text the server refuses is said, and the page keeps what was typed', async ({ page }) => {
  await portal(page, { modes: [mode('Research')] });
  await page.route('**/api/chat-modes/research', (route) =>
    route.request().method() === 'PUT' ? route.fulfill({ status: 400, json: { error: "A mode's name can be at most 60 characters." } }) : route.fallback(),
  );
  await page.goto('/settings/modes');
  await dialog(page).getByRole('button', { name: /^Research/ }).click();
  await dialog(page).getByLabel('Name').fill('x'.repeat(70));
  await dialog(page).getByRole('button', { name: 'Save' }).click();
  await expect(dialog(page).getByRole('alert')).toContainText("A mode's name can be at most 60 characters.");
  await expect(dialog(page).getByLabel('Name')).toHaveValue('x'.repeat(70));
});

test('a portal that cannot switch tools says so in place of the modes', async ({ page }) => {
  await portal(page, { refuse: true });
  await page.goto('/settings/modes');
  await expect(dialog(page).getByText('Tools cannot be switched with EXECUTOR=container', { exact: false })).toBeVisible();
  await expect(dialog(page).getByRole('button', { name: 'New mode' })).toHaveCount(0);
});

test('Settings → Modes speaks German, and is found by the search', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('pithagoras.language', 'de'));
  await portal(page);
  const german = page.getByRole('dialog', { name: 'Einstellungen' });
  await page.goto('/settings/general');
  await german.getByLabel('Einstellungen durchsuchen').fill('anweisungen');
  await german.getByRole('option').first().click();
  await expect(german.getByText('Noch keine eigenen Modi.')).toBeVisible();
  await expect(german.getByText('Deine Modi stehen über dem Nachrichtenfeld eines neuen Chats zur Wahl', { exact: false })).toBeVisible();
  await german.getByRole('button', { name: 'Neuer Modus' }).click();
  await german.getByLabel('Name').fill('Fokus');
  await german.getByRole('button', { name: 'Erstellen' }).click();
  await expect(german.getByRole('switch', { name: 'Über das Code-Tool arbeiten' })).toBeVisible();
  await expect(german.getByRole('combobox', { name: 'Modell für diesen Modus' })).toContainText('Wie der Chat es ohnehin hätte');
  await expect(german.getByText('Wird in einen Chat übernommen, wenn er diesen Modus bekommt', { exact: false })).toBeVisible();
});

test('a chat offers your modes after the portal\'s, leads to Settings → Modes, lists one made there, and a mode with a model puts the chat on it', async ({ page }) => {
  const state = await portal(page, { modes: [mode('Research', { description: 'Reads first' })] });
  await page.addInitScript(() => localStorage.setItem('sidebarCollapsed', 'true'));
  await page.goto('/s/a');
  await expect.poll(() => page.evaluate(() => (window as any).streams.some((s: any) => !s.closed))).toBe(true);
  await page.evaluate(() => (window as any).streams.find((s: any) => !s.closed).emit('caught-up', { seq: 0 }));

  const chip = page.getByRole('button', { name: /^Mode: / });
  const menu = page.getByRole('menu', { name: 'Modes' });
  await chip.click();
  await expect(menu.getByRole('menuitemradio')).toHaveText([/^Standard mode/, /^Code mode/, /^Research/]);
  await menu.getByRole('menuitem', { name: 'New mode…' }).click();
  await expect(page).toHaveURL(/\/s\/a\/settings\/modes$/);

  await dialog(page).getByRole('button', { name: 'New mode' }).click();
  await dialog(page).getByLabel('Name').fill('Brief');
  await dialog(page).getByRole('button', { name: 'Create' }).click();
  await dialog(page).getByRole('combobox', { name: 'Model for this mode' }).click();
  await page.getByRole('option', { name: /^Model B/ }).click();
  await expect.poll(() => state.modes.find((m) => m.id === 'brief')?.model).toBe('model-b');
  await dialog(page).getByRole('button', { name: 'Close' }).click();
  await expect(page).toHaveURL(/\/s\/a$/);

  await expect(page.getByRole('button', { name: 'Model: Model A' })).toBeVisible();
  await chip.click();
  await expect(menu.getByRole('menuitemradio')).toHaveText([/^Standard mode/, /^Code mode/, /^Brief/, /^Research/]);
  await menu.getByRole('menuitemradio', { name: /^Brief/ }).click();
  await expect(chip).toHaveText('Brief');
  // The mode wrote its model into the chat: the pill under the box says so.
  await expect(page.getByRole('button', { name: 'Model: Model B' })).toBeVisible();
});
