import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { type Page } from '@playwright/test';
import { carry, locate, passage } from '../../extensions/docs/web/anchor.js';
import { merge3 } from '../../extensions/docs/web/merge.js';
import { test, expect, mockPortal, reply, DONE } from './portal-mock';

/**
 * The comments on the Documents page: the extension's browser half (extensions/docs/web) with the editor
 * `npm run build` builds, against a store that answers as the server half does (extensions/docs/server.js): threads on
 * passages of the text, which it keeps in their place as the document changes (extensions/docs/web/anchor.js, the
 * module the server half uses). The stream that tells the page of a change is the page's own EventSource, which the
 * test drives by hand.
 */
const NAME = 'pithagoras-docs';
const FOLDER = '0123456789abcdef';
const ID = '1111111111111111';
const web = (file: string) => readFileSync(new URL(`../../extensions/docs/web/${file}`, import.meta.url), 'utf8');
const address = (file: string) => `/api/extension-ui/${NAME}/${file}`;
const API = `/api/x/${NAME}`;
const DOCUMENT = `${API}/folders/${FOLDER}/documents/${ID}`;

test.beforeAll(() => {
  execFileSync(process.execPath, [fileURLToPath(new URL('../../extensions/docs/build.mjs', import.meta.url))], { stdio: 'ignore' });
});

const PLAN = '# The plan\n\nShip it on **Friday**, [see the guide](https://example.com/guide) now.\n\nThe build is green.\n\nSign-off is on Monday.\n';

interface Comment { id: string; author: 'user' | 'agent'; body: string; at: string }
interface Thread {
  id: string; status: 'open' | 'resolved'; orphaned: boolean; quote: string; prefix: string; suffix: string; start: number | null; end: number | null;
  revision: number; createdAt: string; updatedAt: string; comments: Comment[];
  /** Asked of the agent and not answered; answered by the agent and not reacted to; the last time the agent was asked. */
  toAgent?: boolean; answered?: boolean; ping?: { chat: string; sent: boolean; title: string } | null;
}

/** One document with its comments, as the server half keeps them: the passages are followed from revision to revision. */
class Store {
  revision = 3;
  texts = new Map<number, string>([[1, '# The plan\n'], [2, '# The plan\n\nShip it soon.\n'], [3, PLAN]]);
  threads: Thread[] = [];
  puts: { markdown: string; base: number }[] = [];
  /** What the page sent to make a thread. */
  made: any[] = [];
  /** Set to refuse the next request for a thread's comment, or to make it, with this status. */
  refuse: { status: number; error: string } | null = null;
  /** Set to make the agent unreachable for a comment that asks it, for this reason. */
  unreach: string | null = null;
  private count = 0;
  private clock = Date.UTC(2026, 9, 2, 9);

  get markdown() {
    return this.texts.get(this.revision)!;
  }

  private stamp() {
    this.clock += 60_000;
    return new Date(this.clock).toISOString();
  }

  private describe() {
    return { id: ID, name: 'plan.md', scope: 'project', chat: null, revision: this.revision, size: this.markdown.length, modified: '2026-10-01T11:00:00.000Z' };
  }

  /** A save from somewhere else (the agent): the next revision. */
  elsewhere(markdown: string) {
    this.revision += 1;
    this.texts.set(this.revision, markdown);
  }

  read() {
    return { ...this.describe(), title: 'The plan', markdown: this.markdown };
  }

  save(markdown: string, base: number) {
    this.puts.push({ markdown, base });
    if (base !== this.revision) {
      const together = this.texts.has(base) && base < this.revision ? merge3(this.texts.get(base)!, markdown, this.markdown) : null;
      if (together === null) return reply(409, { error: `The document changed: it is at revision ${this.revision}, not ${base}`, revision: this.revision, markdown: this.markdown });
      if (together !== this.markdown) this.elsewhere(together);
      return { ...this.describe(), changed: together !== this.markdown, merged: true, markdown: together };
    }
    const changed = markdown !== this.markdown;
    if (changed) this.elsewhere(markdown);
    return { ...this.describe(), changed };
  }

  /** The passages brought to the text the document has now. */
  follow() {
    for (const t of this.threads) {
      if (t.revision === this.revision) continue;
      const before = this.texts.get(t.revision);
      const found = before !== undefined && t.start !== null ? carry(before, this.markdown, [t])[0] : locate(this.markdown, t) && carry(this.markdown, this.markdown, [{ ...t, start: null, end: null }])[0];
      const kept = found && passage(this.markdown, found.start, found.end);
      if (kept) Object.assign(t, kept, { orphaned: false });
      else Object.assign(t, { start: null, end: null, orphaned: true });
      t.revision = this.revision;
    }
  }

  list() {
    this.follow();
    return { revision: this.revision, threads: this.threads };
  }

