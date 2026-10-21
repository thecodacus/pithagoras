import { type Page } from '@playwright/test';
import { test, expect } from '../../../../tests/browser/portal-mock';

test.use({ installed: ['extensions/canvas'] });

/**
 * A chat's canvases, over the voice fixture's chat (core/web/tests/voice.tsx): the panel beside the conversation, fed
 * as the server half feeds it (`window.extensionSays`), and the routes of the server half, answered here.
 */
const ROUTES = '**/api/x/pithagoras-canvas/chats/test/canvases';
const says = (page: Page, message: unknown) => page.evaluate((m) => (window as any).extensionSays('pithagoras-canvas', m), message);

async function chat(page: Page, list: unknown[] = []) {
  await page.route('**/api/voice', (r) => r.fulfill({ json: { enabled: false } }));
  await page.route('**/api/sessions/test/commands', (r) => r.fulfill({ json: { commands: [] } }));
  await page.route('**/api/sessions/test/config', (r) => r.fulfill({ status: 503, json: {} }));
  await page.route(ROUTES, (r) => r.fulfill({ json: list }));
}

test('a canvas is written live beside the chat, keeps a partial draft, and is edited, stored, downloaded and deleted', async ({ page }) => {
  const failures: string[] = [];
  page.on('pageerror', (e) => failures.push(e.message));
  await chat(page);
  let row = { id: 'canvas-1', title: 'A live document', content: '', revision: 0, status: 'writing', active_call: 'call-1', updated_at: '', persisted: false };
  await page.route(`${ROUTES}/canvas-1`, async (route) => {
    if (route.request().method() === 'DELETE') return route.fulfill({ json: { ok: true } });
    const body = route.request().postDataJSON();
    expect(body.revision).toBe(row.revision);
    row = { ...row, ...body, revision: row.revision + 1, status: 'edited', active_call: null as any };
    return route.fulfill({ json: row });
  });
  await page.route(`${ROUTES}/canvas-1/persist`, (r) => {
    row = { ...row, persisted: true };
    return r.fulfill({ json: row });
  });
  await page.setViewportSize({ width: 1300, height: 860 });
  await page.goto('/tests/voice.html');
  await expect(page.getByRole('button', { name: 'Session canvases', exact: true })).toBeVisible();
  await says(page, { type: 'snapshot', canvases: [] });
  const emit = () => says(page, { type: 'update', canvas: row });
  // A document the agent makes brings the panel up before the first write.
  await says(page, { type: 'create', canvas: { ...row, status: 'saved', active_call: null } });
  await expect(page.getByLabel('Session canvas workspace')).toBeVisible();
  await page.getByRole('button', { name: 'Close Session canvases' }).click();
  await expect(page.getByLabel('Session canvas workspace')).toHaveCount(0);
  // And a write it begins brings it up again.
  row.content = '# A live document\n\nThe first sentence.';
  row.revision = 1;
  await emit();
  await expect(page.getByLabel('Session canvas workspace')).toBeVisible();
  await expect(page.locator('.canvas-document')).toContainText('The first sentence.');
  await expect(page.getByRole('button', { name: 'Edit inline' })).toBeDisabled();
  row.content += ' Another sentence appears.';
  row.revision = 2;
  await emit();
  await expect(page.locator('.canvas-document')).toContainText('Another sentence appears.');
  row.status = 'interrupted';
  row.active_call = null as any;
  await emit();
  await expect(page.getByText('Partial draft retained', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Edit inline' }).click();
  await page.getByLabel('Edit canvas content').fill('My own edited document.');
  await page.getByLabel('Canvas title').fill('Human revision');
  await page.getByRole('button', { name: 'Apply changes' }).click();
  await expect(page.locator('.canvas-document')).toContainText('My own edited document.');
  await expect(page.getByText('Edited by you', { exact: false })).toBeVisible();
  const download = page.waitForEvent('download');
  await page.getByLabel('Download canvas', { exact: true }).click();
  expect((await download).suggestedFilename()).toBe('Human revision.md');
  await page.getByLabel('Store canvas', { exact: true }).click();
  await expect(page.getByLabel('Canvas stored', { exact: true })).toBeDisabled();
  await page.getByLabel('Delete canvas').click();
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.getByText('A place for your documents')).toBeVisible();
  // A document the agent reads is brought up.
  await says(page, { type: 'focus', canvas: { id: 'read-doc', title: 'Document being read', content: 'The AI is reading this document.', revision: 1, status: 'saved', active_call: null } });
  await expect(page.getByLabel('Select canvas')).toHaveText('Document being read');
  await expect(page.locator('.canvas-document')).toContainText('The AI is reading this document.');
  expect(failures).toEqual([]);
});

test('the stored canvases are fetched when the page has not been told them', async ({ page }) => {
  await chat(page, [{ id: 'saved', title: 'Saved document', content: 'Persisted words', revision: 1, status: 'saved', active_call: null, updated_at: '', persisted: true }]);
  await page.setViewportSize({ width: 1300, height: 860 });
  await page.goto('/tests/voice.html');
  await page.getByRole('button', { name: 'Session canvases', exact: true }).click();
  await expect(page.getByLabel('Select canvas')).toHaveText('Saved document');
  await expect(page.locator('.canvas-document')).toContainText('Persisted words');
});

test('a canvas deleted while it is being edited ends the edit, and its draft stays to be copied', async ({ page }) => {
  await chat(page);
  await page.setViewportSize({ width: 1300, height: 860 });
  await page.goto('/tests/voice.html');
  const row = { id: 'canvas-1', title: 'A document', content: 'Written by the agent.', revision: 1, status: 'saved', active_call: null, updated_at: '', persisted: false };
  await says(page, { type: 'snapshot', canvases: [row] });
  await page.getByRole('button', { name: 'Session canvases', exact: true }).click();
  await page.getByRole('button', { name: 'Edit inline' }).click();
  await page.getByLabel('Edit canvas content').fill('Half of my own text.');
  // Gone: the agent removed it, or another tab did.
  await says(page, { type: 'delete', id: 'canvas-1' });
  await expect(page.getByRole('alert')).toContainText('This document was deleted while you were editing it.');
  await expect(page.getByLabel('Your draft')).toHaveValue('Half of my own text.');
  // Not stuck: another document can be made, and the panel closed.
  await expect(page.getByLabel('New canvas')).toBeEnabled();
  await page.getByRole('button', { name: 'Dismiss' }).click();
  await expect(page.getByLabel('Your draft')).toHaveCount(0);
  await page.getByRole('button', { name: 'Close Session canvases' }).click();
  await expect(page.getByLabel('Session canvas workspace')).toHaveCount(0);
});

test('a document that a cut-off write left half done can be put back as it was', async ({ page }) => {
  await chat(page);
  let asked: unknown;
  await page.route(`${ROUTES}/canvas-1/restore`, (r) => {
    asked = r.request().postDataJSON();
    return r.fulfill({ json: { id: 'canvas-1', title: 'A document', content: 'The whole of the document.', revision: 4, status: 'edited', active_call: null, updated_at: '', persisted: true, restorable: false } });
  });
  await page.setViewportSize({ width: 1300, height: 860 });
  await page.goto('/tests/voice.html');
  const row = { id: 'canvas-1', title: 'A document', content: 'The wh', revision: 3, status: 'interrupted', active_call: null, updated_at: '', persisted: true, restorable: true };
  await says(page, { type: 'snapshot', canvases: [row] });
  await page.getByRole('button', { name: 'Session canvases', exact: true }).click();
  const restore = page.getByRole('button', { name: 'Restore the version before the interrupted write' });
  await expect(restore).toBeEnabled();
  // Not while the agent is writing, and not when there is nothing to go back to.
  await says(page, { type: 'update', canvas: { ...row, status: 'writing', active_call: 'call-2' } });
  await expect(restore).toHaveCount(0);
  await says(page, { type: 'update', canvas: { ...row, restorable: false } });
  await expect(restore).toHaveCount(0);
  await says(page, { type: 'update', canvas: row });
  await restore.click();
  expect(asked).toEqual({ revision: 3 });
  await expect(page.locator('.canvas-document')).toContainText('The whole of the document.');
  await expect(restore).toHaveCount(0);
});

test('in voice mode the canvases are a window of their own, brought up as the agent writes, with D to show or hide them', async ({ page }) => {
  await chat(page);
  await page.addInitScript(() => {
    (window as any).EventSource = class { onmessage: any; onopen: any; close() {} };
  });
  await page.unroute('**/api/voice');
  await page.route('**/api/voice', (r) => r.fulfill({ json: { enabled: true } }));
  await page.setViewportSize({ width: 1400, height: 860 });
  await page.goto('/tests/voice.html');
  await page.getByRole('button', { name: 'Turn on hands-free voice' }).click();
  await expect(page.getByRole('status')).toHaveText('Listening', { timeout: 25000 });
  const window = page.locator('.voice-extension-window[data-extension="pithagoras-canvas"]');
  await says(page, { type: 'snapshot', canvases: [] });
  await says(page, { type: 'update', canvas: { id: 'doc', title: 'A shared draft', content: '# Draft', revision: 1, status: 'writing', active_call: 'call-1', updated_at: '', persisted: false } });
  await expect(window).toHaveClass(/is-open/);
  await expect(window.getByLabel('Session canvas workspace')).toContainText('Draft');
  await page.keyboard.press('d');
  await expect(window).toHaveCount(0);
  await page.keyboard.press('d');
  await expect(window).toHaveClass(/is-open/);
});

test('what goes wrong and the delete question are in the theme\'s colour for danger, not one of their own', async ({ page }) => {
  await chat(page);
  await page.goto('/tests/voice.html');
  // The extension's stylesheet is in the page once it is loaded.
  await expect(page.getByRole('button', { name: 'Session canvases', exact: true })).toBeVisible();
  const read = await page.evaluate(() => {
    document.body.insertAdjacentHTML('beforeend', '<p class="canvas-error">e</p><p class="canvas-delete-confirm">d</p><i id="danger" style="color: rgb(var(--danger))"></i>');
    const colour = (selector: string) => getComputedStyle(document.querySelector(selector)!).color;
    return { error: colour('.canvas-error'), confirm: colour('.canvas-delete-confirm'), danger: colour('#danger') };
  });
  expect(read.error).toBe(read.danger);
  expect(read.confirm).toBe(read.danger);
});
