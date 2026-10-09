import { type Locator, type Page } from '@playwright/test';
import { test, expect, mockPortal } from './portal-mock';
import { DEFAULT_ORB } from '../../server/src/orb-style';

const agent = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id, name, home: `/a/${id}`, first: id === 'home', initialised: true, chats: 3, channels: [], orb: DEFAULT_ORB, voice: '', unread: 0, ...extra,
});

/** A portal with the first agent and one more, "ada", whose folder the answers of a new agent made under that name meet. */
async function portal(page: Page, opts: { kept?: string[]; links?: string[]; deleted?: string[]; wizard?: { initialised: boolean; kept: string[] } } = {}) {
  let made = false;
  let ran = false;
  await mockPortal(page, async ({ path: p, method, url }) => {
    if (p === '/api/agents' && method === 'GET') return { agents: [agent('home', 'Nova'), ...(made ? [agent('ada', 'Ada', { chats: 3 })] : [agent('ada', 'Ada')])] };
    if (p === '/api/agents' && method === 'POST') {
      made = true;
      return { ...agent('ada', 'Ada'), kept: opts.kept ?? [] };
    }
    if (p === '/api/agents/ada' && method === 'DELETE') {
      opts.deleted?.push(url.search);
      return { ok: true, sessionsDeleted: 3, routinesSwitchedOff: [], routinesDeleted: [], jobsStopped: 1 };
    }
    if (p === '/api/agent/sessions') return { sessions: [], agentHome: '/a/ada' };
    if (/^\/api\/agents\/[^/]+\/setup$/.test(p)) {
      // With `wizard`, the folder lacks one of the files until the wizard has been run, and the wizard answers as it is told to.
      if (method === 'POST') ran = true;
      // `links`: files of the folder that are links, which the Files tab does not show.
      const files = (opts.links ?? []).map((name) => ({ name, exists: false, content: '', mtime: 0, link: true }));
      if (!opts.wizard) return { initialised: true, home: '/a/ada', files };
      return { initialised: ran && opts.wizard.initialised, home: '/a/ada', files: [], ...(method === 'POST' ? { kept: opts.wizard.kept } : {}) };
    }
  }, { settings: true });
}

const dialog = (page: Page) => page.getByRole('dialog');

test('the delete dialog of an agent says that what runs in its folder is stopped, whichever way the folder goes', async ({ page }) => {
  const deleted: string[] = [];
  await portal(page, { deleted });
  await page.goto('/agents?agent=ada');
  await page.getByRole('button', { name: 'Delete Ada' }).click();
  const text = 'The background jobs running in its folder, a dev server for example, are stopped too, whichever you choose below.';
  await expect(dialog(page)).toContainText('Its 3 chats are stopped and deleted with it.');
  await expect(dialog(page)).toContainText(text);
  // With the folder kept, which is what the dialog starts on, and with it deleted.
  await dialog(page).getByLabel(/Delete its folder too/).check();
  await expect(dialog(page)).toContainText(text);
  await dialog(page).getByLabel(/Keep its folder/).check();
  await dialog(page).getByRole('button', { name: 'Delete agent' }).click();
  await expect.poll(() => deleted).toEqual(['?folder=keep']);
});

/** The wizard's two steps, answered: a character and a name. */
async function answerWizard(main: Locator) {
  await main.getByLabel('Name').fill('Ada');
  await main.getByLabel('Character').fill('Brisk, answers in two lines.');
  await main.getByRole('button', { name: 'Next' }).click();
  await main.getByLabel('Your name').fill('Sam');
  await main.getByRole('button', { name: 'Create' }).click();
}

/** Makes "Ada" with the wizard. */
async function makeAda(page: Page) {
  await page.goto('/agents');
  const main = page.getByRole('main');
  await main.getByRole('button', { name: 'New agent' }).click();
  await answerWizard(main);
  return main;
}

test('an agent whose folder already had its files says that its answers were not written, once, and can be told to go', async ({ page }) => {
  await portal(page, { kept: ['SOUL.md', 'PrimaryUser.md', 'MEMORY.md'] });
  const main = await makeAda(page);
  const note = main.getByRole('status').filter({ hasText: "folder already had" });
  await expect(note).toContainText("This agent's folder already had SOUL.md, PrimaryUser.md, so what you answered was not written to them. Edit them under Files.");
  await expect(note).not.toContainText('MEMORY.md');
  await note.getByRole('button', { name: 'Dismiss' }).click();
  await expect(note).toHaveCount(0);
  // Told to go, it stays gone: not back when the cards are opened and the agent again.
  await main.getByRole('button', { name: 'Agents' }).click();
  await expect(main.getByRole('button', { name: 'New agent' })).toBeVisible();
  await main.getByRole('button', { name: /^Ada/ }).click();
  await expect(main.getByRole('heading', { name: 'Ada' })).toBeVisible();
  await expect(note).toHaveCount(0);
});

test('the note is said once for a page that was not dismissed either: leaving it ends it', async ({ page }) => {
  await portal(page, { kept: ['SOUL.md'] });
  const main = await makeAda(page);
  const note = main.getByRole('status').filter({ hasText: 'folder already had' });
  await expect(note).toContainText("This agent's folder already had SOUL.md, so what you answered was not written to it. Edit it under Files.");
  await main.getByRole('button', { name: 'Agents' }).click();
  await expect(main.getByRole('button', { name: 'New agent' })).toBeVisible();
  await main.getByRole('button', { name: /^Ada/ }).click();
  await expect(main.getByRole('heading', { name: 'Ada' })).toBeVisible();
  await expect(note).toHaveCount(0);
});

