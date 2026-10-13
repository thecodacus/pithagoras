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

/** Two frames drawn after now. */
const frames = (page: Page) => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(null)))));
/** The page quiet, so that nothing moves under a measure: all it asked for is here, the fonts are in, and a frame is drawn. */
const settled = async (page: Page) => {
  await page.waitForLoadState('networkidle');
  await page.evaluate(() => document.fonts.ready);
  await frames(page);
};
/** What the graph's canvas shows, as a picture to compare with another. */
const picture = async (page: Page) => (await frames(page), page.locator('.memory-sky canvas').evaluate((c: HTMLCanvasElement) => c.toDataURL()));

/**
 * Where the notes are on the graph's canvas, found in the picture itself: the
 * white-hot middle of each star, in page pixels. Their links are fainter than
 * that, and so is every star's glow.
 */
const stars = (page: Page) =>
  page.locator('.memory-sky canvas').evaluate((c: HTMLCanvasElement) => {
    const { width, height } = c;
    const data = c.getContext('2d')!.getImageData(0, 0, width, height).data;
    const box = c.getBoundingClientRect();
    const k = box.width / width;
    const hot = (x: number, y: number) => {
      const i = (y * width + x) * 4;
      return data[i] > 170 && data[i + 1] > 170 && data[i + 2] > 170;
    };
    const seen = new Set<number>();
    const found: { x: number; y: number }[] = [];
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        if (!hot(x, y) || seen.has(y * width + x)) continue;
        // The bright pixels that touch this one are the same star.
        const stack = [[x, y]];
        let [sx, sy, n] = [0, 0, 0];
        seen.add(y * width + x);
        while (stack.length) {
          const [px, py] = stack.pop()!;
          sx += px;
          sy += py;
          n++;
          for (let dy = -2; dy <= 2; dy++)
            for (let dx = -2; dx <= 2; dx++) {
              const [qx, qy] = [px + dx, py + dy];
              if (qx < 0 || qy < 0 || qx >= width || qy >= height || seen.has(qy * width + qx) || !hot(qx, qy)) continue;
              seen.add(qy * width + qx);
              stack.push([qx, qy]);
            }
        }
        found.push({ x: box.left + (sx / n) * k, y: box.top + (sy / n) * k });
      }
    return found;
  });

/** How much light there is at a point of the canvas, in page pixels: the sum of the colours of the brightest pixel within `r` of it. */
const lightAt = (page: Page, x: number, y: number, r = 2) =>
  page.locator('.memory-sky canvas').evaluate(
    (c: HTMLCanvasElement, [x, y, r]) => {
      const box = c.getBoundingClientRect();
      const k = c.width / box.width;
      const [px, py, pr] = [Math.round((x - box.left) * k), Math.round((y - box.top) * k), Math.ceil(r * k)];
      const data = c.getContext('2d')!.getImageData(px - pr, py - pr, 2 * pr + 1, 2 * pr + 1).data;
      let best = 0;
      for (let i = 0; i < data.length; i += 4) best = Math.max(best, data[i] + data[i + 1] + data[i + 2]);
      return best;
    },
    [x, y, r],
  );
/** The light at distance `r` from a point, averaged round it: how a star's glow falls off. */
const ringLight = (page: Page, x: number, y: number, r: number) =>
  page.locator('.memory-sky canvas').evaluate(
    (c: HTMLCanvasElement, [x, y, r]) => {
      const box = c.getBoundingClientRect();
      const k = c.width / box.width;
      const [cx, cy] = [(x - box.left) * k, (y - box.top) * k];
      let sum = 0;
      const n = 48;
      for (let a = 0; a < n; a++) {
        const d = c.getContext('2d')!.getImageData(Math.round(cx + r * k * Math.cos((a / n) * 2 * Math.PI)), Math.round(cy + r * k * Math.sin((a / n) * 2 * Math.PI)), 1, 1).data;
        sum += d[0] + d[1] + d[2];
      }
      return sum / n;
    },
    [x, y, r],
  );

