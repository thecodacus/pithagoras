import { type Locator, type Page } from '@playwright/test';
import { test, expect, mockPortal, reply, DONE } from '../../../../tests/browser/portal-mock';

test.use({ installed: ['extensions/media'] });

/**
 * The pictures of the Media page (src/web/MediaPage.tsx) over a portal that makes pictures and no videos: the pictures
 * of its gallery, and the jobs that make more, which the test lets finish when it likes. The page with both kinds is
 * media-page.spec.mts.
 */

interface Pic {
  id: string;
  origin: 'page' | 'chat' | 'folder';
  chat: { id: string; title: string } | null;
  folder: { name: string; home: boolean } | null;
  kind: 'generated' | 'edited' | 'uploaded' | 'unknown';
  prompt: string;
  params: Record<string, unknown>;
  from: string | null;
  createdAt: number;
  bytes: number;
  fileName: string;
  thumb?: boolean;
}
interface Job {
  id: string;
  kind: 'generate' | 'edit';
  state: 'running' | 'done' | 'failed';
  prompt: string;
  size?: string;
  from?: string;
  startedAt: number;
  finishedAt?: number;
  pictureId?: string;
  notes?: string[];
  error?: string;
}

const hex = (n: number) => n.toString(16).padStart(12, '0');
const NOW = Date.parse('2026-10-02T12:00:00Z');

let next = 1;
/** A picture of the gallery; `age` is how many minutes ago it was made. */
const pic = (over: Partial<Pic> & { age?: number } = {}): Pic => {
  const { age = 0, ...rest } = over;
  const n = next++;
  return {
    id: hex(n),
    origin: 'page',
    chat: null,
    folder: null,
    kind: 'generated',
    prompt: `Picture ${n}`,
    params: {},
    from: null,
    createdAt: Date.now() - age * 60_000,
    bytes: 120_000,
    fileName: `image-${n}.png`,
    thumb: false,
    ...rest,
  };
};

