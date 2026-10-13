import { type Page } from '@playwright/test';
import { test, expect, mockPortal, reply, DONE, HANG } from './portal-mock';

const tree = {
  name: '/', path: '/', kind: 'directory', children: [
    { name: 'deployment', path: '/deployment', kind: 'directory', children: [
      { name: 'branches.md', path: '/deployment/branches.md', kind: 'concept', type: 'Deployment Process', title: 'Branch Deployment on Test Host', description: 'The test host deploys branches using deploy-branch.sh.' },
      { name: 'index.md', path: '/deployment/index.md', kind: 'reserved' },
    ] },
    { name: 'people', path: '/people', kind: 'directory', children: [
      { name: 'owner.md', path: '/people/owner.md', kind: 'concept', type: 'Person', title: 'The owner' },
    ] },
    { name: 'index.md', path: '/index.md', kind: 'reserved' },
    { name: 'log.md', path: '/log.md', kind: 'reserved' },
  ],
};
const concepts: Record<string, unknown> = {
  '/deployment/branches.md': {
    path: '/deployment/branches.md',
    frontmatter: { type: 'Deployment Process', title: 'Branch Deployment on Test Host', description: 'The test host deploys branches using deploy-branch.sh.', tags: ['deployment', 'test-host'], timestamp: '2026-09-28T09:17:59.631Z' },
    body: '## Overview\n\nBranches go out with `deploy-branch.sh`. Asked for by [the owner](../people/owner.md); see also [the docs](https://example.com/docs).',
  },
  '/people/owner.md': { path: '/people/owner.md', frontmatter: { title: 'The owner', type: 'Person' }, body: 'Runs the test host.' },
  '/index.md': { path: '/index.md', frontmatter: {}, body: '# Knowledge Base\n\n* [deployment](deployment/) - 1 concept' },
  '/deployment/index.md': { path: '/deployment/index.md', frontmatter: {}, body: '# deployment\n\n* [Branch Deployment](branches.md)' },
};

/** The portal with Understory as the memory, or not, over canned answers. */
const healthy = { healthy: true, orphans: [], brokenLinks: [], issues: [] };
const broken1 = { healthy: false, orphans: [], brokenLinks: [{ path: '/deployment/branches.md', target: '/people/owner.md' }], issues: [] };

async function portal(page: Page, { enabled = true, broken = false, conformant = true, writable = true, afterDelete = broken1 as any, notes = 0, longNames = false, librarian = [] as (string | typeof HANG)[] } = {}) {
  const asked: string[] = [];
  // What the librarian is asked, and what it answers (a stream, per question, in order).
  const chats: any[][] = [];
  const changes: { method: string; path: string; body?: any }[] = [];
  let logCleared = false;
  let wiped = false;
  await mockPortal(page, async (ask) => {
    const { path: p, method, url, json } = ask;
    if (p === '/api/features/flags') return { subagent: { enabled: false }, understory: { enabled } };
    if (p === '/api/features') return { subagent: {}, understory: { enabled, url: 'http://127.0.0.1:3800/mcp', managed: { available: true, container: 'running', config: { llm: { source: 'auto' }, dreamInterval: '' }, providers: [], pulling: { active: false }, lastDream: { at: '2026-09-28T14:00:00Z', ok: true, ran: true, said: '1 file changed — mended the link' } } } };
    if (p === '/api/memory/health') return writable ? { writable: true, health: healthy } : { writable: false };
    if (p === '/api/memory/chat' && method === 'POST') {
      chats.push(json().messages);
      const answer = librarian[chats.length - 1];
      if (answer === HANG) return HANG;
      await ask.route.fulfill({ status: 200, contentType: 'text/event-stream', body: answer ?? '' });
      return DONE;
    }
    if (p === '/api/memory/concept' && method === 'PUT') {
      const sent = json();
      changes.push({ method: 'PUT', path: sent.path, body: sent });
      const stamped = { ...sent.frontmatter, timestamp: '2026-09-28T14:00:00.000Z' };
      // As Understory has it: the write answers the text as it was sent, and the file it made ends in a newline, which every read then shows.
      concepts[sent.path] = { path: sent.path, frontmatter: stamped, body: sent.body.endsWith('\n') ? sent.body : `${sent.body}\n` };
      return { concept: { path: sent.path, frontmatter: stamped, body: sent.body }, health: healthy };
    }
    if (p === '/api/memory/concept' && method === 'DELETE') {
      changes.push({ method: 'DELETE', path: url.searchParams.get('path')! });
      return { health: afterDelete };
    }
    if (p === '/api/memory/reindex') {
      changes.push({ method: 'POST', path: p });
      return { pruned: ['/empty'], reindexed: 3, health: { ...broken1 } };
    }
    if (p === '/api/memory/repair') {
      changes.push({ method: 'POST', path: p });
      return { ran: true, summary: '**Fixed** the link from [branches](/deployment/branches.md).\n\n## What changed\n\n- removed the dangling link', filesChanged: ['/deployment/branches.md'], health: healthy };
    }
    if (p === '/api/memory/wipe') {
      changes.push({ method: 'POST', path: p });
      wiped = true;
      logCleared = true;
      return { health: healthy };
    }
    if (p === '/api/memory/clear-log') {
      changes.push({ method: 'POST', path: p });
      logCleared = true;
      return { health: healthy };
    }
    if (p.startsWith('/api/memory/')) {
      asked.push(`${p}${url.search}`);
      if (broken) return reply(502, { error: 'Could not reach Understory at http://127.0.0.1:3800: it did not answer in time.' });
      if (p === '/api/memory/tree') return wiped ? { name: '/', path: '/', kind: 'directory', children: [{ name: 'index.md', path: '/index.md', kind: 'reserved' }, { name: 'log.md', path: '/log.md', kind: 'reserved' }] } : tree;
      if (p === '/api/memory/validate') return conformant ? { conformant: true, conceptCount: 2, directoryCount: 2, issues: [] } : { conformant: false, conceptCount: 2, directoryCount: 2, issues: [{ path: '/people/owner.md', severity: 'warning', message: 'No description in its frontmatter' }] };
      // Newest first, as Understory keeps it.
      if (p === '/api/memory/log') return logCleared ? [] : [
        { date: '2026-09-28', action: 'Update', summary: 'Linked [Branch Deployment on Test Host](/deployment/branches.md) to its owner.' },
        { date: '2026-09-27', action: 'Creation', summary: 'Added [The owner](/people/owner.md).' },
      ];
      if (p === '/api/memory/graph' && notes) return {
        // A long memory: every note linked to the one before, and to one a few places back.
        nodes: Array.from({ length: notes }, (_, i) => ({ path: `/n${i}.md`, title: longNames ? `How the release of branch ${i} goes out to the test host` : `Note ${i}`, type: i % 3 ? 'Person' : 'Deployment Process', links: 2 })),
        edges: Array.from({ length: notes - 1 }, (_, i) => ({ source: `/n${i}.md`, target: `/n${i + 1}.md` })).concat(Array.from({ length: Math.floor(notes / 7) }, (_, i) => ({ source: `/n${i * 7}.md`, target: `/n${(i * 7 + 5) % notes}.md` }))),
      };
      if (p === '/api/memory/graph') return {
        nodes: [
          { path: '/deployment/branches.md', title: 'Branch Deployment on Test Host', type: 'Deployment Process', description: 'The test host deploys branches using deploy-branch.sh.', links: 1 },
          { path: '/people/owner.md', title: 'The owner', type: 'Person', links: 1 },
          { path: '/loose.md', title: 'A loose note', links: 0 },
        ],
        edges: [{ source: '/deployment/branches.md', target: '/people/owner.md' }],
      };
      if (p === '/api/memory/traces') return [{ id: 't1', kind: 'mutation', input: 'Persist the following knowledge', startedAt: '2026-09-28T09:17:47Z', notation: 'browse layout → write branches.md → ✓', usage: { inputTokens: 9683, outputTokens: 2000 } }];
      if (p === '/api/memory/search') return url.searchParams.get('q') === 'deploy' ? [{ path: '/deployment/branches.md', title: 'Branch Deployment on Test Host', description: 'The test host deploys branches.' }] : [];
      if (p === '/api/memory/concept') {
        const c = concepts[url.searchParams.get('path') ?? ''];
        if (!c) return reply(404, { error: 'Concept not found' });
        return c;
      }
    }
  }, { settings: true });
  return { asked, changes, chats };
}

const notes = (page: Page) => page.getByRole('navigation', { name: 'Notes' });

