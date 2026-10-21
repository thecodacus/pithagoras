import { type Page } from '@playwright/test';
import { test, expect, mockPortal, reply } from './portal-mock';

/**
 * Installing an extension that requires others: the page asks the server what that brings with it, says so before
 * anything is installed, and installs or switches on each before the extension, which comes last. Over canned
 * answers: what the server works out is its own tests' (core/server/test/install-plan.test.mjs).
 */
const ext = (o: Record<string, unknown>) => ({ settings: [], enabled: true, scope: 'user', kinds: ['pithagoras'], ...o });
const engine = { name: 'test-engine', version: '1.0.0', kinds: ['pithagoras'], spec: '/app/extensions/engine', description: 'What others run on.' };
const screen = { name: 'test-screen', version: '0.1.0', kinds: ['pithagoras'], spec: '/app/extensions/screen', description: 'A screen of another program.', requires: { 'test-engine': '^1.0.0' } };
const need = (o: Record<string, unknown>) => ({ name: 'test-engine', range: '^1.0.0', for: 'test-screen', ...o });
const FROM_FOLDER = need({ action: 'install', spec: engine.spec, from: 'shipped', version: '1.0.0' });

/**
 * The portal, with the needs installing the screen brings (`needs`) and the requests that change what is installed
 * in the order they came. `hold` keeps the first install from ending until it is let go.
 */
async function portal(page: Page, needs: unknown[], { fails, hold }: { fails?: string; hold?: boolean } = {}) {
  const changes: string[] = [];
  const installed: unknown[] = [];
  let release = () => {};
  const held = hold ? new Promise<void>((r) => (release = r)) : Promise.resolve();
  await mockPortal(page, async ({ path, method, url, json }) => {
    if (path === '/api/extensions' && method === 'GET') return { settingsPath: '/a/settings.json', extensions: installed };
    if (path === '/api/extensions/shipped') return { extensions: [engine, screen] };
    if (path === '/api/packages/catalog') return { packages: [{ name: 'pi-viewer', version: '2.0.0', description: 'Shows things.', keywords: ['pi-package'], provider: false, author: 'someone' }] };
    if (path === '/api/extensions/plan') {
      const spec = url.searchParams.get('spec');
      changes.push(`plan ${spec}`);
      if (spec === screen.spec) return { name: 'test-screen', version: '0.1.0', needs };
      if (spec === 'npm:pi-viewer') return { name: 'pi-viewer', version: '2.0.0', needs: [need({ for: 'pi-viewer', action: 'install', spec: 'npm:test-engine@^1.0.0', from: 'npm', version: '1.2.0' })] };
      return { needs: [] };
    }
    if (path === '/api/packages' && method === 'POST') {
      const { spec } = json();
      changes.push(`install ${spec}`);
      if (changes.filter((c) => c.startsWith('install')).length === 1) await held;
      if (spec === fails) return reply(500, { error: 'npm could not fetch it' });
      installed.push(ext({ spec, name: spec === engine.spec ? engine.name : spec === screen.spec ? screen.name : spec }));
      return { ok: true, output: '' };
    }
    if (path === '/api/extensions/enabled' && method === 'PUT') {
      changes.push(`switch on ${json().spec}`);
      return { ok: true, enabled: true, reloaded: 0, waiting: 0 };
    }
    return undefined;
  }, { settings: true });
  await page.goto('/settings/extensions');
  await page.getByRole('tab', { name: 'Discover' }).click();
  return { changes, release };
}

const own = (page: Page) => page.getByRole('tabpanel', { name: 'Discover' }).locator('[data-setting="Comes with Pithagoras"]');
const byName = (page: Page) => page.getByRole('tabpanel', { name: 'Discover' }).locator('[data-setting="Install by name"]');
const card = (page: Page, name: string) => own(page).getByRole('listitem').filter({ hasText: name });
const asked = (page: Page) => page.getByRole('alertdialog', { name: 'Install test-screen?' });

test('what an extension requires is on its card before it is installed', async ({ page }) => {
  await portal(page, [FROM_FOLDER]);
  await expect(card(page, 'test-screen')).toContainText('Needs test-engine');
  await expect(card(page, 'What others run on.')).not.toContainText('Needs');
});

test('installing one that requires another lists it, and confirming installs that one first, then the extension', async ({ page }) => {
  const { changes, release } = await portal(page, [FROM_FOLDER], { hold: true });
  await card(page, 'test-screen').getByRole('button', { name: 'Install test-screen' }).click();
  await expect(asked(page)).toContainText('test-screen needs other extensions to run:');
  await expect(asked(page).getByRole('listitem')).toHaveText(['test-engine 1.0.0 is installed from the portal\'s own folder.']);
  await expect(asked(page)).not.toContainText('from npm');
  await asked(page).getByRole('button', { name: 'Install', exact: true }).click();
  // Said as it goes, one package at a time.
  await expect(own(page).getByRole('status')).toHaveText('Installing test-engine, 1 of 2…');
  release();
  await expect(card(page, 'test-screen')).toContainText('Installed');
  await expect(card(page, 'What others run on.')).toContainText('Installed');
  expect(changes).toEqual([`plan ${screen.spec}`, `install ${engine.spec}`, `install ${screen.spec}`]);
  await expect(own(page).getByRole('status')).toHaveCount(0);
});