const svg = (id: string, w = 800, h = 600) => {
  const hue = (parseInt(id.slice(-4), 16) * 47) % 360;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="100%" height="100%" fill="hsl(${hue} 55% 45%)"/><circle cx="${w / 2}" cy="${h / 2}" r="${Math.min(w, h) / 4}" fill="white"/></svg>`;
};

/** An ImagesFeature as the portal tells of it. */
const feature = (over: Record<string, unknown> = {}) => {
  const f = {
    enabled: true, baseUrl: 'https://images.example.com/v1', model: 'image-model', size: '1024x1024', keySet: true,
    editEnabled: true, editBaseUrl: '', editModel: '', editMultiple: false, timeoutSeconds: 300, editKeySet: false, editReady: true, sdExtras: false, ...over,
  };
  // The portal says whether pictures can be made, as it says whether they can be changed.
  return { ready: f.enabled && f.baseUrl !== '', ...f };
};

async function portal(page: Page, { pictures = [] as Pic[], images = feature(), flagOn = true, jobs = [] as Job[], failList = false, videosOn = false } = {}) {
  const pics = [...pictures];
  const state = { jobs: [...jobs], generated: [] as any[], edited: [] as any[], deleted: [] as string[][], stopped: [] as string[], uploads: [] as { name: string | null; type: string | undefined; size: number }[], listed: [] as string[], files: [] as string[], thumbFiles: [] as string[], limit: 4 };
  const sorted = () => [...pics].sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1));
  const job = (over: Partial<Job>): Job => ({ id: `j${state.jobs.length + 1}`.padEnd(12, '0'), kind: 'generate', state: 'running', prompt: '', startedAt: Date.now(), ...over });

  await mockPortal(page, async ({ path: p, method, url, json, route }) => {
    if (p === '/api/x/pithagoras-media/state') return { images: { enabled: flagOn }, videos: { enabled: videosOn } };
    if (p === '/api/x/pithagoras-media/settings/images') return { images };
    if (p === '/api/x/pithagoras-media/images' && method === 'GET') {
      state.listed.push(url.search);
      if (failList) return reply(500, { error: 'The gallery could not be read' });
      const ids = url.searchParams.get('ids');
      if (ids) return { pictures: ids.split(',').map((id) => pics.find((x) => x.id === id)).filter(Boolean) };
      else {
        const origin = url.searchParams.get('origin');
        const kind = url.searchParams.get('kind');
        const before = url.searchParams.get('before');
        const limit = Number(url.searchParams.get('limit') ?? 48);
        let all = sorted().filter((x) => (!origin || x.origin === origin) && (!kind || x.kind === kind));
        const total = all.length;
        if (before) {
          const [at, id] = before.split(':');
          all = all.filter((x) => x.createdAt < Number(at) || (x.createdAt === Number(at) && x.id < id));
        }
        const pageOf = all.slice(0, limit);
        const last = pageOf[pageOf.length - 1];
        return { pictures: pageOf, next: all.length > limit && last ? `${last.createdAt}:${last.id}` : null, total, pageBytes: pics.filter((x) => x.origin === 'page').reduce((sum, x) => sum + x.bytes, 0) };
      }
    }
    if (p === '/api/x/pithagoras-media/images/jobs' && method === 'GET') return { jobs: state.jobs, limit: state.limit };
    if (p.startsWith('/api/x/pithagoras-media/images/jobs/') && method === 'DELETE') {
      const id = p.split('/').pop()!;
      state.stopped.push(id);
      state.jobs = state.jobs.filter((j) => j.id !== id);
      return { ok: true };
    }
    if (p === '/api/x/pithagoras-media/images/generate' && method === 'POST') {
      const sent = json();
      state.generated.push(sent);
      if (sent.prompt === 'refuse me') return reply(429, { error: '4 pictures are being made already: wait for one to finish, or stop one' });
      const made = Array.from({ length: sent.count ?? 1 }, () => job({ prompt: sent.prompt, ...(sent.size ? { size: sent.size } : {}) }));
      state.jobs.unshift(...made);
      return reply(202, { jobs: made });
    }
    if (p === '/api/x/pithagoras-media/images/edit' && method === 'POST') {
      const sent = json();
      state.edited.push(sent);
      const made = Array.from({ length: sent.count ?? 1 }, () => job({ kind: 'edit', prompt: sent.prompt, from: sent.sources[0] }));
      state.jobs.unshift(...made);
      return reply(202, { jobs: made });
    }
    if (p === '/api/x/pithagoras-media/images/upload' && method === 'POST') {
      const made = pic({ kind: 'uploaded', prompt: url.searchParams.get('name') ?? '' });
      state.uploads.push({ name: url.searchParams.get('name'), type: route.request().headers()['content-type'], size: route.request().postDataBuffer()?.length ?? 0 });
      pics.push(made);
      return reply(201, { picture: made });
    }
    if (p === '/api/x/pithagoras-media/images/delete' && method === 'POST') {
      const { ids } = json();
      // As the portal says it: the whole request is refused when it names more.
      if (ids.length > 200) return reply(400, { error: 'At most 200 pictures at a time' });
      state.deleted.push(ids);
      for (const id of ids) pics.splice(pics.findIndex((x) => x.id === id), 1);
      return { deleted: ids, failed: [] };
    }
    if (/^\/api\/x\/pithagoras-media\/images\/[0-9a-f]{12}\/thumb$/.test(p)) {
      // The portal makes the small copy when it is asked for: here it is a smaller drawing.
      const id = p.split('/')[5];
      state.thumbFiles.push(id);
      await route.fulfill({ body: svg(id, 200, 150), contentType: 'image/svg+xml' });
      return DONE;
    }
    if (/^\/api\/x\/pithagoras-media\/images\/[0-9a-f]{12}\/file$/.test(p)) {
      const id = p.split('/')[5];
      state.files.push(id);
      await route.fulfill({ body: svg(id), contentType: 'image/svg+xml' });
      return DONE;
    }
  }, { settings: true });
  return {
    state,
    pics,
    /** A running job is done: its picture is in the gallery, as the portal puts it. */
    finish(id: string, over: Partial<Pic> = {}, notes?: string[]) {
      const j = state.jobs.find((x) => x.id === id)!;
      const made = pic({ prompt: j.prompt, kind: j.kind === 'edit' ? 'edited' : 'generated', from: j.from ?? null, ...over });
      pics.push(made);
      Object.assign(j, { state: 'done', pictureId: made.id, finishedAt: Date.now(), ...(notes ? { notes } : {}) });
      return made;
    },
    fail(id: string, error: string) {
      Object.assign(state.jobs.find((x) => x.id === id)!, { state: 'failed', error, finishedAt: Date.now() });
    },
  };
}

const tile = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
const grid = (page: Page) => page.getByRole('list', { name: 'Pictures' });
const viewer = (page: Page) => page.getByRole('dialog', { name: 'Picture viewer' });
const maker = (page: Page) => page.getByRole('region', { name: /Make a picture|Change a picture/ });

/** The pictures an edit works from, as the form lists them. */
const strip = (page: Page) => maker(page).getByRole('list', { name: /to work from|to change/ });
const thumbs = (page: Page) => strip(page).getByRole('img');
const names = (page: Page) => thumbs(page).evaluateAll((els) => els.map((e) => e.getAttribute('alt')));
const describe = (page: Page) => page.getByPlaceholder('Describe the change: what to add, remove or make different');

/** The form's two modes: Generate, and Edit, where the pictures of a change are chosen. */
const toEdit = (page: Page) => maker(page).getByRole('radio', { name: /^Edit/ }).click();
const toMake = (page: Page) => maker(page).getByRole('radio', { name: /^Generate/ }).click();
/** The box of a picture in the gallery: it ticks it, which a click on the picture itself does not. */
const box = (page: Page, name: string) => cell(page, name).getByRole('checkbox');
const tick = (page: Page, name: string) => box(page, name).check();
/** A change begun in the gallery: the form in Edit, and the pictures ticked in this order. */
async function pick(page: Page, ...prompts: string[]) {
  await toEdit(page);
  for (const name of prompts) await tick(page, name);
}
/** The tile of a picture in the gallery, whole: its box and its place in the edit. */
// By its picture, not its button: a tile that cannot be chosen any more has none.
const cell = (page: Page, name: string) => grid(page).getByRole('listitem').filter({ has: page.getByRole('img', { name, exact: true }) });

/** Files dropped on `target`, as a browser delivers them: a drag over it and then the drop. */
async function drop(target: Locator, files: string[]) {
  await target.evaluate((el, files) => {
    const data = new DataTransfer();
    for (const name of files) data.items.add(new File([`bytes of ${name}`], name, { type: 'image/png' }));
    el.dispatchEvent(new DragEvent('dragover', { dataTransfer: data, bubbles: true, cancelable: true }));
    el.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }));
  }, files);
}
/** A paste into `target`: pictures, and the text that came with them where there is some. */
async function paste(target: Locator, files: string[], text = '') {
  await target.evaluate((el, [files, text]: [string[], string]) => {
    const data = new DataTransfer();
    for (const name of files) data.items.add(new File([`bytes of ${name}`], name, { type: 'image/png' }));
    if (text) data.setData('text/plain', text);
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, [files, text] as [string[], string]);
}
/**
 * A picture of the page dragged up into `target`, as Chromium delivers it: a file made from the picture, with its address beside it
 * as a link and as the `<img>` it was. It is the page's own picture, though it looks like a file from the computer.
 */
async function dropOwn(target: Locator, url: string, files: string[] = ['file.png']) {
  await target.evaluate((el, [url, files]: [string, string[]]) => {
    const data = new DataTransfer();
    for (const name of files) data.items.add(new File([`bytes of ${name}`], name, { type: 'image/png' }));
    data.setData('text/uri-list', new URL(url, location.origin).href);
    data.setData('text/html', `<meta charset='utf-8'><img src="${new URL(url, location.origin).href}" alt="x">`);
    el.dispatchEvent(new DragEvent('dragover', { dataTransfer: data, bubbles: true, cancelable: true }));
    el.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }));
  }, [url, files] as [string, string[]]);
}
const png = (name: string) => ({ name, mimeType: 'image/png', buffer: Buffer.from(`bytes of ${name}`) });

async function loaded(image: Locator) {
  await expect.poll(() => image.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth > 0)).toBe(true);
}

test('the sidebar has Media only while image generation is on and has an address', async ({ page }) => {
  await portal(page, { flagOn: false });
  // The extension asks its server half whether it is on once it is loaded: what is listed is known from its answer.
  const said = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/x/pithagoras-media/state');
  await page.goto('/sessions');
  await expect(page.getByRole('button', { name: 'Sessions' }).first()).toBeVisible();
  await said;
  await expect(page.getByRole('button', { name: 'Media' })).toHaveCount(0);
});

test('Media in the sidebar opens the page, with the pictures in it: the form first, the gallery under it, newest first', async ({ page }) => {
  const a = pic({ prompt: 'A lighthouse at dusk', age: 30 });
  const b = pic({ prompt: 'A red bicycle', age: 5, origin: 'chat', chat: { id: 'c1', title: 'Holiday plans' } });
  await portal(page, { pictures: [a, b] });
  await page.goto('/sessions');
  await page.getByRole('button', { name: 'Media' }).first().click();
  await expect(page).toHaveURL(/\/x\/pithagoras-media\/media$/);
  await expect(page.getByRole('heading', { name: 'Media' })).toBeVisible();
  await expect(maker(page)).toBeVisible();
  const names = await grid(page).getByRole('button').evaluateAll((els) => els.map((e) => e.getAttribute('title')));
  expect(names).toEqual(['A red bicycle', 'A lighthouse at dusk']);
  // Where each is from, and how long ago, under it.
  await expect(grid(page).getByRole('listitem').first()).toContainText('Holiday plans');
  await expect(grid(page).getByRole('listitem').first()).toContainText('5m ago');
  await expect(grid(page).getByRole('listitem').last()).toContainText('Made');
  await expect(page.getByText('2', { exact: true }).first()).toBeVisible();
});

test('the portal is asked to look through its folders when the page opens and with Refresh, and not on each tick of the timer', async ({ page }) => {
  await page.clock.install();
  const p = await portal(page, { pictures: [pic({ prompt: 'One', age: 5 })] });
  await page.goto('/x/pithagoras-media/media');
  await expect(tile(page, 'One')).toBeVisible();
  const lists = () => p.state.listed.filter((q) => !q.includes('ids='));
  // (The dev build is in strict mode, which opens the page twice.)
  const opened = lists().length;
  expect(lists().every((q) => q === '?limit=48')).toBe(true);
  // The half minute: asked again for the top of what it has, which the portal need not look through the folders for.
  await page.clock.runFor(31_000);
  await expect.poll(() => lists().length).toBeGreaterThan(opened);
  expect(lists().slice(opened).every((q) => q.includes('again=1'))).toBe(true);
  // Refresh is asking to look.
  const before = lists().length;
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect.poll(() => lists().length).toBe(before + 1);
  expect(lists().at(-1)).toBe('?limit=48');
});


test('without video generation the viewer has no way to a video', async ({ page }) => {
  await portal(page, { pictures: [pic({ prompt: 'A lighthouse at dusk' })], videosOn: false });
  await page.goto('/x/pithagoras-media/media');
  await tile(page, 'A lighthouse at dusk').click();
  await expect(viewer(page)).toBeVisible();
  await expect(viewer(page).getByRole('button', { name: 'Make a video from it' })).toHaveCount(0);
});

test('with nothing made yet the gallery says so, and a gallery that cannot be read says that', async ({ page }) => {
  await portal(page);
  await page.goto('/x/pithagoras-media/media');
  await expect(page.getByText('No pictures yet. Describe one above to make the first.')).toBeVisible();
});

test('a gallery that cannot be read says why', async ({ page }) => {
  await portal(page, { failList: true });
  await page.goto('/x/pithagoras-media/media');
  await expect(page.getByRole('alert')).toContainText('The gallery could not be read');
});

test('with image generation and editing switched off the page says so in both modes, with the way to the setting, and still shows what there is', async ({ page }) => {
  await portal(page, { pictures: [pic({ prompt: 'Left over' })], images: feature({ enabled: false, editEnabled: false, editReady: false }), flagOn: false });
  await page.goto('/x/pithagoras-media/media');
  await expect(page.getByText('Image generation is switched off, or has no address.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Set it up under Media in Settings' })).toHaveAttribute('href', '/settings/x/pithagoras-media');
  // The form is there, with both modes, each saying that it is not set up.
  await expect(maker(page)).toBeVisible();
  await expect(maker(page).getByRole('radio', { name: /^Generate/ })).toContainText('not set up');
  await expect(maker(page).getByRole('radio', { name: /^Edit/ })).toContainText('not set up');
  await expect(page.getByRole('button', { name: 'Make the picture' })).toHaveCount(0);
  await toEdit(page);
  await expect(maker(page)).toHaveAccessibleName('Change a picture');
  await expect(maker(page).getByText('Image editing is switched off, or has no address.')).toBeVisible();
  await expect(maker(page).getByRole('link', { name: 'Set it up under Media in Settings' })).toHaveAttribute('href', '/settings/x/pithagoras-media');
  await expect(describe(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Change the picture' })).toHaveCount(0);
  await expect(tile(page, 'Left over')).toBeVisible();
});

test('with only changing set up the page opens in Edit: no form to make a picture, but pictures are chosen in the gallery or put in and changed', async ({ page }) => {
  const made = pic({ prompt: 'A fox' });
  const edited = pic({ prompt: 'Make it night', kind: 'edited', from: made.id, params: { sources: [made.id] }, age: 1 });
  const p = await portal(page, { pictures: [made, edited], images: feature({ enabled: false, baseUrl: '', editBaseUrl: 'https://edits.example.com/v1' }) });
  await page.goto('/x/pithagoras-media/media');
  // Where only changing is set up the form opens there; making says that it is not set up.
  await expect(maker(page)).toHaveAccessibleName('Change a picture');
  await expect(maker(page).getByRole('radio', { name: /^Generate/ })).toContainText('not set up');
  await expect(page.getByLabel('Upload a picture')).toBeAttached();
  await expect(page.getByPlaceholder('Describe the picture')).toHaveCount(0);
  await toMake(page);
  await expect(page.getByText('Image generation is switched off, or has no address.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Set it up under Media in Settings' })).toBeVisible();
  await expect(page.getByText('Pictures can still be changed: choose Edit above.')).toBeVisible();
  await expect(page.getByPlaceholder('Describe the picture')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Make the picture' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Advanced' })).toHaveCount(0);
  await expect(tile(page, 'A fox')).toBeVisible();
  // A picture is chosen from the gallery, and that form has its words.
  await toEdit(page);
  await tick(page, 'A fox');
  await expect.poll(() => names(page)).toEqual(['A fox']);
  await describe(page).fill('Add a hat');
  await page.getByRole('button', { name: 'Change the picture' }).click();
  await expect.poll(() => p.state.edited.length).toBe(1);
  expect(p.state.edited[0].sources).toEqual([made.id]);
  // A change can be made again, which is not making one from nothing.
  await tile(page, 'Make it night').click();
  await expect(viewer(page).getByRole('button', { name: 'Run again' })).toBeVisible();
  await page.keyboard.press('Escape');
  await tile(page, 'A fox').click();
  await expect(viewer(page).getByRole('button', { name: 'Run again' })).toHaveCount(0);
});

test('whether pictures can be made is what the portal says, not worked out again from the address', async ({ page }) => {
  // Switched on and with an address, but the portal says that it is not ready: the page believes it, in the form and in the viewer.
  await portal(page, { pictures: [pic({ prompt: 'A fox' })], images: feature({ ready: false }) });
  await page.goto('/x/pithagoras-media/media');
  await expect(maker(page).getByRole('radio', { name: /^Generate/ })).toContainText('not set up');
  await tile(page, 'A fox').click();
  await expect(viewer(page).getByRole('button', { name: 'Run again' })).toHaveCount(0);
});

test('with only making set up Edit is still there, and says that it is not set up and where to switch it on; there is no upload', async ({ page }) => {
  await portal(page, { pictures: [pic({ prompt: 'A fox' })], images: feature({ editEnabled: false, editReady: false }) });
  await page.goto('/x/pithagoras-media/media');
  await expect(page.getByPlaceholder('Describe the picture')).toBeVisible();
  await expect(maker(page).getByRole('radio', { name: /^Edit/ })).toContainText('not set up');
  await expect(page.getByLabel('Upload a picture')).toHaveCount(0);
  await tile(page, 'A fox').click();
  await expect(viewer(page).getByRole('button', { name: 'Run again' })).toBeVisible();
  // Edit it is there too, and leads to the form, which says why there is nothing to edit with.
  await viewer(page).getByRole('button', { name: 'Edit it' }).click();
  await expect(viewer(page)).toHaveCount(0);
  await expect(maker(page)).toHaveAccessibleName('Change a picture');
  await expect(maker(page).getByText('Image editing is switched off, or has no address.')).toBeVisible();
  await expect(maker(page).getByRole('link', { name: 'Set it up under Media in Settings' })).toHaveAttribute('href', '/settings/x/pithagoras-media');
  await expect(page.getByLabel('Upload a picture')).toHaveCount(0);
  await expect(describe(page)).toHaveCount(0);
  // Back to making, which still works.
  await toMake(page);
  await expect(page.getByPlaceholder('Describe the picture')).toBeVisible();
});

test('the filters ask the portal for what they say, and are in the address', async ({ page }) => {
  const p = await portal(page, { pictures: [pic({ prompt: 'Mine' }), pic({ prompt: 'The agent’s', origin: 'chat', chat: { id: 'c1', title: 'A chat' } }), pic({ prompt: 'Changed one', kind: 'edited' })] });
  await page.goto('/x/pithagoras-media/media');
  await expect(grid(page).getByRole('listitem')).toHaveCount(3);
  await page.getByRole('radiogroup', { name: 'Where from' }).getByRole('radio', { name: 'From chats' }).click();
  await expect(page).toHaveURL(/\/x\/pithagoras-media\/media\?origin=chat$/);
  await expect(grid(page).getByRole('listitem')).toHaveCount(1);
  await expect(tile(page, 'The agent’s')).toBeVisible();
  expect(p.state.listed.some((q) => q.includes('origin=chat'))).toBe(true);
  await page.getByRole('radiogroup', { name: 'Where from' }).getByRole('radio', { name: 'All' }).click();
  await page.getByRole('radiogroup', { name: 'How it was made' }).getByRole('radio', { name: 'Changed' }).click();
  await expect(page).toHaveURL(/\/x\/pithagoras-media\/media\?kind=edited$/);
  await expect(grid(page).getByRole('listitem')).toHaveCount(1);
  await expect(tile(page, 'Changed one')).toBeVisible();
  // Back goes through the filters, one at a time: the unfiltered list in between, and the chats before it.
  await page.goBack();
  await expect(page).toHaveURL(/\/x\/pithagoras-media\/media$/);
  await expect(grid(page).getByRole('listitem')).toHaveCount(3);
  await page.goBack();
  await expect(page).toHaveURL(/\/x\/pithagoras-media\/media\?origin=chat$/);
  await expect(grid(page).getByRole('listitem')).toHaveCount(1);
  await expect(tile(page, 'The agent’s')).toBeVisible();
  // A link with a filter in it opens on it.
  await page.goto('/x/pithagoras-media/media?origin=chat&kind=generated');
  await expect(page.getByRole('radiogroup', { name: 'Where from' }).getByRole('radio', { name: 'From chats' })).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByRole('radiogroup', { name: 'How it was made' }).getByRole('radio', { name: 'Made', exact: true })).toHaveAttribute('aria-checked', 'true');
  await expect(grid(page).getByRole('listitem')).toHaveCount(1);
});

/** A picture the portal found in a folder the agent's tools write into: nothing was kept of how it was made. */
const found = (over: Partial<Pic> & { age?: number } = {}) => pic({ origin: 'folder', kind: 'unknown', prompt: '', folder: { name: 'garden', home: false }, ...over });

test('a picture found in an agent\'s home says which agent, the first one included, and Home only where the server gave no name', async ({ page }) => {
  const first = found({ fileName: 'owl.png', folder: { name: 'Nova', home: true }, age: 3 });
  const other = found({ fileName: 'fox.png', folder: { name: 'Research Bot', home: false }, age: 2 });
  const unnamed = found({ fileName: 'moth.png', folder: { name: '', home: true }, age: 1 });
  await portal(page, { pictures: [first, other, unnamed] });
  await page.goto('/x/pithagoras-media/media');
  await expect(grid(page).getByRole('listitem')).toHaveCount(3);
  await expect(grid(page).getByRole('listitem').filter({ hasText: 'Nova' })).toHaveCount(1);
  await expect(grid(page).getByRole('listitem').filter({ hasText: 'Research Bot' })).toHaveCount(1);
  await expect(grid(page).getByRole('listitem').filter({ hasText: 'Home' })).toHaveCount(1);
});

test('pictures that were found in a folder are in the gallery by their file name, say where they are, and are filtered', async ({ page }) => {
  const named = found({ fileName: 'fox.png', age: 3 });
  const home = found({ fileName: 'owl.png', folder: { name: '', home: true }, kind: 'generated', age: 2 });
  const p = await portal(page, { pictures: [pic({ prompt: 'Mine', age: 1 }), named, home] });
  await page.goto('/x/pithagoras-media/media');
  await expect(grid(page).getByRole('listitem')).toHaveCount(3);
  // Without a description a tile is called by its file, and says which folder it is in: Home or the project's.
  await expect(tile(page, 'fox.png')).toBeVisible();
  await expect(grid(page).getByRole('listitem').filter({ hasText: 'garden' })).toHaveCount(1);
  await expect(grid(page).getByRole('listitem').filter({ hasText: 'Home' })).toHaveCount(1);
  await page.getByRole('radiogroup', { name: 'Where from' }).getByRole('radio', { name: 'From folders' }).click();
  await expect(page).toHaveURL(/\/x\/pithagoras-media\/media\?origin=folder$/);
  await expect(grid(page).getByRole('listitem')).toHaveCount(2);
  expect(p.state.listed.some((q) => q.includes('origin=folder'))).toBe(true);
  await page.getByRole('radiogroup', { name: 'How it was made' }).getByRole('radio', { name: 'Not known' }).click();
  await expect(page).toHaveURL(/\/x\/pithagoras-media\/media\?origin=folder&kind=unknown$/);
  await expect(grid(page).getByRole('listitem')).toHaveCount(1);
  await expect(tile(page, 'fox.png')).toBeVisible();
  // A link with them in it opens on them.
  await page.goto('/x/pithagoras-media/media?kind=unknown');
  await expect(page.getByRole('radiogroup', { name: 'How it was made' }).getByRole('radio', { name: 'Not known' })).toHaveAttribute('aria-checked', 'true');
  await expect(grid(page).getByRole('listitem')).toHaveCount(1);
});

test('Details of a picture that was found says where, and that nothing is kept of how it was made; it can be changed but not run again', async ({ page }) => {
  await portal(page, { pictures: [found({ fileName: 'fox.png', createdAt: Date.parse('2026-09-30T08:15:00Z'), bytes: 2_500_000 })] });
  await page.goto('/x/pithagoras-media/media');
  await tile(page, 'fox.png').click();
  await expect(viewer(page).getByRole('button', { name: 'Edit it' })).toBeVisible();
  await expect(viewer(page).getByRole('button', { name: 'Run again' })).toHaveCount(0);
  await viewer(page).getByRole('button', { name: 'Details' }).click();
  const details = viewer(page).getByRole('region', { name: 'Details' });
  await expect(details).toContainText('In the folder “garden”');
  await expect(details).toContainText('Nothing tells how it was made');
  await expect(details).toContainText('fox.png · 2.4 MB');
  await expect(details).toContainText('Nothing was kept of what it was asked for');
  await expect(details.getByText('Description')).toHaveCount(0);
  await expect(details.getByRole('link', { name: 'Open the chat' })).toHaveCount(0);
});

test('a picture that was found is deleted only on purpose, with the folder named, whatever Settings says', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('confirmDeletes', 'off'));
  const theirs = found({ fileName: 'fox.png', age: 5 });
  const other = found({ fileName: 'owl.png', folder: { name: 'work/art', home: false }, age: 4 });
  const mine = pic({ prompt: 'Mine' });
  const p = await portal(page, { pictures: [theirs, other, mine] });
  await page.goto('/x/pithagoras-media/media');
  await tile(page, 'fox.png').click();
  await viewer(page).getByRole('button', { name: 'Delete' }).click();
  const dialog = page.getByRole('alertdialog', { name: 'Delete this picture?' });
  await expect(dialog).toContainText('the folder “garden”');
  await expect(dialog).toContainText('for good');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  expect(p.state.deleted).toEqual([]);
  // With others, one question for all of them, which says what is in a folder.
  await page.keyboard.press('Escape');
  await tick(page, 'fox.png');
  await page.getByRole('button', { name: 'Select all shown' }).click();
  await page.getByRole('button', { name: 'Delete' }).click();
  const several = page.getByRole('alertdialog', { name: 'Delete these 3 pictures?' });
  await expect(several).toContainText('2 of them are files in folders');
  await several.getByRole('button', { name: 'Delete' }).click();
  await expect.poll(() => p.state.deleted.flat().sort()).toEqual([theirs.id, other.id, mine.id].sort());
});

test('a gallery of hundreds is asked for a page at a time, and pictures far down are not fetched', async ({ page }) => {
  // A phone is narrow, so the forty-eight of a page are a long column: most of them are far from the screen.
  await page.setViewportSize({ width: 375, height: 760 });
  const many = Array.from({ length: 150 }, (_, i) => pic({ prompt: `Many ${i + 1}`, age: i }));
  const p = await portal(page, { pictures: many });
  await page.goto('/x/pithagoras-media/media');
  await expect(grid(page).getByRole('listitem')).toHaveCount(48);
  expect(p.state.listed[0]).toContain('limit=48');
  await expect(page.getByText('150', { exact: true }).first()).toBeVisible();
  // What is near the screen is fetched, not all forty-eight.
  await expect.poll(() => p.state.files.length).toBeGreaterThan(0);
  await page.waitForTimeout(300);
  expect(p.state.files.length).toBeLessThan(36);
  const before = p.state.files.length;
  await page.getByRole('button', { name: 'Show more' }).scrollIntoViewIfNeeded();
  await expect.poll(() => p.state.files.length).toBeGreaterThan(before);
  await expect(grid(page).getByRole('listitem')).toHaveCount(96);
  expect(p.state.listed.some((q) => q.includes('before='))).toBe(true);
  // Newest first all the way down, none twice.
  const titles = await grid(page).getByRole('button').evaluateAll((els) => els.map((e) => e.getAttribute('title')));
  expect(titles[0]).toBe('Many 1');
  expect(titles[95]).toBe('Many 96');
  expect(new Set(titles).size).toBe(96);
});

test('making a picture starts a job that holds its place in the grid, and the picture arrives there', async ({ page }) => {
  const p = await portal(page, { pictures: [pic({ prompt: 'Older', age: 60 })] });
  await page.goto('/x/pithagoras-media/media');
  await page.getByPlaceholder('Describe the picture').fill('A fox in the snow');
  await page.getByRole('button', { name: 'Make the picture' }).click();
  expect(p.state.generated).toEqual([{ prompt: 'A fox in the snow', count: 1 }]);
  // The wait is the first tile, where the picture will be.
  const waiting = grid(page).locator('.image-preview.is-making');
  await expect(waiting).toHaveCount(1);
  await expect(waiting).toContainText('Making a picture');
  await expect(page.getByText('1 of 4 being made')).toBeVisible();
  const first = grid(page).getByRole('listitem').first();
  await expect(first.locator('.image-preview.is-making')).toBeVisible();
  const made = p.finish(p.state.jobs[0].id);
  await expect(tile(page, 'A fox in the snow')).toBeVisible();
  await expect(grid(page).locator('.image-preview.is-making')).toHaveCount(0);
  await expect(grid(page).getByRole('listitem')).toHaveCount(2);
  // The same place: first, and the one that was made, once.
  await expect(grid(page).getByRole('listitem').first().getByRole('button')).toHaveAttribute('data-picture-id', made.id);
  await expect(page.getByText('1 of 4 being made')).toHaveCount(0);
});

test('a picture made here and deleted somewhere else is not kept as a tile by its job', async ({ page }) => {
  const p = await portal(page, { pictures: [pic({ prompt: 'Older', age: 60 })] });
  await page.goto('/x/pithagoras-media/media');
  await page.getByPlaceholder('Describe the picture').fill('A fox in the snow');
  await page.getByRole('button', { name: 'Make the picture' }).click();
  const made = p.finish(p.state.jobs[0].id);
  await expect(tile(page, 'A fox in the snow')).toBeVisible();
  // Deleted in another tab: the portal has not got it any more, and its job, which it keeps for an hour, still says it made it.
  p.pics.splice(p.pics.findIndex((x) => x.id === made.id), 1);
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(tile(page, 'A fox in the snow')).toHaveCount(0);
  await expect(grid(page).getByRole('listitem')).toHaveCount(1);
  await expect(tile(page, 'Older')).toBeVisible();
});

test('a picture made here does not stay above one that came after it: the grid is newest first, and the viewer steps in its order', async ({ page }) => {
  const p = await portal(page, { pictures: [pic({ prompt: 'Older', age: 60 })] });
  await page.goto('/x/pithagoras-media/media');
  await page.getByPlaceholder('Describe the picture').fill('A fox in the snow');
  await page.getByRole('button', { name: 'Make the picture' }).click();
  const made = p.finish(p.state.jobs[0].id);
  await expect(tile(page, 'A fox in the snow')).toBeVisible();
  // Putting a picture in from this computer is a way to change one: it is in Edit.
  await toEdit(page);
  await page.getByLabel('Upload a picture').setInputFiles({ name: 'cat.png', mimeType: 'image/png', buffer: Buffer.from('not really a png, the portal looks') });
  await expect(tile(page, 'cat.png')).toBeVisible();
  await toMake(page);
  // The upload is the newest, so it is the first; the one that was made keeps the tile it had, below it.
  const titles = () => grid(page).getByRole('button').evaluateAll((els) => els.map((e) => e.getAttribute('title')));
  await expect.poll(titles).toEqual(['cat.png', 'A fox in the snow', 'Older']);
  await grid(page).getByRole('listitem').first().getByRole('button').click();
  await expect(viewer(page).getByText('1 / 3', { exact: true })).toBeVisible();
  await viewer(page).getByRole('button', { name: 'Next picture' }).click();
  await expect(viewer(page).locator('img[data-picture]')).toHaveAttribute('src', `/api/x/pithagoras-media/images/${made.id}/file`);
});

/** The settings of the form, written as a person would: the fields by their labels. */
const fillOpenAi = async (page: Page) => {
  await page.getByLabel('Model').fill('draw-2');
  await page.getByLabel('Width').fill('768');
  await page.getByLabel('Height').fill('512');
  await page.getByRole('combobox', { name: 'How many' }).click();
  await page.getByRole('option', { name: '2', exact: true }).click();
  await page.getByRole('button', { name: 'Advanced' }).click();
  await page.getByRole('combobox', { name: 'File format' }).click();
  await page.getByRole('option', { name: 'JPEG' }).click();
  await page.getByLabel('Compression').fill('80');
};
/** The less usual settings are in the form's Advanced fold: opened here if it is closed. Nothing else of the form is a box of its own. */
async function advanced(page: Page) {
  const toggle = page.getByRole('button', { name: 'Advanced' });
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  return maker(page);
}
const TIP = 'Using stable-diffusion.cpp? Switch on “Stable Diffusion extra settings” under Media in Settings for more options.';

test('the settings of a request are sent as set, and are kept for the next visit, not the words', async ({ page }) => {
  const p = await portal(page);
  await page.goto('/x/pithagoras-media/media');
  await fillOpenAi(page);
  await page.getByPlaceholder('Describe the picture').fill('Two boats');
  await page.getByRole('button', { name: 'Make 2 pictures' }).click();
  // Only what is set, and as numbers where they are numbers.
  expect(p.state.generated).toEqual([{ prompt: 'Two boats', model: 'draw-2', size: '768x512', outputFormat: 'jpeg', outputCompression: 80, count: 2 }]);
  await expect(grid(page).locator('.image-preview.is-making')).toHaveCount(2);
  await page.reload();
  await expect(page.getByLabel('Model')).toHaveValue('draw-2');
  await expect(page.getByLabel('Width')).toHaveValue('768');
  await expect(page.getByLabel('Height')).toHaveValue('512');
  await expect(page.getByRole('combobox', { name: 'How many' })).toHaveText('2');
  // The fold is as it was left, open here, with what is in it.
  await expect(page.getByRole('button', { name: 'Advanced' })).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('combobox', { name: 'File format' })).toHaveText('JPEG');
  await expect(page.getByLabel('Compression')).toHaveValue('80');
  await expect(page.getByPlaceholder('Describe the picture')).toHaveValue('');
});

test('a field that is left empty shows what is used instead, and sends nothing; the model and size of the add-on are those', async ({ page }) => {
  const p = await portal(page, { images: feature({ model: 'saved-model', size: '640x480', editModel: 'edit-model' }) });
  await page.goto('/x/pithagoras-media/media');
  await expect(page.getByLabel('Model')).toHaveAttribute('placeholder', 'saved-model');
  await expect(page.getByLabel('Width')).toHaveAttribute('placeholder', '640');
  await expect(page.getByLabel('Height')).toHaveAttribute('placeholder', '480');
  await page.getByPlaceholder('Describe the picture').fill('A boat');
  await page.getByRole('button', { name: 'Make the picture' }).click();
  expect(p.state.generated).toEqual([{ prompt: 'A boat', count: 1 }]);
  // A change has its own model, and no size: what it comes out as is the endpoint's to say.
  await toEdit(page);
  await expect(page.getByLabel('Model')).toHaveAttribute('placeholder', 'edit-model');
  await expect(page.getByLabel('Width')).toHaveAttribute('placeholder', "The endpoint's own");
  // Making and changing keep their own settings.
  await page.getByLabel('Model').fill('only-for-edits');
  await toMake(page);
  await expect(page.getByLabel('Model')).toHaveValue('');
});

test('without the Stable Diffusion switch only the OpenAI settings are there, and nothing else is sent, whatever was typed before', async ({ page }) => {
  // What an earlier visit left in the form, with the switch on then.
  await page.addInitScript(() => {
    localStorage.setItem('imagesForm', JSON.stringify({ make: { negativePrompt: 'blurry', sampleSteps: '20', width: '512', height: '512' }, edit: { negativePrompt: 'noisy', strength: '0.5' }, count: 1, open: true }));
  });
  const first = pic({ prompt: 'A fox' });
  const p = await portal(page, { pictures: [first] });
  await page.goto('/x/pithagoras-media/media');
  const form = await advanced(page);
  for (const name of ['Negative prompt', 'Seed', 'Steps', 'Strength']) await expect(page.getByLabel(name)).toHaveCount(0);
  // Under Advanced a quiet line says where more is switched on, with the way there, and the form has no box for what is not shown.
  const tip = form.getByText(TIP);
  await expect(tip).toBeVisible();
  await expect(tip.getByRole('link', { name: 'Media in Settings' })).toHaveAttribute('href', '/settings/x/pithagoras-media');
  expect(await tip.evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBeLessThanOrEqual(12);
  await expect(form.locator('fieldset')).toHaveCount(0);
  await expect(page.getByRole('group', { name: /stable-diffusion/i })).toHaveCount(0);
  await expect(page.getByLabel('Width')).toHaveValue('512');
  await page.getByPlaceholder('Describe the picture').fill('A boat');
  await page.getByRole('button', { name: 'Make the picture' }).click();
  expect(p.state.generated).toEqual([{ prompt: 'A boat', size: '512x512', count: 1 }]);
  await toEdit(page);
  await expect(page.getByRole('radio', { name: 'Noise only' })).toHaveCount(0);
  await expect(page.getByLabel('Strength')).toHaveCount(0);
  // The tip is there for a change as well, under the same fold.
  await expect(maker(page).getByText(TIP)).toBeVisible();
  await tick(page, 'A fox');
  await describe(page).fill('Add a hat');
  await page.getByRole('button', { name: 'Change the picture' }).click();
  await expect.poll(() => p.state.edited.length).toBe(1);
  expect(p.state.edited[0]).toEqual({ prompt: 'Add a hat', sources: [first.id], count: 1 });
});

test('with the Stable Diffusion switch on its fields are plain fields under the Advanced ones, in the same style and with no box or tip of their own, and are sent', async ({ page }) => {
  const p = await portal(page, { images: feature({ sdExtras: true }) });
  await page.goto('/x/pithagoras-media/media');
  // Under Advanced, which is closed until it is opened: nothing of it before.
  for (const name of ['Negative prompt', 'Seed', 'Steps']) await expect(page.getByLabel(name)).toHaveCount(0);
  const form = await advanced(page);
  // Not a box, not a heading of its own, and no tip of where to switch it on, since it is on.
  await expect(form.locator('fieldset')).toHaveCount(0);
  await expect(form.getByRole('group', { name: /stable-diffusion/i })).toHaveCount(0);
  await expect(form.getByText('Stable Diffusion (stable-diffusion.cpp)')).toHaveCount(0);
  await expect(form.getByText(TIP)).toHaveCount(0);
  await expect(form.getByText(/Using stable-diffusion\.cpp\?/)).toHaveCount(0);
  await expect(form.getByText('For stable-diffusion.cpp servers only: these are added to the description as a block that its server reads.')).toBeVisible();
  // For a new picture: no strength, and no way to start from noise.
  await expect(page.getByLabel('Strength')).toHaveCount(0);
  await expect(page.getByRole('radio', { name: 'Noise only' })).toHaveCount(0);
  // Right under the fields of the OpenAI format, in their frame and their style: the nearest box around each is the same one.
  const frameOf = (label: string) => form.getByLabel(label).evaluate((el) => {
    let box = el.parentElement;
    while (box && parseFloat(getComputedStyle(box).borderTopWidth) === 0) box = box.parentElement;
    box!.dataset.frame ??= String(Math.random());
    return box!.dataset.frame;
  });
  const frame = await frameOf('Compression');
  for (const label of ['Seed', 'Steps', 'Negative prompt']) expect(await frameOf(label), label).toBe(frame);
  const at = async (label: string) => (await form.getByLabel(label).boundingBox())!;
  expect((await at('Seed')).y).toBeGreaterThan((await at('Compression')).y);
  expect((await at('Negative prompt')).y).toBeGreaterThan((await at('Seed')).y);
  const style = (label: string) => form.getByLabel(label).evaluate((el) => { const css = getComputedStyle(el); return [css.fontSize, css.fontFamily, css.borderTopWidth, css.borderTopLeftRadius, css.height].join('|'); });
  expect(await style('Seed')).toBe(await style('Compression'));

  await form.getByLabel('Negative prompt').fill('blurry, "text"');
  await form.getByLabel('Seed').fill('42');
  await form.getByLabel('Steps').fill('20');
  await page.getByPlaceholder('Describe the picture').fill('A boat');
  await page.getByRole('button', { name: 'Make the picture' }).click();
  expect(p.state.generated).toEqual([{ prompt: 'A boat', negativePrompt: 'blurry, "text"', seed: 42, sampleSteps: 20, count: 1 }]);
  // Kept for the next visit, but the seed is not: it would make the same picture every time.
  await page.reload();
  const again = await advanced(page);
  await expect(again.getByLabel('Negative prompt')).toHaveValue('blurry, "text"');
  await expect(again.getByLabel('Steps')).toHaveValue('20');
  await expect(again.getByLabel('Seed')).toHaveValue('');
});

test('the fields of stable-diffusion.cpp are there only while the switch is on: it comes on with the page, and takes them away again, and the tip with it', async ({ page }) => {
  const feat = feature({ sdExtras: false });
  const p = await portal(page, { images: feat });
  await page.goto('/x/pithagoras-media/media');
  const form = await advanced(page);
  await expect(form.getByText(TIP)).toBeVisible();
  await expect(page.getByLabel('Seed')).toHaveCount(0);
  // Another visit, with the switch on in Settings meanwhile.
  Object.assign(feat, { sdExtras: true });
  await page.reload();
  const on = await advanced(page);
  await expect(on.getByLabel('Seed')).toBeVisible();
  await expect(on.getByText(TIP)).toHaveCount(0);
  Object.assign(feat, { sdExtras: false });
  await page.reload();
  const off = await advanced(page);
  await expect(off.getByLabel('Seed')).toHaveCount(0);
  await expect(off.getByText(TIP)).toBeVisible();
  expect(p.state.generated).toEqual([]);
});

test('in Edit its fields have a strength and a start from noise: the strength is for the picture that is built on, and neither it nor a mask goes without one', async ({ page }) => {
  const first = pic({ prompt: 'A fox' });
  const second = pic({ prompt: 'A hat' });
  const p = await portal(page, { pictures: [first, second], images: feature({ sdExtras: true, editMultiple: true }) });
  await page.goto('/x/pithagoras-media/media');
  await pick(page, 'A fox', 'A hat');
  // Under Advanced like the rest: nothing of it while the fold is shut, and no box of its own once it is open.
  await expect(page.getByLabel('Strength')).toHaveCount(0);
  await expect(page.getByRole('radio', { name: 'Noise only' })).toHaveCount(0);
  const block = await advanced(page);
  await expect(block.locator('fieldset')).toHaveCount(0);
  await block.getByLabel('Strength').fill('0,75');
  await expect(block.getByRole('radio', { name: 'The first picture' })).toHaveAttribute('aria-checked', 'true');
  await expect(block).toContainText('The first picture is the base that is built on. Strength and a mask work on it.');
  await expect(block).toContainText('tends to decide how far the result may go from the first picture');
  await expect(block).toContainText('such as 0.75 or more');
  await describe(page).fill('The fox in the hat');
  await page.getByRole('button', { name: 'Change the picture' }).click();
  await expect.poll(() => p.state.edited.length).toBe(1);
  expect(p.state.edited[0]).toEqual({ prompt: 'The fox in the hat', sources: [first.id, second.id], strength: 0.75, count: 1 });

  // From noise: the pictures are references, and the strength and the mask are gone, and not sent.
  await expect(maker(page).getByRole('button', { name: 'Only change a part: paint a mask' })).toBeVisible();
  await block.getByRole('radio', { name: 'Noise only' }).click();
  await expect(block.getByRole('radio', { name: 'Noise only' })).toHaveAttribute('aria-checked', 'true');
  await expect(block.getByLabel('Strength')).toBeDisabled();
  await expect(block).toContainText('There is no strength when the result starts from noise.');
  await expect(block).toContainText('The result starts from noise only. The description and all the pictures are used as references; strength and a mask do not apply.');
  await expect(maker(page).getByRole('button', { name: 'Only change a part: paint a mask' })).toHaveCount(0);
  await expect(maker(page)).toContainText('so the first one tends to count less than it does as the base');
  await page.getByRole('button', { name: 'Change the picture' }).click();
  await expect.poll(() => p.state.edited.length).toBe(2);
  expect(p.state.edited[1]).toEqual({ prompt: 'The fox in the hat', sources: [first.id, second.id], fromNoise: true, count: 1 });

  // Back to the picture, the strength is as it was typed; and the start from noise is not kept for the next visit.
  await block.getByRole('radio', { name: 'The first picture' }).click();
  await expect(block.getByLabel('Strength')).toHaveValue('0,75');
  await block.getByRole('radio', { name: 'Noise only' }).click();
  await page.reload();
  await toEdit(page);
  await expect((await advanced(page)).getByRole('radio', { name: 'The first picture' })).toHaveAttribute('aria-checked', 'true');
});

test('a setting that is wrong is said, with the field it is in marked and focused, and nothing is sent', async ({ page }) => {
  const p = await portal(page, { images: feature({ sdExtras: true }) });
  await page.goto('/x/pithagoras-media/media');
  await page.getByPlaceholder('Describe the picture').fill('A boat');
  const make = page.getByRole('button', { name: 'Make the picture' });
  const alert = page.getByRole('alert');

  await page.getByLabel('Width').fill('512');
  await make.click();
  await expect(alert).toHaveText('Set both width and height, or leave both empty.');
  await expect(page.getByLabel('Height')).toBeFocused();
  await expect(page.getByLabel('Height')).toHaveAttribute('aria-invalid', 'true');
  await page.getByLabel('Height').fill('99999');
  await expect(page.getByLabel('Height')).not.toHaveAttribute('aria-invalid', 'true');
  await make.click();
  await expect(alert).toHaveText('Width and height are whole numbers from 64 to 8192.');
  await page.getByLabel('Width').fill('');
  await page.getByLabel('Height').fill('');

  // Under Advanced, which is opened to show it.
  await page.getByRole('button', { name: 'Advanced' }).click();
  await page.getByRole('combobox', { name: 'File format' }).click();
  await page.getByRole('option', { name: 'WebP' }).click();
  await page.getByLabel('Compression').fill('101');
  await page.getByRole('button', { name: 'Advanced' }).click();
  await make.click();
  await expect(alert).toHaveText('The compression is a whole number from 0 to 100.');
  await expect(page.getByRole('button', { name: 'Advanced' })).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByLabel('Compression')).toBeFocused();
  await page.getByLabel('Compression').fill('');

  // The same fold, with the fields of stable-diffusion.cpp in it: opened again where a problem is in one of them.
  const block = maker(page);
  await block.getByLabel('Seed').fill('1.5');
  await page.getByRole('button', { name: 'Advanced' }).click();
  await expect(page.getByLabel('Seed')).toHaveCount(0);
  await make.click();
  await expect(alert).toHaveText('The seed is a whole number, 0 or more, or -1 for a random one.');
  await expect(page.getByRole('button', { name: 'Advanced' })).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByLabel('Seed')).toBeFocused();
  await page.getByLabel('Seed').fill('');
  for (const [label, value, message] of [
    ['Seed', '1.5', 'The seed is a whole number, 0 or more, or -1 for a random one.'],
    ['Seed', '-2', 'The seed is a whole number, 0 or more, or -1 for a random one.'],
    ['Steps', '0', 'The steps are a whole number from 1 to 100.'],
    ['Steps', '101', 'The steps are a whole number from 1 to 100.'],
    ['Negative prompt', 'x'.repeat(4001), 'The negative prompt is over 4000 characters.'],
  ] as const) {
    await block.getByLabel(label).fill(value);
    await make.click();
    await expect(alert, `${label} ${value.slice(0, 5)}`).toHaveText(message);
    await expect(block.getByLabel(label)).toBeFocused();
    await block.getByLabel(label).fill('');
  }
  expect(p.state.generated).toEqual([]);
  // With them put right, it goes.
  await make.click();
  await expect.poll(() => p.state.generated.length).toBe(1);
  expect(p.state.generated[0]).toEqual({ prompt: 'A boat', outputFormat: 'webp', count: 1 });
  await expect(alert).toHaveCount(0);
});

test('a compression is only for a format that has one: it is off and says so for the others, and not sent', async ({ page }) => {
  const p = await portal(page);
  await page.goto('/x/pithagoras-media/media');
  await page.getByRole('button', { name: 'Advanced' }).click();
  const compression = page.getByLabel('Compression');
  await expect(compression).toBeDisabled();
  await expect(page.getByText('Choose JPEG or WebP as the file format to set a compression.')).toBeVisible();
  await page.getByRole('combobox', { name: 'File format' }).click();
  await page.getByRole('option', { name: 'WebP' }).click();
  await expect(compression).toBeEnabled();
  await compression.fill('60');
  await page.getByRole('combobox', { name: 'File format' }).click();
  await page.getByRole('option', { name: 'PNG' }).click();
  await expect(compression).toBeDisabled();
  await page.getByPlaceholder('Describe the picture').fill('A boat');
  await page.getByRole('button', { name: 'Make the picture' }).click();
  expect(p.state.generated).toEqual([{ prompt: 'A boat', outputFormat: 'png', count: 1 }]);
});

test('how many is the portal\'s own dropdown, not the browser\'s: it works by keyboard, and is drawn on the theme and within a phone', async ({ page }) => {
  const p = await portal(page);
  await page.goto('/x/pithagoras-media/media');
  // Nothing on the page is a native select, whose open list ignores the theme.
  await expect(page.locator('select')).toHaveCount(0);
  const many = page.getByRole('combobox', { name: 'How many' });
  await expect(many).toHaveText('1');

  // Keys alone: ArrowDown opens the list on the one that is set, the arrows move, Enter takes, and Escape leaves it as it was.
  await many.focus();
  await many.press('ArrowDown');
  const list = page.getByRole('listbox', { name: 'How many' });
  await expect(list.getByRole('option')).toHaveText(['1', '2', '3', '4']);
  await many.press('ArrowDown');
  await many.press('ArrowDown');
  await many.press('Enter');
  await expect(list).toHaveCount(0);
  await expect(many).toHaveText('3');
  await expect(many).toBeFocused();
  await many.press('ArrowDown');
  await many.press('End');
  await many.press('Escape');
  await expect(list).toHaveCount(0);
  await expect(many).toHaveText('3');
  // Typing a digit jumps to it.
  await many.press('Space');
  await many.press('2');
  await many.press('Enter');
  await expect(many).toHaveText('2');
  await page.getByPlaceholder('Describe the picture').fill('Two boats');
  await page.getByRole('button', { name: 'Make 2 pictures' }).click();
  expect(p.state.generated.map((g) => g.count)).toEqual([2]);

  // On the theme, and beside the fields of the row at their height; on a phone the list stays on the screen.
  for (const [scheme, width] of [['light', 1100], ['dark', 1100], ['light', 375], ['dark', 375]] as const) {
    await page.setViewportSize({ width, height: 760 });
    await page.emulateMedia({ colorScheme: scheme });
    await many.click();
    await expect(list).toBeVisible();
    const [ground, box, own, field] = await Promise.all([
      list.evaluate((el) => getComputedStyle(el).backgroundColor.match(/\d+/g)!.slice(0, 3).map(Number)),
      list.boundingBox(),
      many.boundingBox(),
      page.getByLabel('Width').boundingBox(),
    ]);
    const brightness = ground.reduce((a, b) => a + b, 0) / 3;
    if (scheme === 'dark') expect(brightness, `${scheme} ${width}`).toBeLessThan(90);
    else expect(brightness, `${scheme} ${width}`).toBeGreaterThan(165);
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(width);
    expect(Math.abs(own!.height - field!.height), `${scheme} ${width}`).toBeLessThanOrEqual(2);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await many.press('Escape');
    await expect(list).toHaveCount(0);
  }
});

test('what the portal refuses is shown, and a button does nothing without words', async ({ page }) => {
  const p = await portal(page);
  await page.goto('/x/pithagoras-media/media');
  await expect(page.getByRole('button', { name: 'Make the picture' })).toBeDisabled();
  await page.getByPlaceholder('Describe the picture').fill('refuse me');
  await page.getByRole('button', { name: 'Make the picture' }).click();
  await expect(page.getByRole('alert')).toContainText('4 pictures are being made already');
  expect(p.state.jobs).toEqual([]);
});

test('when as many pictures are being made as may be, no more is started from the form', async ({ page }) => {
  const now = Date.now();
  const running: Job[] = Array.from({ length: 4 }, (_, i) => ({ id: `r${i}`.padEnd(12, '0'), kind: 'generate', state: 'running', prompt: `Running ${i}`, startedAt: now - i }));
  await portal(page, { jobs: running });
  await page.goto('/x/pithagoras-media/media');
  await expect(grid(page).locator('.image-preview.is-making')).toHaveCount(4);
  await page.getByPlaceholder('Describe the picture').fill('One too many');
  await expect(page.getByRole('button', { name: 'Make the picture' })).toBeDisabled();
});

test('a picture that was not made says why, and can be dismissed; one that is being made can be stopped', async ({ page }) => {
  const now = Date.now();
  const p = await portal(page, {
    jobs: [
      { id: 'a'.repeat(12), kind: 'generate', state: 'failed', prompt: 'Refused picture', startedAt: now - 5000, finishedAt: now - 4000, error: 'The image endpoint answered 400: that prompt is not allowed' },
      { id: 'b'.repeat(12), kind: 'generate', state: 'running', prompt: 'Slow picture', startedAt: now - 9000 },
    ],
  });
  await page.goto('/x/pithagoras-media/media');
  const failed = grid(page).locator('.image-preview.is-failed');
  await expect(failed).toContainText('No picture was made');
  await expect(failed).toContainText('that prompt is not allowed');
  await failed.getByRole('button', { name: 'Dismiss' }).click();
  await expect(failed).toHaveCount(0);
  expect(p.state.stopped).toEqual(['a'.repeat(12)]);
  await grid(page).locator('.image-preview.is-making').getByRole('button', { name: 'Stop' }).click();
  await expect(grid(page).locator('.image-preview.is-making')).toHaveCount(0);
  expect(p.state.stopped).toEqual(['a'.repeat(12), 'b'.repeat(12)]);
});

test('jobs that were done when the page was opened are not shown again: their pictures are in the gallery', async ({ page }) => {
  const made = pic({ prompt: 'Made before' });
  await portal(page, { pictures: [made], jobs: [{ id: 'd'.repeat(12), kind: 'generate', state: 'done', prompt: 'Made before', startedAt: Date.now() - 9000, finishedAt: Date.now() - 8000, pictureId: made.id }] });
  await page.goto('/x/pithagoras-media/media');
  await expect(grid(page).getByRole('listitem')).toHaveCount(1);
});

test('a picture opens in the viewer over the page, which steps through the gallery', async ({ page }) => {
  const a = pic({ prompt: 'First', age: 3 });
  const b = pic({ prompt: 'Second', age: 2 });
  const c = pic({ prompt: 'Third', age: 1 });
  await portal(page, { pictures: [a, b, c] });
  await page.goto('/x/pithagoras-media/media');
  await tile(page, 'Second').click();
  await expect(viewer(page)).toBeVisible();
  await expect(viewer(page).locator('img[data-picture]')).toHaveAttribute('src', `/api/x/pithagoras-media/images/${b.id}/file`);
  await expect(viewer(page)).toContainText('Second');
  await expect(viewer(page).getByText('2 / 3', { exact: true })).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await expect(viewer(page).locator('img[data-picture]')).toHaveAttribute('src', `/api/x/pithagoras-media/images/${a.id}/file`);
  await page.keyboard.press('Escape');
  await expect(viewer(page)).toHaveCount(0);
  // Back to the picture that was looked at last.
  await expect(tile(page, 'First')).toBeFocused();
});

test('the original and its edit reach each other, also when the original is further down than the page has loaded', async ({ page }) => {
  const original = pic({ prompt: 'The original', age: 500 });
  const filler = Array.from({ length: 60 }, (_, i) => pic({ prompt: `Filler ${i}`, age: 10 + i }));
  const edit = pic({ prompt: 'Make it blue', kind: 'edited', from: original.id, age: 1 });
  const p = await portal(page, { pictures: [original, ...filler, edit] });
  await page.goto('/x/pithagoras-media/media');
  await tile(page, 'Make it blue').click();
  await expect(viewer(page).getByRole('button', { name: 'Show the original' })).toBeVisible();
  expect(p.state.listed.some((q) => q.includes(`ids=${original.id}`))).toBe(true);
  await viewer(page).getByRole('button', { name: 'Show the original' }).click();
  await expect(viewer(page)).toContainText('The original');
  await expect(viewer(page).locator('img[data-picture]')).toHaveAttribute('src', `/api/x/pithagoras-media/images/${original.id}/file`);
  await viewer(page).getByRole('button', { name: 'Show the edited version' }).click();
  await expect(viewer(page)).toContainText('Make it blue');
});

test('an original that was reached from its edit and is deleted there is gone from the viewer, and the edit no longer points at it', async ({ page }) => {
  const original = pic({ prompt: 'The original', age: 500 });
  const filler = Array.from({ length: 60 }, (_, i) => pic({ prompt: `Filler ${i}`, age: 10 + i }));
  const edit = pic({ prompt: 'Make it blue', kind: 'edited', from: original.id, age: 1 });
  const p = await portal(page, { pictures: [original, ...filler, edit] });
  await page.goto('/x/pithagoras-media/media');
  await tile(page, 'Make it blue').click();
  await viewer(page).getByRole('button', { name: 'Show the original' }).click();
  await expect(viewer(page)).toContainText('The original');
  await expect(viewer(page).getByText('2 / 49', { exact: true })).toBeVisible();
  await viewer(page).getByRole('button', { name: 'Delete' }).click();
  await page.getByRole('alertdialog', { name: 'Delete this picture?' }).getByRole('button', { name: 'Delete' }).click();
  await expect.poll(() => p.state.deleted).toEqual([[original.id]]);
  // The viewer goes on with the next picture of the gallery, and the deleted one is not in what it steps through.
  await expect(viewer(page).getByText('2 / 48', { exact: true })).toBeVisible();
  await expect(viewer(page).locator('img[data-picture]')).not.toHaveAttribute('src', `/api/x/pithagoras-media/images/${original.id}/file`);
  await viewer(page).getByRole('button', { name: 'Previous picture' }).click();
  await expect(viewer(page)).toContainText('Make it blue');
  await expect(viewer(page).getByRole('button', { name: 'Show the original' })).toHaveCount(0);
});

test('stepping on in the viewer asks for the next page of the gallery', async ({ page }) => {
  const many = Array.from({ length: 60 }, (_, i) => pic({ prompt: `Step ${i + 1}`, age: i }));
  await portal(page, { pictures: many });
  await page.goto('/x/pithagoras-media/media');
  await expect(grid(page).getByRole('listitem')).toHaveCount(48);
  await tile(page, 'Step 44').click();
  // Within a few of the end of what is loaded: the rest is loaded behind it, and the count has it.
  await expect(viewer(page).getByText('44 / 60', { exact: true })).toBeVisible();
  for (let i = 0; i < 10; i++) await page.keyboard.press('ArrowRight');
  await expect(viewer(page).getByText('54 / 60', { exact: true })).toBeVisible();
  await expect(viewer(page)).toContainText('Step 54');
});

test('Details tells what a picture was made with and when, and where a chat’s is from', async ({ page }) => {
  const made = pic({
    prompt: 'A fox\nin the snow',
    params: { model: 'draw-2', size: '1024x768', outputFormat: 'webp', outputCompression: 70, negativePrompt: 'blurry', seed: 42, sampleSteps: 20, extra: { quality: 'high', seed: '42' } },
    origin: 'chat', chat: { id: 'c9', title: 'Winter story' },
    createdAt: Date.parse('2026-09-30T08:15:00Z'), fileName: 'fox.png', bytes: 2_500_000,
  });
  await portal(page, { pictures: [made] });
  await page.goto('/x/pithagoras-media/media');
  await tile(page, 'A fox\nin the snow').click();
  await viewer(page).getByRole('button', { name: 'Details' }).click();
  const details = viewer(page).getByRole('region', { name: 'Details' });
  await expect(details).toContainText('A fox');
  await expect(details).toContainText('draw-2');
  await expect(details).toContainText('1024x768');
  // What it was made with: the settings, and what an older version sent as free fields, as they were.
  for (const [name, value] of [['File format', 'WEBP'], ['Compression', '70'], ['Negative prompt', 'blurry'], ['Seed', '42'], ['Steps', '20']]) {
    await expect(details.locator('dt', { hasText: name }).locator('xpath=following-sibling::dd[1]')).toHaveText(value);
  }
  await expect(details).toContainText('quality=high');
  await expect(details).toContainText('In the chat “Winter story”');
  await expect(details).toContainText('fox.png · 2.4 MB');
  await expect(details.getByRole('link', { name: 'Open the chat' })).toHaveAttribute('href', '/s/c9');
});

test('Edit it puts the picture in the form, and the change is sent with it', async ({ page }) => {
  const made = pic({ prompt: 'A fox' });
  const p = await portal(page, { pictures: [made] });
  await page.goto('/x/pithagoras-media/media');
  await tile(page, 'A fox').click();
  await viewer(page).getByRole('button', { name: 'Edit it' }).click();
  await expect(viewer(page)).toHaveCount(0);
  await expect(maker(page)).toHaveAccessibleName('Change a picture');
  await expect(maker(page).getByRole('img', { name: 'A fox' })).toBeVisible();
  await expect(page.getByPlaceholder('Describe the change: what to add, remove or make different')).toBeFocused();
  await page.keyboard.type('Make the fur white');
  await page.getByRole('button', { name: 'Change the picture' }).click();
  expect(p.state.edited).toEqual([{ prompt: 'Make the fur white', sources: [made.id], count: 1 }]);
  // Made over the original, which is under the wait.
  const waiting = grid(page).locator('.image-preview.is-making');
  await expect(waiting).toContainText('Editing a picture');
  p.finish(p.state.jobs[0].id);
  await expect(tile(page, 'Make the fur white')).toBeVisible();
  // A new picture again, whenever it is wanted: the mode switch is there, and the pictures wait for the way back.
  await toMake(page);
  await expect(maker(page)).toHaveAccessibleName('Make a picture');
  await expect(page.getByPlaceholder('Describe the picture')).toBeVisible();
  await toEdit(page);
  await expect(maker(page).getByRole('img', { name: 'A fox' })).toBeVisible();
});

test('an edit that scaled or compressed its picture says so in a warning, until it is put away or the next thing is asked', async ({ page }) => {
  const made = pic({ prompt: 'A fox' });
  const p = await portal(page, { pictures: [made] });
  await page.goto('/x/pithagoras-media/media');
  await tile(page, 'A fox').click();
  await viewer(page).getByRole('button', { name: 'Edit it' }).click();
  await page.keyboard.type('Make the fur white');
  await page.getByRole('button', { name: 'Change the picture' }).click();
  const note = 'The image was scaled down from 4000x500 pixels (1.2 MB) to 2048x256 pixels (0.3 MB) to fit what an edit takes. The result is not scaled back up.';
  p.finish(p.state.jobs[0].id, {}, [note]);
  const warning = page.getByRole('status').filter({ hasText: 'A picture was changed to fit what an edit takes.' });
  await expect(warning).toBeVisible();
  await expect(warning).toContainText(note);
  await warning.getByRole('button', { name: 'Dismiss' }).click();
  await expect(warning).toHaveCount(0);
  // Again, and then a change that needed nothing: the old warning is gone with the next thing asked, and no new one comes.
  await describe(page).fill('Make it blue');
  await page.getByRole('button', { name: 'Change the picture' }).click();
  p.finish(p.state.jobs[0].id, {}, [note]);
  await expect(warning).toBeVisible();
  await describe(page).fill('Make it red');
  await page.getByRole('button', { name: 'Change the picture' }).click();
  await expect(warning).toHaveCount(0);
  p.finish(p.state.jobs[0].id);
  await expect(tile(page, 'Make it red')).toBeVisible();
  await expect(warning).toHaveCount(0);
});

test('in Edit a tick in the box of a picture takes it into the edit, after the ones there, and again takes it out; a click on the picture itself never does, it opens it', async ({ page }) => {
  const [a, b, c] = [pic({ prompt: 'Alpha', age: 3 }), pic({ prompt: 'Beta', age: 2 }), pic({ prompt: 'Gamma', age: 1 })];
  const p = await portal(page, { pictures: [a, b, c], images: feature({ editMultiple: true }) });
  await page.goto('/x/pithagoras-media/media');
  await toEdit(page);
  // Nothing yet: the form says how pictures get in, and there is nothing to send.
  await expect(maker(page).getByText('No picture yet. Pick pictures from the gallery below, drop or paste them here, or add them from this computer.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Change the picture' })).toBeDisabled();
  await describe(page).fill('Beta, painted like Alpha, on Gamma');
  await expect(page.getByRole('button', { name: 'Change the picture' })).toHaveAttribute('title', 'Choose the picture to change first');
  // The gallery says what the boxes are for now, and that the picture is for looking at.
  await expect(page.getByText('Tick pictures to use them in the edit, in the order you tick them. A click on a picture opens it.')).toBeVisible();
  // A click on the picture opens it and takes nothing in; closing it leaves the edit as it was.
  await tile(page, 'Beta').click();
  await expect(viewer(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(viewer(page)).toHaveCount(0);
  await expect(maker(page).getByText('No picture yet.')).toBeVisible();
  await expect(box(page, 'Beta')).not.toBeChecked();
  await tick(page, 'Beta');
  await tick(page, 'Alpha');
  await expect.poll(() => names(page)).toEqual(['Beta', 'Alpha']);
  // Each tile in the edit is ticked and has its place; one that is not is not.
  await expect(box(page, 'Beta')).toBeChecked();
  await expect(cell(page, 'Beta').locator('.gallery-order')).toHaveText('1');
  await expect(cell(page, 'Alpha').locator('.gallery-order')).toHaveText('2');
  await expect(box(page, 'Gamma')).not.toBeChecked();
  await expect(cell(page, 'Gamma').locator('.gallery-order')).toHaveCount(0);
  await tick(page, 'Gamma');
  await expect.poll(() => names(page)).toEqual(['Beta', 'Alpha', 'Gamma']);
  // Ticked again it is out, and the others close up; ticked once more it comes last.
  await box(page, 'Beta').uncheck();
  await expect.poll(() => names(page)).toEqual(['Alpha', 'Gamma']);
  await expect(cell(page, 'Gamma').locator('.gallery-order')).toHaveText('2');
  await tick(page, 'Beta');
  await expect.poll(() => names(page)).toEqual(['Alpha', 'Gamma', 'Beta']);
  // A click on a picture that is in the edit does not take it out either.
  await tile(page, 'Gamma').click();
  await expect(viewer(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect.poll(() => names(page)).toEqual(['Alpha', 'Gamma', 'Beta']);
  await page.getByRole('button', { name: 'Change the picture' }).click();
  await expect.poll(() => p.state.edited.length).toBe(1);
  expect(p.state.edited[0]).toEqual({ prompt: 'Beta, painted like Alpha, on Gamma', sources: [a.id, c.id, b.id], count: 1 });
});

test('in Edit the viewer takes the picture it shows into the edit or out of it, and stays open to go on to the next', async ({ page }) => {
  const [a, b, c] = [pic({ prompt: 'Alpha', age: 3 }), pic({ prompt: 'Beta', age: 2 }), pic({ prompt: 'Gamma', age: 1 })];
  const p = await portal(page, { pictures: [a, b, c], images: feature({ editMultiple: true }) });
  await page.goto('/x/pithagoras-media/media');
  await toEdit(page);
  // The newest is the first of the gallery, and the viewer steps on to the older.
  await tile(page, 'Gamma').click();
  const use = viewer(page).getByRole('button', { name: 'Use in the edit' });
  // Not "Edit it": that would put this one in the place of what is there. This one is added to it.
  await expect(viewer(page).getByRole('button', { name: 'Edit it' })).toHaveCount(0);
  await expect(use).toHaveAttribute('aria-pressed', 'false');
  await use.click();
  await expect(use).toHaveAttribute('aria-pressed', 'true');
  await viewer(page).getByRole('button', { name: 'Next picture' }).click();
  await expect(viewer(page).locator('img[data-picture]')).toHaveAttribute('src', `/api/x/pithagoras-media/images/${b.id}/file`);
  await expect(use).toHaveAttribute('aria-pressed', 'false');
  await use.click();
  await viewer(page).getByRole('button', { name: 'Next picture' }).click();
  await use.click();
  await use.click();
  await expect(use).toHaveAttribute('aria-pressed', 'false');
  await page.keyboard.press('Escape');
  await expect.poll(() => names(page)).toEqual(['Gamma', 'Beta']);
  await expect(box(page, 'Beta')).toBeChecked();
  await describe(page).fill('Both');
  await page.getByRole('button', { name: 'Change the picture' }).click();
  await expect.poll(() => p.state.edited.length).toBe(1);
  expect(p.state.edited[0].sources).toEqual([c.id, b.id]);
});

test('a click or Enter on a picture opens the viewer in either mode, and the box has its own name, is a tab stop of its own, and is ticked with Space', async ({ page }) => {
  const [a, b] = [pic({ prompt: 'Alpha', age: 2 }), pic({ prompt: 'Beta', age: 1 })];
  await portal(page, { pictures: [a, b], images: feature({ editMultiple: true }) });
  await page.goto('/x/pithagoras-media/media');
  for (const mode of ['Generate', 'Edit']) {
    if (mode === 'Edit') await toEdit(page);
    // Enter on the picture, from the keyboard: the viewer, and nothing ticked.
    await tile(page, 'Alpha').focus();
    await page.keyboard.press('Enter');
    await expect(viewer(page)).toBeVisible();
    await expect(viewer(page).locator('img[data-picture]')).toHaveAttribute('src', `/api/x/pithagoras-media/images/${a.id}/file`);
    await page.keyboard.press('Escape');
    await expect(viewer(page)).toHaveCount(0);
    await expect(tile(page, 'Alpha')).toBeFocused();
    await expect(box(page, 'Alpha')).not.toBeChecked();
    await tile(page, 'Beta').click();
    await expect(viewer(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(box(page, 'Beta')).not.toBeChecked();
  }
  await toMake(page);
  // The box: named for its picture, after the picture in the tab order, and ticked with Space; Enter on the picture does not.
  await expect(cell(page, 'Alpha').getByRole('checkbox', { name: 'Select Alpha' })).toBeAttached();
  await tile(page, 'Alpha').focus();
  await page.keyboard.press('Tab');
  await expect(cell(page, 'Alpha').getByRole('checkbox', { name: 'Select Alpha' })).toBeFocused();
  await page.keyboard.press('Space');
  await expect(box(page, 'Alpha')).toBeChecked();
  await expect(page.getByRole('group', { name: 'Selected pictures' }).getByText('1 selected')).toBeVisible();
  await toEdit(page);
  await expect(cell(page, 'Alpha').getByRole('checkbox', { name: 'Use Alpha in the edit' })).toBeAttached();
});

test('where a pointer can hover the box is there while the picture is pointed at or has focus, and always once one is ticked or the form is in Edit', async ({ page }) => {
  const [a, b] = [pic({ prompt: 'Alpha', age: 2 }), pic({ prompt: 'Beta', age: 1 })];
  await portal(page, { pictures: [a, b] });
  await page.goto('/x/pithagoras-media/media');
  const shown = (name: string) => cell(page, name).locator('.gallery-check-hit').evaluate((el) => ({ opacity: Number(getComputedStyle(el).opacity), ...el.getBoundingClientRect().toJSON() }));
  // A mouse: hidden until the tile is pointed at or the box has focus, so that it does not cover every picture.
  await page.mouse.move(0, 0);
  await expect.poll(async () => (await shown('Alpha')).opacity).toBe(0);
  await cell(page, 'Alpha').hover();
  await expect.poll(async () => (await shown('Alpha')).opacity).toBe(1);
  await expect.poll(async () => (await shown('Beta')).opacity).toBe(0);
  await page.mouse.move(0, 0);
  await box(page, 'Beta').focus();
  await expect.poll(async () => (await shown('Beta')).opacity).toBe(1);
  // Once one is ticked every box shows, to tick the next with.
  await box(page, 'Alpha').check();
  await page.mouse.move(0, 0);
  await expect.poll(async () => (await shown('Beta')).opacity).toBe(1);
  await box(page, 'Alpha').uncheck();
  await page.mouse.move(0, 0);
  await expect.poll(async () => (await shown('Beta')).opacity).toBe(0);
  // In Edit the boxes are what the form is made of: all there.
  await toEdit(page);
  await expect.poll(async () => (await shown('Beta')).opacity).toBe(1);
});

test.describe('on a touch screen', () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 800 } });
  test('the boxes are always there, with a place a thumb can find, and a tap on one ticks it where a tap on the picture opens it', async ({ page }) => {
    const [a, b] = [pic({ prompt: 'Alpha', age: 2 }), pic({ prompt: 'Beta', age: 1 })];
    await portal(page, { pictures: [a, b] });
    await page.goto('/x/pithagoras-media/media');
    const hit = cell(page, 'Beta').locator('.gallery-check-hit');
    // No hover to wait for, and at least the 44 pixels a finger needs.
    await expect.poll(() => hit.evaluate((el) => Number(getComputedStyle(el).opacity))).toBe(1);
    // Measured once the page is in: it comes in with the portal's entrance for a page, which moves it by a fraction of a pixel meanwhile.
    await page.locator('.extension-page').evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
    const size = (await hit.boundingBox())!;
    expect(size.width).toBeGreaterThanOrEqual(44);
    expect(size.height).toBeGreaterThanOrEqual(44);
    await hit.tap();
    await expect(box(page, 'Beta')).toBeChecked();
    await expect(page.getByRole('group', { name: 'Selected pictures' }).getByText('1 selected')).toBeVisible();
    await expect(viewer(page)).toHaveCount(0);
    await tile(page, 'Alpha').tap();
    await expect(viewer(page)).toBeVisible();
    await expect(box(page, 'Alpha')).not.toBeChecked();
    // Nothing runs off the screen with the bar there.
    await page.keyboard.press('Escape');
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  });
});

test('where the endpoint takes one picture, a tick takes the place of the one there is, with no place numbers, and the viewer has one button for it', async ({ page }) => {
  const [a, b] = [pic({ prompt: 'Alpha', age: 2 }), pic({ prompt: 'Beta', age: 1 })];
  const p = await portal(page, { pictures: [a, b] });
  await page.goto('/x/pithagoras-media/media');
  await toEdit(page);
  await expect(maker(page).getByText('No picture yet. Pick one from the gallery below, drop or paste it here, or add it from this computer.')).toBeVisible();
  await expect(page.getByText('Tick a picture to use it in the edit. A click on a picture opens it.')).toBeVisible();
  await tick(page, 'Alpha');
  await expect.poll(() => names(page)).toEqual(['Alpha']);
  await tick(page, 'Beta');
  await expect.poll(() => names(page)).toEqual(['Beta']);
  await expect(box(page, 'Alpha')).not.toBeChecked();
  await expect(grid(page).locator('.gallery-order')).toHaveCount(0);
  // The way to several is said, with the way to the setting.
  await expect(maker(page).getByRole('link', { name: 'Set it up under Media in Settings' })).toHaveAttribute('href', '/settings/x/pithagoras-media');
  await describe(page).fill('Make it night');
  await page.getByRole('button', { name: 'Change the picture' }).click();
  await expect.poll(() => p.state.edited.length).toBe(1);
  expect(p.state.edited[0].sources).toEqual([b.id]);
  // Out again, and the viewer: the same choice in it, which puts the picture there in the place of the one there is.
  await box(page, 'Beta').uncheck();
  await expect(maker(page).getByText('No picture yet.')).toBeVisible();
  await tile(page, 'Beta').click();
  await viewer(page).getByRole('button', { name: 'Use in the edit' }).click();
  await expect.poll(() => names(page)).toEqual(['Beta']);
  await viewer(page).getByRole('button', { name: 'Next picture' }).click();
  await viewer(page).getByRole('button', { name: 'Use in the edit' }).click();
  await expect.poll(() => names(page)).toEqual(['Alpha']);
  await expect(viewer(page).getByRole('button', { name: /reference/ })).toHaveCount(0);
});

test('several pictures are picked at once, shown in the order picked with their place and the limit, and sent in that order', async ({ page }) => {
  const p = await portal(page, { images: feature({ editMultiple: true }) });
  await page.goto('/x/pithagoras-media/media');
  await toEdit(page);
  await page.getByLabel('Upload a picture').setInputFiles([png('a.png'), png('b.png'), png('c.png')]);
  await expect(maker(page)).toHaveAccessibleName('Change a picture');
  await expect.poll(() => names(page)).toEqual(['a.png', 'b.png', 'c.png']);
  expect(p.state.uploads.map((u) => u.name)).toEqual(['a.png', 'b.png', 'c.png']);
  // Their places, which the description refers to, and how many more there is room for.
  await expect(strip(page).getByRole('listitem').filter({ hasText: /^[123]$/ })).toHaveCount(3);
  await expect(maker(page).getByText('3 of 8 pictures')).toBeVisible();
  await expect(maker(page).getByText('The 3 pictures to work from, in the order the description can refer to them')).toBeVisible();
  await describe(page).fill('The first, painted like the second, on the third');
  await page.getByRole('button', { name: 'Change the picture' }).click();
  await expect.poll(() => p.state.edited.length).toBe(1);
  expect(p.state.edited[0]).toEqual({ prompt: 'The first, painted like the second, on the third', sources: p.pics.slice(0, 3).map((x) => x.id), count: 1 });
});

test('more pictures are added one after another, also from the add button in the row of them', async ({ page }) => {
  const made = pic({ prompt: 'A fox' });
  const p = await portal(page, { pictures: [made], images: feature({ editMultiple: true }) });
  await page.goto('/x/pithagoras-media/media');
  await tile(page, 'A fox').click();
  await viewer(page).getByRole('button', { name: 'Edit it' }).click();
  await expect.poll(() => names(page)).toEqual(['A fox']);
  // The button is in the row, after the last of them, and takes more than one.
  const add = strip(page).getByRole('button', { name: 'Add pictures from this computer' });
  const chooser = page.waitForEvent('filechooser');
  await add.click();
  expect((await chooser).isMultiple()).toBe(true);
  await page.getByLabel('Upload a picture').setInputFiles(png('b.png'));
  await expect.poll(() => names(page)).toEqual(['A fox', 'b.png']);
  await page.getByLabel('Upload a picture').setInputFiles([png('c.png'), png('d.png')]);
  await expect.poll(() => names(page)).toEqual(['A fox', 'b.png', 'c.png', 'd.png']);
  await describe(page).fill('Mix');
  await page.getByRole('button', { name: 'Change the picture' }).click();
  await expect.poll(() => p.state.edited.length).toBe(1);
  expect(p.state.edited[0].sources).toEqual([made.id, ...p.pics.filter((x) => x.kind === 'uploaded').map((x) => x.id)]);
});

test('the add button is reachable and works from the keyboard', async ({ page }) => {
  await portal(page, { pictures: [pic({ prompt: 'A fox' })], images: feature({ editMultiple: true }) });
  await page.goto('/x/pithagoras-media/media');
  await tile(page, 'A fox').click();
  await viewer(page).getByRole('button', { name: 'Edit it' }).click();
  const add = strip(page).getByRole('button', { name: 'Add pictures from this computer' });
  await add.focus();
  const chooser = page.waitForEvent('filechooser');
  await page.keyboard.press('Enter');
  await chooser;
  // The mouse is not needed for anything else in the row either: each button is a stop of Tab.
  await page.getByLabel('Upload a picture').setInputFiles(png('b.png'));
  await expect.poll(() => names(page)).toEqual(['A fox', 'b.png']);
  const remove = strip(page).getByRole('button', { name: 'Remove b.png' });
  await remove.focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => names(page)).toEqual(['A fox']);
});

test('moving or removing a picture from the keyboard leaves focus in the row, so that the next press goes on from there', async ({ page }) => {
  const [a, b, c] = [pic({ prompt: 'Alpha', age: 3 }), pic({ prompt: 'Beta', age: 2 }), pic({ prompt: 'Gamma', age: 1 })];
  await portal(page, { pictures: [a, b, c], images: feature({ editMultiple: true }) });
  await page.goto('/x/pithagoras-media/media');
  await pick(page, 'Alpha', 'Beta', 'Gamma');
  await expect.poll(() => names(page)).toEqual(['Alpha', 'Beta', 'Gamma']);
  // Later, again and again: the same button has focus after each, and the picture goes on to the end.
  await strip(page).getByRole('button', { name: 'Move Alpha later' }).focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => names(page)).toEqual(['Beta', 'Alpha', 'Gamma']);
  await expect(strip(page).getByRole('button', { name: 'Move Alpha later' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect.poll(() => names(page)).toEqual(['Beta', 'Gamma', 'Alpha']);
  // At the end that button is off: focus goes to the one that is left, which moves it back.
  await expect(strip(page).getByRole('button', { name: 'Move Alpha earlier' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect.poll(() => names(page)).toEqual(['Beta', 'Alpha', 'Gamma']);
  // Taken out, focus goes to the picture that took its place, and not to the top of the page.
  await strip(page).getByRole('button', { name: 'Remove Alpha' }).focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => names(page)).toEqual(['Beta', 'Gamma']);
  await expect(strip(page).getByRole('button', { name: 'Look at Gamma' })).toBeFocused();
  // The last of them: the one before it.
  await strip(page).getByRole('button', { name: 'Remove Gamma' }).focus();
  await page.keyboard.press('Enter');
  await expect(strip(page).getByRole('button', { name: 'Look at Beta' })).toBeFocused();
  // The only one left: out of the row, to the description, where the next thing is typed.
  await strip(page).getByRole('button', { name: 'Remove Beta' }).focus();
  await page.keyboard.press('Enter');
  await expect(maker(page)).toHaveAccessibleName('Change a picture');
  await expect(maker(page).getByText('No picture yet.')).toBeVisible();
  await expect(describe(page)).toBeFocused();
});

test('taking out the only picture from the keyboard, where only changing is set up, leaves focus in the description', async ({ page }) => {
  await portal(page, { images: feature({ enabled: false, baseUrl: '', editBaseUrl: 'https://edits.example.com/v1' }) });
  await page.goto('/x/pithagoras-media/media');
  await page.getByLabel('Upload a picture').setInputFiles([png('only.png')]);
  await expect.poll(() => names(page)).toEqual(['only.png']);
  await strip(page).getByRole('button', { name: 'Remove only.png' }).focus();
  await page.keyboard.press('Enter');
  // Focus is not lost to the top of the page, and the form stays in Edit, empty, for the next picture.
  await expect(maker(page)).toHaveAccessibleName('Change a picture');
  await expect(describe(page)).toBeFocused();
});

test('pictures dropped on the form are added after the ones there, and a drop shows where it will go', async ({ page }) => {
  const p = await portal(page, { images: feature({ editMultiple: true }) });
  await page.goto('/x/pithagoras-media/media');
  // From nothing: a drop starts an edit, as choosing a picture from this computer does.
  await drop(maker(page), ['one.png', 'two.png']);
  await expect(maker(page)).toHaveAccessibleName('Change a picture');
  await expect.poll(() => names(page)).toEqual(['one.png', 'two.png']);
  await drop(maker(page), ['three.png']);
  await expect.poll(() => names(page)).toEqual(['one.png', 'two.png', 'three.png']);
  expect(p.state.uploads.map((u) => u.name)).toEqual(['one.png', 'two.png', 'three.png']);
  // While files are over the form it says what a drop does, and not after.
  await maker(page).evaluate((el) => {
    const data = new DataTransfer();
    data.items.add(new File(['x'], 'x.png', { type: 'image/png' }));
    el.dispatchEvent(new DragEvent('dragover', { dataTransfer: data, bubbles: true, cancelable: true }));
  });
  await expect(maker(page).getByText('Drop pictures here to change them, or to use them as references')).toBeVisible();
  await maker(page).evaluate((el) => el.dispatchEvent(new DragEvent('dragleave', { bubbles: true, cancelable: true, relatedTarget: document.body })));
  await expect(maker(page).getByText('Drop pictures here to change them, or to use them as references')).toHaveCount(0);
});

test('a picture pasted in the description is added, and text that came with it is the text', async ({ page }) => {
  const p = await portal(page, { images: feature({ editMultiple: true }) });
  await page.goto('/x/pithagoras-media/media');
  await paste(page.getByPlaceholder('Describe the picture'), ['image.png']);
  await expect(maker(page)).toHaveAccessibleName('Change a picture');
  await expect.poll(() => names(page)).toEqual(['image.png']);
  await paste(describe(page), ['shot.png', 'shot2.png']);
  await expect.poll(() => names(page)).toEqual(['image.png', 'shot.png', 'shot2.png']);
  // Cells copied from a spreadsheet come with a picture of themselves: the words are what was meant.
  await paste(describe(page), ['cells.png'], 'a\tb');
  await page.waitForTimeout(150);
  expect(p.state.uploads.map((u) => u.name)).toEqual(['image.png', 'shot.png', 'shot2.png']);
});

test('the eight pictures kept for an edit lock no box of Generate: there the boxes are for a download, a delete and a change', async ({ page }) => {
  const many = Array.from({ length: 10 }, (_, i) => pic({ prompt: `Pic ${i + 1}`, age: i }));
  await portal(page, { pictures: many, images: feature({ editMultiple: true }) });
  await page.goto('/x/pithagoras-media/media');
  await pick(page, ...Array.from({ length: 8 }, (_, i) => `Pic ${i + 1}`));
  await expect(box(page, 'Pic 9')).toBeDisabled();
  // Back to making a new picture: the eight stay for the way back, and nothing is locked.
  await toMake(page);
  await expect(box(page, 'Pic 9')).toBeEnabled();
  await expect(cell(page, 'Pic 9').locator('.gallery-tile')).not.toHaveClass(/is-locked/);
  await expect(cell(page, 'Pic 9').locator('.gallery-check-hit')).not.toHaveAttribute('title', /.+/);
  await box(page, 'Pic 9').check();
  await box(page, 'Pic 10').check();
  await expect(bar(page).getByText('2 selected')).toBeVisible();
  // Select all shown takes every one, and each can be taken out of it again on its own.
  await bar(page).getByRole('button', { name: 'Select all shown' }).click();
  await expect(bar(page).getByText('10 selected')).toBeVisible();
  await box(page, 'Pic 9').uncheck();
  await expect(bar(page).getByText('9 selected')).toBeVisible();
  // The way back to the edit has its eight, and its locks.
  await bar(page).getByRole('button', { name: 'Clear selection' }).click();
  await toEdit(page);
  await expect.poll(() => names(page)).toHaveLength(8);
  await expect(box(page, 'Pic 9')).toBeDisabled();
});

test('a picture of the gallery dragged into the form is that picture, added once: nothing is uploaded and the gallery stays as it is', async ({ page }) => {
  const [a, b] = [pic({ prompt: 'A fox', age: 2 }), pic({ prompt: 'A hat', age: 1 })];
  const p = await portal(page, { pictures: [a, b], images: feature({ editMultiple: true }) });
  await page.goto('/x/pithagoras-media/media');
  const tiles = page.locator('.gallery-tile');
  await expect(tiles).toHaveCount(2);
  // The picture itself, not the thumbnail of the same one in the form's row.
  const picture = (name: string) => tiles.filter({ has: page.getByRole('img', { name, exact: true }) }).locator('.image-preview-img');
  // Dragged as a person does, with the mouse, from the gallery to the form: in Generate, which a drop switches to Edit.
  await picture('A fox').dragTo(page.getByPlaceholder('Describe the picture'));
  await expect(maker(page)).toHaveAccessibleName('Change a picture');
  await expect.poll(() => names(page)).toEqual(['A fox']);
  await expect(box(page, 'A fox')).toBeChecked();
  // The same one again is not added twice, and another comes after it.
  await picture('A fox').dragTo(describe(page));
  await picture('A hat').dragTo(describe(page));
  await expect.poll(() => names(page)).toEqual(['A fox', 'A hat']);
  await picture('A fox').dragTo(describe(page));
  await page.waitForTimeout(150);
  expect(await names(page)).toEqual(['A fox', 'A hat']);
  // No copy of it was made: nothing was sent to the portal, and the gallery has the two it had.
  expect(p.state.uploads).toEqual([]);
  expect(p.pics).toHaveLength(2);
  await expect(tiles).toHaveCount(2);
  await expect(page.getByRole('region', { name: 'Gallery' }).getByText('Uploaded')).toHaveCount(0);

  // What the browser hands over for it: a file made from the picture, with its address. It is the picture, not a file of the person's.
  await toMake(page);
  await dropOwn(maker(page), `/api/x/pithagoras-media/images/${b.id}/file`);
  await page.waitForTimeout(150);
  expect(await names(page)).toEqual(['A fox', 'A hat']);
  await dropOwn(describe(page), `/api/x/pithagoras-media/images/${a.id}/file`, ['file.png', 'file2.png']);
  await page.waitForTimeout(150);
  expect(await names(page)).toEqual(['A fox', 'A hat']);
  expect(p.state.uploads).toEqual([]);
  expect(p.pics).toHaveLength(2);
  await expect(tiles).toHaveCount(2);
  // The edit is made from the pictures themselves.
  await describe(page).fill('The fox in the hat');
  await page.getByRole('button', { name: 'Change the picture' }).click();
  await expect.poll(() => p.state.edited.length).toBe(1);
  expect(p.state.edited[0].sources).toEqual([a.id, b.id]);

  // A file of the person's own is still put in the gallery, and so is a picture of another site that has the same path.
  await drop(maker(page), ['mine.png']);
  await expect.poll(() => p.state.uploads.map((u) => u.name)).toEqual(['mine.png']);
  await dropOwn(maker(page), `https://elsewhere.example/api/x/pithagoras-media/images/${a.id}/file`, ['theirs.png']);
  await expect.poll(() => p.state.uploads.map((u) => u.name)).toEqual(['mine.png', 'theirs.png']);
});