test('the note is not said again for an agent that was left by the browser\'s Back', async ({ page }) => {
  await portal(page, { kept: ['SOUL.md'] });
  const main = await makeAda(page);
  const note = main.getByRole('status').filter({ hasText: 'folder already had' });
  await expect(note).toBeVisible();
  await page.goBack();
  await expect(main.getByRole('button', { name: 'New agent' })).toBeVisible();
  await main.getByRole('button', { name: /^Ada/ }).click();
  await expect(main.getByRole('heading', { name: 'Ada' })).toBeVisible();
  await expect(note).toHaveCount(0);
});

test('the note is not said again for an agent that was left by the sidebar\'s Agents', async ({ page }) => {
  await portal(page, { kept: ['SOUL.md'] });
  const main = await makeAda(page);
  const note = main.getByRole('status').filter({ hasText: 'folder already had' });
  await expect(note).toBeVisible();
  await page.getByRole('complementary', { name: 'Sidebar' }).getByRole('button', { name: 'Agents' }).click();
  await expect(main.getByRole('button', { name: 'New agent' })).toBeVisible();
  await main.getByRole('button', { name: /^Ada/ }).click();
  await expect(main.getByRole('heading', { name: 'Ada' })).toBeVisible();
  await expect(note).toHaveCount(0);
});

test("an agent that lost one of its files and is set up again is not said to have taken up a folder from before", async ({ page }) => {
  await portal(page, { wizard: { initialised: true, kept: ['SOUL.md', 'PrimaryUser.md'] } });
  await page.goto('/agents?agent=ada');
  const main = page.getByRole('main');
  await expect(main.getByRole('heading', { name: 'Set up the agent' })).toBeVisible();
  await answerWizard(main);
  const note = main.getByRole('status');
  await expect(note).toContainText("This agent's folder already had SOUL.md, PrimaryUser.md, so what you answered was not written to them.");
  await expect(main.getByText('kept from before')).toHaveCount(0);
});

test('a kept file that is a link is not said to be editable under Files, which shows no editor for it', async ({ page }) => {
  await portal(page, { kept: ['SOUL.md', 'PrimaryUser.md'], links: ['SOUL.md'] });
  const main = await makeAda(page);
  const note = main.getByRole('status').filter({ hasText: 'folder already had' });
  await expect(note).toContainText("This agent's folder already had PrimaryUser.md, so what you answered was not written to it. Edit it under Files.");
  await expect(note).toContainText("This agent's folder already had SOUL.md as a link, so what you answered was not written to it. It is left as it is.");
  await expect(note).not.toContainText('Edit them');
  await main.getByRole('tab', { name: 'Files' }).click();
  await main.getByRole('button', { name: 'SOUL.md' }).click();
  await expect(main.getByText('This file is a link, so it is left alone')).toBeVisible();
  await expect(main.getByRole('textbox', { name: 'SOUL.md' })).toHaveCount(0);
});

test('a kept file that is a link alone is said so, with no pointer to Files', async ({ page }) => {
  await portal(page, { kept: ['SOUL.md', 'PrimaryUser.md'], links: ['SOUL.md', 'PrimaryUser.md'] });
  const main = await makeAda(page);
  const note = main.getByRole('status').filter({ hasText: 'folder already had' });
  await expect(note).toContainText("This agent's folder already had SOUL.md, PrimaryUser.md as links, so what you answered was not written to them. They are left as they are.");
  await expect(note).not.toContainText('under Files');
});

test('a wizard that is answered and still not done is usable again, and not left spinning', async ({ page }) => {
  await portal(page, { wizard: { initialised: false, kept: ['SOUL.md'] } });
  await page.goto('/agents?agent=ada');
  const main = page.getByRole('main');
  await answerWizard(main);
  await expect(main.getByRole('heading', { name: 'Set up the agent' })).toBeVisible();
  await expect(main.getByRole('button', { name: 'Create' })).toBeEnabled();
  await expect(main.getByLabel('Your name')).toBeEnabled();
});

test('an agent made in a folder of its own says nothing of the kind, and one that kept only its memory does not either', async ({ page }) => {
  await portal(page, { kept: ['MEMORY.md'] });
  const main = await makeAda(page);
  await expect(main.getByRole('heading', { name: 'Ada' })).toBeVisible();
  await expect(main.getByText('folder already had')).toHaveCount(0);
});

test('the tab strip scrolls sideways only: it has no vertical scrollbar of a pixel or two', async ({ page }) => {
  await portal(page);
  await page.goto('/agents?agent=ada');
  const strip = page.getByRole('tablist', { name: 'Agent sections' });
  await expect(strip).toBeVisible();
  // Each tab's border sits a pixel over the strip's own, which a strip left to scroll both ways could be scrolled by.
  expect(await strip.evaluate((el) => getComputedStyle(el).overflowY)).toBe('hidden');
  // No scrollbar takes room beside the tabs, and wheeling over them does not move them.
  expect(await strip.evaluate((el) => el.offsetWidth - el.clientWidth)).toBe(0);
  const box = (await strip.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, 40);
  await page.waitForTimeout(100);
  expect(await strip.evaluate((el) => el.scrollTop)).toBe(0);
});
