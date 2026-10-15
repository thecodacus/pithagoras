import { defineConfig } from '@playwright/test';
const origin = 'http://127.0.0.1:5191';
export default defineConfig({
  // The portal's own specs, and each extension's beside its code (extensions/<name>/test/browser).
  testDir: '.', testMatch: /\/(tests\/browser|extensions\/[^/]+\/test\/browser)\/[^/]+\.spec\.mts$/, timeout: 45000, workers: 1,
  use: {
    baseURL: origin, browserName: 'chromium', ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}), headless: true,
    // The portal's extra animations (core/web/src/motion.ts) are on until someone switches them off, and what leaves
    // does so as a picture of itself that lingers for a moment: no test should wait on that or find it by text. So every
    // page starts with them off, as the switch in Settings would leave it; the animation spec turns them on for itself.
    storageState: { cookies: [], origins: [{ origin, localStorage: [{ name: 'animations', value: 'off' }] }] },
  },
  // The dev server proxies /api to a portal. None may answer in a test: an /api call nothing mocked goes to a dead port
  // (and tests/browser/portal-mock.ts answers it first with a 501 that names it).
  // The extensions are built first: a fresh portal's (extensions/defaults.json) are in every page the specs open.
  webServer: { command: 'npm run build:extensions && npm run dev -w core/web -- --host 127.0.0.1 --port 5191 --strictPort', url: 'http://127.0.0.1:5191', reuseExistingServer: false, timeout: 180_000, env: { PITHAGORAS_API: 'http://127.0.0.1:1' } },
});
