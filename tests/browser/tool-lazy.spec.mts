import { type Page } from '@playwright/test';
import { test, expect, mockPortal, reply, type Answer } from './portal-mock';

/**
 * Lazy tools in Settings → Tools: a set or a single tool marked lazy is not in the model's list one by
 * one, and the model reaches it through `tool_search`; direct keeps it in the list; and what has no mark is auto, which
 * the threshold decides by how long the list is. No switch: a mark changes nothing about whether a tool is on. The
 * marking is the same as for any set; the page shows the mark and sends it.
 */
const tools: { name: string; source: string; noLazy?: true; lazy?: true; mcp?: string }[] = [
  { name: 'heavy_open', source: 'pi-heavy' },
  { name: 'heavy_read', source: 'pi-heavy' },
  { name: 'web_search', source: 'pi-web-access' },
];
/** What cannot be lazy: one of pi's own, which the portal marks so. */
const fixed: typeof tools = [{ name: 'bash', source: 'built in', noLazy: true }];
/** An MCP server's tools, as pi names them: a set like any other, filed under the server. */
const servers: typeof tools = [
  { name: 'mcp__notes__read', source: 'notes', mcp: 'notes' },
  { name: 'mcp__notes__write', source: 'notes', mcp: 'notes' },
  { name: 'mcp__memory__recall', source: 'memory', mcp: 'memory' },
];

type Mark = 'lazy' | 'direct';

/** `limitAnswer`: what a save of the limits is answered, by its body and how many came before it; undefined saves it. */
async function portal(page: Page, { marks: start = {} as Record<string, Mark>, resolved: byThreshold = [] as string[], notice = [] as string[], off = [] as string[], more = [] as typeof tools, limitAnswer = undefined as ((body: { tokens: number; tools: number }, before: number) => Promise<Answer> | Answer) | undefined } = {}) {
  /** The marks as the page sent them, one list for each change. */
  const puts: Record<string, Mark>[] = [];
  const limitPuts: { tokens: number; tools: number }[] = [];
  const dismissed: number[] = [];
  let marks = { ...start };
  let limits = { tokens: 3000, tools: 20 };
  await mockPortal(page, async ({ path: p, method, json }) => {
    if (p === '/api/tools' && method === 'GET') {
      return {
        tools: [...tools, ...more].map((tool) => {
          // A tool of pi's own has no mark; the others are as marked, else as the threshold has it, an MCP server's among them.
          const own = tool.noLazy ? undefined : marks[`<tool>${tool.name}`] ?? marks[tool.source];
          const lazy = tool.noLazy ? undefined : own ? own === 'lazy' : byThreshold.includes(tool.source);
          return { ...tool, defaultOn: !off.includes(tool.name), ...(own ? { mark: own } : tool.noLazy ? {} : { auto: true }), ...(lazy ? { lazy: true } : {}) };
        }),
        off,
        names: {},
        marks,
        resolved: { lazy: byThreshold, over: false },
        listed: { tokens: 1234, tools: 5 },
        limits,
        defaultLimits: { tokens: 3000, tools: 20 },
        lazyNotice: notice,
      };
    }
    // The page's switches: what it turns off is off from then on.
    if (p === '/api/tools' && method === 'PUT') {
      off.splice(0, off.length, ...json().off);
      return { off, applied: 0 };
    }
    if (p === '/api/tools/marks' && method === 'PUT') {
      marks = json().marks;
      puts.push(marks);
      return { marks, resolved: { lazy: byThreshold, over: false } };
    }
    if (p === '/api/tools/lazy-limits' && method === 'PUT') {
      limitPuts.push(json());
      const answer = await limitAnswer?.(json(), limitPuts.length - 1);
      if (answer !== undefined) return answer;
      limits = json();
      return { limits, resolved: { lazy: byThreshold, over: false } };
    }
    if (p === '/api/tools/lazy-notice' && method === 'DELETE') {
      dismissed.push(1);
      notice.splice(0);
      return { ok: true };
    }
  }, { settings: true });
  await page.addInitScript(() => localStorage.removeItem('toolGroupsOpen'));
  await page.goto('/settings/tools');
  return { puts, limitPuts, dismissed };
}

