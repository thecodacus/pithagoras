import { readFileSync } from 'node:fs';
import { type Page } from '@playwright/test';
import { test, expect, mockPortal, reply, DONE } from '../../../../tests/browser/portal-mock';

test.use({ installed: ['extensions/media'] });

/**
 * The Media page (src/web/MediaPage.tsx) over a portal that makes both pictures and videos: one gallery of both, a
 * filter for which, and a form for each. What each kind does alone is in media-pictures.spec.mts and
 * media-videos.spec.mts.
 */

interface Item {
  id: string;
  origin: 'page' | 'chat' | 'folder';
  chat: { id: string; title: string } | null;
  folder: { name: string; home: boolean } | null;
  kind: string;
  prompt: string;
  params: Record<string, unknown>;
  from?: null;
  createdAt: number;
  bytes: number;
  fileName: string;
  thumb?: boolean;
  poster?: boolean;
}

const WEBM = readFileSync(new URL('../../../../tests/fixtures/clip.webm', import.meta.url));
const hex = (n: number) => n.toString(16).padStart(12, '0');

let next = 1;
/** A picture of the gallery; `age` is how many minutes ago it was made. */
const pic = (over: Partial<Item> & { age?: number } = {}): Item => {
  const { age = 0, ...rest } = over;
  const n = next++;
  return { id: hex(n), origin: 'page', chat: null, folder: null, kind: 'generated', prompt: `Picture ${n}`, params: {}, from: null, createdAt: Date.now() - age * 60_000, bytes: 100_000, fileName: `image-${n}.png`, thumb: false, ...rest };
};
/** And a video. */
const vid = (over: Partial<Item> & { age?: number } = {}): Item => {
  const { age = 0, ...rest } = over;
  const n = next++;
  return { id: hex(n), origin: 'page', chat: null, folder: null, kind: 'generated', prompt: `Video ${n}`, params: {}, createdAt: Date.now() - age * 60_000, bytes: 2_000_000, fileName: `video-${n}.webm`, poster: true, ...rest };
};

const svg = (id: string) => `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240"><rect width="100%" height="100%" fill="hsl(${(parseInt(id.slice(-4), 16) * 47) % 360} 55% 45%)"/></svg>`;

const images = {
  enabled: true, baseUrl: 'https://images.example.com/v1', model: 'image-model', size: '1024x1024', keySet: true, editEnabled: true, editBaseUrl: '', editModel: '', editMultiple: false, timeoutSeconds: 300,
  editKeySet: false, editReady: true, sdExtras: false, ready: true,
};
const videosFeature = {
  enabled: true, backend: 'sdcpp', backends: [{ id: 'sdcpp', label: 'stable-diffusion.cpp' }], baseUrl: 'https://video.example.com', model: 'video-model', size: '832x480', frames: 33, fps: 16, keySet: true,
  timeoutSeconds: 1800, storageLimitMb: 0, ready: true,
};

