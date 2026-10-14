import { type Page } from '@playwright/test';
import { test, expect, mockPortal, reply } from './portal-mock';
import { DEFAULT_ORB } from '../../core/server/src/orb-style';

test('a tool call reads as its parameters, closed and opened, not as JSON', async ({ page }) => {
  await page.goto('/tests/chat.html?phase=args');
  const search = page.locator('.chat-tool', { hasText: 'web_search' });
  // Closed: "Queries: …", where it said {"queries":[…]}.
  await expect(search.locator('.chat-tool-detail')).toHaveText('Queries: pgvector vs qdrant 2026, homelab vector database · Num results: 5 · Include content: false');
  await search.locator('.chat-tool-head').click();
  // Opened: each parameter a label and its value, the queries a list.
  const args = search.locator('.chat-tool-args');
  await expect(args.locator('dt')).toHaveText(['Queries', 'Num results', 'Include content']);
  await expect(args.locator('.chat-arg-list li')).toHaveText(['pgvector vs qdrant 2026', 'homelab vector database']);
  await expect(args).not.toContainText('[');
  await expect(args).not.toContainText('"');

  // A list of changes: each one numbered, its fields labelled; code in a block of its own.
  const edit = page.locator('.chat-tool', { hasText: 'web/src/main.tsx' }).filter({ hasText: 'edit' });
  await edit.locator('.chat-tool-head').click();
  await expect(edit.locator('.chat-arg-items > li')).toHaveCount(2);
  await expect(edit.locator('.chat-arg-items dt').first()).toHaveText('Old text');
  await expect(edit.locator('.chat-arg-items pre.chat-tool-value')).toHaveText('render(\n  <App />\n);');
  await expect(edit.locator('.chat-tool-body')).not.toContainText('{');

  // An MCP tool that answers in JSON: its answer is read the same way.
  const mcp = page.locator('.chat-tool', { hasText: 'github_list_issues' });
  await expect(mcp.locator('.chat-tool-detail')).toHaveText('Owner: octo-org · Repo: pithagoras · State: open · Labels: bug, ui');
  await mcp.locator('.chat-tool-head').click();
  const output = mcp.locator('.chat-tool-output');
  await expect(output).toHaveClass(/is-structured/);
  await expect(output.locator('.chat-arg-items > li')).toHaveCount(2);
  await expect(output).toContainText('Jump button over the tools menu');
  await expect(output).not.toContainText('{');
});

test('Copy is under the last answer, not beside it, and only there', async ({ page }) => {
  await page.goto('/tests/chat.html?phase=args');
  const answer = page.locator('.md', { hasText: 'pgvector is enough' });
  // The agent's side of the conversation, not the messages sent, which keep theirs.
  const copy = page.locator('.group:not(.items-end)').getByRole('button', { name: 'Copy', exact: true });
  // One: the answer's, and not the paragraph before the tools.
  await expect(copy).toHaveCount(1);
  await expect(copy).toBeVisible();
  const a = (await answer.boundingBox())!;
  const c = (await copy.boundingBox())!;
  // Under the words and lined up with them, not in the margin to their right.
  expect(c.y).toBeGreaterThanOrEqual(a.y + a.height - 1);
  expect(Math.abs(c.x + 6 - a.x)).toBeLessThan(4);
});

test('the answer to an earlier question keeps its Copy when another is asked, one under each answer', async ({ page }) => {
  await page.goto('/tests/chat.html?phase=turns');
  // The agent's side only: the conversation before these two ended in tools, so it has none.
  const copy = page.locator('.group:not(.items-end)').getByRole('button', { name: 'Copy', exact: true });
  await expect(copy).toHaveCount(2);
  const first = (await page.locator('.md', { hasText: 'pgvector is enough for now.' }).boundingBox())!;
  const second = (await page.locator('.md', { hasText: 'Redis is fine for the cache.' }).boundingBox())!;
  const [a, b] = [(await copy.nth(0).boundingBox())!, (await copy.nth(1).boundingBox())!];
  // Each under its own answer, not both under the last.
  expect(a.y).toBeGreaterThanOrEqual(first.y + first.height - 1);
  expect(a.y).toBeLessThan(second.y);
  expect(b.y).toBeGreaterThanOrEqual(second.y + second.height - 1);
});