test('nothing is marked at first: every group and tool is auto, and every tool on', async ({ page }) => {
  await portal(page);
  await expect(page.getByRole('button', { name: /^pi-heavy/ })).toContainText('2 on');
  await expect(page.getByRole('button', { name: 'Lazy or direct pi-heavy' })).toHaveText('auto');
  await expect(page.getByRole('button', { name: 'Lazy or direct pi-web-access' })).toHaveText('auto');
  await page.getByRole('button', { name: /^pi-heavy/ }).click();
  await expect(page.getByRole('button', { name: 'Lazy or direct heavy_open' })).toHaveText('auto');
});

test('a set goes from auto to lazy to direct and back from its header, and its tools stay on', async ({ page }) => {
  const { puts } = await portal(page);
  const heavy = page.getByRole('button', { name: /^pi-heavy/ });
  const mark = page.getByRole('button', { name: 'Lazy or direct pi-heavy' });
  await mark.click();
  await expect.poll(() => puts).toEqual([{ 'pi-heavy': 'lazy' }]);
  await expect(mark).toHaveText('lazy');
  // A screen reader hears the mark in the name; aria-pressed has two values and the mark three.
  await expect(mark).toHaveAccessibleName('Lazy or direct pi-heavy: lazy');
  await expect(mark).not.toHaveAttribute('aria-pressed');
  // The mark is no switch: the tools are on as they were.
  await expect(heavy).toContainText('2 on');
  await expect(mark).toHaveAttribute('title', /through tool_search/);
  // The other set is not touched.
  await expect(page.getByRole('button', { name: 'Lazy or direct pi-web-access' })).toHaveText('auto');
  await heavy.click();
  for (const name of ['heavy_open', 'heavy_read']) {
    // A tool is lazy through its set, which it shows.
    await expect(page.getByRole('button', { name: `Lazy or direct ${name}` })).toHaveText('lazy');
  }
  await mark.click();
  await expect.poll(() => puts.at(-1)).toEqual({ 'pi-heavy': 'direct' });
  await expect(mark).toHaveText('direct');
  await expect(mark).toHaveAccessibleName('Lazy or direct pi-heavy: direct');
  await mark.click();
  await expect.poll(() => puts.at(-1)).toEqual({});
  await expect(mark).toHaveText('auto');
});

test('a single tool is marked on its own, and the mark can be taken back', async ({ page }) => {
  const { puts } = await portal(page);
  await page.getByRole('button', { name: /^pi-web-access/ }).click();
  const mark = page.getByRole('button', { name: 'Lazy or direct web_search' });
  await mark.click();
  await expect.poll(() => puts).toEqual([{ '<tool>web_search': 'lazy' }]);
  await expect(mark).toHaveText('lazy');
  // Its switch is as it was, and the set's mark is not set.
  await expect(page.getByRole('checkbox', { name: /web_search/ })).toBeChecked();
  await expect(page.getByRole('button', { name: 'Lazy or direct pi-web-access' })).toHaveText('auto');
  await mark.click();
  await expect.poll(() => puts.at(-1)).toEqual({ '<tool>web_search': 'direct' });
  await expect(mark).toHaveText('direct');
  await mark.click();
  await expect.poll(() => puts.at(-1)).toEqual({});
  await expect(mark).toHaveText('auto');
});

test('what the threshold made lazy is shown as auto, lazy, and a mark of the person\'s is before it', async ({ page }) => {
  const { puts } = await portal(page, { resolved: ['pi-heavy'] });
  const mark = page.getByRole('button', { name: 'Lazy or direct pi-heavy' });
  await expect(mark).toHaveText('auto, lazy');
  await expect(mark).toHaveAccessibleName('Lazy or direct pi-heavy: auto, lazy');
  await expect(page.getByRole('button', { name: 'Lazy or direct pi-web-access' })).toHaveText('auto');
  await page.getByRole('button', { name: /^pi-heavy/ }).click();
  await expect(page.getByRole('button', { name: 'Lazy or direct heavy_read' })).toHaveText('auto, lazy');
  // Clicked, it goes on to lazy, so the next click is direct: the way to keep a group in the list.
  await mark.click();
  await expect.poll(() => puts).toEqual([{ 'pi-heavy': 'lazy' }]);
  await mark.click();
  await expect.poll(() => puts.at(-1)).toEqual({ 'pi-heavy': 'direct' });
  await expect(mark).toHaveText('direct');
});

