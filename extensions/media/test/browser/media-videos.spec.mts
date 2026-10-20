import { readFileSync } from 'node:fs';
import { type Page } from '@playwright/test';
import { test, expect, mockPortal, reply, DONE } from '../../../../tests/browser/portal-mock';

test.use({ installed: ['extensions/media'] });

/**
 * The videos of the Media page (src/web/MediaPage.tsx) over a portal that makes videos and no pictures: the clips of
 * its gallery, and the jobs that make more, which the test lets finish when it likes. The page with both kinds is
 * media-page.spec.mts.
 */

interface Clip {
  id: string;
  origin: 'page' | 'chat' | 'folder';
  chat: { id: string; title: string } | null;
  folder: { name: string; home: boolean } | null;
  kind: 'generated' | 'animated' | 'unknown';
  prompt: string;
  params: Record<string, unknown>;
  createdAt: number;
  bytes: number;
  fileName: string;
  poster: boolean;
  /** What the file is, as the portal tells of it; a clip that has none is a WebM, as an older portal's all are. */
  format?: { id: string; label: string; mimeType: string; playable: boolean };
  copy?: 'ready' | 'available';
  /** Why the portal could not open the file when it made the list. */
  unavailable?: 'unreachable' | 'too_large';
}
interface Job {
  id: string;
  kind: 'generate' | 'animate';
  state: 'running' | 'done' | 'failed';
  stage?: 'waiting' | 'making';
  queuePosition?: number;
  prompt: string;
  size?: string;
  from?: string;
  startedAt: number;
  finishedAt?: number;
  videoId?: string;
  error?: string;
}
interface Pic {
  id: string;
  origin: 'page';
  chat: null;
  folder: null;
  kind: 'generated' | 'uploaded';
  prompt: string;
  params: Record<string, unknown>;
  from: null;
  createdAt: number;
  bytes: number;
  fileName: string;
  thumb: boolean;
}

const WEBM = readFileSync(new URL('../../../../tests/fixtures/clip.webm', import.meta.url));
const hex = (n: number) => n.toString(16).padStart(12, '0');

let next = 1;
/** A clip of the gallery; `age` is how many minutes ago it was made. */
const clip = (over: Partial<Clip> & { age?: number } = {}): Clip => {
  const { age = 0, ...rest } = over;
  const n = next++;
  return { id: hex(n), origin: 'page', chat: null, folder: null, kind: 'generated', prompt: `Clip ${n}`, params: {}, createdAt: Date.now() - age * 60_000, bytes: 2_000_000, fileName: `video-${n}.webm`, poster: false, ...rest };
};
let pictures = 1000;
/** A picture of the gallery, to start a clip from. */
const pic = (over: Partial<Pic> = {}): Pic => {
  const n = pictures++;
  return { id: hex(n), origin: 'page', chat: null, folder: null, kind: 'generated', prompt: `Picture ${n}`, params: {}, from: null, createdAt: Date.now() - n, bytes: 100_000, fileName: `image-${n}.png`, thumb: false, ...over };
};

const svg = (id: string) => `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240"><rect width="100%" height="100%" fill="hsl(${(parseInt(id.slice(-4), 16) * 47) % 360} 55% 45%)"/></svg>`;

/** A VideosFeature as the portal tells of it. */
const feature = (over: Record<string, unknown> = {}) => {
  const f = {
    enabled: true, backend: 'sdcpp', backends: [{ id: 'sdcpp', label: 'stable-diffusion.cpp' }], baseUrl: 'https://video.example.com', model: 'video-model', size: '832x480',
    frames: 33 as number | null, fps: 16 as number | null, keySet: true, timeoutSeconds: 1800, storageLimitMb: 0, ...over,
  };
  return { ready: f.enabled && f.baseUrl !== '', ...f };
};