test('the way back to the end steps aside for a menu opened from the composer', async ({ page }) => {
  await page.goto('/tests/chat.html?phase=args');
  for (const name of ['web_search', 'github_list_issues']) await page.locator('.chat-tool-head', { hasText: name }).click();
  await page.mouse.move(500, 400);
  await page.mouse.wheel(0, -4000);
  const jump = page.getByRole('button', { name: 'Jump to the end' });
  await expect(jump).toBeVisible();
  await page.getByTitle('Which tools this conversation may use').click();
  await expect(page.getByText('Tools in this chat')).toBeVisible();
  // It floated over the menu, in the middle of the list of tools.
  await expect(jump).toBeHidden();
  await page.keyboard.press('Escape');
  await expect(page.getByText('Tools in this chat')).toBeHidden();
  await expect(jump).toBeVisible();
});

const streamHeight = (page: Page) => page.locator('.chat-thinking-stream').evaluate((e) => e.getBoundingClientRect().height);

test('a few words of thinking take a line, not three; more fills it and it does not shrink back', async ({ page }) => {
  await page.goto('/tests/chat.html?phase=brief');
  const line = await page.locator('.chat-thinking-stream').evaluate((e) => parseFloat(getComputedStyle(e).lineHeight));
  await expect(page.locator('.chat-thinking-stream')).toHaveText('Short one.');
  // It was three lines high whatever it held: two empty ones between the heading and the words.
  expect(await streamHeight(page)).toBeLessThan(line * 1.5);
  await expect(page.locator('.chat-thinking-stream')).not.toHaveClass(/is-clipped/);

  // A fast model: many small pieces. Measured after each, it only ever grows, to three lines.
  const heights = await page.evaluate(async () => {
    const seen: number[] = [];
    const el = () => document.querySelector('.chat-thinking-stream')!;
    const words = 'the regex expects the status at the very end\nso I should check how pi appends it and whether two newlines come first '.repeat(6).split(' ');
    for (const w of words) {
      (window as any).think(' ' + w);
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      seen.push(parseFloat((el() as HTMLElement).style.height) || el().getBoundingClientRect().height);
    }
    return seen;
  });
  for (let i = 1; i < heights.length; i++) expect(heights[i]).toBeGreaterThanOrEqual(heights[i - 1]);
  expect(heights.at(-1)).toBeCloseTo(line * 3, 0);
  await expect(page.locator('.chat-thinking-stream')).toHaveClass(/is-clipped/);
});

const animation = (el: Element, pseudo?: string) => getComputedStyle(el, pseudo).animationName;

test('a working chat shows the π mark and a shimmering word in the composer, and its title shimmers', async ({ page }) => {
  await page.goto('/tests/chat.html?phase=tools');
  const working = page.locator('.composer-working');
  await expect(working).toBeVisible();
  // The app's π, breathing in a glow — not the pulsing yellow dot, nor a spinner.
  const mark = working.locator('.status-working');
  await expect(mark).toHaveText('π');
  expect(await mark.evaluate(animation, '::before')).toBe('chat-halo');
  expect(await mark.locator('span').evaluate(animation)).toBe('working-breathe');
  await expect(page.locator('.composer-settings .animate-pulse')).toHaveCount(0);
  // "Working" shimmers the way "Thinking" does, and so does the chat's title.
  expect(await working.getByText('Working').evaluate(animation)).toBe('chat-shimmer');
  expect(await page.getByRole('button', { name: 'Fix the build' }).evaluate(animation)).toBe('chat-shimmer');
  // Idle: none of it.
  await page.goto('/tests/chat.html?phase=args');
  await expect(page.locator('.composer-settings')).toBeVisible();
  await expect(page.locator('.composer-working, .composer-settings .status-working')).toHaveCount(0);
  expect(await page.getByRole('button', { name: 'Fix the build' }).evaluate(animation)).toBe('none');
});