test('the sidebar has Memory only while Understory is the memory', async ({ page }) => {
  await portal(page, { enabled: false });
  await page.goto('/sessions');
  await expect(page.getByRole('button', { name: 'Sessions' }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Memory' })).toHaveCount(0);
});

test("Memory in the sidebar opens the tree, with each note's type and Understory's own files set apart", async ({ page }) => {
  const { asked } = await portal(page);
  await page.goto('/sessions');
  await page.getByRole('button', { name: 'Memory' }).first().click();
  await expect(page).toHaveURL(/\/memory$/);
  await expect(notes(page).getByRole('button', { name: /Branch Deployment on Test Host/ })).toContainText('Deployment Process');
  await expect(notes(page).getByRole('button', { name: /deployment\// })).toHaveAttribute('aria-expanded', 'true');
  await expect(notes(page).getByRole('button', { name: 'log.md' }).locator('span.italic')).toBeVisible();
  await expect(page.getByRole('button', { name: 'conformant' })).toBeVisible();
  await expect(page.getByText('2 notes in 2 folders')).toBeVisible();
  // A folder shuts.
  await notes(page).getByRole('button', { name: /people\// }).click();
  await expect(notes(page).getByRole('button', { name: /The owner/ })).toHaveCount(0);
  // Nothing here writes.
  expect(asked.every((a) => /^\/api\/memory\/(tree|log|concept|search|graph|traces|validate)/.test(a))).toBe(true);
});

test('a note opens with its type, tags and time; its links open other notes, and Back returns', async ({ page }) => {
  await portal(page);
  await page.goto('/memory');
  await notes(page).getByRole('button', { name: /Branch Deployment on Test Host/ }).click();
  await expect(page).toHaveURL(/note=%2Fdeployment%2Fbranches\.md/);
  const note = page.getByRole('article', { name: 'Branch Deployment on Test Host' });
  await expect(note.getByText('#test-host')).toBeVisible();
  await expect(note.getByRole('heading', { name: 'Overview' })).toBeVisible();
  await expect(note.getByRole('link', { name: 'the docs' })).toHaveAttribute('target', '_blank');
  await note.getByRole('link', { name: 'the owner' }).click();
  await expect(page.getByRole('article', { name: 'The owner' })).toContainText('Runs the test host.');
  await page.goBack();
  await expect(page.getByRole('article', { name: 'Branch Deployment on Test Host' })).toBeVisible();
  // Understory's index, and a folder's link in it to that folder's index.
  await notes(page).getByRole('button', { name: 'index.md' }).last().click();
  await page.getByRole('article', { name: 'index.md' }).getByRole('link', { name: 'deployment' }).click();
  await expect(page).toHaveURL(/note=%2Fdeployment%2Findex\.md/);
});

test('the log lists the changes newest first, and its links open the notes', async ({ page }) => {
  await portal(page);
  await page.goto('/memory');
  await page.getByRole('button', { name: 'Log', exact: true }).click();
  await expect(page).toHaveURL(/view=log/);
  const log = page.getByRole('region', { name: 'Changes to the memory' });
  await expect(log.locator('li').first()).toContainText('2026-09-28');
  await expect(log.locator('li').first()).toContainText('Update');
  await log.getByRole('link', { name: 'The owner' }).click();
  await expect(page.getByRole('article', { name: 'The owner' })).toBeVisible();
});

test('the graph draws the notes and their links, says what the colours are, and a note opens from it', async ({ page }) => {
  await portal(page);
  await page.goto('/memory?view=graph');
  // A group and not a picture: its notes are buttons that Tab reaches, which a picture would make presentational.
  const graph = page.getByRole('group', { name: /3 notes, 1 link/ });
  await expect(graph).toBeVisible();
  await expect(page.getByRole('img', { name: /3 notes, 1 link/ })).toHaveCount(0);
  await expect(graph.locator('line')).toHaveCount(1);
  // A small memory glows and moves: a halo behind each note, a gradient orb, links with a current.
  await expect(graph.locator('.mg-rich')).toHaveCount(1);
  await expect(graph.locator('circle.mg-halo')).toHaveCount(3);
  await expect(graph.locator('circle.mg-orb').first()).toHaveAttribute('fill', /url\(#mg-orb-/);
  expect(await graph.locator('line').evaluate((el) => getComputedStyle(el).animationName)).toBe('mg-flow');
  const legend = page.getByRole('list', { name: 'What the colours are' });
  await expect(legend).toContainText('Deployment Process');
  await expect(legend).toContainText('orphan (unlinked)');
  await page.getByText('Query paths').click();
  await expect(page.getByText('9.7k→2k tok')).toBeVisible();
  const before = (await graph.getAttribute('viewBox'))!;
  // The view glides there, and ends exactly where it was sent.
  await page.getByRole('button', { name: 'Zoom in' }).click();
  await expect(graph).not.toHaveAttribute('viewBox', before);
  await page.getByRole('button', { name: 'Show all of it' }).click();
  await expect(graph).toHaveAttribute('viewBox', before);
  await graph.getByRole('button', { name: 'The owner' }).click();
  await expect(page.getByRole('article', { name: 'The owner' })).toBeVisible();
});

test('a graph of a long memory opens without freezing the page, and panning it is not drawing every note again', async ({ page }) => {
  await portal(page, { notes: 1500 });
  await page.addInitScript(() => {
    (window as any).longest = 0;
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) (window as any).longest = Math.max((window as any).longest, e.duration);
    }).observe({ entryTypes: ['longtask'] });
  });
  await page.goto('/memory?view=graph');
  const graph = page.getByRole('group', { name: /1,?500 notes/ });
  await expect(graph).toBeVisible({ timeout: 30_000 });
  // The layout of 1,500 notes was several seconds in one piece; it is a fraction of one.
  expect(await page.evaluate(() => (window as any).longest)).toBeLessThan(1500);
  // A graph this long is drawn plainly: no halos and no animation per note.
  await expect(graph.locator('.mg-rich')).toHaveCount(0);
  await expect(graph.locator('circle.mg-halo')).toHaveCount(0);

  const box = (await graph.boundingBox())!;
  const from = { x: box.x + box.width - 5, y: box.y + box.height - 5 };
  const sweep = async () => {
    const started = Date.now();
    await page.mouse.move(from.x - 100, from.y - 100, { steps: 60 });
    await page.mouse.move(from.x, from.y);
    return Date.now() - started;
  };
  // The same moves with the button up, which move nothing, are what the mouse itself costs.
  await page.mouse.move(from.x, from.y);
  const idle = await sweep();
  await page.mouse.down();
  const panning = await sweep();
  await page.mouse.up();
  // Drawing 1,500 notes again for each of those moves was two seconds more.
  expect(panning - idle).toBeLessThan(900);
});

/** The boxes of the labels the flat graph shows, on the screen: the layer of all of them, not the copies drawn over a note in focus. */
const labelBoxes = (page: Page) =>
  page.locator('.memory-graph > svg').evaluate((svg) =>
    [...svg.querySelectorAll('text')].filter((el) => !el.closest('.mg-focus, .mg-found-layer')).map((el) => {
      const r = el.getBoundingClientRect();
      return { text: el.textContent ?? '', x0: r.left, y0: r.top, x1: r.right, y1: r.bottom };
    }),
  );
const overlapping = (boxes: { text: string; x0: number; y0: number; x1: number; y1: number }[]) => {
  const found: string[] = [];
  for (let i = 0; i < boxes.length; i++)
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i];
      const b = boxes[j];
      // Half a pixel either way is rounding, not two labels on each other.
      if (a.x0 < b.x1 - 0.5 && b.x0 < a.x1 - 0.5 && a.y0 < b.y1 - 0.5 && b.y0 < a.y1 - 0.5) found.push(`${a.text} / ${b.text}`);
    }
  return found;
};

for (const [width, height] of [[1280, 800], [390, 800]]) {
  test(`labels in the flat graph never lie on each other, with many notes and long names, ${width} wide`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await portal(page, { notes: 140, longNames: true });
    await page.goto('/memory?view=graph');
    const graph = page.getByRole('group', { name: /140 notes/ });
    await expect(graph).toBeVisible();
    // A phone has room for only a few names of so many at once; zooming in shows more.
    await expect.poll(async () => (await labelBoxes(page)).length).toBeGreaterThan(width < 600 ? 2 : 5);
    // Placed again for the scale the view settles at.
    await page.waitForTimeout(400);
    let boxes = await labelBoxes(page);
    expect(overlapping(boxes)).toEqual([]);
    // Cut short, the whole title is in the card.
    expect(boxes.every((b) => b.text.length <= 30)).toBe(true);
    // Zoomed in, more of them have room, and still none lies on another.
    const box = (await graph.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    for (let i = 0; i < 6; i++) await page.mouse.wheel(0, -100);
    await page.waitForTimeout(500);
    const closer = await labelBoxes(page);
    expect(overlapping(closer)).toEqual([]);
    expect(closer.length).toBeGreaterThan(boxes.length);
    boxes = closer;
    // Nor does the legend or the line under the graph: they are beside it, not on it.
    const svgBox = (await graph.boundingBox())!;
    for (const strip of [page.getByRole('list', { name: 'What the colours are' }), page.getByText('— drag to move')]) {
      if (!(await strip.isVisible())) continue;
      const s = (await strip.boundingBox())!;
      expect(s.y + s.height <= svgBox.y + 0.5 || s.y >= svgBox.y + svgBox.height - 0.5).toBe(true);
    }
  });
}

test('pointing at a note lights it and the notes it links with, and a card says what it is', async ({ page }) => {
  await portal(page);
  await page.goto('/memory?view=graph');
  const graph = page.getByRole('group', { name: /3 notes, 1 link/ });
  await expect(graph.locator('.mg-focus')).toHaveCount(0);
  await graph.getByRole('button', { name: 'Branch Deployment on Test Host' }).hover();
  await expect(graph).toHaveClass(/mg-dim/);
  // The note and the one it links with, and the link between them, drawn again over the rest.
  await expect(graph.locator('.mg-focus .mg-lit')).toHaveCount(2);
  await expect(graph.locator('.mg-focus line.mg-hot')).toHaveCount(1);
  await expect(page.getByText('The test host deploys branches using deploy-branch.sh.')).toBeVisible();
  await expect(page.getByText('Click to open', { exact: true })).toBeVisible();
  await page.mouse.move(5, 5);
  await expect(graph.locator('.mg-focus')).toHaveCount(0);
  await expect(page.getByText('Click to open', { exact: true })).toHaveCount(0);
  // Tab reaches a note the same way.
  await graph.getByRole('button', { name: 'The owner' }).focus();
  await expect(graph.locator('.mg-focus .mg-lit')).toHaveCount(2);
});

test('the note last opened is ringed and in the middle when the graph is back, until the background is clicked', async ({ page }) => {
  await portal(page);
  await page.goto('/memory?view=graph');
  const graph = page.getByRole('group', { name: /3 notes, 1 link/ });
  const fit = (await graph.getAttribute('viewBox'))!;
  await graph.getByRole('button', { name: 'The owner' }).click();
  await expect(page.getByRole('article', { name: 'The owner' })).toBeVisible();
  await page.goBack();
  await expect(graph.locator('circle.mg-selected')).toHaveCount(1);
  await expect(graph).toHaveClass(/mg-dim/);
  // Glided to it: the middle of the view is the note.
  await expect(graph).not.toHaveAttribute('viewBox', fit);
  await expect.poll(async () => {
    const [x, y, w, h] = (await graph.getAttribute('viewBox'))!.split(' ').map(Number);
    const ring = graph.locator('circle.mg-selected');
    const cx = Number(await ring.getAttribute('cx'));
    const cy = Number(await ring.getAttribute('cy'));
    return Math.round(Math.hypot(x + w / 2 - cx, y + h / 2 - cy));
  }).toBe(0);
  const box = (await graph.boundingBox())!;
  await page.mouse.click(box.x + 8, box.y + 8);
  await expect(graph.locator('circle.mg-selected')).toHaveCount(0);
  await expect(graph).not.toHaveClass(/mg-dim/);
});

test('the type switches filter both views, and what the search found is lit in both', async ({ page }) => {
  await portal(page);
  await page.goto('/memory?view=graph');
  const legend = page.getByRole('list', { name: 'What the colours are' });
  await legend.getByRole('button', { name: 'Person' }).click();
  await expect(legend.getByRole('button', { name: 'Person' })).toHaveAttribute('aria-pressed', 'false');
  let graph = page.getByRole('group', { name: /2 notes, 0 links/ });
  await expect(graph.getByRole('button', { name: 'The owner' })).toHaveCount(0);
  await expect(page.getByText('(1 hidden)')).toBeVisible();

  await page.getByRole('button', { name: '3D' }).click();
  graph = page.getByRole('group', { name: /2 notes, 0 links/ });
  await expect(graph.locator('canvas')).toBeVisible();
  await expect(graph.getByRole('button', { name: 'Branch Deployment on Test Host' })).toHaveCount(1);
  await expect(graph.getByRole('button', { name: 'The owner' })).toHaveCount(0);
  // The same switches, out of the way of the picture.
  await page.getByLabel('Which notes are shown').click();
  await page.getByRole('list', { name: 'What the colours are' }).getByRole('button', { name: 'Person' }).click();
  graph = page.getByRole('group', { name: /3 notes, 1 link/ });
  await expect(graph.getByRole('button', { name: 'The owner' })).toHaveCount(1);

  await page.getByLabel('Search the memory').fill('deploy');
  await expect(graph.getByRole('button', { name: 'Branch Deployment on Test Host' })).toHaveAccessibleDescription('Matches the search');
  await expect(graph.getByRole('button', { name: 'The owner' })).not.toHaveAccessibleDescription('Matches the search');
  await page.getByRole('button', { name: '2D' }).click();
  await expect(page.getByText('1 note matches “deploy”')).toBeVisible();
  await expect(page.locator('.memory-graph circle.mg-found')).toHaveCount(1);
});

/** The 3D looks by the names the menu gives them. */
const LOOK_NAMES: Record<string, string> = { stellar: 'Constellation', galaxy: 'Galaxy', brain: 'Brain', fireflies: 'Fireflies', helix: 'Double helix' };
/** Picks a 3D look from the toolbar's menu, as a person does. */
async function chooseLook(page: Page, theme: string) {
  await page.getByRole('combobox', { name: 'Look of the 3D view' }).click();
  await page.getByRole('listbox', { name: 'Look of the 3D view' }).getByRole('option', { name: LOOK_NAMES[theme], exact: true }).click();
  await expect(page.locator('.memory-sky')).toHaveAttribute('data-theme-3d', theme);
}

test("the 3D toolbar's look, colour and filter are the portal's own controls", async ({ page }) => {
  await portal(page);
  await page.goto('/memory?view=graph');
  await page.getByRole('button', { name: '3D' }).click();
  // The look: the portal's dropdown, not the system's.
  const look = page.getByRole('combobox', { name: 'Look of the 3D view' });
  await expect(look).toHaveClass(/ui-select/);
  await look.click();
  const list = page.getByRole('listbox', { name: 'Look of the 3D view' });
  await expect(list.getByRole('option')).toHaveText(['Constellation', 'Galaxy', 'Brain', 'Fireflies', 'Double helix']);
  await expect(list.getByRole('option', { name: 'Constellation' })).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(look).toHaveText('Brain');
  // The colour: a button like the dropdown beside it, with a popover of the portal's own.
  const colour = page.getByRole('button', { name: "Colour of the brain's outline" });
  await expect(colour).toHaveClass(/ui-select/);
  await colour.click();
  await expect(page.getByRole('dialog', { name: "Colour of the brain's outline" })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: "Colour of the brain's outline" })).toHaveCount(0);
  // The filter: a button like the others, with a popover that shuts on Escape and on a press outside it.
  const filter = page.getByRole('button', { name: 'Which notes are shown' });
  await expect(filter).toHaveClass(/ui-select/);
  await filter.click();
  await expect(filter).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('list', { name: 'What the colours are' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('list', { name: 'What the colours are' })).toHaveCount(0);
  await expect(filter).toBeFocused();
  await filter.click();
  await page.mouse.click(10, 400);
  await expect(page.getByRole('list', { name: 'What the colours are' })).toHaveCount(0);
});

test('notes in the flat graph are small stars that stay the same size on the screen as it zooms, as the labels do', async ({ page }) => {
  await portal(page, { notes: 140, longNames: true });
  await page.goto('/memory?view=graph');
  const graph = page.getByRole('group', { name: /140 notes/ });
  await expect(graph).toBeVisible();
  const sizes = () =>
    graph.evaluate((svg) => {
      const notes = [...svg.querySelectorAll(':scope > .mg-base [data-note]')];
      const orbs = notes.map((n) => n.querySelector('circle.mg-orb')!.getBoundingClientRect().width);
      // A star, not a blob: fine spikes reaching well past a small bright core.
      const stars = notes.map((n) => (n.querySelector('path.mg-spark') as SVGGraphicsElement | null)?.getBBox());
      // Measured without the twinkle, which turns and swells each star a little.
      const vb = (svg as SVGSVGElement).viewBox.baseVal;
      const px = Math.min(svg.clientWidth / vb.width, svg.clientHeight / vb.height);
      const spikes = stars.map((b) => (b ? b.width * px : 0));
      const labels = [...svg.querySelectorAll(':scope > g.mg-labels text')].map((t) => t.getBoundingClientRect().height);
      return { orb: Math.max(...orbs), star: Math.max(...spikes), stars: stars.filter(Boolean).length, all: notes.length, label: labels.length ? Math.max(...labels) : 0 };
    });
  await page.waitForTimeout(400);
  const before = await sizes();
  // A small core, a few pixels across, inside spikes about three times as wide: still smaller than a label is long.
  expect(before.stars).toBe(before.all);
  expect(before.orb).toBeLessThanOrEqual(8);
  expect(before.star).toBeGreaterThan(before.orb * 2);
  expect(before.star).toBeLessThanOrEqual(20);
  const box = (await graph.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 6; i++) await page.mouse.wheel(0, -100);
  await page.waitForTimeout(500);
  const closer = await sizes();
  // Zoomed in more than twice, they keep their size, give or take the step the scale settles on.
  expect(closer.orb / before.orb).toBeGreaterThan(0.75);
  expect(closer.orb / before.orb).toBeLessThan(1.35);
  expect(closer.star / before.star).toBeGreaterThan(0.75);
  expect(closer.star / before.star).toBeLessThan(1.35);
  expect(closer.label / before.label).toBeGreaterThan(0.75);
  expect(closer.label / before.label).toBeLessThan(1.35);
});

/** Text a canvas was asked to write, counted from before the page starts. */
const countCanvasText = (page: Page) =>
  page.addInitScript(() => {
    (window as any).written = 0;
    for (const name of ['fillText', 'strokeText'] as const) {
      const was = CanvasRenderingContext2D.prototype[name];
      CanvasRenderingContext2D.prototype[name] = function (this: CanvasRenderingContext2D, ...args: any[]) {
        (window as any).written++;
        return (was as any).apply(this, args);
      } as any;
    }
  });
/** Two frames drawn after now. */
const frames = (page: Page) => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(null)))));
/** Text a person could see in the 3D view: anything more than a pixel on a side (the keyboard's buttons are one pixel). */
const visibleText = (page: Page) =>
  page.locator('.memory-sky').evaluate((root) => {
    const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const seen: string[] = [];
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      if (!n.textContent?.trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(n);
      const r = range.getBoundingClientRect();
      let [x0, y0, x1, y1] = [r.left, r.top, r.right, r.bottom];
      // What a box that clips its content leaves of it.
      for (let el = n.parentElement; el && el !== root.parentElement; el = el.parentElement) {
        if (getComputedStyle(el).overflow === 'visible') continue;
        const c = el.getBoundingClientRect();
        [x0, y0, x1, y1] = [Math.max(x0, c.left), Math.max(y0, c.top), Math.min(x1, c.right), Math.min(y1, c.bottom)];
      }
      if (x1 - x0 > 1.5 && y1 - y0 > 1.5) seen.push(n.textContent.trim());
    }
    return seen;
  });

