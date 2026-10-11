import { type Page } from '@playwright/test';
import { test, expect, mockPortal, reply } from './portal-mock';

/**
 * A portal with two agents, Nova and Scout, and one project, "demo". `agent` is the one the project works with
 * (none: a blank slate); `understory` whether the portal has Understory. `made` is what the page asked to have
 * made, `puts` what it changed on the project since.
 */
async function portal(page: Page, opts: { agent?: string; understory?: boolean; understoryOff?: boolean; saveFails?: string } = {}) {
  let agent = opts.agent ?? null;
  let understory = !opts.understoryOff;
  const made: any[] = [];
  const puts: any[] = [];
  const agents = [
    { id: 'home', name: 'Nova', home: '/h', newChats: true },
    { id: 'scout', name: 'Scout', home: '/h/scout', newChats: false },
  ];
  await mockPortal(page, async ({ path: p, method, json }) => {
    if (p === '/api/sessions') return { sessions: [], executor: 'host' };
    if (p === '/api/features/flags') return { subagent: { enabled: false }, understory: { enabled: !!opts.understory }, images: { enabled: false } };
    if (p === '/api/projects' && method === 'POST') {
      made.push(json());
      return { name: 'fresh', path: '/w/fresh', isGit: false, hasInstructions: false };
    }
    if (p === '/api/projects') {
      const link = { ...(agent ? { agent } : {}), ...(understory ? {} : { understoryOff: true }) };
      return { root: '/w', home: '/h', agents, projects: [{ name: 'demo', path: '/w/demo', isGit: false, hasInstructions: false, sessions: 0, lastActive: null, ...link }] };
    }
    if (p === '/api/projects/demo/agent' && method === 'PUT') {
      if (opts.saveFails) return reply(500, { error: opts.saveFails });
      const body = json();
      puts.push(body);
      if (body.agent !== undefined) agent = body.agent;
      if (body.understory !== undefined) understory = body.understory;
    }
    if (p === '/api/projects/demo/agent') // As the server reports it: a blank slate has no Understory, whatever the stored switch says.
    return { agent, understory: !!agent && understory, understoryAvailable: !!opts.understory };
  }, { settings: true });
  await page.goto('/projects');
  return { made, puts };
}

// The list of projects, not the sidebar beside it, which names the agent as well.
const rows = (page: Page) => page.getByRole('main');
const dialog = (page: Page) => page.getByRole('dialog');
const agentSelect = (page: Page) => dialog(page).getByRole('combobox', { name: 'Agent' });
const understorySwitch = (page: Page) => dialog(page).getByRole('switch', { name: 'Understory as memory' });
const pick = async (page: Page, name: string) => {
  await agentSelect(page).click();
  await page.getByRole('option', { name }).click();
};

test('a new project is a blank slate until an agent is picked, and says so', async ({ page }) => {
  const { made } = await portal(page);
  await page.getByRole('button', { name: 'New project' }).click();
  await expect(agentSelect(page)).toContainText('None — a blank slate');
  await expect(dialog(page)).toContainText('A blank slate: the chats have only the instructions');
  await dialog(page).getByRole('textbox', { name: 'Name' }).fill('fresh');
  await dialog(page).getByRole('button', { name: 'Create and open' }).click();
  // Nothing about an agent: a project made as before is made as before.
  await expect.poll(() => made).toEqual([{ name: 'fresh', instructions: '' }]);
});

test('the agent is picked while the project is made, and goes with it', async ({ page }) => {
  const { made } = await portal(page);
  await page.getByRole('button', { name: 'New project' }).click();
  await dialog(page).getByRole('textbox', { name: 'Name' }).fill('fresh');
  await pick(page, 'Scout');
  await expect(agentSelect(page)).toContainText('Scout');
  await expect(dialog(page)).toContainText("Its SOUL.md, PrimaryUser.md and memory go into this project's chats");
  await dialog(page).getByRole('button', { name: 'Create and open' }).click();
  await expect.poll(() => made).toEqual([{ name: 'fresh', instructions: '', agent: 'scout' }]);
});

test('Understory is offered as the memory only where the portal has it, and can be left out for the project', async ({ page }) => {
  await portal(page);
  await page.getByRole('button', { name: 'New project' }).click();
  await expect(agentSelect(page)).toBeVisible();
  await pick(page, 'Scout');
  await expect(understorySwitch(page)).toHaveCount(0);
});

test('a project made without Understory as its memory says so', async ({ page }) => {
  const { made } = await portal(page, { understory: true });
  await page.getByRole('button', { name: 'New project' }).click();
  await dialog(page).getByRole('textbox', { name: 'Name' }).fill('fresh');
  await pick(page, 'Scout');
  await expect(understorySwitch(page)).toHaveAttribute('aria-checked', 'true');
  await understorySwitch(page).click();
  await expect(understorySwitch(page)).toHaveAttribute('aria-checked', 'false');
  await dialog(page).getByRole('button', { name: 'Create and open' }).click();
  await expect.poll(() => made).toEqual([{ name: 'fresh', instructions: '', agent: 'scout', understory: false }]);
});