test('cancelling installs nothing', async ({ page }) => {
  const { changes } = await portal(page, [FROM_FOLDER]);
  await card(page, 'test-screen').getByRole('button', { name: 'Install test-screen' }).click();
  await asked(page).getByRole('button', { name: 'Cancel' }).click();
  await expect(asked(page)).toHaveCount(0);
  await expect(card(page, 'test-screen').getByRole('button', { name: 'Install test-screen' })).toBeEnabled();
  expect(changes).toEqual([`plan ${screen.spec}`]);
});

test('with everything it requires there, it is installed at once, without a question', async ({ page }) => {
  const { changes } = await portal(page, []);
  await card(page, 'test-screen').getByRole('button', { name: 'Install test-screen' }).click();
  await expect(card(page, 'test-screen')).toContainText('Installed');
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  expect(changes).toEqual([`plan ${screen.spec}`, `install ${screen.spec}`]);
});

test('one installed and switched off is listed to be switched on, and is, before the extension is installed', async ({ page }) => {
  const { changes } = await portal(page, [need({ action: 'switch-on', spec: 'npm:test-engine', version: '1.0.0' })]);
  await card(page, 'test-screen').getByRole('button', { name: 'Install test-screen' }).click();
  await expect(asked(page).getByRole('listitem')).toHaveText(['test-engine 1.0.0 is installed but switched off: it is switched on.']);
  await asked(page).getByRole('button', { name: 'Install', exact: true }).click();
  await expect(card(page, 'test-screen')).toContainText('Installed');
  expect(changes).toEqual([`plan ${screen.spec}`, 'switch on npm:test-engine', `install ${screen.spec}`]);
});

test('one that cannot be found is said; the extension can still be installed, and waits for it', async ({ page }) => {
  const { changes } = await portal(page, [
    need({ action: 'missing' }),
    need({ name: 'test-older', action: 'version', version: '0.2.0' }),
    need({ name: 'test-own', action: 'version', from: 'shipped', version: '0.2.0' }),
  ]);
  await card(page, 'test-screen').getByRole('button', { name: 'Install test-screen' }).click();
  await expect(asked(page).getByRole('listitem')).toHaveText([
    'test-engine ^1.0.0 is not in the portal\'s own folder or on npm.',
    'test-older 0.2.0 is installed, and ^1.0.0 is needed: update it.',
    'test-own 0.2.0 is the one in the portal\'s own folder, and ^1.0.0 is needed.',
  ]);
  await expect(asked(page)).toContainText('It can be installed without what is not there: it then waits, and Settings → Extensions says what for.');
  await asked(page).getByRole('button', { name: 'Install', exact: true }).click();
  await expect(card(page, 'test-screen')).toContainText('Installed');
  expect(changes).toEqual([`plan ${screen.spec}`, `install ${screen.spec}`]);
});

test('what a requirement needs is listed with what needs it, and a requirement that fails stops the rest, said', async ({ page }) => {
  const deeper = need({ name: 'test-base', for: 'test-engine', action: 'install', spec: '/app/extensions/base', from: 'shipped', version: '3.0.0' });
  const { changes } = await portal(page, [deeper, FROM_FOLDER], { fails: '/app/extensions/base' });
  await card(page, 'test-screen').getByRole('button', { name: 'Install test-screen' }).click();
  await expect(asked(page).getByRole('listitem').first()).toHaveText('test-base 3.0.0 is installed from the portal\'s own folder.Needed by test-engine');
  await asked(page).getByRole('button', { name: 'Install', exact: true }).click();
  await expect(page.getByText('test-base could not be installed, so test-screen was not: npm could not fetch it')).toBeVisible();
  expect(changes).toEqual([`plan ${screen.spec}`, 'install /app/extensions/base']);
  await expect(card(page, 'test-screen').getByRole('button', { name: 'Install test-screen' })).toBeEnabled();
});

test('a requirement failing after another was installed stops the rest, and what was installed is listed as installed', async ({ page }) => {
  const base = need({ name: 'test-base', action: 'install', spec: '/app/extensions/base', from: 'shipped', version: '3.0.0' });
  const { changes } = await portal(page, [FROM_FOLDER, base], { fails: '/app/extensions/base' });
  await card(page, 'test-screen').getByRole('button', { name: 'Install test-screen' }).click();
  await asked(page).getByRole('button', { name: 'Install', exact: true }).click();
  await expect(page.getByText('test-base could not be installed, so test-screen was not: npm could not fetch it')).toBeVisible();
  expect(changes).toEqual([`plan ${screen.spec}`, `install ${engine.spec}`, 'install /app/extensions/base']);
  await expect(card(page, 'What others run on.')).toContainText('Installed');
  await expect(card(page, 'test-screen').getByRole('button', { name: 'Install test-screen' })).toBeEnabled();
});