async function portal(page: Page, { pictures = [] as Item[], videos = [] as Item[], imagesOn = true, videosOn = true } = {}) {
  const pics = [...pictures];
  const clips = [...videos];
  const state = {
    pictureJobs: [] as any[], videoJobs: [] as any[], generated: [] as any[], videoGenerated: [] as any[], deleted: [] as string[][], videoDeleted: [] as string[][], listed: [] as string[], videoListed: [] as string[],
  };
  const order = (list: Item[]) => [...list].sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1));
  const paged = (list: Item[], url: URL, fallback: number) => {
    const origin = url.searchParams.get('origin');
    const kind = url.searchParams.get('kind');
    const before = url.searchParams.get('before');
    const limit = Number(url.searchParams.get('limit') ?? fallback);
    let all = order(list).filter((x) => (!origin || x.origin === origin) && (!kind || x.kind === kind));
    const total = all.length;
    if (before) {
      const [at, id] = before.split(':');
      all = all.filter((x) => x.createdAt < Number(at) || (x.createdAt === Number(at) && x.id < id));
    }
    const pageOf = all.slice(0, limit);
    const last = pageOf[pageOf.length - 1];
    return { page: pageOf, next: all.length > limit && last ? `${last.createdAt}:${last.id}` : null, total, pageBytes: list.filter((x) => x.origin === 'page').reduce((sum, x) => sum + x.bytes, 0) };
  };

  await mockPortal(page, async ({ path: p, method, url, json, route }) => {
    if (p === '/api/x/pithagoras-media/state') return { images: { enabled: imagesOn }, videos: { enabled: videosOn } };
    if (p === '/api/x/pithagoras-media/settings/images') return { images };
    if (p === '/api/x/pithagoras-media/settings/videos') return { videos: videosFeature };
    if (p === '/api/x/pithagoras-media/images' && method === 'GET') {
      state.listed.push(url.search);
      const ids = url.searchParams.get('ids');
      if (ids) return { pictures: ids.split(',').map((id) => pics.find((x) => x.id === id)).filter(Boolean) };
      const { page: pageOf, ...rest } = paged(pics, url, 48);
      return { pictures: pageOf, ...rest };
    }
    if (p === '/api/x/pithagoras-media/videos' && method === 'GET') {
      state.videoListed.push(url.search);
      const ids = url.searchParams.get('ids');
      if (ids) return { videos: ids.split(',').map((id) => clips.find((x) => x.id === id)).filter(Boolean) };
      const { page: pageOf, ...rest } = paged(clips, url, 24);
      return { videos: pageOf, ...rest };
    }
    if (p === '/api/x/pithagoras-media/images/jobs') return { jobs: state.pictureJobs, limit: 4 };
    if (p === '/api/x/pithagoras-media/videos/jobs') return { jobs: state.videoJobs, limit: 4 };
    if (p === '/api/x/pithagoras-media/images/generate' && method === 'POST') {
      const sent = json();
      state.generated.push(sent);
      const made = [{ id: `pj${state.pictureJobs.length + 1}`.padEnd(12, '0'), kind: 'generate', state: 'running', prompt: sent.prompt, startedAt: Date.now() }];
      state.pictureJobs.unshift(...made);
      return reply(202, { jobs: made });
    }
    if (p === '/api/x/pithagoras-media/videos/generate' && method === 'POST') {
      const sent = json();
      state.videoGenerated.push(sent);
      const made = [{ id: `vj${state.videoJobs.length + 1}`.padEnd(12, '0'), kind: sent.firstFrame ? 'animate' : 'generate', state: 'running', stage: 'making', prompt: sent.prompt, startedAt: Date.now() }];
      state.videoJobs.unshift(...made);
      return reply(202, { jobs: made });
    }
    if (p === '/api/x/pithagoras-media/images/delete' && method === 'POST') {
      const { ids } = json();
      state.deleted.push(ids);
      for (const id of ids) pics.splice(pics.findIndex((x) => x.id === id), 1);
      return { deleted: ids, failed: [] };
    }
    if (p === '/api/x/pithagoras-media/videos/delete' && method === 'POST') {
      const { ids } = json();
      state.videoDeleted.push(ids);
      for (const id of ids) clips.splice(clips.findIndex((x) => x.id === id), 1);
      return { deleted: ids, failed: [] };
    }
    if (/^\/api\/x\/pithagoras-media\/images\/[0-9a-f]{12}\/(thumb|file)$/.test(p)) {
      await route.fulfill({ body: svg(p.split('/')[5]), contentType: 'image/svg+xml' });
      return DONE;
    }
    if (/^\/api\/x\/pithagoras-media\/videos\/[0-9a-f]{12}\/file$/.test(p)) {
      await route.fulfill({ body: WEBM, contentType: 'video/webm' });
      return DONE;
    }
    if (/^\/api\/x\/pithagoras-media\/videos\/[0-9a-f]{12}\/poster$/.test(p)) {
      await route.fulfill({ body: svg(p.split('/')[5]), contentType: 'image/svg+xml' });
      return DONE;
    }
  }, { settings: true });
  return { state, pics, clips };
}

/** The grid, whichever kinds it holds (it is named after them: Media, Pictures or Videos). */
const gallery = (page: Page) => page.locator('ul.gallery-grid');
const tile = (page: Page, name: string) => gallery(page).getByRole('button', { name, exact: true });
const cell = (page: Page, name: string) => gallery(page).getByRole('listitem').filter({ has: page.getByRole('button', { name, exact: true }) });
const titles = (page: Page) => gallery(page).getByRole('button').evaluateAll((els) => els.map((e) => e.getAttribute('title')));
const show = (page: Page, name: 'All' | 'Pictures' | 'Videos') => page.getByRole('radiogroup', { name: 'Show' }).getByRole('radio', { name });