test('the 3D view and its look are kept in this browser, and nothing is written on it in any of its looks', async ({ page }) => {
  await countCanvasText(page);
  await portal(page);
  await page.goto('/memory?view=graph');
  await expect(page.getByRole('button', { name: '2D' })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: '3D' }).click();
  const sky = page.locator('.memory-sky');
  await expect(sky.locator('canvas')).toBeVisible();
  // No legend, no line of counts, no labels: only the picture and its zoom buttons.
  await expect(page.getByRole('list', { name: 'What the colours are' })).toBeHidden();
  await expect(page.getByText('— drag to move')).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('button', { name: '3D' })).toHaveAttribute('aria-pressed', 'true');
  await expect(sky.locator('canvas')).toBeVisible();
  const look = page.getByRole('combobox', { name: 'Look of the 3D view' });
  await expect(look).toHaveText('Constellation');
  for (const theme of ['stellar', 'galaxy', 'brain', 'fireflies', 'helix']) {
    await chooseLook(page, theme);
    await expect(sky).toHaveAttribute('data-theme-3d', theme);
    await frames(page);
    expect(await visibleText(page)).toEqual([]);
    expect(await page.evaluate(() => (window as any).written)).toBe(0);
  }
  await chooseLook(page, 'fireflies');
  await page.reload();
  await expect(page.getByRole('combobox', { name: 'Look of the 3D view' })).toHaveText('Fireflies');
  // A note's name only while it is reached: Tab to its star, and a small card says it; Enter opens it.
  const owner = sky.getByRole('button', { name: 'The owner' });
  await owner.focus();
  await expect.poll(() => visibleText(page)).toContain('The owner');
  await owner.blur();
  await expect.poll(() => visibleText(page)).toEqual([]);
  await owner.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('article', { name: 'The owner' })).toBeVisible();
  expect(await page.evaluate(() => (window as any).written)).toBe(0);
  await page.getByRole('button', { name: 'Graph', exact: true }).click();
  await page.getByRole('button', { name: '2D' }).click();
  await page.reload();
  await expect(page.getByRole('group', { name: /3 notes/ }).locator('line')).toHaveCount(1);
});

