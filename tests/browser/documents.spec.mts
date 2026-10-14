import { readFileSync } from 'node:fs';
import { type Page } from '@playwright/test';
import { test, expect, mockPortal, reply, DONE } from './portal-mock';

/**
 * The Documents extension's page: its own browser half (extensions/docs/web),
 * loaded into the app as the portal serves it, with what its server half
 * would answer.
 */
const NAME = 'pithagoras-docs';
const web = (file: string) => readFileSync(new URL(`../../extensions/docs/web/${file}`, import.meta.url), 'utf8');
const address = (file: string) => `/api/extension-ui/${NAME}/${file}`;

const PLAN = [
  '# The plan',
  '',
  'Ship it on **Friday**.',
  '',
  '| Step | Who |',
  '| --- | --- |',
  '| Build | Agent |',
  '',
  '```bash',
  'npm run build',
  '```',
  '',
].join('\n');

const FOLDERS = [
  {
    id: '0123456789abcdef', name: 'site', path: '/w/site', chats: [{ id: 'a', title: 'First chat' }],
    documents: [
      { id: '1111111111111111', name: 'plan.md', title: 'The plan', revision: 3, size: PLAN.length, modified: '2026-10-01T09:30:00.000Z' },
      { id: '2222222222222222', name: 'release notes.md', title: 'Release notes', revision: 1, size: 40, modified: '2026-10-02T09:30:00.000Z' },
    ],
  },
  { id: 'fedcba9876543210', name: 'tools', path: '/w/tools', chats: [{ id: 'b', title: 'Second chat' }], documents: [{ id: '3333333333333333', name: 'setup.md', title: 'Setting up', revision: 1, size: 20, modified: '2026-10-03T09:30:00.000Z' }] },
];

async function portal(page: Page, folders: unknown[] = FOLDERS) {
  const at = new Date().toISOString();
  const sessions = [{ id: 'a', title: 'First chat', workspace: '/w/site', status: 'idle', kind: 'task', pinned: false, updated_at: at, provider: null, model: null, thinking_level: null }];
  /** The documents the page asked for, as their addresses. */
  const asked: string[] = [];
  await mockPortal(page, async ({ path: p, route }) => {
    if (p === '/api/extension-ui') return { extensions: [{ name: NAME, version: '0.1.0', entry: address('client.js') + '?v=1', style: address('client.css') + '?v=1', server: `/api/x/${NAME}` }] };
    if (p === address('client.js')) { await route.fulfill({ contentType: 'text/javascript', body: web('client.js') }); return DONE; }
    if (p === address('client.css')) { await route.fulfill({ contentType: 'text/css', body: web('client.css') }); return DONE; }
    if (p === `/api/x/${NAME}/folders`) return { folders };
    if (p.startsWith(`/api/x/${NAME}/folders/`)) {
      asked.push(p);
      if (p === `/api/x/${NAME}/folders/0123456789abcdef/documents/1111111111111111`) return { id: '1111111111111111', name: 'plan.md', title: 'The plan', revision: 3, markdown: PLAN, modified: '2026-10-01T09:30:00.000Z' };
      return reply(404, { error: 'There is no such document' });
    }
    if (p === '/api/sessions') return { sessions, executor: 'host' };
    if (p === '/api/models') return { models: [], providers: {} };
  });
  return { asked };
}

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Destinations' });

test('the Documents page is in the sidebar and lists each folder\'s documents, and a document opens as the portal draws Markdown', async ({ page }) => {
  const { asked } = await portal(page);
  await page.goto(`/x/${NAME}/documents`);
  await expect(page.getByRole('heading', { name: 'Documents', exact: true })).toBeVisible();
  await expect(sidebar(page).getByRole('button', { name: 'Documents' })).toHaveAttribute('aria-current', 'page');

  // One section per folder, named as the folder is, with its documents by title.
  const site = page.getByRole('region', { name: 'site' });
  await expect(site).toContainText('/w/site');
  await expect(site.getByRole('listitem')).toHaveText([/^The plan\s*plan\.md · Changed /, /^Release notes\s*release notes\.md · Changed /]);
  await expect(page.getByRole('region', { name: 'tools' }).getByRole('listitem')).toHaveText([/^Setting up\s*setup\.md/]);

  await site.getByRole('button', { name: /The plan/ }).click();
  // Rendered, not shown as its source.
  await expect(page.getByRole('heading', { name: 'The plan', level: 1 })).toBeVisible();
  await expect(page.getByText('Ship it on Friday.', { exact: true })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Agent' })).toBeVisible();
  await expect(page.getByText('npm run build')).toBeVisible();
  await expect(page.getByText(/^documents\/plan\.md · Changed /)).toBeVisible();
  await expect(page.getByText('**Friday**')).toHaveCount(0);

  await page.getByRole('button', { name: /All documents/ }).click();
  await expect(page.getByRole('region', { name: 'site' })).toBeVisible();
  // A document is asked for by its id, never by its file's name; one that is gone says so.
  await page.getByRole('region', { name: 'site' }).getByRole('button', { name: /Release notes/ }).click();
  await expect(page.getByRole('alert')).toContainText('There is no such document');
  // Development React runs each effect twice, and each asks.
  expect([...new Set(asked)]).toEqual([`/api/x/${NAME}/folders/0123456789abcdef/documents/1111111111111111`, `/api/x/${NAME}/folders/0123456789abcdef/documents/2222222222222222`]);
});

test('the Documents page says when no folder has documents', async ({ page }) => {
  await portal(page, []);
  await page.goto('/');
  await sidebar(page).getByRole('button', { name: 'Documents' }).click();
  await expect(page).toHaveURL(new RegExp(`/x/${NAME}/documents$`));
  await expect(page.getByText('No folder has documents yet.', { exact: false })).toBeVisible();
});