async function portal(page: Page, { clips = [] as Clip[], videos = feature(), flagOn = true, jobs = [] as Job[], failList = false, pictureList = [] as Pic[], noPoster = [] as string[] } = {}) {
  const list = [...clips];
  const state = {
    jobs: [...jobs], generated: [] as any[], deleted: [] as string[][], stopped: [] as string[], listed: [] as string[], files: [] as string[], posters: [] as string[], thumbs: [] as string[], copies: [] as string[], limit: 4,
  };
  const sorted = () => [...list].sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1));
  const job = (over: Partial<Job>): Job => ({ id: `j${state.jobs.length + 1}`.padEnd(12, '0'), kind: 'generate', state: 'running', prompt: '', startedAt: Date.now(), ...over });

  await mockPortal(page, async ({ path: p, method, url, json, route }) => {
    if (p === '/api/x/pithagoras-media/state') return { images: { enabled: false }, videos: { enabled: flagOn } };
    if (p === '/api/x/pithagoras-media/settings/videos') return { videos };
    if (p === '/api/x/pithagoras-media/videos' && method === 'GET') {
      state.listed.push(url.search);
      if (failList) return reply(500, { error: 'The gallery could not be read' });
      const ids = url.searchParams.get('ids');
      if (ids) return { videos: ids.split(',').map((id) => list.find((x) => x.id === id)).filter(Boolean) };
      const origin = url.searchParams.get('origin');
      const kind = url.searchParams.get('kind');
      const before = url.searchParams.get('before');
      const limit = Number(url.searchParams.get('limit') ?? 24);
      let all = sorted().filter((x) => (!origin || x.origin === origin) && (!kind || x.kind === kind));
      const total = all.length;
      if (before) {
        const [at, id] = before.split(':');
        all = all.filter((x) => x.createdAt < Number(at) || (x.createdAt === Number(at) && x.id < id));
      }
      const pageOf = all.slice(0, limit);
      const last = pageOf[pageOf.length - 1];
      return { videos: pageOf, next: all.length > limit && last ? `${last.createdAt}:${last.id}` : null, total, pageBytes: list.filter((x) => x.origin === 'page').reduce((sum, x) => sum + x.bytes, 0) };
    }
    if (p === '/api/x/pithagoras-media/videos/jobs' && method === 'GET') return { jobs: state.jobs, limit: state.limit };
    if (p.startsWith('/api/x/pithagoras-media/videos/jobs/') && method === 'DELETE') {
      const id = p.split('/').pop()!;
      state.stopped.push(id);
      state.jobs = state.jobs.filter((j) => j.id !== id);
      return { ok: true };
    }
    if (p === '/api/x/pithagoras-media/videos/generate' && method === 'POST') {
      const sent = json();
      state.generated.push(sent);
      if (sent.prompt === 'refuse me') return reply(429, { error: '4 clips are being made already: wait for one to finish, or stop one' });
      const made = Array.from({ length: sent.count ?? 1 }, () => job({ kind: sent.firstFrame || sent.lastFrame ? 'animate' : 'generate', prompt: sent.prompt, ...(sent.size ? { size: sent.size } : {}), ...(sent.firstFrame ? { from: sent.firstFrame } : {}) }));
      state.jobs.unshift(...made);
      return reply(202, { jobs: made });
    }
    if (p === '/api/x/pithagoras-media/videos/delete' && method === 'POST') {
      const { ids } = json();
      state.deleted.push(ids);
      for (const id of ids) list.splice(list.findIndex((x) => x.id === id), 1);
      return { deleted: ids, failed: [] };
    }
    if (/^\/api\/x\/pithagoras-media\/videos\/[0-9a-f]{12}\/file$/.test(p)) {
      state.files.push(p.split('/')[5]);
      await route.fulfill({ body: WEBM, contentType: 'video/webm' });
      return DONE;
    }
    // The playable copy of a clip a browser does not play: made on request, and then sent to be played.
    if (/^\/api\/x\/pithagoras-media\/videos\/[0-9a-f]{12}\/copy$/.test(p)) {
      const id = p.split('/')[5];
      const target = list.find((x) => x.id === id);
      if (method === 'POST') {
        state.copies.push(id);
        if (target) target.copy = 'ready';
        return { ok: true };
      }
      if (target?.copy !== 'ready') return reply(404, { error: 'This video has no playable copy', code: 'missing' });
      await route.fulfill({ body: WEBM, contentType: 'video/webm' });
      return DONE;
    }
    if (/^\/api\/x\/pithagoras-media\/videos\/[0-9a-f]{12}\/poster$/.test(p)) {
      const id = p.split('/')[5];
      state.posters.push(id);
      // As the portal answers for a clip ffmpeg cannot make a frame of.
      if (noPoster.includes(id)) return reply(404, { error: 'This video has no poster picture', code: 'missing' });
      await route.fulfill({ body: svg(id), contentType: 'image/svg+xml' });
      return DONE;
    }
    // The pictures a clip starts from: the pictures of the gallery.
    if (p === '/api/x/pithagoras-media/images' && method === 'GET') {
      const ids = url.searchParams.get('ids');
      if (ids) return { pictures: ids.split(',').map((id) => pictureList.find((x) => x.id === id)).filter(Boolean) };
      return { pictures: pictureList, next: null, total: pictureList.length, pageBytes: 0 };
    }
    if (/^\/api\/x\/pithagoras-media\/images\/[0-9a-f]{12}\/(thumb|file)$/.test(p)) {
      const id = p.split('/')[5];
      state.thumbs.push(id);
      await route.fulfill({ body: svg(id), contentType: 'image/svg+xml' });
      return DONE;
    }
  }, { settings: true });
  return {
    state,
    list,
    /** A running job is done: its clip is in the gallery, as the portal puts it. */
    finish(id: string, over: Partial<Clip> = {}) {
      const j = state.jobs.find((x) => x.id === id)!;
      const made = clip({ prompt: j.prompt, kind: j.kind === 'animate' ? 'animated' : 'generated', ...over });
      list.push(made);
      Object.assign(j, { state: 'done', videoId: made.id, finishedAt: Date.now() });
      return made;
    },
    fail(id: string, error: string) {
      Object.assign(state.jobs.find((x) => x.id === id)!, { state: 'failed', error, finishedAt: Date.now() });
    },
  };
}

const grid = (page: Page) => page.getByRole('list', { name: 'Videos' });
const tile = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
const cell = (page: Page, name: string) => grid(page).getByRole('listitem').filter({ has: page.getByRole('button', { name, exact: true }) });
const viewer = (page: Page) => page.getByRole('dialog', { name: 'Video viewer' });
const maker = (page: Page) => page.getByRole('region', { name: 'Make a video' });
const describe = (page: Page) => page.getByPlaceholder('Describe the video: the subject, what moves, the camera');

test('the sidebar has Media only while video generation is on and has an address', async ({ page }) => {
  await portal(page, { flagOn: false });
  // The extension asks its server half whether it is on once it is loaded: what is listed is known from its answer.
  const said = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/x/pithagoras-media/state');
  await page.goto('/sessions');
  await expect(page.getByRole('button', { name: 'Sessions' }).first()).toBeVisible();
  await said;
  await expect(page.getByRole('button', { name: 'Media' })).toHaveCount(0);
});