test('a picture of the gallery dragged in where the endpoint takes one takes the place of the one there is', async ({ page }) => {
  const [a, b] = [pic({ prompt: 'A fox', age: 2 }), pic({ prompt: 'A hat', age: 1 })];
  const p = await portal(page, { pictures: [a, b] });
  await page.goto('/x/pithagoras-media/media');
  await page.locator('.gallery-tile .image-preview-img[alt="A fox"]').dragTo(page.getByPlaceholder('Describe the picture'));
  await expect.poll(() => names(page)).toEqual(['A fox']);
  await page.locator('.gallery-tile .image-preview-img[alt="A hat"]').dragTo(describe(page));
  await expect.poll(() => names(page)).toEqual(['A hat']);
  expect(p.state.uploads).toEqual([]);
  expect(p.pics).toHaveLength(2);
});

test('a picture of the gallery dragged into a row that has room for one takes it, one that is there already is no loss, and one that does not fit is said to be left out', async ({ page }) => {
  const many = Array.from({ length: 9 }, (_, i) => pic({ prompt: `Picture ${i + 1}`, age: i + 1 }));
  const p = await portal(page, { pictures: many, images: feature({ editMultiple: true }) });
  await page.goto('/x/pithagoras-media/media');
  await toEdit(page);
  for (const m of many.slice(0, 7)) await tick(page, m.prompt);
  await expect(strip(page).getByRole('img')).toHaveCount(7);
  const notice = maker(page).getByRole('status').filter({ hasText: 'left out' });
  await dropOwn(maker(page), `/api/x/pithagoras-media/images/${many[8].id}/file`);
  await expect.poll(() => names(page).then((n) => n.length)).toBe(8);
  expect(await names(page)).toContain('Picture 9');
  await expect(notice).toHaveCount(0);
  // The row is full now: one that is in it is nothing that was lost, one that is not is said to be left out.
  await dropOwn(maker(page), `/api/x/pithagoras-media/images/${many[0].id}/file`);
  await page.waitForTimeout(150);
  await expect(notice).toHaveCount(0);
  await dropOwn(maker(page), `/api/x/pithagoras-media/images/${many[7].id}/file`);
  await expect(maker(page).getByRole('status').filter({ hasText: 'One picture was left out: an edit takes at most 8.' })).toBeVisible();
  expect(await names(page)).toHaveLength(8);
  expect(p.state.uploads, 'nothing was put in the gallery').toEqual([]);
  expect(p.pics).toHaveLength(9);
});

