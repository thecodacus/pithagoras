import { test, expect, mockPortal } from './portal-mock';

/**
 * Code mode in the tool lists: one box called Code mode, in the chat's tools control beside the other switches and
 * in Settings → Tools. A chat starts with it off, and switching it on there is that chat's own choice.
 */

test("a chat's tools control has Code mode, off, and switching it on sends the chat's tools without it", async ({ page }) => {
  await page.setViewportSize({ width: 1300, height: 800 });
  await page.goto('/tests/chat.html?phase=codemode');
  await page.getByRole('button', { name: 'Which tools this conversation may use' }).click();
  const menu = page.locator('.composer-menu');
  const box = menu.getByRole('button', { name: /^Code mode/ });
  await expect(box).toHaveCount(1);
  await expect(box).toContainText('1 off');
  // Not under the name of the extension that registered it.
  await expect(menu.getByText('codemode', { exact: true })).toBeHidden();
  await box.click();
  const tick = menu.getByRole('checkbox', { name: 'codemode' });
  const row = menu.locator('label').filter({ has: page.getByRole('checkbox', { name: 'codemode' }) });
  await expect(tick).not.toBeChecked();
  // What it does, for a person: not the model's instructions for writing a script.
  await row.hover();
  await expect(page.locator('.ui-tooltip')).toHaveText(/^Lets the model write a script that calls the other tools/);
  await tick.check();
  await expect.poll(() => page.evaluate(() => (window as any).sentTools)).toEqual([[]]);
  await expect(box).toContainText('1 on');
  // On where the default has it off, which the row says.
  await expect(row).toContainText('default off');
});

test('Settings → Tools lists Code mode as its own box, off by default', async ({ page }) => {
  const puts: string[][] = [];
  const off = ['codemode'];
  await mockPortal(page, async ({ path, method, json }) => {
    if (path === '/api/tools' && method === 'GET') return {
      tools: [
        { name: 'codemode', source: 'codemode', inline: true, defaultOn: false },
        { name: 'bash', source: 'built in', defaultOn: true },
      ],
      off, names: {},
    };
    if (path === '/api/tools' && method === 'PUT') {
      puts.push(json().off);
      return { off: json().off, applied: 0 };
    }
  }, { settings: true });
  await page.addInitScript(() => localStorage.removeItem('toolGroupsOpen'));
  await page.goto('/settings/tools');
  const box = page.getByRole('button', { name: /^Code mode/ });
  await expect(box).toContainText('1 off');
  await box.click();
  await page.getByRole('checkbox', { name: 'codemode' }).check();
  await expect.poll(() => puts).toEqual([[]]);
});