  /** A thread as the server makes it from what the page sends. */
  add(body: { base: number; quote: string; prefix?: string; suffix?: string; start?: number | null; body: string }, author: 'user' | 'agent' = 'user') {
    this.made.push(body);
    if (this.refuse) return reply(this.refuse.status, { error: this.refuse.error });
    const text = this.texts.get(body.base);
    const found = text === undefined ? null : locate(text, body);
    const kept = found && passage(text!, found.start, found.end);
    if (!kept) return reply(422, { error: `That passage is not in the document at revision ${body.base}`, code: 'quote_not_found', revision: this.revision });
    const at = this.stamp();
    const thread: Thread = { id: `${(++this.count).toString(16).padStart(16, '0')}`, status: 'open', orphaned: false, ...kept, revision: body.base, createdAt: at, updatedAt: at, comments: [{ id: `c${++this.count}`, author, body: body.body, at }] };
    this.threads.push(thread);
    this.follow();
    return reply(201, this.asked(thread, body.body, author));
  }

  /** As the server does for a comment: `@agent` in the person's asks the agent, and the agent's answers it. The thread as the page gets it. */
  private asked(thread: Thread, body: string, author: 'user' | 'agent') {
    if (author === 'agent') return Object.assign(thread, { toAgent: false, answered: thread.comments.length > 1 });
    thread.answered = false;
    if (!/@agent\b/i.test(body)) return thread;
    thread.toAgent = true;
    thread.ping = { chat: 'a', sent: !this.unreach, title: 'First chat' };
    return this.unreach ? { ...thread, unreached: this.unreach } : thread;
  }

  /** The passage of a thread put on `words` in the text as it is now, as the server does when it knows (it just made that change). */
  place(id: string, words: string) {
    const thread = this.threads.find((t) => t.id === id)!;
    const start = this.markdown.indexOf(words);
    Object.assign(thread, passage(this.markdown, start, start + words.length), { revision: this.revision, orphaned: false });
  }

  /** A comment, as the server adds it. */
  comment(id: string, body: string, author: 'user' | 'agent' = 'user') {
    const thread = this.threads.find((t) => t.id === id);
    if (!thread) return reply(404, { error: 'There is no such comment thread' });
    if (this.refuse) return reply(this.refuse.status, { error: this.refuse.error });
    if (thread.status !== 'open') return reply(409, { error: 'The thread is resolved: it is to be reopened to be added to', code: 'thread_resolved' });
    const at = this.stamp();
    thread.comments.push({ id: `c${++this.count}`, author, body, at });
    thread.updatedAt = at;
    return reply(201, this.asked(thread, body, author));
  }

  settle(id: string, status: 'open' | 'resolved', body?: string) {
    const thread = this.threads.find((t) => t.id === id);
    if (!thread) return reply(404, { error: 'There is no such comment thread' });
    const at = this.stamp();
    if (body) thread.comments.push({ id: `c${++this.count}`, author: 'user', body, at });
    thread.status = status;
    thread.updatedAt = at;
    thread.answered = false;
    if (status === 'resolved') thread.toAgent = false;
    return thread;
  }
}

/** The page, with the store behind it. `document` is the text the page asks for as it opens. */
async function open(page: Page, store: Store, { language, ready = 'Ship it on Friday' }: { language?: string; ready?: string } = {}) {
  if (language) await page.addInitScript((code) => localStorage.setItem('pithagoras.language', code), language);
  const sessions = [{ id: 'a', title: 'First chat', workspace: '/w/site', status: 'idle', kind: 'task', pinned: false, updated_at: new Date().toISOString(), provider: null, model: null, thinking_level: null }];
  const folders = () => [{ id: FOLDER, name: 'site', path: '/w/site', chats: [{ id: 'a', title: 'First chat' }], documents: [{ id: ID, name: 'plan.md', title: 'The plan', revision: store.revision, size: 40, modified: '2026-10-01T11:00:00.000Z', openThreads: store.threads.filter((t) => t.status === 'open').length, answeredThreads: store.threads.filter((t) => t.status === 'open' && t.answered).length }] }];
  await mockPortal(page, async ({ path: p, method, json, route }) => {
    if (p === '/api/extension-ui') return { extensions: [{ name: NAME, version: '0.1.0', entry: address('client.js') + '?v=1', style: address('client.css') + '?v=1', server: API }] };
    if (p.startsWith(address(''))) {
      await route.fulfill({ contentType: p.endsWith('.css') ? 'text/css' : 'text/javascript', body: web(p.slice(address('').length)) });
      return DONE;
    }
    if (p === `${API}/folders`) return { folders: folders() };
    if (p === DOCUMENT && method === 'GET') return store.read();
    if (p === DOCUMENT && method === 'PUT') { const { markdown, base } = json(); return store.save(markdown, base); }
    if (p === `${DOCUMENT}/threads` && method === 'GET') return store.list();
    if (p === `${DOCUMENT}/threads` && method === 'POST') return store.add(json());
    const act = new RegExp(`^${DOCUMENT}/threads/(\\w+)/(comments|resolve|reopen)$`).exec(p);
    if (act && method === 'POST') {
      if (act[2] === 'comments') return store.comment(act[1], json().body);
      if (act[2] === 'resolve') return store.settle(act[1], 'resolved', json().body);
      return store.settle(act[1], 'open');
    }
    if (p === '/api/sessions') return { sessions, executor: 'host' };
    if (p === '/api/models') return { models: [], providers: {} };
  }, { streams: 'open' });
  await page.goto(`/x/${NAME}/documents?folder=${FOLDER}&doc=${ID}`);
  await expect(editorOf(page)).toContainText(ready);
}

