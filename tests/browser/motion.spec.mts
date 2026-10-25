import { type Page } from '@playwright/test';
import { test, expect, mockPortal } from './portal-mock';
import { settled } from './settled';

// An extension's panel beside the portal's own: the portal's tests' stand-in for one.
test.use({ installed: ['tests/fixtures/extensions/console', 'tests/fixtures/extensions/viewer'] });

/**
 * The extra animations (core/web/src/motion.ts): on by default, one switch to turn
 * them off, the system's reduced motion over it, and what they do to the page —
 * which is nothing the page has to wait for. The config presets the switch to
 * off for every other spec; this one starts as a fresh browser does.
 *
 * What was played is read off the page, not waited for: every call of
 * Element.animate is written down, and so is every picture put on the page
 * (what it was, and that it takes no click and is not a dialog or a landmark).
 */
test.use({ storageState: { cookies: [], origins: [] } });

interface Played { on: string; keys: string[]; ghost: boolean; duration: number }
interface Picture { text: string; hidden: string | null; pointer: string; roles: number; dock: string | null; scrollTop: number; z: number; lived: number | null; before: boolean }

const at = new Date().toISOString();
const chat = (id: string, title: string, extra: object = {}) => ({ id, title, workspace: `/w/${id}`, status: 'idle', kind: 'task', pinned: false, updated_at: at, provider: null, model: null, thinking_level: null, ...extra });

/** Five questions, each answered with a command and a reply: more than a window holds. */
const conversation = (tag: string, bigTurn = 1) => {
  let seq = 0;
  const ev = (type: string, payload: object = {}) => ({ seq: ++seq, type, at: Date.now() - 100_000 + seq * 1000, payload });
  const out: ReturnType<typeof ev>[] = [];
  for (let i = 1; i <= 5; i++) {
    out.push(ev('portal_prompt', { message: `${tag} question ${i}` }), ev('agent_start'));
    // One command a turn, or many for the fourth, when asked.
    for (let c = 0; c < (i === 4 ? bigTurn : 1); c++) {
      const id = `${tag}${i}.${c}`;
      out.push(ev('tool_execution_start', { toolCallId: id, toolName: 'bash', args: { command: `npm test ${i}.${c}` } }));
      out.push(ev('tool_execution_end', { toolCallId: id, toolName: 'bash', result: { content: [{ type: 'text', text: 'ok\n' }] } }));
    }
    out.push(ev('message_end', { message: { role: 'assistant', content: [{ type: 'text', text: `${tag} answer ${i}: nothing else to fix here.` }] } }), ev('agent_end'));
  }
  return out;
};

/** The portal over canned answers: chats that can be deleted, a stream that replays them, and a log of what is played. */
async function portal(page: Page, { off = false, confirms = true, places, many = 0, bigTurn = 1 }: { off?: boolean; confirms?: boolean; places?: Record<string, string>; many?: boolean | number; bigTurn?: number } = {}) {
  // More than the sidebar lists without a search box, when asked.
  const extra = many ? Array.from({ length: many === true ? 10 : many }, (_, i) => chat(`x${i}`, `Extra chat ${i}`)) : [];
  const state = { removeDelay: 80, sessions: [chat('a', 'First chat'), chat('b', 'Second chat'), chat('c', 'Third chat'), chat('d', 'Fourth chat'), ...extra], events: { a: conversation('A', bigTurn), b: conversation('B'), c: [] as any[], d: [] as any[], r: conversation('R') } as Record<string, any[]> };
  // A routine's chat: opened by its address, and not in the list of chats.
  const routine = chat('r', 'Routine chat', { kind: 'routine' });
  await mockPortal(page, async ({ path: p, method, json }) => {
    let m: RegExpMatchArray | null;
    if (p === '/api/sessions' && method === 'GET') return { sessions: state.sessions, executor: 'host' };
    if (p === '/api/sessions' && method === 'POST') {
      const made = chat(`n${state.sessions.length}`, 'A new chat');
      state.sessions = [made, ...state.sessions];
      state.events[made.id] = [];
      return made;
    }
    if (p === '/api/sessions/r') return routine;
    if ((m = p.match(/^\/api\/sessions\/(\w+)\/messages\/(\d+)$/)) && method === 'DELETE') {
      const [id, seq] = [m[1], Number(m[2])];
      const next = state.events[id].find((e) => e.seq > seq && e.type === 'portal_prompt');
      const to = next?.seq ?? null;
      state.events[id] = state.events[id].filter((e) => !(e.seq >= seq && (to === null || e.seq < to)));
      // The server says so a moment after it has answered.
      setTimeout(() => page.evaluate(([id, from, to]) => (window as any).emit(id, { seq: 9000 + from, type: 'portal_removed', payload: { from, to } }), [id, seq, to] as const).catch(() => {}), state.removeDelay);
      return { ok: true };
    }
    if ((m = p.match(/^\/api\/sessions\/(\w+)$/)) && method === 'DELETE') {
      state.sessions = state.sessions.filter((s) => s.id !== m![1]);
      return { ok: true };
    }
    if ((m = p.match(/^\/api\/sessions\/(\w+)$/))) return state.sessions.find((s) => s.id === m![1]) ?? {};
    if (/^\/api\/sessions\/\w+\/(config|models)$/.test(p)) return { live: false, state: { model: { id: 'm', name: 'Model', provider: 'x' }, thinkingLevel: 'medium' }, stats: null, thinking: { levels: ['off', 'medium'] }, models: { models: [] }, named: { provider: null, model: null } };
    if (p.endsWith('/background')) return { jobs: [], statuses: [] };
    if (p === '/api/projects') return { root: '/w', home: '/w', projects: [] };
    if (p === '/api/workspaces') return { root: '/w', workspaces: [] };
    if (p === '/api/models') return { models: [], providers: {} };
    if (p === '/api/features/flags') return { memory: { held: false, by: null } };
    if (p === '/api/settings') return { settings: {}, defaults: {}, stored: {}, executor: 'host', workspaceRoot: '/w', piSettingsPath: '/p/settings.json', compaction: { keepRecentTokens: 20000 }, contextDefault: null };
    if (p === '/api/extensions') return { extensions: [], settingsPath: '/p/settings.json' };
    if (/report/.test(p)) return { targets: [], default: null };
  }, { streams: 'none', settings: true });
  await page.addInitScript(([events, off, confirms, places]) => {
    if (off) localStorage.setItem('animations', 'off');
    if (!confirms) localStorage.setItem('confirmDeletes', 'off');
    if (places) localStorage.setItem('panelPlaces', JSON.stringify(places));
    // Every animation started from script, and every picture put on the page.
    const played: Played[] = ((window as any).played = []);
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (this: Element, frames: any, options: any) {
      const first = Array.isArray(frames) ? frames[0] : frames;
      played.push({ on: `${this.tagName.toLowerCase()}${this.className && typeof this.className === 'string' ? '.' + this.className.split(' ')[0] : ''}`, keys: Object.keys(first ?? {}), ghost: !!this.closest('[data-ghost]'), duration: options?.duration ?? 0 });
      return animate.call(this, frames, options);
    };
    const pictures: Picture[] = ((window as any).pictures = []);
    const intro: { pointer: string; at: number }[] = ((window as any).intro = []);
    const entries = new Map<Node, { at: number; entry: any }>();
    new MutationObserver((records) => {
      const now = performance.now();
      for (const r of records) for (const n of r.removedNodes) {
        const was = entries.get(n);
        if (was) was.entry.lived = now - was.at;
      }
      for (const r of records) for (const n of r.addedNodes) {
        if (!(n instanceof HTMLElement)) continue;
        if (n.hasAttribute('data-ghost')) pictures.push({ text: (n.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 4000), hidden: n.getAttribute('aria-hidden'), pointer: getComputedStyle(n).pointerEvents, roles: n.querySelectorAll('[role], [aria-modal], [id]').length, dock: n.firstElementChild?.getAttribute('data-dock') ?? null, scrollTop: (n.firstElementChild as HTMLElement | null)?.scrollTop ?? 0, z: Number(getComputedStyle(n).zIndex), lived: null, before: !!(n.compareDocumentPosition(document.getElementById('root')!) & Node.DOCUMENT_POSITION_FOLLOWING) });
        if (n.hasAttribute('data-ghost')) entries.set(n, { at: now, entry: pictures[pictures.length - 1] });
        if (n.classList.contains('app-intro')) intro.push({ pointer: getComputedStyle(n).pointerEvents, at: performance.now() });
      }
    }).observe(document, { childList: true, subtree: true });
    // The stream: the chat as it was, then what the test emits.
    const streams: any[] = [];
    (window as any).EventSource = class {
      url: string; closed = false; onmessage: any; onopen: any; listeners: Record<string, ((e: any) => void)[]> = {};
      constructor(url: string) {
        this.url = url; streams.push(this);
        setTimeout(() => {
          if (this.closed) return;
          this.onopen?.();
          const list = events[url.match(/sessions\/(\w+)\/events/)![1]] ?? [];
          for (const e of list) this.onmessage?.({ data: JSON.stringify(e) });
          (this.listeners['caught-up'] ?? []).forEach((fn) => fn({ data: JSON.stringify({ seq: list.at(-1)?.seq ?? 0 }) }));
        }, 30);
      }
      addEventListener(n: string, fn: (e: any) => void) { (this.listeners[n] ??= []).push(fn); }
      close() { this.closed = true; }
    };
    (window as any).emit = (id: string, event: unknown) => streams.filter((s) => !s.closed && s.url.includes(`/sessions/${id}/events`)).forEach((s) => s.onmessage?.({ data: JSON.stringify(event) }));
  }, [state.events, off, confirms, places ?? null] as const);
  return state;
}

