import { type Page } from '@playwright/test';
import { test, expect, mockPortal, reply, DONE } from './portal-mock';

/**
 * A portal with a password: signed in once the right one is posted, signed out again when `expired` says so, and not answering while `down`.
 * `expireOnRename` forgets the browser at the rename's request and at no other: `expired` answers every request, and the page asks for
 * the list now and then by itself, so a test that sets it and then clicks has the page find out first on a slow machine.
 */
async function portal(page: Page, state: { authed: boolean; expired?: boolean; expireOnRename?: boolean; down?: boolean; setup?: boolean; removed?: boolean; sso?: { name: string; only: boolean } }) {
  const calls = { status: 0, login: [] as unknown[], setup: [] as unknown[], rename: 0, ssoStarts: [] as string[] };
  const session = { id: 's1', title: 'Old name', workspace: '/w/site', status: 'idle', kind: 'task', pinned: false, updated_at: new Date().toISOString() };
  await mockPortal(page, async ({ path: p, method, route, json, url }) => {
    // What a proxy answers while the portal behind it restarts: a page of its own, not JSON.
    if (state.down && p.startsWith('/api/auth/')) {
      if (p === '/api/auth/status') calls.status++;
      await route.fulfill({ status: 502, contentType: 'text/html', body: '<h1>Bad Gateway</h1>' });
      return DONE;
    }
    if (p === '/api/auth/status') { calls.status++; return { authRequired: true, authed: state.authed, ...(state.setup ? { setup: true } : {}), ...(state.sso ? { oidc: state.sso } : {}) }; }
    // The portal sends the browser on to the provider; here it is a page that says where the browser came.
    if (p === '/api/auth/oidc/start') {
      calls.ssoStarts.push(url.search);
      await route.fulfill({ status: 200, contentType: 'text/html', body: '<h1>At the provider</h1>' });
      return DONE;
    }
    if (p === '/api/auth/setup') {
      const body = json();
      calls.setup.push(body);
      if (body.password === 'change-me') return reply(400, { error: 'That is the example password, which everybody knows. Choose another.' });
      state.authed = true;
      state.setup = false;
      return { ok: true };
    }
    if (p === '/api/auth/login') {
      const body = json();
      calls.login.push(body);
      // The password was removed on the server while this page was open.
      if (state.removed) return reply(409, { error: 'No password has been chosen yet.', setup: true });
      if (body.password !== 'secret') return reply(401, { error: 'Wrong password' });
      state.authed = true;
      state.expired = false;
      return { ok: true };
    }
    if (p === '/api/sessions/s1' && method === 'PATCH' && state.expireOnRename) {
      state.expireOnRename = false;
      state.expired = true;
    }
    // The portal has forgotten this browser: what the server answers to a cookie it no longer takes.
    if (state.expired) return reply(401, { error: 'Unauthorized' });
    if (p === '/api/sessions' && method === 'GET') return { sessions: [session], executor: 'host' };
    if (p === '/api/sessions/s1' && method === 'PATCH') { calls.rename++; return session; }
    if (p === '/api/workspaces') return { root: '/w', workspaces: [] };
  });
  return calls;
}

test('without a login the page asks for the password, and the right one opens the portal', async ({ page }) => {
  const state = { authed: false };
  const calls = await portal(page, state);
  await page.goto('/sessions');
  const password = page.getByPlaceholder('Password');
  const signIn = page.getByRole('button', { name: 'Sign in' });
  await expect(password).toBeVisible();
  await expect(page.getByText('Old name')).toHaveCount(0);
  await expect(signIn).toBeDisabled();
  // No sign-in provider is set up, so there is no button for one.
  await expect(page.getByRole('link', { name: /Sign in with/ })).toHaveCount(0);

  await password.fill('secret');
  await signIn.click();
  // The password goes as the body's `password`, which is what the server reads.
  await expect.poll(() => calls.login).toEqual([{ password: 'secret' }]);
  await expect(page.getByRole('main').getByText('Old name')).toBeVisible();
  await expect(password).toHaveCount(0);
});

test('a wrong password is said so, and asked again without looping on the 401', async ({ page }) => {
  const calls = await portal(page, { authed: false });
  await page.goto('/sessions');
  await expect(page.getByPlaceholder('Password')).toBeVisible();
  const asked = calls.status;
  await page.getByPlaceholder('Password').fill('guess');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText('Wrong password')).toBeVisible();
  await expect(page.getByPlaceholder('Password')).toBeVisible();
  // Settled: the refusal of the login itself is not the portal forgetting a login, which would ask the server again.
  await page.waitForTimeout(500);
  expect(calls.login).toEqual([{ password: 'guess' }]);
  expect(calls.status).toBe(asked);
});

test('a login that runs out in the middle of the work returns to the form, and signing in again goes on', async ({ page }) => {
  const state = { authed: true, expired: false, expireOnRename: true };
  const calls = await portal(page, state);
  await page.goto('/sessions');
  await expect(page.getByRole('main').getByText('Old name')).toBeVisible();

  // The login runs out as the rename is sent (see `expireOnRename`).
  await page.getByRole('button', { name: 'Rename Old name' }).click();
  const field = page.getByLabel('Session name');
  await field.fill('New name');
  await field.press('Enter');
  await expect(page.getByPlaceholder('Password')).toBeVisible();
  await expect(page.getByText(/HTTP 401|Unauthorized/)).toHaveCount(0);

  await page.getByPlaceholder('Password').fill('secret');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('main').getByText('Old name')).toBeVisible();
  expect(calls.login).toEqual([{ password: 'secret' }]);
});

