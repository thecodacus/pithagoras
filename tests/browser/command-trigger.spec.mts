import { type Page } from '@playwright/test';
import { test, expect, mockPortal } from './portal-mock';

const session = { id: 'demo', title: 'Typing a command', workspace: '/workspaces/demo', status: 'idle', kind: 'task', pinned: false };
const other = { id: 'other', title: 'Another chat', workspace: '/workspaces/demo', status: 'idle', kind: 'task', pinned: false };
const commands = [
  { name: 'compact', description: 'Summarise the conversation', source: 'builtin', where: 'server' },
  { name: 'settings', description: 'Open settings', source: 'builtin', where: 'client' },
  { name: 'skill:review', description: 'Review the change', source: 'skill' },
  { name: 'skill:release', description: 'Cut a release', source: 'skill' },
];

/** The portal with no server: chats with commands, and what is sent to them kept in `prompts`, with the pictures that went along in `images`. */
async function portal(page: Page, opts: { listAfter?: Promise<void> } = {}) {
  const prompts: string[] = [];
  const images: unknown[] = [];
  /** Whether a command that did not exist before is now among them: what a run can add. */
  const added = { fresh: false };
  const chats = [session, other];
  await mockPortal(page, async ({ path: p, json }) => {
    if (p === '/api/sessions') return { sessions: chats, executor: 'host' };
    const chat = chats.find((c) => p === `/api/sessions/${c.id}`);
    if (chat) return chat;
    if (p.endsWith('/commands')) {
      await opts.listAfter;
      return { commands: added.fresh ? [...commands, { name: 'skill:fresh', description: 'Written in the last run', source: 'skill' }] : commands };
    }
    if (p.endsWith('/prompt')) {
      const sent = json();
      prompts.push(sent.message);
      images.push(sent.images);
      return { ok: true };
    }
    if (p.endsWith('/config')) return { live: false, state: { model: { id: 'test', name: 'Test', provider: 'local' }, thinkingLevel: 'medium' }, stats: null, thinking: { levels: [] }, models: { models: [] } };
  }, { streams: 'open', setup: 'skipped', settings: true });
  // Out of the way, so the sidebar's chats are not what the test reaches for.
  await page.addInitScript(() => localStorage.setItem('sidebarCollapsed', 'true'));
  return { prompts, images, added };
}

const box = (page: Page) => page.getByLabel('Message', { exact: true });
/** Typed and sent with Enter, once the box can take it: the last message has left it, and the send button is back. */
const say = async (page: Page, text: string) => {
  await box(page).fill(text);
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled();
  await box(page).press('Enter');
};
const palette = (page: Page) => page.getByRole('listbox', { name: 'Commands' });

test('the command character is set under This browser, and kept', async ({ page }) => {
  await portal(page);
  await page.goto('/settings/browser');
  const dialog = page.getByRole('dialog');
  const field = dialog.getByLabel('Command character', { exact: true });
  await expect(field).toHaveValue('/');
  await expect(dialog.getByRole('button', { name: 'Reset', exact: true })).toBeDisabled();
  await expect(dialog.getByText('Type / in the message box to see the commands, or /skill:name to run a skill.')).toBeVisible();

  // Typed over the old one.
  await field.fill('!');
  await expect(dialog.getByText('Type ! in the message box to see the commands, or !skill:name to run a skill.')).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('commandTrigger'))).toBe('!');
  await expect(dialog.getByRole('button', { name: 'Reset', exact: true })).toBeEnabled();

  // A letter would open the list for every message: said so, and not taken.
  await field.pressSequentially('a');
  await expect(dialog.getByRole('alert')).toContainText('That cannot be it');
  expect(await page.evaluate(() => localStorage.getItem('commandTrigger'))).toBe('!');
  // Left, it shows the one in use again.
  await dialog.getByRole('heading', { name: 'Command character' }).click();
  await expect(field).toHaveValue('!');
  await expect(dialog.getByRole('alert')).toHaveCount(0);

  await page.reload();
  await expect(page.getByRole('dialog').getByLabel('Command character', { exact: true })).toHaveValue('!');
  // The shortcuts list says which character jumps to the message box.
  await page.goto('/settings/shortcuts');
  await expect(page.getByRole('list', { name: 'Chat shortcuts' }).getByRole('listitem').first()).toContainText('!');

  await page.goto('/settings/browser');
  await page.getByRole('dialog').getByRole('button', { name: 'Reset', exact: true }).click();
  await expect(page.getByRole('dialog').getByLabel('Command character', { exact: true })).toHaveValue('/');
  expect(await page.evaluate(() => localStorage.getItem('commandTrigger'))).toBeNull();
});