const editorOf = (page: Page) => page.locator('.pd-editor .ProseMirror');
const panel = (page: Page) => page.getByRole('complementary', { name: /Comments|Kommentare/ });
const cards = (page: Page) => panel(page).locator('.pd-thread-card:not(.pd-compose)');
const state = (page: Page) => page.locator('.pd-state');
/** What the marked passages of a thread read as. */
const marked = (page: Page, id: string) => editorOf(page).locator(`[data-pd-thread="${id}"]`).evaluateAll((spans) => spans.map((s) => s.textContent).join(''));
/** The marks are put on after the comments are drawn, a moment later: this waits for them to be on these words. */
const expectMarked = (page: Page, id: string, words: string) => expect.poll(() => marked(page, id)).toBe(words);

/** What the stream of the open document says, as the server half would. */
const told = (page: Page, event: string, data: unknown) =>
  page.evaluate(([event, data]) => {
    const stream = (window as any).streams.filter((s: any) => s.url.includes('/documents/') && s.url.endsWith('/events') && !s.closed).at(-1);
    stream.emit(event, data);
  }, [event, data] as const);

/** Selects `text` in the editor, which must be within one block, as a person would with the mouse. */
async function select(page: Page, text: string) {
  await editorOf(page).getByText(text.slice(0, 6)).first().click();
  await page.evaluate((text) => {
    const root = document.querySelector('.pd-editor .ProseMirror')!;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes: { node: Node; from: number }[] = [];
    let all = '';
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      nodes.push({ node: n, from: all.length });
      all += n.textContent;
    }
    const at = all.indexOf(text);
    if (at < 0) throw new Error(`${text} is not in the editor`);
    const place = (position: number, end: boolean) => {
      const found = [...nodes].reverse().find((n) => (end ? n.from < position : n.from <= position))!;
      return [found.node, position - found.from] as const;
    }
    const range = document.createRange();
    range.setStart(...place(at, false));
    range.setEnd(...place(at + text.length, true));
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
  }, text);
}

const commentButton = (page: Page) => page.getByRole('button', { name: 'Comment', exact: true });

/** A thread made on `quote`, in the store, as if it had been there when the page opened. */
function seeded(store: Store, quote: string, body: string, author: 'user' | 'agent' = 'user') {
  const start = store.markdown.indexOf(quote);
  const made = store.add({ base: store.revision, quote, prefix: store.markdown.slice(Math.max(0, start - 32), start), suffix: store.markdown.slice(start + quote.length, start + quote.length + 32), start, body }, author) as any;
  return made.body as Thread;
}

test('the comments of a document are beside it, by whom they are, and their passages are marked in the text; a click on either leads to the other', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  const store = new Store();
  // Made in the other order than they are in the text.
  const green = seeded(store, 'The build is green.', 'Is it?', 'agent');
  const friday = seeded(store, '**Friday**', 'Why Friday?');
  store.comment(green.id, 'It was at noon.');
  await open(page, store);
  await expect(cards(page)).toHaveCount(2);
  // In the order of the text, with who said what.
  await expect(cards(page).nth(0)).toContainText('Friday');
  await expect(cards(page).nth(0)).toContainText('You');
  await expect(cards(page).nth(0)).toContainText('Why Friday?');
  await expect(cards(page).nth(1)).toContainText('The build is green.');
  await expect(cards(page).nth(1).locator('li[data-author="agent"]')).toContainText('The agent');
  await expect(cards(page).nth(1).locator('li[data-author="agent"]')).toContainText('Is it?');
  await expect(cards(page).nth(1).locator('li[data-author="user"]')).toContainText('It was at noon.');
  await expect(panel(page).getByRole('heading', { name: 'Comments' })).toContainText('2');
  // The words are marked in the text where they are, with the marks inside them left in (a bold word is one passage).
  await expectMarked(page, friday.id, 'Friday');
  await expectMarked(page, green.id, 'The build is green.');
  await expect(editorOf(page).locator('.pd-thread')).toHaveCount(2);
  // Beside the text on a wide page.
  const [editorBox, panelBox] = await Promise.all([page.locator('.pd-editor').boundingBox(), panel(page).boundingBox()]);
  expect(panelBox!.x).toBeGreaterThan(editorBox!.x + editorBox!.width - 2);
  // A click on the card marks the thread as the one looked at; a click on the words does the same.
  await cards(page).nth(1).locator('.pd-quote').click();
  await expect(cards(page).nth(1)).toHaveAttribute('aria-current', 'true');
  await expect(page.locator(`.pd-editor [data-active-thread="${green.id}"]`)).toHaveCount(1);
  await editorOf(page).locator(`[data-pd-thread="${friday.id}"]`).first().click();
  await expect(cards(page).nth(0)).toHaveAttribute('aria-current', 'true');
  await expect(cards(page).nth(1)).not.toHaveAttribute('aria-current', 'true');
  await expect(page.locator(`.pd-editor [data-active-thread="${friday.id}"]`)).toHaveCount(1);
});

