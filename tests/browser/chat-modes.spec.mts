import { type Page } from '@playwright/test';
import { test, expect, mockPortal, reply } from './portal-mock';

/**
 * Chat modes: the picker above the message box of a chat that has said nothing, what choosing a mode sends, what a
 * first message waits for, the mode in the header once the chat has started, and the code tool in the tools of a chat
 * in Code mode, which its switch cannot turn off.
 */
const MODES = [
  { id: 'standard', label: 'Standard mode', description: 'The agent as this chat would have it anyway: the tools that Settings → Tools, its agent and its project switch on.' },
  { id: 'code', label: 'Code mode', description: "The model works through one tool: it writes a short JavaScript script that calls the chat's tools, and is given only what the script puts out." },
];
const config = {
  live: false, state: { model: { id: 'model-a', name: 'Model A', provider: 'llama-swap' }, thinkingLevel: 'medium' }, stats: null,
  thinking: { levels: ['off', 'medium'] }, models: { models: [] }, named: { provider: null, model: null },
};

interface Portal {
  /** What each PUT of the mode sent. */
  puts: unknown[];
  /** What each message sent. */
  prompts: string[];
  /** Holds the PUT's answer until it is settled. */
  hold: Promise<void> | null;
  /** The PUT fails with this. */
  fail: string | null;
  /** What each PUT of the chat's tools sent. */
  toolPuts: string[][];
  /** The PUT of the tools is refused with this. */
  toolsFail: unknown;
}

/**
 * A chat, `a`, in the stored `mode`, with a message in it where it has `said` something, offered `modes`; and another,
 * `b`, in Standard, that has said nothing.
 */
async function portal(page: Page, { mode = null as string | null, said = false, modes = MODES } = {}): Promise<Portal> {
  const state: Portal & { mode: string | null; off: string[] } = { puts: [], prompts: [], hold: null, fail: null, toolPuts: [], toolsFail: null, mode, off: [] };
  const at = new Date().toISOString();
  const session = (id: string) => ({
    id, title: id === 'a' ? 'A chat' : 'Another chat', workspace: '/w/site', status: 'idle', kind: 'task', pinned: false, updated_at: at,
    provider: null, model: null, thinking_level: null, mode: id === 'a' ? state.mode : null,
  });
  await mockPortal(page, async ({ path: p, method, json }) => {
    if (p === '/api/sessions') return { sessions: [session('a'), session('b')], executor: 'host' };
    if (p === '/api/workspaces') return { root: '/w', workspaces: [] };
    if (p === '/api/models') return { models: [], providers: {} };
    const [, id, rest = ''] = /^\/api\/sessions\/([ab])(\/.*)?$/.exec(p) ?? [];
    if (!id) return undefined;
    if (!rest) return session(id);
    if (rest === '/modes' && method === 'GET') return { modes };
    if (rest === '/modes' && method === 'PUT') {
      const { mode: chosen } = json();
      state.puts.push(json());
      await state.hold;
      if (state.fail) return reply(409, { error: state.fail });
      if (id === 'a') state.mode = chosen === 'standard' ? null : chosen;
      return { mode: chosen };
    }
    if (rest === '/prompt') {
      state.prompts.push(json().message);
      return { ok: true };
    }
    if (rest === '/config' || rest === '/models') return config;
    if (rest === '/tools' && method === 'PUT') {
      state.toolPuts.push(json().off);
      if (state.toolsFail) return reply(409, state.toolsFail);
      state.off = json().off;
      return { off: state.off };
    }
    // The code tool on, as Code mode has it; held there, as the server says of a mode that switches it on.
    if (rest === '/tools') return { live: false, off: state.off, names: {}, tools: [
      { name: 'bash', source: 'built in', enabled: !state.off.includes('bash'), defaultOn: true },
      { name: 'codemode', source: 'codemode', inline: true, enabled: !state.off.includes('codemode'), defaultOn: true, ...(id === 'a' && state.mode === 'code' ? { byMode: true } : {}) },
    ] };
  }, { streams: 'open', settings: true });
  // Out of the way, so the sidebar's chat is not what the test reaches for.
  await page.addInitScript(() => localStorage.setItem('sidebarCollapsed', 'true'));
  await page.goto('/s/a');
  await expect.poll(() => page.evaluate(() => (window as any).streams.some((s: any) => !s.closed))).toBe(true);
  await page.evaluate((said) => {
    const s = (window as any).streams.find((s: any) => !s.closed);
    if (said) s.emit('message', { seq: 1, type: 'portal_prompt', payload: { message: 'Hello there' } });
    s.emit('caught-up', { seq: said ? 1 : 0 });
  }, said);
  return state;
}

