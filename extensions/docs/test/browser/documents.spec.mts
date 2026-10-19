import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { type Page } from '@playwright/test';
import { test, expect, mockPortal, reply, DONE } from '../../../../tests/browser/portal-mock';

/**
 * The Documents extension's page: its own browser half (extensions/docs/web),
 * loaded into the app as the portal serves it, with what its server half
 * would answer.
 */
const NAME = 'pithagoras-docs';
const web = (file: string) => readFileSync(new URL(`../../web/${file}`, import.meta.url), 'utf8');
const address = (file: string) => `/api/extension-ui/${NAME}/${file}`;

// A document opens in the editor, which `npm run build` builds (extensions/docs/build.mjs).
test.beforeAll(() => {
  execFileSync(process.execPath, [fileURLToPath(new URL('../../build.mjs', import.meta.url))], { stdio: 'ignore' });
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

/** What the server half answers for the list of folders, which a test may change: the list, the folders that could not be opened, its version and how often it was asked for. */
interface Listing { folders: unknown[]; problems: unknown[]; version: string; asked: number; failing: boolean }

async function portal(page: Page, folders: unknown[] = FOLDERS, streams: 'idle' | 'open' = 'idle', problems: unknown[] = [], listing: Listing = { folders, problems, version: 'v1', asked: 0, failing: false }) {
  const at = new Date().toISOString();
  const sessions = [{ id: 'a', title: 'First chat', workspace: '/w/site', status: 'idle', kind: 'task', pinned: false, updated_at: at, provider: null, model: null, thinking_level: null }];
  /** The documents the page asked for, as their addresses; the documents it made, as it asked for them. */
  const asked: string[] = [];
  const made: unknown[] = [];
  /** The files the page uploaded, as it sent them. */
  const uploaded: { name: string; markdown: string }[] = [];
  await mockPortal(page, async ({ path: p, method, route, json }) => {
    if (p === '/api/extension-ui') return { extensions: [{ name: NAME, version: '0.1.0', entry: address('client.js') + '?v=1', style: address('client.css') + '?v=1', server: `/api/x/${NAME}` }] };
    // The folder the portal serves of the package: its modules, the editor among them, and its stylesheet.
    if (p.startsWith(address(''))) { await route.fulfill({ contentType: p.endsWith('.css') ? 'text/css' : 'text/javascript', body: web(p.slice(address('').length)) }); return DONE; }
    if (p === `/api/x/${NAME}/folders`) {
      listing.asked++;
      if (listing.failing) return reply(503, { error: 'The portal is busy' });
      return { folders: listing.folders, ...(listing.problems.length ? { problems: listing.problems } : {}), version: listing.version };
    }
    // What the first chat sees, for the panel beside it: the documents of its folder.
    if (p === `/api/x/${NAME}/chats/a/documents`) return { folder: { id: '0123456789abcdef', name: 'site', path: '/w/site' }, documents: (listing.folders[0] as { documents: unknown[] } | undefined)?.documents ?? [] };
    if (p === `/api/x/${NAME}/folders/0123456789abcdef/documents` && method === 'POST') {
      made.push(json());
      return reply(201, { id: '4444444444444444', name: 'ideas.md', title: 'Ideas', revision: 1, scope: 'project', chat: null });
    }
    if (p === `/api/x/${NAME}/folders/0123456789abcdef/documents/upload` && method === 'POST') {
      const file = json() as { name: string; markdown: string };
      uploaded.push(file);
      return reply(201, { id: '4444444444444444', name: file.name, title: 'Ideas', revision: 1, scope: 'project', chat: null });
    }
    if (p === `/api/x/${NAME}/folders/0123456789abcdef/documents/4444444444444444`) return { id: '4444444444444444', name: 'ideas.md', title: 'Ideas', revision: 1, markdown: '# Ideas\n', modified: '2026-10-04T09:30:00.000Z' };
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
  return { asked, made, uploaded, says, caughtUp, calls };
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

  // Open in Documents: the panel beside the chat, with that document open, asked for by its id; the chat stays.
  await edited.getByRole('button', { name: 'Open in Documents' }).click();
  const panels = page.getByRole('complementary', { name: 'Panels' });
  await expect(panels.getByRole('heading', { name: 'The plan', level: 1 })).toBeVisible();
  await expect(panels.getByText('Ship it on Friday.', { exact: true })).toBeVisible();
  await expect(page).toHaveURL('/s/a');
  expect([...new Set(asked)]).toEqual([`/api/x/${NAME}/folders/0123456789abcdef/documents/1111111111111111`]);
  await panels.getByRole('button', { name: /All documents/ }).click();
  await expect(panels.getByRole('button', { name: /Release notes/ })).toBeVisible();
});

test('a chat has a Documents panel beside it: its folder\'s documents, opened in the editor there, and a new one made with a title', async ({ page }) => {
  await page.setViewportSize({ width: 1300, height: 800 });
  const { made } = await portal(page);
  await page.goto('/s/a');
  // The chat's header has its button (the sidebar has the page's).
  const toggle = page.locator('.panel-toggle[aria-label="Documents"]');
  await expect(toggle).toHaveAttribute('title', "The documents of this chat's folder, to read, edit and comment on");
  await toggle.click();
  const panels = page.getByRole('complementary', { name: 'Panels' });
  await expect(panels.getByRole('listitem')).toHaveText([/^The plan\s*plan\.md · Changed /, /^Release notes\s*release notes\.md · Changed /]);
  // Another folder's documents are not this chat's.
  await expect(panels.getByText('Setting up')).toHaveCount(0);
  await panels.getByRole('button', { name: /The plan/ }).click();
  await expect(panels.getByRole('heading', { name: 'The plan', level: 1 })).toBeVisible();
  // The comments are not drawn until they are asked for: nothing under the text, no margin.
  await expect(panels.locator('.pd-threads, .pd-thread-card')).toHaveCount(0);
  await panels.getByRole('button', { name: /All documents/ }).click();
  // A new one, by its title: made in the chat's folder, and open at once.
  const create = panels.getByRole('button', { name: 'New document' });
  await expect(create).toBeDisabled();
  await panels.getByRole('textbox', { name: 'Title of a new document' }).fill('Ideas');
  await create.click();
  await expect(panels.getByRole('heading', { name: 'Ideas', level: 1 })).toBeVisible();
  expect(made).toEqual([{ title: 'Ideas' }]);
});

/**
 * The model writing a call, as the chat's stream carries it to the page: each piece of its arguments as it comes (live, which call
 * it is of said with it), then the message ends with the call in it, and the call starts and ends as any does.
 */
function model(page: Page, says: (type: string, payload: unknown) => Promise<unknown>) {
  let live = -1000;
  const emit = (event: unknown) => page.evaluate((e) => (window as any).streams.find((s: any) => !s.closed && s.url.includes('/api/sessions/a/events')).emit('message', e), event);
  return {
    /** A piece of the arguments of call `call` of tool `name`. Read a few times a second at most: a test that wants the next read waits that long. */
    writes: async (call: string, name: string, delta: string) => {
      await emit({ seq: live--, type: 'message_update', at: Date.now(), payload: { type: 'message_update', streamId: `m-${call}`, assistantMessageEvent: { type: 'toolcall_delta', contentIndex: 0, delta, toolCallId: call, toolName: name } } });
      await page.waitForTimeout(200);
    },
    /** The model wrote all of it, and the call ran: `details` when it succeeded, as the tool answers. */
    runs: async (call: string, name: string, args: unknown, details?: unknown) => {
      await says('message_end', { streamId: `m-${call}`, message: { role: 'assistant', content: [{ type: 'toolCall', id: call, name, arguments: args }] } });
      await says('tool_execution_start', { toolCallId: call, toolName: name, args });
      await says('tool_execution_end', { toolCallId: call, toolName: name, isError: !details, result: { content: [{ type: 'text', text: details ? 'Done' : 'exists: refused' }], ...(details ? { details } : {}) } });
    },
  };
}

test('the panel opens when the agent begins a new document, which is drawn as the model writes it and opens in the editor once it is made', async ({ page }) => {
  await page.setViewportSize({ width: 1300, height: 800 });
  const { says, caughtUp } = await portal(page, FOLDERS, 'open');
  await page.goto('/s/a');
  await caughtUp();
  const { writes, runs } = model(page, says);
  const panels = page.getByRole('complementary', { name: 'Panels' });
  await writes('c9', 'doc_create', '{"title":"Ideas","markdown":"The first');
  await expect(panels.getByText('The agent is writing a new document…')).toBeVisible();
  // As doc_create will make it: its title as its heading, where the Markdown has none.
  await expect(panels.locator('.pd-draft h1')).toHaveText('Ideas');
  await expect(panels.locator('.pd-draft')).toContainText('The first');
  await writes('c9', 'doc_create', ' idea, and the second.');
  await expect(panels.locator('.pd-draft')).toContainText('The first idea, and the second.');
  // Made: the document as the tool saved it, in the editor.
  await runs('c9', 'doc_create', { title: 'Ideas', markdown: 'The first idea, and the second.' }, { action: 'create', folder: '0123456789abcdef', id: '4444444444444444', name: 'ideas.md', title: 'Ideas', revision: 1 });
  await expect(panels.getByText('The agent is writing a new document…')).toHaveCount(0);
  await expect(panels.locator('.pd-editor .ProseMirror h1')).toHaveText('Ideas');
  // One that was not made says so, and the list is a click away.
  await writes('c10', 'doc_create', '{"title":"Taken","markdown":"Text"}');
  await expect(panels.getByText('The agent is writing a new document…')).toBeVisible();
  await runs('c10', 'doc_create', { title: 'Taken', markdown: 'Text' });
  await expect(panels.getByText("The agent's new document was not made.")).toBeVisible();
  await panels.getByRole('button', { name: /All documents/ }).click();
  await expect(panels.getByRole('button', { name: /The plan/ })).toBeVisible();
});

test('an edit the model is writing is drawn on its document while nothing of the person\'s is unsaved, the saved text a click away, and the panel opens once for each', async ({ page }) => {
  await page.setViewportSize({ width: 1300, height: 800 });
  const { says, caughtUp } = await portal(page, FOLDERS, 'open');
  await page.goto('/s/a');
  await caughtUp();
  const { writes, runs } = model(page, says);
  const panels = page.getByRole('complementary', { name: 'Panels' });
  const done = { action: 'edit', folder: '0123456789abcdef', id: '1111111111111111', name: 'plan.md', title: 'The plan', revision: 4, from: 3, edits: 1, changed: true };
  // Opened once all of the id has come, on that document, in the chat's folder.
  await writes('e9', 'doc_edit', '{"id":"11111111');
  await expect(page.locator('.pd-page')).toHaveCount(0);
  await writes('e9', 'doc_edit', '11111111","expected_revision":3,"edits":[{"quote":"Friday","replacement":"Mon');
  await expect(panels.getByText('The agent is writing in this document…')).toBeVisible();
  await expect(panels.locator('.pd-draft')).toContainText('Ship it on Mon.');
  await writes('e9', 'doc_edit', 'day afternoon"}]}');
  await expect(panels.locator('.pd-draft')).toContainText('Ship it on Monday afternoon.');
  // The saved text instead, for the rest of this call.
  await panels.getByRole('button', { name: 'Show the saved text' }).click();
  await expect(panels.locator('.pd-draft')).toHaveCount(0);
  await expect(panels.getByText('Ship it on Friday.', { exact: true })).toBeVisible();
  await expect(panels.getByText('The agent is writing in this document. What it writes comes in when it is done.')).toBeVisible();
  await runs('e9', 'doc_edit', { id: '1111111111111111', expected_revision: 3, edits: [{ quote: 'Friday', replacement: 'Monday afternoon' }] }, done);
  await expect(panels.getByText(/The agent is writing in this document/)).toHaveCount(0);

  // Closed while a call is written, it stays closed for that call; the next one opens it again.
  await writes('e10', 'doc_edit', '{"id":"1111111111111111","expected_revision":3,"edits":[{"quote":"Friday","replacement":"Sun');
  await expect(panels.locator('.pd-draft')).toBeVisible();
  await page.getByRole('button', { name: 'Close Documents' }).click();
  await expect(page.locator('.pd-page')).toHaveCount(0);
  await writes('e10', 'doc_edit', 'day"}]}');
  await expect(page.locator('.pd-page')).toHaveCount(0);
  await runs('e10', 'doc_edit', { id: '1111111111111111', edits: [] });
  await writes('e11', 'doc_edit', '{"id":"1111111111111111","expected_revision":3,"edits":[{"quote":"Friday","replacement":"Saturday"}]}');
  await expect(panels.locator('.pd-draft')).toContainText('Ship it on Saturday.');

  // With text of the person's own unsaved, theirs stays in front of them.
  await panels.getByRole('button', { name: 'Show the saved text' }).click();
  await runs('e11', 'doc_edit', { id: '1111111111111111', edits: [] });
  await panels.locator('.pd-editor .ProseMirror p').first().click();
  await page.keyboard.type(' Mine.');
  await writes('e12', 'doc_edit', '{"id":"1111111111111111","expected_revision":3,"edits":[{"quote":"Friday","replacement":"Tuesday"}]}');
  await expect(panels.getByText('The agent is writing in this document. What it writes comes in when it is done.')).toBeVisible();
  await expect(panels.locator('.pd-draft')).toHaveCount(0);
  await expect(panels.locator('.pd-editor .ProseMirror')).toContainText('Mine.');
});

test('a comment, a reply, a changed or deleted comment, a resolved thread and an edit that answers a comment are drawn as what became of the document, in English and in German', async ({ page }) => {
  await page.setViewportSize({ width: 1300, height: 800 });
  const { caughtUp, calls } = await portal(page, FOLDERS, 'open');
  await page.goto('/s/a');
  await caughtUp();
  const thread = 'abcdef0123456789';
  await calls('k1', 'doc_comment', { id: PLAN_AT.id, quote: 'Friday', comment: 'Why?' }, 'Commented', { ...PLAN_AT, action: 'comment', revision: 3, thread });
  await calls('k2', 'doc_reply', { id: PLAN_AT.id, thread, comment: 'Done.' }, 'Replied', { ...PLAN_AT, action: 'reply', revision: 3, thread });
  await calls('k3', 'doc_resolve', { id: PLAN_AT.id, thread }, 'Resolved', { ...PLAN_AT, action: 'resolve', revision: 3, thread, changed: true });
  await calls('k4', 'doc_edit', { id: PLAN_AT.id, thread }, 'Edited', { ...PLAN_AT, action: 'edit', revision: 4, from: 3, edits: 1, changed: true, thread, replied: true });
  await calls('k5', 'doc_edit_comment', { id: PLAN_AT.id, thread, comment_id: 'c1', comment: 'Fixed.' }, 'Changed', { ...PLAN_AT, action: 'edit_comment', revision: 4, thread, comment: 'c1' });
  await calls('k6', 'doc_delete_comment', { id: PLAN_AT.id, thread, comment_id: 'c1' }, 'Deleted', { ...PLAN_AT, action: 'delete_comment', revision: 4, thread, comment: 'c1', removed: 'comment' });
  const cards = page.locator('.tool-row .pd-call');
  await expect(cards).toHaveCount(6);
  await expect(cards.nth(0)).toContainText('Commented on a document');
  await expect(cards.nth(0)).toContainText('documents/plan.md · Revision 3');
  await expect(cards.nth(1)).toContainText('Replied to a comment');
  await expect(cards.nth(2)).toContainText('Resolved a comment');
  await expect(cards.nth(3)).toContainText('Edited a document');
  await expect(cards.nth(3)).toContainText('documents/plan.md · Revision 3 to 4 · 1 edit · answers a comment');
  await expect(cards.nth(4)).toContainText('Changed a comment');
  await expect(cards.nth(4)).toContainText('documents/plan.md · Revision 4');
  await expect(cards.nth(5)).toContainText('Deleted a comment');
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
  await calls('k5', 'doc_edit_comment', { id: PLAN_AT.id }, 'Changed', { ...PLAN_AT, action: 'edit_comment', revision: 4, thread, comment: 'c1' });
  await calls('k6', 'doc_delete_comment', { id: PLAN_AT.id }, 'Deleted', { ...PLAN_AT, action: 'delete_comment', revision: 4, thread, comment: 'c1', removed: 'comment' });
  const cards = page.locator('.tool-row .pd-call');
  await expect(cards.nth(4)).toContainText('Kommentar geändert');
  await expect(cards.nth(5)).toContainText('Kommentar gelöscht');
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

/**
 * The list of documents keeps itself up to date: the page's own EventSource, which the test drives by hand, says the list's version
 * (extensions/docs/server.js) as its first message and whenever it changes, and the page asks for the list again when that is not the
 * version it holds.
 */
const NOTES = { id: '4444444444444444', name: 'notes.md', title: 'Field notes', revision: 1, size: 20, modified: '2026-10-04T09:30:00.000Z' };
const listOf = (page: Page) => page.getByRole('region', { name: 'site' }).getByRole('listitem');

/** What the stream of the list says, as the server half would: the list is at `version` now. */
const listStream = (page: Page, version: string) =>
  page.evaluate((version) => {
    const stream = (window as any).streams.filter((s: any) => !s.closed && s.url.endsWith('/folders/events')).at(-1);
    stream.emit('documents', { version });
  }, version);
/** Every stream of the list the page opened, as its address and whether it was let go of. Development React runs each effect twice, so the first is already closed. */
const streamsOf = (page: Page) => page.evaluate(() => (window as any).streams.filter((s: any) => s.url.endsWith('/folders/events')).map((s: any) => ({ url: s.url, closed: s.closed })));
const openStreams = async (page: Page) => (await streamsOf(page)).filter((s) => !s.closed);

async function opened(page: Page, listing?: Partial<Listing>) {
  const state: Listing = { folders: FOLDERS, problems: [], version: 'v1', asked: 0, failing: false, ...listing };
  await portal(page, FOLDERS, 'open', [], state);
  await page.goto(`/x/${NAME}/documents`);
  await expect(page.getByRole('region', { name: 'site' })).toBeVisible();
  await expect.poll(() => openStreams(page)).toHaveLength(1);
  // What was asked for while the page came up (twice in development) is not counted.
  await page.waitForTimeout(300);
  state.asked = 0;
  return state;
}

/** The first folder with `documents` in place of its own. */
const withDocuments = (documents: unknown[]) => [{ ...(FOLDERS[0] as object), documents }, FOLDERS[1]];

test('the list opens one stream for all folders, and lets go of it when a document is opened and again when the list is back', async ({ page }) => {
  const state = await opened(page);
  expect(await openStreams(page)).toEqual([{ url: `/api/x/${NAME}/folders/events`, closed: false }]);
  // The stream's first message says the version the page holds: nothing to ask for.
  await listStream(page, 'v1');
  await page.waitForTimeout(200);
  expect(state.asked).toBe(0);

  await listOf(page).first().getByRole('button', { name: /The plan/ }).click();
  await expect(page.getByRole('heading', { name: 'The plan', level: 1 })).toBeVisible();
  expect(await openStreams(page)).toEqual([]);
  await page.getByRole('button', { name: /All documents/ }).click();
  await expect(page.getByRole('region', { name: 'site' })).toBeVisible();
  await expect.poll(() => openStreams(page)).toHaveLength(1);
});

test('a document made by the agent or in another window is in the list when the stream says the list changed, without a reload, and the list is not drawn again for the same version', async ({ page }) => {
  const state = await opened(page);
  await expect(listOf(page)).toHaveText([/^The plan\s*plan\.md/, /^Release notes\s*release notes\.md/]);
  const [site] = FOLDERS;
  state.folders = withDocuments([...site.documents, NOTES]);
  state.version = 'v2';
  await listStream(page, 'v2');
  await expect(listOf(page)).toHaveText([/^The plan/, /^Release notes/, /^Field notes\s*notes\.md/]);
  expect(state.asked).toBe(1);
  // Said again, or at the first message of a stream that was opened again: the page holds this version already.
  await listStream(page, 'v2');
  await page.waitForTimeout(200);
  expect(state.asked).toBe(1);
});

test('a document that is renamed, deleted or made again is in the list as it is now, and a folder with no document left is gone from it', async ({ page }) => {
  const state = await opened(page);
  const [site, tools] = FOLDERS;
  const [plan, notes] = site.documents;
  // Renamed: a document of its own under the new name.
  const renamed = { ...notes, id: '5555555555555555', name: 'release.md' };
  state.folders = [{ ...site, documents: [plan, renamed] }, tools];
  state.version = 'v2';
  await listStream(page, 'v2');
  await expect(listOf(page)).toHaveText([/^The plan/, /^Release notes\s*release\.md/]);
  // Deleted.
  state.folders = [{ ...site, documents: [plan] }, tools];
  state.version = 'v3';
  await listStream(page, 'v3');
  await expect(listOf(page)).toHaveCount(1);
  // Made again under its name: the same document.
  state.folders = FOLDERS;
  state.version = 'v4';
  await listStream(page, 'v4');
  await expect(listOf(page)).toHaveText([/^The plan/, /^Release notes\s*release notes\.md/]);
  // A folder whose last document was deleted is not listed: no section is left for it.
  state.folders = [site];
  state.version = 'v5';
  await listStream(page, 'v5');
  await expect(page.getByRole('region', { name: 'tools' })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'site' })).toBeVisible();
  // And the first document of a folder that had none makes its section.
  state.folders = FOLDERS;
  state.version = 'v6';
  await listStream(page, 'v6');
  await expect(page.getByRole('region', { name: 'tools' }).getByRole('listitem')).toHaveText([/^Setting up/]);
});

test('a folder the portal cannot read is said above the list as it turns up and goes as it is mended, and the other folders stay', async ({ page }) => {
  const state = await opened(page);
  await expect(page.getByRole('alert')).toHaveCount(0);
  state.problems = PROBLEMS.slice(1);
  state.folders = [FOLDERS[0]];
  state.version = 'v2';
  await listStream(page, 'v2');
  await expect(page.getByRole('alert')).toHaveText("The documents in /w/locked could not be opened: The portal is not allowed to read this folder's documents folder (permission denied)");
  await expect(page.getByRole('region', { name: 'site' }).getByRole('listitem')).toHaveCount(2);
  // Mended: its documents are listed and the reason is gone.
  state.problems = [];
  state.folders = FOLDERS;
  state.version = 'v3';
  await listStream(page, 'v3');
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'tools' })).toBeVisible();
});

