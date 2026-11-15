import { test, expect } from './portal-mock';

/**
 * What an extension is told of the data contract (docs/guide/data-contract.md), and the `pithagoras.api` it names: a
 * portal whose contract is not one of the versions it needs does not load it, and says why where an extension that
 * failed is said. The page is `core/web/tests/contract.tsx`; the extensions are tests/fixtures/extensions/contract
 * (`^1.0`) and contract-new (`^2.0`).
 */
test.use({ installed: ['tests/fixtures/extensions/contract', 'tests/fixtures/extensions/contract-new'] });

test.beforeEach(async ({ page }) => {
  await page.route('**/api/people', (route) => route.fulfill({ json: { people: [{ id: 'p1', name: 'Ada', role: 'primary' }] } }));
});

test('an extension that needs a newer interface API than the portal has is not loaded, and the page says why, with both numbers', async ({ page }) => {
  await page.goto('/tests/contract.html');
  await expect(page.getByTestId('failures')).toContainText('test-contract-new: Needs interface API ^2.0; this portal has 1.0.0');
  // The one written for what the portal has is loaded: nothing said of it, and the other's module was never imported.
  await expect(page.getByTestId('failures')).not.toContainText('test-contract:');
  await expect.poll(() => page.evaluate(() => (window as any).contractSeen !== undefined)).toBe(true);
  expect(await page.evaluate(() => [(window as any).contractNewLoaded, (window as any).contractNewCalled])).toEqual([undefined, undefined]);
});

test('an extension is handed the contract: its version and features, every member, and the addresses of a chat\'s files', async ({ page }) => {
  await page.goto('/tests/contract.html');
  await expect.poll(() => page.evaluate(() => (window as any).contractSeen !== undefined)).toBe(true);
  const seen = await page.evaluate(() => (window as any).contractSeen);
  // The portal's own number is what it was, and the contract has one of its own.
  expect(seen.version).toBe(1);
  expect(seen.api).toBe('1.0.0');
  expect(seen.features).toEqual(['data.sessions', 'data.chats', 'data.composer', 'data.models', 'data.settings', 'data.me', 'data.status', 'data.prefs', 'data.env', 'data.media']);
  expect(seen.has).toEqual({ sessions: true, media: true, unknown: false });
  expect(seen.members).toEqual({ sessions: 'object', composer: 'object', models: 'object', settings: 'object', me: 'object', status: 'object', prefs: 'object', env: 'object', media: 'object' });
  expect(seen.controller).toBe('function');
  // Shared with every other extension and the page: one cannot change what `has` says, or the question before a delete.
  expect(seen.changes).toEqual({ features: 'refused', api: 'refused', controller: 'refused' });
  expect(seen.image).toBe('/api/sessions/c1/images/a%20b.png');
  expect(seen.picture).toBe('/api/sessions/c1/picture?path=x%2Fy.png&v=3');
});

test("its hooks read the portal's data, and what it keeps in this browser is under its own name", async ({ page }) => {
  await page.goto('/tests/contract.html');
  // Who is using the portal is asked once, by the first part that reads it; the list is the page's to ask for, not a part's.
  await expect(page.getByTestId('reader')).toContainText('Ada · roomy · desk · 0 chats');
  await page.getByRole('button', { name: 'Tighten' }).click();
  await expect(page.getByTestId('reader')).toContainText('tight');
  expect(await page.evaluate(() => localStorage.getItem('ui.test-contract:density'))).toBe('tight');
  await page.getByRole('button', { name: 'Forget' }).click();
  await expect(page.getByTestId('reader')).toContainText('roomy');
  expect(await page.evaluate(() => localStorage.getItem('ui.test-contract:density'))).toBeNull();
  await page.setViewportSize({ width: 500, height: 800 });
  await expect(page.getByTestId('reader')).toContainText('phone');
});

test('a part drawn after the portal did not answer asks again, and shows what it answers then', async ({ page }) => {
  let down = true;
  await page.route('**/api/people', (route) => (down ? route.fulfill({ status: 503, json: { error: 'down' } }) : route.fulfill({ json: { people: [{ id: 'p1', name: 'Ada', role: 'primary' }] } })));
  await page.goto('/tests/contract.html');
  await expect(page.getByTestId('reader')).toContainText('Owner · roomy');
  await expect(page.getByTestId('reader')).toContainText('offline');
  down = false;
  await page.getByRole('button', { name: 'Hide the reader' }).click();
  await page.getByRole('button', { name: 'Show the reader' }).click();
  await expect(page.getByTestId('reader')).toContainText('Ada · roomy');
  await expect(page.getByTestId('reader')).toContainText('ready');
});
