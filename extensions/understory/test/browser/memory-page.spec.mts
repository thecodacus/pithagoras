import { type Locator, type Page } from '@playwright/test';
import { test, expect, mockPortal, reply, DONE, HANG } from '../../../../tests/browser/portal-mock';

test.use({ installed: ['extensions/docker', 'extensions/understory'] });

/** Where Understory's server half answers: its routes, under the address the portal gives the package. */
const BASE = '/api/x/pithagoras-understory';

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

/**
 * The runs of Understory's own agent the portal tells of: a change, and a question that went through two notes. The notation is written as
 * Understory writes it: a file name and no folder, the number of notes a search found and not which, how it ended last.
 */
const TRACES = [
  { id: 't1', kind: 'mutation', input: 'Persist the following knowledge', startedAt: '2026-09-28T09:17:47Z', notation: 'browse layout → write branches.md → ✓', usage: { inputTokens: 9683, outputTokens: 2000 } },
  { id: 't2', kind: 'query', input: 'Who runs the test host?', startedAt: '2026-09-28T09:20:11Z', notation: 'search "test host" (2) → read branches.md → read owner.md → ✓', usage: { inputTokens: 4100, outputTokens: 310 } },
];
/** One step of a run as Understory keeps it, with the full path of each note it touched. */
const step = (tool: string, paths: string[] = [], write = false, summary = paths[0] ?? '') => ({ tool, summary, paths, write });
/** What each of them did, step by step (Understory's /api/trace): `hang` and `fail` for a run that does not answer. */
const RUNS: Record<string, ReturnType<typeof step>[] | 'hang' | 'fail'> = {
  t1: [step('list_directory'), step('write_concept', ['/deployment/branches.md'], true)],
  t2: [step('search_knowledge', ['/deployment/branches.md', '/people/owner.md'], false, 'test host'), step('read_concept', ['/deployment/branches.md']), step('read_concept', ['/people/owner.md'])],
};
/** More notes in the graph, for runs that go by names two notes share, or one with a space in it. */
const MORE = [
  { path: '/projects/a/setup.md', title: 'Setup of project A', type: 'Project', links: 0 },
  { path: '/projects/b/setup.md', title: 'Setup of project B', type: 'Project', links: 0 },
  { path: '/x/my owner.md', title: 'My owner notes', type: 'Person', links: 0 },
];

/** The portal with Understory as the memory, or not, over canned answers. */
const healthy = { healthy: true, orphans: [], brokenLinks: [], issues: [] };
const broken1 = { healthy: false, orphans: [], brokenLinks: [{ path: '/deployment/branches.md', target: '/people/owner.md' }], issues: [] };

async function portal(page: Page, { enabled = true, broken = false, conformant = true, writable = true, afterDelete = broken1 as any, notes = 0, longNames = false, traces = TRACES as any[], runs = RUNS, more = [] as any[], librarian = [] as (string | typeof HANG)[] } = {}) {
  const asked: string[] = [];
  // What the librarian is asked, and what it answers (a stream, per question, in order).
  const chats: any[][] = [];
  const changes: { method: string; path: string; body?: any }[] = [];
  let logCleared = false;
  let wiped = false;
  await mockPortal(page, async (ask) => {
    const { path: p, method, url, json } = ask;
    if (p === `${BASE}/state`) return { enabled, url: 'http://127.0.0.1:3800/mcp', managed: { available: true, container: 'running', config: { llm: { source: 'auto' }, dreamInterval: '' }, providers: [], pulling: { active: false }, lastDream: { at: '2026-09-28T14:00:00Z', ok: true, ran: true, said: '1 file changed — mended the link' } } };
    if (p === `${BASE}/health`) return writable ? { writable: true, health: healthy } : { writable: false };
    if (p === `${BASE}/chat` && method === 'POST') {
      chats.push(json().messages);
      const answer = librarian[chats.length - 1];
      if (answer === HANG) return HANG;
      await ask.route.fulfill({ status: 200, contentType: 'text/event-stream', body: answer ?? '' });
      return DONE;
    }
    if (p === `${BASE}/concept` && method === 'PUT') {
      const sent = json();
      changes.push({ method: 'PUT', path: sent.path, body: sent });
      const stamped = { ...sent.frontmatter, timestamp: '2026-09-28T14:00:00.000Z' };
      // As Understory has it: the write answers the text as it was sent, and the file it made ends in a newline, which every read then shows.
      concepts[sent.path] = { path: sent.path, frontmatter: stamped, body: sent.body.endsWith('\n') ? sent.body : `${sent.body}\n` };
      return { concept: { path: sent.path, frontmatter: stamped, body: sent.body }, health: healthy };
    }
    if (p === `${BASE}/concept` && method === 'DELETE') {
      changes.push({ method: 'DELETE', path: url.searchParams.get('path')! });
      return { health: afterDelete };
    }
    if (p === `${BASE}/reindex`) {
      changes.push({ method: 'POST', path: p });
      return { pruned: ['/empty'], reindexed: 3, health: { ...broken1 } };
    }
    if (p === `${BASE}/repair`) {
      changes.push({ method: 'POST', path: p });
      return { ran: true, summary: '**Fixed** the link from [branches](/deployment/branches.md).\n\n## What changed\n\n- removed the dangling link', filesChanged: ['/deployment/branches.md'], health: healthy };
    }
    if (p === `${BASE}/wipe`) {
      changes.push({ method: 'POST', path: p });
      wiped = true;
      logCleared = true;
      return { health: healthy };
    }
    if (p === `${BASE}/clear-log`) {
      changes.push({ method: 'POST', path: p });
      logCleared = true;
      return { health: healthy };
    }
    if (p.startsWith(`${BASE}/`)) {
      asked.push(`${p}${url.search}`);
      if (broken) return reply(502, { error: 'Could not reach Understory at http://127.0.0.1:3800: it did not answer in time.' });
      if (p === `${BASE}/tree`) return wiped ? { name: '/', path: '/', kind: 'directory', children: [{ name: 'index.md', path: '/index.md', kind: 'reserved' }, { name: 'log.md', path: '/log.md', kind: 'reserved' }] } : tree;
      if (p === `${BASE}/validate`) return conformant ? { conformant: true, conceptCount: 2, directoryCount: 2, issues: [] } : { conformant: false, conceptCount: 2, directoryCount: 2, issues: [{ path: '/people/owner.md', severity: 'warning', message: 'No description in its frontmatter' }] };
      // Newest first, as Understory keeps it.
      if (p === `${BASE}/log`) return logCleared ? [] : [
        { date: '2026-09-28', action: 'Update', summary: 'Linked [Branch Deployment on Test Host](/deployment/branches.md) to its owner.' },
        { date: '2026-09-27', action: 'Creation', summary: 'Added [The owner](/people/owner.md).' },
      ];
      if (p === `${BASE}/graph` && notes) return {
        // A long memory: every note linked to the one before, and to one a few places back.
        nodes: Array.from({ length: notes }, (_, i) => ({ path: `/n${i}.md`, title: longNames ? `How the release of branch ${i} goes out to the test host` : `Note ${i}`, type: i % 3 ? 'Person' : 'Deployment Process', links: 2 })),
        edges: Array.from({ length: notes - 1 }, (_, i) => ({ source: `/n${i}.md`, target: `/n${i + 1}.md` })).concat(Array.from({ length: Math.floor(notes / 7) }, (_, i) => ({ source: `/n${i * 7}.md`, target: `/n${(i * 7 + 5) % notes}.md` }))),
      };
      if (p === `${BASE}/graph`) return {
        nodes: [
          { path: '/deployment/branches.md', title: 'Branch Deployment on Test Host', type: 'Deployment Process', description: 'The test host deploys branches using deploy-branch.sh.', links: 1 },
          { path: '/people/owner.md', title: 'The owner', type: 'Person', links: 1 },
          { path: '/loose.md', title: 'A loose note', links: 0 },
          ...more,
        ],
        edges: [{ source: '/deployment/branches.md', target: '/people/owner.md' }],
      };
      if (p === `${BASE}/traces`) return traces;
      if (p === `${BASE}/trace`) {
        const id = url.searchParams.get('id')!;
        const run = runs[id];
        if (run === 'hang') return HANG;
        if (!run || run === 'fail') return reply(run ? 502 : 404, { error: run ? 'Understory did not answer' : 'trace not found' });
        const notation: string = traces.find((t) => t.id === id)?.notation ?? '';
        // As Understory ends a run: by the last step of its notation.
        const outcome = notation.endsWith('⚠ partial') ? 'partial' : notation.endsWith('✗') ? 'failed' : 'success';
        return { ...traces.find((t) => t.id === id), steps: run.map((one, i) => ({ seq: i + 1, ...one })), outcome };
      }
      if (p === `${BASE}/search`) return url.searchParams.get('q') === 'deploy' ? [{ path: '/deployment/branches.md', title: 'Branch Deployment on Test Host', description: 'The test host deploys branches.' }] : [];
      if (p === `${BASE}/concept`) {
        const c = concepts[url.searchParams.get('path') ?? ''];
        if (!c) return reply(404, { error: 'Concept not found' });
        return c;
      }
    }
  }, { settings: true });
  return { asked, changes, chats };
}

const notes = (page: Page) => page.getByRole('navigation', { name: 'Notes' });

const sidebar = (page: Page) => page.getByRole('complementary', { name: 'Sidebar' });