test('a blank slate has no Understory switch: New project shows it once an agent is picked, and not for None', async ({ page }) => {
  await portal(page, { understory: true });
  await page.getByRole('button', { name: 'New project' }).click();
  await expect(agentSelect(page)).toContainText('None — a blank slate');
  await expect(understorySwitch(page)).toHaveCount(0);
  await pick(page, 'Scout');
  await expect(understorySwitch(page)).toBeVisible();
  await pick(page, 'None — a blank slate');
  await expect(understorySwitch(page)).toHaveCount(0);
});

test("a project's Agent dialog shows the Understory switch only while an agent is picked", async ({ page }) => {
  await portal(page, { understory: true });
  await page.getByRole('button', { name: 'Agent for demo' }).click();
  await expect(agentSelect(page)).toContainText('None — a blank slate');
  await expect(understorySwitch(page)).toHaveCount(0);
  await pick(page, 'Scout');
  await expect(understorySwitch(page)).toBeVisible();
  await expect(understorySwitch(page)).toHaveAttribute('aria-checked', 'true');
  await pick(page, 'None — a blank slate');
  await expect(understorySwitch(page)).toHaveCount(0);
});

test('the New project dialog asks before it is closed with an agent picked, and not before', async ({ page }) => {
  await portal(page);
  await page.getByRole('button', { name: 'New project' }).click();
  await dialog(page).getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog(page)).toHaveCount(0);

  await page.getByRole('button', { name: 'New project' }).click();
  await pick(page, 'Scout');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('alertdialog', { name: 'Discard your changes?' })).toBeVisible();
});

test('a project row names the agent it works with, and a blank slate says nothing', async ({ page }) => {
  await portal(page, { agent: 'scout' });
  await expect(rows(page).getByText('with Scout')).toBeVisible();
});

test('a project that works with no agent has no mark of one on its row', async ({ page }) => {
  await portal(page);
  await expect(rows(page).getByText('demo', { exact: true })).toBeVisible();
  await expect(rows(page).getByText(/^with /)).toHaveCount(0);
});

test('the agent of an existing project is changed later, saved as it is picked', async ({ page }) => {
  const { puts } = await portal(page);
  await page.getByRole('button', { name: 'Agent for demo' }).click();
  await expect(dialog(page)).toContainText('Agent · demo');
  await expect(agentSelect(page)).toContainText('None — a blank slate');

  await pick(page, 'Nova');
  await expect.poll(() => puts).toEqual([{ agent: 'home' }]);
  await expect(agentSelect(page)).toContainText('Nova');

  await pick(page, 'None — a blank slate');
  await expect.poll(() => puts).toEqual([{ agent: 'home' }, { agent: null }]);
  await expect(agentSelect(page)).toContainText('None — a blank slate');

  // Closing it brings the row up to date.
  await pick(page, 'Scout');
  await expect.poll(() => puts.length).toBe(3);
  await dialog(page).getByRole('button', { name: 'Close' }).click();
  await expect(rows(page).getByText('with Scout')).toBeVisible();
});

test("a project's Understory switch is saved on its own, leaving the agent as it is", async ({ page }) => {
  const { puts } = await portal(page, { agent: 'scout', understory: true });
  await page.getByRole('button', { name: 'Agent for demo' }).click();
  await expect(agentSelect(page)).toContainText('Scout');
  await expect(understorySwitch(page)).toHaveAttribute('aria-checked', 'true');
  await understorySwitch(page).click();
  await expect.poll(() => puts).toEqual([{ understory: false }]);
  await expect(understorySwitch(page)).toHaveAttribute('aria-checked', 'false');
});

test('a change the portal did not save is said, and the choice stays as it was', async ({ page }) => {
  await portal(page, { agent: 'scout', saveFails: 'Disk is full' });
  await page.getByRole('button', { name: 'Agent for demo' }).click();
  await pick(page, 'Nova');
  await expect(dialog(page).getByRole('alert')).toContainText('Disk is full');
  await expect(agentSelect(page)).toContainText('Scout');
});

test("the sidebar names the agent a project works with beside the project, and the project's own name stays its name", async ({ page }) => {
  await portal(page, { agent: 'scout' });
  await page.goto('/sessions');
  const side = page.getByRole('complementary', { name: 'Sidebar' });
  await expect(side.getByRole('button', { name: 'demo', exact: true })).toBeVisible();
  await expect(side.getByText('with Scout')).toBeVisible();
  await expect(side.getByText('with Scout')).toHaveAttribute('title', 'Chats here start with the SOUL.md, PrimaryUser.md and memory of Scout');
});

test('the sidebar says nothing of an agent beside a blank slate', async ({ page }) => {
  await portal(page);
  await page.goto('/sessions');
  const side = page.getByRole('complementary', { name: 'Sidebar' });
  await expect(side.getByRole('button', { name: 'demo', exact: true })).toBeVisible();
  await expect(side.getByText(/^with /)).toHaveCount(0);
});