const played = (page: Page) => page.evaluate(() => (window as any).played as Played[]);
const pictures = (page: Page) => page.evaluate(() => (window as any).pictures as Picture[]);
const sidebar = (page: Page) => page.getByRole('complementary', { name: 'Sidebar' });
const motion = (page: Page) => page.locator('html');

/** The chat's row in the sidebar, not a picture of it, which is not in the sidebar. */
const row = (page: Page, title: string) => sidebar(page).locator('.session-row', { hasText: title });

async function deleteChat(page: Page, title: string) {
  await row(page, title).hover();
  await row(page, title).getByRole('button', { name: `Delete ${title}` }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete', exact: true }).click();
}

test('the animations are on until one switch in Settings turns them off, and it is remembered', async ({ page }) => {
  await portal(page);
  await page.goto('/s/a');
  await expect(motion(page)).toHaveAttribute('data-motion', 'fancy');

  await sidebar(page).getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'This browser' }).click();
  const switchEl = page.getByRole('switch', { name: 'Fancy animations' });
  await expect(switchEl).toHaveAttribute('aria-checked', 'true');
  await switchEl.click();
  await expect(switchEl).toHaveAttribute('aria-checked', 'false');
  await expect(motion(page)).not.toHaveAttribute('data-motion', /.+/);
  expect(await page.evaluate(() => localStorage.getItem('animations'))).toBe('off');

  // Kept: a reload is still without them, and opens without the intro.
  await page.reload();
  await expect(motion(page)).not.toHaveAttribute('data-motion', /.+/);
  expect(await page.evaluate(() => (window as any).intro.length)).toBe(0);

  // Settings is a place of its own: the reload is still in it.
  await page.getByRole('dialog').getByRole('button', { name: 'This browser' }).click();
  await page.getByRole('switch', { name: 'Fancy animations' }).click();
  await expect(motion(page)).toHaveAttribute('data-motion', 'fancy');
});

test('a system that asks for reduced motion wins over the switch, and the switch says so', async ({ page }) => {
  await portal(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/s/a');
  await expect(sidebar(page)).toBeVisible();
  await expect(motion(page)).not.toHaveAttribute('data-motion', /.+/);
  expect(await page.evaluate(() => (window as any).intro.length)).toBe(0);

  await sidebar(page).getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'This browser' }).click();
  // Still on, as far as the switch goes: it is what comes back when the system stops asking.
  await expect(page.getByRole('switch', { name: 'Fancy animations' })).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByText('Your system asks for reduced motion')).toBeVisible();
  await page.keyboard.press('Escape');
  // Gone while the system still asks for less: it is not what is switched on next that sees it go.
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // Changed while the page is open, it follows.
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expect(motion(page)).toHaveAttribute('data-motion', 'fancy');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(motion(page)).not.toHaveAttribute('data-motion', /.+/);
  expect((await played(page)).filter((p) => p.ghost)).toEqual([]);
});

test('the portal opens through doors that take no click, and does not do it again on a reload', async ({ page }) => {
  await portal(page);
  await page.goto('/s/a');
  // Under it, the portal is already there to be used.
  await page.getByText('Second chat').first().click();
  await expect(page).toHaveURL(/\/s\/b$/);
  const intro = await page.evaluate(() => (window as any).intro as { pointer: string }[]);
  expect(intro).toHaveLength(1);
  expect(intro[0].pointer).toBe('none');
  // About a second, and gone.
  await expect(page.locator('.app-intro')).toHaveCount(0);

  await page.reload();
  await expect(sidebar(page)).toBeVisible();
  expect(await page.evaluate(() => (window as any).intro.length)).toBe(0);
});

