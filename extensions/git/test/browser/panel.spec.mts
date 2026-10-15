import { type Page } from '@playwright/test';
import { test, expect } from '../../../../tests/browser/portal-mock';

test.use({ installed: ['extensions/git'] });

const calls = (page: Page) => page.evaluate(() => (window as any).gitCalls.filter((c: any) => c.method === 'POST').map((c: any) => ({ url: c.url.replace('/api/x/pithagoras-git/chats/s', ''), body: c.body })));
const row = (page: Page, name: string) => page.getByRole('button', { name: new RegExp(name.replace(/[.]/g, '\\.')) }).first();

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 520, height: 760 });
});

test('what changed is listed staged and not; a file is staged from its row, and the staged ones are committed with the message', async ({ page }) => {
  await page.goto('/tests/extension.html?page=git/panel');
  await expect(page.getByRole('button', { name: 'Unstage login.ts' })).toBeAttached();
  await expect(page.getByText('login flow.md')).toBeVisible();

  await page.getByRole('button', { name: 'Stage session.ts' }).click();
  await expect(page.getByRole('button', { name: 'Unstage session.ts' })).toBeAttached();

  await page.getByRole('textbox', { name: 'Commit message' }).fill('Check the session too');
  await expect(page.getByRole('button', { name: 'Commit 2 staged' })).toBeEnabled();
  await page.getByRole('textbox', { name: 'Commit message' }).press('Control+Enter');
  await expect(page.getByRole('textbox', { name: 'Commit message' })).toHaveValue('');
  expect(await calls(page)).toEqual([
    { url: '/stage', body: { paths: ['src/auth/session.ts'] } },
    { url: '/commit', body: { message: 'Check the session too', amend: false } },
  ]);
});

test('with nothing staged the button commits everything, staging it first', async ({ page }) => {
  await page.goto('/tests/extension.html?page=git/panel');
  await page.getByRole('button', { name: 'Unstage everything' }).click();
  await expect(page.getByRole('button', { name: 'Commit all 4' })).toBeDisabled();
  await page.getByRole('textbox', { name: 'Commit message' }).fill('All of it');
  await page.getByRole('button', { name: 'Commit all 4' }).click();
  await expect(page.getByText('Nothing has changed since the last commit.')).toBeVisible();
  expect((await calls(page)).map((c) => c.url)).toEqual(['/unstage', '/stage', '/commit']);
  expect((await calls(page))[1].body).toEqual({ all: true });
});

test("a file's diff is shown with the lines numbered where they were and where they are, and can be staged from there", async ({ page }) => {
  await page.goto('/tests/extension.html?page=git/panel');
  await row(page, 'session.ts').click();
  const table = page.getByRole('table', { name: 'Changes to src/auth/session.ts' });
  await expect(table).toBeVisible();
  await expect(table.locator('[data-kind="del"]')).toHaveCount(1);
  await expect(table.locator('[data-kind="add"]')).toHaveCount(4);
  await expect(table.locator('[data-kind="del"]')).toContainText('11');
  await expect(table.locator('[data-kind="add"]').first()).toContainText('if (!stored) throw');
  // Said in words as well as drawn: of two lines numbered alike, which one was removed, and what each cell is.
  await expect(table.getByRole('columnheader')).toHaveText(['Line before', 'Line after', 'Kind of change', 'Text']);
  await expect(table.locator('[data-kind="del"]').getByRole('cell').nth(2)).toHaveText('−removed');
  await expect(table.locator('[data-kind="add"]').first().getByRole('cell').nth(2)).toHaveText('+added');

  await page.getByRole('button', { name: 'Stage', exact: true }).click();
  // Back on the list, with it staged.
  await expect(page.getByRole('button', { name: 'Unstage session.ts' })).toBeAttached();
});

