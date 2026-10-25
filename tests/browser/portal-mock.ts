import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test as base, expect, type Page, type Route } from '@playwright/test';

/**
 * The portal with no server, which every browser spec imports `test` and `expect` from.
 *
 * `test` is Playwright's, with one addition: before a test starts, every `/api` request is answered 501 with its own
 * name, so a call that no test mocked fails where it is made, with the URL in the message. Nothing reaches the dev
 * server's proxy, and so no portal that runs on this machine. The extensions the portal has installed are the
 * exception: they are listed and their files served, for the app and for a fixture page that loads them as the app
 * does. So is the lease every voice session takes as it starts and gives back at its end (`…/voice/connection`),
 * which is granted. A test's own `page.route` is registered after it and wins; what it does not answer falls back to
 * this one.
 *
 * `installed` is those extensions, by their folders from the repository's root, and is none unless a spec says:
 * `test.use({ installed: ['extensions/git'] })`. The portal's own specs install a stand-in where they need an
 * extension's panel or window (tests/fixtures/extensions/console), so that none of them needs one the portal
 * ships, which can be removed.
 */
export const test = base.extend<{ unmocked: string[]; installed: string[] }>({
  installed: [[], { option: true }],
  unmocked: [async ({ page, installed }, use, testInfo) => {
    const asked: string[] = [];
    const extensions = installed.map((folder) => extensionOnDisk(path.join(ROOT, folder)));
    await page.route('**/api/**', async (route) => {
      const { pathname, search } = new URL(route.request().url());
      if (route.request().method() === 'GET') {
        if (pathname === '/api/extension-ui') return route.fulfill({ json: { extensions: extensions.map((ext) => ext.listing) } });
        for (const ext of extensions) if (await ext.serve(pathname, route)) return;
      }
      if (route.request().method() === 'POST' && /^\/api\/sessions\/[^/]+\/voice\/connection$/.test(pathname)) return route.fulfill({ json: { ok: true } });
      const what = `${route.request().method()} ${pathname}${search}`;
      asked.push(what);
      return route.fulfill({ status: 501, json: { error: `Not mocked: ${what}` } });
    });
    await use(asked);
    // To see what a spec leaves to this: SHOW_UNMOCKED=1 npx playwright test <spec>
    if (process.env.SHOW_UNMOCKED && asked.length) console.log(`unmocked in "${testInfo.title}":\n  ${[...new Set(asked)].join('\n  ')}`);
  }, { auto: true }],
});
export { expect };

/** What `answer` is asked: the request, and the route for a reply that is more than a body. */
export interface Ask {
  path: string;
  method: string;
  url: URL;
  route: Route;
  /** The JSON the request sent. */
  json: <T = any>() => T;
}

class Reply { constructor(readonly status: number, readonly body: unknown) {} }
/** An answer with a status, where a plain value is a 200. */
export const reply = (status: number, body: unknown = {}) => new Reply(status, body);
/** An answer that never comes, as from a portal that has stopped answering. */
export const HANG = Symbol('never answered');
/** For `answer` to say it has answered the route itself (`route.fulfill`, `route.abort`). */
export const DONE = Symbol('answered by the test');

export type Answer = unknown | Reply | typeof HANG | typeof DONE;

// This file is loaded as CommonJS (it is .ts, and the repository is not a module): its own folder is __dirname.
const ROOT = path.resolve(__dirname, '../..');

const TYPES: Record<string, string> = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };

/**
 * An extension's package on disk, as the portal lists it (`/api/extension-ui`)
 * and serves the folder of its browser half: built, where it has a build.
 * `serve` answers a request for one of its files, and says whether it did.
 */
export function extensionOnDisk(dir: string) {
  const meta = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
  const declared = meta.pithagoras ?? {};
  const client = typeof declared.client === 'string' ? path.resolve(dir, declared.client) : undefined;
  const served = client && path.dirname(client);
  const prefix = `/api/extension-ui/${String(meta.name).split('/').map(encodeURIComponent).join('/')}/`;
  const listing = {
    name: meta.name,
    version: meta.version,
    ...(Array.isArray(declared.themes) ? { themes: declared.themes } : {}),
    ...(client ? { rev: 'test', entry: `${prefix}${path.basename(client)}?v=test` } : {}),
    ...(client && typeof declared.style === 'string' ? { style: `${prefix}${path.relative(served!, path.resolve(dir, declared.style)).split(path.sep).join('/')}?v=test` } : {}),
    ...(typeof declared.server === 'string' ? { server: `/api/x/${meta.name}` } : {}),
  };
  const serve = async (urlPath: string, route: Route): Promise<boolean> => {
    if (!served || !urlPath.startsWith(prefix)) return false;
    const file = path.resolve(served, decodeURIComponent(urlPath.slice(prefix.length)));
    if (!file.startsWith(served + path.sep) || !existsSync(file)) return false;
    await route.fulfill({ path: file, contentType: TYPES[path.extname(file)] ?? 'application/octet-stream' });
    return true;
  };
  return { name: meta.name as string, listing, serve };
}


/**
 * What every portal says unless a test says otherwise: signed in without a password, no chats, and the things the
 * shell asks of every page (the feature flags, voice mode with no source, which extensions draw in it, the places for a new
 * chat) and of every chat (what runs in the background, what came before, the modes it may be put in), with nothing set up.
 */