test('a chat that is left drifts away as a picture, and the one that opens plays its last messages in', async ({ page }) => {
  await portal(page);
  await page.goto('/s/a');
  await expect(page.getByText('A answer 5')).toBeVisible();
  // The picture of the chat that is left is a copy of its list, with the class too: the real list is the one outside the picture's frame.
  const list = page.locator('.chat-list:not([data-ghost] *)');

  await row(page, 'Second chat').click();
  await expect(list).toHaveClass(/is-opening/);
  // The real conversation is the new one at once; what drifts away is a copy.
  await expect(page.getByText('B answer 5')).toBeVisible();
  await expect(page.locator('[data-transcript]').getByText('A answer 5')).toHaveCount(0);
  const log = await played(page);
  expect(log.some((p) => p.ghost && p.keys.includes('opacity'))).toBe(true);
  // And it is a copy that cannot be found as a conversation, clicked, or heard as one.
  const seen = (await pictures(page)).find((p) => p.text.includes('A answer 5'));
  expect(seen).toMatchObject({ hidden: 'true', pointer: 'none', roles: 0 });
  // Then it is just a chat again.
  await expect(list).not.toHaveClass(/is-opening/);
});

test('a deleted chat leaves its row at once and breaks apart as a picture of it', async ({ page }) => {
  await portal(page);
  await page.goto('/s/a');
  await expect(row(page, 'Fourth chat')).toBeVisible();
  await deleteChat(page, 'Fourth chat');

  await expect(row(page, 'Fourth chat')).toHaveCount(0);
  await expect.poll(async () => (await pictures(page)).filter((p) => p.text.includes('Fourth chat')).length).toBeGreaterThan(0);
  const seen = (await pictures(page)).find((p) => p.text.includes('Fourth chat'))!;
  expect(seen).toMatchObject({ hidden: 'true', pointer: 'none' });
  // It goes, and does not stay.
  await expect(page.locator('[data-ghost]')).toHaveCount(0);
});

test('a dialog sinks away as a picture of itself that is not a dialog', async ({ page }) => {
  await portal(page);
  await page.goto('/s/a');
  await sidebar(page).getByRole('button', { name: 'Settings' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await settled(page);
  await page.keyboard.press('Escape');

  await expect(page.getByRole('dialog')).toHaveCount(0);
  // No dialog left behind it for the keys that look for one, nor for a screen reader.
  expect(await page.locator('[aria-modal="true"]').count()).toBe(0);
  const seen = (await pictures(page)).find((p) => p.text.includes('Settings'));
  expect(seen).toMatchObject({ hidden: 'true', pointer: 'none', roles: 0 });
  expect((await played(page)).some((p) => p.ghost && p.on.includes('ui-dialog'))).toBe(true);
});

test('a deleted message breaks apart, the ones below slide up, and the way back to the end is not offered', async ({ page }) => {
  await page.setViewportSize({ width: 1300, height: 760 });
  await portal(page);
  await page.goto('/s/a');
  await expect(page.getByText('A answer 5')).toBeVisible();
  // At the end of a conversation that is longer than the window.
  expect(await page.evaluate(() => { const s = document.querySelector('[data-transcript]')!; return s.scrollHeight > s.clientHeight; })).toBe(true);

  // Not while the last messages are still coming in: they are on their way to where they lie, and a click would scroll to them.
  await expect(page.locator('.chat-list')).not.toHaveClass(/is-opening/);
  const message = page.locator('[data-key]', { hasText: 'A question 4' });
  await message.hover();
  await message.getByRole('button', { name: /Delete this message/ }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete', exact: true }).click();

  await expect(page.getByText('A question 4')).toHaveCount(0);
  await expect.poll(async () => (await pictures(page)).filter((p) => p.text.includes('A question 4')).length).toBeGreaterThan(0);
  // What is below it slid up from where it was.
  expect((await played(page)).some((p) => !p.ghost && p.on.startsWith('div') && p.keys.includes('translate'))).toBe(true);
  // The rows that start below the end made the box scroll further than it does, and it took itself for scrolled away from the end.
  // Nothing is to happen after the scroll: the box is not to take itself for scrolled away, which only waiting shows.
  await page.waitForTimeout(1200);
  await expect(page.locator('.jump-to-end')).toHaveCount(0);
});

test('a panel drops away when it is closed, and a carried one flies to its new place instead', async ({ page }) => {
  await page.setViewportSize({ width: 1300, height: 760 });
  await portal(page);
  await page.goto('/s/a');
  await page.getByRole('button', { name: 'Console', exact: true }).click();
  const aside = page.locator('aside[data-dock="right"]');
  await expect(aside).toBeVisible();
  await settled(page);

  // Carried by its header to the left edge.
  const head = (await aside.locator('.chat-aside-head').boundingBox())!;
  await page.mouse.move(head.x + head.width - 60, head.y + head.height / 2);
  await page.mouse.down();
  await page.mouse.move(head.x + head.width - 120, head.y + 60, { steps: 4 });
  await page.mouse.move(30, 380, { steps: 10 });
  await page.mouse.up();
  await expect(page.locator('aside[data-dock="left"]')).toBeVisible();
  const flown = (await played(page)).filter((p) => !p.ghost && p.on.includes('chat-aside-panel'));
  expect(flown).toHaveLength(1);
  // Not also left behind and closed.
  expect((await played(page)).filter((p) => p.ghost)).toEqual([]);
  await settled(page);

  await page.getByRole('button', { name: 'Close Console' }).click();
  await expect(page.locator('aside[data-dock]')).toHaveCount(0);
  expect((await played(page)).some((p) => p.ghost && p.keys.includes('opacity'))).toBe(true);
});

test('what is sent flies off the send button', async ({ page }) => {
  await portal(page);
  await page.route('**/api/sessions/a/prompt', (route) => route.fulfill({ json: { ok: true } }));
  await page.goto('/s/a');
  await page.getByRole('textbox', { name: 'Message' }).fill('Look at the build');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect.poll(async () => (await played(page)).some((p) => p.on === 'svg' && p.keys.includes('transform'))).toBe(true);
});

test('with the switch off none of it is made: no doors, no pictures, no animation from script', async ({ page }) => {
  await page.setViewportSize({ width: 1300, height: 760 });
  await portal(page, { off: true });
  await page.goto('/s/a');
  await expect(page.getByText('A answer 5')).toBeVisible();
  await expect(motion(page)).not.toHaveAttribute('data-motion', /.+/);

  await deleteChat(page, 'Fourth chat');
  await expect(row(page, 'Fourth chat')).toHaveCount(0);
  await row(page, 'Second chat').click();
  await expect(page.getByText('B answer 5')).toBeVisible();
  await expect(page.locator('.chat-list')).not.toHaveClass(/is-opening/);
  await sidebar(page).getByRole('button', { name: 'Settings' }).click();
  await settled(page);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  // Nothing is to happen from here, which only waiting for as long as it would take shows.
  await page.waitForTimeout(600);

  expect(await played(page)).toEqual([]);
  expect(await pictures(page)).toEqual([]);
  expect(await page.evaluate(() => (window as any).intro.length)).toBe(0);
});

test('closing one of two places plays that place, not the other that stays', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 800 });
  // The viewer at the left, the console at the right.
  await portal(page, { places: { 'x:test-viewer/viewer': 'left' } });
  await page.goto('/s/a');
  await page.getByRole('button', { name: 'Console', exact: true }).click();
  await page.getByRole('button', { name: 'Viewer', exact: true }).click();
  await expect(page.locator('aside[data-dock="right"]')).toBeVisible();
  await expect(page.locator('aside[data-dock="left"]')).toBeVisible();
  await settled(page);

  await page.getByRole('button', { name: 'Close Console' }).click();
  await expect(page.locator('aside[data-dock="right"]')).toHaveCount(0);
  // What went was the console's place; the viewer stays where it is.
  await expect.poll(async () => (await pictures(page)).map((p) => p.dock)).toEqual(['right']);
  await expect(page.locator('aside[data-dock="left"]')).toBeVisible();
  await settled(page);

  // And the one that stayed drops away in its turn when it goes.
  await page.getByRole('button', { name: 'Close Viewer' }).click();
  await expect(page.locator('aside[data-dock]')).toHaveCount(0);
  await expect.poll(async () => (await pictures(page)).map((p) => p.dock)).toEqual(['right', 'left']);
});

