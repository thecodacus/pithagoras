import { test, expect } from './portal-mock';
import { settled } from './settled';
import { readFileSync } from 'node:fs';
const sample = readFileSync(new URL('../fixtures/jfk.wav', import.meta.url));
// A 2×2 PNG, as a picture from the phone or the folder would be.
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==', 'base64');

test.beforeEach(async ({ page }) => {
  await page.route('**/api/browser', route => route.fulfill({ json: { running: false, sessions: [], install: { container: 'stopped' } } }));
  await page.route('**/api/sessions/test/commands', route => route.fulfill({ json: { commands: [] } }));
  await page.route('**/api/sessions/test/config', route => route.fulfill({ status: 503, json: {} }));
  await page.route('**/api/voice', route => route.fulfill({ json: { enabled: true } }));
  await page.route('**/test-speech.wav', route => route.fulfill({ body: sample, contentType: 'audio/wav' }));
  await page.route('**/voice/speech', route => route.fulfill({ body: sample, contentType: 'audio/wav' }));
  await page.route('**/api/sessions/test/picture?**', route => route.fulfill({ body: png, contentType: 'image/png' }));
  await page.route('**/api/sessions/test/files?**', route => route.fulfill({ json: { path: 'src', entries: [{ name: 'app.ts', type: 'file', size: 3, mtime: 1 }], truncated: false } }));
  await page.route('**/api/sessions/test/file?**', route => route.fulfill({ json: { binary: false, size: 3, mtime: 1, content: 'abc' } }));
});

async function start(page: import('@playwright/test').Page) {
  await page.goto('/tests/voice.html');
  await page.getByRole('button', { name: 'Turn on hands-free voice' }).click();
  await expect(page.getByRole('button', { name: 'End voice mode' })).toBeVisible({ timeout: 25000 });
}

test('a picture goes with what is said next, and the agent can show one back', async ({ page }) => {
  const failures: string[] = [];
  page.on('pageerror', e => failures.push(e.message));
  await page.route('**/voice/transcribe', route => route.fulfill({ json: { text: 'What is in this picture?' } }));
  await start(page);
  await page.locator('.voice-stage input[type=file]').setInputFiles({ name: 'photo.png', mimeType: 'image/png', buffer: png });
  await expect(page.getByLabel('Pictures for your next message').getByRole('img', { name: 'photo.png' })).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Add a picture' })).toContainText('1');
  await page.getByRole('button', { name: 'Inject speech' }).click();
  await expect(page.getByTestId('sent')).toHaveText('1', { timeout: 12000 });
  await expect(page.getByTestId('last-send')).toHaveText(JSON.stringify({ message: 'What is in this picture?', images: 1, steer: false }));
  await expect(page.getByLabel('Pictures for your next message')).toBeHidden();

  await page.getByRole('button', { name: 'Show picture' }).click();
  const window = page.getByRole('region', { name: 'Pictures' });
  await expect(window.getByRole('img', { name: 'Sales by month' })).toBeVisible();
  await expect(window).toContainText('Sales by month');
  await page.getByRole('button', { name: 'Show picture' }).click();
  await expect(window).toContainText('2 / 2');
  await window.getByRole('button', { name: 'Previous picture' }).click();
  await expect(window).toContainText('1 / 2');
  await window.getByRole('button', { name: 'Minimize pictures' }).click();
  await expect(page.getByRole('button', { name: 'Show pictures' })).toBeVisible();
  expect(failures).toEqual([]);
});

