import { readFileSync } from 'node:fs';
import { type Locator, type Page } from '@playwright/test';
import { test, expect, mockPortal } from './portal-mock';
import { settled } from './settled';
import { DEFAULT_ORB, type OrbStyle } from '../../core/server/src/orb-style';

/**
 * An avatar an extension draws in voice mode, where the orb is (`voice.avatar`), and the choice of it in an agent's
 * Avatar dialog. The extension is the portal's tests' stand-in, "test-puppet": a square that follows the voice
 * (`puppet`), one that only ever draws the portal's orb (`waiting`), one that throws (`broken`), and the square again
 * from a chunk of its own (`later`).
 */
const PUPPET = 'tests/fixtures/extensions/puppet';
const sample = readFileSync(new URL('../fixtures/jfk.wav', import.meta.url));
// What the portal answers a phrase with: 24 kHz PCM, here the fixture's samples.
const speech = { body: sample.subarray(sample.indexOf('data') + 8), headers: { 'content-type': 'audio/pcm', 'x-sample-rate': '24000' } };

/**
 * The voice stage's own fixture page in voice mode, once it is up, for a chat whose agent's avatar is `look` (which a
 * test may change, and then say so with `orb-style-changed`).
 */
async function stage(page: Page, look: { orb: OrbStyle }) {
  await page.route('**/api/sessions/test/commands', route => route.fulfill({ json: { commands: [] } }));
  await page.route('**/api/sessions/test/config', route => route.fulfill({ status: 503, json: {} }));
  await page.route('**/api/voice', route => route.fulfill({ json: { enabled: true } }));
  await page.route('**/test-speech.wav', route => route.fulfill({ body: sample, contentType: 'audio/wav' }));
  await page.route('**/voice/transcribe', route => route.fulfill({ json: { text: 'A test voice turn.' } }));
  await page.route('**/voice/speech', route => route.fulfill(speech));
  await page.route('**/api/agent/avatar?session=test', route => route.fulfill({ json: { agent: { id: 'home', name: 'Home' }, orb: look.orb } }));
  await page.setViewportSize({ width: 1400, height: 860 });
  await page.goto('/tests/voice.html');
  await page.getByRole('button', { name: 'Turn on hands-free voice' }).click();
  await expect(page.getByRole('button', { name: 'End voice mode' })).toBeVisible({ timeout: 25000 });
}
const listening = (page: Page) => expect(page.getByRole('status')).toHaveText('Listening', { timeout: 25000 });

const chosen = (avatar: string) => ({ orb: { ...DEFAULT_ORB, avatar } });
const level = async (page: Page, side: 'input' | 'output') => Number(await page.getByTestId('puppet').getAttribute(`data-${side}`));
const box = async (page: Page, selector: string) => (await page.locator(selector).boundingBox())!;

