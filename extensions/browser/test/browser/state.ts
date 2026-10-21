import { type Page } from '@playwright/test';
import { mockPortal, type Answer, type Ask } from '../../../../tests/browser/portal-mock';

/** Where Browser's server half answers: its routes, under the address the portal gives the package. */
export const BASE = '/api/x/pithagoras-browser';

/** How the browser stands, as `GET /state` says it (see the server half's routes): installed nowhere, nothing set, unless a test says. */
export const browserState = (over: Record<string, unknown> = {}) => ({
  running: false,
  unprotected: false,
  connected: false,
  version: null,
  pages: [],
  uiPort: '3011',
  uiExposed: false,
  uiOutdated: false,
  cursor: true,
  install: { available: true, mode: 'docker', image: true, container: 'absent', pulling: { active: false, line: '' } },
  config: { user: 'agent', hasPassword: true },
  byDefault: true,
  chats: [],
  routines: [],
  ...over,
});

/** Settings lists Browser, and Docker, which it requires, as the portal has them installed. */
export const EXTENSIONS = [
  { spec: 'extensions/docker', name: 'pithagoras-docker', version: '1.0.0', settings: [] },
  { spec: 'extensions/browser', name: 'pithagoras-browser', version: '0.1.0', settings: [] },
];

/**
 * The portal with Browser installed, its server half answering `/state` with what `state()` says now, and Settings
 * listing it; `answer` first, for anything else a test asks.
 */
export async function withBrowser(page: Page, state: () => unknown, answer: (ask: Ask) => Answer | Promise<Answer> = () => undefined) {
  await mockPortal(page, async (ask) => {
    const got = await answer(ask);
    if (got !== undefined) return got;
    if (ask.method !== 'GET') return undefined;
    if (ask.path === `${BASE}/state`) return state();
    if (ask.path === '/api/extensions') return { settingsPath: '/a/settings.json', extensions: EXTENSIONS };
    return undefined;
  }, { settings: true });
}
