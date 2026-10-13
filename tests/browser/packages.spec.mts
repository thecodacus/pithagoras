import { type Page } from '@playwright/test';
import { test, expect, mockPortal } from './portal-mock';

/**
 * Enter in the field that names a package: it must not start a second install
 * while the first runs, which the disabled button already prevented for a click.
 * Over canned answers; the install does not end until it is let go.
 */
async function portal(page: Page, answers: Record<string, unknown>) {
  const posts: string[] = [];
  let release = () => {};
  const held = new Promise<void>((r) => (release = r));
  await mockPortal(page, async ({ path, method, route }) => {
    if (method === 'POST' && (path === '/api/packages' || path === '/api/channel-packages')) {
      posts.push(`${path} ${route.request().postData()}`);
      await held;
      return { ok: true, output: '' };
    }
    return answers[path];
  }, { settings: true });
  return { posts, release };
}

test('Enter twice in the package field is one install', async ({ page }) => {
  const { posts, release } = await portal(page, { '/api/extensions': { settingsPath: '/a/settings.json', extensions: [] } });
  await page.goto('/settings/extensions');
  await page.getByRole('tab', { name: 'Discover' }).click();
  const field = page.getByPlaceholder('npm:@scope/package');
  await field.fill('npm:pi-thing');
  await field.press('Enter');
  await expect(page.getByRole('button', { name: 'Installing…' })).toBeDisabled();
  await field.press('Enter');
  await field.press('Enter');
  release();
  await expect(page.getByRole('button', { name: 'Install', exact: true })).toBeVisible();
  expect(posts).toEqual(['/api/packages {"spec":"npm:pi-thing"}']);
});

test('Enter twice in the channel package field is one install', async ({ page }) => {
  const { posts, release } = await portal(page, {
    '/api/channels': { channels: [], kinds: [], broken: [], channelsDir: '/a/channels' },
  });
  await page.goto('/settings/channels');
  const field = page.getByPlaceholder('user/repo');
  await field.fill('user/repo');
  await field.press('Enter');
  await expect(page.getByRole('button', { name: 'Installing…' })).toBeDisabled();
  await field.press('Enter');
  await field.press('Enter');
  release();
  await expect(page.getByRole('button', { name: 'Install', exact: true })).toBeVisible();
  expect(posts).toEqual(['/api/channel-packages {"spec":"user/repo"}']);
});

const ext = (name: string, homepage: string) => ({ name, spec: `npm:${name}`, enabled: true, description: '', homepage, settings: [{ key: 'token', value: '', configured: false }] });

test('a package\'s homepage is a link only when it goes to a web page', async ({ page }) => {
  await portal(page, {
    '/api/extensions': { settingsPath: '/a/settings.json', extensions: [ext('pi-web', 'https://example.test/pi-web'), ext('pi-evil', "javascript:alert(document.domain)")] },
  });
  await page.goto('/settings/extensions');
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  const configure = (name: string) => dialog.getByRole('listitem').filter({ hasText: `npm:${name}` }).getByRole('button', { name: /^Configure/ });
  await configure('pi-web').click();
  await expect(dialog.getByRole('link', { name: 'Homepage' })).toHaveAttribute('href', 'https://example.test/pi-web');
  await page.goto('/settings/extensions');
  await configure('pi-evil').click();
  await expect(dialog.getByRole('heading', { name: 'pi-evil' })).toBeVisible();
  await expect(dialog.getByRole('link', { name: 'Homepage' })).toHaveCount(0);
});