test('two messages deleted close together leave the list as it was', async ({ page }) => {
  await page.setViewportSize({ width: 1300, height: 760 });
  // With confirmations off a delete is one press.
  await portal(page, { confirms: false });
  await page.goto('/s/a');
  await expect(page.getByText('A answer 5')).toBeVisible();
  await expect(page.locator('.chat-list')).not.toHaveClass(/is-opening/);

  // The second while the first is still sliding what is below it up.
  await page.evaluate(async () => {
    const del = (text: string) => ([...document.querySelectorAll('[data-key]')].find((r) => r.textContent?.includes(text))!.querySelector('button[aria-label^="Delete this message"]') as HTMLElement).click();
    del('A question 4');
    await new Promise((r) => setTimeout(r, 250));
    del('A question 3');
  });
  await expect(page.getByText('A question 3')).toHaveCount(0);
  await settled(page);
  // Cut off at its edge only while they slide: a long reply still scrolls sideways, and the next message comes in whole.
  expect(await page.locator('.chat-list').evaluate((el: HTMLElement) => [el.style.overflow, el.style.overflowClipMargin])).toEqual(['', '']);
  expect((await pictures(page)).filter((p) => p.text.includes('A question')).length).toBeGreaterThan(1);
});

test('nothing comes in from the right of the box that scrolls it', async ({ page }) => {
  // A chat column narrower than the list is wide: beside the sidebar, at the width where it is still there.
  await page.setViewportSize({ width: 800, height: 760 });
  await portal(page);
  await page.goto('/s/a');
  await expect(page.getByText('A answer 5')).toBeVisible();
  await expect(page.locator('.chat-list')).not.toHaveClass(/is-opening/);

  /** The most a box is wider than it shows, over the next second. */
  const watch = (selector: string) => page.evaluate((selector) => {
    const box = document.querySelector(selector)!;
    const seen = ((window as any).wider = { most: 0 });
    const until = performance.now() + 1100;
    const tick = () => {
      seen.most = Math.max(seen.most, box.scrollWidth - box.clientWidth);
      if (performance.now() < until) requestAnimationFrame(tick);
    };
    tick();
  }, selector);
  const widest = async () => { await settled(page); return page.evaluate(() => (window as any).wider.most as number); };

  // What you say, coming in.
  await watch('[data-transcript]');
  await page.evaluate(() => (window as any).emit('a', { seq: 800, type: 'portal_prompt', payload: { message: 'And one thing more' } }));
  await expect(page.getByText('And one thing more')).toBeVisible();
  expect(await widest()).toBe(0);

  // A page of Settings, coming in.
  await sidebar(page).getByRole('button', { name: 'Settings' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await settled(page);
  await watch('div:has(> .settings-page)');
  await page.getByRole('dialog').getByRole('button', { name: 'This browser' }).click();
  await expect(page.getByRole('switch', { name: 'Fancy animations' })).toBeVisible();
  expect(await widest()).toBe(0);
});

test('turning the animations on or off does not play again what is on the page', async ({ page }) => {
  await portal(page);
  await page.goto('/s/a');
  await sidebar(page).getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'This browser' }).click();
  await expect(page.getByRole('switch', { name: 'Fancy animations' })).toBeVisible();
  // Everything that was coming in has come.
  const going = () => page.evaluate(() => new Promise<number>((done) => requestAnimationFrame(() => done(document.getAnimations().filter((a) => 'animationName' in a && Number.isFinite(a.effect!.getComputedTiming().iterations!) && a.playState === 'running').length))));
  await expect.poll(going, { timeout: 8000 }).toBe(0);

  await page.getByRole('switch', { name: 'Fancy animations' }).click();
  await expect(motion(page)).not.toHaveAttribute('data-motion', /.+/);
  expect(await going()).toBe(0);
  await page.getByRole('switch', { name: 'Fancy animations' }).click();
  await expect(motion(page)).toHaveAttribute('data-motion', 'fancy');
  expect(await going()).toBe(0);
});

