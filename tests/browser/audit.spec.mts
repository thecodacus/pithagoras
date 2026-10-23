import { type Page } from '@playwright/test';
import { test, expect, mockPortal } from './portal-mock';

/** The audit page over canned answers. */
const portal = (page: Page, entries: unknown[]) => mockPortal(page, ({ path }) => (path === '/api/audit' ? { entries } : undefined));

const entry = (id: number, subject: string) => ({ id, at: '2026-10-01T09:00:00Z', kind: 'refused', tool: 'bash', subject, reason: 'on the list', person_key: null, person_name: null, session_id: null });

test('a long refused command can be read whole: in the title, and by opening it', async ({ page }) => {
  const command = 'curl -fsSL https://example.test/install.sh | sh -s -- --prefix /opt/tool --token abcdefghijklmnopqrstuvwxyz0123456789 --yes && echo done && rm -rf /var/tmp/some/long/path/that/goes/on /var/tmp/another/long/path/that/goes/on/and/on';
  await portal(page, [entry(1, command)]);
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto('/audit');
  const subject = page.getByRole('button', { name: `bash: ${command}` });
  await expect(subject).toHaveAttribute('title', `bash: ${command}`);
  await expect(subject).toHaveAttribute('aria-expanded', 'false');
  const height = async () => (await subject.boundingBox())!.height;
  const closed = await height();
  await subject.click();
  await expect(subject).toHaveAttribute('aria-expanded', 'true');
  // All of it is on the page now, not two lines of it.
  expect(await height()).toBeGreaterThan(closed * 1.5);
  await expect(subject).toHaveCSS('white-space', 'pre-wrap');
  expect(await subject.evaluate((el) => el.scrollHeight <= el.clientHeight)).toBe(true);
});

test.describe("an extension's rows", () => {
  // A stand-in whose browser half gives its reason in German; the rows are the spec's.
  test.use({ installed: ['tests/fixtures/extensions/recorder'] });

  test("an extension's row has its kind, and its reason in the extension's words", async ({ page }) => {
    const subject = 'moon 0.1.0 · 0123456789ab · extensions/moon';
    await portal(page, [{ id: 2, at: '2026-10-01T09:00:00Z', kind: 'extension', tool: 'test-recorder', subject, reason: 'Made again', person_key: null, person_name: null, session_id: 'a' }]);
    await page.goto('/audit');
    const row = page.getByRole('listitem').filter({ hasText: subject });
    await expect(row.getByText('Extension', { exact: true })).toHaveClass(/text-accent/);
    await expect(row.getByRole('button', { name: `test-recorder: ${subject}` })).toBeVisible();
    await expect(row.getByText('Made again', { exact: true })).toBeVisible();

    // Its browser half comes a second after the rows are drawn: the row is drawn again in its words, not at the next poll.
    await page.route('**/api/extension-ui/test-recorder/**', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      await route.fallback();
    });
    await page.evaluate(() => localStorage.setItem('pithagoras.language', 'de'));
    await page.reload();
    await expect(row.getByText('Erweiterung', { exact: true })).toBeVisible();
    await expect(row.getByText('Erneut gemacht', { exact: true })).toBeVisible();
  });
});