test('text that is selected is commented on: the passage is marked while the comment is written, and the thread is made on it as the Markdown holds it', async ({ page }) => {
  const store = new Store();
  await open(page, store);
  await expect(commentButton(page)).toBeDisabled();
  await expect(panel(page)).toContainText('No comments yet. Select some text, then press Comment.');
  await select(page, 'Friday, see the guide');
  await expect(commentButton(page)).toBeEnabled();
  await commentButton(page).click();
  const compose = panel(page).locator('.pd-compose');
  await expect(compose).toContainText('Friday, see the guide');
  expect(await editorOf(page).locator('.pd-thread-pending').evaluateAll((spans) => spans.map((s) => s.textContent).join(''))).toBe('Friday, see the guide');
  await expect(compose.getByRole('button', { name: 'Add comment' })).toBeDisabled();
  await compose.getByRole('textbox').fill('Is the guide up to date?');
  await compose.getByRole('button', { name: 'Add comment' }).click();
  await expect(compose).toHaveCount(0);
  await expect(cards(page)).toHaveCount(1);
  await expect(cards(page).first()).toContainText('Is the guide up to date?');
  await expect(cards(page).first()).toContainText('You');
  // What the page sent: the revision it saw, the passage as Markdown (with its marks in it) and what is around it.
  expect(store.made).toHaveLength(1);
  expect(store.made[0]).toMatchObject({ base: 3, quote: '**Friday**, [see the guide](https://example.com/guide)', body: 'Is the guide up to date?', start: PLAN.indexOf('**Friday**') });
  expect(store.made[0].prefix).toBe('# The plan\n\nShip it on ');
  expect(store.made[0].suffix).toBe(' now.\n\nThe build is green.\n\nSign');
  expect(store.threads[0].quote).toBe('**Friday**, [see the guide](https://example.com/guide)');
  // The mark is the thread's now, and the pending one is gone.
  await expect(editorOf(page).locator('.pd-thread-pending')).toHaveCount(0);
  await expectMarked(page, store.threads[0].id, 'Friday, see the guide');
  await expect(cards(page).first()).toHaveAttribute('aria-current', 'true');
  // The document was not changed by it.
  expect(store.puts).toEqual([]);
});

test('a comment that is dropped leaves nothing marked, and one on text that was typed and not saved yet is made on the revision that save made', async ({ page }) => {
  const store = new Store();
  await open(page, store);
  await select(page, 'The build is green.');
  await commentButton(page).click();
  await expect(editorOf(page).locator('.pd-thread-pending')).toHaveText('The build is green.');
  await panel(page).getByRole('button', { name: 'Cancel' }).click();
  await expect(editorOf(page).locator('.pd-thread-pending')).toHaveCount(0);
  await expect(panel(page).locator('.pd-compose')).toHaveCount(0);
  expect(store.made).toEqual([]);

  // Typed, and the second's wait for the save not yet over: the save is made before the comment is started.
  await editorOf(page).getByText('Sign-off is on Monday.').click();
  await page.keyboard.press('End');
  await page.waitForTimeout(100);
  await page.keyboard.type(' Maybe.');
  await expect(state(page)).toHaveText('Unsaved changes · Revision 3');
  await select(page, 'Maybe.');
  await commentButton(page).click();
  await expect(panel(page).locator('.pd-compose')).toBeVisible();
  expect(store.puts).toEqual([{ markdown: PLAN.replace('Monday.', 'Monday. Maybe.'), base: 3 }]);
  await panel(page).locator('.pd-compose').getByRole('textbox').fill('Maybe?');
  await panel(page).locator('.pd-compose').getByRole('button', { name: 'Add comment' }).click();
  await expect(cards(page)).toHaveCount(1);
  expect(store.made[0]).toMatchObject({ base: 4, quote: 'Maybe.' });
  expect(store.threads[0].quote).toBe('Maybe.');
});

