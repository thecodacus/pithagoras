import { type Page } from '@playwright/test';
import { test, expect, mockPortal, reply } from './portal-mock';

/**
 * A portal with one project, "demo", and three tools seen. `off` is what the
 * project has off (the portal-wide default has web_fetch off, which the
 * project's answer includes); `puts` is what the page sent. A save that fails
 * (`saveFails`) is held until the test calls `refuse()`, so it can see the switch first.
 */
async function portal(page: Page, opts: { off?: string[]; refuse?: string; toolsError?: string; readsFail?: boolean; saveFails?: string } = {}) {
  let off = opts.off ?? ['web_fetch'];
  /** Whether the portal answers the list with an error: the test says when it is up again. */
  const down = { reads: opts.readsFail ?? false };
  const puts: string[][] = [];
  /** What the page asked to have made, and the chats it then started. */
  const made: { body: any }[] = [];
  const chats: string[] = [];
  let refuse = () => {};
  const refused = new Promise<void>((done) => (refuse = done));
  await mockPortal(page, async ({ path: p, method, json, route }) => {
    if (p === '/api/sessions' && method === 'POST') {
      chats.push(route.request().postData() ?? '');
      return { id: 'c1', title: 'New chat', workspace: '/w/fresh', executor: 'host', status: 'idle', created_at: '', updated_at: '', last_error: null, pinned: false };
    }
    if (p === '/api/sessions') return { sessions: [], executor: 'host' };
    if (p === '/api/projects' && method === 'POST') {
      const body = json();
      made.push({ body });
      return { name: 'fresh', path: '/w/fresh', isGit: false, hasInstructions: false, ...(opts.toolsError ? { toolsError: opts.toolsError } : {}) };
    }
    if (p === '/api/tools') {
      // What the portal-wide default says: web_fetch off.
      return {
        tools: [
          { name: 'web_search', source: 'pi-web-access', defaultOn: true },
          { name: 'web_fetch', source: 'pi-web-access', defaultOn: false },
          { name: 'todo', source: 'pi-todo', defaultOn: true },
        ],
        off: ['web_fetch'],
        names: {},
      };
    }
    if (p === '/api/projects') {
      return { root: '/w', home: '/h', projects: [{ name: 'demo', path: '/w/demo', isGit: false, hasInstructions: false, hasTools: off.length !== 1 || off[0] !== 'web_fetch', sessions: 0, lastActive: null }] };
    }
    if (p === '/api/projects/demo/tools' && opts.refuse) {
      return reply(400, { error: opts.refuse, code: 'tools-unsupported' });
    }
    if (p === '/api/projects/demo/tools' && method === 'GET' && down.reads) {
      return reply(500, { error: 'The portal is starting up' });
    }
    if (p === '/api/projects/demo/tools' && method === 'PUT' && opts.saveFails) {
      await refused;
      return reply(500, { error: opts.saveFails });
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
          { name: 'web_search', source: 'pi-web-access', description: 'Search the web', enabled: !off.includes('web_search'), defaultOn: true },
          { name: 'web_fetch', source: 'pi-web-access', enabled: !off.includes('web_fetch'), defaultOn: false },
          { name: 'todo', source: 'pi-todo', enabled: !off.includes('todo'), defaultOn: true },
        ],
      };
    }
    if (p === '/api/projects/demo/instructions') return { text: 'Use tabs.' };
  }, { settings: true });
  await page.addInitScript(() => localStorage.removeItem('toolGroupsOpen'));
  await page.goto('/projects');
  return { puts, made, chats, down, refuse };
}

const dialog = (page: Page) => page.getByRole('dialog');
/** The Tools section of the New project dialog, which starts shut. */
const toolsSection = (page: Page) => dialog(page).locator('details', { has: page.locator('summary', { hasText: 'Tools' }) });
const openTools = (page: Page) => dialog(page).locator('summary', { hasText: 'Tools' }).click();

