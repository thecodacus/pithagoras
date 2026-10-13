import { type Page } from '@playwright/test';
import { test, expect, mockPortal, reply } from './portal-mock';

/** Settings → Authentication, its single sign-on, over canned answers: what it is shown, and what it saves. */
async function portal(page: Page, { kept = null as any, only = false, mode = 'password', refuse = '' } = {}) {
  const saves: any[] = [];
  await mockPortal(page, ({ path: p, method, json }) => {
    if (p === '/api/auth/status') return { authed: true, authRequired: mode !== 'open' };
    if (p === '/api/auth/sso' && method === 'GET') return { mode, callbackPath: '/api/auth/oidc/callback', settings: kept, only };
    if (p === '/api/auth/sso' && method === 'PUT') {
      const sent = json();
      saves.push(sent);
      if (sent.current !== 'the current one') return reply(403, { error: 'The current password is wrong.' });
      if (refuse) return reply(400, { error: refuse });
      if (sent.settings === null) return { settings: null, only: false };
      const { clientSecret, ...rest } = sent.settings;
      return { settings: { ...rest, hasSecret: clientSecret === undefined ? Boolean(kept?.hasSecret) : Boolean(clientSecret) }, only: sent.only };
    }
  }, { settings: true });
  await page.addInitScript(() => localStorage.setItem('pithagoras.setup', 'done'));
  return saves;
}

/** Settings → Authentication, with its single sign-on section opened (it is closed at first): the section, beside the password's. */
async function openSso(page: Page) {
  await page.goto('/settings/authentication');
  const section = page.getByRole('dialog').getByRole('region', { name: 'Single sign-on' });
  await section.getByRole('button', { name: /^Single sign-on/ }).click();
  return section;
}

const KEPT = {
  issuer: 'https://id.example.test/realms/home', clientId: 'portal', hasSecret: true,
  redirectUrl: 'https://portal.example.test/api/auth/oidc/callback', scopes: 'openid email profile', name: 'Example ID',
  endSession: false,
};

test('a first setup starts from this address, sends what the provider needs and no list of who may sign in, and asks for the current password', async ({ page }) => {
  const saves = await portal(page);
  const dialog = await openSso(page);
  const redirect = dialog.getByLabel('Redirect URL');
  await expect(redirect).toHaveValue(new RegExp(`^${new URL(page.url()).origin.replace(/[.]/g, '\\.')}/api/auth/oidc/callback$`));
  await redirect.fill('https://portal.example.test/api/auth/oidc/callback');
  await dialog.getByLabel('Issuer URL').fill('https://id.example.test/realms/home');
  await dialog.getByLabel('Client ID').fill('portal');
  await dialog.getByLabel('Client secret').fill('a client secret');
  // Who may sign in is the provider's to say: the page has no list of its own.
  await expect(dialog.getByText('Who may sign in')).toHaveCount(0);
  await expect(dialog.getByLabel('Emails')).toHaveCount(0);
  await expect(dialog.getByLabel('Subjects')).toHaveCount(0);
  // ...and it says so where the provider is set up, without inviting a provider that signs in anybody.
  await expect(dialog.getByText(/every account the provider signs in gets in, so limit the client to your people at the provider/)).toBeVisible();
  await expect(dialog.getByText(/such as Authentik, Keycloak or Entra ID, beside/)).toBeVisible();
  const save = dialog.getByRole('button', { name: 'Save', exact: true });
  await expect(save).toBeDisabled();
  await dialog.getByRole('switch', { name: 'OIDC only' }).click();
  await expect(dialog.getByText('Make sure you can sign in through the provider first.')).toBeVisible();
  await dialog.getByLabel('Current password').fill('the current one');
  await save.click();
  await expect(dialog.getByRole('status')).toHaveText('Saved.');
  expect(saves).toHaveLength(1);
  expect(saves[0]).toEqual({
    current: 'the current one',
    only: true,
    settings: {
      issuer: 'https://id.example.test/realms/home', clientId: 'portal', clientSecret: 'a client secret',
      redirectUrl: 'https://portal.example.test/api/auth/oidc/callback', scopes: '', name: '', endSession: false,
    },
  });
  // The password field is cleared, and the secret is now one that is kept.
  await expect(dialog.getByLabel('Current password')).toHaveValue('');
  await expect(dialog.getByText('A secret is kept. Leave this empty to keep it.')).toBeVisible();
});

test('kept settings are shown without the secret, saved again without one, and a refusal is said', async ({ page }) => {
  const saves = await portal(page, { kept: KEPT });
  const dialog = await openSso(page);
  await expect(dialog.getByLabel('Issuer URL')).toHaveValue(KEPT.issuer);
  await expect(dialog.getByLabel('Client secret')).toHaveValue('');
  await expect(dialog.getByText('A secret is kept. Leave this empty to keep it.')).toBeVisible();

  await dialog.getByLabel('Current password').fill('not it');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog.getByRole('alert')).toHaveText('The current password is wrong.');

  await dialog.getByLabel('Current password').fill('the current one');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog.getByRole('status')).toHaveText('Saved.');
  expect('clientSecret' in saves[1].settings).toBe(false);

  // Taken away on purpose, for a public client.
  await dialog.getByLabel('Remove the kept secret (a public client)').check();
  await dialog.getByLabel('Current password').fill('the current one');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog.getByRole('status')).toHaveText('Saved.');
  expect(saves[2].settings.clientSecret).toBeNull();
});