test('the passage is refused when it is too long for a comment, and a reason is given', async ({ page }) => {
  const store = new Store();
  const long = `# Long\n\n${'word '.repeat(1100).trim()}.\n`;
  store.texts.set(3, long);
  await open(page, store, { ready: 'word word' });
  await editorOf(page).getByText('word word').first().click();
  await page.keyboard.press('Control+a');
  await expect(commentButton(page)).toBeEnabled();
  await commentButton(page).click();
  await expect(page.getByRole('alert')).toContainText('Select less text: a comment can be on at most 5000 characters.');
  await expect(panel(page).locator('.pd-compose')).toHaveCount(0);
  expect(store.made).toEqual([]);
});

test('a thread is answered, resolved with a last comment and opened again; a resolved one is out of the way until asked for', async ({ page }) => {
  const store = new Store();
  const green = seeded(store, 'The build is green.', 'Is it?', 'agent');
  await open(page, store);
  const card = cards(page).first();
  await expect(card.getByRole('button', { name: 'Reply', exact: true })).toBeDisabled();
  // Sent with Ctrl+Enter, which an empty box does not.
  await card.getByRole('textbox', { name: 'Reply' }).press('Control+Enter');
  await expect(card.locator('li')).toHaveCount(1);
  await card.getByRole('textbox', { name: 'Reply' }).fill('Yes, it is.');
  await card.getByRole('textbox', { name: 'Reply' }).press('Control+Enter');
  await expect(card.locator('li')).toHaveCount(2);
  await expect(card.locator('li').nth(1)).toContainText('Yes, it is.');
  await expect(card.getByRole('textbox', { name: 'Reply' })).toHaveValue('');
  // Resolve without a word of its own, then with.
  await card.getByRole('textbox', { name: 'Reply' }).fill('Closing this.');
  await expect(card.getByRole('button', { name: 'Reply and resolve' })).toBeVisible();
  await card.getByRole('button', { name: 'Reply and resolve' }).click();
  await expect(cards(page)).toHaveCount(0);
  expect(store.threads[0].status).toBe('resolved');
  expect(store.threads[0].comments.map((c) => c.body)).toEqual(['Is it?', 'Yes, it is.', 'Closing this.']);
  // No longer marked in the text; counted, and shown on request.
  await expect(editorOf(page).locator('.pd-thread')).toHaveCount(0);
  await expect(panel(page).getByRole('button', { name: 'Show resolved (1)' })).toBeVisible();
  await panel(page).getByRole('button', { name: 'Show resolved (1)' }).click();
  await expect(cards(page)).toHaveCount(1);
  await expect(cards(page).first()).toContainText('Resolved');
  await expect(cards(page).first().getByRole('textbox')).toHaveCount(0);
  await cards(page).first().getByRole('button', { name: 'Reopen' }).click();
  await expect(cards(page).first().getByRole('textbox', { name: 'Reply' })).toBeVisible();
  await expectMarked(page, green.id, 'The build is green.');
  await expect(panel(page).getByRole('button', { name: /resolved/i })).toHaveCount(0);
  // Resolved with nothing written: just closed.
  await cards(page).first().getByRole('button', { name: 'Resolve', exact: true }).click();
  await expect(cards(page)).toHaveCount(0);
  expect(store.threads[0].comments).toHaveLength(3);
});

test('a reply that could not be made keeps what was written, and says why', async ({ page }) => {
  const store = new Store();
  seeded(store, 'The build is green.', 'Is it?');
  await open(page, store);
  const card = cards(page).first();
  store.refuse = { status: 500, error: 'The documents store could not do that' };
  await card.getByRole('textbox', { name: 'Reply' }).fill('A long answer I would not want to lose.');
  await card.getByRole('button', { name: 'Reply', exact: true }).click();
  await expect(card.getByRole('alert')).toContainText('Could not comment: The documents store could not do that');
  await expect(card.getByRole('textbox', { name: 'Reply' })).toHaveValue('A long answer I would not want to lose.');
  await expect(card.locator('li')).toHaveCount(1);
  store.refuse = null;
  await card.getByRole('button', { name: 'Reply', exact: true }).click();
  await expect(card.locator('li')).toHaveCount(2);
  // A new comment that was refused stays open, with the reason, and its words kept.
  await select(page, 'Sign-off is on Monday.');
  await commentButton(page).click();
  store.refuse = { status: 422, error: 'That passage is not in the document at revision 3' };
  await panel(page).locator('.pd-compose').getByRole('textbox').fill('Who signs?');
  await panel(page).locator('.pd-compose').getByRole('button', { name: 'Add comment' }).click();
  await expect(panel(page).locator('.pd-compose')).toContainText('That passage is not in the document at revision 3');
  await expect(panel(page).locator('.pd-compose').getByRole('textbox')).toHaveValue('Who signs?');
  await expect(editorOf(page).locator('.pd-thread-pending')).toHaveText('Sign-off is on Monday.');
});

