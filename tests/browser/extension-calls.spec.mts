import { type Page } from '@playwright/test';
import { test, expect, mockPortal, reply, DONE, listeningTo, pushAsks, pushed } from './portal-mock';

/**
 * What an extension's browser half is given beyond drawing in a slot: the portal's own routes for a chat, as calls and not as addresses
 * to build (`portal.chats.create`, `chats.files`, `chats.background`), and the topics its server half pushes to (`portal.server.on(topic)`).
 * The extension here only hands its `portal` to the test (`window.probe`), which calls it as a module would.
 */
const NAME = 'probe';
const MODULE = 'export default function (portal) { window.probe = portal; }';

async function open(page: Page, answer: (ask: { path: string; method: string; json: () => any }) => unknown = () => undefined, { settings = false } = {}) {
  const asked: { method: string; path: string; search: string; body: unknown; type: string | undefined }[] = [];
  await mockPortal(page, async (ask) => {
    asked.push({ method: ask.method, path: ask.path, search: ask.url.search, body: ask.method === 'POST' ? ask.route.request().postData() : null, type: ask.route.request().headers()['content-type'] });
    if (ask.path === '/api/extension-ui') return { extensions: [{ name: NAME, version: '1.0.0', entry: `/api/extension-ui/${NAME}/client.js?v=1`, server: `/api/x/${NAME}` }] };
    if (ask.path === `/api/extension-ui/${NAME}/client.js`) {
      await ask.route.fulfill({ contentType: 'text/javascript', body: MODULE });
      return DONE;
    }
    return answer(ask);
  }, { streams: 'open', settings });
  await page.goto('/');
  await page.waitForFunction(() => (window as any).probe);
  return asked;
}
const probe = <T,>(page: Page, run: (portal: any) => T, ...args: unknown[]) => page.evaluate(([source, args]) => new Function('portal', 'args', `return (${source})(portal, ...args)`)((window as any).probe, args), [run.toString(), args] as const);

test('a chat is made as New chat makes one, in the folder and under the name it is asked for, and is not opened', async ({ page }) => {
  const asked = await open(page, (ask) => (ask.path === '/api/sessions' && ask.method === 'POST' ? { id: 'n1', title: ask.json().title ?? 'New chat', workspace: ask.json().workspace ?? '/h/agent', status: 'idle' } : undefined));
  const made = await probe(page, (portal) => portal.chats.create({ title: 'Comments on the plan', workspace: '/w/site' }));
  expect(made).toEqual({ id: 'n1', title: 'Comments on the plan', workspace: '/w/site' });
  const posted = asked.find((a) => a.method === 'POST' && a.path === '/api/sessions')!;
  expect(JSON.parse(posted.body as string)).toEqual({ workspace: '/w/site', title: 'Comments on the plan' });
  // Without options: the portal chooses the folder and the name.
  expect(await probe(page, (portal) => portal.chats.create())).toEqual({ id: 'n1', title: 'New chat', workspace: '/h/agent' });
  expect(new URL(page.url()).pathname).toBe('/');
});

test('the portal\'s routes for a chat\'s folder are calls: a picture, a clip and a file by address, an upload, and a path that needs encoding', async ({ page }) => {
  const asked = await open(page, (ask) => (ask.path === '/api/sessions/a/upload' ? { ok: true, path: 'sub/a b (2).txt', size: 2 } : undefined));
  const urls = await probe(page, (portal) => [
    portal.chats.files.pictureUrl('a', 'my pic/é.png'),
    portal.chats.files.pictureUrl('a', 'x.png', 3),
    portal.chats.files.videoUrl('a', 'clip.mp4', 'v9'),
    portal.chats.files.fileUrl('a', 'out/report?.pdf', 12),
  ]);
  expect(urls).toEqual([
    '/api/sessions/a/picture?path=my%20pic%2F%C3%A9.png',
    '/api/sessions/a/picture?path=x.png&v=3',
    '/api/sessions/a/video?path=clip.mp4&v=v9',
    '/api/sessions/a/file?path=out%2Freport%3F.pdf&v=12',
  ]);
  const stored = await probe(page, (portal) => portal.chats.files.upload('a', 'sub', new File(['hi'], 'a b.txt', { type: 'text/plain' })));
  expect(stored).toMatchObject({ path: 'sub/a b (2).txt', size: 2 });
  const upload = asked.find((a) => a.path === '/api/sessions/a/upload')!;
  expect(upload.search).toBe('?path=sub&name=a%20b.txt');
  expect(upload.type).toBe('application/octet-stream');
  expect(upload.body).toBe('hi');
});

