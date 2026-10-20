import { type Page } from '@playwright/test';
import { test, expect, mockPortal } from './portal-mock';

/**
 * The pages extensions bring (`nav.page`) are one group in the sidebar, "Extensions", and one button on the folded
 * rail that opens a menu of them. The stand-ins: Notes, always listed, and Viewer, listed while a test says so.
 */

const KEY = 'sidebarExtensionsOpen';
const NOTES = '/x/pithagoras-notes/notes';

async function portal(page: Page) {
  await mockPortal(page, ({ path: p }) => {
    if (p === '/api/sessions') return { sessions: [], executor: 'host' };
    if (p === '/api/projects') return { root: '/w', home: '/h', projects: [] };
    if (p === '/api/x/pithagoras-notes/notes') return { chats: [] };
  });
}

const nav = (page: Page) => page.getByRole('complementary', { name: 'Sidebar' }).getByRole('navigation', { name: 'Destinations' });
const header = (page: Page) => nav(page).getByRole('button', { name: 'Extensions' });
const group = (page: Page) => nav(page).getByRole('group', { name: 'Extensions' });
const stored = (page: Page) => page.evaluate((key) => localStorage.getItem(key), KEY);
const listViewer = (page: Page, on = true) => page.evaluate((on) => (window as any).viewerListed(on), on);