test('a chat that is left keeps in its picture where its conversation was scrolled to', async ({ page }) => {
  await page.setViewportSize({ width: 1300, height: 760 });
  await portal(page);
  await page.goto('/s/a');
  await expect(page.getByText('A answer 5')).toBeVisible();
  await expect(page.locator('.chat-list')).not.toHaveClass(/is-opening/);
  const at = await page.locator('[data-transcript]').evaluate((el) => el.scrollTop);
  expect(at).toBeGreaterThan(100);

  await row(page, 'Second chat').click();
  await expect.poll(async () => (await pictures(page)).filter((p) => p.text.includes('A answer 5')).length).toBeGreaterThan(0);
  // The end of it, where it was read, and not its start.
  const seen = (await pictures(page)).find((p) => p.text.includes('A answer 5'))!;
  expect(Math.abs(seen.scrollTop - at)).toBeLessThanOrEqual(1);
});

test('a chat that is deleted dissolves, and one the list never had does not', async ({ page }) => {
  await portal(page);
  // A routine's chat, opened by its address and left for another.
  await page.goto('/s/r');
  await expect(page.getByText('R answer 5')).toBeVisible();
  await expect(page.locator('.chat-list')).not.toHaveClass(/is-opening/);
  await row(page, 'Second chat').click();
  await expect(page.getByText('B answer 5')).toBeVisible();
  // Drifts away (340 ms), as any chat does.
  expect((await played(page)).filter((p) => p.ghost).map((p) => p.duration)).toEqual([340]);

  // One that is deleted, open, shrinks away (520 ms).
  await page.goto('/s/a');
  await expect(page.getByText('A answer 5')).toBeVisible();
  await deleteChat(page, 'First chat');
  await expect.poll(async () => (await played(page)).filter((p) => p.ghost).map((p) => p.duration)).toContain(520);
});

test('a new chat is not shown its empty state twice', async ({ page }) => {
  await portal(page);
  await page.goto('/s/a');
  await expect(page.getByText('A answer 5')).toBeVisible();
  await sidebar(page).getByRole('button', { name: 'New', exact: true }).click();
  await expect(page.getByText('Give pi a task.')).toBeVisible();
  // Past the second in which a chat that has just loaded plays its messages in (not the copy of the one that was left, which has the same list).
  await expect(page.locator('main .chat-list')).not.toHaveClass(/is-opening/);
  // Nothing is to be running a moment after the entrance is over: the check is of what is still going, so it is not waited for with what waits for that.
  await page.waitForTimeout(150);
  expect(await page.locator('.chat-empty').evaluate((el) => el.getAnimations().filter((a) => a.playState === 'running').length)).toBe(0);
});

test('a panel that has flown to its place does not come in again', async ({ page }) => {
  await page.setViewportSize({ width: 1300, height: 760 });
  await portal(page);
  await page.goto('/s/a');
  await page.getByRole('button', { name: 'Console', exact: true }).click();
  const aside = page.locator('aside[data-dock="right"]');
  await expect(aside).toBeVisible();
  await settled(page);
  const head = (await aside.locator('.chat-aside-head').boundingBox())!;
  await page.mouse.move(head.x + head.width - 60, head.y + head.height / 2);
  await page.mouse.down();
  await page.mouse.move(head.x + head.width - 120, head.y + 60, { steps: 4 });
  await page.mouse.move(30, 380, { steps: 10 });
  await page.mouse.up();
  const there = page.locator('aside[data-dock="left"]');
  await expect(there).toBeVisible();
  // Its flight is 620 ms; a moment after it, nothing of the entrance a panel that opens has is going.
  // Its flight is 620 ms; a moment after it, nothing of the entrance a panel that opens has is going. That is a check of what is still going, so it is waited for in time.
  await page.waitForTimeout(900);
  expect(await there.evaluate((el) => el.getAnimations({ subtree: true }).filter((a) => 'animationName' in a && a.playState === 'running').length)).toBe(0);
});

test('a search that ends does not bring the rows it hid in as new ones', async ({ page }) => {
  await portal(page, { many: true });
  await page.goto('/s/a');
  await expect(sidebar(page).getByRole('searchbox', { name: 'Search chats' })).toBeVisible();
  await settled(page);
  const search = sidebar(page).getByRole('searchbox', { name: 'Search chats' });
  await search.fill('Fourth');
  await expect(row(page, 'Extra chat 3')).toHaveCount(0);
  await settled(page);

  const before = (await played(page)).length;
  await search.fill('');
  await expect(row(page, 'Extra chat 3')).toBeVisible();
  // Nothing is to happen from here, which only waiting for as long as it would take shows.
  await page.waitForTimeout(900);
  expect((await played(page)).slice(before).filter((p) => p.on.includes('session-row'))).toEqual([]);
});