test.describe('with the extension installed', () => {
  test.use({ installed: [PUPPET, 'tests/fixtures/extensions/console'] });

  test('the stage draws the chosen avatar where the orb is, in the mode voice mode is in and with its levels', async ({ page }) => {
    const failures: string[] = [];
    page.on('pageerror', e => failures.push(e.message));
    await stage(page, chosen('test-puppet/puppet'));
    await listening(page);
    const puppet = page.locator('.voice-avatar').getByTestId('puppet');
    await expect(puppet).toHaveAttribute('data-mode', 'idle');
    await expect(puppet).toHaveAttribute('data-agent', 'home');
    await expect(puppet).toHaveAttribute('data-still', 'false');
    await expect(page.locator('.voice-stage .voice-orb')).toHaveCount(0);

    await page.getByRole('button', { name: 'Inject speech' }).click();
    await expect(puppet).toHaveAttribute('data-mode', 'input');
    await expect.poll(() => level(page, 'input')).toBeGreaterThan(0);
    await expect(page.getByTestId('sent')).toHaveText('1', { timeout: 12000 });
    await expect(puppet).toHaveAttribute('data-mode', 'output');
    await expect.poll(() => level(page, 'output')).toBeGreaterThan(0);
    expect(failures).toEqual([]);
  });

  test('it is told the agent is thinking while it works and nothing is played, and speaking once the reply is', async ({ page }) => {
    await stage(page, chosen('test-puppet/puppet'));
    await listening(page);
    const puppet = page.getByTestId('puppet');
    // The agent at work, with nothing to say yet.
    await page.getByRole('button', { name: 'Start search' }).click();
    await expect(page.getByRole('status')).toHaveText('Thinking');
    await expect(puppet).toHaveAttribute('data-mode', 'thinking');
    // The orb keeps what it was told before there was thinking.
    await expect(page.locator('.voice-stage')).toHaveAttribute('data-mode', 'idle');
    await page.getByRole('button', { name: 'Stream reply', exact: true }).click();
    await expect(puppet).toHaveAttribute('data-mode', 'output');
  });

  test('it is drawn again for a new mode, not each time the stage is drawn again for a piece of what the agent says', async ({ page }) => {
    await stage(page, chosen('test-puppet/puppet'));
    await listening(page);
    const puppet = page.getByTestId('puppet');
    // How many times it was drawn, and how many modes it was given one after another: once as it was mounted, and
    // once for each new mode since.
    const drawn = () => page.evaluate(() => [(window as any).puppetRenders, (window as any).puppetModes.length]);
    expect(await drawn()).toEqual([1, 1]);
    // The model's thinking, streamed in while a window is open: the stage is drawn again for each piece, and keeps it
    // for its dock (hidden while the orb is beside the window).
    await page.getByRole('button', { name: 'Show the conversation' }).click();
    const thought = page.locator('.voice-thought-stream');
    for (let pieces = 1; pieces <= 5; pieces++) {
      await page.getByRole('button', { name: 'Stream thinking' }).click();
      await expect.poll(async () => (await thought.textContent())!.split('the page layout.').length - 1).toBe(pieces);
    }
    expect(await drawn()).toEqual([1, 1]);
    // The person heard, the levels read in every frame, and then a reply streamed in a piece at a time and played.
    await page.getByRole('button', { name: 'Inject speech' }).click();
    await expect(puppet).toHaveAttribute('data-mode', 'input');
    await expect.poll(() => level(page, 'input')).toBeGreaterThan(0);
    await expect(page.getByTestId('sent')).toHaveText('1', { timeout: 12000 });
    const conversation = page.getByRole('region', { name: 'Conversation', exact: true });
    for (let pieces = 1; pieces <= 4; pieces++) {
      await page.getByRole('button', { name: 'Stream reply', exact: true }).click();
      await expect.poll(async () => (await conversation.textContent())!.split('Here is the first sentence.').length - 1).toBe(pieces);
    }
    await expect(puppet).toHaveAttribute('data-mode', 'output', { timeout: 12000 });
    // A mode is listed once it has been drawn with.
    await expect.poll(async () => { const [renders, modes] = await drawn(); return renders - modes; }).toBe(0);
    expect((await drawn())[1]).toBeGreaterThan(3);
    expect(await page.evaluate(() => (window as any).puppetMounts)).toBe(1);
  });

  test('the wait after the person spoke is thinking too, before the reply is played', async ({ page }) => {
    let transcribed!: () => void;
    const gate = new Promise<void>(resolve => { transcribed = resolve; });
    await stage(page, chosen('test-puppet/puppet'));
    await page.route('**/voice/transcribe', async route => { await gate; await route.fulfill({ json: { text: 'And now?' } }); });
    await listening(page);
    const puppet = page.getByTestId('puppet');
    await page.getByRole('button', { name: 'Inject speech' }).click();
    await expect(page.getByRole('status')).toHaveText('Transcribing', { timeout: 12000 });
    await expect(puppet).toHaveAttribute('data-mode', 'thinking');
    transcribed();
    await expect(puppet).toHaveAttribute('data-mode', 'output', { timeout: 12000 });
    // Heard, then the wait, then the reply: in that order.
    const modes: string[] = await page.evaluate(() => (window as any).puppetModes);
    expect(modes.indexOf('input')).toBeGreaterThan(-1);
    expect(modes.indexOf('thinking')).toBeGreaterThan(modes.indexOf('input'));
    expect(modes.lastIndexOf('output')).toBeGreaterThan(modes.indexOf('thinking'));
  });

  test('an avatar that throws is replaced by the orb, and the portal is told its extension failed', async ({ page }) => {
    const told: { name: string; error: string }[] = [];
    await page.route('**/api/extension-ui/failures', route => { told.push(route.request().postDataJSON()); return route.fulfill({ json: { ok: true } }); });
    await stage(page, chosen('test-puppet/broken'));
    await expect(page.locator('.voice-avatar .voice-orb')).toBeVisible();
    await expect(page.getByTestId('puppet')).toHaveCount(0);
    await expect.poll(() => told.map((t) => t.name)).toContain('test-puppet');
    expect(told[0].error).toBe("The puppet's strings are cut");
  });

  test('the orb is drawn while an avatar of a chunk of its own is fetched, and the stage around it stays', async ({ page }) => {
    let fetched!: () => void;
    const gate = new Promise<void>(resolve => { fetched = resolve; });
    await page.route('**/api/extension-ui/test-puppet/later.js*', async route => { await gate; await route.fallback(); });
    await stage(page, chosen('test-puppet/later'));
    await listening(page);
    await expect(page.locator('.voice-avatar-x .voice-orb')).toBeVisible();
    await expect(page.getByRole('button', { name: 'End voice mode' })).toBeVisible();
    fetched();
    await expect(page.locator('.voice-avatar').getByTestId('puppet')).toHaveAttribute('data-mode', 'idle');
    await expect(page.locator('.voice-avatar .voice-orb')).toHaveCount(0);
  });

  test('an avatar whose chunk cannot be fetched is replaced by the orb, and the portal is told', async ({ page }) => {
    const told: { name: string }[] = [];
    await page.route('**/api/extension-ui/failures', route => { told.push(route.request().postDataJSON()); return route.fulfill({ json: { ok: true } }); });
    await page.route('**/api/extension-ui/test-puppet/later.js*', route => route.abort());
    await stage(page, chosen('test-puppet/later'));
    await expect.poll(() => told.map((t) => t.name)).toContain('test-puppet');
    await expect(page.locator('.voice-avatar .voice-orb')).toBeVisible();
    await expect(page.getByTestId('puppet')).toHaveCount(0);
  });

  test("an avatar that draws the portal's orb draws it exactly where the orb is drawn without one", async ({ page }) => {
    const look = { orb: DEFAULT_ORB };
    await stage(page, look);
    await listening(page);
    await settled(page);
    const plain = await box(page, '.voice-stage .voice-orb');
    look.orb = { ...DEFAULT_ORB, avatar: 'test-puppet/waiting' };
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('orb-style-changed')));
    await expect(page.locator('.voice-avatar-x .voice-orb')).toBeVisible();
    expect(await box(page, '.voice-avatar-x .voice-orb')).toEqual(plain);
  });

  test('it follows the orb into its dock and onto a phone in the same box, without being made again', async ({ page }) => {
    await stage(page, chosen('test-puppet/puppet'));
    await listening(page);
    const same = async (width: number) => {
      await settled(page);
      const avatar = await box(page, '.voice-avatar');
      expect(Math.round(avatar.width)).toBe(width);
      // The box it is given is the orb's, and it fills it.
      expect(await box(page, '.voice-avatar-x')).toEqual(avatar);
      expect(await box(page, '[data-testid="puppet"]')).toEqual(avatar);
    };
    await same(380);
    // Two windows open: the orb goes to its dock.
    await page.getByRole('button', { name: 'Show the conversation' }).click();
    await page.getByRole('button', { name: 'Use terminal', exact: true }).click();
    await expect(page.locator('.voice-stage')).toHaveAttribute('data-orb', 'dock');
    await same(100);
    await page.setViewportSize({ width: 390, height: 844 });
    await same(64);
    expect(await page.evaluate(() => (window as any).puppetMounts)).toBe(1);
  });

  test('with push-to-talk on, the avatar is held to talk, as the orb is', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('voicePtt', 'on'));
    // The detector starts a moment after the stage is up, and a press before that is not heard.
    const ready = page.waitForEvent('console', m => m.text().includes('started micVAD'));
    await stage(page, chosen('test-puppet/puppet'));
    await ready;
    // While the agent works, so that a hold is seen to be the person's turn and not its thinking.
    await page.getByRole('button', { name: 'Start search' }).click();
    const puppet = page.getByTestId('puppet');
    await expect(puppet).toHaveAttribute('data-mode', 'thinking');
    const at = await box(page, '[data-testid="puppet"]');
    const hold = page.getByRole('button', { name: 'Hold to talk' });
    await page.mouse.move(at.x + at.width / 2, at.y + at.height / 2);
    // A tap, too short to be heard: not thinking while it is held, and thinking again after.
    await page.evaluate(() => { (window as any).puppetModes.length = 0; });
    await page.mouse.down();
    await page.mouse.up();
    await expect.poll(() => page.evaluate(() => (window as any).puppetModes)).toEqual(['idle', 'thinking']);
    await page.mouse.down();
    await expect(hold).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('status')).toContainText('Hearing you');
    await expect(puppet).not.toHaveAttribute('data-mode', 'thinking');
    await page.mouse.up();
    await expect(hold).toHaveAttribute('aria-pressed', 'false');
    await expect(puppet).toHaveAttribute('data-mode', 'thinking');
  });
});