test('Media in the sidebar opens the page, with the videos in it: the form first, the gallery under it, newest first, each with where it is from and how long it plays', async ({ page }) => {
  const a = clip({ prompt: 'A fox in the snow', age: 30, params: { madeFrames: 33, madeFps: 16 } });
  const b = clip({ prompt: 'A red bicycle', age: 5, origin: 'chat', chat: { id: 'c1', title: 'Holiday plans' }, params: { frames: 48, fps: 24 } });
  await portal(page, { clips: [a, b] });
  await page.goto('/sessions');
  await page.getByRole('button', { name: 'Media' }).first().click();
  await expect(page).toHaveURL(/\/x\/pithagoras-media\/media$/);
  await expect(page.getByRole('heading', { name: 'Media' })).toBeVisible();
  await expect(maker(page)).toBeVisible();
  await expect(grid(page).getByRole('listitem')).toHaveCount(2);
  await expect(grid(page).getByRole('button')).toHaveCount(2);
  const names = await grid(page).getByRole('button').evaluateAll((els) => els.map((e) => e.getAttribute('title')));
  expect(names).toEqual(['A red bicycle', 'A fox in the snow']);
  const first = grid(page).getByRole('listitem').first();
  await expect(first).toContainText('Holiday plans');
  await expect(first).toContainText('2.0 s');
  await expect(first).toContainText('5m ago');
  await expect(grid(page).getByRole('listitem').last()).toContainText('2.1 s');
  await expect(grid(page).getByRole('listitem').last()).toContainText('Made');
});

test('with nothing made yet the gallery says so', async ({ page }) => {
  await portal(page);
  await page.goto('/x/pithagoras-media/media');
  await expect(page.getByText('No videos yet. Describe one above to make the first.')).toBeVisible();
});

test('a gallery that cannot be read says why', async ({ page }) => {
  await portal(page, { failList: true });
  await page.goto('/x/pithagoras-media/media');
  await expect(page.getByRole('alert')).toContainText('The gallery could not be read');
});