test('the list that is shown stays while it cannot be asked for again, and what the next message says is taken', async ({ page }) => {
  const state = await opened(page);
  state.failing = true;
  state.version = 'v2';
  await listStream(page, 'v2');
  await expect.poll(() => state.asked).toBe(1);
  // Not taken away, and no error in its place.
  await expect(listOf(page)).toHaveCount(2);
  await expect(page.getByRole('alert')).toHaveCount(0);
  const [site] = FOLDERS;
  state.failing = false;
  state.folders = withDocuments([...site.documents, NOTES]);
  state.version = 'v3';
  await listStream(page, 'v3');
  await expect(listOf(page)).toHaveCount(3);
});

test('a list that could not be asked for again is asked for again after a while, with the stream saying nothing more', async ({ page }) => {
  const state = await opened(page);
  const [site] = FOLDERS;
  state.failing = true;
  state.folders = withDocuments([...site.documents, NOTES]);
  state.version = 'v2';
  await listStream(page, 'v2');
  await expect.poll(() => state.asked).toBe(1);
  // The list that is shown is the old one, and the page does not give up on the new one.
  await expect(listOf(page)).toHaveCount(2);
  state.failing = false;
  await expect(listOf(page)).toHaveCount(3, { timeout: 8000 });
  expect(state.asked).toBe(2);
});