/** Each 3D look's secret, and the gesture that sets it off. */
const secrets: [string, string, (page: Page) => Promise<void>][] = [
  // A double-click on the empty sky, in its corner.
  ['stellar', 'meteor-shower', async (page) => {
    const b = (await page.locator('.memory-sky canvas').boundingBox())!;
    await page.mouse.dblclick(b.x + 12, b.y + 12);
  }],
  // A drag once right round the core, which is in the middle.
  ['galaxy', 'supernova', async (page) => {
    const b = (await page.locator('.memory-sky canvas').boundingBox())!;
    const [cx, cy] = [b.x + b.width / 2, b.y + b.height / 2];
    await page.mouse.move(cx + 180, cy);
    await page.mouse.down();
    for (let k = 1; k <= 24; k++) await page.mouse.move(cx + 180 * Math.cos((k / 24) * Math.PI * 2), cy + 180 * Math.sin((k / 24) * Math.PI * 2));
    await page.mouse.up();
  }],
  // A press held still on an empty spot.
  ['brain', 'thought', async (page) => {
    const b = (await page.locator('.memory-sky canvas').boundingBox())!;
    await page.mouse.move(b.x + 12, b.y + 12);
    await page.mouse.down();
    await page.waitForTimeout(1700);
    await page.mouse.up();
  }],
  // A shake: quickly back and forth.
  ['fireflies', 'heart', async (page) => {
    const b = (await page.locator('.memory-sky canvas').boundingBox())!;
    await page.mouse.move(b.x + 60, b.y + 60);
    await page.mouse.down();
    for (let k = 0; k < 6; k++) await page.mouse.move(b.x + 60 + (k % 2 ? 0 : 120), b.y + 60);
    await page.mouse.up();
  }],
  // A fast flick across.
  ['helix', 'replication', async (page) => {
    const b = (await page.locator('.memory-sky canvas').boundingBox())!;
    await page.mouse.move(b.x + 40, b.y + b.height / 2);
    await page.mouse.down();
    await page.mouse.move(b.x + 440, b.y + b.height / 2);
    await page.mouse.up();
  }],
];

for (const [theme, egg, gesture] of secrets) {
  test(`the ${theme} look has a secret of its own, ${egg}, and writes nothing while it plays`, async ({ page }) => {
    test.setTimeout(60_000);
    await countCanvasText(page);
    await portal(page, { notes: 40 });
    await page.goto('/memory?view=graph');
    await page.getByRole('button', { name: '3D' }).click();
    await chooseLook(page, theme);
    const sky = page.locator('.memory-sky');
    await expect(sky.locator('canvas')).toBeVisible();
    await frames(page);
    // Another look's gesture is not this one's.
    const [, , other] = secrets[(secrets.findIndex(([t]) => t === theme) + (theme === 'helix' ? 3 : 2)) % secrets.length];
    await other(page);
    await frames(page);
    await expect(sky).not.toHaveAttribute('data-easter-egg', egg);
    await expect(sky).not.toHaveAttribute('data-easter-egg', /./, { timeout: 15_000 });
    await gesture(page);
    await expect(sky).toHaveAttribute('data-easter-egg', egg);
    expect(await visibleText(page)).toEqual([]);
    // It ends by itself, and nothing was opened by it.
    await expect(sky).not.toHaveAttribute('data-easter-egg', /./, { timeout: 15_000 });
    await expect(page.getByRole('article')).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).written)).toBe(0);
  });
}

test('with less motion asked for, the 3D looks hold still and play no secrets', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await portal(page);
  await page.goto('/memory?view=graph');
  await page.getByRole('button', { name: '3D' }).click();
  const canvas = page.locator('.memory-sky canvas');
  for (const theme of ['stellar', 'galaxy', 'brain', 'fireflies', 'helix']) {
    await chooseLook(page, theme);
    await frames(page);
    const first = await canvas.evaluate((c: HTMLCanvasElement) => c.toDataURL());
    await page.waitForTimeout(300);
    await frames(page);
    expect(await canvas.evaluate((c: HTMLCanvasElement) => c.toDataURL())).toBe(first);
  }
  const b = (await canvas.boundingBox())!;
  await chooseLook(page, 'stellar');
  await page.mouse.dblclick(b.x + 12, b.y + 12);
  await frames(page);
  await expect(page.locator('.memory-sky')).not.toHaveAttribute('data-easter-egg', /./);
});