test('a picture the agent had generated is drawn in the chat as a preview, and in the voice picture window', async ({ page }) => {
  const failures: string[] = [];
  page.on('pageerror', e => failures.push(e.message));
  const asked: string[] = [];
  await page.route('**/api/sessions/test/picture?**', route => { asked.push(new URL(route.request().url()).searchParams.get('path') ?? ''); return route.fulfill({ body: png, contentType: 'image/png' }); });
  await page.goto('/tests/voice.html');
  // In the chat: the picture in its preview, fetched from the chat's folder like one that was shown.
  await page.getByRole('button', { name: 'Generate picture' }).click();
  const thumbnail = page.getByTestId('workspace').getByRole('img', { name: 'A lighthouse at dusk' });
  await expect(thumbnail).toBeVisible();
  await expect.poll(() => asked).toContain('generated-images/image-20261001-101500-a1b2c3.png');
  // In place of the tool card, with the call under Details.
  await expect(page.getByTestId('workspace').getByRole('button', { name: 'Details' })).toBeVisible();
  await expect(page.getByTestId('workspace').getByRole('button', { name: /^generate_image/ })).toHaveCount(0);

  // In voice mode: the picture window opens on the next one, and keeps the earlier.
  await page.getByRole('button', { name: 'Turn on hands-free voice' }).click();
  await expect(page.getByRole('button', { name: 'End voice mode' })).toBeVisible({ timeout: 25000 });
  await page.getByRole('button', { name: 'Generate picture' }).click();
  const window = page.getByRole('region', { name: 'Pictures' });
  await expect(window.getByRole('img', { name: 'A lighthouse at dusk' })).toBeVisible();
  await expect(window).toContainText('A lighthouse at dusk');
  await expect(window).toContainText('2 / 2');
  expect(failures).toEqual([]);
});

test("in voice mode a card for generate_image leads to the pictures only when the portal's tool made one", async ({ page }) => {
  await start(page);
  // An extension's tool of that name: its card says what it does and opens nothing, whatever pictures there are.
  // A picture shown before is there to be opened wrongly; its window is put away.
  await page.getByRole('button', { name: 'Show picture' }).click();
  await page.getByRole('region', { name: 'Pictures' }).getByRole('button', { name: 'Minimize pictures' }).click();
  await page.getByRole('button', { name: "Call an extension's generate_image" }).click();
  const theirs = page.locator('.voice-tool-float', { hasText: 'A cat on a sofa' });
  await expect(theirs).toContainText('Making a picture');
  expect(await theirs.evaluate(card => card.tagName)).toBe('DIV');
  await expect(page.getByRole('button', { name: /Making a picture/ })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Pictures' })).toHaveCount(0);

  // The portal's own, once its picture is there: tapping the card shows it.
  await page.getByRole('button', { name: 'Generate picture' }).click();
  const ours = page.getByRole('button', { name: /Making a picture/ });
  await expect(ours).toHaveAttribute('title', 'Show the picture');
});

test("a generate_image card is the same element from its start to its end, only a button once its picture is there", async ({ page }) => {
  await start(page);
  // The real order: the call starts, the model works, and some time later the picture arrives.
  await page.getByRole('button', { name: 'Start generating a picture' }).click();
  const card = page.locator('.voice-tool-float', { hasText: 'A foggy harbour at first light' });
  await expect(card).toContainText('Making a picture');
  await expect(card).not.toHaveAttribute('role', 'button');
  await expect(card).not.toHaveAttribute('title', /.+/);
  // The element is marked, so that a new one drawn in its place would be told by not having the mark.
  await card.evaluate(element => { element.setAttribute('data-first-element', 'yes'); });

  await page.getByRole('button', { name: 'Finish generating the picture' }).click();
  await expect(card).toHaveAttribute('role', 'button');
  await expect(card).toHaveAttribute('title', 'Show the picture');
  await expect(card).toHaveAttribute('data-first-element', 'yes');
  // And the card works as a button, by keyboard too.
  await expect(page.getByRole('region', { name: 'Pictures' })).toBeVisible();
  await page.getByRole('region', { name: 'Pictures' }).getByRole('button', { name: 'Minimize pictures' }).click();
  await card.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('region', { name: 'Pictures' }).getByRole('img', { name: 'A foggy harbour' })).toBeVisible();
});

test('a file dropped on the voice stage is taken there once, not again by the chat behind it', async ({ page }) => {
  let uploads = 0;
  await page.route('**/api/sessions/test/upload?**', route => { uploads++; return route.fulfill({ json: { path: 'notes.pdf', size: 3 } }); });
  await start(page);
  const drop = (files: { name: string; type: string; base64: string }[]) => page.locator('.voice-stage').evaluate((stage, files) => {
    const data = new DataTransfer();
    for (const f of files) data.items.add(new File([Uint8Array.from(atob(f.base64), c => c.charCodeAt(0))], f.name, { type: f.type }));
    stage.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: data }));
    stage.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }));
  }, files);
  await drop([{ name: 'photo.png', type: 'image/png', base64: png.toString('base64') }]);
  await expect(page.getByLabel('Pictures for your next message').getByRole('img', { name: 'photo.png' })).toHaveCount(1);
  await drop([{ name: 'notes.pdf', type: 'application/pdf', base64: 'JVBE' }]);
  await expect(page.getByText('Only PNG, JPEG, GIF and WebP pictures can be sent in voice mode')).toBeVisible();
  // The refused file is not to take the place of the picture there, which only waiting shows.
  await page.waitForTimeout(300);
  await expect(page.getByLabel('Pictures for your next message').getByRole('img', { name: 'photo.png' })).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Add a picture' })).toContainText('1');
  expect(uploads).toBe(0);
});

