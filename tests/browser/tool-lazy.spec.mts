import { type Page } from '@playwright/test';
import { test, expect, mockPortal } from './portal-mock';

/**
 * Lazy tools in Settings → Tools: a set or a single tool marked lazy is not in the model's list one by
 * one, and the model reaches it through the `tools` tool. Opt-in, and no switch: the mark changes
 * nothing about whether a tool is on. The marking is the server's; the page shows the mark and sends it.
 */
const tools: { name: string; source: string; noLazy?: true; lazy?: true; mcp?: string }[] = [
  { name: 'heavy_open', source: 'pi-heavy' },
  { name: 'heavy_read', source: 'pi-heavy' },
  { name: 'web_search', source: 'pi-web-access' },
];
/** What cannot be lazy: one of pi's own, which the portal marks so. */
const fixed: typeof tools = [{ name: 'bash', source: 'built in', noLazy: true }];
/** An MCP server's tools: lazy as the server's "Register tools directly" says, which the portal tells each tool by. */
const servers: typeof tools = [
  { name: 'notes_read', source: 'notes', mcp: 'notes', lazy: true },
  { name: 'notes_write', source: 'notes', mcp: 'notes', lazy: true },
  { name: 'memory_recall', source: 'memory', mcp: 'memory' },
];

async function portal(page: Page, { lazy = [] as string[], off = [] as string[], more = [] as typeof tools } = {}) {
  const puts: string[][] = [];
  /** The servers' "Register tools directly" as the page set it: [server, direct]. */
  const directs: [string, boolean][] = [];
  await mockPortal(page, async ({ path: p, method, json }) => {
    if (p === '/api/tools' && method === 'GET') {
      const marked = (name: string, source: string) => lazy.includes(source) || lazy.includes(`<tool>${name}`);
      return {
        tools: [...tools, ...more].map((tool) => ({
          ...tool,
          defaultOn: !off.includes(tool.name),
          // An MCP server's tool says for itself (`lazy` above); the others are lazy as marked.
          ...(!tool.mcp && marked(tool.name, tool.source) ? { lazy: true } : {}),
        })),
        off,
        names: {},
        lazy,
      };
    }
    // The page's switches: what it turns off is off from then on.
    if (p === '/api/tools' && method === 'PUT') {
      off.splice(0, off.length, ...json().off);
      return { off, applied: 0 };
    }
    if (p === '/api/tools/lazy' && method === 'PUT') {
      const { lazy: wanted } = json();
      puts.push(wanted);
      return { lazy: wanted, applied: 0 };
    }
    const direct = /^\/api\/mcp\/servers\/([^/]+)\/direct$/.exec(p);
    if (direct && method === 'PUT') {
      directs.push([decodeURIComponent(direct[1]), json().direct]);
      return { ok: true, direct: json().direct };
    }
  }, { settings: true });
  await page.addInitScript(() => localStorage.removeItem('toolGroupsOpen'));
  await page.goto('/settings/tools');
  return { puts, directs };
}

test('nothing is lazy until it is marked: no mark, every tool on', async ({ page }) => {
  await portal(page);
  await expect(page.getByRole('button', { name: /^pi-heavy/ })).toContainText('2 on');
  await expect(page.getByRole('button', { name: 'Lazy pi-heavy' })).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByRole('button', { name: 'Lazy pi-web-access' })).toHaveAttribute('aria-pressed', 'false');
  await page.getByRole('button', { name: /^pi-heavy/ }).click();
  await expect(page.getByRole('button', { name: 'Lazy heavy_open' })).toHaveAttribute('aria-pressed', 'false');
});