/** How many pixels of the canvas are mostly green, the colour the test gives the brain. */
const greenPixels = (page: Page) =>
  page.locator('.memory-sky canvas').evaluate((c: HTMLCanvasElement) => {
    const data = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < data.length; i += 4) if (data[i + 1] > 35 && data[i + 1] > 2 * data[i] && data[i + 1] > 2 * data[i + 2]) n++;
    return n;
  });

test("the brain's outline is drawn in the colour chosen for it, and the colour is kept", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await portal(page);
  await page.goto('/memory?view=graph');
  await page.getByRole('button', { name: '3D' }).click();
  await expect(page.getByRole('button', { name: "Colour of the brain's outline" })).toHaveCount(0);
  await chooseLook(page, 'brain');
  await page.getByRole('button', { name: "Colour of the brain's outline" }).click();
  const picker = page.getByRole('dialog', { name: "Colour of the brain's outline" });
  await expect(picker.getByLabel('Hex code')).toHaveValue('#ff5fc8');
  await expect(picker.getByRole('button', { name: '#ff5fc8' })).toHaveAttribute('aria-pressed', 'true');
  await frames(page);
  expect(await greenPixels(page)).toBe(0);
  await picker.getByLabel('Hex code').fill('#00ff00');
  await frames(page);
  expect(await greenPixels(page)).toBeGreaterThan(200);
  // A code that is not one yet changes nothing.
  await picker.getByLabel('Hex code').fill('#00ff');
  await expect(picker.getByLabel('Hex code')).toHaveAttribute('aria-invalid', 'true');
  await frames(page);
  expect(await greenPixels(page)).toBeGreaterThan(200);
  // A swatch is one click.
  await picker.getByRole('button', { name: '#22d3ee' }).click();
  await expect(picker.getByLabel('Hex code')).toHaveValue('#22d3ee');
  await picker.getByLabel('Hex code').fill('#00ff00');
  await page.reload();
  await page.getByRole('button', { name: "Colour of the brain's outline" }).click();
  await expect(page.getByRole('dialog', { name: "Colour of the brain's outline" }).getByLabel('Hex code')).toHaveValue('#00ff00');
  await page.keyboard.press('Escape');
  await expect(page.locator('.memory-sky canvas')).toBeVisible();
  await frames(page);
  expect(await greenPixels(page)).toBeGreaterThan(200);
});

for (const [width, height] of [[1280, 800], [390, 800]]) {
  test(`the brain's colour popover stays inside the window, ${width} wide`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await portal(page);
    await page.goto('/memory?view=graph');
    await page.getByRole('button', { name: '3D' }).click();
    await chooseLook(page, 'brain');
    await page.getByRole('button', { name: "Colour of the brain's outline" }).click();
    const picker = page.getByRole('dialog', { name: "Colour of the brain's outline" });
    await expect(picker).toBeVisible();
    const box = (await picker.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    expect(box.y + box.height).toBeLessThanOrEqual(height);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    // Every swatch in it can be reached.
    for (const swatch of await picker.getByRole('button').all()) {
      const b = (await swatch.boundingBox())!;
      expect(b.x >= 0 && b.x + b.width <= width).toBe(true);
    }
  });
}

test('in 3D a drag turns the view, the wheel zooms, and Show all of it sets it back', async ({ page }) => {
  // Without the drift, the same view is the same picture.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await portal(page);
  await page.goto('/memory?view=graph');
  await page.getByRole('button', { name: '3D' }).click();
  const canvas = page.locator('.memory-sky canvas');
  await expect(canvas).toBeVisible();
  const picture = async () => (await frames(page), canvas.evaluate((c: HTMLCanvasElement) => c.toDataURL()));
  const first = await picture();
  expect(await picture()).toBe(first);
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2 + 40, { steps: 8 });
  await page.mouse.up();
  const turned = await picture();
  expect(turned).not.toBe(first);
  await page.getByRole('button', { name: 'Show all of it' }).click();
  expect(await picture()).toBe(first);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -300);
  expect(await picture()).not.toBe(first);
  await page.getByRole('button', { name: 'Show all of it' }).click();
  await page.getByRole('button', { name: 'Zoom in' }).click();
  expect(await picture()).not.toBe(first);
});

test('a browser whose storage cannot be used still draws the graph, and switches it', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', { get() { throw new Error('blocked'); } });
  });
  await portal(page);
  await page.goto('/memory?view=graph');
  await expect(page.getByRole('group', { name: /3 notes/ }).locator('line')).toHaveCount(1);
  await page.getByRole('button', { name: '3D' }).click();
  await expect(page.locator('.memory-sky canvas')).toBeVisible();
});

test('the search lists what matches, and says when nothing does', async ({ page }) => {
  await portal(page);
  await page.goto('/memory');
  await page.getByLabel('Search the memory').fill('deploy');
  await expect(page.getByRole('list', { name: 'Found in the memory' }).getByRole('button', { name: /Branch Deployment on Test Host/ })).toBeVisible();
  await page.getByLabel('Search the memory').fill('nothing like it');
  await expect(page.getByText('Nothing in the memory matches “nothing like it”.')).toBeVisible();
  await page.getByRole('button', { name: 'Clear the search' }).click();
  await expect(notes(page).getByRole('button', { name: /The owner/ })).toBeVisible();
});

test('a search that failed is not still said once the next one has started or has worked', async ({ page }) => {
  await portal(page);
  // The second search is held until the test lets it answer.
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  // After the portal's own answers, so this one is asked first.
  await page.route('**/api/memory/search*', async (route) => {
    const q = new URL(route.request().url()).searchParams.get('q');
    if (q === 'broken') return route.fulfill({ status: 502, json: { error: 'Understory did not answer' } });
    if (q === 'deploy') await held;
    return route.fallback();
  });
  await page.goto('/memory');
  const search = page.getByLabel('Search the memory');
  await search.fill('broken');
  await expect(page.getByText('Understory did not answer')).toBeVisible();
  // The next search is a new question: the old answer is gone while it is asked, and not only when the new one comes back.
  await search.fill('deploy');
  await expect(page.getByText('Understory did not answer')).toHaveCount(0);
  await expect(page.getByRole('list', { name: 'Found in the memory' })).toHaveCount(0);
  release();
  await expect(page.getByRole('list', { name: 'Found in the memory' }).getByRole('button', { name: /Branch Deployment/ })).toBeVisible();
  await expect(page.getByText('Understory did not answer')).toHaveCount(0);
});

test('a bundle with issues says how many, and lists them', async ({ page }) => {
  await portal(page, { conformant: false });
  await page.goto('/memory');
  await page.getByRole('button', { name: '1 issue' }).click();
  await expect(page.getByText('No description in its frontmatter')).toBeVisible();
  await page.getByRole('button', { name: '/people/owner.md' }).click();
  await expect(page.getByRole('article', { name: 'The owner' })).toBeVisible();
});