test('tool cards say what came of a call, and open what they are about', async ({ page }) => {
  await start(page);
  // The terminal can be opened before the agent has run anything.
  await page.getByRole('button', { name: 'Show terminal' }).click();
  await expect(page.getByLabel('Agent terminal output')).toContainText('No commands yet');
  await page.getByRole('button', { name: 'Minimize terminal' }).click();
  await page.getByRole('button', { name: 'Start search' }).click();
  const search = page.locator('.voice-tool-float', { hasText: 'Searching for “retry”' });
  await expect(search).toBeVisible();
  // Still there after the old eight seconds would have faded it, counting.
  await page.waitForTimeout(4200);
  await expect(search).toContainText(/\d+ s/);
  await page.getByRole('button', { name: 'Edit file' }).click();
  const edit = page.getByRole('button', { name: /Editing app\.ts/ });
  await expect(edit).toContainText('+2 −1');
  await edit.click();
  await expect(page.getByRole('region', { name: 'Files' })).toBeVisible();
  await expect(page.getByLabel('Contents of src/app.ts')).toHaveValue('abc');
});

test('the Files window of voice mode leaves the edit of the chat\'s own Files panel where it is', async ({ page }) => {
  await page.goto('/tests/voice.html');
  // An edit in the chat's Files panel that is not saved.
  await page.getByRole('button', { name: 'Files', exact: true }).click();
  await page.getByRole('button', { name: /^app\.ts/ }).click();
  await page.getByLabel('Contents of app.ts').fill('edited by hand');
  const kept = () => page.evaluate(() => sessionStorage.getItem('pithagoras.file-draft.test') ?? '');
  await expect.poll(kept).toContain('edited by hand');
  await page.getByRole('button', { name: 'Turn on hands-free voice' }).click();
  await expect(page.getByRole('button', { name: 'End voice mode' })).toBeVisible({ timeout: 25000 });
  // The voice stage's own window opens on the folder, ready to show what the agent does, not on a half-made edit of the other.
  await page.getByRole('button', { name: 'Show files' }).click();
  const window = page.locator('.voice-files-window', { has: page.getByRole('button', { name: 'Minimize files' }) });
  await expect(window.getByRole('button', { name: /^app\.ts/ })).toBeVisible();
  await expect(window.getByLabel('Contents of app.ts')).toHaveCount(0);
  await expect(window.getByRole('button', { name: 'Following' })).toBeVisible();
  // Clicking Following again lets go, and Follow takes it up again.
  await window.getByRole('button', { name: 'Following' }).click();
  await expect(window.getByRole('button', { name: 'Follow', exact: true })).toBeVisible();
  await window.getByRole('button', { name: 'Follow', exact: true }).click();
  await expect(window.getByRole('button', { name: 'Following' })).toBeVisible();
  // And it did not take the chat's edit with it when it came: that is still kept, for a reload.
  expect(await kept()).toContain('edited by hand');
  await page.getByRole('button', { name: 'End voice mode' }).click();
  await expect(page.getByLabel('Contents of app.ts')).toHaveValue('edited by hand');
});