const portalBase = ({ path, method, url }: Ask): Answer => {
  if (method !== 'GET') return undefined;
  if (path === '/api/auth/status') return { authed: true, authRequired: false };
  if (path === '/api/sessions') return { sessions: [], executor: 'host' };
  if (path === '/api/features/flags') return { memory: { held: false, by: null } };
  if (path === '/api/voice') return { provider: '', ready: false, speech: true, voices: [], enabled: false };
  // A portal that is not run from a checkout: nothing to update, no notice.
  if (path === '/api/update') return { kind: 'none', boot: 'boot-a' };
  if (/^\/api\/sessions\/[^/]+\/background$/.test(path)) return { supported: true, jobs: [], statuses: [], widgets: [] };
  if (/^\/api\/sessions\/[^/]+\/events\/before$/.test(path)) return { events: [], more: false };
  // No modes to choose from: a chat draws no picker unless a test offers some.
  if (/^\/api\/sessions\/[^/]+\/modes$/.test(path)) return { modes: [] };
  if (path === '/api/projects' && url.searchParams.has('bare')) return { root: '/w', home: '/h', projects: [] };
  return undefined;
};

/** What Settings asks when it opens, with nothing configured: for a test of one page in it that has no use for the rest. */
const settingsBase = ({ path, method }: Ask): Answer => {
  if (method !== 'GET') return undefined;
  const defaults = { provider: 'llama-swap', model: 'model-a', thinkingLevel: 'medium' };
  if (path === '/api/settings') return {
    settings: defaults, stored: {}, defaults, piSettingsPath: '/a/settings.json', compaction: { keepRecentTokens: 20000 }, compactionDefaults: { keepRecentTokens: 20000 },
    contextDefault: null, executor: 'host', workspaceRoot: '/w',
  };
  if (path === '/api/models') return { models: [], providers: {} };
  if (path === '/api/providers') return { presets: [], apis: ['openai-completions'], hosted: [], providers: [] };
  if (path === '/api/routines/report-targets') return { targets: [], default: null };
  if (path === '/api/extensions') return { settingsPath: '/a/settings.json', extensions: [] };
  if (path === '/api/extensions/shipped') return { extensions: [] };
  // What installing a package brings with it, asked before it is installed: nothing else.
  if (path === '/api/extensions/plan') return { needs: [] };
  if (path === '/api/tool-names') return { names: {} };
  if (path === '/api/packages/catalog') return { packages: [] };
  if (path === '/api/workspaces') return { root: '/w', workspaces: [] };
  // About asks whether the portal can restart itself.
  if (path === '/api/restart') return { possible: true, by: 'systemd', running: 0, loaded: [], keepsLogins: true };
  return undefined;
};

export interface PortalOptions {
  /**
   * The page's event streams: `idle` ones that never say anything (the default), `open` ones that open and are kept
   * in `window.streams`, each with `emit(name, data)` for what the server would send, `pending` ones that are kept
   * the same and never open, as when the browser has no connection to give them, or `none` where the test brings its own.
   */
  streams?: 'idle' | 'open' | 'pending' | 'none';
  /** What the setup assistant is told: `done` (the default) keeps it away, `skipped` is a portal with no model, `fresh` a browser that has been told nothing. */
  setup?: 'done' | 'skipped' | 'fresh';
  /** Answers what Settings asks when it opens (`settingsBase`), for a test of a page in it. */
  settings?: boolean;
}

/**
 * Answers the page's `/api` calls: what `answer` returns is the JSON of a 200 (`reply(status, body)` for another
 * status, `HANG` for none), `undefined` leaves it to the base (sign-in and an empty chat list) and then to the 501
 * of `test`. The page starts with the setup assistant out of the way and no stream open.
 */
export async function mockPortal(page: Page, answer: (ask: Ask) => Answer | Promise<Answer> = () => undefined, { streams = 'idle', setup = 'done', settings = false }: PortalOptions = {}) {
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const ask: Ask = { path: url.pathname, method: request.method(), url, route, json: () => request.postDataJSON() };
    let got = await answer(ask);
    if (got === undefined && settings) got = settingsBase(ask);
    if (got === undefined) got = portalBase(ask);
    if (got === undefined) return route.fallback();
    if (got === HANG || got === DONE) return;
    if (got instanceof Reply) return route.fulfill({ status: got.status, json: got.body });
    return route.fulfill({ json: got });
  });
  await page.addInitScript(({ streams, setup }) => {
    if (setup !== 'fresh') localStorage.setItem('pithagoras.setup', setup);
    if (streams === 'none') return;
    if (streams === 'idle') {
      (window as any).EventSource = class { onmessage: any; onopen: any; onerror: any; addEventListener() {} close() {} };
      return;
    }
    const open: any[] = ((window as any).streams = []);
    (window as any).EventSource = class {
      url: string; closed = false; onmessage: any; onopen: any; onerror: any;
      listeners: Record<string, ((e: any) => void)[]> = {};
      constructor(url: string) { this.url = url; open.push(this); if (streams === 'open') setTimeout(() => this.onopen?.(), 0); }
      addEventListener(name: string, fn: (e: any) => void) { (this.listeners[name] ??= []).push(fn); }
      close() { this.closed = true; }
      emit(name: string, data: unknown) {
        const e = { data: JSON.stringify(data) };
        if (name === 'message') this.onmessage?.(e);
        else (this.listeners[name] ?? []).forEach((fn) => fn(e));
      }
    };
  }, { streams, setup });
}