test('a picture of the gallery copied and pasted is that picture; the viewer\'s button for the edit adds it once, and neither makes a copy', async ({ page }) => {
  const [a, b, c] = [pic({ prompt: 'Alpha', age: 3 }), pic({ prompt: 'Beta', age: 2 }), pic({ prompt: 'Gamma', age: 1 })];
  const p = await portal(page, { pictures: [a, b, c], images: feature({ editMultiple: true }) });
  await page.goto('/x/pithagoras-media/media');
  const tiles = page.locator('.gallery-tile');
  // "Copy image": the picture, and the page it was an `<img>` of, which names it.
  await page.getByPlaceholder('Describe the picture').evaluate((el, id) => {
    const data = new DataTransfer();
    data.items.add(new File(['bytes'], 'image.png', { type: 'image/png' }));
    data.setData('text/html', `<meta charset='utf-8'><img src="${location.origin}/api/x/pithagoras-media/images/${id}/file">`);
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, a.id);
  await expect.poll(() => names(page)).toEqual(['Alpha']);
  // The same again is not added twice; a screenshot, which has no address of the gallery, is a file like any other.
  await page.getByPlaceholder('Describe the change: what to add, remove or make different').evaluate((el, id) => {
    const data = new DataTransfer();
    data.items.add(new File(['bytes'], 'image.png', { type: 'image/png' }));
    data.setData('text/html', `<img src="${location.origin}/api/x/pithagoras-media/images/${id}/file">`);
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, a.id);
  await page.waitForTimeout(150);
  expect(await names(page)).toEqual(['Alpha']);
  expect(p.state.uploads).toEqual([]);
  await paste(describe(page), ['shot.png']);
  await expect.poll(() => p.state.uploads.map((u) => u.name)).toEqual(['shot.png']);
  await expect.poll(() => names(page)).toEqual(['Alpha', 'shot.png']);
  const afterUpload = p.pics.length;

  // The viewer: "Use in the edit" takes the picture it shows in, once, and out again; it never puts one in the gallery.
  await tile(page, 'Beta').click();
  const use = viewer(page).getByRole('button', { name: 'Use in the edit' });
  await use.click();
  await expect(use).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => names(page)).toEqual(['Alpha', 'shot.png', 'Beta']);
  await page.keyboard.press('Escape');
  expect(p.state.uploads.map((u) => u.name)).toEqual(['shot.png']);
  expect(p.pics).toHaveLength(afterUpload);
  await expect(tiles).toHaveCount(afterUpload);
});

test('a picture is taken out with its button, and moved earlier or later, and the places and the request follow', async ({ page }) => {
  const [a, b, c] = [pic({ prompt: 'Alpha', age: 3 }), pic({ prompt: 'Beta', age: 2 }), pic({ prompt: 'Gamma', age: 1 })];
  const p = await portal(page, { pictures: [a, b, c], images: feature({ editMultiple: true }) });
  await page.goto('/x/pithagoras-media/media');
  await pick(page, 'Alpha', 'Beta', 'Gamma');
  await expect.poll(() => names(page)).toEqual(['Alpha', 'Beta', 'Gamma']);
  // The first cannot go earlier, the last not later.
  await expect(strip(page).getByRole('button', { name: 'Move Alpha earlier' })).toBeDisabled();
  await expect(strip(page).getByRole('button', { name: 'Move Gamma later' })).toBeDisabled();
  await strip(page).getByRole('button', { name: 'Move Gamma earlier' }).click();
  await expect.poll(() => names(page)).toEqual(['Alpha', 'Gamma', 'Beta']);
  await strip(page).getByRole('button', { name: 'Move Alpha later' }).click();
  await expect.poll(() => names(page)).toEqual(['Gamma', 'Alpha', 'Beta']);
  // The number on each is its place now.
  await expect(strip(page).getByRole('listitem').filter({ has: page.getByRole('img', { name: 'Gamma' }) })).toContainText('1');
  await strip(page).getByRole('button', { name: 'Remove Alpha' }).click();
  await expect.poll(() => names(page)).toEqual(['Gamma', 'Beta']);
  await describe(page).fill('Gamma on Beta');
  await page.getByRole('button', { name: 'Change the picture' }).click();
  await expect.poll(() => p.state.edited.length).toBe(1);
  expect(p.state.edited[0].sources).toEqual([c.id, b.id]);
});

/** A thumbnail of the row, whole: the box that is dragged and dropped on. */
const slot = (page: Page, name: string) => strip(page).getByRole('listitem').filter({ has: page.getByRole('img', { name, exact: true }) });
const FIRST_COUNTS = 'The first picture counts most: it is the one that is changed or carried over, and the others are extra references.';

test('a picture of the row is dragged to another place, and the request has them in that order: the first is the one that counts most', async ({ page }) => {
  const [a, b, c, d] = [pic({ prompt: 'Alpha', age: 4 }), pic({ prompt: 'Beta', age: 3 }), pic({ prompt: 'Gamma', age: 2 }), pic({ prompt: 'Delta', age: 1 })];
  const p = await portal(page, { pictures: [a, b, c, d], images: feature({ editMultiple: true }) });
  await page.goto('/x/pithagoras-media/media');
  await pick(page, 'Alpha', 'Beta', 'Gamma', 'Delta');
  await expect.poll(() => names(page)).toEqual(['Alpha', 'Beta', 'Gamma', 'Delta']);
  await expect(slot(page, 'Delta')).toHaveAttribute('draggable', 'true');
  // The last onto the first: it takes the first place, and the others follow in their order.
  await slot(page, 'Delta').dragTo(slot(page, 'Alpha'));
  await expect.poll(() => names(page)).toEqual(['Delta', 'Alpha', 'Beta', 'Gamma']);
  await expect(strip(page).getByRole('listitem').first()).toContainText('1');
  // The move is said for a screen reader, and the row says nothing of a file being dropped.
  await expect(maker(page).locator('[aria-live="polite"]')).toHaveText('Delta is picture 1 of 4 now');
  await expect(maker(page).getByText('Drop pictures here')).toHaveCount(0);
  // The first onto the third, and one that is dropped on itself stays where it is.
  await slot(page, 'Delta').dragTo(slot(page, 'Beta'));
  await expect.poll(() => names(page)).toEqual(['Alpha', 'Beta', 'Delta', 'Gamma']);
  // (Dropped on itself by the events of a browser: a mouse that does not move is a click, which would open the picture.)
  await slot(page, 'Beta').evaluate((el) => {
    const data = new DataTransfer();
    for (const type of ['dragstart', 'dragover', 'drop', 'dragend']) el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: data }));
  });
  await expect.poll(() => names(page)).toEqual(['Alpha', 'Beta', 'Delta', 'Gamma']);
  await describe(page).fill('Alpha with the others');
  await page.getByRole('button', { name: 'Change the picture' }).click();
  await expect.poll(() => p.state.edited.length).toBe(1);
  expect(p.state.edited[0].sources).toEqual([a.id, b.id, d.id, c.id]);
  // The same order is what the next edit starts from, and the arrows go on from it.
  await strip(page).getByRole('button', { name: 'Move Gamma earlier' }).click();
  await expect.poll(() => names(page)).toEqual(['Alpha', 'Beta', 'Gamma', 'Delta']);
});