test('settings, push-to-talk, adding to a running task, the conversation and repeat', async ({ page }) => {
  test.setTimeout(90000);
  // Recognition is asked several times per utterance, so what it hears is set per utterance.
  let heard = 'Also check the tests.';
  await page.route('**/voice/transcribe', route => route.fulfill({ json: { text: heard } }));
  await start(page);

  // Hands-free first: a reply is spoken, and can then be heard again.
  await page.getByRole('button', { name: 'Inject speech' }).click();
  await expect(page.getByTestId('sent')).toHaveText('1', { timeout: 12000 });
  await expect(page.getByRole('button', { name: 'Repeat the last reply' })).toBeEnabled({ timeout: 12000 });
  // "Say that again" is not sent: the page plays the reply once more.
  await page.getByRole('button', { name: 'Finish reply' }).click();
  await expect(page.getByRole('status')).toContainText('Listening', { timeout: 12000 });
  heard = 'Say that again.';
  await page.getByRole('button', { name: 'Inject speech' }).click();
  await expect(page.getByRole('status')).toContainText('Speaking', { timeout: 12000 });
  await expect(page.getByTestId('sent')).toHaveText('1');
  heard = 'Also check the tests.';

  await page.getByRole('button', { name: 'Voice settings' }).click();
  const settings = page.getByRole('dialog', { name: 'Voice settings' });
  await settings.getByRole('group', { name: 'Speaking speed' }).getByRole('button', { name: '1.5×' }).click();
  await settings.getByRole('group', { name: 'Talking while the agent works' }).getByRole('button', { name: 'Adds to the task' }).click();
  await settings.getByRole('group', { name: 'Push to talk' }).getByRole('button', { name: 'On' }).click();
  expect(await page.evaluate(() => [localStorage.getItem('voiceRate'), localStorage.getItem('voiceSteer'), localStorage.getItem('voicePtt')])).toEqual(['1.5', 'on', 'on']);
  await page.keyboard.press('Escape');
  // With the canvas open beside the stage, the card is still on top of it.
  await page.getByRole('button', { name: 'Session canvases' }).click();
  await expect(page.getByLabel('Session canvas workspace')).toBeVisible();
  await page.getByRole('button', { name: 'Voice settings' }).click();
  const card = await settings.boundingBox();
  expect(await page.evaluate(([x, y]) => !!document.elementFromPoint(x, y)?.closest('.voice-settings'), [card!.x + card!.width / 2, card!.y + 20])).toBe(true);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Close canvas' }).click();
  await expect(settings).toBeHidden();
  await expect(page.getByRole('button', { name: 'Hold to talk' })).toBeVisible();
  // Once the repeated reply (the fixture's long clip) has finished.
  await expect(page.getByRole('status')).toContainText('Hold Space to talk', { timeout: 30000 });

  // Held while the agent works: added to its task, not stopping it.
  await page.getByRole('button', { name: 'Stream reply' }).click();
  await expect(page.getByRole('button', { name: 'Stop the agent' })).toBeVisible();
  await page.keyboard.down('Space');
  await expect(page.getByRole('status')).toContainText('Hearing you');
  await page.getByRole('button', { name: 'Inject speech' }).click();
  await page.waitForTimeout(2800);
  await page.keyboard.up('Space');
  await expect(page.getByTestId('sent')).toHaveText('2', { timeout: 12000 });
  await expect(page.getByTestId('last-send')).toHaveText(JSON.stringify({ message: 'Also check the tests.', images: 0, steer: true }));
  await expect(page.getByTestId('aborted')).toHaveText('0');
  // A tap is not a turn.
  await page.getByRole('button', { name: 'Hold to talk' }).click();
  // A tap is not to send anything, which only waiting for as long as a turn takes shows.
  await page.waitForTimeout(600);
  await expect(page.getByTestId('sent')).toHaveText('2');

  await page.getByRole('button', { name: 'Show the conversation' }).click();
  const conversation = page.getByRole('region', { name: 'Conversation', exact: true });
  await expect(conversation).toContainText('Also check the tests.');
  await expect(conversation).toContainText('Here is the spoken response.');
  // A window beside the orb, not over it or over another window.
  await settled(page);
  const box = await conversation.boundingBox(), orb = await page.locator('.voice-presence').boundingBox();
  expect(orb!.x + orb!.width <= box!.x || box!.x + box!.width <= orb!.x).toBe(true);
  await page.getByRole('button', { name: 'Show picture' }).click();
  await settled(page);
  const pictures = await page.getByRole('region', { name: 'Pictures', exact: true }).boundingBox(), beside = await conversation.boundingBox();
  expect(pictures!.x + pictures!.width <= beside!.x || beside!.x + beside!.width <= pictures!.x).toBe(true);
  await conversation.getByRole('button', { name: 'Close the conversation' }).click();
  // Esc while the agent works stops it, and voice mode stays on.
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('aborted')).toHaveText('1');
  await expect(page.getByRole('button', { name: 'End voice mode' })).toBeVisible();
});