test("Settings' rail is not drawn in again when its search ends", async ({ page }) => {
  await portal(page);
  await page.goto('/s/a');
  await sidebar(page).getByRole('button', { name: 'Settings' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  // Past the dialog's own entrance, rail included.
  await settled(page);
  const search = page.getByRole('combobox', { name: 'Search settings' });
  await search.fill('theme');
  await expect(page.getByRole('listbox', { name: 'Settings found' })).toBeVisible();
  await search.press('Escape');
  await expect(page.locator('.rail-item').first()).toBeVisible();
  expect(await page.evaluate(() => [...document.querySelectorAll('.rail-item')].flatMap((el) => el.getAnimations()).length)).toBe(0);
});

test("the Stop button of voice mode is there at once when a run starts, and the controls come in together when the stage does", async ({ page }) => {
  // The voice fixture, as voice-windows has it; it does not start the animations itself.
  await page.addInitScript(() => { (window as any).EventSource = class { close() {} }; });
  await page.route('**/api/sessions/test/commands', (route) => route.fulfill({ json: { commands: [] } }));
  await page.route('**/api/sessions/test/config', (route) => route.fulfill({ status: 503, json: {} }));
  await page.route('**/api/voice', (route) => route.fulfill({ json: { enabled: true } }));
  await page.setViewportSize({ width: 1400, height: 860 });
  await page.goto('/tests/voice.html');
  await page.evaluate(() => { document.documentElement.dataset.motion = 'fancy'; });
  await page.getByRole('button', { name: 'Turn on hands-free voice' }).click();
  await expect(page.getByRole('status')).toHaveText('Listening', { timeout: 25000 });
  // As one: not a delay for each, which a button drawn later would wait through too.
  expect(await page.locator('.voice-stage-controls').evaluate((el) => getComputedStyle(el).animationName)).toBe('fx-controls-in');

  await page.getByRole('button', { name: 'Stream reply' }).click();
  const stop = page.getByRole('button', { name: 'Stop the agent' });
  await expect(stop).toBeVisible();
  expect(await stop.evaluate((el) => [getComputedStyle(el).animationName, getComputedStyle(el).opacity])).toEqual(['none', '1']);
});

test('a row that comes in while a chat opens is not played in again when the opening second ends', async ({ page }) => {
  await page.setViewportSize({ width: 1300, height: 760 });
  await portal(page);
  await page.goto('/s/a');
  await expect(page.getByText('A answer 5')).toBeVisible();
  await expect(page.locator('main .chat-list')).not.toHaveClass(/is-opening/);

  // From the moment the other chat is drawn: a tool call 100 ms in, and another event at 850 ms, which is any draw.
  const seen = page.evaluate(() => new Promise<[string, string, boolean]>((done) => {
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const tool = (seq: number, id: string) => (window as any).emit('b', { seq, type: 'tool_execution_start', payload: { toolCallId: id, toolName: 'bash', args: { command: `echo ${id}` } } });
    const timer = setInterval(async () => {
      if (!document.querySelector('main .chat-list.is-opening')) return;
      clearInterval(timer);
      await wait(100);
      tool(900, 'live-one');
      await wait(750);
      tool(901, 'live-two');
      await wait(120);
      const row = [...document.querySelectorAll('main .chat-list > [data-key]')].find((r) => r.textContent?.includes('live-one'))!;
      const style = getComputedStyle(row);
      done([style.animationName, style.opacity, !!document.querySelector('main .chat-list.is-opening')]);
    }, 5);
  }));
  await row(page, 'Second chat').click();
  const [name, opacity, opening] = await seen;
  // Still in the opening second, and the row is there, not played in a second time.
  expect(opening).toBe(true);
  expect(name).not.toBe('fx-open');
  expect(opacity).toBe('1');
});

test("Settings' extension pages come in once, not again when the dialog stops being new", async ({ page }) => {
  await portal(page);
  // Asked for as the dialog opens, answered a little after: they are the lines that come in with the list's own stagger.
  await page.route('**/api/extensions', async (route) => {
    await new Promise((r) => setTimeout(r, 400));
    await route.fulfill({ json: { extensions: ['One', 'Two'].map((name) => ({ spec: `npm:ext-${name}`, name: `Ext ${name}`, version: '1', description: '', settings: [{ key: 'apiKey', value: '' }] })), settingsPath: '/p/settings.json' } });
  });
  await page.goto('/s/a');
  await settled(page);
  const names = page.evaluate(() => new Promise<string[]>((done) => {
    const seen = new Set<string>();
    const until = performance.now() + 2400;
    const tick = () => {
      for (const el of document.querySelectorAll('.rail-item')) if (el.textContent?.includes('Ext ')) seen.add(getComputedStyle(el).animationName);
      if (performance.now() < until) requestAnimationFrame(tick);
      else done([...seen]);
    };
    tick();
  }));
  await sidebar(page).getByRole('button', { name: 'Settings' }).click();
  await expect(page.getByRole('dialog').getByText('Ext One')).toBeVisible();
  // One animation, from the start to the end of it: another name is another one, started over.
  expect((await names).filter((n) => n !== 'none')).toHaveLength(1);
});

test('the options of a list that fits do not make it scroll while they come in', async ({ page }) => {
  await portal(page);
  await page.goto('/s/a');
  await sidebar(page).getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'This browser' }).click();
  const language = page.getByRole('combobox', { name: 'Language' });
  await expect(language).toBeVisible();
  await settled(page);

  await page.evaluate(() => {
    const seen = ((window as any).taller = { most: 0 });
    const until = performance.now() + 1200;
    const tick = () => {
      const list = document.querySelector('.ui-select-list');
      if (list) seen.most = Math.max(seen.most, list.scrollHeight - list.clientHeight);
      if (performance.now() < until) requestAnimationFrame(tick);
    };
    tick();
  });
  await language.click();
  await expect(page.getByRole('listbox', { name: 'Language' })).toBeVisible();
  // Nothing is to happen from here, which only waiting for as long as it would take shows.
  await page.waitForTimeout(1300);
  expect(await page.evaluate(() => (window as any).taller.most as number)).toBe(0);
});

test('deleting at the end of a conversation slides what is above, and leaves what is below where it is', async ({ page }) => {
  await page.setViewportSize({ width: 1300, height: 760 });
  await portal(page, { confirms: false });
  await page.goto('/s/a');
  await expect(page.getByText('A answer 5')).toBeVisible();
  await expect(page.locator('main .chat-list')).not.toHaveClass(/is-opening/);

  // Where two rows are drawn, frame by frame, from the press: the one above the gap, and the one below it.
  const drawn = await page.evaluate(() => new Promise<{ above: number[]; below: number[] }>((done) => {
    const find = (text: string) => [...document.querySelectorAll('main .chat-list > [data-key]')].find((r) => r.textContent?.includes(text))!;
    const above: number[] = [], below: number[] = [];
    (find('A question 4').querySelector('button[aria-label^="Delete this message"]') as HTMLElement).click();
    const from = performance.now();
    const tick = () => {
      above.push(find('A answer 3').getBoundingClientRect().top);
      below.push(find('A answer 5').getBoundingClientRect().top);
      if (performance.now() - from < 1500) requestAnimationFrame(tick);
      else done({ above, below });
    };
    tick();
  }));
  // The browser pulls a conversation held at its end back when it gets shorter: what is below the gap stays on the page.
  expect(Math.max(...drawn.below) - Math.min(...drawn.below)).toBeLessThanOrEqual(3);
  // What is above it comes down to it, from where it was, and not in one step.
  const first = drawn.above[0], last = drawn.above.at(-1)!;
  expect(last - first).toBeGreaterThan(60);
  expect(drawn.above.filter((y) => y > first + 8 && y < last - 8).length).toBeGreaterThanOrEqual(3);
  expect(Math.max(...drawn.above.slice(1).map((y, i) => y - drawn.above[i]))).toBeLessThan((last - first) * 0.7);
});

test('sending a message and opening a chat do not make the conversation bounce', async ({ page }) => {
  await page.setViewportSize({ width: 1300, height: 760 });
  await portal(page);
  await page.goto('/s/a');
  await expect(page.getByText('A answer 5')).toBeVisible();
  await expect(page.locator('main .chat-list')).not.toHaveClass(/is-opening/);

  /** How much taller than it ends the box is, at most, over the next 1.4 s: rows that start below its end make it scroll further than it goes. */
  const taller = () => page.evaluate(() => new Promise<number>((done) => {
    const box = document.querySelector('[data-transcript]')!;
    const heights: number[] = [];
    const from = performance.now();
    const tick = () => {
      heights.push(box.scrollHeight);
      if (performance.now() - from < 1400) requestAnimationFrame(tick);
      else done(Math.max(...heights) - heights.at(-1)!);
    };
    tick();
  }));

  const sent = taller();
  await page.evaluate(() => (window as any).emit('a', { seq: 800, type: 'portal_prompt', payload: { message: 'One more thing' } }));
  expect(await sent).toBe(0);

  await row(page, 'Second chat').click();
  await expect(page.getByText('B answer 5')).toBeVisible();
  expect(await taller()).toBe(0);
});