test('the sidebar has one Media entry for both kinds, among the extensions\' pages, and the page opens on both together, newest first', async ({ page }) => {
  await portal(page, { pictures: [pic({ prompt: 'A lighthouse', age: 30 }), pic({ prompt: 'A harbour', age: 10 })], videos: [vid({ prompt: 'A fox', age: 20 }), vid({ prompt: 'A river', age: 5 })] });
  await page.goto('/sessions');
  const sidebar = page.getByRole('complementary', { name: 'Sidebar' });
  await expect(sidebar.getByRole('button', { name: 'Media' })).toHaveCount(1);
  await expect(sidebar.getByRole('group', { name: 'Extensions' }).getByRole('button', { name: 'Media' })).toHaveCount(1);
  await expect(sidebar.getByRole('button', { name: 'Images' })).toHaveCount(0);
  await expect(sidebar.getByRole('button', { name: 'Videos' })).toHaveCount(0);
  await sidebar.getByRole('button', { name: 'Media' }).click();
  await expect(page).toHaveURL(/\/x\/pithagoras-media\/media$/);
  await expect(page.getByRole('heading', { name: 'Media' })).toBeVisible();
  await expect(tile(page, 'A river')).toBeVisible();
  expect(await titles(page)).toEqual(['A river', 'A harbour', 'A fox', 'A lighthouse']);
  // How many of each, apart.
  await expect(page.getByText('2', { exact: true })).toHaveCount(2);
  await expect(page.getByText('pictures', { exact: true })).toBeVisible();
  await expect(page.getByText('videos', { exact: true })).toBeVisible();
});

test('the Media entry is there for either kind alone, and the page then shows that kind with no choice of which', async ({ page }) => {
  await portal(page, { pictures: [pic({ prompt: 'A lighthouse' })], imagesOn: true, videosOn: false });
  await page.goto('/sessions');
  await expect(page.getByRole('complementary', { name: 'Sidebar' }).getByRole('button', { name: 'Media' })).toHaveCount(1);
  await page.goto('/x/pithagoras-media/media');
  await expect(page.getByRole('list', { name: 'Pictures' })).toBeVisible();
  await expect(page.getByRole('radiogroup', { name: 'Show' })).toHaveCount(0);
  await expect(page.getByRole('radiogroup', { name: 'Make' })).toHaveCount(0);
});

test('the filter shows both kinds, the pictures or the videos, and is in the address', async ({ page }) => {
  const p = await portal(page, { pictures: [pic({ prompt: 'A lighthouse', age: 30 })], videos: [vid({ prompt: 'A fox', age: 20 })] });
  await page.goto('/x/pithagoras-media/media');
  await expect(tile(page, 'A fox')).toBeVisible();
  await expect(show(page, 'All')).toBeChecked();

  await show(page, 'Videos').click();
  await expect(page).toHaveURL(/\/x\/pithagoras-media\/media\?show=videos$/);
  await expect(page.getByRole('list', { name: 'Videos' }).getByRole('button')).toHaveCount(1);
  await expect(page.getByText('A lighthouse')).toHaveCount(0);
  await show(page, 'Pictures').click();
  await expect(page).toHaveURL(/\/x\/pithagoras-media\/media\?show=images$/);
  await expect(page.getByRole('list', { name: 'Pictures' }).getByRole('button')).toHaveCount(1);
  await show(page, 'All').click();
  await expect(page).toHaveURL(/\/x\/pithagoras-media\/media$/);
  await expect(gallery(page).getByRole('button')).toHaveCount(2);

  // A link keeps it, and Back does.
  await page.goto('/x/pithagoras-media/media?show=videos&origin=page');
  await expect(show(page, 'Videos')).toBeChecked();
  await expect(page.getByRole('list', { name: 'Videos' }).getByRole('button')).toHaveCount(1);
  expect(p.state.videoListed.at(-1)).toContain('origin=page');
});