test('the jobs the agent left running are stopped, forgotten and followed by calls, with a key that needs encoding', async ({ page }) => {
  const asked = await open(page, (ask) => (/\/background\/.*\/output$/.test(ask.path) ? { text: 'more', from: 4, size: 8 } : ask.path.startsWith('/api/sessions/a/background/') ? { ok: true } : undefined));
  await probe(page, (portal) => portal.chats.background.stop('a', 'job 1'));
  await probe(page, (portal) => portal.chats.background.clear('a'));
  expect(await probe(page, (portal) => portal.chats.background.output('a', 'job 1', 4))).toEqual({ text: 'more', from: 4, size: 8 });
  await probe(page, (portal) => portal.chats.background.output('a', 'job 1'));
  expect(asked.filter((a) => a.path.startsWith('/api/sessions/a/background/')).map((a) => `${a.method} ${a.path}${a.search}`)).toEqual([
    'POST /api/sessions/a/background/job%201/stop',
    'POST /api/sessions/a/background/clear',
    'GET /api/sessions/a/background/job%201/output?from=4',
    'GET /api/sessions/a/background/job%201/output',
  ]);
});

test('a topic of the extension\'s server half is listened to on the page\'s one stream, heard from the moment it is asked for, and let go of with the last listener', async ({ page }) => {
  await open(page);
  await probe(page, (portal) => {
    (window as any).heard = [];
    (window as any).off = [
      portal.server.on('notes', (data: unknown) => (window as any).heard.push(['one', data])),
      portal.server.on('notes', (data: unknown) => (window as any).heard.push(['two', data])),
      portal.server.on('other', (data: unknown) => (window as any).heard.push(['other', data])),
    ];
  });
  await expect.poll(() => listeningTo(page)).toEqual([[NAME, 'notes'], [NAME, 'other']]);
  expect(pushAsks(page).filter(([kind, , topic]) => kind === 'listen' && topic === 'notes')).toHaveLength(1);
  await pushed(page, NAME, 'notes', { n: 1 });
  await pushed(page, 'someone-else', 'notes', { n: 2 });
  await pushed(page, NAME, 'unheard', { n: 3 });
  expect(await page.evaluate(() => (window as any).heard)).toEqual([['one', { n: 1 }], ['two', { n: 1 }]]);
  // One of two goes: the topic is still listened to. The last goes: it is let go of.
  await page.evaluate(() => (window as any).off[0]());
  await page.waitForTimeout(100);
  expect(listeningTo(page)).toContainEqual([NAME, 'notes']);
  await page.evaluate(() => (window as any).off[1]());
  await expect.poll(() => listeningTo(page)).toEqual([[NAME, 'other']]);
  await pushed(page, NAME, 'notes', { n: 4 });
  expect(await page.evaluate(() => (window as any).heard.length)).toBe(2);
});

test('a topic the server half does not allow is asked for once and given up, and a handler for a chat\'s messages asks for no topic', async ({ page }) => {
  await open(page, (ask) => (/^\/api\/pushes\/[^/]+\/listen$/.test(ask.path) && ask.json().topic === 'secret' ? reply(403, { error: 'That topic is not for this page', code: 'refused' }) : undefined));
  await probe(page, (portal) => {
    portal.server.on('secret', () => {});
    // The other overload: what the server half says to the pages open on a chat. It asks for no topic.
    portal.server.on(() => {});
  });
  await expect.poll(() => pushAsks(page).length).toBe(1);
  // A refusal is not asked again after a wait, as a server half that is not running yet is.
  await page.waitForTimeout(2600);
  expect(pushAsks(page)).toEqual([['listen', NAME, 'secret']]);
});