test('everything in voice mode has a key, and the keys can be changed', async ({ page }) => {
  await start(page);
  await expect(page.getByRole('status')).toContainText('Listening');
  // Mute and unmute.
  await page.keyboard.press('m');
  await expect(page.getByRole('button', { name: 'Unmute microphone' })).toBeVisible();
  await page.keyboard.press('m');
  await expect(page.getByRole('button', { name: 'Mute microphone' })).toBeVisible();
  // Windows open and close.
  await page.keyboard.press('t');
  await expect(page.getByLabel('Agent terminal output')).toBeVisible();
  await page.keyboard.press('t');
  await expect(page.getByRole('button', { name: 'Show terminal' })).toBeVisible();
  await page.keyboard.press('c');
  await expect(page.getByRole('region', { name: 'Conversation', exact: true })).toHaveClass(/is-open/);
  await page.keyboard.press('c');
  await expect(page.getByRole('button', { name: 'Show the conversation' })).toBeVisible();
  // Settings: the speed follows . and ,
  await page.keyboard.press('.');
  await page.keyboard.press('o');
  await expect(page.getByRole('group', { name: 'Speaking speed' }).getByRole('button', { name: '1.25×' })).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Escape');
  await page.keyboard.press(',');
  expect(await page.evaluate(() => localStorage.getItem('voiceRate'))).toBe('1');
  // The tooltip names the key.
  await expect(page.getByRole('button', { name: 'Mute microphone' })).toHaveAttribute('title', 'Mute microphone (M)');

  // Changed in the settings: mute moves to K, and M is free.
  await page.getByRole('button', { name: 'Toggle shortcuts' }).click();
  const row = page.getByRole('listitem', { name: 'Mute or unmute the microphone' });
  await expect(row).toContainText('M');
  await row.getByRole('button', { name: 'Change' }).click();
  await expect(row).toContainText('Press the new keys');
  await page.keyboard.press('k');
  await expect(row.locator('kbd')).toHaveText('K');
  await page.getByRole('button', { name: 'Toggle shortcuts' }).click();
  await page.keyboard.press('m');
  await expect(page.getByRole('button', { name: 'Mute microphone' })).toBeVisible();
  await page.keyboard.press('k');
  await expect(page.getByRole('button', { name: 'Unmute microphone' })).toBeVisible();
  // A key another action has moves over, and the list says so.
  await page.getByRole('button', { name: 'Toggle shortcuts' }).click();
  await page.getByRole('listitem', { name: 'Repeat the last reply' }).getByRole('button', { name: 'Change' }).click();
  await page.keyboard.press('k');
  await expect(page.getByRole('status').filter({ hasText: 'which now has no shortcut' })).toContainText('Mute or unmute the microphone');
  await expect(row).toContainText('None');
  await page.getByRole('button', { name: 'Reset all' }).click();
  await expect(row.locator('kbd')).toHaveText('M');
  await page.getByRole('button', { name: 'Toggle shortcuts' }).click();

  // Esc with nothing running ends voice mode.
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Turn on hands-free voice' })).toBeVisible();
  await page.getByRole('button', { name: 'Turn on hands-free voice' }).click();
  await expect(page.getByRole('button', { name: 'End voice mode' })).toBeVisible({ timeout: 25000 });

  // Alt+V ends voice mode, and starts it again from the chat.
  await page.keyboard.press('Alt+v');
  await expect(page.getByRole('button', { name: 'Turn on hands-free voice' })).toBeVisible();
  await page.getByRole('textbox', { name: 'Message' }).focus();
  await page.keyboard.press('Alt+v');
  await expect(page.getByRole('button', { name: 'End voice mode' })).toBeVisible({ timeout: 25000 });
});

test('windows can be resized by their edges, until the windows are arranged anew', async ({ page }) => {
  await start(page);
  await page.getByRole('button', { name: 'Show terminal' }).click();
  const terminal = page.locator('.voice-terminal-window');
  await settled(page);
  const before = (await terminal.boundingBox())!;
  const grip = (await terminal.locator('.resize-sw').boundingBox())!;
  await page.mouse.move(grip.x + 8, grip.y + 8);
  await page.mouse.down();
  await page.mouse.move(grip.x - 80, grip.y + 8 - 60, { steps: 6 });
  await page.mouse.up();
  const after = (await terminal.boundingBox())!;
  expect(after.width).toBeGreaterThan(before.width + 60);
  expect(after.height).toBeLessThan(before.height - 40);
  // The right edge stayed where it was.
  expect(Math.abs(after.x + after.width - (before.x + before.width))).toBeLessThan(2);
  // Another window: the layout places both again.
  await page.getByRole('button', { name: 'Show the conversation' }).click();
  await settled(page);
  expect(await terminal.evaluate(el => el.style.width)).toBe('');
});