test('a kind that only pictures have leaves the videos out, and one that only videos have leaves the pictures out', async ({ page }) => {
  const p = await portal(page, {
    pictures: [pic({ prompt: 'A lighthouse', age: 30 }), pic({ prompt: 'A changed one', age: 25, kind: 'edited' })],
    videos: [vid({ prompt: 'A fox', age: 20 }), vid({ prompt: 'A moving one', age: 10, kind: 'animated' })],
  });
  await page.goto('/x/pithagoras-media/media');
  await expect(gallery(page).getByRole('button')).toHaveCount(4);
  const kinds = page.getByRole('radiogroup', { name: 'How it was made' });
  // Both lists' kinds, the pictures' and the videos'.
  await expect(kinds.getByRole('radio')).toHaveText(['All', 'Made', 'Changed', 'From a picture', 'From this computer', 'Not known']);

  const videosAsked = p.state.videoListed.length;
  await kinds.getByRole('radio', { name: 'Changed' }).click();
  await expect(page).toHaveURL(/\/x\/pithagoras-media\/media\?kind=edited$/);
  await expect.poll(() => titles(page)).toEqual(['A changed one']);
  expect(p.state.videoListed.length).toBe(videosAsked);

  const picturesAsked = p.state.listed.length;
  await kinds.getByRole('radio', { name: 'From a picture' }).click();
  await expect.poll(() => titles(page)).toEqual(['A moving one']);
  expect(p.state.listed.length).toBe(picturesAsked);

  // Made is both lists'.
  await kinds.getByRole('radio', { name: 'Made' }).click();
  await expect.poll(() => titles(page)).toEqual(['A fox', 'A lighthouse']);

  // One kind alone has the kinds of that kind, in its own words.
  await show(page, 'Videos').click();
  await expect(kinds.getByRole('radio')).toHaveText(['All', 'From a description', 'From a picture', 'Not known']);
  await show(page, 'Pictures').click();
  await expect(kinds.getByRole('radio')).toHaveText(['All', 'Made', 'Changed', 'From this computer', 'Not known']);
});

test('a page of each is asked for, and Show more reads on in the list that has not got as far, so that nothing is left out between', async ({ page }) => {
  // Fifty pictures from 1 to 50 minutes ago, and thirty videos all older: the pictures come first, then the videos.
  const manyPictures = Array.from({ length: 50 }, (_, i) => pic({ prompt: `Picture number ${i + 1}`, age: i + 1 }));
  const manyVideos = Array.from({ length: 30 }, (_, i) => vid({ prompt: `Video number ${i + 1}`, age: 100 + i }));
  const p = await portal(page, { pictures: manyPictures, videos: manyVideos });
  // Without the observer that reads on as the end comes near, so that the button is the only thing that does.
  await page.addInitScript(() => delete (window as any).IntersectionObserver);
  await page.goto('/x/pithagoras-media/media');
  // A page of the pictures is 48 and of the videos 24; the videos are all older than the 48th picture, which is as far as the gallery is known.
  await expect(gallery(page).getByRole('listitem')).toHaveCount(48);
  await expect(gallery(page).getByRole('img', { name: 'Video number 1', exact: true })).toHaveCount(0);
  expect(p.state.videoListed.some((q) => q.includes('limit=24'))).toBe(true);

  // The pictures are the list that stops first: they are read on, and now the videos' last is as far as it is known.
  await page.getByRole('button', { name: 'Show more' }).click();
  await expect(gallery(page).getByRole('listitem')).toHaveCount(50 + 24);
  expect(p.state.listed.some((q) => q.includes('before='))).toBe(true);
  expect(p.state.videoListed.some((q) => q.includes('before='))).toBe(false);

  await page.getByRole('button', { name: 'Show more' }).click();
  await expect(gallery(page).getByRole('listitem')).toHaveCount(80);
  await expect(page.getByRole('button', { name: 'Show more' })).toHaveCount(0);
});