test('the limits of the threshold are saved when a field is left, and can be put back', async ({ page }) => {
  const { limitPuts } = await portal(page);
  const tokens = page.getByRole('textbox', { name: 'Tokens of tool declarations' });
  const count = page.getByRole('textbox', { name: 'Number of tools' });
  await expect(tokens).toHaveValue('3000');
  await expect(count).toHaveValue('20');
  await expect(page.getByText("The model's list holds 1,234 tokens in 5 tools.")).toBeVisible();
  await tokens.fill('5000');
  await tokens.press('Enter');
  await expect.poll(() => limitPuts).toEqual([{ tokens: 5000, tools: 20 }]);
  // A word is no number: what was saved comes back, and nothing is sent.
  await count.fill('many');
  await count.blur();
  await expect(count).toHaveValue('20');
  expect(limitPuts).toHaveLength(1);
  await count.fill('0');
  await count.blur();
  await expect.poll(() => limitPuts.at(-1)).toEqual({ tokens: 5000, tools: 0 });
  await page.getByRole('button', { name: /Back to 3,000 tokens or 20 tools/ }).click();
  await expect.poll(() => limitPuts.at(-1)).toEqual({ tokens: 3000, tools: 20 });
  await expect(tokens).toHaveValue('3000');
  await expect(page.getByRole('button', { name: /Back to/ })).toHaveCount(0);
});

test('a save of the limits that fails after a later one went through puts nothing back over it', async ({ page }) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  // The first save is held, and fails once the second has been saved.
  const { limitPuts } = await portal(page, { limitAnswer: async (_body, before) => (before === 0 ? (await held, reply(500, { error: 'The disk is full.' })) : undefined) });
  const tokens = page.getByRole('textbox', { name: 'Tokens of tool declarations' });
  const count = page.getByRole('textbox', { name: 'Number of tools' });
  await tokens.fill('4000');
  await tokens.press('Enter');
  await count.fill('30');
  await count.blur();
  await expect.poll(() => limitPuts).toEqual([{ tokens: 4000, tools: 20 }, { tokens: 4000, tools: 30 }]);
  await expect(page.getByRole('button', { name: /Back to 3,000 tokens or 20 tools/ })).toBeVisible();
  const failed = page.waitForResponse((response) => response.url().endsWith('/api/tools/lazy-limits') && response.status() === 500);
  release();
  await failed;
  // What the page does with the answer is done within a frame or two.
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 200)));
  await expect(tokens).toHaveValue('4000');
  await expect(count).toHaveValue('30');
});

test('a tool switched off reads the list again: what the threshold makes lazy may change with it', async ({ page }) => {
  const resolved = ['pi-heavy'];
  await portal(page, { resolved });
  const mark = page.getByRole('button', { name: 'Lazy or direct pi-heavy' });
  await expect(mark).toHaveText('auto, lazy');
  // With one of its tools off the list is short enough, as the server works it out.
  resolved.splice(0);
  await page.getByRole('button', { name: /^pi-heavy/ }).click();
  await page.getByRole('checkbox', { name: /heavy_open/ }).click();
  await expect(page.getByRole('checkbox', { name: /heavy_open/ })).not.toBeChecked();
  await expect(mark).toHaveText('auto');
});

test('a tool of a set marked direct can be made lazy on its own, and given back to its set', async ({ page }) => {
  const { puts } = await portal(page, { marks: { 'pi-heavy': 'direct' } });
  await page.getByRole('button', { name: /^pi-heavy/ }).click();
  const mark = page.getByRole('button', { name: 'Lazy or direct heavy_open' });
  await expect(mark).toHaveText('direct');
  await mark.click();
  await expect.poll(() => puts.at(-1)).toEqual({ 'pi-heavy': 'direct', '<tool>heavy_open': 'lazy' });
  await expect(mark).toHaveText('lazy');
  // Its own direct would look the same as the set's: the round goes back to no mark of its own.
  await mark.click();
  await expect.poll(() => puts.at(-1)).toEqual({ 'pi-heavy': 'direct' });
  await expect(mark).toHaveText('direct');
});

test('what the threshold made lazy is said once, and can be put away', async ({ page }) => {
  const { dismissed } = await portal(page, { resolved: ['pi-heavy'], notice: ['pi-heavy'] });
  const banner = page.getByRole('status').filter({ hasText: 'The list of tools got long' });
  await expect(banner).toContainText('pi-heavy through tool_search');
  await banner.getByRole('button', { name: 'Dismiss' }).click();
  await expect(banner).toHaveCount(0);
  await expect.poll(() => dismissed).toEqual([1]);
});