test.describe('without the extension', () => {
  test('a chosen avatar whose extension is not there is drawn as the orb', async ({ page }) => {
    await stage(page, chosen('test-puppet/puppet'));
    await expect(page.locator('.voice-avatar .voice-orb')).toBeVisible();
    await expect(page.locator('.voice-avatar-x')).toHaveCount(0);
  });
});

// --- the Avatar dialog, on the Agents page ---

const HEARTBEAT = { minutes: 0, quietStart: '', quietEnd: '', timeZone: 'UTC', last: null, status: null, running: false, watching: false, available: true };
const agentWith = (id: string, name: string, orb: OrbStyle) => ({ id, name, home: `/a/${id}`, first: id === 'home', initialised: true, chats: 0, channels: [], orb, voice: '', heartbeat: HEARTBEAT, unread: 0 });

/** The Agents page with Home, whose avatar is `orb` as saved; what is saved for it is kept in `saved`. */
async function agents(page: Page, orb: OrbStyle) {
  const saved: OrbStyle[] = [];
  await mockPortal(page, ({ path, method, json }) => {
    if (path === '/api/agents/home/orb' && method === 'PUT') {
      saved.push(json());
      return json();
    }
    if (path === '/api/agents') return { agents: [agentWith('home', 'Home', saved.at(-1) ?? orb), agentWith('ada', 'Ada', DEFAULT_ORB)] };
    if (path === '/api/agent/sessions') return { sessions: [], agentHome: '/a/home' };
    if (/^\/api\/agents\/[^/]+\/setup$/.test(path)) return { home: '/a/home', initialised: true, files: [{ name: 'SOUL.md', exists: true, content: 'Kind.', mtime: 1 }] };
  }, { settings: true });
  return saved;
}