test('a window is sized from its corner with the arrow keys, and Home hands it back to the layout', async ({ page }) => {
  await start(page);
  await page.getByRole('button', { name: 'Show terminal' }).click();
  const terminal = page.locator('.voice-terminal-window');
  await settled(page);
  const before = (await terminal.boundingBox())!;
  // One grip of the five is reached with Tab: the corner.
  const grip = terminal.getByRole('button', { name: 'Resize the window' });
  await expect(grip).toHaveCount(1);
  await grip.focus();
  // Smaller, where it already fills the stage to the dock.
  await page.keyboard.press('Shift+ArrowLeft');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  await expect(terminal).toHaveAttribute('data-sized', 'pin');
  const after = (await terminal.boundingBox())!;
  expect(after.width).toBeCloseTo(before.width - 96, 0);
  expect(after.height).toBeCloseTo(before.height - 48, 0);
  // The corner moved, not the window: its left edge stayed.
  expect(after.x).toBeCloseTo(before.x, 0);
  await page.keyboard.press('Home');
  await expect(terminal).not.toHaveAttribute('data-sized', /.+/);
  expect(await terminal.evaluate(el => el.style.width)).toBe('');
});

test('the conversation window renders a reply as markdown, also while it is written, and puts it in a speech bubble apart from what the user said', async ({ page }) => {
  await start(page);
  await page.getByRole('button', { name: 'Show the conversation' }).click();
  const conversation = page.getByRole('region', { name: 'Conversation', exact: true });
  // Half a reply: the list is a list and the open fence is already a code block.
  await page.getByRole('button', { name: 'Stream markdown' }).click();
  await expect(conversation.locator('.voice-said.is-agent li')).toHaveCount(2);
  await expect(conversation.locator('.voice-said.is-agent [data-streamdown="strong"]')).toHaveText('bold');
  // A link is a button that asks before it leaves, as in the chat.
  await expect(conversation.getByRole('button', { name: 'the docs' })).toBeVisible();
  await expect(conversation.locator('.voice-said.is-agent [data-streamdown="code-block"]')).toHaveCount(1);
  await expect(conversation).not.toContainText('**bold**');
  await expect(conversation).not.toContainText('```');
  await page.getByRole('button', { name: 'Finish markdown' }).click();
  await expect(conversation.locator('.voice-said.is-agent [data-streamdown="code-block"]')).toContainText('const answer = 42;');
  await expect(conversation.locator('.voice-said.is-agent li')).toHaveCount(2);

  // The reply sits in a speech bubble, as what the user said does.
  const agent = conversation.locator('.voice-said.is-agent').last(), user = conversation.locator('.voice-said.is-user').first();
  const style = (el: import('@playwright/test').Locator) => el.evaluate(e => { const s = getComputedStyle(e); return { background: s.backgroundColor, border: s.borderTopWidth }; });
  // Apart from the user's bubble, in the light theme and in the dark.
  for (const scheme of ['light', 'dark'] as const) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, scheme);
    const [said, asked] = [await style(agent), await style(user)];
    expect(said.background).not.toBe('rgba(0, 0, 0, 0)');
    expect(said.border).toBe('1px');
    expect(said.background).not.toBe(asked.background);
    const [a, u] = [(await agent.boundingBox())!, (await user.boundingBox())!];
    expect(a.x).toBeLessThan(u.x);
  }
});