test('a chat that moves up the list does not play its entrance again, and does not light up as picked', async ({ page }) => {
  const state = await portal(page);
  await page.goto('/s/b');
  await expect(page.getByText('B answer 5')).toBeVisible();
  await settled(page);
  const open = sidebar(page).locator('.session-row[aria-current="page"]');
  await expect(open).toHaveCount(1);

  // Another chat overtakes the open one, as a chat that starts working does.
  const before = (await played(page)).length;
  state.sessions = [state.sessions[3], ...state.sessions.slice(0, 3)];
  await page.evaluate(() => (window as any).emit('b', { seq: 950, type: 'portal_status', payload: { status: 'idle' } }));
  await expect(sidebar(page).locator('.session-row').first()).toContainText('Fourth chat');
  // It slides; and what the move made start again is at its end.
  expect((await played(page)).slice(before).some((p) => p.on.includes('session-row') && p.keys.includes('translate'))).toBe(true);
  expect(await open.evaluate((el) => el.getAnimations().filter((a) => 'animationName' in a && a.playState === 'running').length)).toBe(0);
});

test('a page that is left is under the dialog that opens as it goes', async ({ page }) => {
  await portal(page);
  await page.goto('/sessions');
  await expect(page.getByRole('heading', { name: 'Sessions' })).toBeVisible();
  await settled(page);
  await sidebar(page).getByRole('button', { name: 'Settings' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  // Settings' backdrop is at 50; what is left of the page lies under it.
  await expect.poll(async () => (await pictures(page)).filter((p) => p.text.includes('Every task you have handed')).length).toBeGreaterThan(0);
  const left = (await pictures(page)).find((p) => p.text.includes('Every task you have handed'))!;
  expect(left.z).toBeLessThan(50);
  // And a dialog's own picture is over everything.
  await settled(page);
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await pictures(page)).some((p) => p.text.includes('Settings') && p.z >= 50)).toBe(true);
});

test('the switch turns the animations off where the page cannot keep it', async ({ page }) => {
  await portal(page);
  // Site data blocked: reading or writing storage throws.
  await page.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('blocked', 'SecurityError'); } });
  });
  await page.route('**/api/models', (route) => route.fulfill({ json: { models: [{ provider: 'x', id: 'm', name: 'M', contextWindow: 1000, reasoning: false }], providers: {} } }));
  await page.goto('/settings/browser');
  const switchEl = page.getByRole('switch', { name: 'Fancy animations' });
  await expect(switchEl).toHaveAttribute('aria-checked', 'true');
  await expect(motion(page)).toHaveAttribute('data-motion', 'fancy');

  await switchEl.click();
  await expect(switchEl).toHaveAttribute('aria-checked', 'false');
  await expect(motion(page)).not.toHaveAttribute('data-motion', /.+/);
});

test("deleting in the sidebar's list, scrolled to its end, slides the rows above and leaves the ones below", async ({ page }) => {
  // Twelve chats, in a window too low for them.
  await page.setViewportSize({ width: 1300, height: 420 });
  await portal(page, { confirms: false, many: 8 });
  await page.goto('/s/a');
  await expect(row(page, 'Extra chat 7')).toBeVisible();
  await settled(page);
  await sidebar(page).locator('.sidebar-list').evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await settled(page);

  const drawn = await page.evaluate(() => new Promise<{ above: number[]; below: number[] }>((done) => {
    const find = (text: string) => [...document.querySelectorAll('aside .session-row')].find((r) => r.textContent?.includes(text))!;
    const above: number[] = [], below: number[] = [];
    (find('Extra chat 3').querySelector('button[title="Delete session"]') as HTMLElement).click();
    const from = performance.now();
    const tick = () => {
      above.push(find('Extra chat 1').getBoundingClientRect().top);
      below.push(find('Extra chat 7').getBoundingClientRect().top);
      if (performance.now() - from < 1500) requestAnimationFrame(tick);
      else done({ above, below });
    };
    tick();
  }));
  // Pulled back by the browser as the list gets shorter: what is below the gap has not moved on the page.
  expect(Math.max(...drawn.below) - Math.min(...drawn.below)).toBeLessThanOrEqual(3);
  const first = drawn.above[0], last = drawn.above.at(-1)!;
  expect(last - first).toBeGreaterThan(20);
  expect(Math.max(...drawn.above.slice(1).map((y, i) => y - drawn.above[i]))).toBeLessThan((last - first) * 0.7);
});

test('a message deleted while the conversation is scrolled before the server answers slides from where it is drawn then', async ({ page }) => {
  await page.setViewportSize({ width: 1300, height: 760 });
  const state = await portal(page, { confirms: false });
  // The server stops the chat's agent first, which takes a while.
  state.removeDelay = 800;
  await page.goto('/s/a');
  await expect(page.getByText('A answer 5')).toBeVisible();
  await expect(page.locator('main .chat-list')).not.toHaveClass(/is-opening/);

  const above = await page.evaluate(() => new Promise<{ t: number; y: number }[]>((done) => {
    const find = (text: string) => [...document.querySelectorAll('main .chat-list > [data-key]')].find((r) => r.textContent?.includes(text))!;
    const box = document.querySelector('[data-transcript]')!;
    const seen: { t: number; y: number }[] = [];
    (find('A question 4').querySelector('button[aria-label^="Delete this message"]') as HTMLElement).click();
    const from = performance.now();
    let scrolled = false;
    const tick = () => {
      const t = performance.now() - from;
      // Reading back a little, while it is being asked.
      if (!scrolled && t > 250) { scrolled = true; box.scrollTop -= 120; }
      seen.push({ t, y: find('A answer 3').getBoundingClientRect().top });
      if (t < 2400) requestAnimationFrame(tick);
      else done(seen);
    };
    tick();
  }));
  // From the moment it was scrolled: the row above the gap only comes down, as it does without the animations. It is not put back to where it was at the press first.
  const after = above.filter((p) => p.t > 400).map((p) => p.y);
  expect(Math.min(...after.slice(1).map((y, i) => y - after[i]))).toBeGreaterThanOrEqual(-1);
  expect(after.at(-1)! - after[0]).toBeGreaterThan(20);
});

