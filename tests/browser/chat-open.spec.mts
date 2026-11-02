import { type Page } from '@playwright/test';
import { test, expect, mockPortal, HANG } from './portal-mock';

/**
 * Opening a chat: the stream it keeps open, and the effort pill it draws
 * before anything has answered.
 */
const modelA = { id: 'model-a', name: 'Model A', provider: 'llama-swap' };
const modelB = { id: 'model-b', name: 'Model B', provider: 'llama-swap' };
const ALL = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const config = (model: typeof modelA, levels: string[], named: { provider: string | null; model: string | null } = { provider: null, model: null }, models = [modelA, modelB]) =>
  ({ live: false, state: { model, thinkingLevel: 'medium' }, stats: null, thinking: { levels }, models: { models }, named });

async function portal(page: Page, opts: { streamsOpen?: boolean } = {}) {
  const at = new Date().toISOString();
  const chat = (id: string, title: string, provider: string | null = null) =>
    ({ id, title, workspace: '/w/site', status: 'idle', kind: 'task', pinned: false, updated_at: at, provider, model: null, thinking_level: null });
  const sessions = [
    chat('a', 'First chat'), chat('b', 'Second chat'),
    // Naming a provider and no model: the default model, run there.
    chat('c', 'Third chat', 'llama-swap'), chat('c2', 'Fourth chat', 'llama-swap'),
    chat('d', 'Fifth chat'), chat('e', 'Sixth chat'),
    chat('f', 'Seventh chat'), chat('g', 'Eighth chat'),
  ];
  /** Whether a model was picked for chat a, which is then its own and no longer the default. */
  let picked = false;
  /** Every GET, by path, and how often. */
  const asked: Record<string, number> = {};
  // Every stream the page opens is in window.streams, with whether it has been closed. One not `open` stays pending.
  await mockPortal(page, async ({ path: p, method }) => {
    if (method === 'GET') asked[p] = (asked[p] ?? 0) + 1;
    if (p === '/api/sessions') return { sessions, executor: 'host' };
    if (/^\/api\/sessions\/\w+$/.test(p)) return sessions.find((s) => p.endsWith('/' + s.id));
    // These answers never come: what their pills show is the first guess.
    if (p === '/api/sessions/b/config' || p === '/api/sessions/c2/config') return HANG;
    if (p === '/api/sessions/a/config' && method === 'POST') {
      picked = true;
      return { ok: true, applied: ['model'], state: { model: modelB, thinkingLevel: 'medium' } };
    }
    if (p === '/api/sessions/a/config' || p === '/api/sessions/a/models') {
      // The model menu fetches the catalogue where the browser has none cached, and is answered as the config is.
      return picked ? { ...config(modelB, ALL, { provider: 'llama-swap', model: modelB.id }), live: true } : config(modelA, ['off', 'medium']);
    }
    if (p === '/api/sessions/c/config') return config(modelA, ['off', 'medium'], { provider: 'llama-swap', model: null });
    // The default is Model B now, and pi's catalogue has not said its levels yet.
    if (p === '/api/sessions/d/config') return config(modelB, []);
    // No catalogue yet: opening the model menu asks pi for it, which says the default is Model B now.
    if (p === '/api/sessions/e/config') return config(modelA, ['off', 'medium'], undefined, []);
    if (p === '/api/sessions/e/models') return { ...config(modelB, ALL), live: true };
    // Still Model A, the default, but pi's catalogue has not answered yet.
    if (p === '/api/sessions/f/config') return config(modelA, []);
    // No default set in the portal: pi's own, which an idle chat cannot name.
    if (p === '/api/sessions/g/config') return config({ id: 'default', name: "pi's default", provider: 'llama-swap' }, []);
    // The browser has no connection for it: asked, and never answered.
    if (p === '/api/workspaces') return { root: '/w', workspaces: [] };
    if (p === '/api/models') return { models: [], providers: {} };
  }, { streams: opts.streamsOpen === false ? 'pending' : 'open', settings: true });
  await page.addInitScript(() => {
    // Whether the page is hidden, as the test says.
    (window as any).hide = (hidden: boolean) => {
      (window as any).hidden = hidden;
      document.dispatchEvent(new Event('visibilitychange'));
    };
    Object.defineProperty(document, 'hidden', { get: () => !!(window as any).hidden });
    Object.defineProperty(document, 'visibilityState', { get: () => ((window as any).hidden ? 'hidden' : 'visible') });
  });
  return { sessions, asked };
}

/** The streams the page has open. Development React runs each effect twice, so a first one may be opened and closed at once. */
const streams = (page: Page) => page.evaluate(() => (window as any).streams.filter((s: any) => !s.closed).map((s: any) => s.url));
/** Every stream the page has asked for, closed or not. */
const everAsked = (page: Page) => page.evaluate(() => [...new Set((window as any).streams.map((s: any) => s.url))]);
const pill = (page: Page) => page.locator('.composer-settings button').nth(1);
/** What a page that has seen chats before keeps: the default's levels, as last reported, and which model they were for. */
const seen = (page: Page, levels: Record<string, string[]>, follows: Record<string, string> = {}) =>
  page.addInitScript(([l, f]) => {
    localStorage.setItem('pithagoras.thinkingLevels', JSON.stringify(l));
    localStorage.setItem('pithagoras.thinkingLevelsFollow', JSON.stringify(f));
  }, [levels, follows] as const);
const open = async (page: Page, title: string, id: string) => {
  await page.getByText(title).first().click();
  await expect(page).toHaveURL(new RegExp(`/s/${id}$`));
};