test('a model error in voice mode opens the conversation on it and plays the line kept at the start, without asking the speech model', async ({ page }) => {
  const asked: string[] = [], made: string[] = [], played: string[] = [];
  await page.route('**/voice/speech', route => { asked.push(route.request().postData() ?? ''); return route.fulfill({ body: sample, contentType: 'audio/wav' }); });
  await page.route('**/voice/error-line**', route => {
    if (route.request().method() === 'POST') { made.push(route.request().postData() ?? ''); return route.fulfill({ json: { ready: true, generated: true } }); }
    played.push(decodeURIComponent(new URL(route.request().url()).searchParams.get('text') ?? ''));
    return route.fulfill({ body: sample, contentType: 'audio/wav' });
  });
  await start(page);
  // Made as voice mode started, in the words it will say.
  await expect.poll(() => made).toEqual([JSON.stringify({ text: 'An error occurred.' })]);
  const conversation = page.getByRole('region', { name: 'Conversation', exact: true });
  await expect(page.getByRole('button', { name: 'Show the conversation' })).toBeVisible();
  await page.getByRole('button', { name: 'Fail the model' }).click();
  // Opened by itself, with the error written in it.
  await expect(page.getByRole('button', { name: 'Show the conversation' })).toHaveCount(0);
  await expect(conversation.getByRole('alert')).toHaveText('Model error: the provider is down');
  // And said: the kept line, not the error's own words, and not made again.
  await expect.poll(() => played).toEqual(['An error occurred.']);
  await settled(page);
  expect(asked).toEqual([]);
});

test('without the kept line the error is shown in writing only, and said so', async ({ page }) => {
  const asked: string[] = [];
  await page.route('**/voice/speech', route => { asked.push(route.request().postData() ?? ''); return route.fulfill({ body: sample, contentType: 'audio/wav' }); });
  // The speech model was not there when voice mode started: nothing was made, and nothing is found.
  await page.route('**/voice/error-line**', route => route.request().method() === 'POST'
    ? route.fulfill({ status: 502, json: { error: 'Breeze returned HTTP 503' } })
    : route.fulfill({ status: 404, json: { error: 'The spoken error line has not been made for this voice yet' } }));
  await start(page);
  await page.getByRole('button', { name: 'Fail the model' }).click();
  await expect(page.getByRole('region', { name: 'Conversation', exact: true }).getByRole('alert')).toHaveText('Model error: the provider is down');
  await expect(page.getByText('The spoken error line is not available, so the error is shown in writing only.')).toBeVisible();
  // The speech model is not asked as a way round it.
  expect(asked).toEqual([]);
  await expect(page.getByRole('button', { name: 'End voice mode' })).toBeVisible();
});

async function missingErrorLine(page: import('@playwright/test').Page) {
  await page.route('**/voice/error-line**', route => route.request().method() === 'POST'
    ? route.fulfill({ status: 502, json: { error: 'Breeze returned HTTP 503' } })
    : route.fulfill({ status: 404, json: { error: 'The spoken error line has not been made for this voice yet' } }));
  await start(page);
  await page.getByRole('button', { name: 'Fail the model' }).click();
  await expect(page.getByText('The spoken error line is not available, so the error is shown in writing only.')).toBeVisible();
  await page.getByRole('button', { name: 'End voice mode' }).click();
  return page.getByRole('alert').filter({ hasText: 'The spoken error line is not available' });
}

test('the notice about the missing error line is still there after voice mode ends, then fades by itself', async ({ page }) => {
  const notice = await missingErrorLine(page);
  await expect(notice).toBeVisible();
  await expect(notice).toBeHidden({ timeout: 9000 });
});

test('the notice about the missing error line goes at once when clicked', async ({ page }) => {
  const notice = await missingErrorLine(page);
  await expect(notice).toBeVisible();
  await notice.click();
  await expect(notice).toBeHidden({ timeout: 1000 });
});

test('an error from before voice mode, coming in late, does not open the conversation', async ({ page }) => {
  await start(page);
  await page.getByRole('button', { name: 'Replay an old error' }).click();
  await expect(page.getByTestId('workspace')).toContainText('Model error: from yesterday');
  await settled(page);
  await expect(page.getByRole('button', { name: 'Show the conversation' })).toBeVisible();
  // A new one still does.
  await page.getByRole('button', { name: 'Fail the model' }).click();
  await expect(page.getByRole('button', { name: 'Show the conversation' })).toHaveCount(0);
});

test('Escape in the confirmation of a link in a reply closes it and neither stops the agent nor ends voice mode', async ({ page }) => {
  await start(page);
  await page.getByRole('button', { name: 'Show the conversation' }).click();
  const conversation = page.getByRole('region', { name: 'Conversation', exact: true });
  // Still being written: the agent is running.
  await page.getByRole('button', { name: 'Stream markdown' }).click();
  await conversation.getByRole('button', { name: 'the docs' }).click();
  const confirmation = page.locator('[data-streamdown="link-safety-modal"]');
  await expect(confirmation).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(confirmation).toBeHidden();
  await expect(page.getByTestId('aborted')).toHaveText('0');
  await expect(page.getByRole('button', { name: 'End voice mode' })).toBeVisible();
});