test('the graph draws the notes and their links, says what the colours are, and a note opens from it', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await portal(page);
  await page.goto('/memory?view=graph');
  // A group and not a picture: its notes are buttons that Tab reaches, which a picture would make presentational.
  const graph = page.getByRole('group', { name: /3 notes, 1 link/ });
  await expect(graph).toBeVisible();
  await expect(page.getByRole('img', { name: /3 notes, 1 link/ })).toHaveCount(0);
  // The 3D view's picture seen straight on: the same canvas, in the look that was kept or the first.
  await expect(graph).toHaveAttribute('data-flat', 'true');
  await expect(graph).toHaveAttribute('data-look', 'stellar');
  await expect(graph.locator('canvas')).toBeVisible();
  await settled(page);
  const found = await stars(page);
  expect(found).toHaveLength(3);
  // The one link is a faint line between two of the three, and no other pair has one.
  const faint = async (a: { x: number; y: number }, b: { x: number; y: number }) => {
    const [mx, my] = [(a.x + b.x) / 2, (a.y + b.y) / 2];
    // Beside the middle of the pair, where no line is, is the backdrop.
    const along = Math.hypot(b.x - a.x, b.y - a.y);
    const side = await lightAt(page, mx - ((b.y - a.y) / along) * 14, my + ((b.x - a.x) / along) * 14, 1);
    return (await lightAt(page, mx, my, 1)) - side;
  };
  const lines = (await Promise.all([faint(found[0], found[1]), faint(found[0], found[2]), faint(found[1], found[2])])).filter((d) => d > 60);
  expect(lines).toHaveLength(1);
  // See-through: dimmer than the stars it joins.
  expect(lines[0]).toBeLessThan(await lightAt(page, found[0].x, found[0].y, 2));
  const legend = page.getByRole('list', { name: 'What the colours are' });
  await expect(legend).toContainText('Deployment Process');
  await expect(legend).toContainText('orphan (unlinked)');
  await page.getByText('Query paths').click();
  await expect(page.getByText('9.7k→2k tok')).toBeVisible();
  const before = await picture(page);
  await page.getByRole('button', { name: 'Zoom in' }).click();
  expect(await picture(page)).not.toBe(before);
  await page.getByRole('button', { name: 'Show all of it' }).click();
  expect(await picture(page)).toBe(before);
  // Opened from the keyboard, through its button.
  await graph.getByRole('button', { name: 'The owner' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('article', { name: 'The owner' })).toBeVisible();
});

test('a graph of a long memory opens without freezing the page, and panning it stays smooth', async ({ page }) => {
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
  // Every note is on the canvas, and in the list a screen reader and Tab reach.
  await expect(graph.locator('canvas')).toBeVisible();
  await expect(graph.locator('ul button')).toHaveCount(1500);

  // Taking hold of the picture and moving it, and rolling the wheel over it: none of that freezes the page, whatever the frames cost.
  const box = (await graph.boundingBox())!;
  await page.evaluate(() => ((window as any).longest = 0));
  await page.mouse.move(box.x + box.width - 5, box.y + box.height - 5);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 105, box.y + box.height - 105, { steps: 60 });
  await page.mouse.up();
  for (let i = 0; i < 6; i++) await page.mouse.wheel(0, -100);
  await frames(page);
  expect(await page.evaluate(() => (window as any).longest)).toBeLessThan(1500);
});

/** What a person could read over the graph: anything more than a pixel on a side (the keyboard's buttons are one pixel). */
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