test('a set is marked lazy from its header and its tools stay on', async ({ page }) => {
  const { puts } = await portal(page);
  const heavy = page.getByRole('button', { name: /^pi-heavy/ });
  const mark = page.getByRole('button', { name: 'Lazy pi-heavy' });
  await mark.click();
  await expect.poll(() => puts).toEqual([['pi-heavy']]);
  await expect(mark).toHaveAttribute('aria-pressed', 'true');
  // The mark is no switch: the tools are on as they were.
  await expect(heavy).toContainText('2 on');
  await expect(mark).toHaveAttribute('title', /through the `tools` tool/);
  // The other set is not touched.
  await expect(page.getByRole('button', { name: 'Lazy pi-web-access' })).toHaveAttribute('aria-pressed', 'false');
  await heavy.click();
  for (const name of ['heavy_open', 'heavy_read']) {
    await expect(page.getByRole('button', { name: `Lazy ${name}` })).toHaveAttribute('aria-pressed', 'true');
    // A tool is lazy through its set: its own mark cannot take that back.
    await expect(page.getByRole('button', { name: `Lazy ${name}` })).toBeDisabled();
  }
});

test('a single tool is marked lazy on its own, and the mark can be taken back', async ({ page }) => {
  const { puts } = await portal(page);
  await page.getByRole('button', { name: /^pi-web-access/ }).click();
  const mark = page.getByRole('button', { name: 'Lazy web_search' });
  await mark.click();
  await expect.poll(() => puts).toEqual([['<tool>web_search']]);
  await expect(mark).toHaveAttribute('aria-pressed', 'true');
  // Its switch is as it was, and the set's mark is not set.
  await expect(page.getByRole('checkbox', { name: /web_search/ })).toBeChecked();
  await expect(page.getByRole('button', { name: 'Lazy pi-web-access' })).toHaveAttribute('aria-pressed', 'false');
  await mark.click();
  await expect.poll(() => puts).toEqual([['<tool>web_search'], []]);
  await expect(mark).toHaveAttribute('aria-pressed', 'false');
});

test('a lazy set is shown as lazy and can be made ordinary again', async ({ page }) => {
  const { puts } = await portal(page, { lazy: ['pi-heavy'] });
  const mark = page.getByRole('button', { name: 'Lazy pi-heavy' });
  await expect(mark).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: /^pi-heavy/ })).toContainText('2 on');
  await mark.click();
  await expect.poll(() => puts).toEqual([[]]);
  await expect(mark).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByRole('button', { name: /^pi-heavy/ })).toContainText('2 on');
});