test('a project has its own tool switches, saved as each is flipped', async ({ page }) => {
  const { puts } = await portal(page);
  await page.getByRole('button', { name: 'Tools for demo' }).click();
  await expect(dialog(page)).toContainText('Tools · demo');
  await expect(dialog(page)).toContainText('what every chat in this project starts with');

  await dialog(page).getByRole('button', { name: /pi-web-access/ }).click();
  const search = dialog(page).getByRole('checkbox', { name: 'web_search' });
  await expect(search).toBeChecked();
  // Off in the portal-wide default, and not switched on here.
  await expect(dialog(page).getByRole('checkbox', { name: 'web_fetch' })).not.toBeChecked();

  await search.uncheck();
  // The whole picture, as for a chat: the portal-wide default's off tool stays in it.
  await expect.poll(() => puts).toEqual([['web_fetch', 'web_search']]);
  await expect(search).not.toBeChecked();
  await expect(dialog(page).getByText('default on')).toBeVisible();

  // Switching on what the portal-wide default has off is the project's exception.
  await dialog(page).getByRole('checkbox', { name: 'web_fetch' }).check();
  await expect.poll(() => puts).toEqual([['web_fetch', 'web_search'], ['web_search']]);
  await expect(dialog(page).getByText('default off')).toBeVisible();
});

