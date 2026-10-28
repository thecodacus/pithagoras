import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { type Locator, type Page } from '@playwright/test';
import { carry, locate, passage } from '../../web/anchor.js';
import { merge3 } from '../../web/merge.js';
import { test, expect, mockPortal, reply, DONE } from '../../../../tests/browser/portal-mock';

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
const web = (file: string) => readFileSync(new URL(`../../web/${file}`, import.meta.url), 'utf8');
const address = (file: string) => `/api/extension-ui/${NAME}/${file}`;
const API = `/api/x/${NAME}`;
const DOCUMENT = `${API}/folders/${FOLDER}/documents/${ID}`;

test.beforeAll(() => {
  execFileSync(process.execPath, [fileURLToPath(new URL('../../build.mjs', import.meta.url))], { stdio: 'ignore' });
});

const PLAN = '# The plan\n\nShip it on **Friday**, [see the guide](https://example.com/guide) now.\n\nThe build is green.\n\nSign-off is on Monday.\n';

interface Comment { id: string; author: 'user' | 'agent'; body: string; at: string; edited?: string }
interface Thread {
  id: string; status: 'open' | 'resolved'; orphaned: boolean; quote: string; prefix: string; suffix: string; start: number | null; end: number | null;
  revision: number; createdAt: string; updatedAt: string; comments: Comment[];
  /** Asked of the agent and not answered; answered by the agent and not reacted to; the last time the agent was asked. */
  toAgent?: boolean; answered?: boolean;
  ping?: { id: number; chat: string | null; comment: string; sent: boolean; title: string | null; state: 'pending' | 'sent' | 'failed'; error?: string } | null;
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
  /** Where a comment that asks the agent can go, as the server says with the threads. */
  ask = { chats: [{ id: 'a', title: 'First chat' }], own: false, workspace: '/w/site' };
  /** How many requests to make a thread were started, and how long the server keeps each before it answers. */
  started = 0;
  delay = 0;
  /** The same for the requests that take a comment away. */
  deleting = 0;
  deleteDelay = 0;
  /** What the page sent to open a chat, and to change or take away a comment. */
  opened: any[] = [];
  requests: { method: string; comment: string; body?: any; draft?: boolean }[] = [];
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
    return { revision: this.revision, threads: this.threads, ask: this.ask };
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
    return reply(201, this.asked(thread, body.body, author, (body as any).chat));
  }

  /**
   * As the server does for a comment that was made or changed: `@agent` in the person's asks the agent of the chat the page says (and
   * not delivered if that is none that works in the folder), taking the mention away takes the ask back, and the agent's comment answers.
   */
  private asked(thread: Thread, body: string, author: 'user' | 'agent', chat?: string | null) {
    if (author === 'agent') return Object.assign(thread, { toAgent: false, answered: thread.comments.length > 1 });
    thread.answered = false;
    const last = thread.comments.at(-1)!;
    if (!/@agent\b/i.test(body)) {
      if (thread.ping && !thread.ping.sent) Object.assign(thread, { ping: null, toAgent: false });
      return thread;
    }
    if (thread.ping?.comment === last.id) return thread;
    const found = this.ask.chats.find((c) => c.id === chat);
    thread.toAgent = true;
    thread.ping = { id: ++this.count, chat: chat ?? null, comment: last.id, sent: false, title: found?.title ?? null, state: found ? 'pending' : 'failed', ...(found ? {} : { error: 'The chat to ask is not one that works in this folder' }) };
    return thread;
  }

  /**
   * A comment of the person's changed. As the person types it (`draft`) it is the last of an open thread; once it is in the list it is any of
   * theirs, in an open thread or a resolved one, marked as edited, and asking the agent only if it is the last of an open thread.
   */
  edit(id: string, comment: string, body: { body: string; chat?: string | null; draft?: boolean }) {
    this.requests.push({ method: 'PUT', comment, body });
    const thread = this.threads.find((t) => t.id === id);
    if (!thread) return reply(404, { error: 'There is no such comment thread', code: 'thread_not_found' });
    if (this.refuse) return reply(this.refuse.status, { error: this.refuse.error });
    const mine = thread.comments.find((c) => c.id === comment);
    if (body.draft) {
      if (thread.status !== 'open') return reply(409, { error: 'The thread is resolved', code: 'thread_resolved' });
      if (!mine) return reply(404, { error: 'There is no such comment', code: 'comment_not_found' });
      if (thread.comments.at(-1) !== mine) return reply(409, { error: 'Something was said in the thread after that comment', code: 'comment_not_last' });
      mine.body = body.body;
      thread.updatedAt = this.stamp();
      return this.asked(thread, body.body, 'user', body.chat);
    }
    if (!mine) return reply(404, { error: 'There is no such comment', code: 'comment_not_found' });
    if (mine.author !== 'user') return reply(409, { error: 'That comment is not yours to change', code: 'comment_not_yours' });
    if (mine.body === body.body) return thread;
    mine.body = body.body;
    mine.edited = thread.updatedAt = this.stamp();
    if (thread.status === 'open' && thread.comments.at(-1) === mine) return this.asked(thread, body.body, 'user', body.chat);
    if (!/@agent\b/i.test(body.body) && thread.ping?.comment === mine.id && !thread.ping.sent) Object.assign(thread, { ping: null, toAgent: false });
    return thread;
  }

  /** A comment of the person's taken away: the one typed away (`draft`, the last), or any of theirs, the thread going with its only comment. */
  remove(id: string, comment: string, draft = false) {
    this.requests.push({ method: 'DELETE', comment, ...(draft ? { draft } : {}) });
    const thread = this.threads.find((t) => t.id === id);
    if (!thread) return reply(404, { error: 'There is no such comment thread', code: 'thread_not_found' });
    const mine = thread.comments.find((c) => c.id === comment);
    if (!mine || (draft && thread.comments.at(-1) !== mine)) return reply(404, { error: 'There is no such comment', code: 'comment_not_found' });
    if (mine.author !== 'user') return reply(409, { error: 'That comment is not yours to change', code: 'comment_not_yours' });
    if (thread.comments.length === 1) {
      this.threads = this.threads.filter((t) => t !== thread);
      return { removed: 'thread', thread: null };
    }
    thread.comments.splice(thread.comments.indexOf(mine), 1);
    if (thread.ping && !thread.comments.some((c) => c.id === thread.ping!.comment)) Object.assign(thread, { ping: null, toAgent: false });
    return { removed: 'comment', thread };
  }

  /** A whole thread taken away: the person's, while the agent has not commented in it. */
  removeThread(id: string) {
    this.requests.push({ method: 'DELETE-THREAD', comment: id });
    const thread = this.threads.find((t) => t.id === id);
    if (!thread) return reply(404, { error: 'There is no such comment thread', code: 'thread_not_found' });
    if (thread.comments[0].author !== 'user') return reply(409, { error: 'That thread was started by the agent', code: 'thread_not_yours' });
    if (thread.comments.some((c) => c.author === 'agent')) return reply(409, { error: 'The agent has commented in this thread', code: 'thread_answered' });
    this.threads = this.threads.filter((t) => t !== thread);
    return { removed: 'thread' };
  }

  /** The person has read what the agent said. */
  seen(id: string) {
    const thread = this.threads.find((t) => t.id === id)!;
    thread.answered = false;
    return thread;
  }

  /** The passage of a thread put on `words` in the text as it is now, as the server does when it knows (it just made that change). */
  place(id: string, words: string) {
    const thread = this.threads.find((t) => t.id === id)!;
    const start = this.markdown.indexOf(words);
    Object.assign(thread, passage(this.markdown, start, start + words.length), { revision: this.revision, orphaned: false });
  }

  /** A comment, as the server adds it. */
  comment(id: string, body: string, author: 'user' | 'agent' = 'user', chat?: string | null) {
    const thread = this.threads.find((t) => t.id === id);
    if (!thread) return reply(404, { error: 'There is no such comment thread' });
    if (this.refuse) return reply(this.refuse.status, { error: this.refuse.error });
    if (thread.status !== 'open') return reply(409, { error: 'The thread is resolved: it is to be reopened to be added to', code: 'thread_resolved' });
    const at = this.stamp();
    thread.comments.push({ id: `c${++this.count}`, author, body, at });
    thread.updatedAt = at;
    return reply(201, this.asked(thread, body, author, chat));
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
async function open(page: Page, store: Store, { language, ready = 'Ship it on Friday', chat, first }: { language?: string; ready?: string; chat?: string; first?: string } = {}) {
  if (language) await page.addInitScript((code) => localStorage.setItem('pithagoras.language', code), language);
  // The chat the person was in, in this tab, before the page was opened.
  if (chat) await page.addInitScript((id) => sessionStorage.setItem('pithagoras-docs/chat', id), chat);
  const sessions = [{ id: 'a', title: 'First chat', workspace: '/w/site', status: 'idle', kind: 'task', pinned: false, updated_at: new Date().toISOString(), provider: null, model: null, thinking_level: null }];
  const folders = () => [{ id: FOLDER, name: 'site', path: '/w/site', chats: [{ id: 'a', title: 'First chat' }], documents: [{ id: ID, name: 'plan.md', title: 'The plan', revision: store.revision, size: 40, modified: '2026-10-01T11:00:00.000Z', openThreads: store.threads.filter((t) => t.status === 'open').length, answeredThreads: store.threads.filter((t) => t.answered).length }] }];
  await mockPortal(page, async ({ path: p, method, json, route, url }) => {
    if (p === '/api/extension-ui') return { extensions: [{ name: NAME, version: '0.1.0', entry: address('client.js') + '?v=1', style: address('client.css') + '?v=1', server: API }] };
    if (p.startsWith(address(''))) {
      await route.fulfill({ contentType: p.endsWith('.css') ? 'text/css' : 'text/javascript', body: web(p.slice(address('').length)) });
      return DONE;
    }
    if (p === `${API}/folders`) return { folders: folders() };
    if (p === DOCUMENT && method === 'GET') return store.read();
    if (p === DOCUMENT && method === 'PUT') { const { markdown, base } = json(); return store.save(markdown, base); }
    if (p === `${DOCUMENT}/threads` && method === 'GET') return store.list();
    if (p === `${DOCUMENT}/threads` && method === 'POST') {
      const body = json();
      store.started += 1;
      if (store.delay) await new Promise((resolve) => setTimeout(resolve, store.delay));
      return store.add(body);
    }
    const act = new RegExp(`^${DOCUMENT}/threads/(\\w+)/(comments|resolve|reopen|seen)$`).exec(p);
    if (act && method === 'POST') {
      if (act[2] === 'comments') return store.comment(act[1], json().body, 'user', json().chat);
      if (act[2] === 'resolve') return store.settle(act[1], 'resolved', json().body);
      if (act[2] === 'seen') return store.seen(act[1]);
      return store.settle(act[1], 'open');
    }
    const one = new RegExp(`^${DOCUMENT}/threads/(\\w+)/comments/(\\w+)$`).exec(p);
    if (one && method === 'PUT') return store.edit(one[1], one[2], json());
    if (one && method === 'DELETE') {
      store.deleting += 1;
      if (store.deleteDelay) await new Promise((resolve) => setTimeout(resolve, store.deleteDelay));
      return store.remove(one[1], one[2], url.searchParams.get('draft') === '1');
    }
    const whole = new RegExp(`^${DOCUMENT}/threads/(\\w+)$`).exec(p);
    if (whole && method === 'DELETE') return store.removeThread(whole[1]);
    // A chat opened for the folder, as the portal's own route makes one.
    if (p === '/api/sessions' && method === 'POST') {
      const made = { id: `n${store.opened.length + 1}`, title: json().title, workspace: json().workspace };
      store.opened.push(json());
      store.ask.chats.push({ id: made.id, title: made.title });
      return made;
    }
    if (p === '/api/sessions') return { sessions, executor: 'host' };
    if (p === '/api/models') return { models: [], providers: {} };
  }, { streams: 'open' });
  // A page of a chat first, as the person comes from one.
  if (first) {
    await page.goto(first);
    // Remembered once the chat is on screen.
    await expect.poll(() => page.evaluate(() => sessionStorage.getItem('pithagoras-docs/chat'))).toBe(first.split('/').pop());
  }
  await page.goto(`/x/${NAME}/documents?folder=${FOLDER}&doc=${ID}`);
  await expect(editorOf(page)).toContainText(ready);
}

const editorOf = (page: Page) => page.locator('.pd-editor .ProseMirror');
/** The list of all the comments, which is only there when the bar's Comments button has opened it. */
const panel = (page: Page) => page.getByRole('complementary', { name: /Comments|Kommentare/ });
/** The threads of the list that are on a passage in the text: a line each, which opens the thread's card on the sheet. */
const items = (page: Page) => panel(page).locator('.pd-item');
/** The threads of the list that are a card of their own there: the ones whose passage is gone or cannot be marked, and the resolved ones. */
const cards = (page: Page) => panel(page).locator('.pd-thread-card');
/** The card of a comment that floats over the sheet, and the thread (or the comment being written) in it. */
const popover = (page: Page) => page.locator('.pd-popover');
const shown = (page: Page) => popover(page).locator('.pd-thread-card');
const barButton = (page: Page) => page.getByRole('button', { name: /^(Comments|Kommentare)( \d+)?$/ });
const state = (page: Page) => page.locator('.pd-state');
/** What the marked passages of a thread read as. */
const mark = (page: Page, id: string) => editorOf(page).locator(`[data-pd-thread="${id}"]`).first();
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
  await closeCard(page);
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
/** The list is asked for with the bar's button. */
async function showList(page: Page) {
  await barButton(page).click();
  await expect(panel(page)).toBeVisible();
}
/** The card that is open is closed with a click on the heading, which no card covers: the text under a card is out of reach while it is open. */
async function closeCard(page: Page) {
  if (await popover(page).count()) {
    await editorOf(page).locator('h1').first().click();
    await expect(popover(page)).toHaveCount(0);
  }
}
/** The comment of thread `id` is opened as a click on its passage does: its card floats over the sheet. */
async function openThread(page: Page, id: string) {
  await closeCard(page);
  await mark(page, id).click();
  await expect(shown(page)).toHaveAttribute('data-thread', id);
  return shown(page);
}
/** Where the passage of thread `id` is on the screen, a rectangle for each line of it. */
const rectsOf = (page: Page, id: string) =>
  page.evaluate((id) => [...document.querySelectorAll(`.pd-editor [data-pd-thread="${id}"]`)].flatMap((el) => [...el.getClientRects()].map((r) => ({ top: r.top, bottom: r.bottom, left: r.left, right: r.right }))), id);
/** Whether the card is clear of every line of the passage (it does not cover a word of it). */
async function clearOf(page: Page, id: string) {
  const box = (await popover(page).boundingBox())!;
  return (await rectsOf(page, id)).every((r) => box.y >= r.bottom - 0.5 || box.y + box.height <= r.top + 0.5 || box.x >= r.right || box.x + box.width <= r.left);
}

/** A thread made on `quote`, in the store, as if it had been there when the page opened. */
function seeded(store: Store, quote: string, body: string, author: 'user' | 'agent' = 'user') {
  const start = store.markdown.indexOf(quote);
  const made = store.add({ base: store.revision, quote, prefix: store.markdown.slice(Math.max(0, start - 32), start), suffix: store.markdown.slice(start + quote.length, start + quote.length + 32), start, body }, author) as any;
  return made.body as Thread;
}

test('by default only the document is shown, its commented passages marked; a click on one opens its comment as a card under it, on the sheet, and only that one', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  const store = new Store();
  // Made in the other order than they are in the text.
  const green = seeded(store, 'The build is green.', 'Is it?', 'agent');
  const friday = seeded(store, '**Friday**', 'Why Friday?');
  store.comment(green.id, 'It was at noon.');
  await open(page, store);
  // The words are marked in the text where they are, with the marks inside them left in (a bold word is one passage).
  await expectMarked(page, friday.id, 'Friday');
  await expectMarked(page, green.id, 'The build is green.');
  await expect(editorOf(page).locator('.pd-thread')).toHaveCount(2);
  // Nothing else of the comments: no margin, no list under the text, no card.
  await expect(panel(page)).toHaveCount(0);
  await expect(page.locator('.pd-threads, .pd-thread-card, .pd-popover')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Comments' })).toHaveCount(0);
  // The bar has the way to the list, with how many are open.
  await expect(barButton(page)).toHaveAccessibleName('Comments 2');
  await expect(barButton(page)).toHaveAttribute('aria-expanded', 'false');

  // A click on a passage opens its thread, with who said what, floating on the sheet.
  const card = await openThread(page, green.id);
  await expect(page.locator('.pd-popover')).toHaveCount(1);
  await expect(card).toContainText('Is it?');
  await expect(card.locator('li[data-author="agent"]')).toContainText('The agent');
  await expect(card.locator('li[data-author="user"]')).toContainText('It was at noon.');
  await expect(card.getByRole('textbox', { name: 'Reply' })).toBeVisible();
  await expect(card.getByRole('button', { name: 'Resolve', exact: true })).toBeVisible();
  // The hint to ask the agent is the box's own placeholder, not a line of the card.
  await expect(card.getByRole('textbox', { name: 'Reply' })).toHaveAttribute('placeholder', 'Reply… (@agent asks the agent)');
  await expect(card).not.toContainText('Write @agent in a comment');
  await expect(page.locator(`.pd-editor [data-active-thread="${green.id}"]`)).toHaveCount(1);
  // On a wide page: beside its passage, level with it, at the right edge of the page, and the words stay readable at its left.
  const sheet = (await page.locator('.pd-sheet').boundingBox())!;
  const box = (await popover(page).boundingBox())!;
  await expect(popover(page)).toHaveAttribute('data-side', 'true');
  expect(Math.round(box.x + box.width)).toBeGreaterThan(Math.round(sheet.x + sheet.width) - 16);
  expect(box.x + box.width).toBeLessThanOrEqual(sheet.x + sheet.width);
  const rects = await rectsOf(page, green.id);
  expect(box.x).toBeGreaterThanOrEqual(Math.max(...rects.map((r) => r.right)));
  expect(Math.abs(box.y - rects[0].top)).toBeLessThan(8);
  expect(await clearOf(page, green.id)).toBe(true);
  // Another passage: that one is the only one open.
  await mark(page, friday.id).click();
  const other = shown(page);
  await expect(other).toHaveAttribute('data-thread', friday.id);
  await expect(page.locator('.pd-popover')).toHaveCount(1);
  await expect(other).toContainText('Why Friday?');
  await expect(other).not.toContainText('Is it?');
  expect(await clearOf(page, friday.id)).toBe(true);
  // Text that is no passage closes it.
  await editorOf(page).getByRole('heading', { name: 'The plan' }).click();
  await expect(popover(page)).toHaveCount(0);
  await expect(page.locator('.pd-editor [data-active-thread=""]')).toHaveCount(1);
});

test('the bar\'s Comments button shows the list of all the threads beside the sheet and hides it again; a thread chosen in it opens its card at its passage', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  const store = new Store();
  const green = seeded(store, 'The build is green.', 'Is it?', 'agent');
  const friday = seeded(store, '**Friday**', 'Why Friday?');
  store.comment(green.id, 'It was at noon.');
  await open(page, store);
  await showList(page);
  await expect(barButton(page)).toHaveAttribute('aria-expanded', 'true');
  await expect(panel(page).getByRole('heading', { name: 'Comments' })).toContainText('2');
  // In the order of the text, with the passage and the last that was said; beside the sheet on a wide page.
  await expect(items(page)).toHaveCount(2);
  await expect(items(page).nth(0)).toContainText('Friday');
  await expect(items(page).nth(0)).toContainText('You: Why Friday?');
  await expect(items(page).nth(1)).toContainText('The build is green.');
  await expect(items(page).nth(1)).toContainText('You: It was at noon.');
  await expect(panel(page)).toContainText('Write @agent in a comment to ask the agent to answer it.');
  const [sheet, list] = await Promise.all([page.locator('.pd-sheet').boundingBox(), panel(page).boundingBox()]);
  expect(list!.x).toBeGreaterThan(sheet!.x + sheet!.width - 2);
  // A thread with a passage in the text has no card in the list: it opens in the text.
  await expect(cards(page)).toHaveCount(0);
  await expect(popover(page)).toHaveCount(0);
  await items(page).nth(1).click();
  await expect(shown(page)).toHaveAttribute('data-thread', green.id);
  await expect(items(page).nth(1)).toHaveAttribute('aria-current', 'true');
  expect(await clearOf(page, green.id)).toBe(true);
  // A click on a passage marks its line in the list as well.
  await mark(page, friday.id).click();
  await expect(items(page).nth(0)).toHaveAttribute('aria-current', 'true');
  await expect(items(page).nth(1)).not.toHaveAttribute('aria-current', 'true');
  // The list is on request: the button hides it again, and so does Close; the card on the sheet stays as it was.
  await barButton(page).click();
  await expect(panel(page)).toHaveCount(0);
  await showList(page);
  await panel(page).getByRole('button', { name: 'Close' }).click();
  await expect(panel(page)).toHaveCount(0);
  await expect(barButton(page)).toHaveAttribute('aria-expanded', 'false');
});