test('a comment the agent writes shows up when the stream says the comments changed, and the page asks again after a stream that dropped', async ({ page }) => {
  const store = new Store();
  await open(page, store);
  await expect(cards(page)).toHaveCount(0);
  let asked = 0;
  await page.route(`**${DOCUMENT}/threads`, (route) => (route.request().method() === 'GET' ? (asked++, route.fallback()) : route.fallback()));
  const green = seeded(store, 'The build is green.', 'Is it?', 'agent');
  await told(page, 'threads', { at: '2026-10-02T10:00:00.000Z' });
  await expect(cards(page)).toHaveCount(1);
  await expect(cards(page).first().locator('li[data-author="agent"]')).toContainText('Is it?');
  await expectMarked(page, green.id, 'The build is green.');
  expect(asked).toBe(1);
  // The stream drops; a comment is written while it is down; the new stream opening is how the page finds out.
  await page.evaluate(() => (window as any).streams[0].emit('error', null));
  seeded(store, 'Sign-off is on Monday.', 'Who signs off?', 'agent');
  await expect(cards(page)).toHaveCount(2, { timeout: 8000 });
  expect(await page.evaluate(() => (window as any).streams.length)).toBe(2);
});

test('a passage stays marked on its words while text is typed before it and in it, and goes where the server says it went when the document is changed from outside', async ({ page }) => {
  const store = new Store();
  const green = seeded(store, 'The build is green.', 'Is it?');
  await open(page, store);
  await expectMarked(page, green.id, 'The build is green.');
  // Typed before it, in the paragraph above, and after the passage's end (not in it).
  await editorOf(page).getByText('Ship it on').first().click();
  await page.keyboard.press('End');
  await page.waitForTimeout(100);
  await page.keyboard.type(' Early.');
  await expectMarked(page, green.id, 'The build is green.');
  await editorOf(page).getByText('The build is green.').click();
  await page.keyboard.press('End');
  await page.waitForTimeout(100);
  await page.keyboard.type(' More.');
  await expectMarked(page, green.id, 'The build is green.');
  // Typed inside it: it is part of the passage.
  // Before "green": past " More." and "green."
  for (let n = 0; n < 12; n++) await page.keyboard.press('ArrowLeft');
  await page.keyboard.type('really ');
  await expectMarked(page, green.id, 'The build is really green.');
  await expect.poll(() => store.markdown, { timeout: 8000 }).toContain('The build is really green. More.');
  await expect(state(page)).toHaveText(/^Saved · Revision \d+$/);
  // The agent adds a paragraph before it and changes the one after: the server followed the passage, and says where it is.
  store.elsewhere(store.markdown.replace('Sign-off is on Monday.', 'Sign-off is on Tuesday.').replace('# The plan\n', '# The plan\n\nA new first paragraph.\n'));
  await told(page, 'revision', { revision: store.revision, author: 'agent', at: '2026-10-02T10:00:00.000Z' });
  await expect(editorOf(page)).toContainText('A new first paragraph.');
  await expect(cards(page).first()).toContainText('The build is really green.');
  await expectMarked(page, green.id, 'The build is really green.');
  // It answers the comment by rewriting the passage (the server puts the passage on what stands there now).
  store.elsewhere(store.markdown.replace('The build is really green.', 'Everything passes now.'));
  store.place(green.id, 'Everything passes now.');
  await told(page, 'revision', { revision: store.revision, author: 'agent', at: '2026-10-02T10:01:00.000Z' });
  await expect(editorOf(page)).toContainText('Everything passes now. More.');
  await expect.poll(() => marked(page, green.id)).toBe('Everything passes now.');
  await expect(cards(page).first().locator('.pd-quote')).toHaveText('Everything passes now.');
});

test('a comment whose passage is no longer in the document says so, can still be answered, and one that cannot be marked in the text says that', async ({ page }) => {
  const text = '# Notes\n\n* a\n* b\n\nSign-off is on Monday.\n';
  const store = new Store();
  store.texts.set(3, text);
  const gone = seeded(store, 'Sign-off is on Monday.', 'Who signs off?');
  // Words the editor does not write as they are in the file (its bullet is another), too few to be found without their marks.
  const odd = seeded(store, '* a', 'Why this one?');
  store.elsewhere(text.replace('Sign-off is on Monday.\n', ''));
  await open(page, store, { ready: 'Notes' });
  await expect(cards(page)).toHaveCount(2);
  const first = cards(page).filter({ hasText: 'Who signs off?' });
  await expect(first).toContainText('The passage this comment was on is no longer in the document.');
  await expect(first.locator('.pd-quote')).toHaveText('Sign-off is on Monday.');
  await first.getByRole('textbox', { name: 'Reply' }).fill('Nobody now.');
  await first.getByRole('button', { name: 'Reply', exact: true }).click();
  await expect(first.locator('li')).toHaveCount(2);
  const second = cards(page).filter({ hasText: 'Why this one?' });
  await expect(second).toContainText('The passage could not be marked in the text.');
  await expectMarked(page, gone.id, '');
  await expectMarked(page, odd.id, '');
});

