import { type Page } from '@playwright/test';
import { test, expect, mockPortal, reply } from './portal-mock';

/** Settings → About → Update and the notice at the top, over a portal whose update the test controls. */
const commit = (sha: string, subject: string) => ({ sha: sha.padEnd(40, '0'), subject, date: '2026-10-12T09:00:00+02:00' });
const NOW = commit('aaa1111', 'Where the checkout is');
const NEXT = commit('bbb2222', 'Where main is');

interface World {
  status: Record<string, unknown>;
  check: Record<string, unknown>;
  posted: { check: number; start: unknown[] };
  /** Answers the start with a refusal instead of a run. */
  refuse?: { status: number; body: unknown };
}

function world(over: Partial<World> = {}): World {
  return {
    status: { kind: 'git', boot: 'boot-a', branch: 'main', current: NOW, notice: { count: 2, target: NEXT, since: '2026-10-12T08:00:00Z' }, rebuild: false, run: null },
    check: { branch: 'main', current: NOW, target: NEXT, behind: 2, ahead: 0, changed: 0, rebuild: false, problem: null, running: 0 },
    posted: { check: 0, start: [] },
    ...over,
  };
}

async function portal(page: Page, w: World) {
  await mockPortal(page, ({ path, method, json }) => {
    if (path === '/api/update/check' && method === 'POST') {
      w.posted.check++;
      return w.check;
    }
    if (path === '/api/update' && method === 'POST') {
      w.posted.start.push(json());
      if (w.refuse) return reply(w.refuse.status, w.refuse.body);
      // As the server has it once the merge is in: the build is pending, which is not a failed one.
      w.status = {
        ...w.status,
        notice: null,
        rebuild: true,
        run: {
          state: 'running', from: NOW, to: NEXT, startedAt: '2026-10-12T09:00:00Z',
          steps: [{ id: 'fetch', state: 'done' }, { id: 'merge', state: 'done' }, { id: 'install', state: 'running' }, { id: 'build', state: 'pending' }, { id: 'restart', state: 'pending' }],
        },
      };
      return reply(202, { run: (w.status as any).run });
    }
    if (path === '/api/update' && method === 'GET') return w.status;
    return undefined;
  }, { settings: true });
}