test('threads that cannot be opened in the text are in the list: a resolved one is shown on request and opened again there, and no thread is out of reach', async ({ page }) => {
  const store = new Store();
  const green = seeded(store, 'The build is green.', 'Is it?');
  const done = seeded(store, 'Sign-off is on Monday.', 'Who?');
  store.settle(done.id, 'resolved');
  await open(page, store);
  // Resolved: not marked in the text, not counted as open, and put away until asked for.
  await expect(editorOf(page).locator('.pd-thread')).toHaveCount(1);
  await expect(barButton(page)).toHaveAccessibleName('Comments 1');
  await showList(page);
  await expect(items(page)).toHaveCount(1);
  await expect(cards(page)).toHaveCount(0);
  await panel(page).getByRole('button', { name: 'Show resolved (1)' }).click();
  await expect(cards(page)).toHaveCount(1);
  await expect(cards(page).first()).toContainText('Who?');
  await expect(cards(page).first()).toContainText('Resolved');
  await cards(page).first().getByRole('button', { name: 'Reopen' }).click();
  // Open again: marked in the text, a line in the list that opens it there.
  await expectMarked(page, done.id, 'Sign-off is on Monday.');
  await expect(cards(page)).toHaveCount(0);
  await expect(items(page)).toHaveCount(2);
  await expect(barButton(page)).toHaveAccessibleName('Comments 2');
  await items(page).filter({ hasText: 'Who?' }).click();
  await expect(shown(page)).toHaveAttribute('data-thread', done.id);
  expect(green.id).toBeTruthy();
});

test('text that is selected is commented on: its card opens at the selection while the comment is written, nothing is sent while it is typed, and Send makes the thread on it', async ({ page }) => {
  const store = new Store();
  await open(page, store);
  await expect(commentButton(page)).toBeDisabled();
  await showList(page);
  await expect(panel(page)).toContainText('No comments yet. Select some text, then press Comment.');
  await barButton(page).click();
  await select(page, 'Friday, see the guide');
  await expect(commentButton(page)).toBeEnabled();
  await commentButton(page).click();
  const compose = popover(page).locator('.pd-compose');
  await expect(compose).toContainText('New comment');
  expect(await editorOf(page).locator('.pd-thread-pending').evaluateAll((spans) => spans.map((s) => s.textContent).join(''))).toBe('Friday, see the guide');
  // The card is at the selection, under it, and the box has the focus.
  const box0 = (await popover(page).boundingBox())!;
  const pending = await page.evaluate(() => [...document.querySelectorAll('.pd-thread-pending')].flatMap((el) => [...el.getClientRects()].map((r) => ({ top: r.top, bottom: r.bottom, right: r.right }))));
  expect(pending.every((r) => box0.x >= r.right || box0.y >= r.bottom || box0.y + box0.height <= r.top)).toBe(true);
  await expect(compose.getByRole('textbox')).toBeFocused();
  const send = compose.getByRole('button', { name: 'Send' });
  await expect(send).toBeDisabled();
  await compose.getByRole('textbox').fill('Is the guide up to date?');
  // Nothing goes while it is typed, however long the pause: the comment is the person's until it is sent.
  await page.waitForTimeout(1500);
  expect(store.made).toEqual([]);
  await compose.getByRole('textbox').fill('Is the guide up to date? Really?');
  await send.click();
  await expect.poll(() => store.made.length).toBe(1);
  // What the page sent: the revision it saw, the passage as Markdown (with its marks in it) and what is around it. No chat: it asks nobody.
  expect(store.made[0]).toEqual({ base: 3, quote: '**Friday**, [see the guide](https://example.com/guide)', prefix: '# The plan\n\nShip it on ', suffix: ' now.\n\nThe build is green.\n\nSign', start: PLAN.indexOf('**Friday**'), body: 'Is the guide up to date? Really?' });
  expect(store.threads[0].quote).toBe('**Friday**, [see the guide](https://example.com/guide)');
  // The card is the thread's from then on, with the comment in it, and the passage is marked as its own; the document was not changed by any of it.
  await expect(compose).toHaveCount(0);
  await expect(shown(page)).toHaveAttribute('data-thread', store.threads[0].id);
  await expect(shown(page)).toContainText('Is the guide up to date? Really?');
  await expect(shown(page)).toContainText('You');
  await expect(editorOf(page).locator('.pd-thread-pending')).toHaveCount(0);
  await expectMarked(page, store.threads[0].id, 'Friday, see the guide');
  expect(store.requests).toEqual([]);
  expect(store.puts).toEqual([]);
  // Ctrl+Enter sends it as well (and so does the shortcut that starts it, Ctrl+Alt+M); with nothing typed it sends nothing.
  await select(page, 'The build is green.');
  await expect(commentButton(page)).toBeEnabled();
  await page.keyboard.press('Control+Alt+m');
  const box = popover(page).locator('.pd-compose').getByRole('textbox');
  await expect(box).toBeFocused();
  await box.press('Control+Enter');
  await box.fill('Green?');
  await box.press('Control+Enter');
  await expect.poll(() => store.made.length).toBe(2);
  expect(store.made[1]).toMatchObject({ body: 'Green?' });
  await showList(page);
  await expect(items(page)).toHaveCount(2);
});

test('a comment being written is closed with Escape or a click outside: given up when nothing was typed, kept (its passage marked) when there are words, and a click on the passage opens it again', async ({ page }) => {
  const store = new Store();
  await open(page, store);
  const compose = popover(page).locator('.pd-compose');
  const pending = editorOf(page).locator('.pd-thread-pending');
  // Nothing typed: Escape gives it up, and the text has the focus again.
  await select(page, 'The build is green.');
  await commentButton(page).click();
  await expect(pending).toHaveText('The build is green.');
  await compose.getByRole('textbox').press('Escape');
  await expect(popover(page)).toHaveCount(0);
  await expect(pending).toHaveCount(0);
  await expect(editorOf(page)).toBeFocused();
  // Nothing typed, and a click outside (on the bar): the same.
  await select(page, 'The build is green.');
  await commentButton(page).click();
  await expect(compose).toBeVisible();
  await page.locator('.pd-titlebar').click({ position: { x: 300, y: 4 } });
  await expect(popover(page)).toHaveCount(0);
  await expect(pending).toHaveCount(0);
  // Words typed: closing keeps them, and the passage stays marked as the comment's.
  await select(page, 'The build is green.');
  await commentButton(page).click();
  await compose.getByRole('textbox').fill('Half a comment');
  await compose.getByRole('textbox').press('Escape');
  await expect(popover(page)).toHaveCount(0);
  await expect(pending).toHaveText('The build is green.');
  expect(store.made).toEqual([]);
  // A click on the marked passage opens the card again, with the words in it.
  await pending.click();
  await expect(compose.getByRole('textbox')).toHaveValue('Half a comment');
  // A click in the text elsewhere closes it again, and Cancel drops the comment for good.
  await editorOf(page).locator('h1').click();
  await expect(popover(page)).toHaveCount(0);
  await pending.click();
  await compose.getByRole('button', { name: 'Cancel' }).click();
  await expect(popover(page)).toHaveCount(0);
  await expect(pending).toHaveCount(0);
  expect(store.made).toEqual([]);
  expect(store.requests).toEqual([]);
});