test('a project that switches tools says so on its row, once the list is closed', async ({ page }) => {
  await portal(page);
  await expect(page.getByText('tools', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Tools for demo' }).click();
  await dialog(page).getByRole('button', { name: /pi-todo/ }).click();
  await dialog(page).getByRole('checkbox', { name: 'todo' }).uncheck();
  await expect(dialog(page).getByRole('checkbox', { name: 'todo' })).not.toBeChecked();
  await dialog(page).getByRole('button', { name: 'Close' }).click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(page.getByText('tools', { exact: true })).toBeVisible();
});

test('a deployment that cannot switch tools says why in place of the list', async ({ page }) => {
  await portal(page, { refuse: 'Tools cannot be switched with EXECUTOR=container' });
  await page.getByRole('button', { name: 'Tools for demo' }).click();
  await expect(dialog(page)).toContainText('Tools cannot be switched with EXECUTOR=container');
  await expect(dialog(page).getByRole('checkbox')).toHaveCount(0);
});

test('a read that fails is not taken for a deployment without tool switches: it can be tried again', async ({ page }) => {
  const { down } = await portal(page, { readsFail: true });
  await page.getByRole('button', { name: 'Tools for demo' }).click();
  await expect(dialog(page).getByRole('alert')).toContainText('Could not load this: The portal is starting up');
  await expect(dialog(page).getByRole('checkbox')).toHaveCount(0);
  down.reads = false;
  await dialog(page).getByRole('button', { name: 'Try again' }).click();
  await dialog(page).getByRole('button', { name: /pi-web-access/ }).click();
  await expect(dialog(page).getByRole('checkbox', { name: 'web_search' })).toBeChecked();
  await expect(dialog(page).getByRole('alert')).toHaveCount(0);
});

test('a switch the portal did not save snaps back, and says why', async ({ page }) => {
  const { refuse } = await portal(page, { saveFails: 'The settings file is read-only' });
  await page.getByRole('button', { name: 'Tools for demo' }).click();
  await dialog(page).getByRole('button', { name: /pi-todo/ }).click();
  const todo = dialog(page).getByRole('checkbox', { name: 'todo' });
  await expect(todo).toBeChecked();
  // A click, not uncheck(): uncheck() looks at the box once more after its click, and the
  // refusal can be back and the box checked again by then. The portal holds its answer
  // instead, so the switch is seen to flip before it snaps back.
  await todo.click();
  await expect(todo).not.toBeChecked();
  refuse();
  await expect(dialog(page).getByRole('alert')).toContainText('That switch was not saved: The settings file is read-only');
  await expect(todo).toBeChecked();
});

test('the tools are chosen while the project is made, and go with it', async ({ page }) => {
  const { made } = await portal(page);
  await page.getByRole('button', { name: 'New project' }).click();
  await dialog(page).getByRole('textbox', { name: 'Name' }).fill('fresh');
  await openTools(page);
  await dialog(page).getByRole('button', { name: /pi-web-access/ }).click();
  const search = dialog(page).getByRole('checkbox', { name: 'web_search' });
  // It starts from the portal-wide default: web_fetch is off there.
  await expect(search).toBeChecked();
  await expect(dialog(page).getByRole('checkbox', { name: 'web_fetch' })).not.toBeChecked();
  await expect(dialog(page)).toContainText('what every chat in this project starts with');
  await search.uncheck();
  await dialog(page).getByRole('button', { name: 'Create and open' }).click();
  await expect.poll(() => made.map((m) => m.body)).toEqual([{ name: 'fresh', instructions: '', toolsOff: ['web_fetch', 'web_search'] }]);
});

test('a project made without touching the tools says nothing about them', async ({ page }) => {
  const { made } = await portal(page);
  await page.getByRole('button', { name: 'New project' }).click();
  await dialog(page).getByRole('textbox', { name: 'Name' }).fill('fresh');
  await dialog(page).getByRole('button', { name: 'Create and open' }).click();
  await expect.poll(() => made.map((m) => m.body)).toEqual([{ name: 'fresh', instructions: '' }]);
});

test('a project that was made without its tools says so, and stays on the page', async ({ page }) => {
  const { chats } = await portal(page, { toolsError: 'database is locked' });
  await page.getByRole('button', { name: 'New project' }).click();
  await dialog(page).getByRole('textbox', { name: 'Name' }).fill('fresh');
  await openTools(page);
  await dialog(page).getByRole('button', { name: /pi-web-access/ }).click();
  await dialog(page).getByRole('checkbox', { name: 'web_search' }).uncheck();
  await dialog(page).getByRole('button', { name: 'Create and open' }).click();
  await expect(page.getByText('"fresh" was created, but its tools could not be set: database is locked')).toBeVisible();
  await expect(dialog(page)).toHaveCount(0);
  // Its chat is not opened over the message.
  expect(chats).toEqual([]);
});

test('the tools in the New project dialog are shut until asked for, and keep what was switched', async ({ page }) => {
  await portal(page);
  await page.getByRole('button', { name: 'New project' }).click();
  // Shut, so the dialog stays short: nothing of the list is on show.
  await expect(toolsSection(page)).toBeVisible();
  await expect(toolsSection(page)).not.toHaveAttribute('open', '');
  await expect(dialog(page).getByText('pi-web-access')).toBeHidden();

  await openTools(page);
  await expect(toolsSection(page)).toHaveAttribute('open', '');
  await dialog(page).getByRole('button', { name: /pi-web-access/ }).click();
  await dialog(page).getByRole('checkbox', { name: 'web_search' }).uncheck();

  // Shut and opened again, the switch is where it was left.
  await openTools(page);
  await expect(dialog(page).getByText('pi-web-access')).toBeHidden();
  await openTools(page);
  await expect(dialog(page).getByRole('checkbox', { name: 'web_search' })).not.toBeChecked();
});

test('the hint above the tools has room above it', async ({ page }) => {
  await portal(page);
  await page.getByRole('button', { name: 'Tools for demo' }).click();
  const hint = dialog(page).getByText('These are the tools earlier chats had.');
  await expect(hint).toBeVisible();
  expect(await hint.evaluate((el) => getComputedStyle(el).paddingTop)).toBe('8px');
});

test('the New project dialog asks before it is closed with something typed in, and not before', async ({ page }) => {
  const { made } = await portal(page);
  await page.getByRole('button', { name: 'New project' }).click();
  // Nothing typed: Escape just closes it.
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toHaveCount(0);

  await page.getByRole('button', { name: 'New project' }).click();
  await dialog(page).getByRole('textbox', { name: 'Name' }).fill('fresh');
  await page.keyboard.press('Escape');
  const ask = page.getByRole('alertdialog', { name: 'Discard your changes?' });
  await expect(ask).toBeVisible();
  await ask.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog(page).getByRole('textbox', { name: 'Name' })).toHaveValue('fresh');
  // The close button and a click beside the dialog ask as well; Discard closes it.
  await dialog(page).getByRole('button', { name: 'Close' }).click();
  await expect(ask).toBeVisible();
  await ask.getByRole('button', { name: 'Cancel' }).click();
  await expect(ask).toBeHidden();
  // Inside the page's own area, beside the dialog.
  await page.mouse.click(300, 360);
  await expect(ask).toBeVisible();
  await ask.getByRole('button', { name: 'Discard' }).click();
  await expect(dialog(page)).toHaveCount(0);
  expect(made).toEqual([]);
});

test("a project's instructions asks before they are closed with changes, and not before", async ({ page }) => {
  await portal(page);
  await page.getByRole('button', { name: 'Instructions for demo' }).click();
  const text = dialog(page).getByRole('textbox', { name: 'Project instructions' });
  await expect(text).toHaveValue('Use tabs.');
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toHaveCount(0);

  await page.getByRole('button', { name: 'Instructions for demo' }).click();
  await text.fill('Use spaces.');
  await page.keyboard.press('Escape');
  const ask = page.getByRole('alertdialog', { name: 'Discard your changes?' });
  await expect(ask).toBeVisible();
  await ask.getByRole('button', { name: 'Discard' }).click();
  await expect(dialog(page)).toHaveCount(0);
});
