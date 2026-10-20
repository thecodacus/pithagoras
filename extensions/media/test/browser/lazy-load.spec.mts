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
  });
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
