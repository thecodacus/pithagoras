import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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

// A document opens in the editor, which `npm run build` builds (extensions/docs/build.mjs).
test.beforeAll(() => {
  execFileSync(process.execPath, [fileURLToPath(new URL('../../extensions/docs/build.mjs', import.meta.url))], { stdio: 'ignore' });
});

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

async function portal(page: Page, folders: unknown[] = FOLDERS, streams: 'idle' | 'open' = 'idle', problems: unknown[] = []) {
  const at = new Date().toISOString();
  const sessions = [{ id: 'a', title: 'First chat', workspace: '/w/site', status: 'idle', kind: 'task', pinned: false, updated_at: at, provider: null, model: null, thinking_level: null }];
  /** The documents the page asked for, as their addresses. */
  const asked: string[] = [];
  await mockPortal(page, async ({ path: p, route }) => {
    if (p === '/api/extension-ui') return { extensions: [{ name: NAME, version: '0.1.0', entry: address('client.js') + '?v=1', style: address('client.css') + '?v=1', server: `/api/x/${NAME}` }] };
    // The folder the portal serves of the package: its modules, the editor among them, and its stylesheet.
    if (p.startsWith(address(''))) { await route.fulfill({ contentType: p.endsWith('.css') ? 'text/css' : 'text/javascript', body: web(p.slice(address('').length)) }); return DONE; }
    if (p === `/api/x/${NAME}/folders`) return { folders, ...(problems.length ? { problems } : {}) };
    if (p.startsWith(`/api/x/${NAME}/folders/`)) {
      // The comments on a document are asked for with it, and are none.
      if (p.endsWith('/threads')) return { revision: 3, threads: [] };
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

test('the Documents page is in the sidebar and lists each folder\'s documents, and a document opens in the editor', async ({ page }) => {
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
  // Drawn as it reads, not shown as its source.
  await expect(page.getByRole('heading', { name: 'The plan', level: 1 })).toBeVisible();
  await expect(page.getByText('Ship it on Friday.', { exact: true })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Agent' })).toBeVisible();
  await expect(page.getByText('npm run build')).toBeVisible();
  await expect(page.getByText('documents/plan.md', { exact: true })).toBeVisible();
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

/** Folders whose documents the server half could not open, as it says them. */
const PROBLEMS = [
  { id: 'aaaaaaaaaaaaaaaa', name: 'broken', path: '/w/broken', error: 'The history of the documents could not be used: git update-ref failed (128): fatal: cannot lock ref (the store is /data/extension-data/pithagoras-docs/aaaaaaaaaaaaaaaa)' },
  { id: 'bbbbbbbbbbbbbbbb', name: 'locked', path: '/w/locked', error: "The portal is not allowed to read this folder's documents folder (permission denied)" },
];

test('a folder whose documents could not be opened is said, with the reason, beside the folders that could, and where there is no other it is not called empty', async ({ page }) => {
  await portal(page, FOLDERS, 'idle', PROBLEMS);
  await page.goto(`/x/${NAME}/documents`);
  const alerts = page.getByRole('alert');
  await expect(alerts).toHaveCount(2);
  await expect(alerts.first()).toHaveText('The documents in /w/broken could not be opened: The history of the documents could not be used: git update-ref failed (128): fatal: cannot lock ref (the store is /data/extension-data/pithagoras-docs/aaaaaaaaaaaaaaaa)');
  await expect(alerts.nth(1)).toHaveText("The documents in /w/locked could not be opened: The portal is not allowed to read this folder's documents folder (permission denied)");
  // The folders that could be opened are there as they were.
  await expect(page.getByRole('region', { name: 'site' }).getByRole('listitem')).toHaveCount(2);
  await expect(page.getByRole('region', { name: 'tools' })).toBeVisible();
});

test('with no folder that could be opened, the reasons are what the page says, and not that no folder has documents', async ({ page }) => {
  await portal(page, [], 'idle', PROBLEMS);
  await page.goto(`/x/${NAME}/documents`);
  await expect(page.getByRole('alert')).toHaveCount(2);
  await expect(page.getByText('No folder has documents yet.', { exact: false })).toHaveCount(0);
});

test('the reasons a folder could not be opened are in German in a German portal', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('pithagoras.language', 'de'));
  await portal(page, [], 'idle', PROBLEMS.slice(1));
  await page.goto(`/x/${NAME}/documents`);
  await expect(page.getByRole('alert')).toHaveText("Die Dokumente in /w/locked konnten nicht geöffnet werden: The portal is not allowed to read this folder's documents folder (permission denied)");
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

test('a comment, a reply, a resolved thread and an edit that answers a comment are drawn as what became of the document, in English and in German', async ({ page }) => {
  await page.setViewportSize({ width: 1300, height: 800 });
  const { caughtUp, calls } = await portal(page, FOLDERS, 'open');
  await page.goto('/s/a');
  await caughtUp();
  const thread = 'abcdef0123456789';
  await calls('k1', 'doc_comment', { id: PLAN_AT.id, quote: 'Friday', comment: 'Why?' }, 'Commented', { ...PLAN_AT, action: 'comment', revision: 3, thread });
  await calls('k2', 'doc_reply', { id: PLAN_AT.id, thread, comment: 'Done.' }, 'Replied', { ...PLAN_AT, action: 'reply', revision: 3, thread });
  await calls('k3', 'doc_resolve', { id: PLAN_AT.id, thread }, 'Resolved', { ...PLAN_AT, action: 'resolve', revision: 3, thread, changed: true });
  await calls('k4', 'doc_edit', { id: PLAN_AT.id, thread }, 'Edited', { ...PLAN_AT, action: 'edit', revision: 4, from: 3, edits: 1, changed: true, thread, replied: true });
  const cards = page.locator('.tool-row .pd-call');
  await expect(cards).toHaveCount(4);
  await expect(cards.nth(0)).toContainText('Commented on a document');
  await expect(cards.nth(0)).toContainText('documents/plan.md · Revision 3');
  await expect(cards.nth(1)).toContainText('Replied to a comment');
  await expect(cards.nth(2)).toContainText('Resolved a comment');
  await expect(cards.nth(3)).toContainText('Edited a document');
  await expect(cards.nth(3)).toContainText('documents/plan.md · Revision 3 to 4 · 1 edit · answers a comment');
  await expect(cards.nth(0).getByRole('button', { name: 'Open in Documents' })).toBeVisible();
});

test('the cards of the agent\'s comments are in German in a German portal', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('pithagoras.language', 'de'));
  await page.setViewportSize({ width: 1300, height: 800 });
  const { caughtUp, calls } = await portal(page, FOLDERS, 'open');
  await page.goto('/s/a');
  await caughtUp();
  const thread = 'abcdef0123456789';
  await calls('k1', 'doc_comment', { id: PLAN_AT.id }, 'Commented', { ...PLAN_AT, action: 'comment', revision: 3, thread });
  await calls('k2', 'doc_reply', { id: PLAN_AT.id }, 'Replied', { ...PLAN_AT, action: 'reply', revision: 3, thread });
  await calls('k3', 'doc_resolve', { id: PLAN_AT.id }, 'Resolved', { ...PLAN_AT, action: 'resolve', revision: 3, thread });
  await calls('k4', 'doc_edit', { id: PLAN_AT.id }, 'Edited', { ...PLAN_AT, action: 'edit', revision: 4, from: 3, edits: 1, changed: true, thread });
  const cards = page.locator('.tool-row .pd-call');
  await expect(cards.nth(0)).toContainText('Dokument kommentiert');
  await expect(cards.nth(1)).toContainText('Auf einen Kommentar geantwortet');
  await expect(cards.nth(2)).toContainText('Kommentar erledigt');
  await expect(cards.nth(3)).toContainText('documents/plan.md · Revision 3 auf 4 · 1 Änderung · beantwortet einen Kommentar');
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
