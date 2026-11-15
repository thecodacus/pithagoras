import { test, expect } from './portal-mock';

/**
 * The chat view reads a chat from the kernel's stores and acts through its controller, and shares both with every other
 * part of the page that reads them (kernel/). The page is `core/web/tests/kernel.tsx`: the chat view, and two parts
 * that read the same chat as an interface of its own would.
 */
test.beforeEach(async ({ page }) => {
  await page.route('**/api/sessions/one/background', (route) => route.fulfill({ json: { supported: true, jobs: [], statuses: [], widgets: [] } }));
  await page.route('**/api/sessions/one/modes', (route) => route.fulfill({ json: { modes: [] } }));
});

test('every part that reads a chat from the kernel sees the same snapshot, the chat view included', async ({ page }) => {
  await page.goto('/tests/kernel.html');
  await expect(page.getByTestId('probe-a')).toContainText('a: 1 events');
  await expect(page.getByTestId('probe-b')).toContainText('b: 1 events');
  await expect(page.getByText('Hello from before')).toBeVisible();
  // What the chat's stream says is put in the store once: all three show it, and the two probes hold the one array.
  await page.evaluate(() => (window as any).say('A second thing'));
  await expect(page.getByTestId('probe-a')).toContainText('a: 2 events');
  await expect(page.getByTestId('probe-b')).toContainText('b: 2 events');
  await expect(page.getByText('A second thing')).toBeVisible();
  expect(await page.evaluate(() => (window as any).same)).toBe(true);
});

test("what is typed in the chat's box is the kernel's draft, and what another part writes there is in the box", async ({ page }) => {
  await page.goto('/tests/kernel.html');
  const box = page.getByRole('textbox').last();
  await box.fill('half a message');
  await expect(page.getByTestId('probe-a')).toContainText('draft “half a message”');
  await expect(page.getByTestId('probe-b')).toContainText('draft “half a message”');
  expect(await page.evaluate(() => (window as any).drafts())).toBe('half a message');
  await page.evaluate(() => (window as any).type('written elsewhere'));
  await expect(box).toHaveValue('written elsewhere');
  await expect(page.getByTestId('probe-b')).toContainText('draft “written elsewhere”');
});

test("sending goes through the chat's controller, and the box is emptied for the kernel and for every part", async ({ page }) => {
  await page.goto('/tests/kernel.html');
  const box = page.getByRole('textbox').last();
  await box.fill('Do the thing');
  await box.press('Enter');
  await expect.poll(() => page.evaluate(() => (window as any).sent)).toEqual(['Do the thing']);
  await expect(box).toHaveValue('');
  await expect(page.getByTestId('probe-a')).toContainText('draft “”');
  expect(await page.evaluate(() => (window as any).drafts())).toBe('');
});