test('Understory not answering is said, with a way to try again', async ({ page }) => {
  await portal(page, { broken: true });
  await page.goto('/memory');
  await expect(page.getByText('The memory could not be read.')).toBeVisible();
  await expect(page.getByText(/did not answer in time/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
});

test('on a phone the notes and what is open take turns', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await portal(page);
  await page.goto('/memory');
  await notes(page).getByRole('button', { name: /The owner/ }).click();
  await expect(page.getByRole('article', { name: 'The owner' })).toBeVisible();
  await expect(notes(page)).toBeHidden();
  await page.getByRole('button', { name: 'Back to the notes' }).click();
  await expect(notes(page)).toBeVisible();
  await page.getByRole('button', { name: 'Graph', exact: true }).click();
  await expect(page.getByRole('group', { name: /3 notes/ })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test('a note is edited in place: its title, type, tags and text, and saving says the memory is in order', async ({ page }) => {
  const { changes } = await portal(page);
  await page.goto('/memory?note=%2Fpeople%2Fowner.md');
  await page.getByRole('button', { name: 'Edit the note' }).click();
  const form = page.getByRole('form', { name: 'Edit the note' });
  await expect(form.getByLabel('Title')).toHaveValue('The owner');
  await form.getByLabel('Title').fill('The owner of the host');
  await form.getByLabel('Tags, separated by commas').fill('people, host');
  await form.getByLabel('Text, in markdown').fill('Runs the test host, and pays for it.');
  await form.getByRole('button', { name: 'Save' }).click();
  // After the note is read once more, to see that nobody wrote it meanwhile.
  await expect.poll(() => changes).toEqual([{ method: 'PUT', path: '/people/owner.md', body: { path: '/people/owner.md', frontmatter: { title: 'The owner of the host', type: 'Person', description: '', tags: ['people', 'host'] }, body: 'Runs the test host, and pays for it.' } }]);
  const after = page.getByRole('dialog', { name: 'The note is saved' });
  await expect(after.getByText('Every link leads somewhere and every note is linked in.')).toBeVisible();
  await expect(after.getByRole('button', { name: 'Repair with the model' })).toBeDisabled();
  await after.getByRole('button', { name: 'Leave it' }).click();
  await expect(page.getByRole('article', { name: 'The owner of the host' })).toContainText('and pays for it');
  await expect(page.getByText('#host')).toBeVisible();
});

test('a note being edited is not left for another note, the log, the graph or a refresh without asking', async ({ page }) => {
  const { changes } = await portal(page);
  await page.goto('/memory?note=%2Fpeople%2Fowner.md');
  await page.getByRole('button', { name: 'Edit the note' }).click();
  const form = page.getByRole('form', { name: 'Edit the note' });
  // Opened for editing and not changed: nothing to lose, so the next note opens at once.
  await notes(page).getByRole('button', { name: /Branch Deployment/ }).click();
  await expect(page).toHaveURL(/note=%2Fdeployment%2Fbranches.md/);
  await notes(page).getByRole('button', { name: /The owner/ }).click();
  await page.getByRole('button', { name: 'Edit the note' }).click();
  await form.getByLabel('Text, in markdown').fill('A long rewrite, not saved yet.');

  const ask = page.getByRole('alertdialog', { name: 'Discard your changes?' });
  for (const leave of [
    () => notes(page).getByRole('button', { name: /Branch Deployment/ }).click(),
    () => page.getByRole('button', { name: 'Log', exact: true }).click(),
    () => page.getByRole('button', { name: 'Graph', exact: true }).click(),
    () => page.getByRole('button', { name: 'Read the memory again' }).click(),
  ]) {
    await leave();
    await expect(ask).toContainText('The note you are editing has changes that are not saved.');
    await ask.getByRole('button', { name: 'Cancel' }).click();
    await expect(page).toHaveURL(/note=%2Fpeople%2Fowner.md/);
    await expect(form.getByLabel('Text, in markdown')).toHaveValue('A long rewrite, not saved yet.');
  }
  expect(changes).toEqual([]);

  // Answered "Discard", the other note opens.
  await notes(page).getByRole('button', { name: /Branch Deployment/ }).click();
  await ask.getByRole('button', { name: 'Discard' }).click();
  await expect(page).toHaveURL(/note=%2Fdeployment%2Fbranches.md/);
  await expect(form).toHaveCount(0);
});

test('a note left by Back, Forward or a link to another page gets its edit back, and still asks before it is left', async ({ page }) => {
  const { changes } = await portal(page);
  await page.goto('/memory?note=%2Fpeople%2Fowner.md');
  await notes(page).getByRole('button', { name: /Branch Deployment/ }).click();
  await expect(page).toHaveURL(/note=%2Fdeployment%2Fbranches.md/);
  await page.getByRole('button', { name: 'Edit the note' }).click();
  const form = page.getByRole('form', { name: 'Edit the note' });
  const text = form.getByLabel('Text, in markdown');
  await text.fill('A long rewrite, not saved yet.');
  // The browser's Back takes the page away from the note without asking, and Forward comes back to it.
  await page.goBack();
  await expect(page).toHaveURL(/note=%2Fpeople%2Fowner.md/);
  await expect(form).toHaveCount(0);
  await page.goForward();
  await expect(text).toHaveValue('A long rewrite, not saved yet.');
  // It is an edit to be asked about again.
  await page.getByRole('button', { name: 'Log', exact: true }).click();
  const ask = page.getByRole('alertdialog', { name: 'Discard your changes?' });
  await expect(ask).toBeVisible();
  await ask.getByRole('button', { name: 'Cancel' }).click();
  // A link to another page of the portal leaves it as well, and so does coming back.
  await page.getByRole('button', { name: 'Sessions' }).first().click();
  await expect(page).toHaveURL(/\/sessions/);
  await page.goBack();
  await expect(page).toHaveURL(/note=%2Fdeployment%2Fbranches.md/);
  await expect(text).toHaveValue('A long rewrite, not saved yet.');
  expect(changes).toEqual([]);
});

const BRANCHES = '/deployment/branches.md';
/** The agent writes the note while the person is elsewhere, or reading: Understory sets a new time on every write. */
const rewritten = () => {
  const was = concepts[BRANCHES] as { frontmatter: object; body: string };
  concepts[BRANCHES] = { ...was, frontmatter: { ...was.frontmatter, timestamp: '2026-09-29T10:00:00.000Z' }, body: 'Branches go out with `deploy-branch.sh`.\n\nThe agent learnt: deploys need an approval now.' };
  return () => void (concepts[BRANCHES] = was);
};

test('an edit brought back over a note the agent wrote meanwhile says so, and Save does not go out unasked', async ({ page }) => {
  const { changes } = await portal(page);
  await page.goto('/memory?note=%2Fpeople%2Fowner.md');
  await notes(page).getByRole('button', { name: /Branch Deployment/ }).click();
  await page.getByRole('button', { name: 'Edit the note' }).click();
  const form = page.getByRole('form', { name: 'Edit the note' });
  await form.getByLabel('Text, in markdown').fill('Branches go out with `deploy-branch.sh`.\nMy addition.');
  await page.goBack();
  await expect(page).toHaveURL(/note=%2Fpeople%2Fowner.md/);
  await expect(page.getByRole('article', { name: 'The owner' })).toBeVisible();
  const restore = rewritten();
  try {
    await page.goForward();
    // The edit is back, built on the old text, and the person is told before they can save it over what the agent learnt.
    await expect(form.getByLabel('Text, in markdown')).toHaveValue(/My addition/);
    const alert = page.getByRole('alert').filter({ hasText: 'This note changed after you started editing it.' });
    await expect(alert).toBeVisible();
    await form.getByRole('button', { name: 'Save' }).click();
    await expect(alert).toBeVisible();
    expect(changes).toEqual([]);
    // Giving it up shows the note as the agent left it.
    await alert.getByRole('button', { name: 'Load the new version' }).click();
    await expect(form).toHaveCount(0);
    await expect(page.getByText('The agent learnt: deploys need an approval now.')).toBeVisible();
    expect(changes).toEqual([]);
  } finally {
    restore();
  }
});

test('a save over a note the agent wrote since the edit began asks first, and goes out when told to', async ({ page }) => {
  const { changes } = await portal(page);
  await page.goto('/memory?note=%2Fdeployment%2Fbranches.md');
  await page.getByRole('button', { name: 'Edit the note' }).click();
  const form = page.getByRole('form', { name: 'Edit the note' });
  await form.getByLabel('Text, in markdown').fill('Mine.');
  const restore = rewritten();
  try {
    await form.getByRole('button', { name: 'Save' }).click();
    const alert = page.getByRole('alert').filter({ hasText: 'This note changed after you started editing it.' });
    await expect(alert).toBeVisible();
    expect(changes).toEqual([]);
    await alert.getByRole('button', { name: 'Save mine anyway' }).click();
    await page.getByRole('dialog', { name: 'The note is saved' }).getByRole('button', { name: 'Leave it' }).click();
    expect(changes.map((c) => [c.method, c.path, c.body.body])).toEqual([['PUT', BRANCHES, 'Mine.']]);
  } finally {
    restore();
  }
});

test('a note that was saved can be edited and saved again: the note is compared as it is read, not as the write answered', async ({ page }) => {
  const { changes } = await portal(page);
  const was = concepts[BRANCHES];
  try {
    await page.goto('/memory?note=%2Fdeployment%2Fbranches.md');
    const saved = page.getByRole('dialog', { name: 'The note is saved' });
    for (const text of ['First line.\nAnd a second.', 'First line.\nAnd a second.\nA typo fixed.']) {
      await page.getByRole('button', { name: 'Edit the note' }).click();
      const form = page.getByRole('form', { name: 'Edit the note' });
      await form.getByLabel('Text, in markdown').fill(text);
      await form.getByRole('button', { name: 'Save' }).click();
      await expect(saved).toBeVisible();
      await saved.getByRole('button', { name: 'Leave it' }).click();
      await expect(saved).toBeHidden();
    }
    await expect(page.getByRole('alert').filter({ hasText: 'This note changed after you started editing it.' })).toHaveCount(0);
    expect(changes.map((c) => c.body.body)).toEqual(['First line.\nAnd a second.', 'First line.\nAnd a second.\nA typo fixed.']);
  } finally {
    concepts[BRANCHES] = was;
  }
});

test('a note deleted while it is being edited can still be saved, and writes it again', async ({ page }) => {
  const { changes } = await portal(page);
  const was = concepts[BRANCHES];
  try {
    await page.goto('/memory?note=%2Fdeployment%2Fbranches.md');
    await page.getByRole('button', { name: 'Edit the note' }).click();
    const form = page.getByRole('form', { name: 'Edit the note' });
    await form.getByLabel('Text, in markdown').fill('Written again.');
    delete concepts[BRANCHES];
    await form.getByRole('button', { name: 'Save' }).click();
    const alert = page.getByRole('alert').filter({ hasText: 'This note was deleted after you started editing it.' });
    await expect(alert).toBeVisible();
    expect(changes).toEqual([]);
    // What the edit has to say is still in the form, and there is nothing newer to load.
    await expect(form.getByLabel('Text, in markdown')).toHaveValue('Written again.');
    await expect(alert.getByRole('button', { name: 'Load the new version' })).toHaveCount(0);
    await alert.getByRole('button', { name: 'Save mine anyway' }).click();
    await page.getByRole('dialog', { name: 'The note is saved' }).getByRole('button', { name: 'Leave it' }).click();
    expect(changes.map((c) => [c.method, c.path, c.body.body])).toEqual([['PUT', BRANCHES, 'Written again.']]);
  } finally {
    concepts[BRANCHES] = was;
  }
});

test('an edit left on a note that was deleted meanwhile is brought back as one over a deleted note', async ({ page }) => {
  const { changes } = await portal(page);
  const was = concepts[BRANCHES];
  try {
    await page.goto('/memory?note=%2Fpeople%2Fowner.md');
    await notes(page).getByRole('button', { name: /Branch Deployment/ }).click();
    await page.getByRole('button', { name: 'Edit the note' }).click();
    const form = page.getByRole('form', { name: 'Edit the note' });
    await form.getByLabel('Title').fill('Branches, my way');
    await form.getByLabel('Text, in markdown').fill('My rewrite.');
    await page.goBack();
    await expect(page).toHaveURL(/note=%2Fpeople%2Fowner.md/);
    await expect(page.getByRole('article', { name: 'The owner' })).toBeVisible();
    // The agent tidies the note away while the person is on another one.
    delete concepts[BRANCHES];
    await page.goForward();
    const alert = page.getByRole('alert').filter({ hasText: 'This note was deleted after you started editing it.' });
    await expect(alert).toBeVisible();
    await expect(page.getByText('Concept not found')).toHaveCount(0);
    await expect(form.getByLabel('Text, in markdown')).toHaveValue('My rewrite.');
    await expect(alert.getByRole('button', { name: 'Load the new version' })).toHaveCount(0);
    // It is the only copy, so leaving still asks.
    await page.getByRole('button', { name: 'Log', exact: true }).click();
    const ask = page.getByRole('alertdialog', { name: 'Discard your changes?' });
    await expect(ask).toBeVisible();
    await ask.getByRole('button', { name: 'Cancel' }).click();
    await expect(form).toBeVisible();
    // Giving it up leaves what was there: nothing.
    await form.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'Concept not found' })).toBeVisible();
    await expect(form).toHaveCount(0);
    expect(changes).toEqual([]);

    // Saved anyway, it is written again as it was typed.
    await page.goto('/memory?note=%2Fpeople%2Fowner.md');
    await notes(page).getByRole('button', { name: /Branch Deployment/ }).click();
    concepts[BRANCHES] = was;
    await page.getByRole('button', { name: 'Edit the note' }).click();
    await form.getByLabel('Title').fill('Branches, my way');
    await form.getByLabel('Text, in markdown').fill('My rewrite.');
    await page.goBack();
    await expect(page.getByRole('article', { name: 'The owner' })).toBeVisible();
    delete concepts[BRANCHES];
    await page.goForward();
    await expect(alert).toBeVisible();
    await alert.getByRole('button', { name: 'Save mine anyway' }).click();
    await page.getByRole('dialog', { name: 'The note is saved' }).getByRole('button', { name: 'Leave it' }).click();
    expect(changes.map((c) => [c.method, c.path, c.body.frontmatter.title, c.body.body])).toEqual([['PUT', BRANCHES, 'Branches, my way', 'My rewrite.']]);
  } finally {
    concepts[BRANCHES] = was;
  }
});

test('a note reported deleted that the agent writes again says it changed, and offers the new version', async ({ page }) => {
  const { changes } = await portal(page);
  const was = concepts[BRANCHES];
  try {
    await page.goto('/memory?note=%2Fdeployment%2Fbranches.md');
    await page.getByRole('button', { name: 'Edit the note' }).click();
    const form = page.getByRole('form', { name: 'Edit the note' });
    await form.getByLabel('Text, in markdown').fill('Mine.');
    delete concepts[BRANCHES];
    await form.getByRole('button', { name: 'Save' }).click();
    const deleted = page.getByRole('alert').filter({ hasText: 'This note was deleted after you started editing it.' });
    await expect(deleted).toBeVisible();

    // It is there again, written by the agent: the next Save finds it, and it is no longer a deleted note.
    const now = concepts[BRANCHES] = { ...(was as { frontmatter: object }), frontmatter: { ...(was as { frontmatter: object }).frontmatter, timestamp: '2026-09-29T10:00:00.000Z' }, body: 'The agent wrote it again.\n' };
    await form.getByRole('button', { name: 'Save' }).click();
    const changed = page.getByRole('alert').filter({ hasText: 'This note changed after you started editing it.' });
    await expect(changed).toBeVisible();
    await expect(deleted).toHaveCount(0);
    expect(changes).toEqual([]);
    await changed.getByRole('button', { name: 'Load the new version' }).click();
    await expect(form).toHaveCount(0);
    await expect(page.getByText('The agent wrote it again.')).toBeVisible();
    expect(now.body).toBe('The agent wrote it again.\n');
  } finally {
    concepts[BRANCHES] = was;
  }
});

test('an edit that was saved, cancelled or given up is not brought back', async ({ page }) => {
  const { changes } = await portal(page);
  await page.goto('/memory?note=%2Fpeople%2Fowner.md');
  const form = page.getByRole('form', { name: 'Edit the note' });
  // The other note is shown before the page goes back: going back from a note that was never left is no leaving.
  const shown = () => expect(page.getByRole('article', { name: 'Branch Deployment on Test Host' })).toBeVisible();
  const away = async () => {
    await notes(page).getByRole('button', { name: /Branch Deployment/ }).click();
    await shown();
    await page.goBack();
    await expect(page).toHaveURL(/note=%2Fpeople%2Fowner.md/);
  };
  // Cancelled.
  await page.getByRole('button', { name: 'Edit the note' }).click();
  await form.getByLabel('Text, in markdown').fill('Cancelled.');
  await form.getByRole('button', { name: 'Cancel' }).click();
  await away();
  await expect(form).toHaveCount(0);
  // Given up, when asked.
  await page.getByRole('button', { name: 'Edit the note' }).click();
  await form.getByLabel('Text, in markdown').fill('Given up.');
  await notes(page).getByRole('button', { name: /Branch Deployment/ }).click();
  await page.getByRole('alertdialog', { name: 'Discard your changes?' }).getByRole('button', { name: 'Discard' }).click();
  await shown();
  await page.goBack();
  await expect(page).toHaveURL(/note=%2Fpeople%2Fowner.md/);
  await expect(form).toHaveCount(0);
  // Saved.
  await page.getByRole('button', { name: 'Edit the note' }).click();
  await form.getByLabel('Text, in markdown').fill('Saved.');
  await form.getByRole('button', { name: 'Save' }).click();
  await page.getByRole('dialog', { name: 'The note is saved' }).getByRole('button', { name: 'Leave it' }).click();
  await away();
  await expect(form).toHaveCount(0);
  expect(changes).toHaveLength(1);
});

test('clearing the whole memory takes the edits of its notes with it', async ({ page }) => {
  await portal(page);
  await page.goto('/memory?note=%2Fpeople%2Fowner.md');
  await page.getByRole('button', { name: 'Edit the note' }).click();
  await page.getByRole('form', { name: 'Edit the note' }).getByLabel('Text, in markdown').fill('Not saved, and then the memory is cleared.');
  await page.getByRole('button', { name: 'Clear the memory' }).click();
  await page.getByRole('alertdialog', { name: 'Clear the whole memory?' }).getByRole('button', { name: 'Clear the memory' }).click();
  await expect(page).toHaveURL(/\/memory$/);
  // A note of the same path turns up later, and is opened.
  await page.evaluate(() => { history.pushState(null, '', '/memory?note=%2Fpeople%2Fowner.md'); window.dispatchEvent(new PopStateEvent('popstate')); });
  await expect(page.getByRole('article', { name: 'The owner' })).toBeVisible();
  await expect(page.getByRole('form', { name: 'Edit the note' })).toHaveCount(0);
});

test('deleting a note asks first, then shows what it broke and offers to put it right', async ({ page }) => {
  const { changes } = await portal(page);
  await page.goto('/memory?note=%2Fpeople%2Fowner.md');
  await page.getByRole('button', { name: 'Delete the note' }).click();
  await page.getByRole('button', { name: 'Cancel' }).click();
  expect(changes).toEqual([]);
  await page.getByRole('button', { name: 'Delete the note' }).click();
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page).toHaveURL(/\/memory$/);
  const after = page.getByRole('dialog', { name: 'The note is deleted' });
  await expect(after.getByText('The memory has 1 thing to put right.')).toBeVisible();
  await expect(after.getByText('/people/owner.md', { exact: true })).toBeVisible();

  await after.getByRole('button', { name: 'Rebuild the index' }).click();
  await expect(after.getByText('3 indexes written anew, 1 empty folder removed.')).toBeVisible();
  await after.getByRole('button', { name: 'Repair with the model' }).click();
  await expect(after.getByText('The model changed 1 file.')).toBeVisible();
  await after.getByText('What the model said').click();
  await expect(after.getByRole('heading', { name: 'What changed' })).toBeVisible();
  await expect(after.getByText('Every link leads somewhere and every note is linked in.')).toBeVisible();
  // Nothing left for it: the model is not asked again.
  await expect(after.getByRole('button', { name: 'Repair with the model' })).toBeDisabled();
  expect(changes.map((c) => `${c.method} ${c.path}`)).toEqual(['DELETE /people/owner.md', 'POST /api/memory/reindex', 'POST /api/memory/repair']);
});

