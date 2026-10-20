import { type Page } from '@playwright/test';
import { test, expect, mockPortal } from '../../../../tests/browser/portal-mock';

test.use({ installed: ['extensions/media'] });

/**
 * The Media page (src/web/MediaPage.tsx, a chunk of its own) is fetched when it is opened, not with the shell and the
 * chat, and neither is its page in Settings.
 */
const at = new Date().toISOString();
const chat = { id: 'a', title: 'Chat A', workspace: '/w/site', status: 'idle', kind: 'task', pinned: false, updated_at: at, created_at: at, provider: null, model: null, thinking_level: null };

async function portal(page: Page) {
  await mockPortal(page, ({ path }) => {
    // Settings lists the extension as the portal has it installed.
    if (path === '/api/extensions') return { settingsPath: '/a/settings.json', extensions: [{ spec: 'extensions/media', name: 'pithagoras-media', version: '0.1.0', settings: [] }] };
    if (path === '/api/sessions') return { sessions: [chat], executor: 'host' };
    if (/^\/api\/sessions\/\w+$/.test(path)) return chat;
    if (path.endsWith('/config')) return { live: false, state: null, stats: null, thinking: { levels: [] }, models: { models: [] }, named: { provider: null, model: null } };
    if (path === '/api/workspaces') return { root: '/w', workspaces: [] };
    if (path === '/api/models') return { models: [], providers: {} };
    // Pictures can be made: the page is in the sidebar.
    if (path === '/api/x/pithagoras-media/state') return { images: { enabled: true }, videos: { enabled: false } };
    if (path === '/api/x/pithagoras-media/settings/images') return { images: { enabled: true, baseUrl: 'https://images.example.com/v1', model: '', size: '', keySet: false, editEnabled: false, editBaseUrl: '', editModel: '', editMultiple: false, editMaxSize: '', editKeySet: false, timeoutSeconds: 300, sdExtras: false, ready: true, editReady: false } };
    if (path === '/api/x/pithagoras-media/images') return { pictures: [], next: null, total: 0, pageBytes: 0 };
    if (path === '/api/x/pithagoras-media/images/jobs') return { jobs: [], limit: 4 };
    if (path === '/api/x/pithagoras-media/settings/videos') return { videos: { enabled: false, backend: 'sdcpp', backends: [{ id: 'sdcpp', label: 'stable-diffusion.cpp' }], baseUrl: '', model: '', size: '', frames: null, fps: null, keySet: false, timeoutSeconds: 1800, storageLimitMb: 0, ready: false } };
  }, { settings: true });
  const files: string[] = [];
  page.on('request', (r) => files.push(new URL(r.url()).pathname));
  return files;
}

/** The extension's pages, each built into a chunk of its own. */
const PAGES = /\/api\/extension-ui\/pithagoras-media\/chunks\/(MediaPage|MediaPanel)-[^/]+\.js$/;

test('the first draw does not fetch the Media page, and it is fetched when it is opened', async ({ page }) => {
  const files = await portal(page);
  await page.goto('/s/a');
  const entry = page.getByRole('complementary', { name: 'Sidebar' }).getByRole('button', { name: 'Media' });
  await expect(entry).toBeVisible();
  expect(files.filter((f) => PAGES.test(f))).toEqual([]);

  await entry.click();
  await expect(page).toHaveURL(/\/x\/pithagoras-media\/media$/);
  await expect(page.getByRole('heading', { name: 'Media' })).toBeVisible();
  // Only that one.
  expect(files.filter((f) => PAGES.test(f)).map((f) => f.split('/').pop()!.split('-')[0])).toEqual(['MediaPage']);
});

/** Holds back the fetch of the extension's page `name` until the test lets it go. */
async function slow(page: Page, name: 'MediaPage' | 'MediaPanel') {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  await page.route((url) => PAGES.test(url.pathname) && url.pathname.includes(`/${name}-`), async (route) => {
    await gate;
    await route.fallback();
  });
  return release;
}

test('while the Media page is fetched, the page says it is loading', async ({ page }) => {
  await portal(page);
  const release = await slow(page, 'MediaPage');
  await page.goto('/s/a');
  await page.getByRole('complementary', { name: 'Sidebar' }).getByRole('button', { name: 'Media' }).click();
  await expect(page).toHaveURL(/\/x\/pithagoras-media\/media$/);
  await expect(page.getByText('Loading…')).toBeVisible();
  release();
  await expect(page.getByRole('heading', { name: 'Media' })).toBeVisible();
  await expect(page.getByText('Loading…')).toHaveCount(0);
});

test('while Media\'s page in Settings is fetched, it says it is loading', async ({ page }) => {
  await portal(page);
  const release = await slow(page, 'MediaPanel');
  await page.goto('/settings/x/pithagoras-media');
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await expect(settings.getByText('Loading…')).toBeVisible();
  release();
  await expect(settings.getByRole('region', { name: 'Video model' })).toBeVisible();
});