test('the sidebar has Memory only while Understory is the memory', async ({ page }) => {
  const stateAsked = page.waitForRequest((r) => new URL(r.url()).pathname === `${BASE}/state`);
  await portal(page, { enabled: false });
  await page.goto('/sessions');
  await stateAsked;
  await expect(sidebar(page).getByRole('button', { name: 'Sessions' }).first()).toBeVisible();
  await expect(sidebar(page).getByRole('button', { name: 'Memory' })).toHaveCount(0);
});

test("Memory, among the extensions' pages in the sidebar, opens the tree, with each note's type and Understory's own files set apart", async ({ page }) => {
  const { asked } = await portal(page);
  await page.goto('/sessions');
  await sidebar(page).getByRole('group', { name: 'Extensions' }).getByRole('button', { name: 'Memory' }).click();
  await expect(page).toHaveURL(/\/x\/pithagoras-understory\/memory$/);
  await expect(notes(page).getByRole('button', { name: /Branch Deployment on Test Host/ })).toContainText('Deployment Process');
  await expect(notes(page).getByRole('button', { name: /deployment\// })).toHaveAttribute('aria-expanded', 'true');
  await expect(notes(page).getByRole('button', { name: 'log.md' }).locator('span.italic')).toBeVisible();
  await expect(page.getByRole('button', { name: 'conformant' })).toBeVisible();
  await expect(page.getByText('2 notes in 2 folders')).toBeVisible();
  // A folder shuts.
  await notes(page).getByRole('button', { name: /people\// }).click();
  await expect(notes(page).getByRole('button', { name: /The owner/ })).toHaveCount(0);
  // Nothing here writes.
  expect(asked.every((a) => /^\/api\/x\/pithagoras-understory\/(tree|log|concept|search|graph|traces|validate)/.test(a))).toBe(true);
});

test('a note opens with its type, tags and time; its links open other notes, and Back returns', async ({ page }) => {
  await portal(page);
  await page.goto('/x/pithagoras-understory/memory');
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
  await page.goto('/x/pithagoras-understory/memory');
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
  await page.goto('/x/pithagoras-understory/memory?view=graph');
  // A group and not a picture: its notes are buttons that Tab reaches, which a picture would make presentational.
  const graph = page.getByRole('group', { name: /3 notes, 1 link/ });
  await expect(graph).toBeVisible();
  await expect(page.getByRole('img', { name: /3 notes, 1 link/ })).toHaveCount(0);
  // In space, on a canvas, in the first look.
  await expect(graph).toHaveAttribute('data-theme-3d', 'stellar');
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
  const lines = (await Promise.all([faint(found[0], found[1]), faint(found[0], found[2]), faint(found[1], found[2])])).filter((d) => d > 40);
  expect(lines).toHaveLength(1);
  // See-through: dimmer than the stars it joins.
  expect(lines[0]).toBeLessThan(await lightAt(page, found[0].x, found[0].y, 2));
  // What the colours are is the filter's: switches in a popover.
  await page.getByRole('button', { name: 'Which notes are shown' }).click();
  const legend = page.getByRole('list', { name: 'What the colours are' });
  await expect(legend).toContainText('Deployment Process');
  await expect(legend).toContainText('orphan (unlinked)');
  await page.keyboard.press('Escape');
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

test('a graph of a long memory opens, and each frame draws each note once, however the pointer moves over it', async ({ page }) => {
  await portal(page, { notes: 1500 });
  // Counted from before the page starts: the pictures a frame stamps, and the frames.
  await page.addInitScript(() => {
    const w = window as any;
    w.stamped = 0;
    w.framesRun = 0;
    const was = CanvasRenderingContext2D.prototype.drawImage;
    CanvasRenderingContext2D.prototype.drawImage = function (this: CanvasRenderingContext2D, ...args: any[]) {
      w.stamped++;
      return (was as any).apply(this, args);
    } as any;
    const raf = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (callback: FrameRequestCallback) => raf((time) => (w.framesRun++, callback(time)));
  });
  await page.goto('/x/pithagoras-understory/memory?view=graph');
  const graph = page.getByRole('group', { name: /1,?500 notes/ });
  await expect(graph).toBeVisible({ timeout: 30_000 });
  // Every note is on the canvas, and in the list a screen reader and Tab reach.
  await expect(graph.locator('canvas')).toBeVisible();
  await expect(graph.locator('ul button')).toHaveCount(1500);
  await settled(page);
  // Taking hold of the picture, moving it, rolling the wheel and pointing at what is under the pointer: all that is the next frame's to draw, never a drawing of its own.
  await page.evaluate(() => Object.assign(window, { stamped: 0, framesRun: 0 }));
  const box = (await graph.boundingBox())!;
  await page.mouse.move(box.x + box.width - 5, box.y + box.height - 5);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 105, box.y + box.height - 105, { steps: 60 });
  await page.mouse.up();
  for (let i = 0; i < 6; i++) await page.mouse.wheel(0, -100);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 30 });
  await frames(page);
  const { stamped, framesRun } = await page.evaluate(() => ({ stamped: (window as any).stamped, framesRun: (window as any).framesRun }));
  expect(framesRun).toBeGreaterThan(0);
  // A glow for each note, once in a frame (a few more for the lamp of the look and the like); drawn on every pointer move, it would be many times that.
  expect(stamped).toBeGreaterThan(1500);
  expect(stamped / framesRun).toBeLessThan(1500 * 1.5);
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
/** Which note a star is: the name its card says while the pointer is on it, after the pointer has been away, so that the card of the star before is not read for it. */
const nameAt = async (page: Page, star: { x: number; y: number }) => {
  await page.mouse.move(5, 5);
  await expect.poll(() => visibleText(page)).toEqual([]);
  await page.mouse.move(star.x, star.y);
  await expect.poll(() => visibleText(page)).not.toEqual([]);
  return (await visibleText(page))[0];
};
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

test('a note is a glowing point and its name shows only while it is pointed at', async ({ page }) => {
  await countCanvasText(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await portal(page);
  await page.goto('/x/pithagoras-understory/memory?view=graph');
  const graph = page.getByRole('group', { name: /3 notes, 1 link/ });
  await expect(graph.locator('canvas')).toBeVisible();
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
    named[await nameAt(page, star)] = star;
    expect((await visibleText(page)).length).toBeGreaterThanOrEqual(2);
  }
  expect(Object.keys(named).sort()).toEqual(['A loose note', 'Branch Deployment on Test Host', 'The owner']);
  expect(await page.evaluate(() => (window as any).written)).toBe(0);
  // The notes it links with light up, and the rest steps back.
  const loose = named['A loose note'];
  const owner = named['The owner'];
  // Drawn again for the pointer being away: a frame after the card has gone.
  await page.mouse.move(5, 5);
  await expect.poll(() => visibleText(page)).toEqual([]);
  await frames(page);
  const rest = { loose: await lightAt(page, loose.x, loose.y, 2), owner: await lightAt(page, owner.x, owner.y, 2) };
  await page.mouse.move(named['Branch Deployment on Test Host'].x, named['Branch Deployment on Test Host'].y);
  await expect(page.getByText('The test host deploys branches using deploy-branch.sh.')).toBeVisible();
  await expect.poll(() => lightAt(page, loose.x, loose.y, 2)).toBeLessThan(rest.loose - 40);
  expect(await lightAt(page, owner.x, owner.y, 2)).toBeGreaterThan(rest.owner - 15);
  // Pointing away puts it all back; Tab reaches a note the same way.
  await page.mouse.move(5, 5);
  await expect.poll(() => visibleText(page)).toEqual([]);
  await expect.poll(() => lightAt(page, loose.x, loose.y, 2)).toBeGreaterThan(rest.loose - 15);
  await graph.getByRole('button', { name: 'The owner' }).focus();
  await expect.poll(() => visibleText(page)).toContain('The owner');
  expect(await page.evaluate(() => (window as any).written)).toBe(0);
});

test('the note last opened is lit and in the middle when the graph is back, until the background is clicked', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await portal(page);
  await page.goto('/x/pithagoras-understory/memory?view=graph');
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

test('the type switches filter the graph, and what the search found is marked', async ({ page }) => {
  await portal(page);
  await page.goto('/x/pithagoras-understory/memory?view=graph');
  await page.getByRole('button', { name: 'Which notes are shown' }).click();
  const legend = page.getByRole('list', { name: 'What the colours are' });
  await legend.getByRole('button', { name: 'Person' }).click();
  await expect(legend.getByRole('button', { name: 'Person' })).toHaveAttribute('aria-pressed', 'false');
  let graph = page.getByRole('group', { name: /2 notes, 0 links/ });
  await expect(graph.locator('canvas')).toBeVisible();
  await expect(graph.getByRole('button', { name: 'Branch Deployment on Test Host' })).toHaveCount(1);
  await expect(graph.getByRole('button', { name: 'The owner' })).toHaveCount(0);
  await legend.getByRole('button', { name: 'Person' }).click();
  graph = page.getByRole('group', { name: /3 notes, 1 link/ });
  await expect(graph.getByRole('button', { name: 'The owner' })).toHaveCount(1);
  // Notes nothing links to have a switch of their own.
  await legend.getByRole('button', { name: 'orphan (unlinked)' }).click();
  await expect(page.getByRole('group', { name: /2 notes, 1 link/ }).getByRole('button', { name: 'A loose note' })).toHaveCount(0);
  await legend.getByRole('button', { name: 'orphan (unlinked)' }).click();

  await page.getByLabel('Search the memory').fill('deploy');
  await expect(graph.getByRole('button', { name: 'Branch Deployment on Test Host' })).toHaveAccessibleDescription('Matches the search');
  await expect(graph.getByRole('button', { name: 'The owner' })).not.toHaveAccessibleDescription('Matches the search');
});

/** The looks by the names the menu gives them. */
const LOOK_NAMES: Record<string, string> = { stellar: 'Constellation', galaxy: 'Galaxy', brain: 'Brain', fireflies: 'Fireflies', helix: 'Double helix' };
/** Picks a look from the toolbar's menu, as a person does. */
async function chooseLook(page: Page, theme: string) {
  await page.getByRole('combobox', { name: 'Look of the 3D view' }).click();
  await page.getByRole('listbox', { name: 'Look of the 3D view' }).getByRole('option', { name: LOOK_NAMES[theme], exact: true }).click();
  await expect(page.locator('.memory-sky')).toHaveAttribute('data-theme-3d', theme);
}

test("the toolbar's look, colour and filter are the portal's own controls", async ({ page }) => {
  await portal(page);
  await page.goto('/x/pithagoras-understory/memory?view=graph');
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
  await expect(page.locator('.memory-sky')).toHaveAttribute('data-theme-3d', 'brain');
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

for (const [width, height] of [[1280, 800], [390, 800]]) {
  test(`with many notes and long names the card says the whole title, inside the graph and off its own star, ${width} wide`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await portal(page, { notes: 140, longNames: true });
    await page.goto('/x/pithagoras-understory/memory?view=graph');
    const graph = page.getByRole('group', { name: /140 notes/ });
    await expect(graph.locator('canvas')).toBeVisible();
    await settled(page);
    const box = (await graph.boundingBox())!;
    // The stars in front are bright; some at the back are too dim to find in the picture.
    const found = await stars(page);
    expect(found.length).toBeGreaterThan(20);
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

test('the look is kept in this browser, and nothing is written on the graph in any of its looks', async ({ page }) => {
  await countCanvasText(page);
  await portal(page);
  await page.goto('/x/pithagoras-understory/memory?view=graph');
  const sky = page.locator('.memory-sky');
  await expect(sky.locator('canvas')).toBeVisible();
  // No strip of switches, no line of counts, no labels: only the picture and its zoom buttons.
  await expect(page.getByRole('list', { name: 'What the colours are' })).toBeHidden();
  await expect(page.getByText('— drag to move')).toHaveCount(0);
  const look = page.getByRole('combobox', { name: 'Look of the 3D view' });
  await expect(look).toHaveText('Constellation');
  for (const theme of ['stellar', 'galaxy', 'brain', 'fireflies', 'helix']) {
    await chooseLook(page, theme);
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
  await expect(page.getByRole('combobox', { name: 'Look of the 3D view' })).toHaveText('Fireflies');
});

test('a view chosen when the graph had two, kept in this browser, falls back to the one it has', async ({ page }) => {
  // What an earlier version left behind: a graph that was flat.
  await page.addInitScript(() => {
    localStorage.setItem('memoryGraph.view', '2d');
  });
  await portal(page);
  await page.goto('/x/pithagoras-understory/memory?view=graph');
  const graph = page.getByRole('group', { name: /3 notes, 1 link/ });
  await expect(graph.locator('canvas')).toBeVisible();
  await expect(graph).toHaveAttribute('data-theme-3d', 'stellar');
  // No switch between views is left.
  await expect(page.getByRole('button', { name: '2D', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '3D', exact: true })).toHaveCount(0);
  await expect(page.getByRole('combobox', { name: 'Look of the 3D view' })).toHaveText('Constellation');
});

/** Each look's secret, and the gesture that sets it off. */
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
    await page.goto('/x/pithagoras-understory/memory?view=graph');
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

test('with less motion asked for, the looks hold still and play no secrets', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await portal(page);
  await page.goto('/x/pithagoras-understory/memory?view=graph');
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
  await page.goto('/x/pithagoras-understory/memory?view=graph');
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
    await page.goto('/x/pithagoras-understory/memory?view=graph');
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

test('a drag turns the view, the wheel zooms, and Show all of it sets it back', async ({ page }) => {
  // Without the drift, the same view is the same picture.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await portal(page);
  await page.goto('/x/pithagoras-understory/memory?view=graph');
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

test("a browser that cannot keep the graph's choices still draws the graph, and switches its look", async ({ page }) => {
  await portal(page);
  // The graph's own keys cannot be read or written, as in a window with its site data blocked; the setup assistant's flag can be, so that it stays away.
  await page.addInitScript(() => {
    const { getItem, setItem } = Storage.prototype;
    const blocked = (key: string) => key.startsWith('memoryGraph.');
    Storage.prototype.getItem = function (this: Storage, key: string) {
      if (blocked(key)) throw new Error('blocked');
      return getItem.call(this, key);
    };
    Storage.prototype.setItem = function (this: Storage, key: string, value: string) {
      if (blocked(key)) throw new Error('blocked');
      return setItem.call(this, key, value);
    };
  });
  await page.goto('/x/pithagoras-understory/memory?view=graph');
  await expect(page.getByRole('group', { name: /3 notes/ }).locator('canvas')).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Look of the 3D view' })).toHaveText('Constellation');
  await chooseLook(page, 'helix');
  await expect(page.locator('.memory-sky canvas')).toBeVisible();
});

test.describe('on a touch screen', () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 800 } });

  test('the first tap on a note says what it is and lights it, the second opens it, and a tap on the background lets go', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await portal(page);
    await page.goto('/x/pithagoras-understory/memory?view=graph');
    const graph = page.getByRole('group', { name: /3 notes, 1 link/ });
    await expect(graph.locator('canvas')).toBeVisible();
    await settled(page);
    // Which star is which: pointed at with a mouse, each says its name in its card.
    const named: Record<string, { x: number; y: number }> = {};
    for (const star of await stars(page)) named[await nameAt(page, star)] = star;
    const [branch, owner, loose] = [named['Branch Deployment on Test Host'], named['The owner'], named['A loose note']];
    expect(branch && owner && loose).toBeTruthy();
    await page.mouse.move(5, 5);
    await expect.poll(() => visibleText(page)).toEqual([]);
    await frames(page);
    const rest = await lightAt(page, loose.x, loose.y, 2);
    const shown = () => visibleText(page).then((text) => text[0]);
    // The first tap: what it is, and it lit with those it links with; nothing opens.
    await page.touchscreen.tap(branch.x, branch.y);
    await expect.poll(shown).toBe('Branch Deployment on Test Host');
    await expect(page.getByRole('article')).toHaveCount(0);
    await expect.poll(() => lightAt(page, loose.x, loose.y, 2)).toBeLessThan(rest - 40);
    // A tap on another note says what that is, and opens neither.
    await page.touchscreen.tap(owner.x, owner.y);
    await expect.poll(shown).toBe('The owner');
    await expect(page.getByRole('article')).toHaveCount(0);
    // A tap on the empty background lets go.
    const box = (await graph.locator('canvas').boundingBox())!;
    await page.touchscreen.tap(box.x + 6, box.y + box.height - 6);
    await expect.poll(() => visibleText(page)).toEqual([]);
    await expect.poll(() => lightAt(page, loose.x, loose.y, 2)).toBeGreaterThan(rest - 15);
    await expect(page.getByRole('article')).toHaveCount(0);
    // The second tap on the same note opens it.
    await page.touchscreen.tap(branch.x, branch.y);
    await expect.poll(shown).toBe('Branch Deployment on Test Host');
    await page.touchscreen.tap(branch.x, branch.y);
    await expect(page.getByRole('article', { name: 'Branch Deployment on Test Host' })).toBeVisible();
  });

  test('a note a finger tapped, then filtered away, takes its card and its lighting with it', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await portal(page);
    await page.goto('/x/pithagoras-understory/memory?view=graph');
    const graph = page.getByRole('group', { name: /3 notes, 1 link/ });
    await expect(graph.locator('canvas')).toBeVisible();
    await settled(page);
    const named: Record<string, { x: number; y: number }> = {};
    for (const star of await stars(page)) named[await nameAt(page, star)] = star;
    const [owner, loose] = [named['The owner'], named['A loose note']];
    await page.mouse.move(5, 5);
    await expect.poll(() => visibleText(page)).toEqual([]);
    await frames(page);
    const rest = await lightAt(page, loose.x, loose.y, 2);
    await page.touchscreen.tap(owner.x, owner.y);
    await expect.poll(() => visibleText(page).then((text) => text[0])).toBe('The owner');
    await expect.poll(() => lightAt(page, loose.x, loose.y, 2)).toBeLessThan(rest - 40);
    // The notes of its type are switched off: the card is gone, and the rest is not left dimmed for a note that is not there.
    await page.getByRole('button', { name: 'Which notes are shown' }).click();
    await page.getByRole('list', { name: 'What the colours are' }).getByRole('button', { name: 'Person' }).click();
    await expect(page.getByRole('group', { name: /2 notes, 0 links/ })).toBeVisible();
    await expect.poll(() => visibleText(page)).toEqual([]);
    await expect.poll(() => lightAt(page, loose.x, loose.y, 2)).toBeGreaterThan(rest - 15);
    // Switched on again, it does not come back with its card.
    await page.getByRole('list', { name: 'What the colours are' }).getByRole('button', { name: 'Person' }).click();
    await expect(page.getByRole('group', { name: /3 notes, 1 link/ })).toBeVisible();
    await frames(page);
    expect(await visibleText(page)).toEqual([]);
  });

  test('two fingers moving apart zoom the graph about the middle of them', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await portal(page, { notes: 12 });
    await page.goto('/x/pithagoras-understory/memory?view=graph');
    const canvas = page.locator('.memory-sky canvas');
    await expect(canvas).toBeVisible();
    await settled(page);
    const before = await stars(page);
    expect(before.length).toBeGreaterThan(5);
    const box = (await canvas.boundingBox())!;
    const middle = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const cdp = await page.context().newCDPSession(page);
    const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', gap: number) =>
      cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x: middle.x - gap / 2, y: middle.y, id: 1 }, { x: middle.x + gap / 2, y: middle.y, id: 2 }] });
    // From 80 to 120 pixels apart: half as close again.
    await touch('touchStart', 80);
    for (let gap = 85; gap <= 120; gap += 5) await touch('touchMove', gap);
    await touch('touchEnd', 0);
    await frames(page);
    const after = await stars(page);
    expect(after.length).toBeGreaterThan(3);
    // Every star left in the picture is where one was, moved out from the middle by the same 1.5.
    for (const star of after) {
      const was = { x: middle.x + (star.x - middle.x) / 1.5, y: middle.y + (star.y - middle.y) / 1.5 };
      expect(before.some((b) => Math.hypot(b.x - was.x, b.y - was.y) < 3)).toBe(true);
    }
    // Nothing was opened by it.
    await expect(page.getByRole('article')).toHaveCount(0);
  });
});

/** Opens the list of Query paths, as a person does. */
const openPaths = async (page: Page) => {
  await page.getByRole('button', { name: 'Query paths' }).click();
  return page.getByRole('list', { name: 'Query paths' });
};
/** A run in that list: its row, the button that keeps it lit, the toggle of its steps (which are in the row once it is open), and opening it. */
const aRun = (list: Locator, question: RegExp) => {
  const row = list.getByRole('listitem').filter({ hasText: question });
  const toggle = row.locator('button[aria-expanded]');
  return {
    row,
    pin: row.locator('button[aria-pressed]'),
    toggle,
    /** Opened with its toggle, as a person does, unless it is open. */
    open: async () => {
      if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
      await expect(toggle).toHaveAttribute('aria-expanded', 'true');
      return row;
    },
  };
};

test('Query paths lists the runs of Understory with the path each took, what it cost, and whether it changed the memory', async ({ page }) => {
  await portal(page, {
    traces: [
      ...TRACES,
      { id: 't3', kind: 'query', input: 'What was asked of the librarian?', startedAt: '2026-09-28T09:25:00Z', notation: 'browse layout → ✓' },
      { id: 't4', kind: 'query', input: 'What does the old note say?', startedAt: '2026-09-28T09:26:00Z', notation: 'read gone.md → ✓' },
    ],
    runs: { ...RUNS, t3: [step('list_directory')], t4: [step('read_concept', ['/gone.md'])] },
  });
  await page.goto('/x/pithagoras-understory/memory?view=graph');
  await expect(page.locator('.memory-sky canvas')).toBeVisible();
  // Closed to begin with, so that the graph has the room.
  await expect(page.getByRole('list', { name: 'Query paths' })).toHaveCount(0);
  const list = await openPaths(page);
  const [changed, queried, noted, goneOne] = [aRun(list, /Persist the following knowledge/), aRun(list, /Who runs the test host/), aRun(list, /What was asked of the librarian/), aRun(list, /What does the old note say/)];
  // Every run is a row of its question, what it cost and its dot, the steps shut away until it is opened.
  await expect(list.locator('button[aria-expanded="false"]')).toHaveCount(4);
  await expect(queried.row).not.toContainText('branches.md');
  // The tokens, in the chat's own writing.
  await expect(changed.row).toContainText('9.7k→2k tok');
  await expect(queried.row).toContainText('4.1k→310 tok');
  await expect(noted.row).toContainText('?→? tok');
  // A change and a question differ by colour, and a path is its steps, in order, each note one of them names marked with a glow.
  const [change, query, nothing, gone] = [await changed.open(), await queried.open(), await noted.open(), await goneOne.open()];
  await expect(change.locator('[data-run-dot]')).toHaveClass(/text-warn/);
  await expect(query.locator('[data-run-dot]')).toHaveClass(/text-accent/);
  await expect(query).toContainText(/search\s*"test host" \(2\)\s*read\s*branches\.md\s*read\s*owner\.md\s*✓/);
  // The two reads have a glow each, and the search that found both has none: it only found them. The change has one, for the note it wrote.
  await expect(query.locator('span[style*="box-shadow"]')).toHaveCount(2);
  await expect(change.locator('span[style*="box-shadow"]')).toHaveCount(1);
  // One that touched no note says so, and so does one that touched a note that is not in the graph any more.
  await expect(nothing.locator('span[style*="box-shadow"]')).toHaveCount(0);
  await expect(nothing).toContainText('This run touched no note');
  await expect(gone.locator('span[style*="box-shadow"]')).toHaveCount(0);
  await expect(gone).toContainText('No note of this path is in the graph');
  await expect(query).not.toContainText('touched no note');
  await expect(query).not.toContainText('No note of this path is in the graph');
  // Shut by Escape and by a press outside it, like the other popovers.
  await page.keyboard.press('Escape');
  await expect(list).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Query paths' })).toBeFocused();
  await openPaths(page);
  await page.mouse.click(10, 400);
  await expect(page.getByRole('list', { name: 'Query paths' })).toHaveCount(0);
});

test('with no run of Understory on record, no Query paths are offered', async ({ page }) => {
  await portal(page, { traces: [] });
  await page.goto('/x/pithagoras-understory/memory?view=graph');
  await expect(page.locator('.memory-sky canvas')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Query paths' })).toHaveCount(0);
});

test('pointing at a path lights its notes and the links between them in the graph, a click keeps it, and a second lets it go', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await portal(page);
  await page.goto('/x/pithagoras-understory/memory?view=graph');
  const graph = page.getByRole('group', { name: /3 notes, 1 link/ });
  await expect(graph.locator('canvas')).toBeVisible();
  await settled(page);
  // Which star is which: pointed at, each says its name in its card.
  const named: Record<string, { x: number; y: number }> = {};
  for (const star of await stars(page)) named[await nameAt(page, star)] = star;
  const [branch, owner, loose] = [named['Branch Deployment on Test Host'], named['The owner'], named['A loose note']];
  expect(branch && owner && loose).toBeTruthy();
  // Drawn again for the pointer being away: a frame after the card has gone.
  await page.mouse.move(5, 5);
  await expect.poll(() => visibleText(page)).toEqual([]);
  await frames(page);
  const middle = { x: (branch.x + owner.x) / 2, y: (branch.y + owner.y) / 2 };
  const link = () => lightAt(page, middle.x, middle.y, 1);
  const rest = { loose: await lightAt(page, loose.x, loose.y, 2), owner: await lightAt(page, owner.x, owner.y, 2), branch: await lightAt(page, branch.x, branch.y, 2), link: await link() };
  /** The note nothing in the path touches has stepped back: its star is less lit than at rest. */
  const dimmed = async () => (await lightAt(page, loose.x, loose.y, 2)) < rest.loose - 40;
  const restored = async () => (await lightAt(page, loose.x, loose.y, 2)) > rest.loose - 15;

  const list = await openPaths(page);
  const query = aRun(list, /Who runs the test host/).pin;
  // Pointed at: the two notes it went through stay, the link between them is lit, and the note it never came to steps back.
  await query.hover();
  await expect.poll(() => dimmed()).toBe(true);
  expect(await lightAt(page, owner.x, owner.y, 2)).toBeGreaterThan(rest.owner - 15);
  expect(await lightAt(page, branch.x, branch.y, 2)).toBeGreaterThan(rest.branch - 15);
  expect(await link()).toBeGreaterThan(rest.link + 100);
  await expect(graph.getByRole('button', { name: 'The owner' })).toHaveAccessibleDescription('On the path traced');
  await expect(graph.getByRole('button', { name: 'A loose note' })).not.toHaveAccessibleDescription('On the path traced');
  // Pointed away, it is as it was.
  await page.mouse.move(5, 5);
  await expect.poll(() => restored()).toBe(true);
  expect(await link()).toBeLessThan(rest.link + 60);
  // Reached with Tab, it is lit the same way.
  await query.focus();
  await expect.poll(() => dimmed()).toBe(true);
  await page.getByRole('button', { name: 'Query paths' }).focus();
  await expect.poll(() => restored()).toBe(true);
  // A click keeps it lit: with the pointer away, with the list shut.
  await query.click();
  await expect(query).toHaveAttribute('aria-pressed', 'true');
  await page.mouse.move(5, 5);
  await expect.poll(() => dimmed()).toBe(true);
  await page.keyboard.press('Escape');
  await expect(list).toHaveCount(0);
  await frames(page);
  expect(await dimmed()).toBe(true);
  expect(await link()).toBeGreaterThan(rest.link + 100);
  // The button says a path is lit; the second click lets it go.
  await expect(page.getByRole('button', { name: 'Query paths' })).toHaveClass(/text-accent/);
  await openPaths(page);
  await expect(query).toHaveAttribute('aria-pressed', 'true');
  await query.click();
  await expect(query).toHaveAttribute('aria-pressed', 'false');
  await page.mouse.move(5, 5);
  await expect.poll(() => restored()).toBe(true);
  await expect(page.getByRole('button', { name: 'Query paths' })).not.toHaveClass(/text-accent/);
});

test('a run that lights nothing says why on its shut row, pointed at or kept lit, and lights nothing and dims nothing', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await portal(page, {
    traces: [
      { id: 't3', kind: 'query', input: 'What was asked of the librarian?', startedAt: '2026-09-28T09:25:00Z', notation: 'browse layout → read gone.md → ✓' },
      { id: 't4', kind: 'query', input: 'What did it find in the layout?', startedAt: '2026-09-28T09:26:00Z', notation: 'browse layout → ✓' },
      TRACES[1],
    ],
    runs: { ...RUNS, t3: [step('list_directory'), step('read_concept', ['/gone.md'])], t4: [step('list_directory')] },
  });
  await page.goto('/x/pithagoras-understory/memory?view=graph');
  await expect(page.locator('.memory-sky canvas')).toBeVisible();
  await settled(page);
  const found = await stars(page);
  expect(found).toHaveLength(3);
  const before = await Promise.all(found.map((s) => lightAt(page, s.x, s.y, 2)));
  const list = await openPaths(page);
  const [gone, bare, lights] = [aRun(list, /What was asked of the librarian/), aRun(list, /What did it find in the layout/), aRun(list, /Who runs the test host/)];
  // Shut, as they begin: the reason is on the row, in its tooltip and its description, and its dot is hollow; a run that lights notes has none of these.
  for (const [one, why] of [[gone, 'No note of this path is in the graph'], [bare, 'This run touched no note']] as const) {
    await expect(one.toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(one.pin).toHaveAttribute('title', new RegExp(`\n${why}$`));
    await expect(one.pin).toHaveAccessibleDescription(why);
    await expect(one.row.locator('[data-run-dot]')).toHaveAttribute('data-run-dot', 'dark');
    expect(await one.row.locator('[data-run-dot]').evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgba(0, 0, 0, 0)');
    // Pointed at and kept lit, it still lights nothing and dims nothing, and stays shut.
    await one.pin.hover();
    await frames(page);
    expect(await Promise.all(found.map((s) => lightAt(page, s.x, s.y, 2)))).toEqual(before);
    await one.pin.click();
    await page.mouse.move(5, 5);
    await frames(page);
    expect(await Promise.all(found.map((s) => lightAt(page, s.x, s.y, 2)))).toEqual(before);
    await expect(one.pin).toHaveAttribute('aria-pressed', 'true');
    await expect(one.toggle).toHaveAttribute('aria-expanded', 'false');
    await one.pin.click();
  }
  await expect(lights.pin).toHaveAttribute('title', 'Who runs the test host?');
  await expect(lights.row.locator('[data-run-dot]')).toHaveAttribute('data-run-dot', 'lit');
  // Opened, the same words are under its steps.
  await gone.open();
  await expect(gone.row.locator('p')).toHaveText('No note of this path is in the graph');
});

for (const width of [390, 1280]) test(`the list of paths is at most half the window tall and scrolls, and nothing in it makes the page scroll sideways, ${width} wide`, async ({ page }) => {
  await page.setViewportSize({ width, height: 800 });
  const many = Array.from({ length: 40 }, (_, i) => ({
    id: `t${i}`,
    kind: i % 3 ? 'query' : 'mutation',
    input: `A long question ${i} about how the branches of the test host are deployed and who asked for it`,
    startedAt: '2026-09-28T09:20:11Z',
    notation: 'browse layout → read /deployment/branches.md → read ../people/owner.md → read the-notes-about-everything-the-owner-ever-said-about-the-test-host.md → write /deployment/branches.md → ✓',
    usage: { inputTokens: 4100 + i, outputTokens: 310 },
  }));
  await portal(page, { traces: many });
  await page.goto('/x/pithagoras-understory/memory?view=graph');
  await expect(page.locator('.memory-sky canvas')).toBeVisible();
  const list = await openPaths(page);
  await expect(list.getByRole('listitem')).toHaveCount(30);
  // Inside the window, short, scrolling by itself.
  const popover = page.locator('div.float-in-down').filter({ has: list });
  const box = (await popover.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(width);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(800);
  const sizes = await list.evaluate((el) => ({ scroll: el.scrollHeight, shown: el.clientHeight, across: el.scrollWidth, wide: el.clientWidth }));
  expect(sizes.scroll).toBeGreaterThan(sizes.shown * 2);
  expect(sizes.shown).toBeLessThanOrEqual(800 * 0.5 + 1);
  expect(sizes.across).toBeLessThanOrEqual(sizes.wide + 1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  // The last of them can be got to, and tapped.
  const last = list.getByRole('listitem').last().locator('button[aria-pressed]');
  await last.scrollIntoViewIfNeeded();
  await last.click();
  await expect(last).toHaveAttribute('aria-pressed', 'true');
  // Kept lit it is still shut; opened with its toggle, with its long names: they are cut, and do not widen the list.
  await expect(list.getByRole('listitem').last()).not.toContainText('the-notes-about');
  await list.getByRole('listitem').last().locator('button[aria-expanded]').click();
  await expect(list.getByRole('listitem').last()).toContainText('the-notes-about');
  expect(await list.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
});

/**
 * What a person reads inside `root`: each element with text of its own, with its size, and its colour as it shows against what is behind
 * it. A colour or a background that lets the page through (its own alpha, or the `opacity` of it or of anything it is in) is laid over
 * what is behind it; where `root` floats over the picture, over each colour of `under`, and the worst of them counts.
 */
const readable = (root: Locator, under: number[][] = []) =>
  root.evaluate((top, under) => {
    const parse = (c: string) => (c.match(/[\d.]+/g) ?? []).map(Number);
    const alphaOf = (c: number[]) => (c.length > 3 ? c[3] : 1);
    /** How much of an element shows through opacity: its own, and that of everything it is in. */
    const shown = (from: Element | null) => {
      let a = 1;
      for (let n = from; n; n = n.parentElement) a *= parseFloat(getComputedStyle(n).opacity);
      return a;
    };
    const over = (back: number[], colour: number[], alpha: number) => [0, 1, 2].map((i) => colour[i] * alpha + back[i] * (1 - alpha));
    const floating = top.closest('.memory-sky');
    return [top, ...top.querySelectorAll('*')].flatMap((el) => {
      const text = [...el.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent ?? '').join('').trim();
      if (!text) return [];
      const layers: { colour: number[]; alpha: number }[] = [];
      for (let n: Element | null = el; n && n !== floating; n = n.parentElement) {
        const colour = parse(getComputedStyle(n).backgroundColor);
        const alpha = alphaOf(colour) * shown(n);
        if (colour.length >= 3 && alpha > 0) layers.unshift({ colour, alpha });
      }
      const behind = floating ? under : [[255, 255, 255]];
      const written = parse(getComputedStyle(el).color);
      return behind.map((base) => {
        const back = layers.reduce((back, layer) => over(back, layer.colour, layer.alpha), base);
        return { text, size: parseFloat(getComputedStyle(el).fontSize), colour: over(back, written, alphaOf(written) * shown(el)), back };
      });
    });
  }, under);
/** The WCAG contrast of a colour on another. */
const contrast = (a: number[], b: number[]) => {
  const light = (c: number[]) => c.slice(0, 3).map((v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
  const [hi, lo] = [Math.max(light(a), light(b)), Math.min(light(a), light(b))];
  return (hi + 0.05) / (lo + 0.05);
};
/** What a card or a popover says, each piece at the portal's body size or more, and at least 4.5 to 1 against what is behind it. */
const expectReadable = (seen: Awaited<ReturnType<typeof readable>>, what: string) => {
  expect(seen.length, `${what} says something`).toBeGreaterThan(3);
  for (const piece of seen) {
    expect(piece.size, `${what}: "${piece.text}" is ${piece.size}px`).toBeGreaterThanOrEqual(14);
    expect(contrast(piece.colour, piece.back), `${what}: "${piece.text}" on ${piece.back.map(Math.round)}`).toBeGreaterThanOrEqual(4.5);
  }
};

for (const scheme of ['dark', 'light'] as const) {
  for (const [width, height] of [[1280, 800], [390, 800]]) {
    test(`the card over a star and the list of paths are written at the body size, and can be read, ${scheme} ${width} wide`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
      await portal(page, {
        traces: [
          ...TRACES,
          { id: 't3', kind: 'query', input: 'What was asked of the librarian?', startedAt: '2026-09-28T09:25:00Z', notation: 'browse layout → ✓', usage: { inputTokens: 900, outputTokens: 40 } },
          { id: 't4', kind: 'query', input: 'What does the old note say?', startedAt: '2026-09-28T09:26:00Z', notation: 'read gone.md → ⚠ partial', usage: { inputTokens: 800, outputTokens: 30 } },
        ],
        runs: { ...RUNS, t3: [step('list_directory')], t4: [step('read_concept', ['/gone.md'])] },
      });
      await page.goto('/x/pithagoras-understory/memory?view=graph');
      await expect(page.locator('html')).toHaveAttribute('data-theme', scheme);
      const graph = page.getByRole('group', { name: /3 notes, 1 link/ });
      await expect(graph.locator('canvas')).toBeVisible();
      await settled(page);
      // The card of a note with everything it can say: name, type, links and a description. Under it is the picture: dark, or lit by a star.
      const named: Record<string, { x: number; y: number }> = {};
      for (const star of await stars(page)) named[await nameAt(page, star)] = star;
      const star = named['Branch Deployment on Test Host'];
      await page.mouse.move(5, 5);
      await expect.poll(() => visibleText(page)).toEqual([]);
      await page.mouse.move(star.x, star.y);
      const card = page.locator('.memory-sky .pointer-events-none.absolute');
      await expect(card).toContainText('The test host deploys branches using deploy-branch.sh.');
      expectReadable(await readable(card, [[10, 10, 12], [20, 26, 58], [255, 255, 255]]), 'the card');
      // The list: the question, what it cost, the steps and what is said of a path with no note in it; and the one kept lit, behind which the accent shows.
      await page.mouse.move(5, 5);
      const list = await openPaths(page);
      await expect(list.getByRole('listitem')).toHaveCount(4);
      const popover = page.locator('div.float-in-down').filter({ has: list });
      expectReadable(await readable(popover), 'the list, shut');
      // Opened, with the steps of each run in view, and both lines that say a run lit nothing: it touched no note, and its note is not in the graph. They must be on the screen to be measured.
      const [change, query] = [aRun(list, /Persist the following knowledge/), aRun(list, /Who runs the test host/)];
      for (const one of [change, query, aRun(list, /What was asked of the librarian/), aRun(list, /What does the old note say/)]) await one.open();
      await expect(popover).toContainText('This run touched no note');
      await expect(popover).toContainText('No note of this path is in the graph');
      await expect(popover).toContainText('⚠ partial');
      const seen = await readable(popover);
      expect(seen.some((piece) => piece.text === 'This run touched no note')).toBe(true);
      expect(seen.some((piece) => piece.text === 'No note of this path is in the graph')).toBe(true);
      expectReadable(seen, 'the list, open');
      await query.pin.click();
      expectReadable(await readable(popover), 'the list with a path kept');
      // The steps are not squeezed: each is as wide as its words.
      for (const chip of await query.row.locator('span.rounded-full.border').all()) expect((await chip.boundingBox())!.width).toBeGreaterThan(30);
    });
  }
}

for (const [width, height] of [[1280, 800], [390, 800]]) {
  for (const fancy of [false, true]) {
    test(`a popover of the toolbar unrolls from its top edge, where its button is, ${fancy ? 'with' : 'without'} the extra animations, ${width} wide`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      if (fancy) await page.addInitScript(() => localStorage.setItem('animations', 'on'));
      await portal(page);
      await page.goto('/x/pithagoras-understory/memory?view=graph');
      await expect(page.locator('.memory-sky canvas')).toBeVisible();
      if (fancy) await expect(page.locator('html')).toHaveAttribute('data-motion', 'fancy');
      else await expect(page.locator('html')).not.toHaveAttribute('data-motion', 'fancy');
      for (const name of ['Query paths', 'Which notes are shown']) {
        const button = page.getByRole('button', { name });
        await button.click();
        const popover = page.locator('div.float-in-down');
        await expect(popover).toHaveCount(1);
        const seen = await popover.evaluate((el, fancy) => {
          // Stopped a moment after it began: which part of it is there, and which is not yet?
          const animation = el.getAnimations().find((a) => (a as CSSAnimation).animationName.endsWith('float-in-down'))!;
          animation.pause();
          animation.currentTime = fancy ? 20 : 40;
          const box = el.getBoundingClientRect();
          const inside = (x: number, y: number) => el.contains(document.elementFromPoint(x, y));
          const keyframes = (animation.effect as KeyframeEffect).getKeyframes();
          const result = {
            name: (animation as CSSAnimation).animationName,
            origin: getComputedStyle(el).transformOrigin,
            height: box.height,
            fromAbove: parseFloat(String(keyframes[0].translate).split(' ')[1]) < 0,
            topShown: inside(box.left + box.width / 2, box.top + 6),
            bottomShown: inside(box.left + box.width / 2, box.bottom - 6),
          };
          animation.finish();
          return result;
        }, fancy);
        expect(seen.name).toBe(fancy ? 'fx-float-in-down' : 'float-in-down');
        // Unrolled from the top: it starts a little above where it comes to rest, its top edge is the first of it there, and the bottom is the last.
        expect(seen.fromAbove).toBe(true);
        expect(seen.topShown, `the top of ${name} is there first`).toBe(true);
        expect(seen.bottomShown, `the bottom of ${name} is not there yet`).toBe(false);
        if (fancy) expect(seen.origin.split(' ')[1]).toBe('0px');
        // Done, it is whole, and under its button: on the side of it that the unrolling began from.
        await frames(page);
        const box = (await popover.boundingBox())!;
        const at = (await button.boundingBox())!;
        expect(box.y).toBeGreaterThanOrEqual(at.y + at.height - 1);
        await page.keyboard.press('Escape');
        await expect(popover).toHaveCount(0);
      }
    });
  }
}

test('a step goes by the path Understory gives for it: a file name two notes share lights one, a search lights none, a name with a space lights its own', async ({ page }) => {
  await portal(page, {
    more: MORE,
    traces: [
      { id: 'a', kind: 'query', input: 'How is project A set up?', startedAt: '2026-09-28T10:00:00Z', notation: 'search "setup" (2) → read setup.md → ✓' },
      { id: 'b', kind: 'query', input: 'Is there a note called branches.md?', startedAt: '2026-09-28T10:01:00Z', notation: 'search "branches.md" (0) → browse layout → ✓' },
      { id: 'c', kind: 'query', input: 'What did my owner say?', startedAt: '2026-09-28T10:02:00Z', notation: 'read my owner.md → ✓' },
      // Understory writes a query as it was asked, so a joint of its own can be in it.
      { id: 'd', kind: 'query', input: 'How do I go from deploy to prod?', startedAt: '2026-09-28T10:03:00Z', notation: 'search "deploy -> prod → stage" (1) → read branches.md → ✓' },
    ],
    runs: {
      a: [step('search_knowledge', ['/projects/a/setup.md', '/projects/b/setup.md'], false, 'setup'), step('read_concept', ['/projects/a/setup.md'])],
      b: [step('search_knowledge', [], false, 'branches.md'), step('list_directory')],
      c: [step('read_concept', ['/x/my owner.md'])],
      d: [{ ...step('search_knowledge', ['/deployment/branches.md']), summary: 'deploy -> prod → stage' }, step('read_concept', ['/deployment/branches.md'])],
    },
  });
  await page.goto('/x/pithagoras-understory/memory?view=graph');
  const graph = page.getByRole('group', { name: /6 notes, 1 link/ });
  await expect(graph.locator('canvas')).toBeVisible();
  const list = await openPaths(page);
  const [a, b, c, d] = ['How is project A', 'Is there a note called', 'What did my owner', 'How do I go from deploy'].map((name) => aRun(list, new RegExp(name)));
  const lit = async () => (await Promise.all([...(await graph.getByRole('button').all())].map(async (button) => ((await button.getAttribute('aria-description')) === 'On the path traced' ? await button.textContent() : null)))).filter(Boolean).sort();
  for (const one of [a, b, c, d]) await one.open();
  // `read setup.md` is one of two notes; the step says which, and the search that found both lights neither.
  await a.pin.hover();
  await expect.poll(lit).toEqual(['Setup of project A']);
  await expect(a.row.locator('span[style*="box-shadow"]')).toHaveCount(1);
  await expect(a.row).not.toContainText('No note of this path');
  // A search for a file's name touched no note, and the one with that name is not lit.
  await b.pin.hover();
  await expect.poll(lit).toEqual([]);
  await expect(b.row).toContainText('This run touched no note');
  // A name with a space in it is its own note, not the one whose name is the end of it.
  await c.pin.hover();
  await expect.poll(lit).toEqual(['My owner notes']);
  // A query with arrows in it is one step, not cut in pieces, and the note the run read is lit all the same.
  await d.pin.hover();
  await expect.poll(lit).toEqual(['Branch Deployment on Test Host']);
  await expect(d.row.locator('span.rounded-full.border').first()).toContainText(/search\s*"deploy -> prod → stage" \(1\)/);
  await expect(d.row.locator('span.rounded-full.border')).toHaveCount(2);
});

test('the end of a run is told as Understory ends it, and a run is a change by what it did, whoever asked', async ({ page }) => {
  await portal(page, {
    traces: [
      { id: 'a', kind: 'query', input: 'A run that came to part of it', startedAt: '2026-09-28T10:00:00Z', notation: 'read branches.md → ⚠ partial' },
      { id: 'b', kind: 'chat', input: 'Note that the owner runs the test host', startedAt: '2026-09-28T10:01:00Z', notation: 'search "owner" (1) → write owner.md → ✓' },
      { id: 'c', kind: 'mutation', input: 'A change that failed before it wrote', startedAt: '2026-09-28T10:02:00Z', notation: 'search "owner" (0) → ✗' },
      { id: 'd', kind: 'query', input: 'A run that failed', startedAt: '2026-09-28T10:03:00Z', notation: 'browse layout → ✗' },
    ],
    runs: {
      a: [step('read_concept', ['/deployment/branches.md'])],
      b: [step('search_knowledge', ['/people/owner.md'], false, 'owner'), step('write_concept', ['/people/owner.md'], true)],
      c: [step('search_knowledge', [], false, 'owner')],
      d: [step('list_directory')],
    },
  });
  await page.goto('/x/pithagoras-understory/memory?view=graph');
  await expect(page.locator('.memory-sky canvas')).toBeVisible();
  const list = await openPaths(page);
  const opened: Locator[] = [];
  for (const name of ['came to part', 'Note that the owner', 'failed before it wrote', 'A run that failed']) opened.push(await aRun(list, new RegExp(name)).open());
  const [partial, chat, failedChange, failed] = opened;
  // How it ended is its last step, in its own words, and its own colour.
  await expect(partial).toContainText('⚠ partial');
  await expect(partial.locator('span.bg-current').last()).toHaveClass(/text-warn/);
  await expect(failed.locator('span.bg-current').last()).toHaveClass(/text-danger/);
  // The librarian that wrote a note changed the memory, though it is a chat; a change that wrote nothing did not.
  await expect(chat.locator('[data-run-dot]')).toHaveClass(/text-warn/);
  await expect(failedChange.locator('[data-run-dot]')).toHaveClass(/text-accent/);
});

test('a run whose steps have not come says nothing of its notes, and lights none; one whose steps cannot come is told by its words alone', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await portal(page, { runs: { t1: 'hang', t2: 'fail' } });
  await page.goto('/x/pithagoras-understory/memory?view=graph');
  const graph = page.getByRole('group', { name: /3 notes, 1 link/ });
  await expect(graph.locator('canvas')).toBeVisible();
  const list = await openPaths(page);
  const [change, query] = [aRun(list, /Persist the following knowledge/), aRun(list, /Who runs the test host/)];
  for (const [one, word] of [[change, 'write'], [query, 'read']] as const) {
    // The words, not the notes: no glow, and nothing said of whether it touched any.
    const run = await one.open();
    await expect(run).toContainText(word);
    await expect(run.locator('span[style*="box-shadow"]')).toHaveCount(0);
    await expect(run).not.toContainText('touched no note');
    await expect(run).not.toContainText('No note of this path');
    await run.hover();
    await frames(page);
    await expect(graph.getByRole('button', { name: 'The owner' })).not.toHaveAccessibleDescription('On the path traced');
  }
  // A change asked for is still told by its asking, until its steps say otherwise.
  await expect(change.row.locator('[data-run-dot]')).toHaveClass(/text-warn/);
});

for (const [width, height] of [[1280, 800], [390, 800]]) {
  test(`ten runs, shut, fit the list without scrolling, ${width} wide`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    const ten = Array.from({ length: 10 }, (_, i) => ({
      id: `r${i}`,
      kind: i % 3 ? 'query' : 'mutation',
      input: `A long question ${i} about how the branches of the test host are deployed and who asked for it`,
      startedAt: '2026-09-28T09:20:11Z',
      notation: 'browse layout → read branches.md → read owner.md → write branches.md → ✓',
      usage: { inputTokens: 4100 + i, outputTokens: 310 },
    }));
    await portal(page, { traces: ten });
    await page.goto('/x/pithagoras-understory/memory?view=graph');
    await expect(page.locator('.memory-sky canvas')).toBeVisible();
    const list = await openPaths(page);
    await expect(list.getByRole('listitem')).toHaveCount(10);
    // Every run is one line, and none of them is open.
    await expect(list.locator('button[aria-expanded="false"]')).toHaveCount(10);
    await expect(list).not.toContainText('branches.md');
    for (const row of await list.getByRole('listitem').all()) expect((await row.boundingBox())!.height).toBeLessThanOrEqual(40);
    // So all ten are in view: nothing to scroll, and the popover inside the window.
    const sizes = await list.evaluate((el) => ({ scroll: el.scrollHeight, shown: el.clientHeight, across: el.scrollWidth - el.clientWidth }));
    expect(sizes.scroll).toBeLessThanOrEqual(sizes.shown + 1);
    expect(sizes.across).toBeLessThanOrEqual(1);
    const box = (await page.locator('div.float-in-down').filter({ has: list }).boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    expect(box.y + box.height).toBeLessThanOrEqual(height);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    // The cost is still in each row, not cut off with the question.
    for (const row of await list.getByRole('listitem').all()) await expect(row).toContainText(/\d(\.\dk)?→310 tok/);
  });
}

test("a run opens and shuts with its toggle, by the mouse and by the keyboard, and the toggle says what it does and to which run", async ({ page }) => {
  await portal(page);
  await page.goto('/x/pithagoras-understory/memory?view=graph');
  await expect(page.locator('.memory-sky canvas')).toBeVisible();
  const list = await openPaths(page);
  const run = aRun(list, /Who runs the test host/);
  // A real button that says whether its run is open, and what it would do, with the run's question in its name.
  await expect(run.toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(run.toggle).toHaveAccessibleName(/^Show the steps\s+Who runs the test host/);
  await expect(run.row).not.toContainText('branches.md');
  await expect(run.row.locator('[id$="-steps"]')).toHaveCount(0);
  await run.toggle.click();
  await expect(run.toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(run.toggle).toHaveAccessibleName(/^Hide the steps\s+Who runs the test host/);
  const controls = await run.toggle.getAttribute('aria-controls');
  await expect(page.locator(`[id="${controls}"]`)).toContainText('branches.md');
  await expect(run.row).toContainText(/search\s*"test host" \(2\)\s*read\s*branches\.md\s*read\s*owner\.md\s*✓/);
  // The mouse having left it, it stays as the person said.
  await page.mouse.move(5, 5);
  await expect(run.toggle).toHaveAttribute('aria-expanded', 'true');
  await run.toggle.click();
  await expect(run.toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(run.row).not.toContainText('branches.md');
  // The keyboard: Tab to the run's button and on to its toggle; Enter opens, Space shuts.
  await page.getByRole('button', { name: 'Query paths' }).focus();
  await page.keyboard.press('Tab');
  await expect(aRun(list, /Persist the following knowledge/).pin).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(aRun(list, /Persist the following knowledge/).toggle).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(aRun(list, /Persist the following knowledge/).toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(aRun(list, /Persist the following knowledge/).row).toContainText('write');
  await page.keyboard.press('Space');
  await expect(aRun(list, /Persist the following knowledge/).toggle).toHaveAttribute('aria-expanded', 'false');
  // Tab goes on to the next run, one stop for its button and one for its toggle; none is skipped.
  await page.keyboard.press('Tab');
  await expect(run.pin).toBeFocused();
});

test('a run does not open on pointing alone, nor on being kept lit; its toggle opens it, and it stays as the person left it', async ({ page }) => {
  await portal(page);
  await page.goto('/x/pithagoras-understory/memory?view=graph');
  await expect(page.locator('.memory-sky canvas')).toBeVisible();
  const list = await openPaths(page);
  const [change, query] = [aRun(list, /Persist the following knowledge/), aRun(list, /Who runs the test host/)];
  await expect(list.locator('button[aria-expanded="false"]')).toHaveCount(2);
  // Pointed at, on its row and on its question, for a while: it is lit in the graph and stays shut.
  const graph = page.getByRole('group', { name: /3 notes, 1 link/ });
  await query.pin.hover();
  await page.waitForTimeout(400);
  await expect(graph.getByRole('button', { name: 'The owner' })).toHaveAccessibleDescription('On the path traced');
  await expect(query.toggle).toHaveAttribute('aria-expanded', 'false');
  await query.toggle.hover();
  await query.row.hover({ position: { x: 20, y: 6 } });
  await expect(query.toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(query.row).not.toContainText('branches.md');
  await page.mouse.move(5, 5);
  // Kept lit, it is still shut.
  await query.pin.click();
  await expect(query.pin).toHaveAttribute('aria-pressed', 'true');
  await expect(query.toggle).toHaveAttribute('aria-expanded', 'false');
  // The toggle opens it, and the pointer going away does not shut it.
  await query.toggle.click();
  await expect(query.toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(query.row).toContainText('branches.md');
  await page.mouse.move(5, 5);
  await expect(query.toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(change.toggle).toHaveAttribute('aria-expanded', 'false');
  // Open, it stays open with the list shut and opened again, and the other stays shut.
  await page.keyboard.press('Escape');
  await openPaths(page);
  await expect(query.toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(change.toggle).toHaveAttribute('aria-expanded', 'false');
  // The toggle shuts it, and pointing at it again does not open it.
  await query.toggle.click();
  await expect(query.toggle).toHaveAttribute('aria-expanded', 'false');
  await query.pin.hover();
  await page.waitForTimeout(300);
  await expect(query.toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(query.pin).toHaveAttribute('aria-pressed', 'true');
});

test('a run that is shut lights its notes in the graph all the same, pointed at, reached with Tab, or kept lit', async ({ page }) => {
  await portal(page);
  await page.goto('/x/pithagoras-understory/memory?view=graph');
  const graph = page.getByRole('group', { name: /3 notes, 1 link/ });
  await expect(graph.locator('canvas')).toBeVisible();
  const list = await openPaths(page);
  const query = aRun(list, /Who runs the test host/);
  const owner = graph.getByRole('button', { name: 'The owner' });
  const loose = graph.getByRole('button', { name: 'A loose note' });
  // Shut, as it begins: the pointer on it lights the notes of its path, and it stays shut.
  await expect(query.toggle).toHaveAttribute('aria-expanded', 'false');
  await query.pin.hover();
  await expect(query.toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(owner).toHaveAccessibleDescription('On the path traced');
  await expect(loose).not.toHaveAccessibleDescription('On the path traced');
  await page.mouse.move(5, 5);
  await expect(owner).not.toHaveAccessibleDescription('On the path traced');
  // Reached with Tab, a run that is shut lights its notes too, and stays shut.
  await query.pin.focus();
  await expect(owner).toHaveAccessibleDescription('On the path traced');
  await expect(query.toggle).toHaveAttribute('aria-expanded', 'false');
  // Kept lit with a click while it is shut, as the person left it: still shut, and lit with the pointer away and the list shut.
  await query.pin.click();
  await expect(query.pin).toHaveAttribute('aria-pressed', 'true');
  await expect(query.toggle).toHaveAttribute('aria-expanded', 'false');
  await page.mouse.move(5, 5);
  await expect(owner).toHaveAccessibleDescription('On the path traced');
  await page.keyboard.press('Escape');
  await expect(list).toHaveCount(0);
  await expect(owner).toHaveAccessibleDescription('On the path traced');
  await expect(loose).not.toHaveAccessibleDescription('On the path traced');
});

test('the search lists what matches, and says when nothing does', async ({ page }) => {
  await portal(page);
  await page.goto('/x/pithagoras-understory/memory');
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
  await page.route('**/api/x/pithagoras-understory/search*', async (route) => {
    const q = new URL(route.request().url()).searchParams.get('q');
    if (q === 'broken') return route.fulfill({ status: 502, json: { error: 'Understory did not answer' } });
    if (q === 'deploy') await held;
    return route.fallback();
  });
  await page.goto('/x/pithagoras-understory/memory');
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
  await page.goto('/x/pithagoras-understory/memory');
  await page.getByRole('button', { name: '1 issue' }).click();
  await expect(page.getByText('No description in its frontmatter')).toBeVisible();
  await page.getByRole('button', { name: '/people/owner.md' }).click();
  await expect(page.getByRole('article', { name: 'The owner' })).toBeVisible();
});

test('Understory not answering is said, with a way to try again and its page in Settings', async ({ page }) => {
  await portal(page, { broken: true });
  await page.goto('/x/pithagoras-understory/memory');
  await expect(page.getByText('The memory could not be read.')).toBeVisible();
  await expect(page.getByText(/did not answer in time/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Settings → Memory' })).toHaveAttribute('href', '/settings/x/pithagoras-understory');
});

test('on a phone the notes and what is open take turns', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await portal(page);
  await page.goto('/x/pithagoras-understory/memory');
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
  await page.goto('/x/pithagoras-understory/memory?note=%2Fpeople%2Fowner.md');
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
  await page.goto('/x/pithagoras-understory/memory?note=%2Fpeople%2Fowner.md');
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
  await page.goto('/x/pithagoras-understory/memory?note=%2Fpeople%2Fowner.md');
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
  await page.goto('/x/pithagoras-understory/memory?note=%2Fpeople%2Fowner.md');
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
  await page.goto('/x/pithagoras-understory/memory?note=%2Fdeployment%2Fbranches.md');
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
    await page.goto('/x/pithagoras-understory/memory?note=%2Fdeployment%2Fbranches.md');
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
    await page.goto('/x/pithagoras-understory/memory?note=%2Fdeployment%2Fbranches.md');
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
    await page.goto('/x/pithagoras-understory/memory?note=%2Fpeople%2Fowner.md');
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
    await page.goto('/x/pithagoras-understory/memory?note=%2Fpeople%2Fowner.md');
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
    await page.goto('/x/pithagoras-understory/memory?note=%2Fdeployment%2Fbranches.md');
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
  await page.goto('/x/pithagoras-understory/memory?note=%2Fpeople%2Fowner.md');
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
  await page.goto('/x/pithagoras-understory/memory?note=%2Fpeople%2Fowner.md');
  await page.getByRole('button', { name: 'Edit the note' }).click();
  await page.getByRole('form', { name: 'Edit the note' }).getByLabel('Text, in markdown').fill('Not saved, and then the memory is cleared.');
  await page.getByRole('button', { name: 'Clear the memory' }).click();
  await page.getByRole('alertdialog', { name: 'Clear the whole memory?' }).getByRole('button', { name: 'Clear the memory' }).click();
  await expect(page).toHaveURL(/\/x\/pithagoras-understory\/memory$/);
  // A note of the same path turns up later, and is opened.
  await page.evaluate(() => { history.pushState(null, '', '/x/pithagoras-understory/memory?note=%2Fpeople%2Fowner.md'); window.dispatchEvent(new PopStateEvent('popstate')); });
  await expect(page.getByRole('article', { name: 'The owner' })).toBeVisible();
  await expect(page.getByRole('form', { name: 'Edit the note' })).toHaveCount(0);
});

test('deleting a note asks first, then shows what it broke and offers to put it right', async ({ page }) => {
  const { changes } = await portal(page);
  await page.goto('/x/pithagoras-understory/memory?note=%2Fpeople%2Fowner.md');
  await page.getByRole('button', { name: 'Delete the note' }).click();
  await page.getByRole('button', { name: 'Cancel' }).click();
  expect(changes).toEqual([]);
  await page.getByRole('button', { name: 'Delete the note' }).click();
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page).toHaveURL(/\/x\/pithagoras-understory\/memory$/);
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
  expect(changes.map((c) => `${c.method} ${c.path}`)).toEqual(['DELETE /people/owner.md', `POST ${BASE}/reindex`, `POST ${BASE}/repair`]);
});

test("Understory's own index is not edited by hand, nor any note of one run elsewhere", async ({ page }) => {
  await portal(page);
  await page.goto('/x/pithagoras-understory/memory?note=%2Findex.md');
  await expect(page.getByRole('article', { name: 'index.md' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit the note' })).toHaveCount(0);
  await page.goto('/x/pithagoras-understory/memory?note=%2Fpeople%2Fowner.md');
  await expect(page.getByRole('button', { name: 'Edit the note' })).toBeVisible();
});

test('one run elsewhere is read only', async ({ page }) => {
  await portal(page, { writable: false });
  await page.goto('/x/pithagoras-understory/memory?note=%2Fpeople%2Fowner.md');
  await expect(page.getByRole('article', { name: 'The owner' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit the note' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Delete the note' })).toHaveCount(0);
});

test('the log can be cleared, after asking; the notes stay', async ({ page }) => {
  const { changes } = await portal(page);
  await page.goto('/x/pithagoras-understory/memory?view=log');
  const log = page.getByRole('region', { name: 'Changes to the memory' });
  await expect(log.locator('li')).toHaveCount(2);
  await page.getByRole('button', { name: 'Clear the log' }).click();
  await expect(page.getByText(/The notes stay as they are/)).toBeVisible();
  await page.getByRole('button', { name: 'Clear it' }).click();
  await expect(log.getByText('Nothing has changed yet.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Clear the log' })).toHaveCount(0);
  expect(changes.map((c) => c.path)).toEqual([`${BASE}/clear-log`]);
  await expect(page.getByRole('navigation', { name: 'Notes' }).getByRole('button', { name: /The owner/ })).toBeVisible();
});

test('one run elsewhere has no clearing of its log', async ({ page }) => {
  await portal(page, { writable: false });
  await page.goto('/x/pithagoras-understory/memory?view=log');
  await expect(page.getByRole('region', { name: 'Changes to the memory' }).locator('li')).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'Clear the log' })).toHaveCount(0);
});

test('the whole memory can be cleared, after asking: no notes, an empty index and log', async ({ page }) => {
  const { changes } = await portal(page);
  await page.goto('/x/pithagoras-understory/memory?note=%2Fpeople%2Fowner.md');
  await page.getByRole('button', { name: 'Clear the memory' }).click();
  await expect(page.getByText(/The agent forgets everything it kept here/)).toBeVisible();
  await page.getByRole('button', { name: 'Cancel' }).click();
  expect(changes).toEqual([]);
  await page.getByRole('button', { name: 'Clear the memory' }).click();
  await page.getByRole('alertdialog', { name: 'Clear the whole memory?' }).getByRole('button', { name: 'Clear the memory' }).click();
  await expect(page).toHaveURL(/\/x\/pithagoras-understory\/memory$/);
  const notes = page.getByRole('navigation', { name: 'Notes' });
  await expect(notes.getByRole('button', { name: /The owner/ })).toHaveCount(0);
  await expect(notes.getByRole('button', { name: 'log.md' })).toBeVisible();
  expect(changes.map((c) => c.path)).toEqual([`${BASE}/wipe`]);
});

test('one run elsewhere cannot be cleared from here', async ({ page }) => {
  await portal(page, { writable: false });
  await page.goto('/x/pithagoras-understory/memory');
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
  await page.goto('/x/pithagoras-understory/memory');
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
  await expect.poll(() => asked.filter((a) => a === `${BASE}/tree`).length).toBeGreaterThan(1);

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
  await page.goto('/x/pithagoras-understory/memory?view=chat');
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
  await page.goto('/x/pithagoras-understory/memory');
  await expect(page.getByRole('navigation', { name: 'Notes' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Librarian' })).toHaveCount(0);
  await page.goto('/x/pithagoras-understory/memory?view=chat');
  await expect(page.getByText('Choose a note, or open the log or the graph.')).toBeVisible();
});