test('the hint about the kept secret changes once the issuer or client is another', async ({ page }) => {
  await portal(page, { kept: KEPT });
  const dialog = await openSso(page);
  await expect(dialog.getByText('A secret is kept. Leave this empty to keep it.')).toBeVisible();
  await dialog.getByLabel('Issuer URL').fill('https://id.example.test/realms/other');
  await expect(dialog.getByText('The issuer or the client ID changed: type the client secret again, or remove it for a public client.')).toBeVisible();
  await dialog.getByLabel('Issuer URL').fill(KEPT.issuer);
  await expect(dialog.getByText('A secret is kept. Leave this empty to keep it.')).toBeVisible();
  await dialog.getByLabel('Client ID').fill('another');
  await expect(dialog.getByText(/The issuer or the client ID changed/)).toBeVisible();
});

test('what the server refuses is said in its words, and taking single sign-on out asks first', async ({ page }) => {
  const saves = await portal(page, { kept: KEPT, refuse: 'The provider does not offer PKCE with S256' });
  const dialog = await openSso(page);
  await dialog.getByLabel('Current password').fill('the current one');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog.getByRole('alert')).toHaveText('The provider does not offer PKCE with S256');

  await dialog.getByRole('button', { name: 'Take out single sign-on' }).click();
  const ask = page.getByRole('alertdialog');
  await expect(ask).toContainText('Take out single sign-on?');
  await ask.getByRole('button', { name: 'Cancel' }).click();
  expect(saves).toHaveLength(1);
});

test('taking single sign-on out sends no settings, and the form starts again empty', async ({ page }) => {
  const saves = await portal(page, { kept: KEPT, only: true });
  const dialog = await openSso(page);
  await expect(dialog.getByRole('switch', { name: 'OIDC only' })).toBeChecked();
  await dialog.getByLabel('Current password').fill('the current one');
  await dialog.getByRole('button', { name: 'Take out single sign-on' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Take it out' }).click();
  await expect(dialog.getByRole('status')).toHaveText('Single sign-on is taken out.');
  expect(saves).toEqual([{ current: 'the current one', settings: null, only: false }]);
  await expect(dialog.getByLabel('Issuer URL')).toHaveValue('');
  await expect(dialog.getByRole('switch', { name: 'OIDC only' })).not.toBeChecked();
});

test('a portal with no login has nothing to set up: no password, and no single sign-on section', async ({ page }) => {
  await portal(page, { mode: 'open' });
  await page.goto('/settings/authentication');
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText(/no password to change and no single sign-on to set up here/)).toBeVisible();
  await expect(dialog.getByRole('button', { name: /^Single sign-on/ })).toHaveCount(0);
  await expect(dialog.getByLabel('Issuer URL')).toHaveCount(0);
});

test('the password and single sign-on share the Authentication tab: the password open, single sign-on closed and saying it is off', async ({ page }) => {
  await portal(page);
  await page.goto('/settings/authentication');
  const dialog = page.getByRole('dialog');
  const rail = dialog.getByRole('navigation');
  await expect(rail.getByRole('button', { name: 'Authentication' }).or(rail.getByRole('link', { name: 'Authentication' })).first()).toBeVisible();
  await expect(rail.getByText('Password', { exact: true })).toHaveCount(0);
  await expect(rail.getByText('Single sign-on', { exact: true })).toHaveCount(0);
  await expect(dialog.getByLabel(/^New password/)).toBeVisible();
  const sso = dialog.getByRole('button', { name: /^Single sign-on/ });
  await expect(sso).toHaveAttribute('aria-expanded', 'false');
  await expect(sso).toContainText('Off');
  await expect(dialog.getByLabel('Issuer URL')).toBeHidden();
  await sso.click();
  await expect(sso).toHaveAttribute('aria-expanded', 'true');
  await expect(dialog.getByLabel('Issuer URL')).toBeVisible();
  await expect(sso).toContainText('Signing in through an OpenID Connect provider');
});

test('closed, single sign-on says which provider it uses and whether it is the only way in', async ({ page }) => {
  await portal(page, { kept: KEPT, only: true });
  await page.goto('/settings/authentication');
  const sso = page.getByRole('dialog').getByRole('button', { name: /^Single sign-on/ });
  await expect(sso).toContainText('Example ID · OIDC only');
  await expect(sso).toHaveAttribute('aria-expanded', 'false');
});

test('the old addresses of the two pages open the Authentication tab', async ({ page }) => {
  await portal(page);
  for (const old of ['/settings/password', '/settings/sso']) {
    await page.goto(old);
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByLabel(/^New password/)).toBeVisible();
    await expect(dialog.getByRole('button', { name: /^Single sign-on/ })).toBeVisible();
  }
});

test('a search for single sign-on opens the tab and its closed section, and one for the password finds it there too', async ({ page }) => {
  await portal(page);
  await page.goto('/settings/general');
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await dialog.getByLabel('Search settings').fill('oidc only');
  await expect(dialog.getByRole('option').first()).toContainText('OIDC only');
  await dialog.getByLabel('Search settings').press('Enter');
  await expect(dialog.getByRole('button', { name: /^Single sign-on/ })).toHaveAttribute('aria-expanded', 'true');
  await expect(dialog.getByRole('region', { name: 'Single sign-on' })).toBeInViewport();
  await expect(dialog.getByRole('switch', { name: 'OIDC only' })).toBeVisible();

  await dialog.getByLabel('Search settings').fill('keycloak');
  await expect(dialog.getByRole('option').first()).toContainText('Single sign-on');
  await dialog.getByLabel('Search settings').fill('passwort');
  await expect(dialog.getByRole('option').first()).toContainText('Change password');
  await dialog.getByLabel('Search settings').press('Enter');
  await expect(dialog.getByLabel('Current password').first()).toBeVisible();
});