test('a passage is found in the text the editor writes when the file is written in another style', async ({ page }) => {
  const text = '# List\n\n* first item\n* second item\n\nAfter the list.\n';
  const store = new Store();
  store.texts.set(3, text);
  const thread = seeded(store, 'first item\n* second item', 'These two?');
  await open(page, store, { ready: 'first item' });
  // The editor writes `-`: the passage, kept as the file has it, is found by its words.
  await expect(cards(page)).toHaveCount(1);
  await expectMarked(page, thread.id, 'first itemsecond item');
  await expect(editorOf(page).locator('li')).toHaveCount(2);
});

test('the comments are under the text at a phone\'s width, with no sideways scrolling, and the comment button is within reach', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  const store = new Store();
  seeded(store, 'The build is green.', 'Is it? '.repeat(30), 'agent');
  await open(page, store);
  await expect(cards(page)).toHaveCount(1);
  const [editorBox, panelBox] = await Promise.all([page.locator('.pd-editor').boundingBox(), panel(page).boundingBox()]);
  expect(panelBox!.y).toBeGreaterThan(editorBox!.y + editorBox!.height - 2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  expect(await page.evaluate(() => [...document.querySelectorAll('.pd-threads *')].every((e) => e.getBoundingClientRect().right <= window.innerWidth + 1))).toBe(true);
  await select(page, 'Sign-off is on Monday.');
  await expect(commentButton(page)).toBeEnabled();
  expect((await commentButton(page).boundingBox())!.x + (await commentButton(page).boundingBox())!.width).toBeLessThanOrEqual(390);
});