test('discarding asks first, and nothing is thrown away when the answer is no', async ({ page }) => {
  await page.goto('/tests/extension.html?page=git/panel');
  await page.getByRole('button', { name: 'Discard the changes to README.md' }).click();
  await expect(page.getByRole('alertdialog')).toContainText('Discard the changes to README.md?');
  await page.getByRole('button', { name: 'Cancel' }).click();
  expect(await calls(page)).toEqual([]);
  await page.getByRole('button', { name: 'Discard the changes to README.md' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Discard' }).click();
  await expect(page.getByText('README.md')).toHaveCount(0);
  expect(await calls(page)).toEqual([{ url: '/discard', body: { paths: ['README.md'] } }]);
});

test('what the agent writes shows up without a refresh, and a file opens in Files from its row', async ({ page }) => {
  await page.goto('/tests/extension.html?page=git/panel');
  await expect(page.getByText('login.ts')).toBeVisible();
  await page.evaluate(() => (window as any).agentWrote('src/auth/logout.ts'));
  await expect(page.getByText('logout.ts')).toBeVisible();
  await page.getByRole('button', { name: 'Open README.md in Files' }).click();
  await expect(page.getByTestId('opened')).toHaveText('README.md');
});

test('a push the remote refuses says why', async ({ page }) => {
  await page.goto('/tests/extension.html?page=git/panel&push=fail');
  await page.getByRole('button', { name: /^Push/ }).click();
  await expect(page.getByRole('alert')).toContainText('Updates were rejected because the remote contains work that you do not have locally.');
});

test('history: a commit opens with its message and files, and a file of it with its diff', async ({ page }) => {
  await page.goto('/tests/extension.html?page=git/panel&tab=history');
  await page.getByText('Add the login form').click();
  await expect(page.getByText('With a body that explains why.')).toBeVisible();
  await row(page, 'new.ts').click();
  await expect(page.getByRole('table', { name: 'Changes to src/auth/new.ts' })).toBeVisible();
  expect((await page.evaluate(() => (window as any).gitCalls.map((c: any) => c.url))).some((u: string) => u.includes('of=commit') && u.includes('sha=b2c3d4e5'))).toBe(true);
  await page.getByRole('button', { name: 'Back' }).click();
  await page.getByRole('button', { name: 'Back' }).click();
  await expect(page.getByText('Compare this branch with its base')).toBeVisible();
});

test('branches: one is made from a name, and one on the remote is checked out as a local branch following it', async ({ page }) => {
  await page.goto('/tests/extension.html?page=git/panel&tab=branches');
  await page.getByRole('textbox', { name: 'Name of the new branch' }).fill('fix/typo');
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByRole('button', { name: /fix\/typo/ }).first()).toBeVisible();
  await page.getByRole('button', { name: /On the remote/ }).click();
  await page.getByRole('button', { name: /origin\/feature\/signup/ }).click();
  await expect(page.locator('[data-git-tab]').getByText('feature/signup').first()).toBeVisible();
  expect(await calls(page)).toEqual([
    { url: '/branches', body: { name: 'fix/typo' } },
    { url: '/switch', body: { name: 'origin/feature/signup', remote: true } },
  ]);
});

test('pull requests: listed through gh, one opened with its checks and conversation, merged only once asked', async ({ page }) => {
  await page.goto('/tests/extension.html?page=git/panel&tab=pulls');
  await page.getByRole('button', { name: /Dark mode for the settings/ }).click();
  await expect(page.getByText('Looks good — one question about the hash.')).toBeVisible();
  await expect(page.getByText('lint')).toBeVisible();
  // A draft is not merged.
  await expect(page.getByRole('button', { name: 'Merge' })).toBeDisabled();
  await page.getByRole('button', { name: 'Back' }).click();
  await page.getByRole('button', { name: /Login with a password/ }).last().click();
  await page.getByRole('combobox', { name: 'How to merge' }).click();
  await page.getByRole('option', { name: 'Rebase' }).click();
  await page.getByRole('button', { name: 'Merge' }).click();
  await expect(page.getByRole('alertdialog')).toContainText('Rebased on main');
  await page.getByRole('alertdialog').getByRole('button', { name: 'Merge' }).click();
  await expect.poll(() => calls(page)).toEqual([{ url: '/pulls/41/merge', body: { method: 'rebase', deleteBranch: true } }]);
});

test('a branch without a pull request offers to open one, filled in from its commits', async ({ page }) => {
  await page.goto('/tests/extension.html?page=git/panel&tab=branches');
  await page.getByRole('textbox', { name: 'Name of the new branch' }).fill('feature/export');
  await page.getByRole('button', { name: 'Create' }).click();
  await page.getByRole('tab', { name: 'Pull requests' }).click();
  await page.getByRole('button', { name: 'Open a pull request for feature/export' }).click();
  await expect(page.getByRole('textbox', { name: 'Description of the pull request' })).toHaveValue('- Add the login form\n- Check the password before the session is made');
  await page.getByRole('textbox', { name: 'Title of the pull request' }).fill('Export to CSV');
  await page.getByRole('button', { name: 'Open', exact: true }).click();
  // Straight to the one just opened.
  await expect(page.getByRole('button', { name: 'Back' })).toBeVisible();
  const opened = (await calls(page)).find((c) => c.url === '/pulls');
  expect(opened?.body).toEqual({ title: 'Export to CSV', body: '- Add the login form\n- Check the password before the session is made', base: 'main', draft: false });
});

test('without gh, pull requests say how to get them — and the branch can still be compared with its base', async ({ page }) => {
  await page.goto('/tests/extension.html?page=git/panel&tab=pulls&gh=off');
  await expect(page.getByText('Install the GitHub CLI (gh)')).toBeVisible();
  await page.getByRole('button', { name: /Compare feature\/login with its base/ }).click();
  await expect(page.getByText('Check the password before the session is made')).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Compare with' })).toContainText('origin/main');
});

test('a folder in no repository is offered git init', async ({ page }) => {
  await page.goto('/tests/extension.html?page=git/panel&repo=none');
  await expect(page.getByText("This chat's folder is not in a git repository.")).toBeVisible();
  await page.getByRole('button', { name: 'Make it one (git init)' }).click();
  expect(await calls(page)).toEqual([{ url: '/init', body: {} }]);
});

test('amending with nothing staged changes only the last commit: the unstaged work is not swept into it', async ({ page }) => {
  await page.goto('/tests/extension.html?page=git/panel');
  await page.getByRole('button', { name: 'Unstage everything' }).click();
  await page.getByRole('checkbox', { name: 'Amend' }).check();
  await page.getByRole('textbox', { name: 'Commit message' }).fill('Better words');
  await page.getByRole('button', { name: 'Amend', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: 'Amend' })).not.toBeChecked();
  expect((await calls(page)).map((c) => c.url)).toEqual(['/unstage', '/commit']);
  expect((await calls(page))[1].body).toEqual({ message: 'Better words', amend: true });
});