test('a shortcut for anywhere in the portal runs wherever the key is pressed, is listed in Settings, and is left to a field that is typed in unless the key has a modifier', async ({ page }) => {
  await page.addInitScript(() => localStorage.removeItem('keybindings'));
  await open(page);
  await page.evaluate(() => {
    const portal = (window as any).probe;
    (window as any).ran = [];
    (window as any).offs = [
      portal.shortcuts.register({ id: 'plain', label: 'A key alone', scope: 'app', default: { code: 'KeyJ' }, run: ({ target }: any) => { (window as any).ran.push(['plain', (target as HTMLElement).tagName]); } }),
      portal.shortcuts.register({ id: 'save', label: 'Save the thing', scope: 'app', default: { code: 'KeyS', ctrl: true }, run: ({ target }: any) => { (window as any).ran.push(['save', (target as HTMLElement).tagName]); } }),
      portal.shortcuts.register({ id: 'declines', label: 'Declines', scope: 'app', default: { code: 'KeyK', ctrl: true }, run: () => false }),
    ];
    document.body.insertAdjacentHTML('beforeend', '<input id="field" aria-label="a field"><button id="plain-button">b</button>');
  });
  const ran = () => page.evaluate(() => (window as any).ran);
  // On the page, anywhere.
  await page.locator('#plain-button').focus();
  await page.keyboard.press('j');
  await page.keyboard.press('Control+s');
  expect(await ran()).toEqual([['plain', 'BUTTON'], ['save', 'BUTTON']]);
  // In a field: a key alone is the field's, one with Ctrl is the shortcut's.
  await page.locator('#field').focus();
  await page.keyboard.press('j');
  expect(await page.locator('#field').inputValue()).toBe('j');
  await page.keyboard.press('Control+s');
  expect(await ran()).toEqual([['plain', 'BUTTON'], ['save', 'BUTTON'], ['save', 'INPUT']]);
  // One that has nothing to do leaves the key to the browser: it was not stopped.
  const prevented = await page.evaluate(() => new Promise<boolean>((resolve) => {
    window.addEventListener('keydown', (e) => setTimeout(() => resolve(e.defaultPrevented)), { once: true });
    document.getElementById('plain-button')!.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyK', key: 'k', ctrlKey: true, bubbles: true, cancelable: true }));
  }));
  expect(prevented).toBe(false);
  // The key that ran is the portal's: the browser's own meaning of it is not.
  const saved = await page.evaluate(() => new Promise<boolean>((resolve) => {
    window.addEventListener('keydown', (e) => setTimeout(() => resolve(e.defaultPrevented)), { once: true, capture: false });
    document.getElementById('plain-button')!.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyS', key: 's', ctrlKey: true, bubbles: true, cancelable: true }));
  }));
  expect(saved).toBe(true);
  // Taken out, the key is nobody's.
  await page.evaluate(() => (window as any).offs[1]());
  await page.locator('#plain-button').focus();
  await page.keyboard.press('Control+s');
  expect((await ran()).length).toBe(4);
});