test('pi\'s own tools have no mark to set, and the groups that can be lazy have it', async ({ page }) => {
  await portal(page, { more: fixed });
  await expect(page.getByRole('button', { name: 'Lazy or direct pi-heavy' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Lazy or direct built in' })).toHaveCount(0);
  await page.getByRole('button', { name: /^built in/ }).click();
  await expect(page.getByRole('checkbox', { name: /bash/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Lazy or direct bash' })).toHaveCount(0);
});

test('an MCP server is a group like any other: auto at first, and its mark goes round from its header, its tools on throughout', async ({ page }) => {
  const { puts } = await portal(page, { more: servers, resolved: ['notes'] });
  const notes = page.getByRole('button', { name: 'Lazy or direct notes' });
  const memory = page.getByRole('button', { name: 'Lazy or direct memory' });
  // Auto, as for any group: by size, which put notes behind the search and left memory in the list.
  await expect(notes).toHaveText('auto, lazy');
  await expect(memory).toHaveText('auto');
  await page.getByRole('button', { name: /^notes/ }).click();
  const read = page.getByRole('button', { name: 'Lazy or direct mcp__notes__read' });
  await expect(read).toBeEnabled();
  await expect(read).toHaveText('auto, lazy');
  await notes.click();
  await expect.poll(() => puts.at(-1)).toEqual({ notes: 'lazy' });
  await expect(notes).toHaveText('lazy');
  await notes.click();
  await expect.poll(() => puts.at(-1)).toEqual({ notes: 'direct' });
  await expect(notes).toHaveText('direct');
  await notes.click();
  await expect.poll(() => puts.at(-1)).toEqual({});
  // The server's tools are on as they were.
  await expect(page.getByRole('button', { name: /^notes/ })).toContainText('2 on');
  await memory.click();
  await expect.poll(() => puts.at(-1)).toEqual({ memory: 'lazy' });
  await expect(memory).toHaveText('lazy');
});

test('a lazy tool carries its label in a project\'s switches, and keeps it as the switch is flipped off and on', async ({ page }) => {
  // The label is what the server says of the tool, whether the project has it on or off: a switch does not change it.
  let off: string[] = [];
  const puts: string[][] = [];
  await mockPortal(page, async ({ path: p, method, json }) => {
    if (p === '/api/sessions') return { sessions: [], executor: 'host' };
    if (p === '/api/projects') {
      return { root: '/w', home: '/h', projects: [{ name: 'demo', path: '/w/demo', isGit: false, hasInstructions: false, hasTools: false, sessions: 0, lastActive: null }] };
    }
    if (p === '/api/projects/demo/tools' && method === 'PUT') {
      off = json().off;
      puts.push(off);
      return { off, applied: 0 };
    }
    if (p === '/api/projects/demo/tools') {
      return {
        live: false,
        off,
        names: {},
        tools: [
          { name: 'heavy_open', source: 'pi-heavy', enabled: !off.includes('heavy_open'), defaultOn: true, lazy: true },
          { name: 'web_search', source: 'pi-web-access', enabled: !off.includes('web_search'), defaultOn: true },
        ],
      };
    }
    if (p === '/api/projects/demo/instructions') return { text: '' };
  }, { settings: true });
  await page.addInitScript(() => localStorage.removeItem('toolGroupsOpen'));
  await page.goto('/projects');
  await page.getByRole('button', { name: 'Tools for demo' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: /pi-heavy/ }).click();
  await dialog.getByRole('button', { name: /pi-web-access/ }).click();
  const label = dialog.getByText('lazy', { exact: true });
  const open = dialog.getByRole('checkbox', { name: 'heavy_open' });
  // On and lazy: the label is there, and only beside the tool that is lazy.
  await expect(open).toBeChecked();
  await expect(label).toHaveCount(1);
  await expect(open.locator('xpath=ancestor::label').getByText('lazy', { exact: true })).toBeVisible();

  await open.uncheck();
  await expect.poll(() => puts).toEqual([['heavy_open']]);
  await expect(open).not.toBeChecked();
  await expect(open.locator('xpath=ancestor::label').getByText('lazy', { exact: true })).toBeVisible();

  await open.check();
  await expect.poll(() => puts).toEqual([['heavy_open'], []]);
  await expect(open).toBeChecked();
  await expect(label).toHaveCount(1);
  // The other tool is no lazy one, whatever is flipped beside it.
  const search = dialog.getByRole('checkbox', { name: 'web_search' });
  await search.uncheck();
  await expect.poll(() => puts).toEqual([['heavy_open'], [], ['web_search']]);
  await expect(label).toHaveCount(1);
  await expect(search.locator('xpath=ancestor::label').getByText('lazy', { exact: true })).toHaveCount(0);
});