test('a comment on text that was typed and not saved yet is made on the revision that save made', async ({ page }) => {
  const store = new Store();
  await open(page, store);
  // Typed, and the second's wait for the save not yet over: the save is made before the comment is started.
  await editorOf(page).getByText('Sign-off is on Monday.').click();
  await page.keyboard.press('End');
  await page.waitForTimeout(100);
  await page.keyboard.type(' Maybe.');
  await expect(state(page)).toHaveText('Unsaved changes · Revision 3');
  await select(page, 'Maybe.');
  await commentButton(page).click();
  await expect(popover(page).locator('.pd-compose')).toBeVisible();
  expect(store.puts).toEqual([{ markdown: PLAN.replace('Monday.', 'Monday. Maybe.'), base: 3 }]);
  await popover(page).locator('.pd-compose').getByRole('textbox').fill('Maybe?');
  await popover(page).locator('.pd-compose').getByRole('button', { name: 'Send' }).click();
  await expect.poll(() => store.made.length).toBe(1);
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
  await expect(popover(page)).toHaveCount(0);
  expect(store.made).toEqual([]);
});

test('a thread is answered with Send, resolved and opened again; resolving closes its card, and what was typed goes with it', async ({ page }) => {
  const store = new Store();
  const green = seeded(store, 'The build is green.', 'Is it?', 'agent');
  await open(page, store);
  const card = await openThread(page, green.id);
  const box = card.getByRole('textbox', { name: 'Reply' });
  const send = card.getByRole('button', { name: 'Send' });
  // Nothing typed is nothing to send.
  await expect(send).toBeDisabled();
  await box.press('Control+Enter');
  await expect(card.locator('li')).toHaveCount(1);
  // Typed, and not sent while it waits: it is the box's, not the thread's.
  await box.fill('Yes, it is.');
  await page.waitForTimeout(1000);
  expect(store.threads[0].comments).toHaveLength(1);
  await send.click();
  await expect.poll(() => store.threads[0].comments.length).toBe(2);
  await expect(card.locator('li')).toHaveCount(2);
  await expect(card.locator('li').nth(1)).toContainText('Yes, it is.');
  await expect(box).toHaveValue('');
  // Typed, and the thread resolved: what was typed is sent first, as the last word; the card closes, the text has the focus.
  await box.fill('And another.');
  await card.getByRole('button', { name: 'Resolve', exact: true }).click();
  await expect(popover(page)).toHaveCount(0);
  await expect(editorOf(page)).toBeFocused();
  expect(store.threads[0].status).toBe('resolved');
  expect(store.threads[0].comments.map((c) => c.body)).toEqual(['Is it?', 'Yes, it is.', 'And another.']);
  expect(store.requests).toEqual([]);
  // No longer marked in the text, and not counted; in the list, put away until asked for.
  await expect(editorOf(page).locator('.pd-thread')).toHaveCount(0);
  await expect(barButton(page)).toHaveAccessibleName('Comments');
  await showList(page);
  await expect(panel(page).getByRole('button', { name: 'Show resolved (1)' })).toBeVisible();
  await panel(page).getByRole('button', { name: 'Show resolved (1)' }).click();
  await expect(cards(page)).toHaveCount(1);
  await expect(cards(page).first()).toContainText('Resolved');
  await expect(cards(page).first().getByRole('textbox')).toHaveCount(0);
  await cards(page).first().getByRole('button', { name: 'Reopen' }).click();
  await expectMarked(page, green.id, 'The build is green.');
  await expect(panel(page).getByRole('button', { name: /resolved/i })).toHaveCount(0);
  // Resolved with nothing typed: just closed.
  await barButton(page).click();
  const again = await openThread(page, green.id);
  await expect(again.getByRole('textbox', { name: 'Reply' })).toHaveValue('');
  await again.getByRole('button', { name: 'Resolve', exact: true }).click();
  await expect(popover(page)).toHaveCount(0);
  expect(store.threads[0].comments).toHaveLength(3);
});