test('a chat keeps one stream, hidden or not', async ({ page }) => {
  await page.clock.install();
  await portal(page);
  await page.goto('/s/a');
  await expect.poll(() => streams(page)).toEqual(['/api/sessions/a/events?since=0']);
  // What the installed extensions' server halves say comes on it too: no stream of their own.
  expect(await everAsked(page)).toEqual(['/api/sessions/a/events?since=0']);

  // A hidden tab keeps it: hands-free voice speaks its replies there, a
  // document the agent makes opens there, and a run started elsewhere ends
  // there. Giving it back after a while left all three to a status check.
  await page.evaluate(() => (window as any).hide(true));
  await page.clock.fastForward(120_000);
  expect(await streams(page)).toEqual(['/api/sessions/a/events?since=0']);
});

test("a chat on the default model draws the default's effort control before its own answer comes", async ({ page }) => {
  await portal(page);
  await page.goto('/s/a');
  await expect(page.getByTitle('Thinking on / off')).toHaveText('thinking on');
  // Chat b names no model either, and its config does not answer: the default's
  // was last seen to switch on and off, not slide across seven levels.
  await open(page, 'Second chat', 'b');
  await expect(page.locator('.composer-settings button').first()).toHaveText('default');
  await expect(page.getByTitle('Thinking on / off')).toHaveText('thinking on');
  await expect(page.getByTitle('Effort / thinking level')).toHaveCount(0);
});

test('a chat naming only a provider draws what was last seen for one like it', async ({ page }) => {
  // Its first paint looks the levels up by what its row names: the provider,
  // and no model. They were kept only for a row naming neither.
  await portal(page);
  await page.goto('/s/c');
  await expect(page.getByTitle('Thinking on / off')).toHaveText('thinking on');
  await open(page, 'Fourth chat', 'c2');
  await expect(page.locator('.composer-settings button').first()).toHaveText('default');
  await expect(page.getByTitle('Thinking on / off')).toHaveText('thinking on');
});

test("a model picked in a chat on the default is not kept as the default's", async ({ page }) => {
  await portal(page);
  await page.goto('/s/a');
  await expect(page.getByTitle('Thinking on / off')).toHaveText('thinking on');
  // Picked here: the chat is on a model of its own now, with seven levels.
  await page.getByTitle('model-a', { exact: true }).click();
  await page.getByRole('button', { name: 'More models' }).click();
  // By its name, not its title: the list opens under the pointer, and the title of the model it comes to rest on is
  // lifted into the portal's own tooltip (tooltips.ts), so a title would find nothing.
  await page.getByRole('group', { name: 'Models' }).getByRole('button', { name: 'Model B' }).click();
  await expect(page.getByTitle('Effort / thinking level')).toHaveText('medium');
  // Chat b is still on the default, which switches on and off.
  await open(page, 'Second chat', 'b');
  await expect(page.locator('.composer-settings button').first()).toHaveText('default');
  await expect(page.getByTitle('Thinking on / off')).toHaveText('thinking on');
});

test("a new default's control is not the old default's, when its levels are not known yet", async ({ page }) => {
  await seen(page, { ':': ['off', 'medium'] }, { ':': 'llama-swap:model-a' });
  await portal(page);
  // Chat d is drawn first with the default's levels as last seen: Model A's.
  // Its answer names Model B, the default now, with no levels yet. What was
  // drawn is another model's, and stayed until the chat was run.
  await page.goto('/s/d');
  await expect(page.locator('.composer-settings button').first()).toHaveText('Model B');
  await expect(page.getByTitle('Effort / thinking level')).toHaveText('medium');
});

test("the levels the model list reports are kept as the config's are", async ({ page }) => {
  await seen(page, { ':': ['off', 'medium'] });
  await portal(page);
  await page.goto('/s/e');
  await expect(page.getByTitle('Thinking on / off')).toHaveText('thinking on');
  // No catalogue: opening the menu asks pi, which says the default is Model B now.
  await page.getByTitle('model-a', { exact: true }).click();
  await expect(pill(page)).toHaveText('medium');
  await page.keyboard.press('Escape');
  // Chat b follows the default too: it draws Model B's seven levels, not Model A's two.
  await open(page, 'Second chat', 'b');
  await expect(page.locator('.composer-settings button').first()).toHaveText('default');
  await expect(page.getByTitle('Effort / thinking level')).toHaveText('medium');
});

test("the default's control stays while pi's catalogue has not answered", async ({ page }) => {
  // Drawn from what was last seen for a chat on the default: Model A's. Its
  // answer names Model A with no levels yet. The first paint named no model,
  // and was taken for another's: the right control became the full slider
  // whenever the catalogue was slow.
  await seen(page, { ':': ['off', 'medium'] }, { ':': 'llama-swap:model-a' });
  await portal(page);
  await page.goto('/s/f');
  await expect(page.locator('.composer-settings button').first()).toHaveText('Model A');
  await page.waitForTimeout(300);
  await expect(page.getByTitle('Thinking on / off')).toHaveText('thinking on');
});

test("pi's own default, which cannot be named, keeps what was drawn", async ({ page }) => {
  await seen(page, { ':': ['off', 'medium'] }, { ':': 'llama-swap:model-a' });
  await portal(page);
  await page.goto('/s/g');
  await expect(page.locator('.composer-settings button').first()).toHaveText("pi's default");
  await page.waitForTimeout(300);
  await expect(page.getByTitle('Thinking on / off')).toHaveText('thinking on');
});