test('a working chat in the sidebar has the π mark and a shimmering title', async ({ page }) => {
  const session = { id: 's1', title: 'Busy chat', workspace: '/w/site', status: 'running', kind: 'task', pinned: false, updated_at: new Date().toISOString() };
  const idle = { ...session, id: 's2', title: 'Quiet chat', status: 'idle' };
  await mockPortal(page, async ({ path: p }) => {
    if (p === '/api/sessions') return { sessions: [session, idle], executor: 'host' };
  }, { settings: true });
  await page.goto('/');
  const sidebar = page.getByRole('complementary', { name: 'Sidebar' });
  const busyTitle = sidebar.getByText('Busy chat');
  const mark = busyTitle.locator('..').locator('.status-working');
  await expect(mark).toHaveText('π');
  expect(await mark.evaluate(animation, '::before')).toBe('chat-halo');
  expect(await busyTitle.evaluate(animation)).toBe('chat-shimmer');
  // The idle one: a still dot and a still title.
  const quietTitle = sidebar.getByText('Quiet chat');
  await expect(quietTitle.locator('..').locator('.status-dot')).toBeVisible();
  expect(await quietTitle.evaluate(animation)).toBe('none');
  // Every mark has the same slot: the titles beside a working and an idle chat line up.
  const q = (await quietTitle.boundingBox())!;
  const b = (await busyTitle.boundingBox())!;
  expect(Math.abs(q.x - b.x)).toBeLessThan(0.5);
});

test('parameters keep their numbers and their spaces, and an id too long for a number is not rewritten', async ({ page }) => {
  await page.goto('/tests/chat.html?phase=args');
  const call = page.locator('.chat-tool', { hasText: 'configure' });
  await call.locator('.chat-tool-head').click();
  const value = (label: string) => call.locator('.chat-tool-args > div', { has: page.locator('dt', { hasText: label }) }).locator('dd');
  // They read "8,080" and "0".
  await expect(value('Port')).toHaveText('8080');
  await expect(value('Threshold')).toHaveText('0.0001');
  // Drawn, not only in the page: the indent to replace was dropped from sight.
  expect(await value('Old string').evaluate((e) => (e as HTMLElement).innerText)).toBe('    return x;');
  // Read as JSON it came out as 12345678901234567000: shown as the text it was.
  const output = call.locator('.chat-tool-output');
  await expect(output).not.toHaveClass(/is-structured/);
  await expect(output).toContainText('12345678901234567890');
  // Nor a decimal longer than a number holds: read as JSON it was shown rounded.
  const ledger = page.locator('.chat-tool', { hasText: 'ledger' });
  await ledger.locator('.chat-tool-head').click();
  await expect(ledger.locator('.chat-tool-output')).not.toHaveClass(/is-structured/);
  await expect(ledger.locator('.chat-tool-output')).toContainText('0.123456789012345678901');
});

test('an agent conversation keeps its title in place when it starts working', async ({ page }) => {
  const at = new Date().toISOString();
  const row = (id: string, title: string, status: string) => ({ id, title, status, workspace: '/a', kind: 'agent', pinned: false, updated_at: at, channel_key: `tg:${id}`, channel: null });
  await mockPortal(page, async ({ path: p }) => {
    if (p === '/api/agents') return { agents: [{ id: 'home', name: 'Nova', home: '/a', first: true, initialised: true, chats: 2, channels: [], orb: DEFAULT_ORB, voice: '' }] };
    if (p === '/api/agent/sessions') return { sessions: [row('x', 'Working agent chat', 'running'), row('y', 'Resting agent chat', 'idle')], agentHome: '/a' };
    if (p === '/api/agents/home/setup') return { initialised: true, home: '/a', files: [] };
  }, { settings: true });
  // The agent's own page, opened from its card.
  await page.goto('/agents?agent=home');
  const main = page.getByRole('main');
  const busy = (await main.getByText('Working agent chat').boundingBox())!;
  const idle = (await main.getByText('Resting agent chat').boundingBox())!;
  // The π is twice a dot's width, and without its slot pushed the title along.
  expect(Math.abs(busy.x - idle.x)).toBeLessThan(0.5);
  await expect(main.locator('.status-slot > .status-working')).toHaveCount(1);
});