/** Held until the returned function is called. */
function held(): [Promise<void>, () => void] {
  let release!: () => void;
  return [new Promise<void>((resolve) => (release = resolve)), () => release()];
}

const chip = (page: Page) => page.getByRole('button', { name: /^Mode: / });
const menu = (page: Page) => page.getByRole('menu', { name: 'Modes' });
const row = (page: Page, label: string) => menu(page).getByRole('menuitemradio', { name: new RegExp(`^${label}`) });
const box = (page: Page) => page.getByLabel('Message', { exact: true });

test('a new chat offers Standard, chosen, and Code mode, each with its whole line; choosing Standard again is no change', async ({ page }) => {
  const state = await portal(page);
  await expect(chip(page)).toHaveText('Standard mode');
  await expect(chip(page)).toHaveAccessibleName('Mode: Standard mode');
  await expect(chip(page)).toHaveAttribute('aria-haspopup', 'menu');
  await chip(page).click();
  await expect(chip(page)).toHaveAttribute('aria-expanded', 'true');
  await expect(menu(page).getByText('How this chat works. It is fixed once the chat has started.')).toBeVisible();
  await expect(row(page, 'Standard mode')).toHaveAttribute('aria-checked', 'true');
  await expect(row(page, 'Code mode')).toHaveAttribute('aria-checked', 'false');
  for (const mode of MODES) {
    const line = menu(page).getByText(mode.description, { exact: true });
    await expect(line).toBeVisible();
    // Wrapped, not cut: the line is as wide as it is shown.
    expect(await line.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  }
  await row(page, 'Standard mode').click();
  await expect(menu(page)).toHaveCount(0);
  await page.waitForTimeout(300);
  expect(state.puts).toEqual([]);
});

test('choosing Code mode saves it, shows it at once, and a message sent meanwhile goes after the save', async ({ page }) => {
  const state = await portal(page);
  const [hold, release] = held();
  state.hold = hold;
  await chip(page).click();
  await row(page, 'Code mode').click();
  await expect(menu(page)).toHaveCount(0);
  await expect(chip(page)).toHaveText('Code mode');
  await expect.poll(() => state.puts).toEqual([{ mode: 'code' }]);
  await box(page).fill('Count the lines');
  await box(page).press('Enter');
  await page.waitForTimeout(300);
  expect(state.prompts).toEqual([]);
  release();
  await expect.poll(() => state.prompts).toEqual(['Count the lines']);
});

test('a save that fails puts the chip back and says why, and a message sent meanwhile is not sent and stays in the box', async ({ page }) => {
  const state = await portal(page);
  state.fail = 'This chat has started, and its mode is fixed: start a new chat for another one.';
  await chip(page).click();
  await row(page, 'Code mode').click();
  await expect(page.getByText(state.fail)).toBeVisible();
  await expect(chip(page)).toHaveText('Standard mode');

  const [hold, release] = held();
  state.hold = hold;
  await chip(page).click();
  await row(page, 'Code mode').click();
  await expect.poll(() => state.puts.length).toBe(2);
  await box(page).fill('Count the lines');
  await box(page).press('Enter');
  release();
  await expect(page.getByText(state.fail)).toBeVisible();
  await expect(chip(page)).toHaveText('Standard mode');
  await page.waitForTimeout(300);
  expect(state.prompts).toEqual([]);
  await expect(box(page)).toHaveValue('Count the lines');
});

test('a choice made while the last one is on its way is saved after it, and a message sent meanwhile waits for both', async ({ page }) => {
  const state = await portal(page);
  const [first, releaseFirst] = held();
  state.hold = first;
  await chip(page).click();
  await row(page, 'Code mode').click();
  await expect.poll(() => state.puts).toEqual([{ mode: 'code' }]);
  await chip(page).click();
  await row(page, 'Standard mode').click();
  await expect(chip(page)).toHaveText('Standard mode');
  await box(page).fill('Count the lines');
  await box(page).press('Enter');
  await page.waitForTimeout(300);
  expect(state.puts).toEqual([{ mode: 'code' }]);
  expect(state.prompts).toEqual([]);

  const [second, releaseSecond] = held();
  state.hold = second;
  releaseFirst();
  await expect.poll(() => state.puts).toEqual([{ mode: 'code' }, { mode: 'standard' }]);
  await page.waitForTimeout(300);
  expect(state.prompts).toEqual([]);
  await expect(chip(page)).toHaveText('Standard mode');
  releaseSecond();
  await expect.poll(() => state.prompts).toEqual(['Count the lines']);
});

test('a save on its way in one chat does not hold back a message in another', async ({ page }) => {
  const state = await portal(page);
  state.fail = 'This chat has started, and its mode is fixed: start a new chat for another one.';
  const [hold, release] = held();
  state.hold = hold;
  await chip(page).click();
  await row(page, 'Code mode').click();
  await expect.poll(() => state.puts).toEqual([{ mode: 'code' }]);

  // The other chat, by the browser's own way, which keeps the page and its state.
  await page.evaluate(() => { history.pushState({}, '', '/s/b'); dispatchEvent(new PopStateEvent('popstate')); });
  const stream = () => page.evaluate(() => (window as any).streams.some((s: any) => !s.closed && s.url.includes('/sessions/b/')));
  await expect.poll(stream).toBe(true);
  await page.evaluate(() => (window as any).streams.find((s: any) => !s.closed && s.url.includes('/sessions/b/')).emit('caught-up', { seq: 0 }));
  await box(page).fill('Hello from b');
  await box(page).press('Enter');
  await expect.poll(() => state.prompts).toEqual(['Hello from b']);
  expect(state.puts).toEqual([{ mode: 'code' }]);
  release();
});

test('a chat that has started has no chip, and its mode in the header; Standard says nothing, and a mode not offered now says so', async ({ page }) => {
  await portal(page, { mode: 'code', said: true });
  await expect(page.getByText('Hello there')).toBeVisible();
  await expect(chip(page)).toHaveCount(0);
  const pill = page.locator('.chat-header').getByText('Code mode', { exact: true });
  await expect(pill).toBeVisible();
  await expect(pill).toHaveAttribute('title', MODES[1].description);
});

test('a started chat in Standard has no mode in its header', async ({ page }) => {
  await portal(page, { said: true });
  await expect(page.getByText('Hello there')).toBeVisible();
  await expect(chip(page)).toHaveCount(0);
  await expect(page.locator('.chat-header').getByText('Standard mode')).toHaveCount(0);
});

test('a started chat whose mode is not offered now names it, and says it is not available', async ({ page }) => {
  await portal(page, { mode: 'x/gone', said: true });
  await expect(page.getByText('Hello there')).toBeVisible();
  const pill = page.locator('.chat-header').getByText('gone', { exact: true });
  await expect(pill).toBeVisible();
  await expect(pill).toHaveAttribute('title', 'gone is not available now');
});

test('on a phone the mode in the header is cut shorter, leaving the title its room', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const long = { id: 'x/long', label: 'Deep research with a rather long name', description: 'Reads widely before it answers.' };
  await portal(page, { mode: 'x/long', said: true, modes: [...MODES, long] });
  const pill = page.locator('.chat-header').getByText(long.label, { exact: true });
  await expect(pill).toBeVisible();
  expect((await pill.boundingBox())!.width).toBeLessThanOrEqual(96);
});