test('the voice settings card stays inside a short screen and scrolls', async ({ page }) => {
  await page.setViewportSize({ width: 844, height: 390 });
  await start(page);
  await page.getByRole('button', { name: 'Voice settings' }).click();
  const card = page.getByRole('dialog', { name: 'Voice settings' });
  await expect(card).toBeVisible();
  expect((await card.boundingBox())!.y).toBeGreaterThanOrEqual(0);
  expect(await card.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
  // The first row can be reached.
  await card.getByRole('group', { name: 'Speaking speed' }).scrollIntoViewIfNeeded();
  await expect(card.getByRole('group', { name: 'Speaking speed' })).toBeInViewport();
});

test('with push-to-talk on, the orb can be held to talk, as on a phone', async ({ page }) => {
  test.setTimeout(60000);
  await page.addInitScript(() => localStorage.setItem('voicePtt', 'on'));
  await page.route('**/voice/transcribe', route => route.fulfill({ json: { text: 'Hello from the orb.' } }));
  // The detector starts a moment after the stage is up, and a press before that is not heard.
  const ready = page.waitForEvent('console', m => m.text().includes('started micVAD'));
  await start(page);
  await ready;
  const orb = page.locator('.voice-avatar');
  await expect(orb).toHaveClass(/is-holdable/);
  const box = (await orb.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  // A tap is not a turn.
  await page.mouse.down();
  await expect(page.getByRole('status')).toContainText('Hearing you');
  await page.mouse.up();
  await page.waitForTimeout(600);
  await expect(page.getByTestId('sent')).toHaveText('0');
  // Held while speaking: sent when let go.
  await page.mouse.down();
  await expect(page.getByRole('status')).toContainText('Hearing you');
  // A second finger lifting is not the first letting go.
  await orb.dispatchEvent('pointerup', { pointerId: 7 });
  await orb.dispatchEvent('pointercancel', { pointerId: 7 });
  await page.waitForTimeout(400);
  await expect(page.getByRole('status')).toContainText('Hearing you');
  // Not a real click: the mouse is down on the orb.
  await page.getByRole('button', { name: 'Inject speech' }).dispatchEvent('click');
  await page.waitForTimeout(2800);
  await page.mouse.up();
  await expect(page.getByTestId('sent')).toHaveText('1', { timeout: 12000 });
  await expect(page.getByTestId('last-send')).toHaveText(JSON.stringify({ message: 'Hello from the orb.', images: 0, steer: false }));
});

test('turning push-to-talk off during a hold does not leave the orb dead for the next hold', async ({ page }) => {
  test.setTimeout(60000);
  await page.addInitScript(() => localStorage.setItem('voicePtt', 'on'));
  const ready = page.waitForEvent('console', m => m.text().includes('started micVAD'));
  await start(page);
  await ready;
  const orb = page.locator('.voice-avatar');
  const status = page.getByRole('status');
  const box = (await orb.boundingBox())!;
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  // The mouse has one pointer id for good: the first press after the switch has to count.
  await page.mouse.move(x, y);
  await page.mouse.down();
  await expect(status).toContainText('Hearing you');
  await page.keyboard.press('h');
  await expect(orb).not.toHaveClass(/is-holdable/);
  await page.mouse.up();
  await page.keyboard.press('h');
  await expect(orb).toHaveClass(/is-holdable/);
  await page.mouse.down();
  await expect(status).toContainText('Hearing you');
  await page.mouse.up();
  await expect(status).not.toContainText('Hearing you');
  // Every finger is a new pointer id, so a stale one would block all of them.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true });
  const touch = async (type: 'touchStart' | 'touchEnd') => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
  await touch('touchStart');
  await expect(status).toContainText('Hearing you');
  await page.keyboard.press('h');
  await expect(orb).not.toHaveClass(/is-holdable/);
  await touch('touchEnd');
  await page.keyboard.press('h');
  await expect(orb).toHaveClass(/is-holdable/);
  for (let i = 0; i < 2; i++) {
    await touch('touchStart');
    await expect(status).toContainText('Hearing you');
    await touch('touchEnd');
    await expect(status).not.toContainText('Hearing you');
  }
});