test('a comment is sent once: Send again while it is on its way sends nothing more, and its buttons wait for it', async ({ page }) => {
  const store = new Store();
  store.delay = 1500;
  await open(page, store);
  await select(page, 'The build is green.');
  await commentButton(page).click();
  const compose = popover(page).locator('.pd-compose');
  await compose.getByRole('textbox').fill('Hello');
  await compose.getByRole('button', { name: 'Send' }).click();
  await expect.poll(() => store.started).toBe(1);
  await expect(compose.getByRole('button', { name: 'Send' })).toBeDisabled();
  await expect(compose.getByRole('button', { name: 'Cancel' })).toBeDisabled();
  await compose.getByRole('textbox').press('Control+Enter');
  await expect.poll(() => store.threads.length, { timeout: 10_000 }).toBe(1);
  await expect(compose).toHaveCount(0);
  expect(store.started).toBe(1);
  expect(store.threads.map((t) => t.comments.map((c) => c.body))).toEqual([['Hello']]);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('a comment that could not be sent keeps what was typed and says why, and Send tries again', async ({ page }) => {
  const store = new Store();
  const green = seeded(store, 'The build is green.', 'Is it?');
  await open(page, store);
  const card = await openThread(page, green.id);
  store.refuse = { status: 500, error: 'The documents store could not do that' };
  await card.getByRole('textbox', { name: 'Reply' }).fill('A long answer I would not want to lose.');
  await card.getByRole('button', { name: 'Send' }).click();
  await expect(card.getByRole('alert')).toContainText('Could not comment: The documents store could not do that');
  await expect(card.getByRole('textbox', { name: 'Reply' })).toHaveValue('A long answer I would not want to lose.');
  await expect(card.locator('li')).toHaveCount(1);
  store.refuse = null;
  await card.getByRole('button', { name: 'Send' }).click();
  await expect.poll(() => store.threads[0].comments.length).toBe(2);
  await expect(card.getByRole('alert')).toHaveCount(0);
  await expect(card.getByRole('textbox', { name: 'Reply' })).toHaveValue('');
  // A new comment that was refused stays open, with the reason, and its words kept.
  await select(page, 'Sign-off is on Monday.');
  await commentButton(page).click();
  store.refuse = { status: 422, error: 'That passage is not in the document at revision 3' };
  const compose = popover(page).locator('.pd-compose');
  await compose.getByRole('textbox').fill('Who signs?');
  await compose.getByRole('button', { name: 'Send' }).click();
  await expect(compose).toContainText('That passage is not in the document at revision 3');
  await expect(compose.getByRole('textbox')).toHaveValue('Who signs?');
  await expect(editorOf(page).locator('.pd-thread-pending')).toHaveText('Sign-off is on Monday.');
  // Nothing was made, so Cancel has nothing to take away.
  await compose.getByRole('button', { name: 'Cancel' }).click();
  await expect(popover(page)).toHaveCount(0);
});

test('a comment the agent writes shows up when the stream says the comments changed, and the page asks again after a stream that dropped', async ({ page }) => {
  const store = new Store();
  await open(page, store);
  await showList(page);
  await expect(items(page)).toHaveCount(0);
  await expect(barButton(page)).toHaveAccessibleName('Comments');
  let asked = 0;
  await page.route(`**${DOCUMENT}/threads`, (route) => (route.request().method() === 'GET' ? (asked++, route.fallback()) : route.fallback()));
  const green = seeded(store, 'The build is green.', 'Is it?', 'agent');
  await told(page, 'threads', { at: '2026-10-02T10:00:00.000Z' });
  await expect(items(page)).toHaveCount(1);
  await expect(barButton(page)).toHaveAccessibleName('Comments 1');
  await expectMarked(page, green.id, 'The build is green.');
  const card = await openThread(page, green.id);
  await expect(card.locator('li[data-author="agent"]')).toContainText('Is it?');
  expect(asked).toBe(1);
  // The stream drops; a comment is written while it is down; the new stream opening is how the page finds out.
  await page.evaluate(() => (window as any).streams[0].emit('error', null));
  seeded(store, 'Sign-off is on Monday.', 'Who signs off?', 'agent');
  await expect(items(page)).toHaveCount(2, { timeout: 8000 });
  expect(await page.evaluate(() => (window as any).streams.length)).toBe(2);
});

test('a passage stays marked on its words while text is typed before it and in it, and goes where the server says it went when the document is changed from outside', async ({ page }) => {
  const store = new Store();
  const green = seeded(store, 'The build is green.', 'Is it?');
  await open(page, store);
  await showList(page);
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
  await expect(items(page).first()).toContainText('The build is really green.');
  await expectMarked(page, green.id, 'The build is really green.');
  // It answers the comment by rewriting the passage (the server puts the passage on what stands there now).
  store.elsewhere(store.markdown.replace('The build is really green.', 'Everything passes now.'));
  store.place(green.id, 'Everything passes now.');
  await told(page, 'revision', { revision: store.revision, author: 'agent', at: '2026-10-02T10:01:00.000Z' });
  await expect(editorOf(page)).toContainText('Everything passes now. More.');
  await expect.poll(() => marked(page, green.id)).toBe('Everything passes now.');
  await expect(items(page).first().locator('.pd-quote')).toHaveText('Everything passes now.');
});

test('a comment whose passage is no longer in the document is in the list, says so, and can still be answered there; one that cannot be marked in the text says that', async ({ page }) => {
  const text = '# Notes\n\n* a\n* b\n\nSign-off is on Monday.\n';
  const store = new Store();
  store.texts.set(3, text);
  const gone = seeded(store, 'Sign-off is on Monday.', 'Who signs off?');
  // Words the editor does not write as they are in the file (its bullet is another), too few to be found without their marks.
  const odd = seeded(store, '* a', 'Why this one?');
  store.elsewhere(text.replace('Sign-off is on Monday.\n', ''));
  await open(page, store, { ready: 'Notes' });
  // Marked nowhere: the list is the way to them, and it says how many are open.
  await expect(editorOf(page).locator('.pd-thread')).toHaveCount(0);
  await expect(barButton(page)).toHaveAccessibleName('Comments 2');
  await showList(page);
  await expect(cards(page)).toHaveCount(2);
  const first = cards(page).filter({ hasText: 'Who signs off?' });
  await expect(first).toContainText('The passage this comment was on is no longer in the document.');
  await expect(first.locator('.pd-quote')).toHaveText('Sign-off is on Monday.');
  await first.getByRole('textbox', { name: 'Reply' }).fill('Nobody now.');
  await first.getByRole('textbox', { name: 'Reply' }).press('Control+Enter');
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
  await expectMarked(page, thread.id, 'first itemsecond item');
  await expect(editorOf(page).locator('li')).toHaveCount(2);
  await openThread(page, thread.id);
});

test('at a phone\'s width the card of a comment fills the page under its passage with no sideways scrolling, the list is a panel over the page from the right edge, and the comment button is within reach', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  const store = new Store();
  const green = seeded(store, 'The build is green.', 'Is it? '.repeat(30), 'agent');
  await open(page, store);
  const noSideways = () => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
  expect(await noSideways()).toBe(true);
  await openThread(page, green.id);
  const sheet = (await page.locator('.pd-sheet').boundingBox())!;
  const box = (await popover(page).boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(sheet.x);
  expect(box.x + box.width).toBeLessThanOrEqual(sheet.x + sheet.width);
  expect(box.width).toBeGreaterThan(sheet.width - 40);
  expect(await clearOf(page, green.id)).toBe(true);
  expect(await noSideways()).toBe(true);
  expect(await page.evaluate(() => [...document.querySelectorAll('.pd-popover *')].every((e) => e.getBoundingClientRect().right <= window.innerWidth + 1))).toBe(true);
  // The list is a panel at the right edge, over the page, the page's whole height under the bars, and no wider than 320 px;
  // choosing a thread in it closes it, so that the card is not covered.
  await showList(page);
  const list = (await panel(page).boundingBox())!;
  const area = (await page.locator('.pd-desk').boundingBox())!;
  expect(Math.round(list.x + list.width)).toBe(Math.round(area.x + area.width));
  expect(list.width).toBeLessThanOrEqual(320);
  expect(list.width).toBeGreaterThan(200);
  expect(Math.round(list.y)).toBe(Math.round(area.y));
  expect(Math.round(list.y + list.height)).toBe(Math.round(area.y + area.height));
  expect(await noSideways()).toBe(true);
  await items(page).first().click();
  await expect(panel(page)).toHaveCount(0);
  await expect(shown(page)).toHaveAttribute('data-thread', green.id);
  await select(page, 'Sign-off is on Monday.');
  await expect(commentButton(page)).toBeEnabled();
  expect((await commentButton(page).boundingBox())!.x + (await commentButton(page).boundingBox())!.width).toBeLessThanOrEqual(390);
});

test('what the comments say is in German in a German portal', async ({ page }) => {
  const store = new Store();
  const green = seeded(store, 'The build is green.', 'Is it?', 'agent');
  const done = seeded(store, 'Sign-off is on Monday.', 'Who?');
  store.settle(done.id, 'resolved');
  await open(page, store, { language: 'de' });
  await expect(barButton(page)).toHaveAccessibleName('Kommentare 1');
  await showList(page);
  await expect(panel(page).getByRole('heading', { name: 'Kommentare' })).toBeVisible();
  await expect(items(page).first()).toContainText('Der Agent');
  await expect(panel(page).getByRole('button', { name: 'Erledigte anzeigen (1)' })).toBeVisible();
  await expect(panel(page).getByRole('button', { name: 'Schließen' })).toBeVisible();
  await barButton(page).click();
  const card = await openThread(page, green.id);
  await expect(card.getByRole('textbox', { name: 'Antworten' })).toBeVisible();
  await expect(card.getByRole('button', { name: 'Erledigen', exact: true })).toBeVisible();
  await expect(card.getByRole('textbox', { name: 'Antworten' })).toHaveAttribute('placeholder', 'Antworten… (@agent fragt den Agenten)');
  await expect(page.getByRole('button', { name: 'Kommentieren', exact: true })).toBeDisabled();
  await select(page, 'Ship it on');
  await page.getByRole('button', { name: 'Kommentieren', exact: true }).click();
  await expect(popover(page).locator('.pd-compose')).toContainText('Neuer Kommentar');
  await expect(popover(page).locator('.pd-compose').getByRole('textbox', { name: 'Kommentar schreiben' })).toBeVisible();
  await expect(popover(page).locator('.pd-compose').getByRole('button', { name: 'Abbrechen' })).toBeVisible();
  await popover(page).locator('.pd-compose').getByRole('textbox').fill('Gut?');
  await expect(popover(page).locator('.pd-compose').getByRole('button', { name: 'Senden' })).toBeEnabled();
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


/** The chat the page last remembered the person in, in this tab. */
const remembered = (page: Page) => page.evaluate(() => sessionStorage.getItem('pithagoras-docs/chat'));

/** A comment typed on `quote` and sent: the card of its thread, open on the sheet. */
async function compose(page: Page, quote: string, text: string) {
  await select(page, quote);
  await commentButton(page).click();
  const card = popover(page).locator('.pd-compose');
  await card.getByRole('textbox').fill(text);
  await card.getByRole('button', { name: 'Send' }).click();
  await expect(card).toHaveCount(0);
  const made = shown(page).filter({ hasText: text });
  await expect(made).toBeVisible();
  return made;
}

test('a comment with @agent asks the agent of the chat the person is in once it is sent: the thread says so, and says when the agent answered, until the person has seen it or reacts', async ({ page }) => {
  const store = new Store();
  await open(page, store, { chat: 'a' });
  // One that does not ask names no chat.
  const quiet = await compose(page, 'Sign-off is on Monday.', 'Who signs?');
  expect(store.made[0]).not.toHaveProperty('chat');
  await expect(quiet.locator('.pd-asked')).toHaveCount(0);
  // Typed with @agent and not finished: nobody is asked, however long it waits.
  await select(page, 'The build is green.');
  await commentButton(page).click();
  const box = popover(page).locator('.pd-compose').getByRole('textbox');
  await box.fill('Is it? @agent, please');
  await page.waitForTimeout(1500);
  expect(store.made).toHaveLength(1);
  // Sent: as it was written, with the chat the page knows the person is in.
  await box.fill('Is it? @agent, please check.');
  await popover(page).locator('.pd-compose').getByRole('button', { name: 'Send' }).click();
  await expect.poll(() => store.made.length).toBe(2);
  expect(store.made[1]).toMatchObject({ body: 'Is it? @agent, please check.', chat: 'a' });
  const card = shown(page).filter({ hasText: 'Is it?' });
  await expect(card.locator('.pd-asked')).toHaveText('Asked the agent · First chat');
  await expect(card.locator('.pd-asked')).toHaveAttribute('data-asked', 'waiting');
  // The server has the chat take it, and the agent answers; the page is told the comments changed.
  const thread = store.threads[1];
  thread.ping = { ...thread.ping!, sent: true, state: 'sent' };
  store.comment(thread.id, 'Yes, it is.', 'agent');
  await told(page, 'threads', { at: '2026-10-02T10:00:00.000Z' });
  const news = card.locator('.pd-asked');
  await expect(news).toHaveText(/^The agent answered/);
  await expect(news).toHaveAttribute('data-asked', 'answered');
  await expect(card.locator('li')).toHaveCount(2);
  // Saying it was read is the reaction.
  await news.getByRole('button', { name: 'Got it' }).click();
  await expect(news).toHaveCount(0);
  expect(thread.answered).toBe(false);
  // A reply that asks again is asked again, in the chat, once it is sent.
  await card.getByRole('textbox', { name: 'Reply' }).fill('Once more, @agent.');
  await page.waitForTimeout(1000);
  expect(thread.comments).toHaveLength(2);
  await card.getByRole('button', { name: 'Send' }).click();
  await expect.poll(() => thread.ping?.state).toBe('pending');
  expect(thread.ping?.chat).toBe('a');
  await expect(card.locator('.pd-asked')).toHaveText('Asked the agent · First chat');
  expect(store.requests).toEqual([]);
});

test('a comment that asks the agent when the person is in no chat of the folder opens one for it when it is sent, and is asked in that chat from then on', async ({ page }) => {
  const store = new Store();
  // The chat the person was last in is another folder's: nobody here can be asked in it.
  await open(page, store, { chat: 'elsewhere' });
  // While it is typed, no chat is opened for it.
  await select(page, 'The build is green.');
  await commentButton(page).click();
  await popover(page).locator('.pd-compose').getByRole('textbox').fill('Is it? @agent');
  await page.waitForTimeout(1500);
  expect(store.opened).toEqual([]);
  await popover(page).locator('.pd-compose').getByRole('button', { name: 'Send' }).click();
  await expect.poll(() => store.made.length).toBe(1);
  expect(store.opened).toEqual([{ title: 'Comments on The plan', workspace: '/w/site' }]);
  expect(store.made[0]).toMatchObject({ chat: 'n1' });
  expect(await remembered(page)).toBe('n1');
  await expect(shown(page).filter({ hasText: 'Is it?' }).locator('.pd-asked')).toHaveText('Asked the agent · Comments on The plan');
  // The same chat for the next one, and for a reply: no second chat is opened.
  const first = store.threads[0].id;
  await compose(page, 'Sign-off is on Monday.', 'Who signs? @agent');
  expect(store.made[1]).toMatchObject({ chat: 'n1' });
  const card = await openThread(page, first);
  await card.getByRole('textbox', { name: 'Reply' }).fill('And you? @agent');
  await card.getByRole('button', { name: 'Send' }).click();
  await expect.poll(() => store.threads[0].comments.length).toBe(2);
  expect(store.opened).toHaveLength(1);
});

test('a chat that cannot be opened is said, and the comment is kept and says it was not delivered', async ({ page }) => {
  const store = new Store();
  await open(page, store);
  await page.route('**/api/sessions', (route) => (route.request().method() === 'POST' ? route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'That folder is not one a chat may start in' }) }) : route.fallback()));
  const card = await compose(page, 'The build is green.', 'Is it? @agent');
  await expect.poll(() => store.made.length).toBe(1);
  await expect(page.getByRole('status').filter({ hasText: 'Could not open a chat to ask the agent in: That folder is not one a chat may start in' })).toBeVisible();
  expect(store.made[0].body).toBe('Is it? @agent');
  expect(store.made[0]).toMatchObject({ chat: null });
  await expect(card.locator('.pd-asked')).toHaveText('Not delivered to the agent · The chat to ask is not one that works in this folder');
  await page.getByRole('status').filter({ hasText: 'Could not open a chat' }).getByRole('button', { name: 'Dismiss' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Could not open a chat' })).toHaveCount(0);
});

test('a chat\'s own document is asked in its own chat, wherever the person is, and no chat is opened', async ({ page }) => {
  const store = new Store();
  store.ask = { chats: [{ id: 'own', title: 'The owner' }], own: true, workspace: '/w/site' };
  await open(page, store, { chat: 'a' });
  const card = await compose(page, 'The build is green.', 'Is it? @agent');
  await expect.poll(() => store.made.length).toBe(1);
  expect(store.made[0]).toMatchObject({ chat: 'own' });
  expect(store.opened).toEqual([]);
  await expect(card.locator('.pd-asked')).toHaveText('Asked the agent · The owner');
});

test('the chat that was on screen last is the one the person is in when the page is opened from it', async ({ page }) => {
  const store = new Store();
  await open(page, store, { first: '/s/a' });
  expect(await remembered(page)).toBe('a');
  await compose(page, 'The build is green.', 'Is it? @agent');
  await expect.poll(() => store.made.length).toBe(1);
  expect(store.made[0]).toMatchObject({ chat: 'a' });
  expect(store.opened).toEqual([]);
});

test('a comment whose chat is gone from the thread says it was not delivered; one the agent resolved is news in the list until the person has seen it', async ({ page }) => {
  const store = new Store();
  const lost = seeded(store, 'The build is green.', 'Is it? @agent');
  Object.assign(lost, { toAgent: true, ping: { id: 9, chat: null, comment: lost.comments[0].id, sent: false, title: null, state: 'failed', error: 'No chat that can read this document works in its folder any more' } });
  const resolved = seeded(store, 'Sign-off is on Monday.', 'Who signs? @agent');
  Object.assign(resolved, { status: 'resolved', answered: true });
  resolved.comments.push({ id: 'c99', author: 'agent', body: 'The owner does.', at: '2026-10-02T10:00:00.000Z' });
  const quiet = seeded(store, 'Ship it on', 'Fine.');
  Object.assign(quiet, { status: 'resolved' });
  await open(page, store);
  const card = await openThread(page, lost.id);
  await expect(card.locator('.pd-asked')).toHaveText('Not delivered to the agent · No chat that can read this document works in its folder any more');
  // The agent resolved it: it is in the list, resolved and answered, and the one that is only resolved is put away.
  await showList(page);
  const news = cards(page).filter({ hasText: 'Who signs?' });
  await expect(news).toBeVisible();
  await expect(news).toContainText('Resolved');
  await expect(news.locator('.pd-asked')).toHaveText(/^The agent answered/);
  await expect(news).toContainText('The owner does.');
  await expect(cards(page).filter({ hasText: 'Fine.' })).toHaveCount(0);
  await expect(panel(page).getByRole('button', { name: 'Show resolved (1)' })).toBeVisible();
  // Seen: it is put away with the other.
  await news.getByRole('button', { name: 'Got it' }).click();
  await expect(cards(page).filter({ hasText: 'Who signs?' })).toHaveCount(0);
  await expect(panel(page).getByRole('button', { name: 'Show resolved (2)' })).toBeVisible();
  expect(resolved.answered).toBe(false);
});

test('a reply being typed when the agent answers stays in the box, and is sent after the answer', async ({ page }) => {
  const store = new Store();
  const green = seeded(store, 'The build is green.', 'Is it?');
  await open(page, store);
  const card = await openThread(page, green.id);
  const box = card.getByRole('textbox', { name: 'Reply' });
  await box.fill('Please check.');
  // The agent answers and the page is told: the answer is in the open card, and what is being typed is still the person's.
  store.comment(store.threads[0].id, 'Checked.', 'agent');
  await told(page, 'threads', { at: '2026-10-02T10:00:00.000Z' });
  await expect(card.locator('li')).toHaveCount(2);
  await expect(box).toHaveValue('Please check.');
  await expect(box).toBeFocused();
  await card.getByRole('button', { name: 'Send' }).click();
  await expect.poll(() => store.threads[0].comments.length).toBe(3);
  expect(store.threads[0].comments.map((c) => [c.author, c.body])).toEqual([['user', 'Is it?'], ['agent', 'Checked.'], ['user', 'Please check.']]);
  expect(store.requests).toEqual([]);
  await expect(card.getByRole('alert')).toHaveCount(0);
});

test('what asking the agent says is in German in a German portal, and the chat opened for the folder is named in it', async ({ page }) => {
  const store = new Store();
  const green = seeded(store, 'The build is green.', 'Is it? @agent');
  Object.assign(green, { toAgent: true, ping: { id: 1, chat: 'a', comment: green.comments[0].id, sent: true, title: 'First chat', state: 'sent' } });
  const friday = seeded(store, '**Friday**', 'Why Friday?');
  Object.assign(friday, { answered: true });
  const monday = seeded(store, 'Sign-off is on Monday.', 'Who? @agent');
  Object.assign(monday, { toAgent: true, ping: { id: 2, chat: 'a', comment: monday.comments[0].id, sent: false, title: 'First chat', state: 'failed' } });
  await open(page, store, { language: 'de' });
  await showList(page);
  await expect(panel(page)).toContainText('Schreibe @agent in einen Kommentar, damit der Agent ihn beantwortet.');
  await barButton(page).click();
  await expect((await openThread(page, green.id)).locator('.pd-asked')).toHaveText('Den Agenten gefragt · First chat');
  const answered = await openThread(page, friday.id);
  await expect(answered.locator('.pd-asked')).toHaveText(/^Der Agent hat geantwortet/);
  await expect(answered.getByRole('button', { name: 'Verstanden' })).toBeVisible();
  await expect((await openThread(page, monday.id)).locator('.pd-asked')).toHaveText('Nicht beim Agenten angekommen');
  await select(page, 'Ship it on');
  await page.getByRole('button', { name: 'Kommentieren', exact: true }).click();
  await popover(page).locator('.pd-compose').getByRole('textbox').fill('@agent?');
  await popover(page).locator('.pd-compose').getByRole('button', { name: 'Senden' }).click();
  await expect.poll(() => store.opened.length).toBe(1);
  expect(store.opened[0].title).toBe('Kommentare zu The plan');
});

test('the list of documents says how many comments the agent answered, and none when it answered nothing', async ({ page }) => {
  const store = new Store();
  const first = seeded(store, 'The build is green.', 'Is it? @agent');
  const second = seeded(store, 'Sign-off is on Monday.', 'Who?');
  await open(page, store);
  await page.getByRole('button', { name: /All documents/ }).click();
  await expect(page.getByRole('region', { name: 'site' }).getByRole('listitem')).toHaveText([/plan\.md · Changed .* · 2 open comments$/]);
  store.comment(first.id, 'Yes.', 'agent');
  Object.assign(second, { status: 'resolved', answered: true });
  await page.goto(`/x/${NAME}/documents`);
  await expect(page.getByRole('region', { name: 'site' }).getByRole('listitem')).toHaveText([/plan\.md · Changed .* · 1 open comment · 2 answered by the agent$/]);
});

const dialog = (page: Page) => page.getByRole('alertdialog');

test('a comment of the person is changed with Edit: the box is kept as it is until Save, Cancel and Escape leave it, and the comment says it was edited', async ({ page }) => {
  const store = new Store();
  const thread = seeded(store, 'The build is green.', 'Is it?');
  store.comment(thread.id, 'Yes.', 'agent');
  store.comment(thread.id, 'Sure?');
  await open(page, store);
  const card = await openThread(page, thread.id);
  const items = card.locator('li');
  await expect(items).toHaveCount(3);
  // Only the person's own comments are theirs to change: not the agent's.
  await expect(items.nth(0).getByRole('button', { name: 'Edit' })).toBeVisible();
  await expect(items.nth(1).getByRole('button', { name: 'Edit' })).toHaveCount(0);
  await expect(items.nth(1).getByRole('button', { name: 'Delete' })).toHaveCount(0);
  await expect(items.nth(0).getByText('edited', { exact: true })).toHaveCount(0);
  // Cancel and Escape leave it as it was, and send nothing.
  await items.nth(0).getByRole('button', { name: 'Edit' }).click();
  const box = card.getByRole('textbox', { name: 'Edit the comment' });
  await expect(box).toHaveValue('Is it?');
  await expect(box).toBeFocused();
  await box.fill('Is it really?');
  await card.getByRole('button', { name: 'Cancel' }).click();
  await expect(items.nth(0)).toContainText('Is it?');
  await expect(box).toHaveCount(0);
  await items.nth(0).getByRole('button', { name: 'Edit' }).click();
  await expect(box).toHaveValue('Is it?', 'a new box starts from the comment, not from what was given up');
  await box.fill('Is it really?');
  await box.press('Escape');
  await expect(box).toHaveCount(0);
  expect(store.requests).toEqual([]);
  // Saving needs words that are new.
  await items.nth(0).getByRole('button', { name: 'Edit' }).click();
  const save = card.getByRole('button', { name: 'Save', exact: true });
  await expect(save).toBeDisabled();
  await box.fill('   ');
  await expect(save).toBeDisabled();
  await box.fill('Is it right?');
  await expect(save).toBeEnabled();
  await save.click();
  await expect(box).toHaveCount(0);
  await expect(items.nth(0)).toContainText('Is it right?');
  await expect(items.nth(0).getByText('edited', { exact: true })).toBeVisible();
  await expect(items).toHaveCount(3);
  // A comment that is in the list is changed with no draft: whatever its place, and it names no chat when it asks nobody.
  expect(store.requests).toEqual([{ method: 'PUT', comment: thread.comments[0].id, body: { body: 'Is it right?' } }]);
  expect(store.threads[0].comments[0].edited).toBeTruthy();
  // Ctrl+Enter saves too.
  await items.nth(2).getByRole('button', { name: 'Edit' }).click();
  await box.fill('Sure about that?');
  await box.press('Control+Enter');
  await expect(items.nth(2)).toContainText('Sure about that?');
  expect(store.threads[0].comments.map((c) => c.body)).toEqual(['Is it right?', 'Yes.', 'Sure about that?']);
});

test('a change that cannot be saved says why and stays in the box, to be saved again', async ({ page }) => {
  const store = new Store();
  const thread = seeded(store, 'The build is green.', 'Is it?');
  await open(page, store);
  const card = await openThread(page, thread.id);
  await card.getByRole('button', { name: 'Edit' }).click();
  const box = card.getByRole('textbox', { name: 'Edit the comment' });
  await box.fill('Is it right?');
  store.refuse = { status: 409, error: 'The thread is resolved elsewhere' };
  await card.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(card.getByRole('alert')).toContainText('Could not comment: The thread is resolved elsewhere');
  await expect(box).toHaveValue('Is it right?');
  store.refuse = null;
  await card.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(box).toHaveCount(0);
  await expect(card.locator('li').first()).toContainText('Is it right?');
});

test('a comment is deleted after a question, and the thread stays; the only comment of a thread is deleted with the thread, by its own button', async ({ page }) => {
  const store = new Store();
  const thread = seeded(store, 'The build is green.', 'Is it?');
  const first = thread.comments[0].id;
  store.comment(thread.id, 'Sure?');
  await open(page, store);
  const card = await openThread(page, thread.id);
  const items = card.locator('li');
  await expectMarked(page, thread.id, 'The build is green.');
  await expect(items).toHaveCount(2);
  // Asked first; Cancel leaves everything.
  await items.nth(0).getByRole('button', { name: 'Delete' }).click();
  await expect(dialog(page)).toContainText('Delete this comment?');
  await dialog(page).getByRole('button', { name: 'Cancel' }).click();
  await expect(items).toHaveCount(2);
  expect(store.requests).toEqual([]);
  await items.nth(0).getByRole('button', { name: 'Delete' }).click();
  await dialog(page).getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(items).toHaveCount(1);
  await expect(items.first()).toContainText('Sure?');
  expect(store.requests).toEqual([{ method: 'DELETE', comment: first }]);
  expect(store.threads[0].comments.map((c) => c.body)).toEqual(['Sure?']);
  await expectMarked(page, thread.id, 'The build is green.');
  // The one comment left is the thread: it has no Delete of its own, the thread has.
  await expect(items.first().getByRole('button', { name: 'Delete' })).toHaveCount(0);
  await card.getByRole('button', { name: 'Delete thread' }).click();
  await expect(dialog(page)).toContainText('Delete this thread?');
  await dialog(page).getByRole('button', { name: 'Cancel' }).click();
  await expect(popover(page)).toHaveCount(1);
  await card.getByRole('button', { name: 'Delete thread' }).click();
  await dialog(page).getByRole('button', { name: 'Delete thread' }).click();
  await expect(popover(page)).toHaveCount(0);
  expect(store.threads).toEqual([]);
  expect(store.requests.at(-1)).toEqual({ method: 'DELETE-THREAD', comment: thread.id });
  // Its mark in the text goes with it.
  await expect(editorOf(page).locator('.pd-thread')).toHaveCount(0);
  await showList(page);
  await expect(panel(page)).toContainText('No comments yet.');
});

test('a thread is deleted as a whole only while it is the person\'s and the agent has not commented in it, and the buttons follow what the agent does', async ({ page }) => {
  const store = new Store();
  const mine = seeded(store, 'The build is green.', 'Is it?');
  store.comment(mine.id, 'More.');
  const answered = seeded(store, 'Sign-off is on Monday.', 'Who signs off?');
  store.comment(answered.id, 'The release manager.', 'agent');
  const theirs = seeded(store, 'Ship it on', 'Why Friday?', 'agent');
  const closed = seeded(store, 'The plan', 'Old.');
  store.settle(closed.id, 'resolved');
  await open(page, store);
  const card = await openThread(page, mine.id);
  await expect(card.getByRole('button', { name: 'Delete thread' })).toBeVisible();
  const answeredCard = await openThread(page, answered.id);
  await expect(answeredCard.getByRole('button', { name: 'Resolve' })).toBeVisible();
  await expect(answeredCard.getByRole('button', { name: 'Delete thread' })).toHaveCount(0);
  // The person's comment in a thread of the answered kind can still go by itself.
  await expect(answeredCard.locator('li').first().getByRole('button', { name: 'Delete' })).toBeVisible();
  const theirCard = await openThread(page, theirs.id);
  await expect(theirCard.getByRole('button', { name: 'Resolve' })).toBeVisible();
  await expect(theirCard.getByRole('button', { name: 'Delete thread' })).toHaveCount(0);
  // A resolved thread of the person's is theirs to delete too, beside Reopen: it is a card of the list.
  await showList(page);
  await panel(page).getByRole('button', { name: 'Show resolved (1)' }).click();
  const old = cards(page).filter({ hasText: 'Old.' });
  await expect(old.getByRole('button', { name: 'Reopen' })).toBeVisible();
  await expect(old.getByRole('button', { name: 'Delete thread' })).toBeVisible();
  // The agent comments in the person's thread: the button goes, when the page is told.
  await openThread(page, mine.id);
  await expect(shown(page).locator('li')).toHaveCount(2);
  store.comment(mine.id, 'Yes.', 'agent');
  await told(page, 'threads', { at: '2026-10-02T10:00:00.000Z' });
  await expect(shown(page).locator('li')).toHaveCount(3);
  await expect(shown(page).getByRole('button', { name: 'Resolve' })).toBeVisible();
  await expect(shown(page).getByRole('button', { name: 'Delete thread' })).toHaveCount(0);
  // A thread that is deleted elsewhere is gone from here when the page is told, with its mark in the text and its card.
  await openThread(page, answered.id);
  store.threads = store.threads.filter((t) => t.id !== answered.id);
  await told(page, 'threads', { at: '2026-10-02T10:01:00.000Z' });
  await expect(popover(page)).toHaveCount(0);
  await expect(editorOf(page).locator(`[data-pd-thread="${answered.id}"]`)).toHaveCount(0);
  await expect(items(page).filter({ hasText: 'Who signs off?' })).toHaveCount(0);
  // The resolved one is deleted from here.
  await old.getByRole('button', { name: 'Delete thread' }).click();
  await dialog(page).getByRole('button', { name: 'Delete thread' }).click();
  await expect(old).toHaveCount(0);
  expect(store.threads.map((t) => t.id)).toEqual([mine.id, theirs.id]);
});

test('a thread deleted while a comment was being typed in it takes the box with it, sends nothing of it, and says nothing is wrong', async ({ page }) => {
  const store = new Store();
  const thread = seeded(store, 'The build is green.', 'Is it?');
  await open(page, store);
  const card = await openThread(page, thread.id);
  await card.getByRole('textbox', { name: 'Reply' }).fill('Typed on.');
  await card.getByRole('button', { name: 'Delete thread' }).click();
  await dialog(page).getByRole('button', { name: 'Delete thread' }).click();
  await expect(popover(page)).toHaveCount(0);
  expect(store.threads).toEqual([]);
  expect(store.requests.map((r) => r.method)).toEqual(['DELETE-THREAD']);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('changing the last comment of an open thread asks the agent as a new one would; one that is not the last asks nobody, and opens no chat', async ({ page }) => {
  const store = new Store();
  const last = seeded(store, 'The build is green.', 'Is it?');
  const older = seeded(store, 'Sign-off is on Monday.', 'Who signs off?');
  store.comment(older.id, 'The release manager.', 'agent');
  await open(page, store, { chat: 'a' });
  const edit = async (id: string, text: string) => {
    const card = await openThread(page, id);
    await card.locator('li').first().getByRole('button', { name: 'Edit' }).click();
    await card.getByRole('textbox', { name: 'Edit the comment' }).fill(text);
    await card.getByRole('button', { name: 'Save', exact: true }).click();
    return card;
  };
  const card = await edit(last.id, 'Is it? @agent, please check.');
  await expect(card.locator('.pd-asked')).toHaveText('Asked the agent · First chat');
  expect(store.requests.at(-1)).toMatchObject({ method: 'PUT', comment: last.comments[0].id, body: { body: 'Is it? @agent, please check.', chat: 'a' } });
  expect(store.threads[0].ping?.chat).toBe('a');
  // The agent has answered the other: the mention changes nothing there.
  const answered = await edit(older.id, 'Who signs off? @agent');
  await expect(answered.locator('li').first()).toContainText('@agent');
  expect(store.requests.at(-1)!.body).not.toHaveProperty('chat');
  expect(store.threads[1].toAgent).toBeFalsy();
  await expect(answered.locator('.pd-asked')).toHaveText(/^The agent answered/);
  expect(store.opened).toEqual([]);
});

test('what changing and deleting comments says is in German in a German portal', async ({ page }) => {
  const store = new Store();
  const thread = seeded(store, 'The build is green.', 'Is it?');
  store.comment(thread.id, 'Sure?');
  store.threads[0].comments[0].edited = '2026-10-02T09:30:00.000Z';
  await open(page, store, { language: 'de' });
  const card = await openThread(page, thread.id);
  const first = card.locator('li').first();
  await expect(first.getByText('bearbeitet', { exact: true })).toBeVisible();
  await expect(first.getByText('bearbeitet', { exact: true })).toHaveAttribute('title', /^Bearbeitet /);
  await expect(card.getByRole('button', { name: 'Kommentarthread löschen' })).toBeVisible();
  await first.getByRole('button', { name: 'Bearbeiten' }).click();
  await expect(card.getByRole('textbox', { name: 'Kommentar bearbeiten' })).toBeVisible();
  await expect(card.getByRole('button', { name: 'Speichern', exact: true })).toBeDisabled();
  await card.getByRole('button', { name: 'Abbrechen' }).click();
  await first.getByRole('button', { name: 'Löschen' }).click();
  await expect(dialog(page)).toContainText('Diesen Kommentar löschen?');
  await expect(dialog(page)).toContainText('Der Kommentar wird endgültig gelöscht.');
  await dialog(page).getByRole('button', { name: 'Abbrechen' }).click();
  await card.getByRole('button', { name: 'Kommentarthread löschen' }).click();
  await expect(dialog(page)).toContainText('Diesen Kommentarthread löschen?');
  await expect(dialog(page)).toContainText('Der Kommentarthread und alle seine Kommentare werden endgültig gelöscht.');
});

test('changing the last comment whose ask a chat has taken looks for no chat and opens none, even when the person is in no chat of the folder', async ({ page }) => {
  const store = new Store();
  const thread = seeded(store, 'The build is green.', 'Is it? @agent');
  // The agent of a chat was woken with it, and has not answered.
  thread.ping = { ...thread.ping!, sent: true, state: 'sent' };
  await open(page, store, { chat: 'elsewhere' });
  const card = await openThread(page, thread.id);
  await card.getByRole('button', { name: 'Edit' }).click();
  await card.getByRole('textbox', { name: 'Edit the comment' }).fill('Is it? @agent, typo fixed');
  await card.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(card.locator('li').first()).toContainText('typo fixed');
  expect(store.opened).toEqual([]);
  expect(store.requests.at(-1)!.body).not.toHaveProperty('chat');
});

test('Ctrl+Enter in the Edit box with the words unchanged just closes it: nothing is sent', async ({ page }) => {
  const store = new Store();
  const thread = seeded(store, 'The build is green.', 'Is it? @agent', 'user');
  await open(page, store, { chat: 'a' });
  const card = await openThread(page, thread.id);
  await card.getByRole('button', { name: 'Edit' }).click();
  const box = card.getByRole('textbox', { name: 'Edit the comment' });
  await box.press('Control+Enter');
  await expect(box).toHaveCount(0);
  await expect(card.locator('li').first()).toContainText('Is it? @agent');
  // The same words with spaces around them are the same words.
  await card.getByRole('button', { name: 'Edit' }).click();
  await box.fill('  Is it? @agent  ');
  await box.press('Control+Enter');
  await expect(box).toHaveCount(0);
  expect(store.requests).toEqual([]);
});

test('where there is no room beside a passage the card is under it, above it where there is no room under it, inside the page, and follows the passage as the text moves and the page scrolls', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 800 });
  const filler = Array.from({ length: 14 }, (_, i) => `Paragraph ${i + 1} of what is between.`).join('\n\n');
  const edge = `${'word '.repeat(15)}right edge words`;
  const store = new Store();
  store.texts.set(3, `# The plan\n\nThe first point.\n\n${edge}\n\n${filler}\n\nThe last point.\n`);
  const first = seeded(store, 'The first point.', 'One.');
  const right = seeded(store, 'right edge words', 'Edge.');
  const last = seeded(store, 'The last point.', 'Three.');
  await open(page, store, { ready: 'The last point.' });
  await expectMarked(page, last.id, 'The last point.');
  const gap = async (id: string) => (await popover(page).boundingBox())!.y - Math.max(...(await rectsOf(page, id)).map((r) => r.bottom));
  const sheet = (await page.locator('.pd-sheet').boundingBox())!;
  // Under its passage, where there is room.
  await openThread(page, first.id);
  expect(await gap(first.id)).toBeGreaterThan(0);
  expect(await gap(first.id)).toBeLessThan(20);
  // A passage at the right of the sheet: the card is kept inside it.
  await openThread(page, right.id);
  const box = (await popover(page).boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(sheet.x);
  expect(box.x + box.width).toBeLessThanOrEqual(sheet.x + sheet.width);
  expect(await clearOf(page, right.id)).toBe(true);
  // Text typed above moves the passage, and the card goes with it.
  await openThread(page, first.id);
  const before = (await popover(page).boundingBox())!.y;
  const spread = await gap(first.id);
  await closeCard(page);
  await editorOf(page).getByText('Paragraph 1 of').click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('A new paragraph.');
  await page.keyboard.press('Enter');
  await page.keyboard.type('And another.');
  await openThread(page, last.id);
  // (The passage far down is at the bottom of the page: where the page is scrolled to, the card is above it if there is no room under it.)
  await page.evaluate((id) => document.querySelector(`.pd-editor [data-pd-thread="${id}"]`)!.scrollIntoView({ block: 'end' }), last.id);
  await expect.poll(async () => (await popover(page).boundingBox())!.y + (await popover(page).boundingBox())!.height <= (await rectsOf(page, last.id))[0].top + 1).toBe(true);
  expect(await clearOf(page, last.id)).toBe(true);
  await expect(popover(page)).toHaveAttribute('data-above', 'true');
  // It follows the passage as the page is scrolled: moved with it, at the same distance.
  const apart = async () => (await rectsOf(page, last.id))[0].top - ((await popover(page).boundingBox())!.y + (await popover(page).boundingBox())!.height);
  const was = await apart();
  const scrolledBy = await page.evaluate(() => { const s = document.querySelector('.pd-scroll')!; const before = s.scrollTop; s.scrollTop = before - 30; return before - s.scrollTop; });
  expect(scrolledBy).toBeGreaterThan(0);
  await expect.poll(async () => Math.abs((await apart()) - was)).toBeLessThan(2);
  // Back at the first: it moved down with the text typed above it.
  await page.evaluate(() => document.querySelector('.pd-scroll')!.scrollTo(0, 0));
  await openThread(page, first.id);
  expect((await popover(page).boundingBox())!.y).toBeGreaterThan(before - 5);
  expect(spread).toBeGreaterThan(0);
  expect(await gap(first.id)).toBeLessThan(20);
});

test('a comment typed and not sent survives the card being closed and opened, the list being shown and hidden, and the width of the page changing, and the page still asks before it is left', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 1000 });
  const store = new Store();
  const green = seeded(store, 'The build is green.', 'Is it?');
  await open(page, store);
  const asks = () => page.evaluate(() => { const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; });
  expect(await asks()).toBe(false);
  // A reply typed in the card is kept when the card is closed with Escape (the text has the focus) and opened again.
  const card = await openThread(page, green.id);
  await card.getByRole('textbox', { name: 'Reply' }).fill('Half a reply');
  expect(await asks()).toBe(true);
  await card.getByRole('textbox', { name: 'Reply' }).press('Escape');
  await expect(popover(page)).toHaveCount(0);
  await expect(editorOf(page)).toBeFocused();
  expect(await asks()).toBe(true);
  await expect((await openThread(page, green.id)).getByRole('textbox', { name: 'Reply' })).toHaveValue('Half a reply');
  // Closed with a click outside, and opened from the list, which is shown and hidden meanwhile.
  await page.locator('.pd-titlebar').click({ position: { x: 300, y: 4 } });
  await expect(popover(page)).toHaveCount(0);
  await showList(page);
  await barButton(page).click();
  await showList(page);
  await items(page).first().click();
  await expect(shown(page).getByRole('textbox', { name: 'Reply' })).toHaveValue('Half a reply');
  // (The bar's button is outside the card: it closes it. The card is opened again for what follows.)
  await barButton(page).click();
  await expect(panel(page)).toHaveCount(0);
  await expect((await openThread(page, green.id)).getByRole('textbox', { name: 'Reply' })).toHaveValue('Half a reply');
  // The page narrowed to a phone's width and widened again: the card is drawn as it needs to be, with the words in it.
  await page.setViewportSize({ width: 700, height: 1000 });
  await expect(page.locator('.pd-doc')).toHaveAttribute('data-layout', 'narrow');
  await expect(shown(page).getByRole('textbox', { name: 'Reply' })).toHaveValue('Half a reply');
  await page.setViewportSize({ width: 1400, height: 1000 });
  await expect(page.locator('.pd-doc')).toHaveAttribute('data-layout', 'wide');
  await expect(shown(page).getByRole('textbox', { name: 'Reply' })).toHaveValue('Half a reply');
  // A comment being written on a passage is kept when its card is closed, and the page asks for it as well.
  await select(page, 'Sign-off is on Monday.');
  await commentButton(page).click();
  await popover(page).locator('.pd-compose').getByRole('textbox').fill('Unsent words');
  await popover(page).locator('.pd-compose').getByRole('textbox').press('Escape');
  await expect(popover(page)).toHaveCount(0);
  expect(await asks()).toBe(true);
  await closeCard(page);
  await editorOf(page).locator('.pd-thread-pending').click();
  await expect(popover(page).locator('.pd-compose').getByRole('textbox')).toHaveValue('Unsent words');
  // Sent, the reply is gone from the drafts: the box is empty for the next one.
  await mark(page, green.id).click();
  await shown(page).getByRole('textbox', { name: 'Reply' }).press('Control+Enter');
  await expect(shown(page).locator('li')).toHaveCount(2);
  await expect(shown(page).getByRole('textbox', { name: 'Reply' })).toHaveValue('');
  // The comment on the passage is given up: nothing is left to warn of.
  await closeCard(page);
  await editorOf(page).locator('.pd-thread-pending').click();
  await popover(page).locator('.pd-compose').getByRole('button', { name: 'Cancel' }).click();
  await expect(popover(page)).toHaveCount(0);
  expect(await asks()).toBe(false);
});

