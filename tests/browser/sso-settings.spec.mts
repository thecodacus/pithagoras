import { type Page } from '@playwright/test';
import { test, expect, mockPortal, reply } from './portal-mock';

/** Settings → Single sign-on over canned answers: what it is shown, and what it saves. */
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

const KEPT = {
  issuer: 'https://id.example.test/realms/home', clientId: 'portal', hasSecret: true,
  redirectUrl: 'https://portal.example.test/api/auth/oidc/callback', scopes: 'openid email profile', name: 'Example ID',
  endSession: false, allowedEmails: ['you@example.test'], allowedGroups: ['Portal users'], groupsClaim: 'groups', allowedSubjects: [],
};

test('a first setup starts from this address, sends the lists one entry a line, and asks for the current password', async ({ page }) => {
  const saves = await portal(page);
  await page.goto('/settings/sso');
  const dialog = page.getByRole('dialog');
  const redirect = dialog.getByLabel('Redirect URL');
  await expect(redirect).toHaveValue(new RegExp(`^${new URL(page.url()).origin.replace(/[.]/g, '\\.')}/api/auth/oidc/callback$`));
  await redirect.fill('https://portal.example.test/api/auth/oidc/callback');
  await dialog.getByLabel('Issuer URL').fill('https://id.example.test/realms/home');
  await dialog.getByLabel('Client ID').fill('portal');
  await dialog.getByLabel('Client secret').fill('a client secret');
  await dialog.getByLabel('Emails').fill('you@example.test\nother@example.test, third@example.test');
  await dialog.getByLabel(/^Groups(?! claim)/).fill('Portal users, admins');
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
      allowedEmails: ['you@example.test', 'other@example.test', 'third@example.test'],
      // A group's name may hold a comma: only lines part them.
      allowedGroups: ['Portal users, admins'], groupsClaim: '', allowedSubjects: [],
    },
  });
  // The password field is cleared, and the secret is now one that is kept.
  await expect(dialog.getByLabel('Current password')).toHaveValue('');
  await expect(dialog.getByText('A secret is kept. Leave this empty to keep it.')).toBeVisible();
});

test('kept settings are shown without the secret, saved again without one, and a refusal is said', async ({ page }) => {
  const saves = await portal(page, { kept: KEPT });
  await page.goto('/settings/sso');
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('Issuer URL')).toHaveValue(KEPT.issuer);
  await expect(dialog.getByLabel('Client secret')).toHaveValue('');
  await expect(dialog.getByLabel('Emails')).toHaveValue('you@example.test');
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

test('what the server refuses is said in its words, and taking single sign-on out asks first', async ({ page }) => {
  const saves = await portal(page, { kept: KEPT, refuse: 'The provider does not offer PKCE with S256' });
  await page.goto('/settings/sso');
  const dialog = page.getByRole('dialog');
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
  await page.goto('/settings/sso');
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('switch', { name: 'OIDC only' })).toBeChecked();
  await dialog.getByLabel('Current password').fill('the current one');
  await dialog.getByRole('button', { name: 'Take out single sign-on' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Take it out' }).click();
  await expect(dialog.getByRole('status')).toHaveText('Single sign-on is taken out.');
  expect(saves).toEqual([{ current: 'the current one', settings: null, only: false }]);
  await expect(dialog.getByLabel('Issuer URL')).toHaveValue('');
  await expect(dialog.getByRole('switch', { name: 'OIDC only' })).not.toBeChecked();
});

test('a portal with no login has nothing to set up', async ({ page }) => {
  await portal(page, { mode: 'open' });
  await page.goto('/settings/sso');
  await expect(page.getByRole('dialog').getByText(/no single sign-on to set up here/)).toBeVisible();
  await expect(page.getByRole('dialog').getByLabel('Issuer URL')).toHaveCount(0);
});