test('a single picture is not dragged, and a row of several says that the first counts most', async ({ page }) => {
  const [a, b] = [pic({ prompt: 'Alpha', age: 2 }), pic({ prompt: 'Beta', age: 1 })];
  await portal(page, { pictures: [a, b], images: feature({ editMultiple: true }) });
  await page.goto('/x/pithagoras-media/media');
  await pick(page, 'Alpha');
  await expect(slot(page, 'Alpha')).not.toHaveAttribute('draggable', 'true');
  await expect(maker(page)).not.toContainText(FIRST_COUNTS);
  await tick(page, 'Beta');
  await expect.poll(() => names(page)).toEqual(['Alpha', 'Beta']);
  await expect(slot(page, 'Beta')).toHaveAttribute('draggable', 'true');
  await expect(maker(page)).toContainText(FIRST_COUNTS);
  await expect(maker(page)).toContainText('Drag a picture to another place, or use the arrows under it, to change the order; the endpoint gets them in this order.');
});

test('the order is changed from the keyboard alone, with the arrows, and said as it changes; the request has that order', async ({ page }) => {
  const [a, b, c] = [pic({ prompt: 'Alpha', age: 3 }), pic({ prompt: 'Beta', age: 2 }), pic({ prompt: 'Gamma', age: 1 })];
  const p = await portal(page, { pictures: [a, b, c], images: feature({ editMultiple: true }) });
  await page.goto('/x/pithagoras-media/media');
  await pick(page, 'Alpha', 'Beta', 'Gamma');
  const said = maker(page).locator('[aria-live="polite"]');
  // Tab reaches the arrows in the row, one picture after the other.
  await strip(page).getByRole('button', { name: 'Look at Alpha' }).focus();
  await page.keyboard.press('Tab');
  await expect(strip(page).getByRole('button', { name: 'Remove Alpha' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(strip(page).getByRole('button', { name: 'Move Alpha earlier' })).toBeDisabled();
  await expect(strip(page).getByRole('button', { name: 'Move Alpha later' })).toBeFocused();
  await page.keyboard.press('Space');
  await expect.poll(() => names(page)).toEqual(['Beta', 'Alpha', 'Gamma']);
  await expect(said).toHaveText('Alpha is picture 2 of 3 now');
  await strip(page).getByRole('button', { name: 'Move Gamma earlier' }).focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await expect.poll(() => names(page)).toEqual(['Gamma', 'Beta', 'Alpha']);
  await expect(said).toHaveText('Gamma is picture 1 of 3 now');
  await describe(page).fill('Gamma first');
  await page.keyboard.press('Control+Enter');
  await expect.poll(() => p.state.edited.length).toBe(1);
  expect(p.state.edited[0].sources).toEqual([c.id, b.id, a.id]);
});

test('at most eight pictures go into an edit: the rest of a pick is not uploaded, and it is said', async ({ page }) => {
  const p = await portal(page, { images: feature({ editMultiple: true }) });
  await page.goto('/x/pithagoras-media/media');
  await toEdit(page);
  await page.getByLabel('Upload a picture').setInputFiles(Array.from({ length: 6 }, (_, i) => png(`p${i + 1}.png`)));
  await expect.poll(() => names(page)).toHaveLength(6);
  await page.getByLabel('Upload a picture').setInputFiles(Array.from({ length: 4 }, (_, i) => png(`q${i + 1}.png`)));
  await expect.poll(() => names(page)).toEqual(['p1.png', 'p2.png', 'p3.png', 'p4.png', 'p5.png', 'p6.png', 'q1.png', 'q2.png']);
  await expect(maker(page).getByRole('status').filter({ hasText: '2 pictures were left out: an edit takes at most 8.' })).toBeVisible();
  // The two that did not fit were never put in the gallery.
  expect(p.state.uploads.map((u) => u.name)).toEqual(['p1.png', 'p2.png', 'p3.png', 'p4.png', 'p5.png', 'p6.png', 'q1.png', 'q2.png']);
  await expect(maker(page).getByText('8 of 8 pictures')).toBeVisible();
  // Full: there is no add button until one is taken out.
  await expect(strip(page).getByRole('button', { name: 'Add pictures from this computer' })).toHaveCount(0);
  await strip(page).getByRole('button', { name: 'Remove q2.png' }).click();
  await expect(strip(page).getByRole('button', { name: 'Add pictures from this computer' })).toBeVisible();
});

test('pictures that were uploaded while the row filled up from the gallery are said to be left out, not dropped without a word', async ({ page }) => {
  const extra = pic({ prompt: 'Zeta' });
  const p = await portal(page, { pictures: [extra], images: feature({ editMultiple: true }) });
  await page.goto('/x/pithagoras-media/media');
  await toEdit(page);
  await page.getByLabel('Upload a picture').setInputFiles(Array.from({ length: 6 }, (_, i) => png(`p${i + 1}.png`)));
  await expect.poll(() => names(page)).toHaveLength(6);
  // Two more are on their way up, slowly, and there is room for both when they set out.
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  await page.route('**/api/x/pithagoras-media/images/upload*', async (route) => {
    await gate;
    await route.fallback();
  });
  await drop(maker(page), ['q1.png', 'q2.png']);
  await expect(maker(page).getByRole('status').filter({ hasText: 'Adding…' })).toBeAttached();
  // Meanwhile a tick in the gallery takes a seventh, so that only one of the two fits.
  await tick(page, 'Zeta');
  await expect.poll(() => names(page)).toHaveLength(7);
  release();
  await expect.poll(() => names(page)).toEqual(['p1.png', 'p2.png', 'p3.png', 'p4.png', 'p5.png', 'p6.png', 'Zeta', 'q1.png']);
  await expect(maker(page).getByRole('status').filter({ hasText: 'One picture was left out: an edit takes at most 8.' })).toBeVisible();
  // It is in the gallery, as every upload is; it is the notice that tells it was not taken.
  expect(p.state.uploads.map((u) => u.name)).toContain('q2.png');
});

test('an edit waits for the pictures that are still being added: neither the button nor Ctrl+Enter sends it without them', async ({ page }) => {
  const alpha = pic({ prompt: 'Alpha' });
  const p = await portal(page, { pictures: [alpha], images: feature({ editMultiple: true }) });
  await page.goto('/x/pithagoras-media/media');
  await pick(page, 'Alpha');
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  await page.route('**/api/x/pithagoras-media/images/upload*', async (route) => {
    await gate;
    await route.fallback();
  });
  await drop(maker(page), ['b.png', 'c.png']);
  await expect(maker(page).getByRole('status').filter({ hasText: 'Adding…' })).toBeAttached();
  await describe(page).fill('Put the person of the first picture into the second, in the style of the third');
  // They are not in the row yet: an edit sent now would be made of Alpha alone, and the row would show three as if they were used.
  const change = page.getByRole('button', { name: 'Change the picture' });
  await expect(change).toBeDisabled();
  await expect(change).toHaveAttribute('title', 'Wait until the pictures are added');
  await describe(page).press('Control+Enter');
  await page.waitForTimeout(200);
  expect(p.state.edited).toEqual([]);
  release();
  await expect.poll(() => names(page)).toEqual(['Alpha', 'b.png', 'c.png']);
  await expect(change).toBeEnabled();
  await expect(change).not.toHaveAttribute('title', /Wait/);
  await describe(page).press('Control+Enter');
  await expect.poll(() => p.state.edited.length).toBe(1);
  const uploaded = p.pics.filter((x) => x.kind === 'uploaded').map((x) => x.id);
  expect(p.state.edited[0].sources).toEqual([alpha.id, ...uploaded]);
});

test('where the endpoint takes one picture, an edit does not go out from the picture that a drop is replacing', async ({ page }) => {
  const alpha = pic({ prompt: 'Alpha' });
  const p = await portal(page, { pictures: [alpha] });
  await page.goto('/x/pithagoras-media/media');
  await pick(page, 'Alpha');
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  await page.route('**/api/x/pithagoras-media/images/upload*', async (route) => {
    await gate;
    await route.fallback();
  });
  await paste(describe(page), ['b.png']);
  await describe(page).fill('Make it night');
  await describe(page).press('Control+Enter');
  await expect(page.getByRole('button', { name: 'Change the picture' })).toBeDisabled();
  await page.waitForTimeout(200);
  expect(p.state.edited).toEqual([]);
  release();
  await expect.poll(() => names(page)).toEqual(['b.png']);
  await expect(page.getByRole('button', { name: 'Change the picture' })).toBeEnabled();
  await describe(page).press('Control+Enter');
  await expect.poll(() => p.state.edited.length).toBe(1);
  expect(p.state.edited[0].sources).toEqual([p.pics.find((x) => x.kind === 'uploaded')!.id]);
});

test('where the endpoint takes one picture, a picture put in replaces it, the extra ones are said to be left out, and the setting is named', async ({ page }) => {
  const p = await portal(page);
  await page.goto('/x/pithagoras-media/media');
  await drop(maker(page), ['one.png', 'two.png', 'three.png']);
  await expect.poll(() => names(page)).toEqual(['one.png']);
  expect(p.state.uploads.map((u) => u.name), 'only the one that is used was put in the gallery').toEqual(['one.png']);
  await expect(maker(page).getByRole('status').filter({ hasText: '2 more pictures were left out: this editing endpoint takes one picture per edit.' })).toBeVisible();
  // No row of several: no count, no add button, no way to move one; the picker takes one file.
  await expect(maker(page).getByText(/of 8 pictures/)).toHaveCount(0);
  await expect(strip(page).getByRole('button', { name: 'Add pictures from this computer' })).toHaveCount(0);
  await expect(page.getByLabel('Upload a picture')).not.toHaveAttribute('multiple', '');
  // What is said of the setting, with the way to it.
  await expect(maker(page).getByText(/takes one picture per edit, and a picture you add takes the place of the one there is/)).toBeVisible();
  await expect(maker(page).getByRole('link', { name: 'Set it up under Media in Settings' })).toHaveAttribute('href', '/settings/x/pithagoras-media');
  // Another put in takes the place of the one there is.
  await drop(maker(page), ['four.png']);
  await expect.poll(() => names(page)).toEqual(['four.png']);
});

test('several pictures chosen for an endpoint that takes one are said to be too many, and are not sent until one is left', async ({ page }) => {
  const a = pic({ prompt: 'Alpha', age: 3 });
  const b = pic({ prompt: 'Beta', age: 2 });
  const edit = pic({ prompt: 'Both', kind: 'edited', from: a.id, params: { sources: [a.id, b.id] }, age: 1 });
  const p = await portal(page, { pictures: [a, b, edit] });
  await page.goto('/x/pithagoras-media/media');
  await tile(page, 'Both').click();
  await viewer(page).getByRole('button', { name: 'Run again' }).click();
  await expect.poll(() => names(page)).toEqual(['Alpha', 'Beta']);
  await expect(maker(page).getByRole('alert').filter({ hasText: 'takes one picture per edit, and 2 are chosen' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Change the picture' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Change the picture' })).toHaveAttribute('title', /takes one picture per edit, and 2 are chosen/);
  await strip(page).getByRole('button', { name: 'Remove Beta' }).click();
  await expect(page.getByRole('button', { name: 'Change the picture' })).toBeEnabled();
  await page.getByRole('button', { name: 'Change the picture' }).click();
  await expect.poll(() => p.state.edited.length).toBe(1);
  expect(p.state.edited[0].sources).toEqual([a.id]);
});

test('the mask belongs to the first picture, which says so, and moving another first starts the mask over', async ({ page }) => {
  const a = pic({ prompt: 'Alpha', age: 2 });
  const b = pic({ prompt: 'Beta', age: 1 });
  const p = await portal(page, { pictures: [a, b], images: feature({ editMultiple: true }) });
  await page.goto('/x/pithagoras-media/media');
  await pick(page, 'Alpha', 'Beta');
  // Chosen in this order: Alpha, then Beta.
  await expect.poll(() => names(page)).toEqual(['Alpha', 'Beta']);
  await page.getByRole('button', { name: 'Only change a part: paint a mask' }).click();
  const painter = page.getByRole('img', { name: 'The picture to change' });
  await expect(painter).toHaveAttribute('src', `/api/x/pithagoras-media/images/${a.id}/file`);
  await expect(maker(page).getByText(/Paint over what should change in picture 1, “Alpha”\. The mask belongs to the first picture only/)).toBeVisible();
  await expect(strip(page).getByText('Mask', { exact: true })).toBeVisible();
  // The tag is on the first one.
  await expect(strip(page).getByRole('listitem').filter({ has: page.getByRole('img', { name: 'Alpha' }) }).getByText('Mask', { exact: true })).toBeVisible();
  // Another one in the first place is another picture to paint on: the mask starts over.
  await strip(page).getByRole('button', { name: 'Move Beta earlier' }).click();
  await expect.poll(() => names(page)).toEqual(['Beta', 'Alpha']);
  await expect(strip(page).getByText('Mask', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Only change a part: paint a mask' })).toBeVisible();
  await page.getByRole('button', { name: 'Only change a part: paint a mask' }).click();
  await expect(page.getByRole('img', { name: 'The picture to change' })).toHaveAttribute('src', `/api/x/pithagoras-media/images/${b.id}/file`);
  await describe(page).fill('Beta, as Alpha');
  await page.getByRole('button', { name: 'Change the picture' }).click();
  await expect.poll(() => p.state.edited.length).toBe(1);
  expect(p.state.edited[0]).toEqual({ prompt: 'Beta, as Alpha', sources: [b.id, a.id], count: 1 });
});

test('the mask painter is not reused for another first picture: it would keep the strokes and a failed load of the one before', async ({ page }) => {
  const a = pic({ prompt: 'Alpha', age: 2 });
  const b = pic({ prompt: 'Beta', age: 1 });
  await portal(page, { pictures: [a, b], images: feature({ editMultiple: true }) });
  await page.goto('/x/pithagoras-media/media');
  await pick(page, 'Alpha', 'Beta');
  await page.getByRole('button', { name: 'Only change a part: paint a mask' }).click();
  await expect(page.getByRole('img', { name: 'The picture to change' })).toHaveAttribute('src', `/api/x/pithagoras-media/images/${a.id}/file`);
  // Mask is switched off again as soon as the first picture changes, so the one render in between is where a painter that is kept shows: its picture is another's, under the old state.
  await page.evaluate(() => {
    (window as any).reused = 0;
    new MutationObserver((records) => {
      for (const r of records) {
        const img = r.target as HTMLElement;
        if (img.getAttribute('alt') === 'The picture to change' && r.oldValue !== img.getAttribute('src')) (window as any).reused++;
      }
    }).observe(document.body, { attributes: true, subtree: true, attributeFilter: ['src'], attributeOldValue: true });
  });
  await strip(page).getByRole('button', { name: 'Move Beta earlier' }).click();
  await expect.poll(() => names(page)).toEqual(['Beta', 'Alpha']);
  expect(await page.evaluate(() => (window as any).reused)).toBe(0);
});

test('a picture of the row opens larger in the viewer, which steps through them and gives focus back', async ({ page }) => {
  const a = pic({ prompt: 'Alpha', age: 2 });
  const b = pic({ prompt: 'Beta', age: 1 });
  await portal(page, { pictures: [a, b], images: feature({ editMultiple: true }) });
  await page.goto('/x/pithagoras-media/media');
  await pick(page, 'Alpha', 'Beta');
  await strip(page).getByRole('button', { name: 'Look at Beta' }).click();
  await expect(viewer(page).getByText('2 / 2', { exact: true })).toBeVisible();
  await expect(viewer(page).locator('img[data-picture]')).toHaveAttribute('src', `/api/x/pithagoras-media/images/${b.id}/file`);
  await viewer(page).getByRole('button', { name: 'Previous picture' }).click();
  await expect(viewer(page).locator('img[data-picture]')).toHaveAttribute('src', `/api/x/pithagoras-media/images/${a.id}/file`);
  await page.keyboard.press('Escape');
  await expect(viewer(page)).toHaveCount(0);
  await expect(strip(page).getByRole('button', { name: 'Look at Alpha' })).toBeFocused();
});

test('at most eight pictures can be chosen in the gallery: the others are dimmed and cannot be chosen until one is taken out, and the limit is said', async ({ page }) => {
  const many = Array.from({ length: 10 }, (_, i) => pic({ prompt: `Pic ${i + 1}`, age: i }));
  const p = await portal(page, { pictures: many, images: feature({ editMultiple: true }) });
  await page.goto('/x/pithagoras-media/media');
  await pick(page, ...Array.from({ length: 8 }, (_, i) => `Pic ${i + 1}`));
  await expect.poll(() => names(page)).toHaveLength(8);
  await expect(maker(page).getByText('8 of 8 pictures')).toBeVisible();
  // The ninth and tenth are not to be had: their box is off, with the reason. The picture itself can still be looked at.
  const ninth = box(page, 'Pic 9');
  await expect(ninth).toBeDisabled();
  await expect(cell(page, 'Pic 9').locator('.gallery-check-hit')).toHaveAttribute('title', 'An edit takes at most 8 pictures');
  await expect(cell(page, 'Pic 9').locator('.gallery-tile')).toHaveClass(/is-locked/);
  await expect(cell(page, 'Pic 1').locator('.gallery-tile')).not.toHaveClass(/is-locked/);
  await expect(box(page, 'Pic 10')).toBeDisabled();
  await expect.poll(() => names(page)).toHaveLength(8);
  await tile(page, 'Pic 9').click();
  await expect(viewer(page)).toBeVisible();
  // The viewer's choice is the box's: not for one that would be the ninth, and the one that is in can be taken out from there.
  await expect(viewer(page).getByRole('button', { name: 'Use in the edit' })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect.poll(() => names(page)).toHaveLength(8);
  // One that is in can still be taken out, and then the others can be chosen again.
  await box(page, 'Pic 8').uncheck();
  await expect(maker(page).getByText('7 of 8 pictures')).toBeVisible();
  await expect(ninth).toBeEnabled();
  await ninth.check();
  await expect.poll(() => names(page)).toHaveLength(8);
  await describe(page).fill('All of them');
  await page.getByRole('button', { name: 'Change the picture' }).click();
  await expect.poll(() => p.state.edited.length).toBe(1);
  expect(p.state.edited[0].sources).toEqual([1, 2, 3, 4, 5, 6, 7, 9].map((n) => many[n - 1].id));
});

test('a file that is no picture is said so by name, and the pictures with it are still added', async ({ page }) => {
  await portal(page, { images: feature({ editMultiple: true }) });
  await page.goto('/x/pithagoras-media/media');
  await maker(page).evaluate((el) => {
    const data = new DataTransfer();
    data.items.add(new File(['x'], 'notes.pdf', { type: 'application/pdf' }));
    data.items.add(new File(['y'], 'ok.png', { type: 'image/png' }));
    el.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }));
  });
  await expect.poll(() => names(page)).toEqual(['ok.png']);
  await expect(maker(page).getByRole('alert')).toContainText('notes.pdf is not a PNG, JPEG, GIF or WebP picture');
});

test('an upload the portal answers without words is said by name and status, and one that cannot reach the portal says that', async ({ page }) => {
  const p = await portal(page, { images: feature({ editMultiple: true }) });
  await page.goto('/x/pithagoras-media/media');
  await toEdit(page);
  await page.route('**/api/x/pithagoras-media/images/upload*', (route) => route.fulfill({ status: 500, body: '' }));
  await page.getByLabel('Upload a picture').setInputFiles([png('a.png')]);
  await expect(maker(page).getByRole('alert')).toHaveText('Could not upload a.png (500)');
  await page.route('**/api/x/pithagoras-media/images/upload*', (route) => route.abort('internetdisconnected'));
  await page.getByLabel('Upload a picture').setInputFiles([png('b.png')]);
  await expect(maker(page).getByRole('alert')).toHaveText('Cannot reach the portal');
  expect(p.state.uploads).toEqual([]);
});

test('where only generation is set up a drop or a paste does nothing, and the browser does not open the file', async ({ page }) => {
  const p = await portal(page, { images: feature({ editEnabled: false, editReady: false }) });
  await page.goto('/x/pithagoras-media/media');
  await drop(maker(page), ['one.png']);
  await paste(page.getByPlaceholder('Describe the picture'), ['two.png']);
  await page.waitForTimeout(150);
  expect(p.state.uploads).toEqual([]);
  await expect(maker(page)).toHaveAccessibleName('Make a picture');
});

test('on a phone eight pictures in the row stay on the screen, each reachable, and the form needs no sideways scroll', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 760 });
  const p = await portal(page, { images: feature({ editMultiple: true }) });
  await page.goto('/x/pithagoras-media/media');
  await toEdit(page);
  await page.getByLabel('Upload a picture').setInputFiles(Array.from({ length: 8 }, (_, i) => png(`phone${i + 1}.png`)));
  await expect.poll(() => names(page)).toHaveLength(8);
  expect(p.state.uploads).toHaveLength(8);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  for (const name of ['phone1.png', 'phone8.png']) {
    for (const button of [`Remove ${name}`, `Move ${name} ${name === 'phone1.png' ? 'later' : 'earlier'}`]) {
      const box = await strip(page).getByRole('button', { name: button }).boundingBox();
      expect(box, button).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(375);
      // A finger can hit it: nothing smaller than a small button.
      expect(box!.width).toBeGreaterThanOrEqual(24);
      expect(box!.height).toBeGreaterThanOrEqual(24);
    }
  }
});