test('every thread is reached with the keyboard: Ctrl+Alt+M at a commented passage opens its card with the focus in its box, a line of the list does the same, Tab goes from the text to the card, and the threads without a passage are in the list', async ({ page }) => {
  const text = '# Notes\n\nA line.\n\nAn other line.\n\nSign-off is on Monday.\n';
  const store = new Store();
  store.texts.set(3, text);
  const gone = seeded(store, 'Sign-off is on Monday.', 'Who signs off?');
  const line = seeded(store, 'An other line.', 'Which line?', 'agent');
  store.elsewhere(text.replace('Sign-off is on Monday.\n', ''));
  await open(page, store, { ready: 'Notes' });
  await expectMarked(page, line.id, 'An other line.');
  // The caret in the passage, and Ctrl+Alt+M: the card is open and the box has the focus. Typing there is the box's.
  await editorOf(page).getByText('A line.').click();
  await page.keyboard.press('ArrowDown');
  await expect.poll(() => page.evaluate(() => Boolean(window.getSelection()?.anchorNode?.parentElement?.closest('[data-pd-thread]')))).toBe(true);
  await page.keyboard.press('Control+Alt+m');
  await expect(shown(page)).toHaveAttribute('data-thread', line.id);
  await expect(shown(page).getByRole('textbox', { name: 'Reply' })).toBeFocused();
  await page.keyboard.type('two words');
  await expect(shown(page).getByRole('textbox', { name: 'Reply' })).toHaveValue('two words');
  // Escape: closed, the text has the focus; the words are kept, and are there when the card is opened again.
  await page.keyboard.press('Escape');
  await expect(popover(page)).toHaveCount(0);
  await expect(editorOf(page)).toBeFocused();
  await mark(page, line.id).click();
  await expect(shown(page).getByRole('textbox', { name: 'Reply' })).toHaveValue('two words');
  // With the caret in no commented passage the shortcut does nothing.
  await page.keyboard.press('Escape');
  await editorOf(page).getByText('A line.').click();
  await page.keyboard.press('Control+Alt+m');
  await expect(popover(page)).toHaveCount(0);
  // Tab from the text goes to the card, which is next in the order of the page.
  await mark(page, line.id).click();
  await expect(shown(page)).toHaveAttribute('data-thread', line.id);
  await page.keyboard.press('Tab');
  await expect(shown(page).locator(':focus')).toHaveCount(1);
  // The thread whose passage is gone has no mark to reach: it is a card of the list, with its box and buttons, in the tab order.
  await expect(editorOf(page).locator(`[data-pd-thread="${gone.id}"]`)).toHaveCount(0);
  await barButton(page).focus();
  await page.keyboard.press('Enter');
  await expect(panel(page)).toBeVisible();
  const orphan = cards(page).filter({ hasText: 'Who signs off?' });
  await expect(orphan).toContainText('The passage this comment was on is no longer in the document.');
  await orphan.getByRole('textbox', { name: 'Reply' }).focus();
  await expect(orphan.getByRole('textbox', { name: 'Reply' })).toBeFocused();
  await orphan.getByRole('textbox', { name: 'Reply' }).pressSequentially('Nobody now.');
  await page.keyboard.press('Control+Enter');
  await expect(orphan.locator('li')).toHaveCount(2);
  await expect(orphan.getByRole('button', { name: 'Resolve' })).toBeVisible();
  // A line of the list for a thread with a passage: Enter opens its card, with the focus in the box.
  await expect(items(page)).toHaveCount(1);
  await items(page).first().focus();
  await page.keyboard.press('Enter');
  await expect(shown(page)).toHaveAttribute('data-thread', line.id);
  await expect(shown(page).getByRole('textbox', { name: 'Reply' })).toBeFocused();
  await expect(shown(page).getByRole('textbox', { name: 'Reply' })).toHaveValue('two words');
});

