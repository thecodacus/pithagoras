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

async function portal(page: Page, folders: unknown[] = FOLDERS, streams: 'idle' | 'open' = 'idle') {
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
    if (/^\/api\/sessions\/\w+$/.test(p)) return sessions[0];
    if (/^\/api\/sessions\/\w+\/(config|models)$/.test(p)) return { live: false, state: { model: null, thinkingLevel: 'medium' }, stats: null, thinking: { levels: ['off', 'medium'] }, models: { models: [] }, named: { provider: null, model: null } };
    if (p.endsWith('/canvases')) return [];
  }, { streams });
  /** Something the chat's pi said, as the chat's stream carries it. */
  let seq = 100;
  const says = (type: string, payload: unknown) =>
    page.evaluate(([event]) => (window as any).streams.find((s: any) => !s.closed && s.url.includes('/api/sessions/a/events')).emit('message', event), [{ seq: ++seq, type, at: Date.now(), payload }] as const);
  /** The chat's stream has sent what there was: from here what its pi says is shown as it comes. */
  const caughtUp = async () => {
    await page.waitForFunction(() => (window as any).streams?.some((s: any) => !s.closed && s.url.includes('/api/sessions/a/events')));
    await page.evaluate(() => (window as any).streams.find((s: any) => !s.closed && s.url.includes('/api/sessions/a/events')).emit('caught-up', {}));
  };
  /** A call of a tool, from its start to its end. */
  const calls = async (callId: string, toolName: string, args: unknown, text: string, details?: unknown, isError = false) => {
    await says('tool_execution_start', { toolCallId: callId, toolName, args });
    await says('tool_execution_end', { toolCallId: callId, toolName, isError, result: { content: [{ type: 'text', text }], ...(details ? { details } : {}) } });
  };
  return { asked, says, caughtUp, calls };
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

/** What the agent's tools report of a document they named, as the server half's tools give it. */
const PLAN_AT = { folder: '0123456789abcdef', id: '1111111111111111', name: 'plan.md', path: 'documents/plan.md', title: 'The plan', scope: 'project' };

test('a call of one of the agent\'s document tools is drawn as what became of the document, with a way to read it on the page', async ({ page }) => {
  await page.setViewportSize({ width: 1300, height: 800 });
  const { says, caughtUp, calls, asked } = await portal(page, FOLDERS, 'open');
  await page.goto('/s/a');
  await caughtUp();
  await says('tool_execution_start', { toolCallId: 'e1', toolName: 'doc_edit', args: { id: PLAN_AT.id, expected_revision: 2, edits: [{ quote: 'a', replacement: 'b' }, { quote: 'c', replacement: 'd' }] } });
  // While it runs the portal's own card says it best.
  await expect(page.locator('.tool-row')).toHaveCount(1);
  await expect(page.locator('.pd-call')).toHaveCount(0);
  await says('tool_execution_end', { toolCallId: 'e1', toolName: 'doc_edit', isError: false, result: { content: [{ type: 'text', text: 'Edited "The plan"' }], details: { ...PLAN_AT, action: 'edit', revision: 3, from: 2, edits: 2, changed: true } } });
  const edited = page.locator('.tool-row .pd-call').first();
  await expect(edited).toContainText('Edited a document');
  await expect(edited).toContainText('The plan');
  await expect(edited).toContainText('documents/plan.md · Revision 2 to 3 · 2 edits');

  await calls('e2', 'doc_edit', { id: PLAN_AT.id }, 'No change', { ...PLAN_AT, action: 'edit', revision: 3, from: 3, edits: 1, changed: false });
  await expect(page.locator('.pd-call').nth(1)).toContainText('documents/plan.md · No change · 1 edit');
  await calls('c1', 'doc_create', { title: 'The plan' }, 'Created', { ...PLAN_AT, action: 'create', revision: 1 });
  await expect(page.locator('.pd-call').nth(2)).toContainText('Created a document');
  await expect(page.locator('.pd-call').nth(2)).toContainText('documents/plan.md · Revision 1');
  await calls('r1', 'doc_read', { id: PLAN_AT.id, revision: 1 }, 'text', { ...PLAN_AT, action: 'read', revision: 1, current: 3 });
  await expect(page.locator('.pd-call').nth(3)).toContainText('Read a document');
  await expect(page.locator('.pd-call').nth(3)).toContainText('Revision 1 · an earlier revision, the document is at 3');
  // A refusal, and a list, are the portal's own cards: nothing there to open.
  await calls('e3', 'doc_edit', { id: PLAN_AT.id }, 'revision_mismatch: "The plan" is at revision 4, not 3', undefined, true);
  await calls('l1', 'doc_list', {}, '1 document:\n- 1111111111111111  "The plan"', { action: 'list', documents: [] });
  await expect(page.locator('.tool-row')).toHaveCount(6);
  await expect(page.locator('.pd-call')).toHaveCount(4);

  // Open in Documents: the page, with that document open, asked for by its id.
  await edited.getByRole('button', { name: 'Open in Documents' }).click();
  await expect(page).toHaveURL(`/x/${NAME}/documents?folder=0123456789abcdef&doc=1111111111111111`);
  await expect(page.getByRole('heading', { name: 'The plan', level: 1 })).toBeVisible();
  await expect(page.getByText('Ship it on Friday.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /All documents/ })).toBeVisible();
  expect([...new Set(asked)]).toEqual([`/api/x/${NAME}/folders/0123456789abcdef/documents/1111111111111111`]);
  await page.getByRole('button', { name: /All documents/ }).click();
  await expect(page.getByRole('region', { name: 'site' })).toBeVisible();
});

test('the agent\'s document cards are in German in a German portal', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('pithagoras.language', 'de'));
  await page.setViewportSize({ width: 1300, height: 800 });
  const { caughtUp, calls } = await portal(page, FOLDERS, 'open');
  await page.goto('/s/a');
  await caughtUp();
  await calls('e1', 'doc_edit', { id: PLAN_AT.id }, 'Edited', { ...PLAN_AT, action: 'edit', revision: 3, from: 2, edits: 1, changed: true });
  const card = page.locator('.tool-row .pd-call');
  await expect(card).toContainText('Dokument bearbeitet');
  await expect(card).toContainText('documents/plan.md · Revision 2 auf 3 · 1 Änderung');
  await expect(card.getByRole('button', { name: 'In Dokumenten öffnen' })).toBeVisible();
});