test('a renamed file with more changes is staged by its new name, and unstaged with its old one', async ({ page }) => {
  await page.goto('/tests/extension.html?page=git/panel&rename=1');
  await page.getByRole('button', { name: 'Stage token.ts', exact: true }).click();
  await expect.poll(() => calls(page)).toEqual([{ url: '/stage', body: { paths: ['src/auth/token.ts'] } }]);
  await page.getByRole('button', { name: 'Unstage token.ts', exact: true }).click();
  await expect.poll(async () => (await calls(page))[1]).toEqual({ url: '/unstage', body: { paths: ['src/auth/token.ts', 'src/auth/jwt.ts'] } });
});

test("a file in conflict is shown a column per side: ours, theirs, and git's markers", async ({ page }) => {
  await page.goto('/tests/extension.html?page=git/panel&conflict=1');
  await expect(page.getByText('Merging —')).toBeVisible();
  await row(page, 'a.txt').click();
  const table = page.getByRole('table', { name: 'Changes to a.txt' });
  const ours = table.locator('[role=row]', { hasText: 'TWO main' });
  await expect(ours).toHaveAttribute('data-kind', 'add');
  // Ours: line 2 before, line 3 now — not a line of context that reads "+TWO main".
  // The sign is drawn, and said in words as well.
  await expect(ours).toHaveText(/^2\s*3\s*\+\s*addedTWO main$/);
  await expect(table.locator('[role=row]', { hasText: 'TWO side' })).toHaveText(/^\s*5\s*\+\s*added\s*TWO side$/);
  await expect(table.locator('[data-kind=add]')).toHaveCount(6);
});

