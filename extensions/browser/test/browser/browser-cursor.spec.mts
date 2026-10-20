import { test, expect } from '../../../../tests/browser/portal-mock';
import { BASE, browserState, withBrowser } from './state';

test.use({ installed: ['extensions/docker', 'extensions/browser'] });

/**
 * The Browser page's switch for the agent's cursor: it says what the server half says, and a press asks it for the
 * other state and nothing else. Over canned answers; `calls` is every request that changes something.
 */
test('the cursor switch shows what the server half says and a press asks for the other state', async ({ page }) => {
  const calls: string[] = [];
  let cursor = true;
  await withBrowser(page, () => browserState({ cursor }), ({ path, method, json }) => {
    if (path === `${BASE}/cursor` && method === 'PUT') {
      const { on } = json<{ on: boolean }>();
      calls.push(`PUT /cursor ${on}`);
      cursor = on;
      return { cursor };
    }
  });
  await page.goto('/x/pithagoras-browser/browser');
  const toggle = page.getByRole('switch', { name: "Show the agent's cursor" });
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  expect(calls).toEqual(['PUT /cursor false']);
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  expect(calls).toEqual(['PUT /cursor false', 'PUT /cursor true']);
});