test.describe('with extension pages', () => {
  test.use({ installed: ['tests/fixtures/extensions/notes', 'tests/fixtures/extensions/viewer'] });

  test('the pages are in one group above Audit, not among the portal\'s own', async ({ page }) => {
    await portal(page);
    await page.goto('/sessions');
    await expect(header(page)).toHaveAttribute('aria-expanded', 'true');
    await expect(header(page)).toHaveAttribute('aria-controls', (await group(page).getAttribute('id'))!);
    await expect(group(page).getByRole('button', { name: 'Notes' })).toBeVisible();
    // Above Audit, which stays the last destination, and indented in the group: not a destination of the list itself.
    const labels = await nav(page).getByRole('button').evaluateAll((items) => items.map((b) => b.textContent!.trim()));
    expect(labels.slice(-3)).toEqual(['Extensions', 'Notes', 'Audit']);
    const at = async (name: string) => (await nav(page).getByRole('button', { name, exact: true }).boundingBox())!.x;
    expect(await at('Notes')).toBeGreaterThan(await at('Routines'));
    // Its icon is the size of the portal's own.
    const sizes = await nav(page).getByRole('button').evaluateAll((items) => Object.fromEntries(items.map((b) => [b.textContent!.trim(), b.querySelector('svg')!.getBoundingClientRect().width])));
    expect(sizes.Notes).toBeGreaterThan(0);
    expect(sizes.Notes).toBe(sizes.Audit);
  });

  test('folded by hand, the group stays folded after a reload; opened again, it stays open', async ({ page }) => {
    await portal(page);
    await page.goto('/sessions');
    await header(page).click();
    await expect(header(page)).toHaveAttribute('aria-expanded', 'false');
    await expect(nav(page).getByRole('button', { name: 'Notes' })).toHaveCount(0);
    await page.reload();
    await expect(header(page)).toHaveAttribute('aria-expanded', 'false');
    await expect(nav(page).getByRole('button', { name: 'Notes' })).toHaveCount(0);
    await header(page).click();
    await expect(nav(page).getByRole('button', { name: 'Notes' })).toBeVisible();
    await page.reload();
    await expect(header(page)).toHaveAttribute('aria-expanded', 'true');
    await expect(nav(page).getByRole('button', { name: 'Notes' })).toBeVisible();
  });

  test('a folded group opens by itself while one of its pages is showing, and is folded again once it is left', async ({ page }) => {
    await page.addInitScript((key) => { if (!sessionStorage.getItem('seeded')) { sessionStorage.setItem('seeded', '1'); localStorage.setItem(key, 'false'); } }, KEY);
    await portal(page);
    await page.goto(NOTES);
    await expect(page.getByRole('heading', { name: 'Notes' })).toBeVisible();
    await expect(header(page)).toHaveAttribute('aria-expanded', 'true');
    await expect(nav(page).getByRole('button', { name: 'Notes' })).toHaveAttribute('aria-current', 'page');
    // Held open by the page, so the fold does nothing and keeps what was chosen.
    await expect(header(page)).toHaveAttribute('aria-disabled', 'true');
    expect(await stored(page)).toBe('false');
    // It says why, and pressing it neither folds the group nor changes what is kept: a plain click is refused as the disabled it announces.
    await expect(header(page)).toHaveAttribute('title', 'Open while one of its pages is showing');
    expect(await header(page).evaluate((b) => getComputedStyle(b).cursor)).toBe('default');
    await header(page).focus();
    await page.keyboard.press('Enter');
    await expect(header(page)).toHaveAttribute('aria-expanded', 'true');
    await expect(nav(page).getByRole('button', { name: 'Notes' })).toBeVisible();
    expect(await stored(page)).toBe('false');
    // Each press on its own: two that flipped the kept choice would put it back.
    await header(page).click({ force: true });
    await expect(header(page)).toHaveAttribute('aria-expanded', 'true');
    expect(await stored(page)).toBe('false');
    await nav(page).getByRole('button', { name: 'Sessions' }).click();
    await expect(header(page)).toHaveAttribute('aria-expanded', 'false');
    await expect(nav(page).getByRole('button', { name: 'Notes' })).toHaveCount(0);
  });

  test('a page its extension does not list is not in the group', async ({ page }) => {
    await portal(page);
    await page.goto('/sessions');
    await expect(group(page).getByRole('button', { name: 'Notes' })).toBeVisible();
    await expect(group(page).getByRole('button', { name: 'Viewer' })).toHaveCount(0);
    await listViewer(page);
    await expect(group(page).getByRole('button', { name: 'Viewer' })).toBeVisible();
    await listViewer(page, false);
    await expect(group(page).getByRole('button', { name: 'Viewer' })).toHaveCount(0);
  });

  test('on the folded rail one button opens a menu of the pages, which are picked with the keys or the mouse', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('sidebarCollapsed', 'true'));
    await portal(page);
    await page.goto('/sessions');
    const rail = page.getByRole('navigation', { name: 'Destinations' });
    // Nothing of the portal's pages is among the rail's buttons for them: one button for all.
    await expect(rail.getByRole('button', { name: 'Notes' })).toHaveCount(0);
    const trigger = rail.getByRole('button', { name: 'Extensions' });
    await expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await expect(trigger).not.toHaveAttribute('aria-current', /.+/);
    // The puzzle is directly before Audit, which stays the last of the destinations.
    expect(await rail.getByRole('button').evaluateAll((items) => items.map((b) => b.getAttribute('aria-label')).slice(-3))).toEqual(['Extensions', 'Audit', 'Settings']);
    await listViewer(page);

    // Opened with Enter: the first page has the focus, and the arrows go round.
    await trigger.focus();
    await page.keyboard.press('Enter');
    const menu = page.getByRole('menu', { name: 'Extensions' });
    await expect(menu).toBeVisible();
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    const items = menu.getByRole('menuitem');
    await expect(items).toHaveText(['Notes', 'Viewer']);
    await expect(items.nth(0)).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(items.nth(1)).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(items.nth(0)).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await expect(items.nth(1)).toBeFocused();
    // Escape shuts it and the button has the focus again.
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');

    // Space opens it too, and Enter on a page goes there and shuts the menu.
    await page.keyboard.press('Space');
    await expect(menu).toBeVisible();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/x\/test-viewer\/viewer$/);
    await expect(page.getByText("The viewer's page")).toBeVisible();
    await expect(menu).toHaveCount(0);
    await expect(trigger).toHaveAttribute('aria-current', 'page');

    // With the mouse: the page showing is marked in the menu, a click picks another.
    await trigger.click();
    await expect(items.nth(1)).toHaveAttribute('aria-current', 'page');
    await expect(items.nth(1)).toBeFocused();
    await items.nth(0).click();
    await expect(page).toHaveURL(new RegExp(`${NOTES}$`));
    await expect(menu).toHaveCount(0);
    await expect(trigger).toHaveAttribute('aria-current', 'page');
    await rail.getByRole('button', { name: 'Sessions' }).click();
    await expect(trigger).not.toHaveAttribute('aria-current', /.+/);
  });

  test('on the rail Tab leaves the menu from the button\'s place, and the arrows go on when the page they are on is unlisted', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('sidebarCollapsed', 'true'));
    await portal(page);
    await page.goto('/sessions');
    const rail = page.getByRole('navigation', { name: 'Destinations' });
    const trigger = rail.getByRole('button', { name: 'Extensions' });
    const menu = page.getByRole('menu', { name: 'Extensions' });
    await expect(trigger).toBeVisible();
    await listViewer(page);

    // Tab goes on to the next button of the rail (Audit, which comes after the puzzle), Shift+Tab back to the one before: not to the start of the page.
    await trigger.focus();
    await page.keyboard.press('Enter');
    await expect(menu).toBeVisible();
    await page.keyboard.press('Tab');
    await expect(menu).toHaveCount(0);
    await expect(rail.getByRole('button', { name: 'Audit' })).toBeFocused();
    await trigger.focus();
    await page.keyboard.press('Enter');
    await expect(menu).toBeVisible();
    await page.keyboard.press('Shift+Tab');
    await expect(menu).toHaveCount(0);
    await expect(rail.getByRole('button', { name: 'Routines' })).toBeFocused();

    // The page the focus is on is unlisted: the focus is on the one now in its place, and Enter still picks.
    await trigger.focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('End');
    await expect(menu.getByRole('menuitem', { name: 'Viewer' })).toBeFocused();
    await listViewer(page, false);
    await expect(menu.getByRole('menuitem')).toHaveText(['Notes']);
    await expect(menu.getByRole('menuitem', { name: 'Notes' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(new RegExp(`${NOTES}$`));
  });

  test('on the rail a press outside the menu shuts it, and a page not listed is not in it', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('sidebarCollapsed', 'true'));
    await portal(page);
    await page.goto('/sessions');
    const trigger = page.getByRole('navigation', { name: 'Destinations' }).getByRole('button', { name: 'Extensions' });
    await trigger.click();
    const menu = page.getByRole('menu', { name: 'Extensions' });
    await expect(menu.getByRole('menuitem')).toHaveText(['Notes']);
    // Listed while it is open: it is added to the menu.
    await listViewer(page);
    await expect(menu.getByRole('menuitem')).toHaveText(['Notes', 'Viewer']);
    await page.mouse.click(700, 400);
    await expect(menu).toHaveCount(0);
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  test('on a phone the drawer has the group, folded and opened as on a wide screen', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    // The wide screen's choice to fold the sidebar to its rail does not follow into the drawer.
    await page.addInitScript(() => localStorage.setItem('sidebarCollapsed', 'true'));
    await portal(page);
    await page.goto('/sessions');
    await page.getByRole('button', { name: 'Open navigation' }).click();
    const drawer = page.getByRole('dialog', { name: 'Navigation' });
    await expect(drawer.getByRole('button', { name: 'Extensions' })).toHaveAttribute('aria-expanded', 'true');
    await drawer.getByRole('button', { name: 'Extensions' }).click();
    await expect(drawer.getByRole('button', { name: 'Notes' })).toHaveCount(0);
    await drawer.getByRole('button', { name: 'Extensions' }).click();
    await drawer.getByRole('button', { name: 'Notes' }).click();
    await expect(page).toHaveURL(new RegExp(`${NOTES}$`));
    await expect(page.getByRole('heading', { name: 'Notes' })).toBeVisible();
  });

  test.describe('in a browser set to German', () => {
    test.use({ locale: 'de-DE' });

    test("on a phone the bar at the top names the page shown as the sidebar does, in the extension's own words", async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 800 });
      await portal(page);
      await page.goto(NOTES);
      await expect(page.locator('.app-mobile-bar')).toHaveText('Notizen');
    });
  });
});