test('a row deleted in the phone\'s drawer breaks apart over the drawer', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await portal(page, { confirms: false });
  await page.goto('/s/a');
  await expect(page.getByText('A answer 5')).toBeVisible();
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await expect(row(page, 'Fourth chat')).toBeVisible();
  await settled(page);
  await page.evaluate(() => ([...document.querySelectorAll('aside .session-row')].find((r) => r.textContent?.includes('Fourth chat'))!.querySelector('button[title="Delete session"]') as HTMLElement).click());
  await expect.poll(async () => (await pictures(page)).filter((p) => p.text.includes('Fourth chat')).length).toBeGreaterThan(0);
  // The drawer is at 50: the picture of what was in it is over it, or it is not to be seen.
  expect((await pictures(page)).find((p) => p.text.includes('Fourth chat'))!.z).toBeGreaterThan(50);
});

test('a menu that opens Settings as it closes drops away under the dialog', async ({ page }) => {
  await page.setViewportSize({ width: 1300, height: 760 });
  await portal(page);
  await page.goto('/s/a');
  await expect(page.getByText('A answer 5')).toBeVisible();
  await settled(page);
  await page.locator('.composer-settings button').first().click();
  await page.getByRole('button', { name: 'Add or change providers…' }).click();
  // Settings' own page is not drawn here: what is asked is where the menu's picture lies, over the page and under what opens.
  await page.waitForURL(/\/settings\/models$/);
  await expect.poll(async () => (await pictures(page)).filter((p) => p.text.includes('Add or change providers')).length).toBeGreaterThan(0);
  expect((await pictures(page)).find((p) => p.text.includes('Add or change providers'))!.z).toBeLessThan(50);
});

test('a conversation that is left is under the floating window that lies over it', async ({ page }) => {
  await page.setViewportSize({ width: 1300, height: 760 });
  await portal(page, { places: { 'x:test-console/console': 'float' } });
  await page.goto('/s/a');
  await expect(page.getByText('A answer 5')).toBeVisible();
  await page.getByRole('button', { name: 'Console', exact: true }).click();
  await expect(page.locator('aside[data-dock="float"]')).toBeVisible();
  await settled(page);

  await row(page, 'Second chat').click();
  await expect.poll(async () => (await pictures(page)).filter((p) => p.text.includes('A answer 5')).length).toBeGreaterThan(0);
  // The window is at 20, and stays open across the switch: what is left of the chat does not lie over it.
  const left = (await pictures(page)).find((p) => p.text.includes('A answer 5'))!;
  expect(left.z).toBeLessThan(20);
});

test('deleting a message with many rows in its turn still breaks the message itself apart', async ({ page }) => {
  await page.setViewportSize({ width: 1300, height: 1100 });
  // Ten commands answering the fourth question.
  await portal(page, { bigTurn: 10 });
  await page.goto('/s/a');
  await expect(page.getByText('A answer 5')).toBeVisible();
  await expect(page.locator('main .chat-list')).not.toHaveClass(/is-opening/);
  const message = page.locator('[data-key]', { hasText: 'A question 4' });
  await message.hover();
  await message.getByRole('button', { name: /Delete this message/ }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.getByText('A question 4')).toHaveCount(0);
  await settled(page);

  const all = await pictures(page);
  // The one that was deleted was seen, for as long as the others, and not taken off the page before it was drawn.
  const question = all.find((p) => p.text.includes('A question 4'))!;
  expect(question.lived).toBeGreaterThan(150);
  // So was the sinking of the dialog that asked.
  expect(all.find((p) => p.text.includes('Delete this message?'))!.lived).toBeGreaterThan(150);
});

test('closing the window at the back of two does not bring it in front of the other', async ({ page }) => {
  await page.setViewportSize({ width: 1300, height: 760 });
  await portal(page, { places: { 'x:test-console/console': 'float', 'x:test-viewer/viewer': 'float' } });
  await page.goto('/s/a');
  await expect(page.getByText('A answer 5')).toBeVisible();
  await page.getByRole('button', { name: 'Console', exact: true }).click();
  await page.getByRole('button', { name: 'Viewer', exact: true }).click();
  await expect(page.locator('aside[data-dock="float"]')).toHaveCount(2);
  await settled(page);
  const viewer = page.locator('aside[data-dock="float"]', { hasText: 'Viewer' });
  const z = Number(await viewer.evaluate((el) => getComputedStyle(el).zIndex));

  await page.getByRole('button', { name: 'Viewer', exact: true }).click();
  await expect(page.locator('aside[data-dock="float"]')).toHaveCount(1);
  await expect.poll(async () => (await pictures(page)).filter((p) => p.dock === 'float').length).toBeGreaterThan(0);
  const seen = (await pictures(page)).find((p) => p.dock === 'float')!;
  // At the height the window had, and before the app in the page: a window at the same height that stays is in front of it.
  expect(seen.z).toBe(z);
  expect(seen.before).toBe(true);
});

test("Settings' picture is not over a dialog that opens as it goes", async ({ page }) => {
  await portal(page);
  await page.goto('/s/a');
  await sidebar(page).getByRole('button', { name: 'Settings' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await settled(page);
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await pictures(page)).filter((p) => p.text.includes('Settings')).length).toBeGreaterThan(0);
  const seen = (await pictures(page)).find((p) => p.text.includes('Settings'))!;
  // The assistant it can open is a dialog at 50 too: that one is in front.
  expect(seen.z).toBe(50);
  expect(seen.before).toBe(true);
});

test('the chat that is picked lights up, and the open one does not each time the sidebar is shown', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await portal(page);
  await page.goto('/s/a');
  await expect(page.getByText('A answer 5')).toBeVisible();
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await row(page, 'Second chat').click();
  await expect(page).toHaveURL(/\/s\/b$/);
  // Picked: it lit up.
  await expect.poll(async () => (await played(page)).some((p) => p.on.includes('session-row') && p.keys.includes('boxShadow'))).toBe(true);
  await settled(page);

  // The drawer shown again, a while after: the open chat's row is just there.
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await expect(row(page, 'Second chat')).toBeVisible();
  // The row is just there, with no animation of its own a moment after it is shown: a check of what is still going, so it is waited for in time.
  await page.waitForTimeout(150);
  expect(await row(page, 'Second chat').evaluate((el) => el.getAnimations().length)).toBe(0);
});