test('a stream that dropped is opened again after a while, and a change that was made while it was down is found by its first message', async ({ page }) => {
  const state = await opened(page);
  const made = (await streamsOf(page)).length;
  await page.evaluate(() => (window as any).streams.filter((s: any) => !s.closed).at(-1).emit('error', null));
  expect(await openStreams(page)).toEqual([]);
  // After a wait, another is opened, and its first message is the list's version.
  await expect.poll(async () => (await streamsOf(page)).length, { timeout: 6000 }).toBe(made + 1);
  expect(await openStreams(page)).toHaveLength(1);
  const [site] = FOLDERS;
  state.folders = withDocuments([...site.documents, NOTES]);
  state.version = 'v2';
  await listStream(page, 'v2');
  await expect(listOf(page)).toHaveCount(3);
});

test('a list that could not be asked for the first time says why, and is asked for again by the stream\'s first message', async ({ page }) => {
  const state: Listing = { folders: FOLDERS, problems: [], version: 'v1', asked: 0, failing: true };
  await portal(page, FOLDERS, 'open', [], state);
  await page.goto(`/x/${NAME}/documents`);
  await expect(page.getByRole('alert')).toBeVisible();
  await expect.poll(() => openStreams(page)).toHaveLength(1);
  // The portal is back, and the stream says where the list stands: the page asks again, with no button.
  state.failing = false;
  await listStream(page, 'v1');
  await expect(page.getByRole('region', { name: 'site' })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('the panel beside a chat lists every document of its folder, another chat\'s own marked as that chat\'s', async ({ page }) => {
  await page.setViewportSize({ width: 1300, height: 800 });
  const documents = [
    ...(FOLDERS[0].documents as object[]),
    { id: '5555555555555555', name: 'scratch.md', title: 'Scratch pad', revision: 1, size: 10, modified: '2026-10-02T09:30:00.000Z', scope: 'chat', chat: 'b', otherChat: true, chatTitle: 'Second chat' },
  ];
  await portal(page, [{ ...FOLDERS[0], documents }, FOLDERS[1]]);
  await page.goto('/s/a');
  await page.locator('.panel-toggle[aria-label="Documents"]').click();
  const panels = page.getByRole('complementary', { name: 'Panels' });
  await expect(panels.getByRole('listitem')).toHaveCount(3);
  await expect(panels.getByRole('button', { name: /Scratch pad/ })).toContainText('scratch.md · From the chat Second chat · Changed');
});

test('Markdown files are uploaded into the chat\'s folder from the panel, with the button or dropped on the list, and one that is not Markdown is said', async ({ page }) => {
  await page.setViewportSize({ width: 1300, height: 800 });
  const { uploaded } = await portal(page);
  await page.goto('/s/a');
  await page.locator('.panel-toggle[aria-label="Documents"]').click();
  const panels = page.getByRole('complementary', { name: 'Panels' });
  await expect(panels.getByRole('button', { name: 'Upload' })).toBeVisible();
  const picker = panels.locator('input[type="file"]');
  await expect(picker).toHaveAttribute('accept', '.md,.markdown,text/markdown');
  // A picture is not sent; a Markdown file is, as it is, under its name.
  await picker.setInputFiles([
    { name: 'photo.png', mimeType: 'image/png', buffer: Buffer.from('not text') },
    { name: 'notes.md', mimeType: 'text/markdown', buffer: Buffer.from('# Notes\n\nKept as it is.\n') },
  ]);
  await expect(panels.getByRole('alert')).toContainText('photo.png is not a Markdown file (.md).');
  await expect.poll(() => uploaded).toEqual([{ name: 'notes.md', markdown: '# Notes\n\nKept as it is.\n' }]);

  // Dropped on the list: it is marked while the files are over it, and both are sent.
  const files = await page.evaluateHandle(() => {
    const data = new DataTransfer();
    data.items.add(new File(['# One\n'], 'one.md', { type: 'text/markdown' }));
    data.items.add(new File(['# Two\n'], 'two.markdown', { type: 'text/markdown' }));
    return data;
  });
  const zone = panels.locator('.pd-dropzone');
  await zone.dispatchEvent('dragenter', { dataTransfer: files });
  await expect(panels.getByText('Drop Markdown files here to add them as documents')).toBeVisible();
  await zone.dispatchEvent('drop', { dataTransfer: files });
  await expect(panels.getByText('Drop Markdown files here to add them as documents')).toHaveCount(0);
  await expect.poll(() => uploaded.map((f) => f.name)).toEqual(['notes.md', 'one.md', 'two.markdown']);
  // One file on its own, and nothing refused: it is opened.
  await picker.setInputFiles([{ name: 'ideas.md', mimeType: 'text/markdown', buffer: Buffer.from('# Ideas\n') }]);
  await expect(panels.locator('.ProseMirror h1')).toHaveText('Ideas');
});

test('a file that is not UTF-8 is not uploaded and the list says so; a UTF-8 file is sent with its byte order mark kept', async ({ page }) => {
  await page.setViewportSize({ width: 1300, height: 800 });
  const { uploaded } = await portal(page);
  await page.goto('/s/a');
  await page.locator('.panel-toggle[aria-label="Documents"]').click();
  const panels = page.getByRole('complementary', { name: 'Panels' });
  const picker = panels.locator('input[type="file"]');
  await picker.setInputFiles([
    // Windows-1252: its "Ä" is the single byte C4, which is no UTF-8.
    { name: 'old.md', mimeType: 'text/markdown', buffer: Buffer.from('# \xc4rger\n', 'latin1') },
    { name: 'bom.md', mimeType: 'text/markdown', buffer: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('# Ärger\n', 'utf8')]) },
    { name: 'plain.md', mimeType: 'text/markdown', buffer: Buffer.from('# Ärger\n', 'utf8') },
  ]);
  await expect(panels.getByRole('alert')).toContainText('old.md is not UTF-8 text, so it is not sent. Save it as UTF-8 first.');
  await expect.poll(() => uploaded).toEqual([
    { name: 'bom.md', markdown: '\uFEFF# Ärger\n' },
    { name: 'plain.md', markdown: '# Ärger\n' },
  ]);
});

test('a document open in the panel opens on a page of its own, the whole of it, with Full page', async ({ page }) => {
  await page.setViewportSize({ width: 1300, height: 800 });
  await portal(page);
  await page.goto('/s/a');
  await page.locator('.panel-toggle[aria-label="Documents"]').click();
  const panels = page.getByRole('complementary', { name: 'Panels' });
  await panels.getByRole('button', { name: /The plan/ }).click();
  await expect(panels.getByRole('toolbar', { name: 'Formatting' })).toBeVisible();
  await panels.getByRole('button', { name: /Full page|Open on its own page/ }).click();
  await expect(page).toHaveURL(new RegExp(`/x/${NAME}/documents\\?folder=0123456789abcdef&doc=1111111111111111$`));
  await expect(page.locator('.pd-full .ProseMirror h1')).toHaveText('The plan');
  await expect(page.getByRole('heading', { name: 'Documents', exact: true })).toHaveCount(0);
});

test('a document open in the panel is a page that fills it to its bottom, with no frame, and its list opens from the right edge', async ({ page }) => {
  // Taller than a short document, which is what shows a strip under it.
  await page.setViewportSize({ width: 1300, height: 1300 });
  await portal(page);
  await page.goto('/s/a');
  await page.locator('.panel-toggle[aria-label="Documents"]').click();
  const panels = page.getByRole('complementary', { name: 'Panels' });
  await panels.getByRole('button', { name: /The plan/ }).click();
  await expect(panels.getByRole('heading', { name: 'The plan', level: 1 })).toBeVisible();
  const at = () =>
    page.evaluate(() => {
      const rect = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
      const panel = document.querySelector('.pd-panel') as HTMLElement;
      const sheet = getComputedStyle(document.querySelector('.pd-sheet')!);
      return { panel: rect('.pd-panel').bottom, scroll: rect('.pd-scroll').bottom, sheet: rect('.pd-sheet').bottom, toolbar: rect('.pd-toolbar').bottom, top: rect('.pd-scroll').top, scrolls: panel.scrollHeight > panel.clientHeight + 1, frame: [sheet.borderTopWidth, sheet.boxShadow, sheet.backgroundColor] };
    });
  // The page goes down to the panel's end (it is the text's ground the whole way), and the panel has nothing to scroll for the room under it.
  await expect.poll(async () => Math.round((await at()).panel - (await at()).scroll)).toBe(0);
  const now = await at();
  expect(Math.round(now.sheet)).toBe(Math.round(now.panel));
  expect(Math.round(now.top)).toBe(Math.round(now.toolbar));
  expect(now.scrolls).toBe(false);
  expect(now.frame).toEqual(['0px', 'none', 'rgba(0, 0, 0, 0)']);
  // Its list comes in from the right edge, over the page, the whole height of it (the panel is narrow).
  await panels.getByRole('button', { name: /^Comments/ }).click();
  const list = (await panels.getByRole('complementary', { name: 'Comments' }).boundingBox())!;
  const desk = (await page.locator('.pd-desk').boundingBox())!;
  expect(Math.round(list.x + list.width)).toBe(Math.round(desk.x + desk.width));
  expect(Math.round(list.y)).toBe(Math.round(desk.y));
  expect(Math.round(list.y + list.height)).toBe(Math.round(desk.y + desk.height));
  expect(list.width).toBeLessThanOrEqual(320);
  await panels.getByRole('complementary', { name: 'Comments' }).getByRole('button', { name: 'Close' }).click();
  // In a shorter panel, where the text is longer than it: the page scrolls in itself, and the panel does not.
  await page.setViewportSize({ width: 1300, height: 500 });
  await expect.poll(() => page.evaluate(() => { const s = document.querySelector('.pd-scroll')!; return s.scrollHeight > s.clientHeight; })).toBe(true);
  const short = await at();
  expect(short.scrolls).toBe(false);
  expect(Math.abs(Math.round(short.panel - short.scroll))).toBe(0);
});

test('the extension\'s module registers its page without the editor\'s half, which is loaded when a document is first opened', async ({ page }) => {
  const modules: string[] = [];
  page.on('request', (request) => {
    const at = new URL(request.url()).pathname;
    if (at.startsWith(address(''))) modules.push(at.slice(address('').length));
  });
  await portal(page);
  await page.goto(`/x/${NAME}/documents`);
  await expect(page.getByRole('heading', { name: 'Documents', exact: true })).toBeVisible();
  await expect(sidebar(page).getByRole('button', { name: 'Documents' })).toHaveAttribute('aria-current', 'page');
  // The page is there, with its list, and nothing of the editor was asked for: not its half of the page, not the comments, not the editor.
  expect(modules).toContain('client.js');
  expect(modules.filter((name) => /document-editor|comments|saver|anchor|live|editor\.js/.test(name))).toEqual([]);
  // A document opened loads it, behind the page's loading state.
  await page.getByRole('region', { name: 'site' }).getByRole('button', { name: /The plan/ }).click();
  await expect(page.locator('.pd-editor h1')).toHaveText('The plan');
  expect(modules).toEqual(expect.arrayContaining(['document-editor.js', 'editor.js']));
});

test('a failed load of the editor offers a reload, not a retry that cannot work, and the page loads the editor after it', async ({ page }) => {
  await portal(page);
  let asked = 0;
  await page.route('**/document-editor.js*', (route) => (asked++ === 0 ? route.abort() : route.fallback()));
  await page.goto(`/x/${NAME}/documents`);
  await page.getByRole('region', { name: 'site' }).getByRole('button', { name: /The plan/ }).click();
  // Said once, in the words of the failure, with the one thing that helps.
  const alert = page.getByRole('alert');
  await expect(alert).toContainText('The editor could not be loaded');
  await expect(alert).not.toContainText('Could not load this');
  await expect(alert.getByRole('button', { name: 'Reload the page' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Try again' })).toHaveCount(0);
  // The browser keeps the failure: a second ask would not even go out.
  expect(asked).toBe(1);
  await alert.getByRole('button', { name: 'Reload the page' }).click();
  await expect(page.getByRole('heading', { name: 'Documents', exact: true })).toBeVisible();
  await page.getByRole('region', { name: 'site' }).getByRole('button', { name: /The plan/ }).click();
  await expect(page.locator('.pd-editor h1')).toHaveText('The plan');
});