async function openAvatar(page: Page) {
  await page.goto('/agents?agent=home');
  await page.getByRole('button', { name: /^(Customize the avatar|Avatar anpassen)$/ }).click();
  return page.getByRole('dialog', { name: 'Avatar' });
}

const pressed = (choices: ReturnType<Page['getByRole']>) => choices.locator('button[aria-pressed="true"]');
/**
 * Off the stage, the dark square an avatar is drawn on, the avatar's box in it and what is drawn there, each by its
 * width, and whether the square cuts what is drawn past it.
 */
const onSquare = (drawn: Locator) => drawn.evaluate((el) => {
  const box = el.closest('.voice-avatar')!, square = box.parentElement!;
  const width = (e: Element) => Math.round(e.getBoundingClientRect().width);
  return { square: width(square), box: width(box), drawn: width(el), cut: getComputedStyle(square).overflow === 'hidden' };
});

test.describe('the Avatar dialog with the extension installed', () => {
  test.use({ installed: [PUPPET] });

  test('lists the orb and every avatar the extension offers, previews the one chosen in each state, and saves it', async ({ page }) => {
    const saved = await agents(page, DEFAULT_ORB);
    const dialog = await openAvatar(page);
    const shownAs = dialog.getByRole('group', { name: 'Shown as' });
    await expect(shownAs.getByRole('button')).toHaveText([/^Orb/, /^PuppetA square that follows the voice$/, /^Waiting$/, /^Broken$/, /^Later$/]);
    await expect(pressed(shownAs)).toHaveText(/^Orb/);
    const states = dialog.getByRole('group', { name: 'Preview state' }).getByRole('button');
    await expect(states).toHaveText(['Idle', 'Listening', 'Speaking', 'Muted']);
    await expect(dialog.getByRole('tablist', { name: 'Avatar sections' })).toBeVisible();

    await shownAs.getByRole('button', { name: /^Puppet/ }).click();
    await expect(dialog.getByRole('tablist')).toHaveCount(0);
    await expect(dialog).toContainText("How it looks is set by its extension, on the extension's page in Settings. Where it cannot be drawn, voice mode shows the agent's orb.");
    const puppet = dialog.getByTestId('puppet');
    await expect(puppet).toHaveAttribute('data-still', 'false');
    // All of the preview's square is its box, and what is past it is cut.
    expect(await onSquare(puppet)).toEqual({ square: 220, box: 220, drawn: 220, cut: true });
    await expect(states).toHaveText(['Idle', 'Listening', 'Speaking', 'Thinking', 'Muted']);
    for (const [label, mode] of [['Idle', 'idle'], ['Listening', 'input'], ['Speaking', 'output'], ['Thinking', 'thinking'], ['Muted', 'muted']]) {
      await states.filter({ hasText: label }).click();
      await expect(puppet).toHaveAttribute('data-mode', mode);
    }
    // Speaking with the made-up voice.
    await states.filter({ hasText: 'Speaking' }).click();
    await expect.poll(() => level(page, 'output')).toBeGreaterThan(0);

    await dialog.getByRole('button', { name: 'Save avatar' }).click();
    await expect.poll(() => saved.map((s) => s.avatar)).toEqual(['test-puppet/puppet']);
    // The orb's look is saved with it, for where it cannot be drawn.
    expect(saved[0].personality).toBe(DEFAULT_ORB.personality);
    // The agent's avatar on its page is now the puppet, as a picture, and says which it is.
    await expect(page.locator('[title="Puppet"]').getByTestId('puppet')).toHaveAttribute('data-still', 'true');
    expect(await onSquare(page.locator('[title="Puppet"]').getByTestId('puppet'))).toEqual({ square: 64, box: 64, drawn: 64, cut: true });

    await dialog.getByRole('button', { name: 'Reset to default' }).click();
    await expect(pressed(shownAs)).toHaveText(/^Orb/);
    await expect(dialog.getByRole('tablist', { name: 'Avatar sections' })).toBeVisible();
    // Back to the orb while it is previewed thinking: the orb has no such state, and the preview speaks again.
    await shownAs.getByRole('button', { name: /^Puppet/ }).click();
    await states.filter({ hasText: 'Thinking' }).click();
    await shownAs.getByRole('button', { name: /^Orb/ }).click();
    await expect(states).toHaveText(['Idle', 'Listening', 'Speaking', 'Muted']);
    await expect(states.filter({ hasText: 'Speaking' })).toHaveAttribute('aria-pressed', 'true');
    await expect(dialog.locator('.voice-orb')).toBeVisible();
  });

  test('in German, the extension names its avatars in its own words and the five states fit their buttons', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('pithagoras.language', 'de'));
    await agents(page, { ...DEFAULT_ORB, avatar: 'test-puppet/puppet' });
    const dialog = await openAvatar(page);
    const shownAs = dialog.getByRole('group', { name: 'Dargestellt als' });
    await expect(pressed(shownAs)).toHaveText('PuppeEin Quadrat, das der Stimme folgt');
    const states = dialog.getByRole('group', { name: 'Vorschauzustand' }).getByRole('button');
    await expect(states).toHaveText(['Ruhend', 'Hört zu', 'Spricht', 'Denkt nach', 'Stumm']);
    const overflowing = () => states.evaluateAll((buttons) => buttons.filter((b) => b.scrollWidth > b.clientWidth).map((b) => b.textContent));
    expect(await overflowing()).toEqual([]);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(states).toHaveCount(5);
    expect(await overflowing()).toEqual([]);
  });

  test('a saved avatar the page does not have is said to be not available, the orb is shown, and saving keeps it', async ({ page }) => {
    const saved = await agents(page, { ...DEFAULT_ORB, avatar: 'test-puppet/gone' });
    // The installed extensions, held back: until they are in the page, one of them may still offer it.
    let listed!: () => void;
    const gate = new Promise<void>(resolve => { listed = resolve; });
    await page.route('**/api/extension-ui', async route => { await gate; await route.fallback(); });
    const dialog = await openAvatar(page);
    const shownAs = dialog.getByRole('group', { name: 'Shown as' });
    await expect(pressed(shownAs)).toHaveText('Not available');
    await expect(page.locator('[title="Not available"]')).toHaveCount(1);
    const why = dialog.getByText('This avatar is not available', { exact: false });
    await expect(why).toHaveCount(0);
    listed();
    await expect(shownAs.getByRole('button', { name: /^Puppet/ })).toBeVisible();
    await expect(pressed(shownAs)).toHaveText('Not available');
    await expect(dialog).toContainText('This avatar is not available: its extension is not installed or is switched off, could not be loaded, or no longer offers it. Voice mode shows the orb.');
    await expect(dialog.locator('.voice-orb')).toBeVisible();
    // The orb's sections, since the orb is what is shown.
    await dialog.getByRole('button', { name: /^Lively/ }).click();
    await dialog.getByRole('button', { name: 'Save avatar' }).click();
    await expect.poll(() => saved.map((s) => [s.avatar, s.personality])).toEqual([['test-puppet/gone', 'lively']]);
  });

  test('the cards of the Agents page draw an avatar of an extension as a picture', async ({ page }) => {
    await agents(page, { ...DEFAULT_ORB, avatar: 'test-puppet/puppet' });
    await page.goto('/agents');
    const card = page.getByRole('button', { name: /Home/ });
    await expect(card.getByTestId('puppet')).toHaveAttribute('data-still', 'true');
    await expect(card.getByTestId('puppet')).toHaveAttribute('data-mode', 'idle');
    await expect(card.getByTestId('puppet')).toHaveAttribute('data-agent', 'home');
    // All of the card's square is its box, and what is past it, which would reach over the agent's name, is cut.
    expect(await onSquare(card.getByTestId('puppet'))).toEqual({ square: 112, box: 112, drawn: 112, cut: true });
    // The orb's square is as it was: its glow, and a hat, may reach past it.
    const orb = page.getByRole('button', { name: /Ada/ }).locator('.voice-orb');
    await expect(orb).toBeVisible();
    expect(await onSquare(orb)).toEqual({ square: 112, box: 112, drawn: 160, cut: false });
  });
});

test.describe('the Avatar dialog without an avatar extension', () => {
  test('is as it always was: no choice of what the agent is shown as', async ({ page }) => {
    await agents(page, DEFAULT_ORB);
    const dialog = await openAvatar(page);
    await expect(dialog.getByRole('tablist', { name: 'Avatar sections' })).toBeVisible();
    await expect(dialog.getByRole('group', { name: 'Shown as' })).toHaveCount(0);
    await expect(dialog.getByRole('group', { name: 'Preview state' }).getByRole('button')).toHaveText(['Idle', 'Listening', 'Speaking', 'Muted']);
  });
});