test('a character typed before the old one counts, and a letter there is refused', async ({ page }) => {
  await portal(page);
  await page.goto('/settings/browser');
  const dialog = page.getByRole('dialog');
  const field = dialog.getByLabel('Command character', { exact: true });
  // The caret at the left edge, nothing selected: as when the field is clicked again, or tapped.
  await field.click();
  await field.press('Home');
  await field.pressSequentially('!');
  await expect(field).toHaveValue('!');
  expect(await page.evaluate(() => localStorage.getItem('commandTrigger'))).toBe('!');

  await field.press('Home');
  await field.pressSequentially('a');
  await expect(dialog.getByRole('alert')).toContainText('That cannot be it');
  expect(await page.evaluate(() => localStorage.getItem('commandTrigger'))).toBe('!');
});

test('a setting is found by what it does', async ({ page }) => {
  await portal(page);
  await page.goto('/settings/general');
  await page.getByRole('combobox', { name: 'Search settings' }).fill('trigger');
  await page.getByRole('option').first().click();
  await expect(page.getByRole('dialog').getByLabel('Command character', { exact: true })).toBeVisible();
});

test('with the slash as the character, nothing is different', async ({ page }) => {
  const { prompts } = await portal(page);
  await page.goto('/s/demo');
  await box(page).fill('/skill:rev');
  await expect(palette(page).getByRole('option')).toHaveText([/\/skill:review/]);
  await box(page).press('Enter');
  await expect.poll(() => prompts).toEqual(['/skill:review']);
  // A message that only starts with a path is still one.
  await box(page).fill('/etc/hosts is wrong');
  await expect(palette(page)).toHaveCount(0);
  await say(page, '/etc/hosts is wrong');
  await expect.poll(() => prompts).toEqual(['/skill:review', '/etc/hosts is wrong']);
});