test('the row of pictures reads in the dark theme as in the light: the places, the mask tag and the add button are not the colour of what is behind them', async ({ page }) => {
  await portal(page, { images: feature({ editMultiple: true }) });
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto('/x/pithagoras-media/media');
    await toEdit(page);
    await page.getByLabel('Upload a picture').setInputFiles([png('x.png'), png('y.png')]);
    await expect.poll(() => names(page)).toHaveLength(2);
    await page.getByRole('button', { name: 'Only change a part: paint a mask' }).click();
    const colours = await strip(page).evaluate((el) => {
      const read = (node: Element) => {
        const style = getComputedStyle(node);
        return { ink: style.color, ground: style.backgroundColor };
      };
      const tag = [...el.querySelectorAll('span')].find((x) => x.textContent === 'Mask')!;
      const place = [...el.querySelectorAll('span')].find((x) => x.textContent === '2')!;
      const add = el.querySelector('button[aria-label="Add pictures from this computer"]')!;
      return { tag: read(tag), place: read(place), add: { ink: getComputedStyle(add).color, ground: getComputedStyle(el.closest('section')!).backgroundColor } };
    });
    for (const [name, c] of Object.entries(colours)) expect(c.ink, `${scheme}: ${name}`).not.toBe(c.ground);
  }
});

