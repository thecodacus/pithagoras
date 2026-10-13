import { test, expect, mockPortal } from './portal-mock';

/**
 * The Browser page's switch for the agent's cursor: it says what the portal says, and a press asks the portal for the
 * other state and nothing else. Over canned answers; `calls` is every request that changes something.
 */
test('the cursor switch shows what the portal says and a press asks for the other state', async ({ page }) => {
  const calls: string[] = [];
  let cursor = true;
  await mockPortal(page, ({ path, method, json }) => {
    if (path === '/api/browser' && method === 'GET') {
      return {
        running: false, unprotected: false, connectedAs: null, version: null, pages: [], uiPort: '3011', uiExposed: false, uiOutdated: false, cursor, allowlist: '', configured: false, byDefault: true, sessions: [], routines: [],
        install: { available: true, mode: 'docker', image: false, container: 'absent', binary: '/usr/bin/chromium', pulling: { active: false, line: '' } },
        config: { user: 'abc', hasPassword: true },
      };
    }
    if (path === '/api/browser/cursor' && method === 'PUT') {
      const { on } = json<{ on: boolean }>();
      calls.push(`PUT ${path} ${on}`);
      cursor = on;
      return { cursor };
    }
  }, { settings: true });
  await page.goto('/browser');
  const toggle = page.getByRole('switch', { name: "Show the agent's cursor" });
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  expect(calls).toEqual(['PUT /api/browser/cursor false']);
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  expect(calls).toEqual(['PUT /api/browser/cursor false', 'PUT /api/browser/cursor true']);
});