test('with video generation switched off the page says so, with the way to the setting, and still shows what there is', async ({ page }) => {
  // The portal says it is on and the settings say they are not: the form says what is missing.
  await portal(page, { clips: [clip({ prompt: 'Left over' })], videos: feature({ enabled: false }) });
  await page.goto('/x/pithagoras-media/media');
  await expect(maker(page)).toContainText('Video generation is switched off, or has no address.');
  await expect(maker(page).getByRole('link', { name: 'Set it up under Media in Settings' })).toHaveAttribute('href', '/settings/x/pithagoras-media');
  await expect(describe(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Make the video' })).toHaveCount(0);
  await expect(tile(page, 'Left over')).toBeVisible();
});

test('a clip is described and made: the settings go as named fields, the wait shows where it is, and the clip arrives where the wait was', async ({ page }) => {
  const p = await portal(page);
  await page.goto('/x/pithagoras-media/media');
  // What is used where a field is left empty is shown in it.
  await expect(page.getByLabel('Width')).toHaveAttribute('placeholder', '832');
  await expect(page.getByLabel('Height')).toHaveAttribute('placeholder', '480');
  await expect(page.getByLabel('Frames', { exact: true })).toHaveAttribute('placeholder', '33');
  await expect(page.getByLabel('Frame rate')).toHaveAttribute('placeholder', '16');
  await expect(maker(page)).toContainText('33 frames at 16 frames per second play for about 2.1 s.');
  await describe(page).fill('  A fox runs through the snow  ');
  await page.getByLabel('Frames', { exact: true }).fill('49');
  await page.getByLabel('Frame rate').fill('24');
  await expect(maker(page)).toContainText('49 frames at 24 frames per second play for about 2.0 s.');
  await page.getByRole('button', { name: 'Advanced' }).click();
  await page.getByLabel('Seed').fill('7');
  await page.getByLabel('Steps').fill('20');
  await page.getByLabel('Negative prompt').fill('blurry');
  await page.getByRole('button', { name: 'Make the video' }).click();
  await expect.poll(() => p.state.generated.length).toBe(1);
  expect(p.state.generated[0]).toEqual({ prompt: 'A fox runs through the snow', frames: 49, fps: 24, negativePrompt: 'blurry', seed: 7, sampleSteps: 20, count: 1 });

  // It is being made: a tile of its own, with what it is and where it is on the server.
  const making = page.locator('.image-preview', { hasText: 'Making a video' });
  await expect(making.getByRole('status')).toContainText('Making a video');
  const j = p.state.jobs[0];
  Object.assign(j, { stage: 'waiting', queuePosition: 3 });
  await expect(making).toContainText('Waiting its turn on the server: place 3');
  Object.assign(j, { stage: 'making', queuePosition: undefined });
  await expect(making).toContainText('Being made on the server');
  await expect(page.getByText('being made', { exact: true })).toBeVisible();

  // Done: the clip takes the place the wait had, in the gallery.
  const made = p.finish(j.id, { params: { madeFrames: 49, madeFps: 24 } });
  // A clip with no poster is fetched, for its first frame, once it is near the screen: the form above is long.
  await grid(page).scrollIntoViewIfNeeded();
  await expect(tile(page, 'A fox runs through the snow')).toBeVisible();
  await expect(grid(page).getByRole('listitem')).toHaveCount(1);
  await expect(cell(page, 'A fox runs through the snow')).toContainText('2.0 s');
  expect(p.state.files).toContain(made.id);
});

test('a setting that is wrong is said when the video is asked for, with the field marked, and nothing is sent', async ({ page }) => {
  const p = await portal(page);
  await page.goto('/x/pithagoras-media/media');
  await describe(page).fill('A fox');
  await page.getByLabel('Width').fill('832');
  await page.getByRole('button', { name: 'Make the video' }).click();
  await expect(maker(page).getByRole('alert')).toContainText('Set both width and height, or leave both empty.');
  await expect(page.getByLabel('Height')).toBeFocused();
  await expect(page.getByLabel('Height')).toHaveAttribute('aria-invalid', 'true');
  await page.getByLabel('Height').fill('480');
  await page.getByLabel('Frames', { exact: true }).fill('0');
  await page.getByRole('button', { name: 'Make the video' }).click();
  await expect(maker(page).getByRole('alert')).toContainText('The frames are a whole number from 1 to 1000.');
  await page.getByLabel('Frames', { exact: true }).fill('33');
  // A seed in Advanced is opened to be shown.
  await page.getByLabel('Frame rate').fill('16');
  await page.getByRole('button', { name: 'Advanced' }).click();
  await page.getByLabel('Seed').fill('-5');
  await page.getByRole('button', { name: 'Advanced' }).click();
  await page.getByRole('button', { name: 'Make the video' }).click();
  await expect(maker(page).getByRole('alert')).toContainText('The seed is a whole number');
  await expect(page.getByLabel('Seed')).toBeVisible();
  expect(p.state.generated).toEqual([]);
});

test('a request the portal refuses says why in the form', async ({ page }) => {
  await portal(page);
  await page.goto('/x/pithagoras-media/media');
  await describe(page).fill('refuse me');
  await page.getByRole('button', { name: 'Make the video' }).click();
  await expect(maker(page).getByRole('alert')).toContainText('4 clips are being made already');
});

test('a clip that is not made says why in its frame, and Dismiss takes it off the page; Stop drops one that is being made', async ({ page }) => {
  const p = await portal(page);
  await page.goto('/x/pithagoras-media/media');
  await describe(page).fill('First');
  await page.getByRole('button', { name: 'Make the video' }).click();
  await describe(page).fill('Second');
  await page.getByRole('button', { name: 'Make the video' }).click();
  await expect.poll(() => p.state.jobs.length).toBe(2);
  const [second, first] = p.state.jobs;
  p.fail(first.id, 'out of memory');
  await expect(page.getByText('No video was made', { exact: true })).toBeVisible();
  await expect(page.getByText('out of memory', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Dismiss' }).click();
  await expect(page.getByText('No video was made', { exact: true })).toHaveCount(0);
  expect(p.state.stopped).toEqual([first.id]);
  await page.getByRole('button', { name: 'Stop' }).click();
  expect(p.state.stopped).toEqual([first.id, second.id]);
  await expect(page.locator('.image-preview')).toHaveCount(0);
});

test('a clip that is not made shows its whole message in its tile, however long, and not a few lines of it', async ({ page }) => {
  const p = await portal(page);
  await page.goto('/x/pithagoras-media/media');
  await describe(page).fill('First');
  await page.getByRole('button', { name: 'Make the video' }).click();
  await expect.poll(() => p.state.jobs.length).toBe(1);
  const message = 'What the video endpoint sent is not a WebM or MP4 video, which is what a browser plays. It says output_format avi, mime_type video/x-msvideo; the file starts with 52 49 46 46 10 20 30 40; frame_count 49, resolution 832x480.';
  expect(message.length).toBeGreaterThan(200);
  p.fail(p.state.jobs[0].id, message);
  const reason = page.locator('.image-preview-failed p');
  await expect(reason).toHaveText(message);
  // Every line of it is there to be read: none is cut off by the tile, which is as high as its message.
  expect(await reason.evaluate((el) => el.scrollHeight <= el.clientHeight + 1)).toBe(true);
  const frame = (await page.locator('.image-preview-frame').boundingBox())!;
  const text = (await reason.boundingBox())!;
  expect(text.y + text.height).toBeLessThanOrEqual(frame.y + frame.height + 1);
  expect(text.height).toBeGreaterThan(60);
});

const AVI = { id: 'avi', label: 'AVI', mimeType: 'video/x-msvideo', playable: false };
const WEBM_FORMAT = { id: 'webm', label: 'WebM', mimeType: 'video/webm', playable: true };

test('a clip the portal could not open says why in its details, and keeps the format it has', async ({ page }) => {
  const away = clip({ prompt: 'On a drive', format: WEBM_FORMAT, unavailable: 'unreachable', age: 1 });
  const big = clip({ prompt: 'Grown too large', format: AVI, unavailable: 'too_large' });
  await portal(page, { clips: [away, big] });
  await page.goto('/x/pithagoras-media/media');
  // Not "Unknown": the one that is a WebM is a tile of a clip, and the AVI is an AVI.
  await expect(tile(page, 'Grown too large')).toContainText('AVI');
  await expect(tile(page, 'On a drive')).not.toContainText('Unknown');
  await tile(page, 'On a drive').click();
  await viewer(page).getByRole('button', { name: 'Details' }).click();
  const details = viewer(page).getByRole('region', { name: 'Details' });
  await expect(details).toContainText('Its file or its folder is out of reach for the moment.');
  await expect(details).toContainText('WebM');
  await page.keyboard.press('Escape');
  await expect(viewer(page)).toHaveCount(0);
  await tile(page, 'Grown too large').click();
  await viewer(page).getByRole('button', { name: 'Details' }).click();
  await expect(viewer(page).getByRole('region', { name: 'Details' })).toContainText('It is over 100 MB, which the portal does not play or send.');
});

test('a clip a browser cannot play is a tile of its own kind that opens to be downloaded, with a short note, and is never asked for as a video or a poster', async ({ page }) => {
  const avi = clip({ prompt: 'An old format', fileName: 'video-20260101-120000-ab12.avi', format: AVI, age: 1 });
  const plays = clip({ prompt: 'Plays', poster: true, format: { id: 'webm', label: 'WebM', mimeType: 'video/webm', playable: true } });
  const p = await portal(page, { clips: [avi, plays] });
  await page.goto('/x/pithagoras-media/media');
  const typed = tile(page, 'An old format');
  await expect(typed).toBeVisible();
  await expect(typed).toContainText('AVI');
  await expect(typed).toContainText('A browser cannot play it here');
  // The one that plays is a poster, as before.
  await expect(tile(page, 'Plays')).toBeVisible();
  expect(p.state.posters).toEqual([plays.id]);
  expect(p.state.files).not.toContain(avi.id);

  await typed.click();
  const open = viewer(page);
  await expect(open).toBeVisible();
  await expect(open.locator('video')).toHaveCount(0);
  await expect(open).toContainText('Its format is AVI, which a browser cannot play here.');
  const download = open.getByRole('link', { name: 'Download it' });
  await expect(download).toHaveAttribute('href', `/api/x/pithagoras-media/videos/${avi.id}/file`);
  await expect(download).toHaveAttribute('download', 'video-20260101-120000-ab12.avi');
  // Nothing to open in a tab: it would be saved, not shown.
  await expect(open.getByRole('link', { name: 'Open in a new tab' })).toHaveCount(0);
  // No ffmpeg: no copy is offered.
  await expect(open.getByRole('button', { name: 'Make a WebM copy to play' })).toHaveCount(0);
  await open.getByRole('button', { name: 'Details' }).click();
  await expect(open.getByRole('region', { name: 'Details' })).toContainText('AVI, not played here');
  expect(p.state.files).not.toContain(avi.id);
});

test('where ffmpeg is there a clip a browser cannot play offers a WebM copy to play, made on request, and the original is still downloaded', async ({ page }) => {
  const avi = clip({ prompt: 'Convert me', fileName: 'video-20260101-120000-cd34.avi', format: AVI, copy: 'available' });
  const p = await portal(page, { clips: [avi] });
  await page.goto('/x/pithagoras-media/media');
  await tile(page, 'Convert me').click();
  const open = viewer(page);
  const make = open.getByRole('button', { name: 'Make a WebM copy to play' });
  await expect(make).toBeVisible();
  expect(p.state.copies).toEqual([]);
  await make.click();
  // The copy plays where the file was offered; the original is still there to be had.
  const player = open.locator('video');
  await expect(player).toHaveAttribute('src', `/api/x/pithagoras-media/videos/${avi.id}/copy`);
  await expect(open).toContainText('A WebM copy plays here; the original AVI file is kept, and Download gives it.');
  await expect(open.getByRole('link', { name: 'Download the video' })).toHaveAttribute('href', `/api/x/pithagoras-media/videos/${avi.id}/file`);
  expect(p.state.copies).toEqual([avi.id]);

  // A copy that was made before is played at once. The viewer is closed first: Escape goes one step back in history, a moment
  // after the viewer is gone (use-back-to-close.ts), and a reload that does not wait for that step is cut short.
  await page.keyboard.press('Escape');
  await expect(viewer(page)).toHaveCount(0);
  await page.waitForFunction(() => !history.state?.pithagorasOverlay);
  await page.reload();
  await tile(page, 'Convert me').click();
  await expect(viewer(page).locator('video')).toHaveAttribute('src', `/api/x/pithagoras-media/videos/${avi.id}/copy`);
  expect(p.state.copies).toEqual([avi.id]);
});

test('a clip with a poster shows it, and one without shows its first frame from the clip itself', async ({ page }) => {
  const withPoster = clip({ prompt: 'Has a poster', poster: true });
  const without = clip({ prompt: 'Has none', poster: false, age: 1 });
  const p = await portal(page, { clips: [withPoster, without] });
  await page.goto('/x/pithagoras-media/media');
  await expect(tile(page, 'Has a poster')).toBeVisible();
  const poster = tile(page, 'Has a poster').locator('img');
  await expect(poster).toHaveAttribute('src', `/api/x/pithagoras-media/videos/${withPoster.id}/poster`);
  await expect.poll(() => p.state.posters).toContain(withPoster.id);
  const frame = tile(page, 'Has none').locator('video');
  await expect(frame).toHaveAttribute('src', `/api/x/pithagoras-media/videos/${without.id}/file`);
  await expect(frame).toHaveAttribute('preload', 'metadata');
  expect(p.state.posters).not.toContain(without.id);
  // Neither plays by itself in the grid.
  await expect(frame).toHaveJSProperty('muted', true);
  await expect(frame).toHaveJSProperty('paused', true);
});

test('a clip the portal could not make a poster of is not taken for gone: its tile shows the first frame from the clip itself and opens', async ({ page }) => {
  const odd = clip({ prompt: 'No frame for ffmpeg', poster: true });
  const p = await portal(page, { clips: [odd], noPoster: [odd.id] });
  await page.goto('/x/pithagoras-media/media');
  // The poster was asked for, said 404, and the tile went on to the clip's own first frame.
  await expect.poll(() => p.state.posters).toContain(odd.id);
  const frame = tile(page, 'No frame for ffmpeg').locator('video');
  await expect(frame).toHaveAttribute('src', `/api/x/pithagoras-media/videos/${odd.id}/file`);
  await expect(page.getByText('This video is no longer in the folder.')).toHaveCount(0);
  await expect(page.getByText('No video was made', { exact: true })).toHaveCount(0);
  await tile(page, 'No frame for ffmpeg').click();
  await expect(viewer(page).locator('video')).toHaveAttribute('src', `/api/x/pithagoras-media/videos/${odd.id}/file`);
});

test('a click on a clip plays it in the viewer, which steps through the gallery and has the page\'s buttons', async ({ page }) => {
  const a = clip({ prompt: 'First clip', age: 1, params: { size: '832x480', frames: 40, madeFrames: 33, madeFps: 16, seed: 7 } });
  const b = clip({ prompt: 'Second clip', age: 2 });
  const c = clip({ prompt: 'Third clip', age: 3 });
  await portal(page, { clips: [a, b, c] });
  await page.goto('/x/pithagoras-media/media');
  await tile(page, 'Second clip').click();
  await expect(viewer(page)).toBeVisible();
  const player = viewer(page).locator('video');
  await expect(player).toHaveAttribute('src', `/api/x/pithagoras-media/videos/${b.id}/file`);
  await expect(player).toHaveAttribute('controls', '');
  await expect(viewer(page)).toContainText('2 / 3');
  await viewer(page).getByRole('button', { name: 'Next video' }).click();
  await expect(player).toHaveAttribute('src', `/api/x/pithagoras-media/videos/${c.id}/file`);
  await expect(viewer(page).getByRole('button', { name: 'Next video' })).toBeDisabled();
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await expect(player).toHaveAttribute('src', `/api/x/pithagoras-media/videos/${a.id}/file`);
  await expect(viewer(page).getByRole('link', { name: 'Open in a new tab' })).toHaveAttribute('href', `/api/x/pithagoras-media/videos/${a.id}/file`);
  await expect(viewer(page).getByRole('link', { name: 'Download the video' })).toHaveAttribute('download', a.fileName);

  // Details: what it was made with.
  await viewer(page).getByRole('button', { name: 'Details' }).click();
  const details = viewer(page).getByRole('region', { name: 'Details' });
  await expect(details).toContainText('First clip');
  await expect(details).toContainText('832x480');
  await expect(details).toContainText('2.1 s');
  // The server rounded the frames: what it made, and what was asked for beside it.
  await expect(details).toContainText('33 (asked for 40)');
  await expect(details).toContainText('Seed');
  await expect(details).toContainText(a.fileName);

  // Closed with Escape, and focus goes back to the clip.
  await page.keyboard.press('Escape');
  await expect(viewer(page)).toHaveCount(0);
  await expect(tile(page, 'First clip')).toBeFocused();
});

test('the arrow keys step to another clip, except while the player itself has the keyboard, where they move through the clip', async ({ page }) => {
  const a = clip({ prompt: 'One', age: 1 });
  const b = clip({ prompt: 'Two', age: 2 });
  await portal(page, { clips: [a, b] });
  await page.goto('/x/pithagoras-media/media');
  await tile(page, 'One').click();
  const player = viewer(page).locator('video');
  await expect(player).toHaveAttribute('src', `/api/x/pithagoras-media/videos/${a.id}/file`);
  await player.focus();
  await page.keyboard.press('ArrowRight');
  await expect(player).toHaveAttribute('src', `/api/x/pithagoras-media/videos/${a.id}/file`);
  // With the dialog itself focused the arrow is the viewer's.
  await viewer(page).focus();
  await page.keyboard.press('ArrowRight');
  await expect(player).toHaveAttribute('src', `/api/x/pithagoras-media/videos/${b.id}/file`);
});

test('Run again makes a clip once more as it was asked for; one made from a picture needs that picture still', async ({ page }) => {
  const picture = pic({ prompt: 'Start frame' });
  const plain = clip({ prompt: 'Made once', params: { model: 'video-model', size: '640x384', frames: 33, fps: 16, seed: 5, sampleSteps: 20, negativePrompt: 'blurry', madeFrames: 33, madeFps: 16 } });
  const animated = clip({ prompt: 'Moves on', kind: 'animated', age: 1, params: { firstFrame: { picture: picture.id } } });
  const lostFrame = clip({ prompt: 'Frame lost', kind: 'animated', age: 2, params: { firstFrame: { picture: hex(999999) } } });
  const inChat = clip({ prompt: 'From a chat picture', kind: 'animated', age: 3, origin: 'chat', chat: { id: 'c1', title: 'A chat' }, params: { firstFrame: { path: 'x.png' } } });
  const found = clip({ prompt: '', origin: 'folder', folder: { name: 'work', home: false }, kind: 'unknown', age: 4 });
  const p = await portal(page, { clips: [plain, animated, lostFrame, inChat, found], pictureList: [picture] });
  await page.goto('/x/pithagoras-media/media');

  await tile(page, 'Made once').click();
  await viewer(page).getByRole('button', { name: 'Run again' }).click();
  await expect.poll(() => p.state.generated.length).toBe(1);
  // What it was made with, and none of what the server said it made.
  expect(p.state.generated[0]).toEqual({ prompt: 'Made once', model: 'video-model', size: '640x384', frames: 33, fps: 16, seed: 5, sampleSteps: 20, negativePrompt: 'blurry' });
  await expect(viewer(page)).toHaveCount(0);
  await expect(page.locator('.image-preview', { hasText: 'Making a video' })).toBeVisible();

  await tile(page, 'Moves on').click();
  await viewer(page).getByRole('button', { name: 'Run again' }).click();
  await expect.poll(() => p.state.generated.length).toBe(2);
  expect(p.state.generated[1]).toEqual({ prompt: 'Moves on', firstFrame: picture.id });

  // The picture it started from is gone: it is said, and no clip without its first frame is made in its place.
  await tile(page, 'Frame lost').click();
  await viewer(page).getByRole('button', { name: 'Run again' }).click();
  await expect(page.getByRole('alert')).toContainText('The picture this was made from is not in the gallery any more.');
  expect(p.state.generated.length).toBe(2);
  await viewer(page).getByRole('button', { name: 'Close' }).click();

  // The agent's clip from a picture of its folder, and one found with no description, have nothing to run again.
  await tile(page, 'From a chat picture').click();
  await expect(viewer(page)).toBeVisible();
  await expect(viewer(page).getByRole('button', { name: 'Run again' })).toHaveCount(0);
  await viewer(page).getByRole('button', { name: 'Details' }).click();
  await expect(viewer(page).getByRole('region', { name: 'Details' })).toContainText('x.png');
  await expect(viewer(page).getByRole('link', { name: 'Open the chat' })).toHaveAttribute('href', '/s/c1');
});

test('Run again of a clip that began and ended on pictures sends both, with its strength, and needs both in the gallery still', async ({ page }) => {
  const first = pic({ prompt: 'Start frame' });
  const last = pic({ prompt: 'End frame' });
  const both = clip({ prompt: 'From one to the other', kind: 'animated', params: { strength: 0.4, firstFrame: { picture: first.id }, lastFrame: { picture: last.id } } });
  const lostLast = clip({ prompt: 'End lost', kind: 'animated', age: 1, params: { firstFrame: { picture: first.id }, lastFrame: { picture: hex(999999) } } });
  const inChat = clip({ prompt: 'From chat pictures', kind: 'animated', age: 2, origin: 'chat', chat: { id: 'c1', title: 'A chat' }, params: { firstFrame: { picture: first.id }, lastFrame: { path: 'end.png' } } });
  const p = await portal(page, { clips: [both, lostLast, inChat], pictureList: [first, last] });
  await page.goto('/x/pithagoras-media/media');

  await tile(page, 'From one to the other').click();
  await viewer(page).getByRole('button', { name: 'Run again' }).click();
  await expect.poll(() => p.state.generated.length).toBe(1);
  expect(p.state.generated[0]).toEqual({ prompt: 'From one to the other', strength: 0.4, firstFrame: first.id, lastFrame: last.id });

  await tile(page, 'End lost').click();
  await viewer(page).getByRole('button', { name: 'Run again' }).click();
  await expect(page.getByRole('alert')).toContainText('The picture this was made from is not in the gallery any more.');
  expect(p.state.generated.length).toBe(1);
  await viewer(page).getByRole('button', { name: 'Close' }).click();

  // A last frame that is a path in a chat's folder is not one the gallery has: nothing to run again, and the Details name it.
  await tile(page, 'From chat pictures').click();
  await expect(viewer(page).getByRole('button', { name: 'Run again' })).toHaveCount(0);
  await viewer(page).getByRole('button', { name: 'Details' }).click();
  const details = viewer(page).getByRole('region', { name: 'Details' });
  await expect(details).toContainText('Last frame');
  await expect(details).toContainText('end.png');
});

test('a clip is made from a picture of the gallery: chosen in a dialog, shown as the first frame, and sent as its id', async ({ page }) => {
  const a = pic({ prompt: 'A lighthouse' });
  const b = pic({ prompt: 'A harbour' });
  const p = await portal(page, { pictureList: [a, b] });
  await page.goto('/x/pithagoras-media/media');
  await expect(describe(page)).toBeVisible();
  await page.getByRole('button', { name: 'Start from a picture' }).click();
  const dialog = page.getByRole('dialog', { name: 'Start from a picture' });
  await expect(dialog.getByRole('list', { name: 'Pictures' }).getByRole('button')).toHaveCount(2);
  await dialog.getByRole('button', { name: 'Start from A harbour' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(maker(page)).toContainText('First frame');
  await expect(maker(page)).toContainText('A harbour');
  // With a first frame the words say what happens next.
  await page.getByPlaceholder('Describe what happens next: what moves, and how').fill('The boats drift');
  await page.getByRole('button', { name: 'Make the video' }).click();
  await expect.poll(() => p.state.generated.length).toBe(1);
  expect(p.state.generated[0]).toEqual({ prompt: 'The boats drift', firstFrame: b.id, count: 1 });
  expect(p.state.jobs[0].kind).toBe('animate');
  // Taken away, the clip is made from the description alone again.
  await maker(page).getByRole('button', { name: 'Remove the first frame' }).click();
  await expect(maker(page)).not.toContainText('A harbour');
  await expect(page.getByPlaceholder('Describe the video: the subject, what moves, the camera')).toBeVisible();
});

test('a clip ends on a picture of the gallery too: chosen in a dialog of its own beside the first frame, shown as the last frame, and sent as its id', async ({ page }) => {
  const a = pic({ prompt: 'A lighthouse' });
  const b = pic({ prompt: 'A harbour' });
  const p = await portal(page, { pictureList: [a, b] });
  await page.goto('/x/pithagoras-media/media');
  await describe(page).fill('The boats drift');
  // Both buttons are there at once, and the last frame is optional.
  await expect(page.getByRole('button', { name: 'Start from a picture' })).toBeVisible();
  await page.getByRole('button', { name: 'End on a picture' }).click();
  const dialog = page.getByRole('dialog', { name: 'End on a picture' });
  await expect(dialog).toContainText('The picture is the last frame of the clip.');
  await expect(dialog.getByRole('list', { name: 'Pictures' }).getByRole('button')).toHaveCount(2);
  await dialog.getByRole('button', { name: 'End on A harbour' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(maker(page)).toContainText('Last frame');
  await expect(maker(page)).toContainText('A harbour');
  await expect(maker(page)).toContainText('Whether the clip really ends on it depends on the model: some ignore it without saying so.');
  await expect(maker(page)).not.toContainText('First frame');
  await expect(page.getByRole('button', { name: 'End on a picture' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Start from a picture' }).click();
  await page.getByRole('dialog', { name: 'Start from a picture' }).getByRole('button', { name: 'Start from A lighthouse' }).click();
  await expect(maker(page)).toContainText('First frame');
  await page.getByRole('button', { name: 'Make the video' }).click();
  await expect.poll(() => p.state.generated.length).toBe(1);
  expect(p.state.generated[0]).toEqual({ prompt: 'The boats drift', firstFrame: a.id, lastFrame: b.id, count: 1 });
  expect(p.state.jobs[0].kind).toBe('animate');

  // Taken away, the clip ends where the model likes again; the first frame stays.
  await maker(page).getByRole('button', { name: 'Remove the last frame' }).click();
  await expect(maker(page)).not.toContainText('Last frame');
  await expect(maker(page)).toContainText('First frame');
  await page.getByRole('button', { name: 'Make the video' }).click();
  await expect.poll(() => p.state.generated.length).toBe(2);
  expect(p.state.generated[1]).toEqual({ prompt: 'The boats drift', firstFrame: a.id, count: 1 });
});

test('a strength is a number from 0 to 1 under Advanced: sent as typed, 0 included, and said when it is wrong', async ({ page }) => {
  const p = await portal(page);
  await page.goto('/x/pithagoras-media/media');
  await describe(page).fill('A fox');
  await page.getByRole('button', { name: 'Advanced' }).click();
  await page.getByLabel('Strength').fill('1.5');
  await page.getByRole('button', { name: 'Make the video' }).click();
  await expect(maker(page).getByRole('alert')).toContainText('The strength is a number from 0 to 1, such as 0.75.');
  await expect(page.getByLabel('Strength')).toHaveAttribute('aria-invalid', 'true');
  expect(p.state.generated).toEqual([]);
  await page.getByLabel('Strength').fill('0,4');
  await page.getByRole('button', { name: 'Make the video' }).click();
  await expect.poll(() => p.state.generated.length).toBe(1);
  expect(p.state.generated[0]).toEqual({ prompt: 'A fox', strength: 0.4, count: 1 });
  await page.getByLabel('Strength').fill('0');
  await page.getByRole('button', { name: 'Make the video' }).click();
  await expect.poll(() => p.state.generated.length).toBe(2);
  expect(p.state.generated[1]).toEqual({ prompt: 'A fox', strength: 0, count: 1 });
});

test('a picture named in the address is the first frame, and the address is cleared of it', async ({ page }) => {
  const a = pic({ prompt: 'A lighthouse' });
  const p = await portal(page, { pictureList: [a] });
  await page.goto(`/x/pithagoras-media/media?from=${a.id}`);
  await expect(maker(page)).toContainText('A lighthouse');
  await expect(page).toHaveURL(/\/x\/pithagoras-media\/media$/);
  await page.getByPlaceholder('Describe what happens next: what moves, and how').fill('It rains');
  await page.getByRole('button', { name: 'Make the video' }).click();
  await expect.poll(() => p.state.generated.length).toBe(1);
  expect(p.state.generated[0].firstFrame).toBe(a.id);
});

test('a picture that is not in the gallery any more cannot be the first frame, and it is said', async ({ page }) => {
  await portal(page, { pictureList: [] });
  await page.goto(`/x/pithagoras-media/media?from=${hex(424242)}`);
  await expect(page.getByRole('alert')).toContainText('The picture to start from is not in the gallery any more.');
  await expect(maker(page)).not.toContainText('First frame');
});

test('clips are ticked and deleted together after asking, and the question says what is in a chat\'s folder', async ({ page }) => {
  const a = clip({ prompt: 'Mine', age: 1 });
  const b = clip({ prompt: 'In a chat', age: 2, origin: 'chat', chat: { id: 'c1', title: 'Holiday plans' } });
  const c = clip({ prompt: 'Keep me', age: 3 });
  const p = await portal(page, { clips: [a, b, c] });
  await page.goto('/x/pithagoras-media/media');
  await cell(page, 'Mine').getByRole('checkbox').check();
  await cell(page, 'In a chat').getByRole('checkbox').check();
  const bar = page.getByRole('group', { name: 'Selected videos' });
  await expect(bar).toContainText('2 selected');
  await bar.getByRole('button', { name: 'Delete' }).click();
  const dialog = page.getByRole('alertdialog', { name: 'Delete these 2 videos?' });
  await expect(dialog).toContainText('1 of them is a file in the folder of a chat');
  await dialog.getByRole('button', { name: 'Delete' }).click();
  await expect.poll(() => p.state.deleted).toEqual([[a.id, b.id]]);
  await expect(tile(page, 'Mine')).toHaveCount(0);
  await expect(tile(page, 'In a chat')).toHaveCount(0);
  await expect(tile(page, 'Keep me')).toBeVisible();
  await expect(bar).toHaveCount(0);
});

test('a clip is deleted from the viewer after asking, and the viewer moves on', async ({ page }) => {
  const a = clip({ prompt: 'Doomed', age: 1 });
  const b = clip({ prompt: 'Survivor', age: 2 });
  const p = await portal(page, { clips: [a, b] });
  await page.goto('/x/pithagoras-media/media');
  await tile(page, 'Doomed').click();
  await viewer(page).getByRole('button', { name: 'Delete' }).click();
  const dialog = page.getByRole('alertdialog', { name: 'Delete this video?' });
  await expect(dialog).toContainText('The file is deleted from the portal.');
  await dialog.getByRole('button', { name: 'Delete' }).click();
  await expect.poll(() => p.state.deleted).toEqual([[a.id]]);
  await expect(viewer(page).locator('video')).toHaveAttribute('src', `/api/x/pithagoras-media/videos/${b.id}/file`);
});

test('the filters are in the address, so that a link and Back keep them', async ({ page }) => {
  const mine = clip({ prompt: 'Made here', age: 1 });
  const theirs = clip({ prompt: 'From a chat', age: 2, origin: 'chat', chat: { id: 'c1', title: 'A chat' }, kind: 'animated' });
  await portal(page, { clips: [mine, theirs] });
  await page.goto('/x/pithagoras-media/media?origin=chat&kind=animated');
  await expect(tile(page, 'From a chat')).toBeVisible();
  await expect(tile(page, 'Made here')).toHaveCount(0);
  await page.getByRole('radio', { name: 'From a description' }).click();
  await expect(page).toHaveURL(/\/x\/pithagoras-media\/media\?origin=chat&kind=generated$/);
  await expect(page.getByText('No videos match these filters.')).toBeVisible();
  await page.goBack();
  await expect(tile(page, 'From a chat')).toBeVisible();
});

test('the clips made on the page show what they take of the disk, beside the limit when there is one', async ({ page }) => {
  await portal(page, { clips: [clip({ bytes: 3_000_000 }), clip({ bytes: 1_000_000, origin: 'chat', chat: { id: 'c1', title: 'A chat' } })], videos: feature({ storageLimitMb: 2048 }) });
  await page.goto('/x/pithagoras-media/media');
  await expect(page.getByText('2.9 MB')).toBeVisible();
  await expect(page.getByText('kept from this page, of 2.0 GB')).toBeVisible();
});

test('the gallery is paged: the next page is asked for with the one before it, and Show more is there for a keyboard', async ({ page }) => {
  const many = Array.from({ length: 30 }, (_, i) => clip({ prompt: `Clip number ${i + 1}`, age: i + 1 }));
  const p = await portal(page, { clips: many });
  await page.goto('/x/pithagoras-media/media');
  await expect(grid(page).getByRole('listitem')).toHaveCount(24);
  await page.getByRole('button', { name: 'Show more' }).click();
  await expect(grid(page).getByRole('listitem')).toHaveCount(30);
  expect(p.state.listed.some((q) => q.includes('before='))).toBe(true);
});