test.describe('with a slow extension first in the list', () => {
  // Viewer is listed first, and its module is not there for as long as the test says.
  test.use({ installed: ['tests/fixtures/extensions/viewer', 'tests/fixtures/extensions/notes'] });

  test('the pages of the others are in the group at once, and stay in the order of the list when the slow one comes', async ({ page }) => {
    let arrive!: () => void;
    const late = new Promise<void>((resolve) => { arrive = resolve; });
    await page.route('**/api/extension-ui/test-viewer/client.js*', async (route) => { await late; await route.fallback(); });
    await portal(page);
    await page.goto('/sessions');
    await expect(group(page).getByRole('button', { name: 'Notes' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Viewer' })).toHaveCount(0);
    arrive();
    await expect.poll(() => page.evaluate(() => typeof (window as any).viewerListed)).toBe('function');
    await listViewer(page);
    // Viewer came into the page last, and is listed first all the same: that is the order the server lists them in.
    await expect(group(page).getByRole('button')).toHaveText(['Viewer', 'Notes']);
  });
});

test.describe('without extension pages', () => {
  test('there is no group in the sidebar and no button on the rail', async ({ page }) => {
    await portal(page);
    await page.goto('/sessions');
    await expect(nav(page).getByRole('button', { name: 'Audit' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Extensions' })).toHaveCount(0);
    await page.evaluate(() => localStorage.setItem('sidebarCollapsed', 'true'));
    await page.reload();
    await expect(page.getByRole('navigation', { name: 'Destinations' }).getByRole('button', { name: 'Audit' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Extensions' })).toHaveCount(0);
  });
});
