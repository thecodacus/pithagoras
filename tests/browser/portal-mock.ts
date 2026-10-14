import { test as base, expect, type Page, type Route } from '@playwright/test';

/**
 * The portal with no server, which every browser spec imports `test` and `expect` from.
 *
 * `test` is Playwright's, with one addition: before a test starts, every `/api` request is answered 501 with its own
 * name, so a call that no test mocked fails where it is made, with the URL in the message. Nothing reaches the dev
 * server's proxy, and so no portal that runs on this machine. A test's own `page.route` is registered after it and
 * wins; what it does not answer falls back to this one.
 */
export const test = base.extend<{ unmocked: string[] }>({
  unmocked: [async ({ page }, use, testInfo) => {
    const asked: string[] = [];
    await page.route('**/api/**', (route) => {
      const { pathname, search } = new URL(route.request().url());
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

/**
 * What every portal says unless a test says otherwise: signed in without a password, no chats, and the three things the
 * shell asks of every page (the add-on flags, the browser add-on, the voice add-on, which extensions draw in it, the places for a new chat) and of
 * every chat (what runs in the background, what came before), with nothing set up.
 */
const portalBase = ({ path, method, url }: Ask): Answer => {
  if (method !== 'GET') return undefined;
  if (path === '/api/auth/status') return { authed: true, authRequired: false };
  if (path === '/api/sessions') return { sessions: [], executor: 'host' };
  if (path === '/api/features/flags') return { subagent: { enabled: false }, understory: { enabled: false }, images: { enabled: false } };
  if (path === '/api/browser') return {
    running: false, unprotected: false, connectedAs: null, install: { available: false, image: false, container: 'absent', pulling: { active: false, line: '' } },
    config: { user: '', hasPassword: false }, version: null, pages: [], uiPort: '', uiExposed: false, uiOutdated: false, cursor: true, allowlist: '', configured: false, byDefault: true, sessions: [], routines: [],
  };
  if (path === '/api/voice') return { enabled: false };
  if (path === '/api/extension-ui') return { extensions: [] };
  // A portal that is not run from a checkout: nothing to update, no notice.
  if (path === '/api/update') return { kind: 'none', boot: 'boot-a' };
  if (/^\/api\/sessions\/[^/]+\/background$/.test(path)) return { supported: true, jobs: [], statuses: [], widgets: [] };
  if (/^\/api\/sessions\/[^/]+\/events\/before$/.test(path)) return { events: [], more: false };
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