test('the agent setup shows its steps as the assistant does, Back before Create, and nothing to change while Create runs', async ({ page }) => {
  await mockPortal(page, async ({ path: p, method }) => {
    if (p === '/api/agents') return { agents: [{ id: 'home', name: 'Agent', home: '/a', first: true, initialised: false, chats: 0, channels: [], orb: DEFAULT_ORB, voice: '' }] };
    if (p === '/api/agent/sessions') return { sessions: [], agentHome: '/a' };
    if (p === '/api/agents/home/setup' && method === 'POST') {
      await new Promise((r) => setTimeout(r, 400));
      return reply(409, { error: `That name is taken: /home/user/.pi/agent/${'deeply_nested_directory_'.repeat(5)}/SOUL.md` });
    }
    if (p === '/api/agents/home/setup') return { initialised: false, home: '/a', files: [] };
  }, { settings: true });
  await page.setViewportSize({ width: 390, height: 900 });
  // An agent that is not set up yet opens on its setup.
  await page.goto('/agents?agent=home');
  const main = page.getByRole('main');
  const current = main.locator('.setup-step[aria-current="step"]');
  await expect(current).toHaveText('1. Who it is');
  await expect(main.getByText('Step 1 of 2')).toHaveClass(/sr-only/);
  await expect(main.getByRole('button', { name: 'Back' })).toHaveCount(0);
  await main.getByLabel('Name').fill('Nova');
  await main.getByRole('button', { name: 'Next' }).click();
  await expect(current).toHaveText('2. Who it works for');
  // Back where it is in the assistant: at the left, the way forward at the right.
  const back = (await main.getByRole('button', { name: 'Back' }).boundingBox())!;
  const create = (await main.getByRole('button', { name: 'Create' }).boundingBox())!;
  expect(create.x - (back.x + back.width)).toBeGreaterThan(100);
  // Enter on the last field creates, as it moves on from the first. While it
  // runs nothing changes: an edit would miss what is sent, and going back
  // would leave its failure on a step that does not show it.
  await main.getByLabel('Your name').fill('Sam');
  await main.getByLabel('Your name').press('Enter');
  await expect(main.getByRole('button', { name: 'Back' })).toBeDisabled();
  await expect(main.getByLabel('About you')).toBeDisabled();
  await expect(main.getByRole('alert')).toContainText('That name is taken');
  await expect(main.getByLabel('About you')).toBeEnabled();
  // The focus Create took is given back, where the name is fixed.
  await expect(main.getByLabel('Your name')).toBeFocused();
  // A long word in the error does not widen the form past the phone.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const form = (await main.getByRole('group', { name: 'Who it works for' }).boundingBox())!;
  expect(form.x + form.width).toBeLessThanOrEqual(390);
  await main.getByRole('button', { name: 'Back' }).click();
  await expect(current).toHaveText('1. Who it is');
  await expect(main.getByLabel('Name')).toHaveValue('Nova');
  // Back again, the failure is not shown for a Create not yet sent.
  await main.getByRole('button', { name: 'Next' }).click();
  await expect(current).toHaveText('2. Who it works for');
  await expect(main.getByRole('alert')).toHaveCount(0);
});

test('the composer stops following the pointer when the drag is lost without a let-go', async ({ page }) => {
  await page.goto('/tests/chat.html?phase=args');
  const grip = page.getByRole('slider', { name: 'Resize message composer vertically' }).or(page.getByLabel('Resize message composer vertically'));
  const g = (await grip.first().boundingBox())!;
  await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
  await page.mouse.down();
  await page.mouse.move(g.x + g.width / 2, g.y - 40, { steps: 4 });
  // The capture lost with no pointerup — the page took it, or the grip went away.
  await grip.first().evaluate((e) => e.dispatchEvent(new PointerEvent('lostpointercapture', { pointerId: 1, bubbles: true })));
  const box = page.getByLabel('Message', { exact: true });
  const height = (await box.boundingBox())!.height;
  // It went on growing with the pointer until the next click.
  await page.mouse.move(g.x + g.width / 2, g.y - 160, { steps: 4 });
  expect((await box.boundingBox())!.height).toBeCloseTo(height, 0);
  await page.mouse.up();
});

test('a finished reply says how fast it was written and read, and the tokens in and out, beside its Copy', async ({ page }) => {
  await page.goto('/tests/chat.html?phase=stats');
  const line = page.getByText('35.9 t/s · prefill 544 t/s · 12,467 in · 41 out');
  await expect(line).toBeVisible();
  const details = await line.getAttribute('title');
  expect(details).toContain('Prompt: 12,467 tokens');
  expect(details).toContain('1,203 read in 2.21 s');
  expect(details).toContain('11,264 of them from the cache');
  expect(details).toContain('Answer: 41 tokens, written in 1.14 s');
  expect(details).toContain('Draft: 22 of 30 tokens kept');
  await line.scrollIntoViewIfNeeded();
});