test('a chat offered no modes draws no chip', async ({ page }) => {
  await portal(page, { modes: [] });
  await expect(box(page)).toBeVisible();
  await expect(chip(page)).toHaveCount(0);
});

test('the keys open the menu, move in it, and close it back onto the chip', async ({ page }) => {
  await portal(page);
  await chip(page).focus();
  await page.keyboard.press('ArrowDown');
  await expect(menu(page)).toBeVisible();
  await expect(row(page, 'Standard mode')).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(row(page, 'Code mode')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu(page)).toHaveCount(0);
  await expect(chip(page)).toBeFocused();
});

test('the picker speaks German', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('pithagoras.language', 'de'));
  await portal(page);
  await expect(page.getByRole('button', { name: 'Modus: Standardmodus' })).toHaveText('Standardmodus');
  await page.getByRole('button', { name: 'Modus: Standardmodus' }).click();
  await expect(page.getByRole('menu', { name: 'Modi' }).getByText('Wie dieser Chat arbeitet. Das steht fest, sobald der Chat begonnen hat.')).toBeVisible();
  await expect(page.getByRole('menuitemradio', { name: /^Code-Modus/ })).toBeVisible();
});

test('choosing a mode with words in the box sends nothing, by a click or by Enter, and the words stay', async ({ page }) => {
  const state = await portal(page);
  await box(page).fill('Not yet');
  await chip(page).click();
  await row(page, 'Code mode').click();
  await expect.poll(() => state.puts).toEqual([{ mode: 'code' }]);
  await chip(page).click();
  await row(page, 'Standard mode').focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => state.puts).toEqual([{ mode: 'code' }, { mode: 'standard' }]);
  await page.waitForTimeout(300);
  expect(state.prompts).toEqual([]);
  await expect(box(page)).toHaveValue('Not yet');
});