test('a portal that does not answer is not taken for a login that is gone, and is asked again', async ({ page }) => {
  const state = { authed: true, down: true };
  const calls = await portal(page, state);
  await page.goto('/sessions');
  await expect(page.getByText('Cannot reach the portal')).toBeVisible();
  await expect(page.getByPlaceholder('Password')).toHaveCount(0);
  const asked = calls.status;
  // Asking again by hand, while it is still away.
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect.poll(() => calls.status).toBeGreaterThan(asked);
  await expect(page.getByText('Cannot reach the portal')).toBeVisible();
  // Back: the page does not wait to be told, and the login the browser holds is still good.
  state.down = false;
  await expect(page.getByRole('main').getByText('Old name')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByPlaceholder('Password')).toHaveCount(0);
  expect(calls.login).toEqual([]);
});

test('a password sent while the portal is away says that, not the proxy\'s status', async ({ page }) => {
  const state = { authed: false, down: false };
  const calls = await portal(page, state);
  await page.goto('/sessions');
  await expect(page.getByPlaceholder('Password')).toBeVisible();
  state.down = true;
  await page.getByPlaceholder('Password').fill('secret');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText('Cannot reach the portal')).toBeVisible();
  await expect(page.getByText(/HTTP 502/)).toHaveCount(0);
  // Still the form: nothing was refused.
  await expect(page.getByPlaceholder('Password')).toBeVisible();
  expect(calls.login).toEqual([]);
});

test('a portal with no password asks for one, twice, and the one chosen opens the portal', async ({ page }) => {
  const state = { authed: false, setup: true };
  const calls = await portal(page, state);
  await page.goto('/sessions');
  const password = page.getByPlaceholder('New password');
  const repeat = page.getByPlaceholder('Repeat the password');
  const set = page.getByRole('button', { name: 'Set password' });
  await expect(page.getByText('Choose a password')).toBeVisible();
  await expect(page.getByPlaceholder('Password', { exact: true })).toHaveCount(0);
  await expect(set).toBeDisabled();

  // Told in the page, before anything is sent: too short, and two different ones.
  await password.fill('short');
  await repeat.fill('short');
  await set.click();
  await expect(page.getByRole('alert')).toHaveText('The password has to be at least 8 characters.');
  await password.fill('a first password');
  await repeat.fill('a first passwore');
  await set.click();
  await expect(page.getByRole('alert')).toHaveText('The two passwords are not the same.');
  expect(calls.setup).toEqual([]);

  // What the server refuses is shown as it says it, and the form stays.
  await password.fill('change-me');
  await repeat.fill('change-me');
  await set.click();
  await expect(page.getByRole('alert')).toContainText('example password');
  await expect(password).toBeVisible();

  await password.fill('a first password');
  await repeat.fill('a first password');
  await set.click();
  // Only the password goes: the second field is for the person.
  await expect.poll(() => calls.setup).toEqual([{ password: 'change-me' }, { password: 'a first password' }]);
  await expect(page.getByRole('main').getByText('Old name')).toBeVisible();
  await expect(password).toHaveCount(0);
  expect(calls.login).toEqual([]);
});

test('a password removed on the server while the sign-in page is open turns it into the page that asks for a new one', async ({ page }) => {
  const state = { authed: false, removed: true };
  const calls = await portal(page, state);
  await page.goto('/sessions');
  await page.getByPlaceholder('Password').fill('secret');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText('Choose a password')).toBeVisible();
  await expect(page.getByText('No password has been chosen yet.')).toHaveCount(0);
  expect(calls.login).toEqual([{ password: 'secret' }]);
});

test('with a sign-in provider the page offers its button beside the password, and the button starts there from this page', async ({ page }) => {
  const calls = await portal(page, { authed: false, sso: { name: 'Example ID', only: false } });
  await page.goto('/sessions?tab=files');
  const button = page.getByRole('link', { name: 'Sign in with Example ID' });
  await expect(button).toBeVisible();
  await expect(page.getByPlaceholder('Password')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  await button.click();
  await expect(page.getByRole('heading', { name: 'At the provider' })).toBeVisible();
  // Back to the page it was on: the server checks the path is the portal's own.
  expect(calls.ssoStarts).toEqual([`?returnTo=${encodeURIComponent('/sessions?tab=files')}`]);
  expect(calls.login).toEqual([]);
});

test('with OIDC only, the page has no password form, only the provider\'s button', async ({ page }) => {
  await portal(page, { authed: false, sso: { name: 'Example ID', only: true } });
  await page.goto('/sessions');
  await expect(page.getByRole('link', { name: 'Sign in with Example ID' })).toBeVisible();
  await expect(page.getByPlaceholder('Password')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Sign in' })).toHaveCount(0);
  await expect(page.getByText('or with the password')).toHaveCount(0);
});