test('Update asks what is new, shows both commits and confirms before anything is started', async ({ page }) => {
  const w = world({ check: { ...world().check, running: 2 } });
  await portal(page, w);
  await page.goto('/settings/about');
  const section = page.locator('section[data-setting="Update"]');
  await expect(section).toContainText('main · aaa1111 Where the checkout is');
  await expect(section).toContainText('2 new commits on main, update available');

  await section.getByRole('button', { name: 'Update', exact: true }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toContainText('Update the portal?');
  await expect(dialog).toContainText('2 new commits on main:');
  await expect(dialog).toContainText('aaa1111 Where the checkout is');
  await expect(dialog).toContainText('bbb2222 Where main is');
  await expect(dialog).toContainText('2 chats or routines are running. The restart stops them');
  expect(w.posted.start).toEqual([]);

  // Cancelled: nothing was started.
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  expect(w.posted.start).toEqual([]);

  await section.getByRole('button', { name: 'Update', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Update and restart' }).click();
  // The commit that was shown is the one it asks for, and the steps are drawn as they stand.
  await expect.poll(() => w.posted.start).toEqual([{ expect: NEXT.sha }]);
  const steps = section.getByRole('list', { name: 'Update progress' }).getByRole('listitem');
  await expect(steps).toHaveCount(5);
  await expect(steps.nth(2)).toHaveAttribute('data-state', 'running');
  await expect(steps.nth(0)).toHaveAttribute('data-state', 'done');
  await expect(section.getByRole('button', { name: 'Update', exact: true })).toBeDisabled();
  await expect(section).not.toContainText('most likely because a build failed');
});

test('a build that is not of the checked out commit is built again after a confirmation, with nothing to merge', async ({ page }) => {
  // As after a failed build and a restart: the checkout is at main, so there is nothing new, and the files are of an older commit.
  const w = world({ check: { ...world().check, current: NEXT, target: NEXT, behind: 0, rebuild: true } });
  w.status = { ...w.status, notice: null, current: NEXT, rebuild: true };
  await portal(page, w);
  await page.goto('/settings/about');
  const section = page.locator('section[data-setting="Update"]');
  await expect(section).toContainText('most likely because a build failed. Update builds it again.');
  await section.getByRole('button', { name: 'Update', exact: true }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toContainText('This builds it again: bbb2222 Where main is.');
  await dialog.getByRole('button', { name: 'Update and restart' }).click();
  await expect.poll(() => w.posted.start).toEqual([{ expect: NEXT.sha }]);
});

test('one running chat is said in the singular, and none is not mentioned', async ({ page }) => {
  const w = world({ check: { ...world().check, running: 1 } });
  await portal(page, w);
  await page.goto('/settings/about');
  await page.locator('section[data-setting="Update"]').getByRole('button', { name: 'Update', exact: true }).click();
  await expect(page.getByRole('alertdialog')).toContainText('1 chat or routine is running.');
  await page.getByRole('alertdialog').getByRole('button', { name: 'Cancel' }).click();

  w.check = { ...w.check, running: 0 };
  await page.locator('section[data-setting="Update"]').getByRole('button', { name: 'Update', exact: true }).click();
  await expect(page.getByRole('alertdialog')).toContainText('Update the portal?');
  await expect(page.getByRole('alertdialog')).not.toContainText('running');
});

test('what stands in the way is said, with no question asked', async ({ page }) => {
  const w = world({ check: { ...world().check, changed: 3, problem: { code: 'dirty', message: 'The checkout has local changes (3 files).' } } });
  await portal(page, w);
  await page.goto('/settings/about');
  const section = page.locator('section[data-setting="Update"]');
  await section.getByRole('button', { name: 'Update', exact: true }).click();
  await expect(section.getByRole('status').filter({ hasText: '3 files with local changes' })).toBeVisible();
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  expect(w.posted.start).toEqual([]);

  w.check = { ...w.check, changed: 0, problem: { code: 'diverged', message: '' } };
  await section.getByRole('button', { name: 'Update', exact: true }).click();
  await expect(section.getByRole('status').filter({ hasText: 'cannot move straight to it' })).toBeVisible();

  w.check = { ...w.check, problem: { code: 'detached', message: '' } };
  await section.getByRole('button', { name: 'Update', exact: true }).click();
  await expect(section.getByRole('status').filter({ hasText: 'not on a branch' })).toBeVisible();

  w.check = { ...w.check, behind: 0, problem: null, target: NOW };
  await section.getByRole('button', { name: 'Update', exact: true }).click();
  await expect(section.getByRole('status').filter({ hasText: 'The portal is up to date.' })).toBeVisible();
  expect(w.posted.start).toEqual([]);
});

test('a portal that would not come back after the restart says so before it asks, and asks nothing', async ({ page }) => {
  const w = world({ check: { ...world().check, problem: { code: 'restart', message: 'The portal runs as the systemd service p.service, which is set to Restart=no.' } } });
  await portal(page, w);
  await page.goto('/settings/about');
  const section = page.locator('section[data-setting="Update"]');
  await section.getByRole('button', { name: 'Update', exact: true }).click();
  await expect(section.getByRole('status').filter({ hasText: 'Set Restart=on-failure (or Restart=always) in its unit, then update again.' })).toBeVisible();
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  expect(w.posted.start).toEqual([]);
});

test('a start the portal refuses is said in words', async ({ page }) => {
  const w = world({ refuse: { status: 409, body: { error: 'origin/main has moved on since it was looked at. Check again.', code: 'moved' } } });
  await portal(page, w);
  await page.goto('/settings/about');
  const section = page.locator('section[data-setting="Update"]');
  await section.getByRole('button', { name: 'Update', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Update and restart' }).click();
  await expect(section.getByRole('status').filter({ hasText: 'has moved on since it was looked at' })).toBeVisible();
});

test('a failed step is shown with its name and what the program printed, and the button is there to try again', async ({ page }) => {
  const w = world();
  w.status = {
    ...w.status, notice: null, rebuild: true,
    run: {
      state: 'failed', from: NOW, to: NEXT, startedAt: '2026-10-12T09:00:00Z',
      steps: [{ id: 'fetch', state: 'done' }, { id: 'merge', state: 'done' }, { id: 'install', state: 'done' }, { id: 'build', state: 'failed' }, { id: 'restart', state: 'pending' }],
      failed: { step: 'build', message: 'npm run build failed (exit 2)', output: 'src/x.ts(4,1): error TS2322: nope', oldFilesBack: true },
    },
  };
  await portal(page, w);
  await page.goto('/settings/about');
  const section = page.locator('section[data-setting="Update"]');
  const alert = section.getByRole('alert');
  await expect(alert).toContainText('The update stopped at “Building”. The portal is still running its old build, with its files as they were.');
  await expect(alert).toContainText('npm run build failed (exit 2)');
  await expect(alert).toContainText('error TS2322: nope');
  await expect(section).toContainText('The build is not of the commit that is checked out, most likely because a build failed. Update builds it again.');
  await expect(section.getByRole('button', { name: 'Update', exact: true })).toBeEnabled();
});

test('in a Docker container there is no button and no notice, and the page says how to update the image', async ({ page }) => {
  const w = world();
  w.status = { kind: 'container', boot: 'boot-a' };
  await portal(page, w);
  await page.goto('/settings/about');
  const section = page.locator('section[data-setting="Update"]');
  await expect(section).toContainText('cannot rebuild itself');
  await expect(section).toContainText('git pull && docker compose up -d --build');
  await expect(section.getByRole('button')).toHaveCount(0);
  await expect(page.getByText('update available')).toHaveCount(0);
  // Nothing was asked of the remote.
  expect(w.posted.check).toBe(0);

  // A portal that is no checkout either has no such section.
  w.status = { kind: 'none', boot: 'boot-a' };
  await page.goto('/settings/about');
  await expect(page.getByText('Where the agent runs')).toBeVisible();
  await expect(page.locator('section[data-setting="Update"]')).toHaveCount(0);
});

test('a portal that runs from its source files under a watcher has no button and says why', async ({ page }) => {
  const w = world();
  w.status = { kind: 'dev', boot: 'boot-a' };
  await portal(page, w);
  await page.goto('/settings/about');
  const section = page.locator('section[data-setting="Update"]');
  await expect(section).toContainText('under a file watcher (npm run dev:server)');
  await expect(section).toContainText('npm run build && npm start');
  await expect(section.getByRole('button')).toHaveCount(0);
  await expect(page.getByText('update available')).toHaveCount(0);
  // Nothing was asked of the remote.
  expect(w.posted.check).toBe(0);
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Sessions' }).first()).toBeVisible();
  await expect(page.getByText('update available')).toHaveCount(0);
});

test('the notice at the top says there are new commits, and Update on it asks the same question', async ({ page }) => {
  const w = world();
  await portal(page, w);
  await page.goto('/');
  const notice = page.getByRole('status').filter({ hasText: '2 new commits on main, update available' });
  await expect(notice).toBeVisible();
  await notice.getByRole('button', { name: 'Update', exact: true }).click();
  await expect(page.getByRole('alertdialog')).toContainText('bbb2222 Where main is');
  await page.getByRole('alertdialog').getByRole('button', { name: 'Update and restart' }).click();
  await expect.poll(() => w.posted.start).toEqual([{ expect: NEXT.sha }]);
  // While it runs, the notice says how far it has got.
  await expect(page.getByRole('status').filter({ hasText: 'Updating the portal: Installing dependencies' })).toBeVisible();
});

test('the notice can be put away, and a newer target brings it back', async ({ page }) => {
  const w = world();
  await portal(page, w);
  await page.goto('/');
  const notice = page.getByRole('status').filter({ hasText: 'new commits on main, update available' });
  await expect(notice).toBeVisible();
  await notice.getByRole('button', { name: 'Dismiss' }).click();
  await expect(notice).toBeHidden();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Sessions' }).first()).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'update available' })).toHaveCount(0);

  w.status = { ...w.status, notice: { count: 3, target: commit('ccc3333', 'More'), since: '2026-10-12T10:00:00Z' } };
  await page.reload();
  await expect(page.getByRole('status').filter({ hasText: '3 new commits on main, update available' })).toBeVisible();
});

test('no notice where the portal has nothing new', async ({ page }) => {
  const w = world();
  w.status = { ...w.status, notice: null };
  await portal(page, w);
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Sessions' }).first()).toBeVisible();
  await expect(page.getByText('update available')).toHaveCount(0);
});

test('the page loads again when the portal comes back after an update', async ({ page }) => {
  const w = world();
  w.status = {
    ...w.status, notice: null,
    run: { state: 'restarting', from: NOW, to: NEXT, startedAt: '2026-10-12T09:00:00Z', steps: [{ id: 'fetch', state: 'done' }, { id: 'merge', state: 'done' }, { id: 'install', state: 'done' }, { id: 'build', state: 'done' }, { id: 'restart', state: 'running' }] },
  };
  await portal(page, w);
  await page.goto('/');
  await expect(page.getByRole('status').filter({ hasText: 'The portal is restarting.' })).toBeVisible();
  await page.evaluate(() => ((window as any).beforeReload = true));
  // The portal is back: another start of it, running the new commit, with no update going on.
  w.status = { kind: 'git', boot: 'boot-b', branch: 'main', current: NEXT, notice: null, rebuild: false, run: null };
  await expect.poll(() => page.evaluate(() => (window as any).beforeReload === true), { timeout: 8000 }).toBe(false);
  await expect(page.getByRole('status').filter({ hasText: 'The portal is restarting.' })).toHaveCount(0);
});

test('the update is in German where the portal is', async ({ page }) => {
  const w = world();
  await page.addInitScript(() => localStorage.setItem('pithagoras.language', 'de'));
  await portal(page, w);
  await page.goto('/settings/about');
  const section = page.locator('section[data-setting="Aktualisieren"]');
  await expect(section).toContainText('2 neue Commits auf main, Aktualisierung verfügbar');
  await section.getByRole('button', { name: 'Aktualisieren', exact: true }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toContainText('Das Portal aktualisieren?');
  await expect(dialog).toContainText('Aktualisieren und neu starten');
});

test('a browser that asked for notifications is told once for each new target, when nobody is looking', async ({ page }) => {
  await page.addInitScript(() => {
    const shown: string[][] = ((window as any).shown = []);
    (window as any).Notification = class {
      static permission = 'granted';
      static requestPermission = async () => 'granted';
      onclick: unknown;
      constructor(title: string, options: { body: string; tag: string }) { shown.push([title, options.body, options.tag]); }
      close() {}
    };
    localStorage.setItem('notifyWhenAway', 'on');
    document.hasFocus = () => false;
  });
  const w = world();
  await portal(page, w);
  await page.goto('/');
  await expect(page.getByRole('status').filter({ hasText: '2 new commits on main, update available' })).toBeVisible();
  const told = () => page.evaluate(() => (window as any).shown as string[][]);
  await expect.poll(told).toEqual([['Update available', '2 new commits on main, update available', `update-${NEXT.sha}`]]);

  // The same target on the next load, or with more commits behind it, is not a new notice.
  w.status = { ...w.status, notice: { count: 3, target: NEXT, since: '2026-10-12T08:00:00Z' } };
  await page.reload();
  await expect(page.getByRole('status').filter({ hasText: '3 new commits on main, update available' })).toBeVisible();
  expect(await told()).toEqual([]);

  const newer = commit('ccc3333', 'More');
  w.status = { ...w.status, notice: { count: 4, target: newer, since: '2026-10-12T10:00:00Z' } };
  await page.reload();
  await expect.poll(told).toEqual([['Update available', '4 new commits on main, update available', `update-${newer.sha}`]]);
});

test('a failed update is said at the top of every page until it is put away', async ({ page }) => {
  const w = world();
  w.status = {
    ...w.status, notice: null, rebuild: true,
    run: {
      state: 'failed', from: NOW, to: NEXT, startedAt: '2026-10-12T09:00:00Z',
      steps: [{ id: 'fetch', state: 'done' }, { id: 'merge', state: 'done' }, { id: 'install', state: 'failed' }, { id: 'build', state: 'pending' }, { id: 'restart', state: 'pending' }],
      failed: { step: 'install', message: 'npm ci failed (exit 1)', output: 'npm ERR! network', oldFilesBack: true },
    },
  };
  await portal(page, w);
  await page.goto('/');
  const line = page.getByRole('status').filter({ hasText: 'The update stopped at “Installing dependencies”' });
  await expect(line).toBeVisible();
  await line.getByRole('button', { name: 'Details' }).click();
  await expect(page).toHaveURL(/\/settings\/about$/);
  await page.goto('/');
  await page.getByRole('status').filter({ hasText: 'The update stopped at' }).getByRole('button', { name: 'Dismiss' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'The update stopped at' })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Sessions' }).first()).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'The update stopped at' })).toHaveCount(0);
});

/** A failed run for the tests of what the failure says of the files. */
function failedRun(step: string, oldFilesBack: boolean, message: string) {
  const order = ['fetch', 'merge', 'install', 'build', 'restart'];
  const at = order.indexOf(step);
  return {
    state: 'failed', from: NOW, to: NEXT, startedAt: '2026-10-12T09:00:00Z',
    steps: order.map((id, i) => ({ id, state: i < at ? 'done' : i === at ? 'failed' : 'pending' })),
    failed: { step, message, output: '', oldFilesBack },
  };
}

test('a restart that failed does not say the old files are as they were: the new build has replaced them', async ({ page }) => {
  const w = world();
  w.status = { ...w.status, notice: null, run: failedRun('restart', false, 'The portal was not started from a file') };
  await portal(page, w);
  await page.goto('/');
  const line = page.getByRole('status').filter({ hasText: 'could not restart itself' });
  await expect(line).toContainText('The new version is built, but the portal could not restart itself. Restart it on the host.');
  await expect(line).not.toContainText('as they were');
  await page.goto('/settings/about');
  const alert = page.locator('section[data-setting="Update"]').getByRole('alert');
  await expect(alert).toContainText('could not restart itself');
  await expect(alert).not.toContainText('as they were');
});

test('files that could not be put back are said, and not said to be as they were', async ({ page }) => {
  const w = world();
  w.status = { ...w.status, notice: null, run: failedRun('build', false, 'npm run build failed (exit 2). The old files could not be put back: EACCES') };
  await portal(page, w);
  await page.goto('/');
  const line = page.getByRole('status').filter({ hasText: 'The update stopped at' });
  await expect(line).toContainText('The update stopped at “Building”, and the old files could not be put back. Look at the install on the host.');
  await expect(line).not.toContainText('as they were');
  await page.goto('/settings/about');
  const alert = page.locator('section[data-setting="Update"]').getByRole('alert');
  await expect(alert).toContainText('and the old files could not be put back. Look at the install on the host.');
  await expect(alert).toContainText('EACCES');
  await expect(alert).not.toContainText('as they were');
});

test('a failure with the old files back says they are as they were, at the top and in Settings', async ({ page }) => {
  const w = world();
  w.status = { ...w.status, notice: null, run: failedRun('install', true, 'npm ci failed (exit 1)') };
  await portal(page, w);
  await page.goto('/');
  await expect(page.getByRole('status').filter({ hasText: 'The update stopped at' })).toContainText('with its files as they were.');
  await page.goto('/settings/about');
  await expect(page.locator('section[data-setting="Update"]').getByRole('alert')).toContainText('with its files as they were.');
});