test('a chat that has said nothing in a mode not offered now names it on the chip, and is put in one offered; the mode it has is no change', async ({ page }) => {
  const state = await portal(page, { mode: 'x/gone' });
  await expect(chip(page)).toHaveText('gone');
  await expect(chip(page)).toHaveAttribute('title', 'gone is not available now');
  await chip(page).click();
  await expect(menu(page).getByRole('menuitemradio', { checked: true })).toHaveCount(0);
  await row(page, 'Code mode').click();
  await expect.poll(() => state.puts).toEqual([{ mode: 'code' }]);
  await expect(chip(page)).toHaveText('Code mode');

  await chip(page).click();
  await row(page, 'Code mode').click();
  await expect(menu(page)).toHaveCount(0);
  await page.waitForTimeout(300);
  expect(state.puts).toEqual([{ mode: 'code' }]);
});

/** The chat's tools, opened, with every group open. */
async function tools(page: Page) {
  await page.getByRole('button', { name: /^(Which tools this conversation may use|Welche Tools)/ }).click();
  const list = page.locator('.composer-menu');
  await expect(list.getByRole('button', { name: /^(Code mode|Code-Modus)/ })).toBeVisible();
  const shut = list.locator('button[aria-expanded="false"]');
  while (await shut.count()) await shut.first().click();
  return list;
}
const HELD = "This chat's mode works through the code tool, so it stays on: start a chat in Standard mode to work without it.";

test("in a chat in Code mode the code tool's switch is on and cannot be flipped, and says why; the other switches are as before", async ({ page }) => {
  const state = await portal(page, { mode: 'code' });
  const list = await tools(page);
  const tick = list.getByRole('checkbox', { name: 'codemode' });
  await expect(tick).toBeChecked();
  await expect(tick).toBeDisabled();
  await expect(list.getByText(HELD, { exact: true })).toBeVisible();
  // Its group has no switch for all of it: nothing in it can be switched.
  await expect(list.getByRole('button', { name: /^all (on|off)$/ })).toHaveCount(1);
  await list.getByText('codemode', { exact: true }).click({ force: true });
  await page.waitForTimeout(300);
  expect(state.toolPuts).toEqual([]);
  await expect(tick).toBeChecked();
  await list.getByRole('checkbox', { name: 'bash' }).uncheck();
  await expect.poll(() => state.toolPuts).toEqual([['bash']]);
});

test('a Standard chat switches the code tool like any other, and says why in German when the server holds it on', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('pithagoras.language', 'de'));
  const state = await portal(page);
  // Put in Code mode from another tab after this list was drawn: the server refuses, with its code.
  state.toolsFail = { error: HELD, code: 'codemode-held' };
  const list = await tools(page);
  const tick = list.getByRole('checkbox', { name: 'codemode' });
  await expect(tick).toBeEnabled();
  await expect(list.getByText('Der Modus dieses Chats', { exact: false })).toHaveCount(0);
  await tick.uncheck();
  await expect.poll(() => state.toolPuts).toEqual([['codemode']]);
  await expect(list.getByRole('alert')).toHaveText('Dieser Schalter wurde nicht gespeichert: Der Modus dieses Chats arbeitet über das Code-Tool, daher bleibt es an: Starte einen Chat im Standardmodus, um ohne es zu arbeiten.');
  await expect(tick).toBeChecked();
});

test('the reason beside the held switch is in German too', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('pithagoras.language', 'de'));
  await portal(page, { mode: 'code' });
  const list = await tools(page);
  await expect(list.getByRole('checkbox', { name: 'codemode' })).toBeDisabled();
  await expect(list.getByText('Der Modus dieses Chats arbeitet über das Code-Tool, daher bleibt es an: Starte einen Chat im Standardmodus, um ohne es zu arbeiten.', { exact: true })).toBeVisible();
});