test("Understory's own index is not edited by hand, nor any note of one run elsewhere", async ({ page }) => {
  await portal(page);
  await page.goto('/memory?note=%2Findex.md');
  await expect(page.getByRole('article', { name: 'index.md' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit the note' })).toHaveCount(0);
  await page.goto('/memory?note=%2Fpeople%2Fowner.md');
  await expect(page.getByRole('button', { name: 'Edit the note' })).toBeVisible();
});

test('one run elsewhere is read only', async ({ page }) => {
  await portal(page, { writable: false });
  await page.goto('/memory?note=%2Fpeople%2Fowner.md');
  await expect(page.getByRole('article', { name: 'The owner' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit the note' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Delete the note' })).toHaveCount(0);
});

test('the log can be cleared, after asking; the notes stay', async ({ page }) => {
  const { changes } = await portal(page);
  await page.goto('/memory?view=log');
  const log = page.getByRole('region', { name: 'Changes to the memory' });
  await expect(log.locator('li')).toHaveCount(2);
  await page.getByRole('button', { name: 'Clear the log' }).click();
  await expect(page.getByText(/The notes stay as they are/)).toBeVisible();
  await page.getByRole('button', { name: 'Clear it' }).click();
  await expect(log.getByText('Nothing has changed yet.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Clear the log' })).toHaveCount(0);
  expect(changes.map((c) => c.path)).toEqual(['/api/memory/clear-log']);
  await expect(page.getByRole('navigation', { name: 'Notes' }).getByRole('button', { name: /The owner/ })).toBeVisible();
});

test('one run elsewhere has no clearing of its log', async ({ page }) => {
  await portal(page, { writable: false });
  await page.goto('/memory?view=log');
  await expect(page.getByRole('region', { name: 'Changes to the memory' }).locator('li')).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'Clear the log' })).toHaveCount(0);
});