test('pi\'s own tools have no lazy mark to set, and the groups that can be lazy have it', async ({ page }) => {
  await portal(page, { more: fixed });
  await expect(page.getByRole('button', { name: 'Lazy pi-heavy' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Lazy built in' })).toHaveCount(0);
  await page.getByRole('button', { name: /^built in/ }).click();
  await expect(page.getByRole('checkbox', { name: /bash/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Lazy bash' })).toHaveCount(0);
});

test('an MCP server\'s group has the lazy button, and it is the server\'s Register tools directly: lazy is off, and a tool cannot differ from its server', async ({ page }) => {
  const { puts, directs } = await portal(page, { more: servers });
  const notes = page.getByRole('button', { name: 'Lazy notes', exact: true });
  const memory = page.getByRole('button', { name: 'Lazy memory', exact: true });
  // Lazy is the adapter's default; a server that registers its tools directly (Understory, for one) is not.
  await expect(notes).toHaveAttribute('aria-pressed', 'true');
  await expect(memory).toHaveAttribute('aria-pressed', 'false');
  await expect(notes).toHaveAttribute('title', /through the `mcp` tool/);
  await expect(notes).toHaveAttribute('title', /Register tools directly/);
  await page.getByRole('button', { name: /^notes/ }).click();
  const read = page.getByRole('button', { name: 'Lazy notes_read' });
  await expect(read).toHaveAttribute('aria-pressed', 'true');
  await expect(read).toBeDisabled();
  await expect(read).toHaveAttribute('title', /Set for the whole server/);

  // Registering the tools directly: the setting of the server, and no mark of the portal's.
  await notes.click();
  await expect.poll(() => directs).toEqual([['notes', true]]);
  await expect(notes).toHaveAttribute('aria-pressed', 'false');
  await expect(read).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByRole('button', { name: 'Lazy notes_write' })).toHaveAttribute('aria-pressed', 'false');
  // The server's tools are on as they were.
  await expect(page.getByRole('button', { name: /^notes/ })).toContainText('2 on');
  // And lazy again.
  await notes.click();
  await expect.poll(() => directs).toEqual([['notes', true], ['notes', false]]);
  await expect(notes).toHaveAttribute('aria-pressed', 'true');
  await expect(read).toHaveAttribute('aria-pressed', 'true');
  // A server that registers its tools directly can be lazy too, from its own button.
  await memory.click();
  await expect.poll(() => directs.at(-1)).toEqual(['memory', false]);
  await expect(memory).toHaveAttribute('aria-pressed', 'true');
  expect(puts).toEqual([]);
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

test('the lazy buttons are greyed out for a tool that is off, and for a group of tools that are all off', async ({ page }) => {
  // heavy_open is off in the defaults, heavy_read is on; every tool of pi-web-access is off.
  const { puts } = await portal(page, { off: ['heavy_open', 'web_search'], lazy: ['<tool>heavy_open'] });
  const heavy = page.getByRole('button', { name: 'Lazy pi-heavy' });
  const web = page.getByRole('button', { name: 'Lazy pi-web-access' });
  // One tool of the set is still on: the set can be marked.
  await expect(heavy).toBeEnabled();
  await expect(web).toBeDisabled();
  await expect(web).toHaveAttribute('title', /All of its tools are off/);
  await page.getByRole('button', { name: /^pi-heavy/ }).click();
  await page.getByRole('button', { name: /^pi-web-access/ }).click();
  const off = page.getByRole('button', { name: 'Lazy heavy_open' });
  await expect(off).toBeDisabled();
  await expect(off).toHaveAttribute('title', /This tool is off/);
  // What was marked stays shown as it is, and is not changed from here.
  await expect(off).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: 'Lazy web_search' })).toBeDisabled();
  await off.click({ force: true });
  await expect(page.getByRole('button', { name: 'Lazy heavy_read' })).toBeEnabled();

  // Switched on, the button is live again.
  await page.getByRole('checkbox', { name: /heavy_open/ }).check();
  await expect(off).toBeEnabled();
  expect(puts).toEqual([]);
});

test('an off tool whose mark is fixed is not told to switch it on to change the mark', async ({ page }) => {
  // notes_read: an MCP server's tool, set by the server's button. heavy_read: in a set that is marked lazy as a whole.
  await portal(page, { more: servers, off: ['notes_read', 'heavy_read'], lazy: ['pi-heavy'] });
  await page.getByRole('button', { name: /^notes/ }).click();
  await page.getByRole('button', { name: /^pi-heavy/ }).click();
  const mcp = page.getByRole('button', { name: 'Lazy notes_read' });
  await expect(mcp).toBeDisabled();
  await expect(mcp).toHaveAttribute('title', /Set for the whole server/);
  const set = page.getByRole('button', { name: 'Lazy heavy_read' });
  await expect(set).toBeDisabled();
  await expect(set).not.toHaveAttribute('title', /Switch it on here/);
  // An off tool of a set that is not marked still says how to get at its mark.
  await page.getByRole('button', { name: /^pi-web-access/ }).click();
  await expect(page.getByRole('button', { name: 'Lazy web_search' })).toBeEnabled();
});

test('Escape in the name field of a tool group cancels the rename, and does not close Settings', async ({ page }) => {
  await portal(page);
  await page.getByRole('button', { name: /^Rename pi-web-access/ }).click();
  const field = page.getByRole('textbox', { name: /^Name for pi-web-access/ });
  await field.fill('Search');
  await field.press('Escape');
  await expect(field).toHaveCount(0);
  await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
  // Nothing was renamed, and the next Escape is the dialog's own.
  await expect(page.getByRole('button', { name: /^pi-web-access/ })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Settings' })).toHaveCount(0);
});