test('Run again makes a picture from a description once more, as it was asked for, and not with the free fields an older version sent', async ({ page }) => {
  const made = pic({ prompt: 'A fox', params: { model: 'draw-2', size: '768x512', outputFormat: 'jpeg', outputCompression: 80, extra: { quality: 'high', seed: '42', hd: true } } });
  const p = await portal(page, { pictures: [made] });
  await page.goto('/x/pithagoras-media/media');
  await tile(page, 'A fox').click();
  await viewer(page).getByRole('button', { name: 'Run again' }).click();
  await expect(viewer(page)).toHaveCount(0);
  expect(p.state.generated).toEqual([{ prompt: 'A fox', size: '768x512', model: 'draw-2', outputFormat: 'jpeg', outputCompression: 80 }]);
  await expect(grid(page).locator('.image-preview.is-making')).toHaveCount(1);
});

for (const sdExtras of [false, true]) {
  test(`Run again ${sdExtras ? 'sends' : 'does not send'} what only stable-diffusion.cpp reads while the switch for it is ${sdExtras ? 'on' : 'off'}; the picture keeps it either way`, async ({ page }) => {
    const made = pic({ prompt: 'A fox', params: { model: 'draw-2', negativePrompt: 'blurry', seed: 42, sampleSteps: 20, strength: 0.5, fromNoise: true } });
    const p = await portal(page, { pictures: [made], images: feature({ sdExtras }) });
    await page.goto('/x/pithagoras-media/media');
    await tile(page, 'A fox').click();
    await viewer(page).getByRole('button', { name: 'Details' }).click();
    const details = viewer(page).getByRole('region', { name: 'Details' });
    await expect(details).toContainText('blurry');
    // What it was made with includes where it started from: noise, not the first picture, whatever the switch says now.
    await expect(details.locator('dt', { hasText: 'Start from' }).locator('xpath=following-sibling::dd[1]')).toHaveText('Noise only');
    await expect(details.locator('dt', { hasText: 'Strength' }).locator('xpath=following-sibling::dd[1]')).toHaveText('0.5');
    await viewer(page).getByRole('button', { name: 'Run again' }).click();
    await expect.poll(() => p.state.generated.length).toBe(1);
    expect(p.state.generated).toEqual([sdExtras ? { prompt: 'A fox', model: 'draw-2', negativePrompt: 'blurry', seed: 42, sampleSteps: 20 } : { prompt: 'A fox', model: 'draw-2' }]);
  });
}

test('Run again of a change shows it in the form, with its pictures and words, since its mask is not kept', async ({ page }) => {
  const a = pic({ prompt: 'Alpha', age: 5 });
  const edit = pic({ prompt: 'Make it night', kind: 'edited', from: a.id, params: { sources: [a.id], masked: true }, age: 1 });
  const p = await portal(page, { pictures: [a, edit] });
  await page.goto('/x/pithagoras-media/media');
  await tile(page, 'Make it night').click();
  await viewer(page).getByRole('button', { name: 'Run again' }).click();
  await expect(maker(page)).toHaveAccessibleName('Change a picture');
  await expect(maker(page).getByRole('img', { name: 'Alpha' })).toBeVisible();
  await expect(page.getByPlaceholder('Describe the change: what to add, remove or make different')).toHaveValue('Make it night');
  expect(p.state.edited).toEqual([]);
});