test.describe('with another character', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('commandTrigger', '!'));
  });

  test('it opens the same list, and the slash does not', async ({ page }) => {
    await portal(page);
    await page.goto('/s/demo');
    await box(page).fill('/');
    await page.waitForTimeout(300);
    await expect(palette(page)).toHaveCount(0);

    await box(page).fill('!');
    await expect(palette(page).getByRole('option')).toHaveCount(commands.length);
    await expect(palette(page).getByRole('option').first()).toContainText('!compact');
    await box(page).fill('!skill:');
    await expect(palette(page).getByRole('option')).toHaveText([/!skill:review/, /!skill:release/]);
    // Tab completes it in the same form, ready for what the command takes.
    await box(page).press('Tab');
    await expect(box(page)).toHaveValue('!skill:review ');
  });

  test('the character from anywhere on the page opens the box with the list', async ({ page }) => {
    await portal(page);
    await page.goto('/s/demo');
    await expect(box(page)).toBeVisible();
    await page.keyboard.press('/');
    await expect(box(page)).not.toBeFocused();
    await page.keyboard.press('!');
    await expect(box(page)).toBeFocused();
    await expect(box(page)).toHaveValue('!');
    await expect(palette(page).getByRole('option')).toHaveCount(commands.length);
  });

  test('a skill is sent as pi knows it, from the list and typed out, and a message is still a message', async ({ page }) => {
    const { prompts } = await portal(page);
    await page.goto('/s/demo');
    await say(page, '!skill:rev');
    await expect.poll(() => prompts).toEqual(['/skill:review']);

    await say(page, '!skill:release the new version\nto everyone');
    await expect.poll(() => prompts).toEqual(['/skill:review', '/skill:release the new version\nto everyone']);

    // The old way still reaches pi as the command it is.
    await say(page, '/compact');
    await expect.poll(() => prompts).toEqual(['/skill:review', '/skill:release the new version\nto everyone', '/compact']);

    // What starts with the character and is no command is said as it was written.
    await say(page, '!important: the build is red');
    await expect.poll(() => prompts.at(-1)).toBe('!important: the build is red');
    expect(prompts).toHaveLength(4);
  });

  test('a command typed before the list has come is waited for, not said to the agent', async ({ page }) => {
    let listed!: () => void;
    const { prompts } = await portal(page, { listAfter: new Promise<void>((resolve) => (listed = resolve)) });
    await page.goto('/s/demo');
    await say(page, '!skill:review the diff');
    await page.waitForTimeout(300);
    expect(prompts).toEqual([]);
    listed();
    await expect.poll(() => prompts).toEqual(['/skill:review the diff']);
  });

  test('what is typed while the list is awaited stays in the box, and the message is not sent twice', async ({ page }) => {
    let listed!: () => void;
    const { prompts } = await portal(page, { listAfter: new Promise<void>((resolve) => (listed = resolve)) });
    await page.goto('/s/demo');
    await say(page, '!skill:review the diff');
    // Out of the box at once, as a message is.
    await expect(box(page)).toHaveValue('');
    await box(page).pressSequentially('and the tests');
    await page.waitForTimeout(300);
    listed();
    await expect.poll(() => prompts).toEqual(['/skill:review the diff']);
    await page.waitForTimeout(300);
    await expect(box(page)).toHaveValue('and the tests');
    expect(prompts).toEqual(['/skill:review the diff']);
  });

  test('the box of another chat is left alone while the list is awaited', async ({ page }) => {
    let listed!: () => void;
    const { prompts } = await portal(page, { listAfter: new Promise<void>((resolve) => (listed = resolve)) });
    await page.goto('/s/other');
    await box(page).fill('draft in the other chat');
    await page.getByRole('button', { name: 'Expand sidebar' }).click();
    await page.getByLabel('Sidebar', { exact: true }).getByText('Typing a command').click();
    // The chat is the one open when its title is the page's: the box is its own from then on.
    await expect(page.getByRole('heading', { level: 2, name: 'Typing a command' })).toBeVisible();
    await say(page, '!skill:review the diff');
    await page.getByLabel('Sidebar', { exact: true }).getByText('Another chat').click();
    await expect(page.getByRole('heading', { level: 2, name: 'Another chat' })).toBeVisible();
    await expect(box(page)).toHaveValue('draft in the other chat');
    listed();
    await expect.poll(() => prompts).toEqual(['/skill:review the diff']);
    await page.waitForTimeout(300);
    await expect(box(page)).toHaveValue('draft in the other chat');
  });

  test('a picture waits in the box through a command that turns out to be one, and goes with a message that does not', async ({ page }) => {
    let listed!: () => void;
    const { prompts, images } = await portal(page, { listAfter: new Promise<void>((resolve) => (listed = resolve)) });
    await page.goto('/s/demo');
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
    await page.locator('input[type=file]').first().setInputFiles({ name: 'photo.png', mimeType: 'image/png', buffer: png });
    await expect(page.getByRole('button', { name: 'Remove photo.png' })).toBeVisible();
    await say(page, '!skill:review the diff');
    listed();
    await expect.poll(() => prompts).toEqual(['/skill:review the diff']);
    // A command is run, not said: the picture is where it was, and did not go.
    await expect(page.getByRole('button', { name: 'Remove photo.png' })).toBeVisible();
    expect(images).toEqual([undefined]);
    // The same, with words that are not a command: the picture goes with them.
    await say(page, '!important: look at this');
    await expect.poll(() => prompts.length).toBe(2);
    expect(images[1]).toHaveLength(1);
    await expect(page.getByRole('button', { name: 'Remove photo.png' })).toHaveCount(0);
  });

  test('a command a run has just added is one when it is sent, however it got into the box', async ({ page }) => {
    const { prompts, added } = await portal(page);
    await page.goto('/s/demo');
    // The list is shown once, as it was before the run.
    await box(page).fill('!skill:rev');
    await expect(palette(page).getByRole('option')).toHaveCount(1);
    await box(page).fill('');
    // A run ends, and has written a skill.
    added.fresh = true;
    await expect.poll(() => page.evaluate(() => (window as any).streams.filter((s: any) => !s.closed).length)).toBeGreaterThan(0);
    await page.evaluate(() => {
      const stream = (window as any).streams.filter((s: any) => !s.closed).at(-1);
      stream.emit('caught-up', {});
      stream.emit('message', { seq: 1, type: 'turn_end', at: Date.now(), payload: {} });
    });
    // Events are applied a frame at a time, and the run is over for the page once its end is drawn: a person pastes later than that, a script need not.
    await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
    // Pasted whole: never typed as a bare name, so nothing has asked for the new list.
    await say(page, '!skill:fresh go');
    await expect.poll(() => prompts).toEqual(['/skill:fresh go']);
  });

  test('a command that is the portal\'s own is run here at once, without the list and in the chat it was typed in', async ({ page }) => {
    // The list never comes: pi's command list is none of its business.
    const { prompts } = await portal(page, { listAfter: new Promise<void>(() => {}) });
    await page.goto('/s/demo');
    await say(page, '!settings');
    // /settings opens the dialog: it is never sent to pi, nor said in the chat.
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page).toHaveURL(/\/s\/demo\/settings\//);
    expect(prompts).toEqual([]);
    await expect(box(page)).toHaveValue('');
  });

  test('what is sent while a command waits for the list goes after it', async ({ page }) => {
    let listed!: () => void;
    const { prompts } = await portal(page, { listAfter: new Promise<void>((resolve) => (listed = resolve)) });
    await page.goto('/s/demo');
    await say(page, '!skill:review the diff');
    await say(page, 'and then this');
    await say(page, '!important: and this');
    await page.waitForTimeout(300);
    expect(prompts).toEqual([]);
    listed();
    await expect.poll(() => prompts).toEqual(['/skill:review the diff', 'and then this', '!important: and this']);
  });
});