test('a shortcut for anywhere in the portal is not run for AltGr, nor while a dialog is open, nor for a key that was handled already; the ones for voice mode are not run here; Settings lists both apart', async ({ page }) => {
  await open(page, undefined, { settings: true });
  await page.evaluate(() => {
    const portal = (window as any).probe;
    (window as any).ran = 0;
    (window as any).voiceRan = 0;
    portal.shortcuts.register({ id: 'comment', label: 'Comment here', scope: 'app', default: { code: 'KeyM', ctrl: true, alt: true }, run: () => { (window as any).ran++; } });
    portal.shortcuts.register({ id: 'tell', label: 'Tell it', scope: 'voice', default: { code: 'KeyT' }, run: () => { (window as any).voiceRan++; } });
    document.body.insertAdjacentHTML('beforeend', '<button id="b">b</button>');
  });
  const press = (code: string, init: KeyboardEventInit = {}) => page.evaluate(([code, init]) => {
    document.getElementById('b')!.dispatchEvent(new KeyboardEvent('keydown', { code: code as string, key: (code as string).slice(3).toLowerCase(), bubbles: true, cancelable: true, ...(init as object) }));
    return (window as any).ran as number;
  }, [code, init] as const);
  expect(await press('KeyM', { ctrlKey: true, altKey: true })).toBe(1);

  // AltGr is reported as Ctrl+Alt on Windows, and types a character on some layouts: not a shortcut.
  expect(await page.evaluate(() => {
    const e = new KeyboardEvent('keydown', { code: 'KeyM', key: 'µ', ctrlKey: true, altKey: true, bubbles: true, cancelable: true });
    e.getModifierState = (key: string) => key === 'AltGraph';
    document.getElementById('b')!.dispatchEvent(e);
    return (window as any).ran;
  })).toBe(1);

  // A browser that does not name AltGr types a character instead, which a letter key does not: µ, @.
  expect(await page.evaluate(() => {
    for (const key of ['µ', '@', '€']) document.getElementById('b')!.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyM', key, ctrlKey: true, altKey: true, bubbles: true, cancelable: true }));
    return (window as any).ran;
  })).toBe(1);
  // The letter of another layout (Dvorak types o where the key is S) is a letter: the physical key is the shortcut.
  expect(await press('KeyM', { ctrlKey: true, altKey: true, key: 'o' })).toBe(2);

  // A dialog has the keys while it is open.
  await page.evaluate(() => document.body.insertAdjacentHTML('beforeend', '<div aria-modal="true" id="dialog"></div>'));
  expect(await press('KeyM', { ctrlKey: true, altKey: true })).toBe(2);
  await page.evaluate(() => document.getElementById('dialog')!.remove());
  expect(await press('KeyM', { ctrlKey: true, altKey: true })).toBe(3);

  // A part of the page that handled the key has it.
  await page.evaluate(() => document.getElementById('b')!.addEventListener('keydown', (e) => e.preventDefault(), { once: true }));
  expect(await press('KeyM', { ctrlKey: true, altKey: true })).toBe(3);

  // Voice mode's own are for voice mode.
  await press('KeyT');
  expect(await page.evaluate(() => (window as any).voiceRan)).toBe(0);

  // Settings lists the two apart.
  await page.evaluate(() => (window as any).probe.navigate('/settings/shortcuts'));
  await expect(page.getByRole('heading', { name: 'Anywhere in the portal' })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Portal shortcuts' }).getByRole('listitem')).toHaveCount(1);
  await expect(page.getByRole('listitem', { name: 'Comment here' })).toContainText('probe');
  await expect(page.getByRole('list', { name: 'Voice mode shortcuts' }).getByRole('listitem', { name: 'Tell it' })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Voice mode shortcuts' }).getByRole('listitem', { name: 'Comment here' })).toHaveCount(0);
});

test('a press in the list of a select, or in the question confirm asks, is in an overlay of the portal\'s, and one elsewhere is not', async ({ page }) => {
  await open(page);
  const answers = await page.evaluate(() => {
    document.body.insertAdjacentHTML('beforeend', '<div data-popover-layer role="listbox"><span id="in-list">a</span></div><div role="alertdialog"><b id="in-question">b</b></div><div role="dialog"><i id="in-dialog">c</i></div><p id="elsewhere">d</p>');
    const { ui } = (window as any).probe;
    const at = (id: string) => ui.inOverlay(document.getElementById(id));
    return { list: at('in-list'), question: at('in-question'), dialog: at('in-dialog'), elsewhere: at('elsewhere'), none: ui.inOverlay(null), window: ui.inOverlay(window) };
  });
  expect(answers).toEqual({ list: true, question: true, dialog: false, elsewhere: false, none: false, window: false });
});