test('the card of an open thread is updated when the agent comments, and keeps what was typed; the text of a thread shown in it is not cut', async ({ page }) => {
  const store = new Store();
  const green = seeded(store, 'The build is green.', 'Is it?');
  await open(page, store);
  const card = await openThread(page, green.id);
  await card.getByRole('textbox', { name: 'Reply' }).fill('typing…');
  store.comment(green.id, 'A long answer. '.repeat(40), 'agent');
  await told(page, 'threads', { at: '2026-10-02T10:00:00.000Z' });
  await expect(card.locator('li')).toHaveCount(2);
  await expect(card.getByRole('textbox', { name: 'Reply' })).toHaveValue('typing…');
  // Still beside its passage: the card grew, and is placed again.
  expect(await clearOf(page, green.id)).toBe(true);
  const sheet = (await page.locator('.pd-sheet').boundingBox())!;
  const box = (await popover(page).boundingBox())!;
  expect(box.x + box.width).toBeLessThanOrEqual(sheet.x + sheet.width);
});

test('the page is the whole area under the toolbar: no box, no frame, no band under it, and a click anywhere under the text puts the caret at its end', async ({ page }) => {
  await page.setViewportSize({ width: 1300, height: 1200 });
  const store = new Store();
  seeded(store, 'The build is green.', 'Is it?');
  await open(page, store);
  // Not a list under the text, and no margin.
  await expect(page.locator('.pd-threads, .pd-margin, .pd-thread-card')).toHaveCount(0);
  const m = await page.evaluate(() => {
    const at = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
    const sheet = getComputedStyle(document.querySelector('.pd-sheet')!);
    const editor = getComputedStyle(document.querySelector('.pd-editor')!);
    return {
      doc: at('.pd-doc'), scroll: at('.pd-scroll'), sheet: at('.pd-sheet'), scroller: at('.extension-page'), toolbar: at('.pd-toolbar'),
      frame: [sheet.borderTopWidth, sheet.borderLeftWidth, sheet.boxShadow, sheet.backgroundColor, editor.borderTopWidth],
      overflows: (() => { const s = document.querySelector('.extension-page')!; return s.scrollHeight > s.clientHeight + 1; })(),
    };
  });
  // The page goes from the toolbar to the end of the area, and is the text's ground the whole way, with no frame of its own.
  expect(Math.round(m.scroll.top)).toBe(Math.round(m.toolbar.bottom));
  expect(Math.round(m.scroll.bottom)).toBe(Math.round(m.scroller.bottom));
  expect(Math.round(m.sheet.bottom)).toBe(Math.round(m.scroll.bottom));
  expect(m.overflows).toBe(false);
  expect(m.frame).toEqual(['0px', '0px', 'none', 'rgba(0, 0, 0, 0)', '0px']);
  // A click far under the text, and beside it, goes to the end of the document: what is typed there is its last words.
  await editorOf(page).getByText('Sign-off is on Monday.').click();
  await page.keyboard.press('Home');
  await page.mouse.click(m.scroll.left + 40, m.scroll.bottom - 60);
  await page.keyboard.type(' End.');
  await expect(editorOf(page).locator('p').last()).toHaveText('Sign-off is on Monday. End.');
  await editorOf(page).getByText('Ship it on').click();
  await page.mouse.click(m.scroll.right - 15, m.scroll.top + 300);
  await page.keyboard.type(' Again.');
  await expect(editorOf(page).locator('p').last()).toHaveText('Sign-off is on Monday. End. Again.');
  // The caret is where it was put: a click in the text itself is not taken for it.
  await editorOf(page).getByText('Ship it on').click();
  await page.keyboard.press('End');
  await page.keyboard.type('!');
  await expect(editorOf(page).locator('p').nth(0)).toContainText('now.!');
  await expect(editorOf(page).locator('p').last()).toHaveText('Sign-off is on Monday. End. Again.');
});