test('in 2D a note is a glowing point and its name shows only while it is pointed at, as in 3D', async ({ page }) => {
  await countCanvasText(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await portal(page);
  await page.goto('/memory?view=graph');
  const graph = page.getByRole('group', { name: /3 notes, 1 link/ });
  await expect(graph).toHaveAttribute('data-flat', 'true');
  await settled(page);
  // No name anywhere, drawn or written, until a note is pointed at.
  expect(await visibleText(page)).toEqual([]);
  const found = await stars(page);
  expect(found).toHaveLength(3);
  // A glow, not a dot: the light falls off smoothly from the star's middle, well above the dark backdrop at its edge, and out.
  const [middle, near, mid, edge, far] = await Promise.all([0, 2, 4, 6, 20].map((r) => ringLight(page, found[0].x, found[0].y, r)));
  expect(middle).toBeGreaterThan(near);
  expect(near).toBeGreaterThan(mid);
  expect(mid).toBeGreaterThan(edge);
  expect(edge).toBeGreaterThan(far + 10);
  // Pointing at each in turn: a card with the name, type, links and description, and nothing else written.
  const named: Record<string, { x: number; y: number }> = {};
  for (const star of found) {
    await page.mouse.move(star.x, star.y);
    await expect.poll(() => visibleText(page)).not.toEqual([]);
    const text = await visibleText(page);
    named[text[0]] = star;
    expect(text.length).toBeGreaterThanOrEqual(2);
  }
  expect(Object.keys(named).sort()).toEqual(['A loose note', 'Branch Deployment on Test Host', 'The owner']);
  expect(await page.evaluate(() => (window as any).written)).toBe(0);
  // The notes it links with light up, and the rest steps back.
  const loose = named['A loose note'];
  const owner = named['The owner'];
  await page.mouse.move(named['Branch Deployment on Test Host'].x, named['Branch Deployment on Test Host'].y);
  await expect(page.getByText('The test host deploys branches using deploy-branch.sh.')).toBeVisible();
  await expect.poll(() => lightAt(page, loose.x, loose.y, 2)).toBeLessThan(400);
  expect(await lightAt(page, owner.x, owner.y, 2)).toBeGreaterThan(600);
  // Pointing away puts it all back; Tab reaches a note the same way.
  await page.mouse.move(5, 5);
  await expect.poll(() => visibleText(page)).toEqual([]);
  await expect.poll(() => lightAt(page, loose.x, loose.y, 2)).toBeGreaterThan(600);
  await graph.getByRole('button', { name: 'The owner' }).focus();
  await expect.poll(() => visibleText(page)).toContain('The owner');
  expect(await page.evaluate(() => (window as any).written)).toBe(0);
});

test('the note last opened is lit and in the middle when the graph is back, until the background is clicked', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await portal(page);
  await page.goto('/memory?view=graph');
  const graph = page.getByRole('group', { name: /3 notes, 1 link/ });
  await expect(graph).toBeVisible();
  await settled(page);
  await graph.getByRole('button', { name: 'The owner' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('article', { name: 'The owner' })).toBeVisible();
  await page.goBack();
  await expect(graph).toBeVisible();
  // Gone to it: the note is the star in the middle of the picture, with the ring round it, and the one nothing links with is dimmed.
  const box = (await graph.locator('canvas').boundingBox())!;
  const middle = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await expect.poll(async () => (await stars(page)).filter((s) => Math.hypot(s.x - middle.x, s.y - middle.y) < 3).length).toBeGreaterThanOrEqual(2);
  const ringed = await picture(page);
  await page.mouse.click(box.x + 8, box.y + 8);
  // Let go, the ring and the dimming are gone.
  await expect.poll(() => picture(page)).not.toBe(ringed);
});

test('the type switches filter both views, and what the search found is marked in both', async ({ page }) => {
  await portal(page);
  await page.goto('/memory?view=graph');
  const legend = page.getByRole('list', { name: 'What the colours are' });
  await legend.getByRole('button', { name: 'Person' }).click();
  await expect(legend.getByRole('button', { name: 'Person' })).toHaveAttribute('aria-pressed', 'false');
  let graph = page.getByRole('group', { name: /2 notes, 0 links/ });
  await expect(graph.locator('canvas')).toBeVisible();
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
  graph = page.getByRole('group', { name: /3 notes, 1 link/ });
  await expect(graph).toHaveAttribute('data-flat', 'true');
  await expect(graph.getByRole('button', { name: 'Branch Deployment on Test Host' })).toHaveAccessibleDescription('Matches the search');
  await expect(graph.getByRole('button', { name: 'The owner' })).not.toHaveAccessibleDescription('Matches the search');
});

/** The looks by the names the menu gives them. */
const LOOK_NAMES: Record<string, string> = { stellar: 'Constellation', galaxy: 'Galaxy', brain: 'Brain', fireflies: 'Fireflies', helix: 'Double helix' };
/** Picks a look from the toolbar's menu, as a person does. */
async function chooseLook(page: Page, theme: string) {
  await page.getByRole('combobox', { name: 'Look of the graph' }).click();
  await page.getByRole('listbox', { name: 'Look of the graph' }).getByRole('option', { name: LOOK_NAMES[theme], exact: true }).click();
  await expect(page.locator('.memory-sky')).toHaveAttribute('data-look', theme);
}

for (const mode of ['2D', '3D']) {
  test(`the ${mode} toolbar's look, colour and switches are the portal's own controls`, async ({ page }) => {
    await portal(page);
    await page.goto('/memory?view=graph');
    await page.getByRole('button', { name: mode, exact: true }).click();
    // The look: the portal's dropdown, not the system's, the same in both views.
    const look = page.getByRole('combobox', { name: 'Look of the graph' });
    await expect(look).toHaveClass(/ui-select/);
    await look.click();
    const list = page.getByRole('listbox', { name: 'Look of the graph' });
    await expect(list.getByRole('option')).toHaveText(['Constellation', 'Galaxy', 'Brain', 'Fireflies', 'Double helix']);
    await expect(list.getByRole('option', { name: 'Constellation' })).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(look).toHaveText('Brain');
    await expect(page.locator('.memory-sky')).toHaveAttribute('data-look', 'brain');
    // The colour: a button like the dropdown beside it, with a popover of the portal's own.
    const colour = page.getByRole('button', { name: "Colour of the brain's outline" });
    await expect(colour).toHaveClass(/ui-select/);
    await colour.click();
    await expect(page.getByRole('dialog', { name: "Colour of the brain's outline" })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: "Colour of the brain's outline" })).toHaveCount(0);
    const switches = page.getByRole('list', { name: 'What the colours are' });
    if (mode === '2D') {
      // The type switches stand in a strip above the picture.
      await expect(switches).toBeVisible();
      await expect(page.getByRole('button', { name: 'Which notes are shown' })).toHaveCount(0);
      return;
    }
    // In 3D they are a button like the others, with a popover that shuts on Escape and on a press outside it.
    const filter = page.getByRole('button', { name: 'Which notes are shown' });
    await expect(filter).toHaveClass(/ui-select/);
    await filter.click();
    await expect(filter).toHaveAttribute('aria-expanded', 'true');
    await expect(switches).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(switches).toHaveCount(0);
    await expect(filter).toBeFocused();
    await filter.click();
    await page.mouse.click(10, 400);
    await expect(switches).toHaveCount(0);
  });
}