test('a picture and a video are made from the same page: the form is the one of the kind chosen, and each job holds a place in the one gallery', async ({ page }) => {
  const p = await portal(page);
  await page.goto('/x/pithagoras-media/media');
  const choice = page.getByRole('radiogroup', { name: 'Make' });
  await expect(choice.getByRole('radio', { name: 'A picture' })).toBeChecked();
  await expect(page.getByRole('region', { name: 'Make a picture' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Make a video' })).toHaveCount(0);
  await page.getByPlaceholder('Describe the picture').fill('A lighthouse at dusk');
  await page.getByRole('button', { name: 'Make the picture' }).click();
  await expect.poll(() => p.state.generated.length).toBe(1);
  expect(p.state.generated[0].prompt).toBe('A lighthouse at dusk');

  await choice.getByRole('radio', { name: 'A video' }).click();
  await expect(page.getByRole('region', { name: 'Make a video' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Make a picture' })).toHaveCount(0);
  await page.getByPlaceholder('Describe the video: the subject, what moves, the camera').fill('A fox in the snow');
  await page.getByRole('button', { name: 'Make the video' }).click();
  await expect.poll(() => p.state.videoGenerated.length).toBe(1);
  expect(p.state.videoGenerated[0]).toMatchObject({ prompt: 'A fox in the snow', count: 1 });

  // Both are being made, in the one grid, and counted together.
  await expect(gallery(page).getByRole('listitem')).toHaveCount(2);
  await expect(page.locator('div').filter({ has: page.getByText('being made', { exact: true }) }).filter({ hasText: /^2\s*being made$/ }).first()).toBeVisible();

  // The words of each form stay with it, whichever is shown.
  await choice.getByRole('radio', { name: 'A picture' }).click();
  await expect(page.getByPlaceholder('Describe the picture')).toHaveValue('A lighthouse at dusk');
  await choice.getByRole('radio', { name: 'A video' }).click();
  await expect(page.getByPlaceholder('Describe the video: the subject, what moves, the camera')).toHaveValue('A fox in the snow');
});

test('a video started while only pictures are shown brings the videos into the gallery, so that its tile is not left out', async ({ page }) => {
  await portal(page, { pictures: [pic({ prompt: 'A lighthouse' })] });
  await page.goto('/x/pithagoras-media/media?show=images');
  await expect(show(page, 'Pictures')).toBeChecked();
  await page.getByRole('radiogroup', { name: 'Make' }).getByRole('radio', { name: 'A video' }).click();
  await page.getByPlaceholder('Describe the video: the subject, what moves, the camera').fill('A fox in the snow');
  await page.getByRole('button', { name: 'Make the video' }).click();
  await expect(page).toHaveURL(/\/x\/pithagoras-media\/media$/);
  await expect(show(page, 'All')).toBeChecked();
  // The picture, and the video being made.
  await expect(gallery(page).getByRole('listitem')).toHaveCount(2);
  await expect(page.getByText('Making a video', { exact: true })).toBeVisible();
});

test('a picture started while only videos are shown does the same, and one of the kind shown leaves the filter as it is', async ({ page }) => {
  await portal(page, { videos: [vid({ prompt: 'A fox' })] });
  await page.goto('/x/pithagoras-media/media?show=videos');
  await page.getByRole('radiogroup', { name: 'Make' }).getByRole('radio', { name: 'A picture' }).click();
  await page.getByPlaceholder('Describe the picture').fill('A lighthouse at dusk');
  await page.getByRole('button', { name: 'Make the picture' }).click();
  await expect(show(page, 'All')).toBeChecked();
  await expect(gallery(page).getByRole('listitem')).toHaveCount(2);

  await show(page, 'Videos').click();
  await expect(page).toHaveURL(/\/x\/pithagoras-media\/media\?show=videos$/);
  await page.getByRole('radiogroup', { name: 'Make' }).getByRole('radio', { name: 'A video' }).click();
  await page.getByPlaceholder('Describe the video: the subject, what moves, the camera').fill('A river');
  await page.getByRole('button', { name: 'Make the video' }).click();
  await expect(gallery(page).getByRole('listitem')).toHaveCount(2);
  await expect(page).toHaveURL(/\/x\/pithagoras-media\/media\?show=videos$/);
});

test('a kind or an origin that would hide what was just started is let go of with the rest, and one that fits stays', async ({ page }) => {
  const mine = pic({ prompt: 'Mine', origin: 'page', age: 5 });
  const edited = pic({ prompt: 'A changed one', kind: 'edited', age: 6 });
  const theirs = pic({ prompt: 'From a chat', origin: 'chat', chat: { id: 'c1', title: 'A chat' }, age: 7 });
  await portal(page, { pictures: [mine, edited, theirs] });
  const makeVideo = async (words: string) => {
    await page.getByRole('radiogroup', { name: 'Make' }).getByRole('radio', { name: 'A video' }).click();
    await page.getByPlaceholder('Describe the video: the subject, what moves, the camera').fill(words);
    await page.getByRole('button', { name: 'Make the video' }).click();
  };

  // Changed pictures only: a video is none of them, so the kind goes and the video has its tile.
  await page.goto('/x/pithagoras-media/media?show=images&kind=edited');
  await expect(gallery(page).getByRole('listitem')).toHaveCount(1);
  await makeVideo('A fox in the snow');
  await expect(page).toHaveURL(/\/x\/pithagoras-media\/media$/);
  await expect(gallery(page).getByRole('listitem')).toHaveCount(4);
  await expect(page.getByText('Making a video', { exact: true })).toBeVisible();

  // The agent's pictures only: what is made here is not from a chat, so the origin goes.
  await page.goto('/x/pithagoras-media/media?show=images&origin=chat');
  await expect(gallery(page).getByRole('listitem')).toHaveCount(1);
  await makeVideo('A river');
  await expect(page).toHaveURL(/\/x\/pithagoras-media\/media$/);
  await expect(gallery(page).getByRole('listitem').filter({ hasText: 'A river' })).toHaveCount(1);

  // What is made here fits "made here": that filter stays, with the video in it.
  await page.goto('/x/pithagoras-media/media?show=images&origin=page');
  await expect(gallery(page).getByRole('listitem')).toHaveCount(2);
  await makeVideo('A lighthouse');
  await expect(page).toHaveURL(/\/x\/pithagoras-media\/media\?origin=page$/);
  await expect(show(page, 'All')).toBeChecked();
  await expect(gallery(page).getByRole('listitem').filter({ hasText: 'A lighthouse' })).toHaveCount(1);
});

test('the form follows the filter: videos shown, the form of videos is open', async ({ page }) => {
  await portal(page);
  await page.goto('/x/pithagoras-media/media?show=videos');
  await expect(page.getByRole('region', { name: 'Make a video' })).toBeVisible();
  await expect(page.getByRole('radiogroup', { name: 'Make' }).getByRole('radio', { name: 'A video' })).toBeChecked();
  // The person's own choice wins, whatever is shown.
  await page.getByRole('radiogroup', { name: 'Make' }).getByRole('radio', { name: 'A picture' }).click();
  await expect(page.getByRole('region', { name: 'Make a picture' })).toBeVisible();
});

test('a picture and a video are ticked together; they are downloaded or deleted together after one question, and only pictures are edited', async ({ page }) => {
  const a = pic({ prompt: 'A lighthouse', age: 3 });
  const b = vid({ prompt: 'A fox', age: 2 });
  const keep = pic({ prompt: 'Keep me', age: 4 });
  const p = await portal(page, { pictures: [a, keep], videos: [b] });
  await page.goto('/x/pithagoras-media/media');
  await cell(page, 'A lighthouse').getByRole('checkbox').check();
  const bar = page.getByRole('group', { name: 'Selected items' });
  await expect(bar).toContainText('1 selected');
  await cell(page, 'A fox').getByRole('checkbox').check();
  await expect(bar).toContainText('2 selected');
  // A video is not something to edit, and the bar says so.
  await expect(bar.getByRole('button', { name: 'Edit' })).toBeDisabled();
  await expect(bar).toContainText('Only pictures can be edited: leave the videos out');
  await bar.getByRole('button', { name: 'Select all shown' }).click();
  await expect(bar).toContainText('3 selected');
  await cell(page, 'Keep me').getByRole('checkbox').uncheck();

  await bar.getByRole('button', { name: 'Delete' }).click();
  const dialog = page.getByRole('alertdialog', { name: 'Delete these 2 files?' });
  await expect(dialog).toContainText('The file is deleted from the portal.');
  await dialog.getByRole('button', { name: 'Delete' }).click();
  await expect.poll(() => p.state.deleted).toEqual([[a.id]]);
  await expect.poll(() => p.state.videoDeleted).toEqual([[b.id]]);
  await expect(tile(page, 'A lighthouse')).toHaveCount(0);
  await expect(tile(page, 'A fox')).toHaveCount(0);
  await expect(tile(page, 'Keep me')).toBeVisible();
  await expect(bar).toHaveCount(0);
});

test('only pictures ticked can be edited from the bar, and the form opens in Edit with them', async ({ page }) => {
  const a = pic({ prompt: 'A lighthouse', age: 3 });
  await portal(page, { pictures: [a], videos: [vid({ prompt: 'A fox', age: 2 })] });
  await page.goto('/x/pithagoras-media/media');
  await cell(page, 'A lighthouse').getByRole('checkbox').check();
  const bar = page.getByRole('group', { name: 'Selected items' });
  await expect(bar.getByRole('button', { name: 'Edit' })).toBeEnabled();
  await bar.getByRole('button', { name: 'Edit' }).click();
  await expect(page.getByRole('region', { name: 'Change a picture' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Change a picture' }).getByRole('img', { name: 'A lighthouse' })).toBeVisible();
  // While the boxes are the edit's, a video has none.
  await expect(cell(page, 'A fox').getByRole('checkbox')).toHaveCount(0);
});

test('a picture opens in the picture viewer and a video in the video viewer, each stepping through its own kind', async ({ page }) => {
  await portal(page, { pictures: [pic({ prompt: 'First picture', age: 4 }), pic({ prompt: 'Second picture', age: 2 })], videos: [vid({ prompt: 'A fox', age: 3 }), vid({ prompt: 'A river', age: 1 })] });
  await page.goto('/x/pithagoras-media/media');
  await tile(page, 'First picture').click();
  const pictureViewer = page.getByRole('dialog', { name: 'Picture viewer' });
  await expect(pictureViewer).toBeVisible();
  await expect(pictureViewer.getByRole('img', { name: 'First picture' })).toBeVisible();
  // The next picture, not the video between.
  await pictureViewer.getByRole('button', { name: 'Previous picture' }).click();
  await expect(pictureViewer.getByRole('img', { name: 'Second picture' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(pictureViewer).toHaveCount(0);

  await tile(page, 'A fox').click();
  const videoViewer = page.getByRole('dialog', { name: 'Video viewer' });
  await expect(videoViewer).toBeVisible();
  await expect(videoViewer.getByText('2 / 2', { exact: true })).toBeVisible();
  await videoViewer.getByRole('button', { name: 'Previous video' }).click();
  await expect(videoViewer.getByText('1 / 2', { exact: true })).toBeVisible();
});

test('Make a video from it in the picture viewer opens the form for videos with that picture as the first frame', async ({ page }) => {
  const a = pic({ prompt: 'A lighthouse at dusk' });
  const p = await portal(page, { pictures: [a], videos: [] });
  await page.goto('/x/pithagoras-media/media');
  await tile(page, 'A lighthouse at dusk').click();
  const viewer = page.getByRole('dialog', { name: 'Picture viewer' });
  await viewer.getByRole('button', { name: 'Make a video from it' }).click();
  await expect(viewer).toHaveCount(0);
  const maker = page.getByRole('region', { name: 'Make a video' });
  await expect(maker).toBeVisible();
  await expect(maker).toContainText('First frame');
  await expect(maker).toContainText('A lighthouse at dusk');
  await expect(page.getByRole('radiogroup', { name: 'Make' }).getByRole('radio', { name: 'A video' })).toBeChecked();
  await page.getByPlaceholder('Describe what happens next: what moves, and how').fill('The light turns');
  await page.getByRole('button', { name: 'Make the video' }).click();
  await expect.poll(() => p.state.videoGenerated.length).toBe(1);
  expect(p.state.videoGenerated[0].firstFrame).toBe(a.id);
});

test('without video generation the picture viewer has no way to a video', async ({ page }) => {
  await portal(page, { pictures: [pic({ prompt: 'A lighthouse' })], videosOn: false });
  await page.goto('/x/pithagoras-media/media');
  await tile(page, 'A lighthouse').click();
  await expect(page.getByRole('dialog', { name: 'Picture viewer' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Make a video from it' })).toHaveCount(0);
});

test('with nothing made yet the gallery says so for both kinds, and for a filter that leaves nothing', async ({ page }) => {
  await portal(page);
  await page.goto('/x/pithagoras-media/media');
  await expect(page.getByText('Nothing here yet. Describe a picture or a video above to make the first.')).toBeVisible();
  await page.getByRole('radiogroup', { name: 'Where from' }).getByRole('radio', { name: 'From chats' }).click();
  await expect(page.getByText('Nothing matches these filters.')).toBeVisible();
});

test('the Media page fits a phone with both kinds in it', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await portal(page, { pictures: [pic({ prompt: 'A lighthouse' })], videos: [vid({ prompt: 'A fox' })] });
  await page.goto('/x/pithagoras-media/media');
  await expect(tile(page, 'A fox')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});