test('the list opens at the side, at the right edge, in a wide page (beside the text) and in a narrow one (over it), with Close', async ({ page }) => {
  const store = new Store();
  seeded(store, 'The build is green.', 'Is it?');
  await open(page, store);
  for (const [width, layout] of [[1400, 'wide'], [700, 'narrow']] as const) {
    await page.setViewportSize({ width, height: 900 });
    await expect(page.locator('.pd-doc')).toHaveAttribute('data-layout', layout);
    await showList(page);
    const [list, area, scroll] = await Promise.all([panel(page).boundingBox(), page.locator('.pd-desk').boundingBox(), page.locator('.pd-scroll').boundingBox()]);
    expect(Math.round(list!.x + list!.width)).toBe(Math.round(area!.x + area!.width));
    expect(Math.round(list!.y)).toBe(Math.round(area!.y));
    expect(Math.round(list!.y + list!.height)).toBe(Math.round(area!.y + area!.height));
    expect(list!.width).toBeLessThanOrEqual(320);
    // Beside the text it pushes the page narrower; over it, the page keeps all its width.
    if (layout === 'wide') expect(Math.round(scroll!.x + scroll!.width)).toBe(Math.round(list!.x));
    else expect(Math.round(scroll!.x + scroll!.width)).toBe(Math.round(area!.x + area!.width));
    await panel(page).getByRole('button', { name: 'Close' }).click();
    await expect(panel(page)).toHaveCount(0);
  }
});

test('a comment started far down a long document keeps the page where it is, and its card is on screen with the box focused', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  const lines = Array.from({ length: 80 }, (_, i) => `P${String(i).padStart(3, '0')} is a line of the long text.`).join('\n\n');
  const store = new Store();
  store.texts.set(3, `# Long\n\n${lines}\n`);
  await open(page, store, { ready: 'P079' });
  const scrolled = () => page.evaluate(() => document.querySelector('.pd-scroll')!.scrollTop);
  for (const line of ['P079 is a line of the long text.', 'P040 is a line of the long text.']) {
    await select(page, line);
    await expect(commentButton(page)).toBeEnabled();
    const before = await scrolled();
    expect(before).toBeGreaterThan(300);
    await commentButton(page).click();
    const box = popover(page).locator('.pd-compose').getByRole('textbox');
    await expect(box).toBeFocused();
    // The page stayed where it was, and the card is in view, not at the top of the sheet.
    expect(Math.abs((await scrolled()) - before)).toBeLessThan(4);
    const card = (await popover(page).boundingBox())!;
    expect(card.y).toBeGreaterThanOrEqual(0);
    expect(card.y + card.height).toBeLessThanOrEqual(900);
    await box.press('Escape');
    await expect(popover(page)).toHaveCount(0);
  }
  // The same through the shortcut, and for a comment opened again from the list.
  await select(page, 'P040 is a line of the long text.');
  await expect(commentButton(page)).toBeEnabled();
  const before = await scrolled();
  await page.keyboard.press('Control+Alt+m');
  await expect(popover(page).locator('.pd-compose').getByRole('textbox')).toBeFocused();
  expect(Math.abs((await scrolled()) - before)).toBeLessThan(4);
});

test('a comment kept with words in it is not thrown away by starting another one: the person is asked, Cancel opens the kept one, it is in the list and reached from the keyboard', async ({ page }) => {
  const store = new Store();
  await open(page, store);
  await select(page, 'The build is green.');
  await commentButton(page).click();
  const compose = popover(page).locator('.pd-compose');
  await compose.getByRole('textbox').fill('Draft one, long and careful');
  await compose.getByRole('textbox').press('Escape');
  await expect(popover(page)).toHaveCount(0);
  // It is in the list, as a line that opens it.
  await showList(page);
  await expect(items(page)).toHaveCount(1);
  await expect(items(page).first()).toContainText('New comment: Draft one, long and careful');
  await expect(items(page).first()).toContainText('The build is green.');
  await items(page).first().click();
  await expect(compose.getByRole('textbox')).toHaveValue('Draft one, long and careful');
  await expect(compose.getByRole('textbox')).toBeFocused();
  await compose.getByRole('textbox').press('Escape');
  await barButton(page).click();
  // From the keyboard: the caret in its passage and the shortcut.
  await editorOf(page).getByText('Ship it on').click();
  await page.keyboard.press('ArrowDown');
  await expect.poll(() => page.evaluate(() => Boolean(window.getSelection()?.anchorNode?.parentElement?.closest('[data-pd-thread]')))).toBe(true);
  await page.keyboard.press('Control+Alt+m');
  await expect(compose.getByRole('textbox')).toHaveValue('Draft one, long and careful');
  await compose.getByRole('textbox').press('Escape');
  // Another comment is started: asked first. Cancel leaves the kept one, which is open again; the new passage is not commented on.
  await select(page, 'Sign-off is on Monday.');
  await expect(commentButton(page)).toBeEnabled();
  await commentButton(page).click();
  await expect(dialog(page)).toContainText('Discard the comment you started?');
  await dialog(page).getByRole('button', { name: 'Cancel' }).click();
  await expect(compose.getByRole('textbox')).toHaveValue('Draft one, long and careful');
  await expect(editorOf(page).locator('.pd-thread-pending')).toHaveText('The build is green.');
  // Again, and discarded: the new passage is the one being written.
  await compose.getByRole('textbox').press('Escape');
  await select(page, 'Sign-off is on Monday.');
  await expect(commentButton(page)).toBeEnabled();
  await commentButton(page).click();
  await dialog(page).getByRole('button', { name: 'Discard' }).click();
  await expect(editorOf(page).locator('.pd-thread-pending')).toHaveText('Sign-off is on Monday.');
  await expect(compose.getByRole('textbox')).toHaveValue('');
  expect(store.made).toEqual([]);
  // Nothing typed in the kept one: no question.
  await compose.getByRole('textbox').press('Escape');
  await select(page, 'The build is green.');
  await expect(commentButton(page)).toBeEnabled();
  await commentButton(page).click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(editorOf(page).locator('.pd-thread-pending')).toHaveText('The build is green.');
});

test('a change to a sent comment is kept when the card is closed, comes back when it is opened, and the page asks before it is left', async ({ page }) => {
  const store = new Store();
  const green = seeded(store, 'The build is green.', 'Original words');
  await open(page, store);
  const asks = () => page.evaluate(() => { const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; });
  let card = await openThread(page, green.id);
  await card.getByRole('button', { name: 'Edit' }).click();
  // Begun and not changed: nothing to keep or to warn of.
  expect(await asks()).toBe(false);
  await card.getByRole('textbox', { name: 'Edit the comment' }).fill('Carefully changed words');
  expect(await asks()).toBe(true);
  // Closed by a click in the text, opened again: the box is there with the words, not focused (nobody asked for it).
  await closeCard(page);
  expect(await asks()).toBe(true);
  card = await openThread(page, green.id);
  await expect(card.getByRole('textbox', { name: 'Edit the comment' })).toHaveValue('Carefully changed words');
  await expect(card.getByRole('textbox', { name: 'Edit the comment' })).not.toBeFocused();
  expect(store.requests).toEqual([]);
  // Saved: it is the comment's, and nothing is kept.
  await card.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(card.getByRole('textbox', { name: 'Edit the comment' })).toHaveCount(0);
  await expect(card.locator('li').first()).toContainText('Carefully changed words');
  expect(await asks()).toBe(false);
  // A change given up (Cancel) is not kept either; one back to the comment's own words is none.
  await card.getByRole('button', { name: 'Edit' }).click();
  await card.getByRole('textbox', { name: 'Edit the comment' }).fill('Yet another');
  await card.getByRole('button', { name: 'Cancel' }).click();
  expect(await asks()).toBe(false);
  await card.getByRole('button', { name: 'Edit' }).click();
  await card.getByRole('textbox', { name: 'Edit the comment' }).fill('Typed');
  await card.getByRole('textbox', { name: 'Edit the comment' }).fill('Carefully changed words');
  expect(await asks()).toBe(false);
  // A change to a comment that is gone is nothing to warn of.
  await card.getByRole('textbox', { name: 'Edit the comment' }).fill('Will be lost');
  expect(await asks()).toBe(true);
  store.threads = [];
  await told(page, 'threads', { at: '2026-10-02T10:00:00.000Z' });
  await expect(popover(page)).toHaveCount(0);
  await expect.poll(asks).toBe(false);
});

test('Ctrl+Alt+M is the comment shortcut and nothing else: AltGr+M (Ctrl+Alt on Windows) is left to the text, which types its character', async ({ page }) => {
  const store = new Store();
  await open(page, store);
  await editorOf(page).getByText('Ship it on').click();
  const sent = (init: KeyboardEventInit) =>
    page.evaluate((init) => {
      const event = new KeyboardEvent('keydown', { code: 'KeyM', bubbles: true, cancelable: true, ...init });
      document.querySelector('.pd-editor .ProseMirror')!.dispatchEvent(event);
      return event.defaultPrevented;
    }, init);
  // As Windows reports AltGr+M on a German layout, and with its state named: not taken.
  expect(await sent({ key: 'µ', ctrlKey: true, altKey: true })).toBe(false);
  expect(await sent({ key: 'µ', altKey: true, modifierAltGraph: true })).toBe(false);
  expect(await sent({ key: 'm', ctrlKey: true, altKey: true, modifierAltGraph: true })).toBe(false);
  // The shortcut is: Ctrl+Alt+M, and ⌘+Alt+M (which types µ on a Mac).
  expect(await sent({ key: 'm', ctrlKey: true, altKey: true })).toBe(true);
  expect(await sent({ key: 'µ', metaKey: true, altKey: true })).toBe(true);
});

test('Escape closes a card that a click opened, wherever the focus is in the text, and does nothing when no card is open', async ({ page }) => {
  const store = new Store();
  const green = seeded(store, 'The build is green.', 'Is it?');
  await open(page, store);
  await openThread(page, green.id);
  await expect(editorOf(page)).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(popover(page)).toHaveCount(0);
  await expect(editorOf(page)).toBeFocused();
  // With none open, Escape is not taken: the page sees it unprevented.
  const taken = () => page.evaluate(() => { const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }); document.querySelector('.pd-editor .ProseMirror')!.dispatchEvent(event); return event.defaultPrevented; });
  expect(await taken()).toBe(false);
});

test('a card whose passage goes while a reply is typed in it stays open where it was, with the note, the words and the focus', async ({ page }) => {
  const store = new Store();
  const green = seeded(store, 'The build is green.', 'Is it?');
  await open(page, store);
  const card = await openThread(page, green.id);
  await card.getByRole('textbox', { name: 'Reply' }).fill('Half a reply');
  const before = (await popover(page).boundingBox())!;
  // The agent saves a revision without the sentence.
  store.elsewhere(store.markdown.replace('The build is green.\n\n', ''));
  await told(page, 'revision', { revision: store.revision, author: 'agent', at: '2026-10-02T10:00:00.000Z' });
  await expect(editorOf(page)).not.toContainText('The build is green.');
  await expect(editorOf(page).locator('.pd-thread')).toHaveCount(0);
  await expect(card).toContainText('The passage this comment was on is no longer in the document.');
  await expect(card.getByRole('textbox', { name: 'Reply' })).toHaveValue('Half a reply');
  await expect(card.getByRole('textbox', { name: 'Reply' })).toBeFocused();
  const after = (await popover(page).boundingBox())!;
  expect(Math.abs(after.x - before.x)).toBeLessThan(2);
  // It can still be sent, and closed with Escape; the thread is then in the list.
  await card.getByRole('textbox', { name: 'Reply' }).press('Control+Enter');
  await expect.poll(() => store.threads[0].comments.length).toBe(2);
  await card.getByRole('textbox', { name: 'Reply' }).press('Escape');
  await expect(popover(page)).toHaveCount(0);
  await showList(page);
  await expect(cards(page)).toHaveCount(1);
});