test('what changed is shown at once, however long GitHub takes to answer', async ({ page }) => {
  await page.goto('/tests/extension.html?page=git/panel&ghslow=1&tab=pulls');
  await expect(page.getByText('Asking GitHub…')).toBeVisible();
  await page.getByRole('tab', { name: 'Changes' }).click();
  await expect(page.getByText('session.ts')).toBeVisible({ timeout: 1500 });
  await page.getByRole('tab', { name: 'Pull requests' }).click();
  await expect(page.getByText('Dark mode for the settings')).toBeVisible({ timeout: 8000 });
});

test('in a chat whose folder is part of the repository, only its own files are offered to open in Files', async ({ page }) => {
  await page.goto('/tests/extension.html?page=git/panel&prefix=src');
  await expect(page.getByRole('button', { name: 'Open session.ts in Files' })).toBeAttached();
  // README.md is at the repository's top, outside src/: Files does not show it.
  await expect(page.getByText('README.md')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open README.md in Files' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Open session.ts in Files' }).click();
  await expect(page.getByTestId('opened')).toHaveText('auth/session.ts');
});

test('patches stopped half way are called that, not a rebase', async ({ page }) => {
  await page.goto('/tests/extension.html?page=git/panel&op=am');
  await expect(page.getByRole('status').filter({ hasText: 'Applying patches' })).toBeVisible();
});

test('a stash is acted on by what it is, not only by its place in the list', async ({ page }) => {
  await page.goto('/tests/extension.html?page=git/panel');
  await page.getByRole('button', { name: /1 stash/ }).click();
  await page.getByRole('button', { name: 'Drop this stash' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Drop' }).click();
  await expect.poll(() => calls(page)).toEqual([{ url: '/stashes/drop', body: { ref: 'stash@{0}', sha: '5'.repeat(40) } }]);
});

test('each question is asked once: a comparison when opened, the branches when one is made', async ({ page }) => {
  const asked = (what: string) => page.evaluate((w) => (window as any).gitCalls.filter((c: any) => c.method === 'GET' && c.url.split('?')[0].endsWith(w)).length, what);
  await page.goto('/tests/extension.html?page=git/panel&tab=history');
  await page.getByText('Compare this branch with its base').click();
  await expect(page.getByRole('combobox', { name: 'Compare with' })).toContainText('origin/main');
  await page.waitForTimeout(500);
  expect(await asked('/compare')).toBe(1);
  await page.getByRole('tab', { name: 'Branches' }).click();
  await expect(page.getByText('old/experiment')).toBeVisible();
  const before = await asked('/branches');
  await page.getByRole('textbox', { name: 'Name of the new branch' }).fill('fix/once');
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page.locator('[data-git-tab]').getByText('fix/once').first()).toBeVisible();
  await page.waitForTimeout(500);
  expect(await asked('/branches') - before).toBe(1);
});

test("a pull request is filled in against the repository's own default branch — upstream/main in a fork — and says so when it cannot be", async ({ page }) => {
  await page.goto('/tests/extension.html?page=git/panel&tab=branches');
  await page.getByRole('textbox', { name: 'Name of the new branch' }).fill('feature/export');
  await page.getByRole('button', { name: 'Create' }).click();
  await page.getByRole('tab', { name: 'Pull requests' }).click();
  await page.getByRole('button', { name: 'Open a pull request for feature/export' }).click();
  await expect(page.getByRole('textbox', { name: 'Title of the pull request' })).not.toHaveValue('');
  const compared = await page.evaluate(() => (window as any).gitCalls.filter((c: any) => c.url.includes('/compare')).map((c: any) => c.url));
  expect(compared.at(-1)).toContain('base=upstream%2Fmain');

  // What was typed into the form above is kept for the chat, and would open it here already.
  await page.evaluate(() => sessionStorage.clear());
  await page.goto('/tests/extension.html?page=git/panel&tab=branches&comparefail=1');
  await page.getByRole('textbox', { name: 'Name of the new branch' }).fill('feature/export');
  await page.getByRole('button', { name: 'Create' }).click();
  await page.getByRole('tab', { name: 'Pull requests' }).click();
  await page.getByRole('button', { name: 'Open a pull request for feature/export' }).click();
  await expect(page.getByText('Not filled in: upstream/main and HEAD have nothing in common')).toBeVisible();
});

test('once opened, the pull request is the branch’s — no second offer to open it, even where gh named no number', async ({ page }) => {
  // With a number the pull request is shown, and the list drawn anew behind
  // it; without one nothing is shown, and the list was left offering it.
  await page.goto('/tests/extension.html?page=git/panel&tab=branches&prurl=odd');
  await page.getByRole('textbox', { name: 'Name of the new branch' }).fill('feature/export');
  await page.getByRole('button', { name: 'Create' }).click();
  await page.getByRole('tab', { name: 'Pull requests' }).click();
  await page.getByRole('button', { name: 'Open a pull request for feature/export' }).click();
  await page.getByRole('textbox', { name: 'Title of the pull request' }).fill('Export to CSV');
  await page.getByRole('button', { name: 'Open', exact: true }).click();
  await expect(page.getByRole('button', { name: /Export to CSV/ }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: /Open a pull request for/ })).toHaveCount(0);
});

