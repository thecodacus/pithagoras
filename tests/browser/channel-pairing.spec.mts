import { type Page } from '@playwright/test';
import { test, expect, mockPortal } from './portal-mock';
import { DEFAULT_ORB } from '../../core/server/src/orb-style';

/**
 * A code a channel package asks to have scanned — Signal's link to a new
 * device — is drawn on the channel's page as a QR code while it waits, with
 * what the package says to do with it, and goes once the package takes it back.
 */

const CODE = 'sgnl://linkdevice?uuid=abc&pub_key=def';
const CHANNEL = {
  id: 'c1', slug: 'signal', kind: 'signal', name: 'Signal', enabled: true, config: { url: 'http://127.0.0.1:8080', account: '+15551234567' }, secretsSet: [], instructions: '',
  relayProgress: true, relayTools: false, agentId: 'home', sessionCount: 0, state: 'running', log: [], created_at: '', updated_at: '1',
  pairing: { code: CODE, hint: 'Scan this with the phone of +15551234567.' },
};
const KIND = { id: 'signal', label: 'Signal', blurb: 'A messenger', fields: [{ key: 'url', label: 'signal-cli daemon', required: true }, { key: 'account', label: 'Signal number', required: true }], packageName: 'pithagoras-channel-signal', builtin: true, runnable: true };
const AGENTS = { agents: [{ id: 'home', name: 'Home', home: '/a', first: true, initialised: true, chats: 0, channels: [], orb: DEFAULT_ORB, voice: '', unread: 0 }] };

async function portal(page: Page, channel: () => unknown) {
  await mockPortal(page, (ask) => (ask.path === '/api/channels' ? { channels: [channel()], kinds: [KIND], broken: [], channelsDir: '/a/channels' } : ask.path === '/api/agents' ? AGENTS : undefined), { settings: true });
}

test("a code the channel waits to have scanned is on its page as a QR code with what to do, and goes once it is used", async ({ page }) => {
  let live: Record<string, unknown> = CHANNEL;
  await portal(page, () => live);
  await page.clock.install();
  await page.goto('/settings/channels');
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await settings.getByRole('button', { name: /^Signal/ }).first().click();

  const qr = settings.getByRole('img', { name: 'Code to scan' });
  await expect(qr).toBeVisible();
  await expect(settings.getByText('Scan this with the phone of +15551234567.')).toBeVisible();
  await expect(settings.getByText(CODE, { exact: true })).toBeVisible();
  // Square, large enough for a camera, and dark on white in either theme.
  const box = (await qr.boundingBox())!;
  expect(Math.round(box.width)).toBe(Math.round(box.height));
  expect(box.width).toBeGreaterThanOrEqual(180);
  expect(await qr.locator('path').getAttribute('d')).toMatch(/^M\d+ \d+h1v1h-1z/);

  live = { ...CHANNEL, pairing: undefined };
  await page.clock.runFor(5000);
  await expect(qr).toBeHidden();
  await expect(settings.getByText(CODE, { exact: true })).toBeHidden();
});