test('on a wide page a card is beside its passage, level with it at the right edge, never over the passage, and falls back to under it where the passage runs into its place; in a narrow page it is under it', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  const edge = `${'word '.repeat(30)}the end of a long line`;
  const store = new Store();
  store.texts.set(3, `# The plan\n\nThe first point.\n\n${edge}\n\nThe last point.\n`);
  const first = seeded(store, 'The first point.', 'One.');
  const long = seeded(store, edge, 'Long.');
  await open(page, store, { ready: 'The last point.' });
  const sheet = (await page.locator('.pd-sheet').boundingBox())!;
  await openThread(page, first.id);
  await expect(popover(page)).toHaveAttribute('data-side', 'true');
  let box = (await popover(page).boundingBox())!;
  expect(Math.round(sheet.x + sheet.width - (box.x + box.width))).toBeLessThanOrEqual(16);
  expect(Math.abs(box.y - (await rectsOf(page, first.id))[0].top)).toBeLessThan(8);
  expect(await clearOf(page, first.id)).toBe(true);
  // A passage that runs on under the card's place: the card goes under it instead, and the words are still not covered.
  await openThread(page, long.id);
  await expect(popover(page)).not.toHaveAttribute('data-side', 'true');
  box = (await popover(page).boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(Math.max(...(await rectsOf(page, long.id)).map((r) => r.bottom)));
  expect(await clearOf(page, long.id)).toBe(true);
  // In a narrow page there is no room beside it.
  await page.setViewportSize({ width: 800, height: 900 });
  await openThread(page, first.id);
  await expect(popover(page)).not.toHaveAttribute('data-side', 'true');
  box = (await popover(page).boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(Math.max(...(await rectsOf(page, first.id)).map((r) => r.bottom)));
});

test('a marker in the right margin, level with the line of each commented passage, shows how many comments the thread has and opens its card; it is a button, stacks with others on the same line, follows the text, and hides while its card is open', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  const store = new Store();
  const friday = seeded(store, '**Friday**', 'Why Friday?');
  store.comment(friday.id, 'It is the release day.', 'agent');
  store.comment(friday.id, 'Ok.');
  const green = seeded(store, 'The build is green.', 'Is it?');
  await open(page, store);
  await expectMarked(page, green.id, 'The build is green.');
  const markers = page.locator('.pd-marker');
  await expect(markers).toHaveCount(2);
  // A real button with a name that says what it is on and how many comments there are.
  const fridayMarker = page.getByRole('button', { name: 'Comments on “Friday”: 3' });
  const greenMarker = page.getByRole('button', { name: 'Comments on “The build is green.”: 1' });
  await expect(fridayMarker).toContainText('3');
  // In the margin to the right of the text column, level with the line of the passage (a thread is on a line of it).
  const sheet = (await page.locator('.pd-sheet').boundingBox())!;
  const text = (await editorOf(page).boundingBox())!;
  const at = (await greenMarker.boundingBox())!;
  expect(at.x).toBeGreaterThanOrEqual(text.x + text.width);
  expect(at.x + at.width).toBeLessThanOrEqual(sheet.x + sheet.width);
  // (Measured again until it is steady: the line may still be moving into its place.)
  await expect.poll(async () => {
    const [m, rects] = [(await greenMarker.boundingBox())!, await rectsOf(page, green.id)];
    return Math.abs(m.y + m.height / 2 - (rects[0].top + rects[0].bottom) / 2);
  }).toBeLessThan(3);
  // A click opens its card beside the passage (as a click on the words does), and the marker is gone while it is open.
  await greenMarker.click();
  await expect(shown(page)).toHaveAttribute('data-thread', green.id);
  await expect(popover(page)).toHaveAttribute('data-side', 'true');
  await expect(greenMarker).toHaveCount(0);
  await expect(markers).toHaveCount(1);
  await closeCard(page);
  await expect(greenMarker).toBeVisible();
  // With the keyboard: Enter on it opens the card with the focus in its box.
  await greenMarker.focus();
  await page.keyboard.press('Enter');
  await expect(shown(page)).toHaveAttribute('data-thread', green.id);
  await expect(shown(page).getByRole('textbox', { name: 'Reply' })).toBeFocused();
  await closeCard(page);
  // The marker goes down with its passage when text is typed above it.
  const before = (await greenMarker.boundingBox())!.y;
  await editorOf(page).getByRole('heading').click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('A new paragraph that is above.');
  await expect.poll(async () => (await greenMarker.boundingBox())!.y - before).toBeGreaterThan(20);
  await expect.poll(async () => {
    const [m, rects] = [(await greenMarker.boundingBox())!, await rectsOf(page, green.id)];
    return Math.abs(m.y + m.height / 2 - (rects[0].top + rects[0].bottom) / 2);
  }).toBeLessThan(3);
  // A resolved thread has none.
  await openThread(page, friday.id);
  await shown(page).getByRole('button', { name: 'Resolve', exact: true }).click();
  await expect(markers).toHaveCount(1);
});

test('threads on one line have a marker each, one under the other, not over each other', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  const store = new Store();
  seeded(store, 'Ship it on', 'Ship what?');
  seeded(store, '**Friday**', 'Why Friday?');
  seeded(store, 'now.', 'Now?');
  await open(page, store);
  const markers = page.locator('.pd-marker');
  await expect(markers).toHaveCount(3);
  const boxes = (await markers.evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left }; }))).sort((a, b) => a.top - b.top);
  for (let i = 1; i < boxes.length; i++) expect(boxes[i].top).toBeGreaterThanOrEqual(boxes[i - 1].bottom);
  // All in the same column of the margin.
  expect(new Set(boxes.map((b) => Math.round(b.left))).size).toBe(1);
});

test('in a narrow page, where there is no margin, there are no markers: the highlighted words open the card', async ({ page }) => {
  await page.setViewportSize({ width: 600, height: 900 });
  const store = new Store();
  const green = seeded(store, 'The build is green.', 'Is it?');
  await open(page, store);
  await expectMarked(page, green.id, 'The build is green.');
  await expect(page.locator('.pd-marker')).toHaveCount(0);
  await openThread(page, green.id);
});

test('a card beside its passage goes with it when the page is scrolled, however far, and does not stay at the top of the view over other text', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 800 });
  const filler = Array.from({ length: 60 }, (_, i) => `Paragraph ${i + 1} of what is between.`).join('\n\n');
  const store = new Store();
  store.texts.set(3, `# The plan\n\nThe first point.\n\n${filler}\n\nThe last point.\n`);
  const first = seeded(store, 'The first point.', 'One.');
  await open(page, store, { ready: 'The last point.' });
  await openThread(page, first.id);
  await expect(popover(page)).toHaveAttribute('data-side', 'true');
  const level = async () => Math.abs((await popover(page).boundingBox())!.y - (await rectsOf(page, first.id))[0].top);
  expect(await level()).toBeLessThan(8);
  // Scrolled on to read: the passage is far above the view, and the card is with it, not over the lines being read.
  // (Waited for in the page: a frame has passed, so that the scroll was told, and then longer than the card waits to be placed again.)
  await page.evaluate(() => new Promise<void>((done) => {
    document.querySelector('.pd-scroll')!.scrollTo(0, 1500);
    requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(done, 300)));
  }));
  expect((await rectsOf(page, first.id))[0].bottom).toBeLessThan(0);
  expect(await level()).toBeLessThan(8);
  const area = (await page.locator('.pd-scroll').boundingBox())!;
  const card = (await popover(page).boundingBox())!;
  expect(card.y + card.height).toBeLessThan(area.y);
  // And back: beside the passage again.
  await page.evaluate(() => document.querySelector('.pd-scroll')!.scrollTo(0, 0));
  await expect.poll(level).toBeLessThan(8);
});

/** The room right of the text column, and where each marker is: what has to be clear of the words. */
const margins = (page: Page) =>
  page.evaluate(() => {
    const sheet = document.querySelector('.pd-sheet')!.getBoundingClientRect();
    const column = document.querySelector('.pd-editor')!.getBoundingClientRect();
    return { sheet: sheet.width, margin: sheet.right - column.right, markers: [...document.querySelectorAll('.pd-marker')].map((m) => { const r = m.getBoundingClientRect(); return { left: r.left - column.right, right: sheet.right - r.right }; }) };
  });

test('the markers in the margin are drawn only where the margin is wide enough to hold them, also with a panel beside the page, and never touch the text', async ({ page }) => {
  const edge = `${'word '.repeat(30)}the end of a long line`;
  const store = new Store();
  store.texts.set(3, `# The plan\n\n${edge}\n\nThe last point.\n`);
  const long = seeded(store, edge, 'Long.');
  await page.setViewportSize({ width: 1700, height: 900 });
  await open(page, store, { ready: 'The last point.' });
  await expectMarked(page, long.id, edge);
  // Without the panel the margin is wide: a marker, clear of the column.
  await expect(page.locator('.pd-marker')).toHaveCount(1);
  let room = await margins(page);
  expect(room.markers[0].left).toBeGreaterThanOrEqual(0);
  expect(room.markers[0].right).toBeGreaterThanOrEqual(0);
  await showList(page);
  // The panel takes from the page: at a sheet of about 760 and 880 pixels the margin is narrow, and it is the words that open a card.
  for (const width of [1320, 1440, 1700]) {
    await page.setViewportSize({ width, height: 900 });
    await expect.poll(async () => (await margins(page)).sheet).toBeLessThan(width - 300);
    // Measured again until steady: the page is laid out again after the window changed.
    await expect.poll(async () => {
      room = await margins(page);
      return room.markers.length === (room.margin >= 76 ? 1 : 0);
    }).toBe(true);
    for (const marker of room.markers) {
      expect(marker.left).toBeGreaterThanOrEqual(0);
      expect(marker.right).toBeGreaterThanOrEqual(0);
    }
    // Settled before the next width: a measure the page still has queued from this one would be taken at the next, and
    // the next would be passed by it whether or not the page notices that width itself. From 1440 to 1700 pixels only
    // the sheet's padding grows, and the text inside it stays as wide as it was.
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  }
  // The sheets of about 760 and 880 pixels were among them: no marker, no overlap.
  await page.setViewportSize({ width: 1320, height: 900 });
  await expect.poll(async () => Math.round((await margins(page)).sheet)).toBeLessThan(800);
  await expect(page.locator('.pd-marker')).toHaveCount(0);
  // The card is under the passage there (its words are not covered), as they open it.
  await openThread(page, long.id);
  await expect(popover(page)).not.toHaveAttribute('data-side', 'true');
  expect(await clearOf(page, long.id)).toBe(true);
});

test('the markers are measured once in a frame, and not after every key: typing in a document with many comments costs the passages one look, not one each', async ({ page }) => {
  await page.setViewportSize({ width: 1700, height: 900 });
  const paragraphs = Array.from({ length: 40 }, (_, i) => `Point ${i + 1} is stated here.`);
  const store = new Store();
  store.texts.set(3, `# The plan\n\n${paragraphs.join('\n\n')}\n\nThe last point.\n`);
  for (const text of paragraphs) seeded(store, text, 'Why?');
  await open(page, store, { ready: 'The last point.' });
  await expect(page.locator('.pd-marker')).toHaveCount(40);
  // How often the editor's marked passages are asked for, as the page looks for where they are.
  await page.evaluate(() => {
    const asked = { count: 0 };
    (window as any).asked = asked;
    const query = Element.prototype.querySelectorAll;
    Element.prototype.querySelectorAll = function (selector: string) {
      if (typeof selector === 'string' && selector.includes('data-pd-thread')) asked.count++;
      return query.call(this, selector);
    };
  });
  await editorOf(page).getByText('The last point.').click();
  await page.keyboard.press('End');
  await page.waitForTimeout(100);
  await page.keyboard.type('x'.repeat(30), { delay: 5 });
  await page.waitForTimeout(500);
  // (One look for each frame at most, as the text settled; a look for each passage on each key would be over a thousand.)
  expect(await page.evaluate(() => (window as any).asked.count)).toBeLessThan(60);
});

/* The document written as Markdown (the bar's Markdown): the comments are not drawn in the source, and the list still has them. */
test('in the Markdown nothing of the comments is drawn on the text, the list has them all, and choosing one goes to the editor and opens its card', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  const store = new Store();
  const green = seeded(store, 'The build is green.', 'Is it?', 'agent');
  const friday = seeded(store, '**Friday**', 'Why Friday?');
  await open(page, store);
  await expectMarked(page, friday.id, 'Friday');
  await expect(page.locator('.pd-marker')).toHaveCount(2);
  const modes = page.getByRole('group', { name: 'Editing mode' });
  await modes.getByRole('button', { name: 'Markdown', exact: true }).click();
  const source = page.getByRole('textbox', { name: 'Markdown source' });
  await expect(source).toBeVisible();
  // No marks, no markers, no card, no way to start a comment (the shortcut included); the source is the file's own text.
  await expect(editorOf(page)).toBeHidden();
  await expect(page.locator('.pd-marker, .pd-popover')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Comment', exact: true })).toHaveCount(0);
  await source.click();
  await page.keyboard.press('Control+Alt+m');
  await expect(popover(page)).toHaveCount(0);
  await expect(source).toHaveValue(store.markdown);
  // The comments are all in the list, and the bar says how many are open.
  await expect(barButton(page)).toHaveAccessibleName('Comments 2');
  await showList(page);
  await expect(items(page)).toHaveCount(2);
  await expect(items(page).nth(0)).toContainText('Why Friday?');
  // One chosen there goes back to the editor, with its card open at the passage.
  await items(page).nth(0).click();
  await expect(modes.getByRole('button', { name: 'Visual', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(editorOf(page)).toBeVisible();
  await expect(shown(page)).toHaveAttribute('data-thread', friday.id);
  await expect(shown(page)).toContainText('Why Friday?');
  expect(green.id).not.toBe(friday.id);
});