for (const [width, height] of [[1280, 800], [390, 800]]) {
  test(`with many notes and long names the card says the whole title, inside the graph and off its own star, ${width} wide`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await portal(page, { notes: 140, longNames: true });
    await page.goto('/memory?view=graph');
    const graph = page.getByRole('group', { name: /140 notes/ });
    await expect(graph).toBeVisible();
    await settled(page);
    const box = (await graph.boundingBox())!;
    const found = await stars(page);
    expect(found.length).toBeGreaterThan(100);
    // Nothing is written on it, whatever the number of notes.
    expect(await visibleText(page)).toEqual([]);
    // Pointed at, in the middle and at the edges of the picture, a card is the one thing written.
    const edges = [found.reduce((a, b) => (a.x < b.x ? a : b)), found.reduce((a, b) => (a.x > b.x ? a : b)), found.reduce((a, b) => (a.y < b.y ? a : b)), found.reduce((a, b) => (a.y > b.y ? a : b)), found[Math.floor(found.length / 2)]];
    for (const star of edges) {
      await page.mouse.move(star.x, star.y);
      const card = page.locator('.memory-sky .pointer-events-none.absolute');
      await expect(card).toContainText(/How the release of branch \d+ goes out to the test host/);
      // Put where its star is by the next frame.
      await frames(page);
      const c = (await card.boundingBox())!;
      expect(c.x).toBeGreaterThanOrEqual(box.x - 0.5);
      expect(c.x + c.width).toBeLessThanOrEqual(box.x + box.width + 0.5);
      expect(c.y).toBeGreaterThanOrEqual(box.y - 0.5);
      expect(c.y + c.height).toBeLessThanOrEqual(box.y + box.height + 0.5);
      // Not over the star it names.
      expect(star.y < c.y - 2 || star.y > c.y + c.height + 2 || star.x < c.x - 2 || star.x > c.x + c.width + 2).toBe(true);
    }
    await page.mouse.move(box.x + 2, box.y + 2);
    await expect.poll(() => visibleText(page)).toEqual([]);
  });
}