test('what the comments say is in German in a German portal', async ({ page }) => {
  const store = new Store();
  seeded(store, 'The build is green.', 'Is it?', 'agent');
  const done = seeded(store, 'Sign-off is on Monday.', 'Who?');
  store.settle(done.id, 'resolved');
  await open(page, store, { language: 'de' });
  await expect(panel(page).getByRole('heading', { name: 'Kommentare' })).toBeVisible();
  await expect(cards(page).first()).toContainText('Der Agent');
  await expect(cards(page).first().getByRole('button', { name: 'Antworten', exact: true })).toBeVisible();
  await expect(cards(page).first().getByRole('button', { name: 'Erledigen', exact: true })).toBeVisible();
  await expect(panel(page).getByRole('button', { name: 'Erledigte anzeigen (1)' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Kommentieren', exact: true })).toBeDisabled();
  await select(page, 'Ship it on');
  await page.getByRole('button', { name: 'Kommentieren', exact: true }).click();
  await expect(panel(page).locator('.pd-compose')).toContainText('Neuer Kommentar');
  await expect(panel(page).locator('.pd-compose').getByRole('button', { name: 'Kommentar hinzufügen' })).toBeVisible();
  await expect(panel(page).locator('.pd-compose').getByRole('button', { name: 'Abbrechen' })).toBeVisible();
});

test('the list of documents says how many comments are open on each', async ({ page }) => {
  const store = new Store();
  seeded(store, 'The build is green.', 'Is it?');
  seeded(store, 'Sign-off is on Monday.', 'Who?');
  await open(page, store);
  await page.getByRole('button', { name: /All documents/ }).click();
  await expect(page.getByRole('region', { name: 'site' }).getByRole('listitem')).toHaveText([/plan\.md · Changed .* · 2 open comments$/]);
  store.threads[1].status = 'resolved';
  await page.goto(`/x/${NAME}/documents`);
  await expect(page.getByRole('region', { name: 'site' }).getByRole('listitem')).toHaveText([/plan\.md · Changed .* · 1 open comment$/]);
});

test('a comment with @agent asks the agent: the thread says the agent was asked, and that it answered, until the person reacts', async ({ page }) => {
  const store = new Store();
  await open(page, store);
  await expect(panel(page)).toContainText('Write @agent in a comment to ask the agent to answer it.');
  await select(page, 'The build is green.');
  await commentButton(page).click();
  const compose = panel(page).locator('.pd-compose');
  await compose.getByRole('textbox').fill('Is it? @agent, please check.');
  await compose.getByRole('button', { name: 'Add comment' }).click();
  await expect(cards(page)).toHaveCount(1);
  // Sent as it was written: the server decides what a mention is.
  expect(store.made[0].body).toBe('Is it? @agent, please check.');
  const asked = cards(page).first().locator('.pd-asked');
  await expect(asked).toHaveText('Asked the agent · First chat');
  await expect(asked).toHaveAttribute('data-asked', 'waiting');
  await expect(page.getByRole('status').filter({ hasText: 'could not be reached' })).toHaveCount(0);
  // The agent answers, and the page is told the comments changed: the thread is answered, with the answer in it.
  store.comment(store.threads[0].id, 'Yes, it is.', 'agent');
  await told(page, 'threads', { at: '2026-10-02T10:00:00.000Z' });
  await expect(asked).toHaveText('The agent answered');
  await expect(asked).toHaveAttribute('data-asked', 'answered');
  await expect(cards(page).first().locator('li[data-author="agent"]')).toContainText('Yes, it is.');
  // A reply of the person's is the reaction: nothing is to be told any more.
  await cards(page).first().getByRole('textbox', { name: 'Reply' }).fill('Thanks.');
  await cards(page).first().getByRole('button', { name: 'Reply', exact: true }).click();
  await expect(cards(page).first().locator('li')).toHaveCount(3);
  await expect(cards(page).first().locator('.pd-asked')).toHaveCount(0);
  // A reply that asks again is asked again.
  await cards(page).first().getByRole('textbox', { name: 'Reply' }).fill('One more thing, @agent.');
  await cards(page).first().getByRole('button', { name: 'Reply', exact: true }).click();
  await expect(cards(page).first().locator('.pd-asked')).toHaveText('Asked the agent · First chat');
});

test('a comment the agent could not be asked with is kept, and the page says why and that it was not delivered', async ({ page }) => {
  const store = new Store();
  store.unreach = 'This chat was discarded';
  await open(page, store);
  await select(page, 'The build is green.');
  await commentButton(page).click();
  const compose = panel(page).locator('.pd-compose');
  await compose.getByRole('textbox').fill('Is it? @agent');
  await compose.getByRole('button', { name: 'Add comment' }).click();
  await expect(cards(page)).toHaveCount(1);
  await expect(cards(page).first()).toContainText('Is it? @agent');
  await expect(cards(page).first().locator('.pd-asked')).toHaveText('Not delivered to the agent');
  const warning = page.getByRole('status').filter({ hasText: 'Saved, but the agent could not be reached: This chat was discarded' });
  await expect(warning).toBeVisible();
  // The thread the page keeps is the thread, not the answer that carried the reason.
  await warning.getByRole('button', { name: 'Dismiss' }).click();
  await expect(warning).toHaveCount(0);
  // A reply that asks has the same reason, and is kept too.
  await cards(page).first().getByRole('textbox', { name: 'Reply' }).fill('Hello? @agent');
  await cards(page).first().getByRole('button', { name: 'Reply', exact: true }).click();
  await expect(cards(page).first().locator('li')).toHaveCount(2);
  await expect(page.getByRole('status').filter({ hasText: 'Saved, but the agent could not be reached' })).toBeVisible();
});

test('what asking the agent says is in German in a German portal', async ({ page }) => {
  const store = new Store();
  const green = seeded(store, 'The build is green.', 'Is it? @agent');
  Object.assign(green, { toAgent: true, ping: { chat: 'a', sent: true, title: 'First chat' } });
  const friday = seeded(store, '**Friday**', 'Why Friday?');
  Object.assign(friday, { answered: true });
  const monday = seeded(store, 'Sign-off is on Monday.', 'Who? @agent');
  Object.assign(monday, { toAgent: true, ping: { chat: 'a', sent: false, title: 'First chat' } });
  await open(page, store, { language: 'de' });
  await expect(panel(page)).toContainText('Schreibe @agent in einen Kommentar, damit der Agent ihn beantwortet.');
  await expect(cards(page).filter({ hasText: 'Is it?' }).locator('.pd-asked')).toHaveText('Den Agenten gefragt · First chat');
  await expect(cards(page).filter({ hasText: 'Why Friday?' }).locator('.pd-asked')).toHaveText('Der Agent hat geantwortet');
  await expect(cards(page).filter({ hasText: 'Who?' }).locator('.pd-asked')).toHaveText('Nicht beim Agenten angekommen');
  store.unreach = 'Dieser Chat wurde verworfen';
  await select(page, 'Ship it on');
  await page.getByRole('button', { name: 'Kommentieren', exact: true }).click();
  await panel(page).locator('.pd-compose').getByRole('textbox').fill('@agent?');
  await panel(page).locator('.pd-compose').getByRole('button', { name: 'Kommentar hinzufügen' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Gespeichert, aber der Agent war nicht zu erreichen: Dieser Chat wurde verworfen' })).toBeVisible();
});

test('the list of documents says how many comments the agent answered, and none when it answered nothing', async ({ page }) => {
  const store = new Store();
  const first = seeded(store, 'The build is green.', 'Is it? @agent');
  seeded(store, 'Sign-off is on Monday.', 'Who?');
  await open(page, store);
  await page.getByRole('button', { name: /All documents/ }).click();
  await expect(page.getByRole('region', { name: 'site' }).getByRole('listitem')).toHaveText([/plan\.md · Changed .* · 2 open comments$/]);
  store.comment(first.id, 'Yes.', 'agent');
  await page.goto(`/x/${NAME}/documents`);
  await expect(page.getByRole('region', { name: 'site' }).getByRole('listitem')).toHaveText([/plan\.md · Changed .* · 2 open comments · 1 answered by the agent$/]);
});