test('what is installed from npm for one that comes with the portal is said to run with the agent\'s rights, and one needed twice in versions that differ is said for both', async ({ page }) => {
  const base = need({ name: 'test-base', action: 'install', spec: '/app/extensions/base', from: 'shipped', version: '3.0.0' });
  await portal(page, [
    need({ action: 'install', spec: 'npm:test-engine@^1.0.0', from: 'npm', version: '1.2.0' }),
    need({ for: 'test-base', range: '^2.0.0', action: 'version', from: 'npm', version: '1.2.0' }),
    base,
  ]);
  await card(page, 'test-screen').getByRole('button', { name: 'Install test-screen' }).click();
  await expect(asked(page).getByRole('listitem')).toHaveText([
    'test-engine 1.2.0 is installed from npm.',
    'test-engine 1.2.0 is the one installed from npm, and ^2.0.0 is needed.Needed by test-base',
    'test-base 3.0.0 is installed from the portal\'s own folder.',
  ]);
  await expect(asked(page)).toContainText('Those installed from npm run inside pi with the same rights as the agent — reading files, running commands. Install packages you trust.');
});

test('a package from npm asks once, with what it needs under the warning, and installs that first', async ({ page }) => {
  const { changes } = await portal(page, []);
  await page.getByRole('button', { name: 'Install pi-viewer' }).click();
  const question = page.getByRole('alertdialog', { name: 'Install pi-viewer?' });
  await expect(question).toContainText('It is installed from npm and runs inside pi with the same rights as the agent');
  await expect(question.getByRole('listitem')).toHaveText(['test-engine 1.2.0 is installed from npm.']);
  await expect(question).toContainText('Those installed from npm run inside pi with the same rights as the agent');
  await question.getByRole('button', { name: 'Install', exact: true }).click();
  await expect(page.getByRole('tabpanel', { name: 'Discover' }).getByRole('listitem').filter({ hasText: 'pi-viewer' })).toContainText('Installed');
  expect(changes).toEqual(['plan npm:pi-viewer', 'install npm:test-engine@^1.0.0', 'install npm:pi-viewer']);
});

test('a package from npm that fails after what it needs was installed says so, and what was installed is listed', async ({ page }) => {
  const { changes } = await portal(page, [], { fails: 'npm:pi-viewer' });
  await page.getByRole('button', { name: 'Install pi-viewer' }).click();
  await page.getByRole('alertdialog', { name: 'Install pi-viewer?' }).getByRole('button', { name: 'Install', exact: true }).click();
  await expect(page.getByText('npm could not fetch it')).toBeVisible();
  expect(changes).toEqual(['plan npm:pi-viewer', 'install npm:test-engine@^1.0.0', 'install npm:pi-viewer']);
  await expect(card(page, 'What others run on.')).toContainText('Installed');
});

test('a spec installed by name lists what it needs; cancelled, what was typed stays, and on yes that is installed first', async ({ page }) => {
  const { changes, release } = await portal(page, [], { hold: true });
  const field = page.getByRole('textbox', { name: 'Install by name' });
  await field.fill('npm:pi-viewer');
  await byName(page).getByRole('button', { name: 'Install', exact: true }).click();
  const question = page.getByRole('alertdialog', { name: 'Install pi-viewer?' });
  await expect(question.getByRole('listitem')).toHaveText(['test-engine 1.2.0 is installed from npm.']);
  await question.getByRole('button', { name: 'Cancel' }).click();
  await expect(question).toHaveCount(0);
  // Done with: the button is there to press again, for what is still typed.
  await expect(byName(page).getByRole('button', { name: 'Install', exact: true })).toBeEnabled();
  await expect(field).toHaveValue('npm:pi-viewer');
  expect(changes).toEqual(['plan npm:pi-viewer']);

  await field.press('Enter');
  await question.getByRole('button', { name: 'Install', exact: true }).click();
  await expect(byName(page).getByRole('status')).toHaveText('Installing test-engine, 1 of 2…');
  release();
  await expect(field).toHaveValue('');
  expect(changes).toEqual(['plan npm:pi-viewer', 'plan npm:pi-viewer', 'install npm:test-engine@^1.0.0', 'install npm:pi-viewer']);
  await expect(byName(page).getByRole('status')).toHaveCount(0);
});

test('a spec by name that cannot be read beforehand, a git URL, is installed at once', async ({ page }) => {
  const { changes } = await portal(page, []);
  const field = page.getByRole('textbox', { name: 'Install by name' });
  await field.fill('git:github.com/user/repo');
  await byName(page).getByRole('button', { name: 'Install', exact: true }).click();
  await expect(field).toHaveValue('');
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  expect(changes).toEqual(['plan git:github.com/user/repo', 'install git:github.com/user/repo']);
});