test('the whole memory can be cleared, after asking: no notes, an empty index and log', async ({ page }) => {
  const { changes } = await portal(page);
  await page.goto('/memory?note=%2Fpeople%2Fowner.md');
  await page.getByRole('button', { name: 'Clear the memory' }).click();
  await expect(page.getByText(/The agent forgets everything it kept here/)).toBeVisible();
  await page.getByRole('button', { name: 'Cancel' }).click();
  expect(changes).toEqual([]);
  await page.getByRole('button', { name: 'Clear the memory' }).click();
  await page.getByRole('alertdialog', { name: 'Clear the whole memory?' }).getByRole('button', { name: 'Clear the memory' }).click();
  await expect(page).toHaveURL(/\/memory$/);
  const notes = page.getByRole('navigation', { name: 'Notes' });
  await expect(notes.getByRole('button', { name: /The owner/ })).toHaveCount(0);
  await expect(notes.getByRole('button', { name: 'log.md' })).toBeVisible();
  expect(changes.map((c) => c.path)).toEqual(['/api/memory/wipe']);
});

test('one run elsewhere cannot be cleared from here', async ({ page }) => {
  await portal(page, { writable: false });
  await page.goto('/memory');
  await expect(page.getByRole('navigation', { name: 'Notes' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Clear the memory' })).toHaveCount(0);
});

const events = (...chunks: unknown[]) => chunks.map((c) => `data: ${typeof c === 'string' ? c : JSON.stringify(c)}\n\n`).join('');
const answering = (text: string, withTool = false) => events(
  { type: 'start' }, { type: 'start-step' },
  ...(withTool ? [
    { type: 'tool-input-available', toolCallId: 'c1', toolName: 'search_knowledge', input: { query: 'deploy' } },
    { type: 'tool-output-available', toolCallId: 'c1', output: [] },
    { type: 'finish-step' }, { type: 'start-step' },
  ] : []),
  { type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: text }, { type: 'text-end', id: 't' }, { type: 'finish' }, '[DONE]',
);
const composer = (page: Page) => page.getByRole('textbox', { name: 'Ask the librarian' });

test('the librarian answers in a chat of its own, with its tool calls and links to notes; the conversation goes up whole, and Clear chat starts over', async ({ page }) => {
  const { chats, asked } = await portal(page, {
    librarian: [answering('Branches go out with [the script](/deployment/branches.md).', true), answering('Only the owner.'), answering('Fresh start.')],
  });
  await page.goto('/memory');
  await page.getByRole('button', { name: 'Librarian' }).click();
  await expect(page).toHaveURL(/view=chat/);
  const log = page.getByRole('log', { name: 'Conversation with the librarian' });
  await expect(page.getByRole('button', { name: 'Clear chat' })).toBeDisabled();

  await composer(page).fill('How are branches deployed?');
  await composer(page).press('Enter');
  await expect(log.getByText('How are branches deployed?')).toBeVisible();
  await expect(log.getByText('search_knowledge')).toBeVisible();
  await expect(log.getByText(/Branches go out with/)).toBeVisible();
  expect(chats[0].map((m) => [m.role, m.parts[0].text])).toEqual([['user', 'How are branches deployed?']]);
  // It wrote or read with a tool: the notes beside it are read again.
  await expect.poll(() => asked.filter((a) => a === '/api/memory/tree').length).toBeGreaterThan(1);

  // The conversation stays while a note from its answer is open, and the next question carries it.
  await log.getByRole('link', { name: 'the script' }).click();
  await expect(page.getByRole('article', { name: 'Branch Deployment on Test Host' })).toBeVisible();
  await page.getByRole('button', { name: 'Librarian' }).click();
  await expect(log.getByText('How are branches deployed?')).toBeVisible();
  await composer(page).fill('Who asked for it?');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(log.getByText('Only the owner.')).toBeVisible();
  expect(chats[1].map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
  expect(chats[1][1].parts.map((p: any) => p.type)).toEqual(['step-start', 'tool-search_knowledge', 'step-start', 'text']);
  expect(chats[1][1].parts[1]).toMatchObject({ state: 'output-available', input: { query: 'deploy' } });

  await page.getByRole('button', { name: 'Clear chat' }).click();
  await expect(log.getByText('Who asked for it?')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Clear chat' })).toBeDisabled();
  await composer(page).fill('Anything left?');
  await composer(page).press('Enter');
  await expect(log.getByText('Fresh start.')).toBeVisible();
  expect(chats[2].map((m) => m.role)).toEqual(['user']);
});

test('an answer under way can be stopped, and a failure of the librarian is said', async ({ page }) => {
  const { chats } = await portal(page, { librarian: [HANG, events({ type: 'start' }, { type: 'error', errorText: 'The model did not answer' }, '[DONE]')] });
  await page.goto('/memory?view=chat');
  await composer(page).fill('Hello?');
  await composer(page).press('Enter');
  await expect(page.getByText('The librarian is thinking…')).toBeVisible();
  await page.getByRole('button', { name: 'Stop' }).click();
  await expect(page.getByRole('button', { name: 'Send' })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);

  await composer(page).fill('Again?');
  await composer(page).press('Enter');
  await expect(page.getByRole('alert')).toContainText('The librarian could not answer: The model did not answer');
  // The stopped question had no answer: the model is not given an empty turn to follow it.
  expect(chats[1].map((m) => m.role)).toEqual(['user', 'user']);
});

test('one run elsewhere has no librarian', async ({ page }) => {
  await portal(page, { writable: false });
  await page.goto('/memory');
  await expect(page.getByRole('navigation', { name: 'Notes' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Librarian' })).toHaveCount(0);
  await page.goto('/memory?view=chat');
  await expect(page.getByText('Choose a note, or open the log or the graph.')).toBeVisible();
});