test('a history that failed once shows the commits when asked again, not the old error', async ({ page }) => {
  await page.goto('/tests/extension.html?page=git/panel&tab=history&logfail=1');
  await expect(page.getByRole('alert')).toContainText('index.lock');
  await page.evaluate(() => (window as any).moveHead());
  await expect(page.getByText('Add the login form')).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('Refresh reads the state once', async ({ page }) => {
  await page.goto('/tests/extension.html?page=git/panel');
  await expect(page.getByText('session.ts')).toBeVisible();
  const states = () => page.evaluate(() => (window as any).gitCalls.filter((c: any) => c.method === 'GET' && c.url === '/api/x/pithagoras-git/chats/s').length);
  const before = await states();
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Refreshing' })).toHaveCount(0);
  await page.waitForTimeout(300);
  expect((await states()) - before).toBe(1);
});

test('a commit message and the Amend box are still there after a diff was opened over them, and after a reload', async ({ page }) => {
  await page.goto('/tests/extension.html?page=git/panel');
  await page.getByRole('textbox', { name: 'Commit message' }).fill('Words worth keeping');
  await page.getByRole('checkbox', { name: 'Amend' }).check();
  await row(page, 'session.ts').click();
  await expect(page.getByRole('table', { name: 'Changes to src/auth/session.ts' })).toBeVisible();
  await page.getByRole('button', { name: 'Back' }).click();
  await expect(page.getByRole('textbox', { name: 'Commit message' })).toHaveValue('Words worth keeping');
  await expect(page.getByRole('checkbox', { name: 'Amend' })).toBeChecked();
  await page.reload();
  await expect(page.getByRole('textbox', { name: 'Commit message' })).toHaveValue('Words worth keeping');
  // Sent, it is not kept for the next time.
  await page.getByRole('button', { name: /^Amend with/ }).click();
  await expect(page.getByRole('textbox', { name: 'Commit message' })).toHaveValue('');
  await page.reload();
  await expect(page.getByRole('textbox', { name: 'Commit message' })).toHaveValue('');
  await expect(page.getByRole('checkbox', { name: 'Amend' })).not.toBeChecked();
});

test('a comment on a pull request survives looking at one of its files', async ({ page }) => {
  await page.goto('/tests/extension.html?page=git/panel&tab=pulls');
  await page.getByRole('button', { name: /Login with a password/ }).last().click();
  await page.getByRole('textbox', { name: 'Comment on the pull request' }).fill('One question about line 12');
  await page.getByRole('button', { name: /login\.ts/ }).first().click();
  await expect(page.getByRole('table', { name: 'Changes to src/auth/login.ts' })).toBeVisible();
  await page.getByRole('button', { name: 'Back' }).click();
  await expect(page.getByRole('textbox', { name: 'Comment on the pull request' })).toHaveValue('One question about line 12');
  await page.reload();
  await page.getByRole('button', { name: /Login with a password/ }).last().click();
  await expect(page.getByRole('textbox', { name: 'Comment on the pull request' })).toHaveValue('One question about line 12');
  await page.getByRole('button', { name: 'Comment', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Comment on the pull request' })).toHaveValue('');
});

test('the form that opens a pull request survives a comparison looked at over it, and is gone once cancelled', async ({ page }) => {
  await page.goto('/tests/extension.html?page=git/panel&tab=branches');
  await page.getByRole('textbox', { name: 'Name of the new branch' }).fill('feature/export');
  await page.getByRole('button', { name: 'Create' }).click();
  await page.getByRole('tab', { name: 'Pull requests' }).click();
  await page.getByRole('button', { name: 'Open a pull request for feature/export' }).click();
  await page.getByRole('textbox', { name: 'Title of the pull request' }).fill('Export to CSV');
  await page.getByRole('checkbox', { name: 'Draft' }).check();
  await page.getByRole('button', { name: /Compare feature\/export with its base/ }).click();
  await expect(page.getByText('Add the login form').first()).toBeVisible();
  await page.getByRole('button', { name: 'Back' }).click();
  await expect(page.getByRole('textbox', { name: 'Title of the pull request' })).toHaveValue('Export to CSV');
  await expect(page.getByRole('checkbox', { name: 'Draft' })).toBeChecked();
  // Cancelled, it is gone.
  await page.getByRole('button', { name: 'Cancel' }).click();
  await page.reload();
  await page.getByRole('textbox', { name: 'Name of the new branch' }).fill('feature/export');
  await page.getByRole('button', { name: 'Create' }).click();
  await page.getByRole('tab', { name: 'Pull requests' }).click();
  await expect(page.getByRole('button', { name: 'Open a pull request for feature/export' })).toBeVisible();
});

test('a branch deleted anyway leaves the list', async ({ page }) => {
  await page.goto('/tests/extension.html?page=git/panel&tab=branches&unmerged=1');
  await expect(page.getByRole('button', { name: /old\/experiment/ }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Delete old/experiment', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete anyway' }).click();
  await expect(page.getByRole('button', { name: /old\/experiment/ })).toHaveCount(0);
  expect((await calls(page)).map((c) => c.body)).toEqual([{ name: 'old/experiment', force: false }, { name: 'old/experiment', force: true }]);
});

test('a double click on Older commits loads one page, and the next page follows the first', async ({ page }) => {
  await page.goto('/tests/extension.html?page=git/panel&tab=history&many=1');
  await expect(page.getByText('Commit number 0', { exact: true })).toBeVisible();
  const older = page.getByRole('button', { name: 'Older commits…' });
  await older.dblclick();
  await expect(page.getByText('Commit number 199', { exact: true })).toBeVisible();
  await expect(older).toBeEnabled();
  const skips = await page.evaluate(() => (window as any).gitCalls.filter((c: any) => c.url.includes('/log?')).map((c: any) => c.url));
  expect(skips.filter((u: string) => u.includes('skip=100'))).toHaveLength(1);
  await expect(page.getByText('Commit number 150', { exact: true })).toHaveCount(1);
  await older.click();
  await expect(page.getByText('Commit number 249', { exact: true })).toBeVisible();
  await expect(page.getByText('Commit number 200', { exact: true })).toHaveCount(1);
});

test('a comparison that fails shows no commits or files of the one before, whose base they were against', async ({ page }) => {
  await page.goto('/tests/extension.html?page=git/panel&tab=history');
  await page.getByText('Compare this branch with its base').click();
  await expect(page.getByRole('button', { name: /login\.ts/ })).toBeVisible();
  await page.getByRole('combobox', { name: 'Compare with' }).click();
  await page.getByRole('option', { name: 'old/experiment' }).click();
  await expect(page.getByRole('alert')).toContainText('old/experiment and HEAD have nothing in common');
  await expect(page.getByRole('button', { name: /login\.ts/ })).toHaveCount(0);
  await expect(page.getByText('Add the login form')).toHaveCount(0);
});

test('the diff of a file in conflict offers no Discard, and says Mark resolved where the row does', async ({ page }) => {
  await page.goto('/tests/extension.html?page=git/panel&conflict=1');
  await row(page, 'a.txt').click();
  await expect(page.getByRole('table', { name: 'Changes to a.txt' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Discard' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Stage', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Mark resolved' }).click();
  expect(await calls(page)).toEqual([{ url: '/stage', body: { paths: ['a.txt'] } }]);
  // Any other file still can.
  await page.goto('/tests/extension.html?page=git/panel&conflict=1');
  await row(page, 'session.ts').click();
  await expect(page.getByRole('button', { name: 'Discard' })).toBeVisible();
});

test('the files of a pull request are listed as a commit’s are: the letter says what happened, a rename shows where it came from, a deleted file is struck through', async ({ page }) => {
  await page.goto('/tests/extension.html?page=git/panel&tab=pulls&prfiles=1');
  await page.getByRole('button', { name: /Login with a password/ }).last().click();
  const renamed = page.getByRole('button', { name: /token\.ts/ });
  await expect(renamed).toHaveAttribute('title', 'src/auth/jwt.ts → src/auth/token.ts');
  await expect(renamed.getByTitle('Renamed')).toHaveText('R');
  const deleted = page.getByRole('button', { name: /old\.ts/ });
  await expect(deleted.getByTitle('Deleted')).toHaveText('D');
  await expect(deleted.locator('.line-through')).toHaveText('old.ts');
  // The file opens as before: the diff is the pull request's, not a second request.
  await deleted.click();
  await expect(page.getByRole('table', { name: 'Changes to src/auth/old.ts' })).toBeVisible();
});

test('only the last file of a cut-off pull request diff says it was cut off', async ({ page }) => {
  await page.goto('/tests/extension.html?page=git/panel&tab=pulls&prtruncated=1');
  await page.getByRole('button', { name: /Login with a password/ }).last().click();
  await page.getByRole('button', { name: /login\.ts/ }).first().click();
  await expect(page.getByRole('table', { name: 'Changes to src/auth/login.ts' })).toBeVisible();
  await expect(page.getByText('This diff is too large to show whole')).toHaveCount(0);
  await page.getByRole('button', { name: 'Back' }).click();
  await page.getByRole('button', { name: /session\.ts/ }).first().click();
  await expect(page.getByText('This diff is too large to show whole')).toBeVisible();
});

test("a pull request from a fork's branch of the same name can be checked out; the branch's own cannot", async ({ page }) => {
  await page.goto('/tests/extension.html?page=git/panel&tab=pulls&fork=1');
  await page.getByRole('button', { name: /Fix a typo from a fork/ }).click();
  await expect(page.getByRole('button', { name: 'Check out' })).toBeVisible();
  await page.goto('/tests/extension.html?page=git/panel&tab=pulls');
  await page.getByRole('button', { name: /Login with a password/ }).last().click();
  await expect(page.getByText('Login with a password').first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Check out' })).toHaveCount(0);
});

test('a large diff shows its first rows, and the rest as asked', async ({ page }) => {
  await page.goto('/tests/extension.html?page=git/panel&bigdiff=1');
  await row(page, 'session.ts').click();
  const table = page.getByRole('table', { name: 'Changes to src/auth/session.ts' });
  // The hunk header is a row too; the one that names the columns for a screen reader is not drawn.
  const rows = table.locator('[role=row]:not(.sr-only)');
  await expect(rows).toHaveCount(3000);
  await expect(page.getByText('3000 of 6501 lines shown')).toBeVisible();
  await page.getByRole('button', { name: 'Show more' }).click();
  await expect(rows).toHaveCount(6000);
  await page.getByRole('button', { name: 'Show more' }).click();
  await expect(rows).toHaveCount(6501);
  await expect(page.getByRole('button', { name: 'Show more' })).toHaveCount(0);
});

test('a pull request list that failed is asked again, not left as Loading', async ({ page }) => {
  await page.goto('/tests/extension.html?page=git/panel&tab=pulls&pullsfail=1');
  await expect(page.getByRole('alert')).toContainText('GitHub is not answering');
  // No way to dismiss it into a list that is neither there nor failed.
  await expect(page.getByRole('button', { name: 'Dismiss' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByText('Dark mode for the settings')).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('a branch whose pull request GitHub could not be asked about is not offered a second one', async ({ page }) => {
  await page.goto('/tests/extension.html?page=git/panel&tab=pulls&currentfail=1&branch=feature/export');
  await expect(page.getByText('Could not ask GitHub about this branch: gh timed out')).toBeVisible();
  await expect(page.getByRole('button', { name: /Open a pull request for/ })).toHaveCount(0);
});

test('the files of a pull request whose diff failed say so, and do not say there are none', async ({ page }) => {
  await page.goto('/tests/extension.html?page=git/panel&tab=pulls&prdifffail=1');
  await page.getByRole('button', { name: /Login with a password/ }).last().click();
  await expect(page.getByRole('alert')).toContainText('gh pr diff failed');
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
});

test('once the repository cannot be read, what is shown is said to be old', async ({ page }) => {
  await page.goto('/tests/extension.html?page=git/panel');
  await expect(page.getByText('session.ts')).toBeVisible();
  await page.evaluate(() => {
    (window as any).stateFails = true;
    (window as any).moveHead();
  });
  await expect(page.getByRole('alert')).toContainText('what is shown may be out of date: The portal could not be reached');
  await expect(page.getByText('session.ts')).toBeVisible();
  await page.evaluate(() => ((window as any).stateFails = false));
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('a clone inside the chat\'s folder can be picked, and everything the panel does then is that repository\'s', async ({ page }) => {
  await page.goto('/tests/extension.html?page=git/panel&nested=1');
  const picker = page.getByRole('combobox', { name: 'Repository' });
  await expect(picker).toBeVisible();
  await expect(page.getByText('session.ts')).toBeVisible();
  await picker.click();
  await page.getByRole('option', { name: 'tools/lib' }).click();
  await expect(page.getByText('lib.ts')).toBeVisible();
  await expect(page.getByText('session.ts')).toHaveCount(0);
  await expect(page.getByTitle(/On trunk/)).toBeVisible();
  // Its files are in the chat's folder under the clone's name, which is where Files has them.
  await page.getByRole('button', { name: 'Open lib.ts in Files' }).click();
  await expect(page.getByTestId('opened')).toHaveText('tools/lib/src/lib.ts');
  await page.getByRole('button', { name: 'Stage lib.ts' }).click();
  expect(await calls(page)).toEqual([{ url: '/stage?repo=tools%2Flib', body: { paths: ['src/lib.ts'] } }]);
  // The pick is kept for the chat.
  await page.reload();
  await expect(page.getByText('lib.ts')).toBeVisible();
  await expect(page.getByTitle(/On trunk/)).toBeVisible();
});

test('a folder in no repository of its own shows the clone in it, without a click', async ({ page }) => {
  await page.goto('/tests/extension.html?page=git/panel&repo=none&nested=1');
  // Nothing to click: the only repository there is, is the one shown.
  await expect(page.getByText('lib.ts')).toBeVisible();
  await expect(page.getByText('This chat\'s folder is not in a git repository.')).toHaveCount(0);
});

test('with one repository, nothing is offered to pick', async ({ page }) => {
  await page.goto('/tests/extension.html?page=git/panel');
  await expect(page.getByText('session.ts')).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Repository' })).toHaveCount(0);
});

test('GitHub\'s late answer for the repository left is not taken for the one picked', async ({ page }) => {
  // The folder's own repository is asked first and answers after four seconds; the clone picked meanwhile answers at once.
  await page.goto('/tests/extension.html?page=git/panel&nested=1&ghslow=1&tab=pulls');
  const picker = page.getByRole('combobox', { name: 'Repository' });
  await picker.click();
  await page.getByRole('option', { name: 'tools/lib' }).click();
  await expect(page.getByText(/On trunk — switch to a branch of your own/)).toBeVisible();
  // Past the slow answer: it must not have replaced the clone's (whose default branch is trunk, not main).
  await page.waitForTimeout(4500);
  await expect(page.getByText(/On trunk — switch to a branch of your own/)).toBeVisible();
});

test('a folder in no repository that holds a clone can still be made a repository', async ({ page }) => {
  await page.goto('/tests/extension.html?page=git/panel&repo=none&nested=1');
  await expect(page.getByText('lib.ts')).toBeVisible();
  const picker = page.getByRole('combobox', { name: 'Repository' });
  await picker.click();
  await page.getByRole('option', { name: '.', exact: true }).click();
  await expect(page.getByText('This chat\'s folder is not in a git repository.')).toBeVisible();
  await expect(picker).toBeVisible();
  await page.getByRole('button', { name: 'Make it one (git init)' }).click();
  expect(await calls(page)).toEqual([{ url: '/init', body: {} }]);
  // And back to the clone, which is still there to pick.
  await picker.click();
  await page.getByRole('option', { name: 'tools/lib' }).click();
  await expect(page.getByText('lib.ts')).toBeVisible();
});