test('Run again of a change puts the form in Edit, where the boxes are the pictures of the edit: what was selected before is let go, and the bar with its Delete is gone', async ({ page }) => {
  const [a, b, c] = [pic({ prompt: 'Alpha', age: 5 }), pic({ prompt: 'Bravo', age: 4 }), pic({ prompt: 'Charlie', age: 3 })];
  const edit = pic({ prompt: 'Make it night', kind: 'edited', from: c.id, params: { sources: [c.id] }, age: 1 });
  const p = await portal(page, { pictures: [a, b, c, edit] });
  await page.goto('/x/pithagoras-media/media');
  await tick(page, 'Alpha');
  await tick(page, 'Bravo');
  await expect(bar(page).getByText('2 selected')).toBeVisible();
  await tile(page, 'Make it night').click();
  await viewer(page).getByRole('button', { name: 'Run again' }).click();
  await expect(maker(page)).toHaveAccessibleName('Change a picture');
  await expect.poll(() => names(page)).toEqual(['Charlie']);
  // The only box that is ticked is the edit's, and nothing else is selected behind it that a button of the bar could delete.
  await expect(box(page, 'Charlie')).toBeChecked();
  await expect(box(page, 'Alpha')).not.toBeChecked();
  await expect(box(page, 'Bravo')).not.toBeChecked();
  await expect(bar(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Delete', exact: true })).toHaveCount(0);
  expect(p.state.deleted).toEqual([]);
});

test('a picture put in from this computer is in the gallery and is the one to change', async ({ page }) => {
  const p = await portal(page);
  await page.goto('/x/pithagoras-media/media');
  await toEdit(page);
  await page.getByLabel('Upload a picture').setInputFiles({ name: 'cat.png', mimeType: 'image/png', buffer: Buffer.from('not really a png, the portal looks') });
  await expect(maker(page)).toHaveAccessibleName('Change a picture');
  await expect(maker(page).getByRole('img', { name: 'cat.png' })).toBeVisible();
  expect(p.state.uploads).toEqual([{ name: 'cat.png', type: 'application/octet-stream', size: 34 }]);
  await expect(tile(page, 'cat.png')).toBeVisible();
});

test('a part of the picture can be painted as a mask, which goes with the change at the picture’s own size', async ({ page }) => {
  const made = pic({ prompt: 'A fox' });
  const p = await portal(page, { pictures: [made] });
  await page.goto('/x/pithagoras-media/media');
  await tile(page, 'A fox').click();
  await viewer(page).getByRole('button', { name: 'Edit it' }).click();
  await page.getByRole('button', { name: 'Only change a part: paint a mask' }).click();
  const canvas = page.getByLabel('Paint over the part that should change');
  await loaded(page.getByRole('img', { name: 'The picture to change' }));
  const box = (await canvas.boundingBox())!;
  // A stroke across the middle.
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.5, { steps: 6 });
  await page.mouse.up();
  await page.getByPlaceholder('Describe the change: what to add, remove or make different').fill('Add a hat');
  await page.getByRole('button', { name: 'Change the picture' }).click();
  await expect.poll(() => p.state.edited.length).toBe(1);
  const sent = p.state.edited[0];
  expect(sent).toMatchObject({ prompt: 'Add a hat', sources: [made.id] });
  const pixels = await page.evaluate(async (mask) => {
    const img = new Image();
    img.src = `data:image/png;base64,${mask}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(img, 0, 0);
    const alpha = (x: number, y: number) => ctx.getImageData(x, y, 1, 1).data[3];
    return { w: img.naturalWidth, h: img.naturalHeight, painted: alpha(400, 300), outside: alpha(40, 40), below: alpha(400, 560) };
  }, sent.mask);
  // The picture's own size; transparent where it was painted, and opaque elsewhere.
  expect(pixels).toEqual({ w: 800, h: 600, painted: 0, outside: 255, below: 255 });
});

test('without a stroke no mask is sent, and the whole picture may change', async ({ page }) => {
  const made = pic({ prompt: 'A fox' });
  const p = await portal(page, { pictures: [made] });
  await page.goto('/x/pithagoras-media/media');
  await tile(page, 'A fox').click();
  await viewer(page).getByRole('button', { name: 'Edit it' }).click();
  await page.getByRole('button', { name: 'Only change a part: paint a mask' }).click();
  await page.getByPlaceholder('Describe the change: what to add, remove or make different').fill('Add a hat');
  await page.getByRole('button', { name: 'Change the picture' }).click();
  await expect.poll(() => p.state.edited.length).toBe(1);
  expect(p.state.edited[0]).toEqual({ prompt: 'Add a hat', sources: [made.id], count: 1 });
});

test('deleting a picture of the page asks, and takes it away', async ({ page }) => {
  const mine = pic({ prompt: 'Mine' });
  const other = pic({ prompt: 'Other', age: 5 });
  const p = await portal(page, { pictures: [mine, other] });
  await page.goto('/x/pithagoras-media/media');
  await tile(page, 'Mine').click();
  await viewer(page).getByRole('button', { name: 'Delete' }).click();
  const dialog = page.getByRole('alertdialog', { name: 'Delete this picture?' });
  await expect(dialog).toContainText('The file is deleted from the portal. This cannot be undone.');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  expect(p.state.deleted).toEqual([]);
  await expect(viewer(page)).toBeVisible();
  await viewer(page).getByRole('button', { name: 'Delete' }).click();
  await page.getByRole('alertdialog', { name: 'Delete this picture?' }).getByRole('button', { name: 'Delete' }).click();
  await expect.poll(() => p.state.deleted).toEqual([[mine.id]]);
  // The viewer goes on with the next, and the gallery has lost it.
  await expect(viewer(page).locator('img[data-picture]')).toHaveAttribute('src', `/api/x/pithagoras-media/images/${other.id}/file`);
  await page.keyboard.press('Escape');
  await expect(tile(page, 'Mine')).toHaveCount(0);
  await expect(grid(page).getByRole('listitem')).toHaveCount(1);
});

test('the page says how much of the disk its own pictures take, and the number goes down with a delete', async ({ page }) => {
  const mine = pic({ prompt: 'Mine' });
  const more = pic({ prompt: 'More', age: 1 });
  const theirs = pic({ prompt: 'From a chat', origin: 'chat', chat: { id: 'c1', title: 'A chat' }, age: 2 });
  await portal(page, { pictures: [mine, more, theirs] });
  await page.goto('/x/pithagoras-media/media');
  // A chat’s files are the chat’s: only the two of the page are counted, and a filter does not change it.
  const kept = page.getByText('kept from this page').locator('..');
  await expect(kept).toContainText('234.4 KB');
  await page.getByRole('radiogroup', { name: 'Where from' }).getByRole('radio', { name: 'From chats' }).click();
  await expect(tile(page, 'From a chat')).toBeVisible();
  await expect(kept).toContainText('234.4 KB');
  await page.getByRole('radiogroup', { name: 'Where from' }).getByRole('radio', { name: 'All' }).click();
  await tile(page, 'Mine').click();
  await viewer(page).getByRole('button', { name: 'Delete' }).click();
  await page.getByRole('alertdialog', { name: 'Delete this picture?' }).getByRole('button', { name: 'Delete' }).click();
  await expect(kept).toContainText('117.2 KB');
});

test('a picture in a chat’s folder is deleted only on purpose, with a warning, whatever Settings says', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('confirmDeletes', 'off'));
  const theirs = pic({ prompt: 'From a chat', origin: 'chat', chat: { id: 'c1', title: 'Holiday plans' } });
  const mine = pic({ prompt: 'Mine', age: 5 });
  const p = await portal(page, { pictures: [theirs, mine] });
  await page.goto('/x/pithagoras-media/media');
  // The page's own goes at once, where Settings says not to ask.
  await tile(page, 'Mine').click();
  await viewer(page).getByRole('button', { name: 'Delete' }).click();
  await expect.poll(() => p.state.deleted).toEqual([[mine.id]]);
  // A chat's is asked about.
  await expect(viewer(page).locator('img[data-picture]')).toHaveAttribute('src', `/api/x/pithagoras-media/images/${theirs.id}/file`);
  await viewer(page).getByRole('button', { name: 'Delete' }).click();
  const dialog = page.getByRole('alertdialog', { name: 'Delete this picture?' });
  await expect(dialog).toContainText('“Holiday plans”');
  await expect(dialog).toContainText('for good');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  expect(p.state.deleted).toEqual([[mine.id]]);
});

const bar = (page: Page) => page.getByRole('group', { name: 'Selected pictures' });

test('several pictures can be selected with their boxes, to download or delete together, and a click on a picture opens it', async ({ page }) => {
  const a = pic({ prompt: 'One', age: 3 });
  const b = pic({ prompt: 'Two', age: 2 });
  const c = pic({ prompt: 'Three', age: 1, origin: 'chat', chat: { id: 'c1', title: 'A chat' } });
  const p = await portal(page, { pictures: [a, b, c] });
  await page.goto('/x/pithagoras-media/media');
  // No select mode to go into, and no bar while nothing is ticked: the gallery says the boxes are there.
  await expect(page.getByRole('button', { name: 'Select', exact: true })).toHaveCount(0);
  await expect(bar(page)).toHaveCount(0);
  await expect(page.getByText('Tick pictures to download, delete or edit them. A click on a picture opens it.')).toBeVisible();
  // A tick selects, and does not open the viewer.
  await tick(page, 'One');
  await tick(page, 'Three');
  await expect(viewer(page)).toHaveCount(0);
  await expect(bar(page).getByText('2 selected')).toBeVisible();
  await expect(box(page, 'One')).toBeChecked();
  await expect(box(page, 'Two')).not.toBeChecked();
  await expect(box(page, 'Three')).toBeChecked();
  // A click on a ticked picture opens it, and ticks nothing more and nothing less.
  await tile(page, 'Two').click();
  await expect(viewer(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(viewer(page)).toHaveCount(0);
  await expect(bar(page).getByText('2 selected')).toBeVisible();
  const downloads: string[] = [];
  page.on('download', (d) => downloads.push(d.suggestedFilename()));
  await page.getByRole('button', { name: 'Download' }).click();
  await expect.poll(() => downloads.length).toBe(2);
  expect(downloads.sort()).toEqual([c.fileName, a.fileName].sort());
  // Deleting says that one of them is a chat’s.
  await page.getByRole('button', { name: 'Delete' }).click();
  const dialog = page.getByRole('alertdialog', { name: 'Delete these 2 pictures?' });
  await expect(dialog).toContainText('1 of them is a file in the folder of a chat');
  await dialog.getByRole('button', { name: 'Delete' }).click();
  await expect.poll(() => p.state.deleted.length).toBe(1);
  expect([...p.state.deleted[0]].sort()).toEqual([a.id, c.id].sort());
  await expect(grid(page).getByRole('listitem')).toHaveCount(1);
  // Nothing is ticked any more, so the bar is gone with it.
  await expect(bar(page)).toHaveCount(0);
});

test('the bar of the selection has the actions, clears with its button or Escape, and is let go of when the form goes to Edit', async ({ page }) => {
  const [a, b, c] = [pic({ prompt: 'Alpha', age: 3 }), pic({ prompt: 'Beta', age: 2 }), pic({ prompt: 'Gamma', age: 1 })];
  const p = await portal(page, { pictures: [a, b, c], images: feature({ editMultiple: true }) });
  await page.goto('/x/pithagoras-media/media');
  await tick(page, 'Gamma');
  const actions = bar(page).getByRole('button');
  await expect(actions).toHaveText(['Select all shown', 'Edit', 'Download', 'Delete', 'Clear selection']);
  await bar(page).getByRole('button', { name: 'Clear selection' }).click();
  await expect(bar(page)).toHaveCount(0);
  await expect(box(page, 'Gamma')).not.toBeChecked();
  await tick(page, 'Beta');
  await page.keyboard.press('Escape');
  await expect(bar(page)).toHaveCount(0);
  await expect(box(page, 'Beta')).not.toBeChecked();
  // Escape in a viewer closes the viewer and not the selection under it.
  await tick(page, 'Beta');
  await tile(page, 'Alpha').click();
  await page.keyboard.press('Escape');
  await expect(viewer(page)).toHaveCount(0);
  await expect(bar(page).getByText('1 selected')).toBeVisible();
  // Edit takes them into the form, in the order they were ticked, and the selection is let go of.
  await tick(page, 'Alpha');
  await bar(page).getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(maker(page)).toHaveAccessibleName('Change a picture');
  await expect.poll(() => names(page)).toEqual(['Beta', 'Alpha']);
  await expect(bar(page)).toHaveCount(0);
  await expect(box(page, 'Alpha')).toBeChecked();
  await expect(cell(page, 'Beta').locator('.gallery-order')).toHaveText('1');
  await expect(describe(page)).toBeFocused();
  await describe(page).fill('Both');
  await page.getByRole('button', { name: 'Change the picture' }).click();
  await expect.poll(() => p.state.edited.length).toBe(1);
  expect(p.state.edited[0].sources).toEqual([b.id, a.id]);
  // Ticks made in Generate are not the edit's: going to Edit by the switch starts from what the form has.
  await toMake(page);
  await box(page, 'Alpha').uncheck();
  await tick(page, 'Gamma');
  await expect(bar(page).getByText('1 selected')).toBeVisible();
  await toEdit(page);
  await expect(bar(page)).toHaveCount(0);
});

test('a selection that cannot all be an edit says why, where the endpoint takes one picture, and the Edit button is off', async ({ page }) => {
  const [a, b] = [pic({ prompt: 'Alpha', age: 2 }), pic({ prompt: 'Beta', age: 1 })];
  const p = await portal(page, { pictures: [a, b] });
  await page.goto('/x/pithagoras-media/media');
  await tick(page, 'Alpha');
  const edit = bar(page).getByRole('button', { name: 'Edit', exact: true });
  await expect(edit).toBeEnabled();
  await tick(page, 'Beta');
  await expect(edit).toBeDisabled();
  await expect(edit).toHaveAttribute('title', 'The editing endpoint takes one picture per edit: select one');
  // And in words on the bar, which a phone and a keyboard have, and the button points to.
  const why = bar(page).getByText('The editing endpoint takes one picture per edit: select one');
  await expect(why).toBeVisible();
  await expect(edit).toHaveAccessibleDescription('The editing endpoint takes one picture per edit: select one');
  await box(page, 'Beta').uncheck();
  await expect(why).toHaveCount(0);
  await edit.click();
  await expect.poll(() => names(page)).toEqual(['Alpha']);
  await describe(page).fill('Make it night');
  await page.getByRole('button', { name: 'Change the picture' }).click();
  await expect.poll(() => p.state.edited.length).toBe(1);
  expect(p.state.edited[0].sources).toEqual([a.id]);
});

test('a selection does not follow a change of filter: a chat’s picture that is not shown is never deleted with another, whatever Settings says', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('confirmDeletes', 'off'));
  const theirs = pic({ prompt: 'From a chat', origin: 'chat', chat: { id: 'c1', title: 'Holiday plans' }, age: 5 });
  const mine = pic({ prompt: 'Mine' });
  const p = await portal(page, { pictures: [theirs, mine] });
  await page.goto('/x/pithagoras-media/media?origin=chat');
  await tick(page, 'From a chat');
  await expect(page.getByText('1 selected')).toBeVisible();
  await page.getByRole('radiogroup', { name: 'Where from' }).getByRole('radio', { name: 'Made here' }).click();
  await expect(tile(page, 'Mine')).toBeVisible();
  // What is not shown is not selected: nothing is, and the bar is gone.
  await expect(bar(page)).toHaveCount(0);
  await tick(page, 'Mine');
  await expect(page.getByText('1 selected')).toBeVisible();
  await page.getByRole('button', { name: 'Delete' }).click();
  await expect.poll(() => p.state.deleted).toEqual([[mine.id]]);
  // Back to the chats: still there, and not selected.
  await page.goBack();
  await expect(tile(page, 'From a chat')).toBeVisible();
  await expect(box(page, 'From a chat')).not.toBeChecked();
  await expect(bar(page)).toHaveCount(0);
  expect(p.state.deleted).toEqual([[mine.id]]);
});

test('a gallery of hundreds can be selected whole and deleted: the portal takes 200 at a time, and one question covers them all', async ({ page }) => {
  const many = Array.from({ length: 240 }, (_, i) => pic({ prompt: `Many ${i + 1}`, age: i }));
  const p = await portal(page, { pictures: many });
  // Without the observer that reads on as the end comes near, so that the button is the only thing that does. With it, the
  // click's scroll to the button can bring the next page first, and the click then reads on one page too far or finds no button.
  await page.addInitScript(() => delete (window as any).IntersectionObserver);
  await page.goto('/x/pithagoras-media/media');
  // A page at a time, by the button, until all of it is loaded.
  for (const shown of [96, 144, 192, 240]) {
    await page.getByRole('button', { name: 'Show more' }).click();
    await expect(grid(page).getByRole('listitem')).toHaveCount(shown);
  }
  await tick(page, 'Many 1');
  await page.getByRole('button', { name: 'Select all shown' }).click();
  await expect(page.getByText('240 selected')).toBeVisible();
  await page.getByRole('button', { name: 'Delete' }).click();
  await page.getByRole('alertdialog', { name: 'Delete these 240 pictures?' }).getByRole('button', { name: 'Delete' }).click();
  await expect.poll(() => p.state.deleted.map((ids) => ids.length)).toEqual([200, 40]);
  await expect(grid(page).getByRole('listitem')).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(bar(page)).toHaveCount(0);
});

test('on a phone the grid has two columns, the viewer reaches every action, and nothing runs off the screen', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 760 });
  const many = Array.from({ length: 6 }, (_, i) => pic({ prompt: `Phone ${i + 1}`, age: i }));
  // Every button there can be: the row of them is longer than the screen.
  await portal(page, { pictures: many, images: feature({ editMultiple: true }) });
  await page.goto('/x/pithagoras-media/media');
  await expect(grid(page).getByRole('listitem')).toHaveCount(6);
  const columns = await grid(page).evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').length);
  expect(columns).toBe(2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await tile(page, 'Phone 1').click();
  for (const name of ['Details', 'Edit it', 'Run again', 'Delete', 'Close']) {
    const box = await viewer(page).getByRole('button', { name }).boundingBox();
    expect(box, name).not.toBeNull();
    expect(box!.x + box!.width).toBeLessThanOrEqual(375);
    expect(box!.x).toBeGreaterThanOrEqual(0);
  }
  // Where the buttons are too many for one row, the one that wraps stays at the right, under the others, and not at the left under the count.
  const close = await viewer(page).getByRole('button', { name: 'Close' }).boundingBox();
  expect(close!.x + close!.width).toBeGreaterThan(375 - 16);
  await viewer(page).getByRole('button', { name: 'Details' }).click();
  const panel = await viewer(page).getByRole('region', { name: 'Details' }).boundingBox();
  expect(panel!.x).toBeGreaterThanOrEqual(0);
  expect(panel!.x + panel!.width).toBeLessThanOrEqual(375);
});

test('the gallery reads in the dark theme as in the light', async ({ page }) => {
  await portal(page, { pictures: [pic({ prompt: 'Dim one' })], jobs: [{ id: 'e'.repeat(12), kind: 'generate', state: 'failed', prompt: 'Not made', startedAt: Date.now() - 5000, error: 'No luck' }] });
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto('/x/pithagoras-media/media');
    const tileBox = tile(page, 'Dim one');
    await expect(tileBox).toBeVisible();
    // The failure is readable on either: its words are not the colour of what is behind them.
    const colours = await grid(page).locator('.image-preview.is-failed').evaluate((el) => {
      const words = el.querySelector('.image-preview-failed b') as HTMLElement;
      return { ink: getComputedStyle(words).color, ground: getComputedStyle(el.querySelector('.image-preview-frame')!).backgroundColor };
    });
    expect(colours.ink).not.toBe(colours.ground);
  }
});

test('a tile of a big picture loads its small copy, and one of a small file or a GIF loads the file', async ({ page }) => {
  const big = pic({ prompt: 'A heavy picture', age: 5, thumb: true });
  const small = pic({ prompt: 'A small file', age: 4, bytes: 2_000 });
  const animated = pic({ prompt: 'A moving one', age: 3, fileName: 'move.gif' });
  const p = await portal(page, { pictures: [big, small, animated] });
  await page.goto('/x/pithagoras-media/media');
  for (const name of ['A heavy picture', 'A small file', 'A moving one']) await loaded(tile(page, name).getByRole('img'));
  await expect(tile(page, 'A heavy picture').getByRole('img')).toHaveAttribute('src', `/api/x/pithagoras-media/images/${big.id}/thumb`);
  await expect(tile(page, 'A small file').getByRole('img')).toHaveAttribute('src', `/api/x/pithagoras-media/images/${small.id}/file`);
  await expect(tile(page, 'A moving one').getByRole('img')).toHaveAttribute('src', `/api/x/pithagoras-media/images/${animated.id}/file`);
  expect(p.state.thumbFiles).toEqual([big.id]);
  expect(p.state.files, 'the big picture\'s file is not loaded for its tile').not.toContain(big.id);
});

test('the pictures of an edit show their small copies in the form', async ({ page }) => {
  const a = pic({ prompt: 'With a copy', age: 5, thumb: true });
  const b = pic({ prompt: 'Without one', age: 4 });
  const p = await portal(page, { pictures: [a, b], images: feature({ editMultiple: true }) });
  await page.goto('/x/pithagoras-media/media');
  await pick(page, 'With a copy', 'Without one');
  await expect(thumbs(page)).toHaveCount(2);
  await loaded(thumbs(page).first());
  await loaded(thumbs(page).last());
  expect(await thumbs(page).evaluateAll((els) => els.map((e) => e.getAttribute('src')))).toEqual([`/api/x/pithagoras-media/images/${a.id}/thumb`, `/api/x/pithagoras-media/images/${b.id}/file`]);
  expect(p.state.thumbFiles).toContain(a.id);
});

/** A new picture's references, as the form lists them in Generate. */
const references = (page: Page) => maker(page).getByRole('list', { name: /reference picture/i });
const referenceNames = (page: Page) => references(page).getByRole('img').evaluateAll((els) => els.map((e) => e.getAttribute('alt')));

test('reference pictures in Generate: opened, ticked in the gallery in order, reordered, and sent with the description; closed, the boxes select again', async ({ page }) => {
  const sheet = pic({ prompt: 'A fox sheet', age: 2 });
  const style = pic({ prompt: 'Watercolour', age: 1 });
  const p = await portal(page, { pictures: [sheet, style], images: feature({ editMultiple: true, editModel: 'edit-model', sdExtras: true }) });
  await page.goto('/x/pithagoras-media/media');
  await expect(maker(page)).toHaveAccessibleName('Make a picture');
  // Closed until opened: Generate's boxes are for a download, a delete and a change.
  const open = maker(page).getByRole('button', { name: 'Use reference pictures' });
  await expect(open).toHaveAttribute('aria-expanded', 'false');
  await expect(box(page, 'A fox sheet')).toHaveAccessibleName('Select A fox sheet');
  await open.click();
  await expect(maker(page).getByText('No reference picture yet. Tick pictures in the gallery below, drop or paste them here, or add them from this computer.')).toBeVisible();
  await expect(box(page, 'A fox sheet')).toHaveAccessibleName('Use A fox sheet as a reference');
  await expect(page.getByText('Tick pictures to use them as references, in the order you tick them. A click on a picture opens it.')).toBeVisible();
  // Ticked in an order, and moved: the order is the request's.
  await tick(page, 'Watercolour');
  await tick(page, 'A fox sheet');
  await expect.poll(() => referenceNames(page)).toEqual(['Watercolour', 'A fox sheet']);
  await expect(cell(page, 'Watercolour').locator('.gallery-order')).toHaveText('1');
  await references(page).getByRole('button', { name: 'Move A fox sheet earlier' }).click();
  await expect.poll(() => referenceNames(page)).toEqual(['A fox sheet', 'Watercolour']);
  // From noise, as the add-on says the endpoint is stable-diffusion.cpp; the editing model is what is used without one typed.
  await expect(maker(page).getByText('The new picture starts from noise: the references guide it, and none of them is changed.')).toBeVisible();
  await expect(page.locator('#image-model')).toHaveAttribute('placeholder', 'edit-model');
  await page.getByPlaceholder('Describe the picture').fill('The fox from the first picture, skiing');
  await page.getByRole('button', { name: 'Make the picture' }).click();
  await expect.poll(() => p.state.generated.length).toBe(1);
  expect(p.state.generated[0]).toEqual({ prompt: 'The fox from the first picture, skiing', count: 1, references: [sheet.id, style.id] });
  expect(p.state.edited).toEqual([]);

  // Closed again: none are sent, and the boxes select.
  await maker(page).getByRole('button', { name: 'Leave out the reference pictures' }).click();
  await expect(references(page)).toHaveCount(0);
  await expect(box(page, 'A fox sheet')).toHaveAccessibleName('Select A fox sheet');
  await page.getByRole('button', { name: 'Make the picture' }).click();
  await expect.poll(() => p.state.generated.length).toBe(2);
  expect(p.state.generated[1]).toEqual({ prompt: 'The fox from the first picture, skiing', count: 1 });
});

test('the form says what happens to references: the first may be the start while Stable Diffusion extra settings are off, a size may be the first’s, and one where the endpoint takes one', async ({ page }) => {
  const sheet = pic({ prompt: 'A fox sheet', age: 2 });
  const style = pic({ prompt: 'Watercolour', age: 1 });
  await portal(page, { pictures: [sheet, style], images: feature({ size: '', sdExtras: false }) });
  await page.goto('/x/pithagoras-media/media');
  await maker(page).getByRole('button', { name: 'Use reference pictures' }).click();
  await expect(maker(page).getByText(/^This editing endpoint takes one reference picture, and a picture you add takes the place of the one there is/)).toBeVisible();
  await tick(page, 'A fox sheet');
  await expect(maker(page).getByText(/Stable Diffusion extra settings are off, so a stable-diffusion\.cpp server starts from the first reference, and the picture may come out as a reworked copy of it/)).toBeVisible();
  await expect(maker(page).getByRole('link', { name: 'Media in Settings', exact: true })).toBeVisible();
  const noSize = maker(page).getByText('No size is set, so the endpoint may make the picture in the size and shape of the first reference. Set a width and height to choose them.');
  await expect(noSize).toBeVisible();
  await page.locator('#image-width').fill('768');
  await page.locator('#image-height').fill('1344');
  await expect(noSize).toHaveCount(0);
  // One where the endpoint takes one: another takes its place.
  await tick(page, 'Watercolour');
  await expect.poll(() => referenceNames(page)).toEqual(['Watercolour']);
  await expect(box(page, 'A fox sheet')).not.toBeChecked();
});

test('without editing, references say what to switch on, and the gallery’s boxes stay for selecting', async ({ page }) => {
  await portal(page, { pictures: [pic({ prompt: 'A fox sheet' })], images: feature({ editEnabled: false, editReady: false }) });
  await page.goto('/x/pithagoras-media/media');
  await maker(page).getByRole('button', { name: 'Use reference pictures' }).click();
  await expect(maker(page).getByText('Reference pictures are sent to the image editing endpoint, and image editing is switched off or has no address.')).toBeVisible();
  await expect(maker(page).getByRole('link', { name: 'Set it up under Media in Settings' })).toBeVisible();
  await expect(box(page, 'A fox sheet')).toHaveAccessibleName('Select A fox sheet');
});

test('pictures dropped on Generate while references are open are references, uploaded once; closed, a drop still starts an edit', async ({ page }) => {
  const p = await portal(page, { images: feature({ editMultiple: true }) });
  await page.goto('/x/pithagoras-media/media');
  await maker(page).getByRole('button', { name: 'Use reference pictures' }).click();
  await maker(page).evaluate((el) => {
    const data = new DataTransfer();
    data.items.add(new File(['x'], 'x.png', { type: 'image/png' }));
    el.dispatchEvent(new DragEvent('dragover', { dataTransfer: data, bubbles: true, cancelable: true }));
  });
  await expect(maker(page).getByText('Drop pictures here to use them as references')).toBeVisible();
  await drop(maker(page), ['sheet.png', 'style.png']);
  await expect.poll(() => referenceNames(page)).toEqual(['sheet.png', 'style.png']);
  await expect(maker(page)).toHaveAccessibleName('Make a picture');
  expect(p.state.uploads.map((u) => u.name)).toEqual(['sheet.png', 'style.png']);
  await maker(page).getByRole('button', { name: 'Leave out the reference pictures' }).click();
  await drop(maker(page), ['photo.png']);
  await expect(maker(page)).toHaveAccessibleName('Change a picture');
  await expect.poll(() => names(page)).toEqual(['photo.png']);
});

test('a picture made from references says so under Details, and Run again makes it with the same ones, or says they are gone', async ({ page }) => {
  const sheet = pic({ prompt: 'A fox sheet', age: 3 });
  const style = pic({ prompt: 'Watercolour', age: 2 });
  const made = pic({ prompt: 'The fox, skiing', params: { model: 'edit-model', size: '1024x1024', fromNoise: true, references: [sheet.id, style.id] }, age: 1 });
  const lost = pic({ prompt: 'The fox, sailing', params: { references: [sheet.id, 'ffffffffffff'] }, age: 0 });
  const p = await portal(page, { pictures: [sheet, style, made, lost], images: feature({ editMultiple: true }) });
  await page.goto('/x/pithagoras-media/media');
  await tile(page, 'The fox, skiing').click();
  await viewer(page).getByRole('button', { name: 'Details' }).click();
  const details = viewer(page).getByRole('region', { name: 'Details' });
  for (const [name, value] of [['How', 'Made from a description'], ['Reference pictures', '2 pictures'], ['Start from', 'Noise only'], ['Model', 'edit-model']]) {
    await expect(details.locator('dt', { hasText: name }).locator('xpath=following-sibling::dd[1]')).toHaveText(value);
  }
  await viewer(page).getByRole('button', { name: 'Run again' }).click();
  await expect.poll(() => p.state.generated.length).toBe(1);
  // The model is the editing endpoint's, always: it is not sent.
  expect(p.state.generated[0]).toEqual({ prompt: 'The fox, skiing', size: '1024x1024', references: [sheet.id, style.id] });

  await tile(page, 'The fox, sailing').click();
  await viewer(page).getByRole('button', { name: 'Run again' }).click();
  await expect(page.getByText('The reference pictures this was made with are not all in the gallery any more.')).toBeVisible();
  expect(p.state.generated).toHaveLength(1);
});

test('with references the Model field shows the editing model and is off: a model typed for making pictures is kept, and not sent', async ({ page }) => {
  const sheet = pic({ prompt: 'A fox sheet' });
  const p = await portal(page, { pictures: [sheet], images: feature({ model: 'image-model', editModel: 'edit-model', editMultiple: true }) });
  await page.goto('/x/pithagoras-media/media');
  const model = page.locator('#image-model');
  await model.fill('generation-only-model');
  await maker(page).getByRole('button', { name: 'Use reference pictures' }).click();
  // Open and empty, the picture is made as ever, with the model typed.
  await expect(model).toBeEnabled();
  await tick(page, 'A fox sheet');
  await expect(model).toBeDisabled();
  await expect(model).toHaveValue('edit-model');
  await expect(model).toHaveAccessibleDescription('Reference pictures use the editing model: edit-model');
  await page.getByPlaceholder('Describe the picture').fill('The fox, sailing');
  await page.getByRole('button', { name: 'Make the picture' }).click();
  await expect.poll(() => p.state.generated.length).toBe(1);
  expect(p.state.generated[0]).toEqual({ prompt: 'The fox, sailing', count: 1, references: [sheet.id] });
  // Without references the typed one is back, and sent.
  await maker(page).getByRole('button', { name: 'Leave out the reference pictures' }).click();
  await expect(model).toBeEnabled();
  await expect(model).toHaveValue('generation-only-model');
  await expect(maker(page).getByText(/Reference pictures use the editing/)).toHaveCount(0);
  await page.getByRole('button', { name: 'Make the picture' }).click();
  await expect.poll(() => p.state.generated.length).toBe(2);
  expect(p.state.generated[1]).toEqual({ prompt: 'The fox, sailing', model: 'generation-only-model', count: 1 });
});

test('with no editing model set, the Model field says references use the editing endpoint’s own', async ({ page }) => {
  await portal(page, { pictures: [pic({ prompt: 'A fox sheet' })], images: feature({ editModel: '' }) });
  await page.goto('/x/pithagoras-media/media');
  await maker(page).getByRole('button', { name: 'Use reference pictures' }).click();
  await tick(page, 'A fox sheet');
  await expect(page.locator('#image-model')).toBeDisabled();
  await expect(page.locator('#image-model')).toHaveValue('');
  await expect(maker(page).getByText("Reference pictures use the editing endpoint's own model.")).toBeVisible();
});

test('a reference that was scaled down is said to be one in the warning, not a picture changed for an edit', async ({ page }) => {
  const sheet = pic({ prompt: 'A fox sheet' });
  const p = await portal(page, { pictures: [sheet] });
  await page.goto('/x/pithagoras-media/media');
  await maker(page).getByRole('button', { name: 'Use reference pictures' }).click();
  await tick(page, 'A fox sheet');
  await page.getByPlaceholder('Describe the picture').fill('The fox, skiing');
  await page.getByRole('button', { name: 'Make the picture' }).click();
  await expect.poll(() => p.state.jobs.length).toBe(1);
  const note = 'The reference was scaled down from 4000x500 pixels (1.2 MB) to 2048x256 pixels (0.3 MB) to fit what the editing endpoint takes.';
  p.finish(p.state.jobs[0].id, {}, [note]);
  const warning = page.getByRole('status').filter({ hasText: 'A reference picture was scaled down to fit what the editing endpoint takes.' });
  await expect(warning).toBeVisible();
  await expect(warning).toContainText(note);
  await expect(page.getByText('A picture was changed to fit what an edit takes.')).toHaveCount(0);
});

test('Run again of a picture made with the same reference twice makes it again with both', async ({ page }) => {
  const sheet = pic({ prompt: 'A fox sheet', age: 2 });
  const twice = pic({ prompt: 'Two foxes', params: { references: [sheet.id, sheet.id] }, age: 1 });
  const p = await portal(page, { pictures: [sheet, twice], images: feature({ editMultiple: true }) });
  await page.goto('/x/pithagoras-media/media');
  await tile(page, 'Two foxes').click();
  await viewer(page).getByRole('button', { name: 'Run again' }).click();
  await expect.poll(() => p.state.generated.length).toBe(1);
  expect(p.state.generated[0]).toEqual({ prompt: 'Two foxes', references: [sheet.id, sheet.id] });
});