test('the view and its look are kept in this browser, and nothing is written on the graph in either view, in any of its looks', async ({ page }) => {
  await countCanvasText(page);
  await portal(page);
  await page.goto('/memory?view=graph');
  await expect(page.getByRole('button', { name: '2D' })).toHaveAttribute('aria-pressed', 'true');
  const sky = page.locator('.memory-sky');
  await expect(sky.locator('canvas')).toBeVisible();
  await expect(sky).toHaveAttribute('data-flat', 'true');
  await expect(page.getByRole('combobox', { name: 'Look of the graph' })).toHaveText('Constellation');
  /** Every look in turn, and not a word on it. */
  const quiet = async () => {
    for (const theme of ['stellar', 'galaxy', 'brain', 'fireflies', 'helix']) {
      await chooseLook(page, theme);
      await frames(page);
      expect(await visibleText(page)).toEqual([]);
      expect(await page.evaluate(() => (window as any).written)).toBe(0);
    }
  };
  await quiet();
  await chooseLook(page, 'fireflies');
  await page.reload();
  await expect(page.getByRole('combobox', { name: 'Look of the graph' })).toHaveText('Fireflies');
  await page.getByRole('button', { name: '3D' }).click();
  await expect(sky.locator('canvas')).toBeVisible();
  await expect(sky).not.toHaveAttribute('data-flat', /./);
  // No strip of switches, no line of counts, no labels: only the picture and its zoom buttons.
  await expect(page.getByRole('list', { name: 'What the colours are' })).toBeHidden();
  await expect(page.getByText('— drag to move')).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('button', { name: '3D' })).toHaveAttribute('aria-pressed', 'true');
  await expect(sky.locator('canvas')).toBeVisible();
  // The look chosen in the other view is the look of this one.
  await expect(page.getByRole('combobox', { name: 'Look of the graph' })).toHaveText('Fireflies');
  await quiet();
  await chooseLook(page, 'fireflies');
  await page.reload();
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
  await expect(sky).toHaveAttribute('data-flat', 'true');
  await expect(page.getByText('— drag to move')).toBeVisible();
});

/** Each look's secret, and the gesture that sets it off in 3D. */
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

test("the constellation's secret plays in 2D too, and writes nothing while it plays", async ({ page }) => {
  await countCanvasText(page);
  await portal(page, { notes: 40 });
  await page.goto('/memory?view=graph');
  const sky = page.locator('.memory-sky');
  await expect(sky).toHaveAttribute('data-flat', 'true');
  await frames(page);
  await secrets[0][2](page);
  await expect(sky).toHaveAttribute('data-easter-egg', 'meteor-shower');
  expect(await visibleText(page)).toEqual([]);
  await expect(sky).not.toHaveAttribute('data-easter-egg', /./, { timeout: 15_000 });
  expect(await page.evaluate(() => (window as any).written)).toBe(0);
});

test('with less motion asked for, the looks hold still in both views and play no secrets', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await portal(page);
  await page.goto('/memory?view=graph');
  const canvas = page.locator('.memory-sky canvas');
  for (const mode of ['2D', '3D']) {
    await page.getByRole('button', { name: mode, exact: true }).click();
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
  }
});

/** How many pixels of the canvas are mostly green, the colour the test gives the brain. */
const greenPixels = (page: Page) =>
  page.locator('.memory-sky canvas').evaluate((c: HTMLCanvasElement) => {
    const data = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < data.length; i += 4) if (data[i + 1] > 35 && data[i + 1] > 2 * data[i] && data[i + 1] > 2 * data[i + 2]) n++;
    return n;
  });

for (const mode of ['2D', '3D']) {
  test(`the brain's outline is drawn in the colour chosen for it, and the colour is kept, in ${mode}`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await portal(page);
    await page.goto('/memory?view=graph');
    await page.getByRole('button', { name: mode, exact: true }).click();
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
}

for (const [width, height, mode] of [[1280, 800, '2D'], [390, 800, '2D'], [1280, 800, '3D'], [390, 800, '3D']] as const) {
  test(`the brain's colour popover stays inside the window, ${mode} ${width} wide`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await portal(page);
    await page.goto('/memory?view=graph');
    await page.getByRole('button', { name: mode, exact: true }).click();
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
  const first = await picture(page);
  expect(await picture(page)).toBe(first);
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2 + 40, { steps: 8 });
  await page.mouse.up();
  const turned = await picture(page);
  expect(turned).not.toBe(first);
  await page.getByRole('button', { name: 'Show all of it' }).click();
  expect(await picture(page)).toBe(first);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -300);
  expect(await picture(page)).not.toBe(first);
  await page.getByRole('button', { name: 'Show all of it' }).click();
  await page.getByRole('button', { name: 'Zoom in' }).click();
  expect(await picture(page)).not.toBe(first);
});

test('in 2D a drag moves the view without turning it, the wheel zooms toward the pointer, and Show all of it sets it back', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await portal(page, { notes: 12 });
  await page.goto('/memory?view=graph');
  const canvas = page.locator('.memory-sky canvas');
  await expect(canvas).toBeVisible();
  await settled(page);
  const first = await stars(page);
  expect(first).toHaveLength(12);
  const box = (await canvas.boundingBox())!;
  // The background taken hold of and moved: every star goes where the pointer went, and none of them moves against another.
  await page.mouse.move(box.x + 20, box.y + 20);
  await page.mouse.down();
  await page.mouse.move(box.x + 20 + 70, box.y + 20 + 40, { steps: 8 });
  await page.mouse.up();
  await frames(page);
  const moved = await stars(page);
  expect(moved).toHaveLength(12);
  for (const star of first) expect(moved.some((m) => Math.hypot(m.x - (star.x + 70), m.y - (star.y + 40)) < 1.5)).toBe(true);
  // The wheel over a star: it stays where it is, and the rest go out from it, each by the same factor.
  const middle = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const under = moved.reduce((a, b) => (Math.hypot(a.x - middle.x, a.y - middle.y) < Math.hypot(b.x - middle.x, b.y - middle.y) ? a : b));
  await page.mouse.move(under.x, under.y);
  for (let i = 0; i < 2; i++) await page.mouse.wheel(0, -100);
  // Pointed at, a star and its neighbours light and the rest dim: so look at them with the pointer out of the way.
  const stay = { x: under.x, y: under.y };
  await page.mouse.move(box.x + 3, box.y + 3);
  await frames(page);
  const zoomed = await stars(page);
  expect(zoomed.some((z) => Math.hypot(z.x - stay.x, z.y - stay.y) < 1.5)).toBe(true);
  expect(zoomed.length).toBeGreaterThan(4);
  const goesOut = (before: { x: number; y: number }[], after: { x: number; y: number }[], from: { x: number; y: number }, factor: number) =>
    after.every((a) => before.some((b) => Math.hypot(from.x + (a.x - from.x) / factor - b.x, from.y + (a.y - from.y) / factor - b.y) < 1.5));
  expect(goesOut(moved, zoomed, stay, 1.12 ** 2)).toBe(true);
  await page.getByRole('button', { name: 'Show all of it' }).click();
  await frames(page);
  const back = await stars(page);
  for (const star of first) expect(back.some((b) => Math.hypot(b.x - star.x, b.y - star.y) < 0.5)).toBe(true);
  // The buttons zoom about the middle of the view.
  await page.getByRole('button', { name: 'Zoom in' }).click();
  await frames(page);
  const closer = await stars(page);
  expect(closer.length).toBeGreaterThan(3);
  expect(goesOut(back, closer, middle, 1.3)).toBe(true);
});

test('the constellation turns by itself in 3D and holds still in 2D', async ({ page }) => {
  await portal(page, { notes: 20 });
  await page.goto('/memory?view=graph');
  await expect(page.locator('.memory-sky canvas')).toBeVisible();
  // The strip over the picture is complete, so that it does not move under it.
  await expect(page.getByText('Query paths')).toBeVisible();
  /** What part of the stars seen a moment later are where a star was before, in the canvas's own pixels (a twinkling star may be too dim to see in one of the two). */
  const stayed = async () => {
    await frames(page);
    const canvas = page.locator('.memory-sky canvas');
    const [first, from] = [await stars(page), (await canvas.boundingBox())!];
    await page.waitForTimeout(1500);
    const [later, to] = [await stars(page), (await canvas.boundingBox())!];
    expect(first.length).toBeGreaterThan(10);
    expect(later.length).toBeGreaterThan(10);
    return later.filter((b) => first.some((a) => Math.hypot(a.x - from.x - (b.x - to.x), a.y - from.y - (b.y - to.y)) < 1.5)).length / later.length;
  };
  expect(await stayed()).toBeGreaterThan(0.6);
  await page.getByRole('button', { name: '3D' }).click();
  await expect(page.locator('.memory-sky')).not.toHaveAttribute('data-flat', /./);
  expect(await stayed()).toBeLessThan(0.3);
});

test('a browser whose storage cannot be used still draws the graph, and switches it', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', { get() { throw new Error('blocked'); } });
  });
  await portal(page);
  await page.goto('/memory?view=graph');
  await expect(page.getByRole('group', { name: /3 notes/ }).locator('canvas')).toBeVisible();
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
