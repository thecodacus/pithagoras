import { readFileSync } from 'node:fs';
import { type Page } from '@playwright/test';
import { test, expect, mockPortal, DONE } from './portal-mock';

/**
 * An extension that draws in the portal: the Notes extension's own browser
 * half (extensions/notes/web), loaded into the app as the portal serves it.
 */
const NAME = 'pithagoras-notes';
const web = (file: string) => readFileSync(new URL(`../../extensions/notes/web/${file}`, import.meta.url), 'utf8');
const address = (name: string, file: string) => `/api/extension-ui/${name}/${file}`;

async function portal(page: Page, module = web('client.js'), probe?: string) {
  const at = new Date().toISOString();
  const sessions = [
    { id: 'a', title: 'First chat', workspace: '/w/site', status: 'idle', kind: 'task', pinned: false, updated_at: at, provider: null, model: null, thinking_level: null },
    { id: 'b', title: 'Second chat', workspace: '/w/site', status: 'idle', kind: 'task', pinned: false, updated_at: at, provider: null, model: null, thinking_level: null },
  ];
  const model = { id: 'model-a', name: 'Model A', provider: 'llama-swap' };
  const state = { installed: true, revision: 1, probeServerError: undefined as string | undefined };
  /** What the browser half said to its extension, by chat. */
  const said: { chat: string; extension: string; data: any }[] = [];
  await mockPortal(page, async ({ path: p, method, route, json }) => {
    if (p === '/api/extension-ui') {
      const v = `?v=${state.revision}`;
      return {
        extensions: [
          ...(state.installed ? [{ name: NAME, version: '0.2.0', entry: address(NAME, 'client.js') + v, style: address(NAME, 'client.css') + v, server: `/api/x/${NAME}` }] : []),
          ...(probe ? [{ name: 'probe', version: '1.0.0', entry: address('probe', 'client.js') + v, server: '/api/x/probe', serverError: state.probeServerError }] : []),
        ],
      };
    }
    // What is installed, as Settings lists it.
    if (p === '/api/extensions' && probe) return { settingsPath: '/a/settings.json', extensions: [{ spec: 'npm:probe', name: 'probe', version: '1.0.0', enabled: true, settings: [] }] };
    if (p === address('probe', 'client.js')) { await route.fulfill({ contentType: 'text/javascript', body: probe! }); return DONE; }
    // The Notes extension's own route, as its server half answers it.
    if (p === `/api/x/${NAME}/notes`) return { chats: [{ id: 'b', title: 'Second chat', notes: [{ id: 1, text: 'Kept with the second chat', by: 'agent' }] }] };
    if (p === address(NAME, 'client.js')) { await route.fulfill({ contentType: 'text/javascript', body: module }); return DONE; }
    if (p === address(NAME, 'client.css')) { await route.fulfill({ contentType: 'text/css', body: web('client.css') }); return DONE; }
    if (p === '/api/sessions') return { sessions, executor: 'host' };
    const told = /^\/api\/sessions\/(\w+)\/extension-ui$/.exec(p);
    if (told && method === 'POST') { said.push({ chat: told[1], ...json() }); return { ok: true }; }
    if (/^\/api\/sessions\/\w+$/.test(p)) return sessions.find((s) => p.endsWith('/' + s.id));
    if (/^\/api\/sessions\/\w+\/(config|models)$/.test(p)) return { live: false, state: { model, thinkingLevel: 'medium' }, stats: null, thinking: { levels: ['off', 'medium'] }, models: { models: [model] }, named: { provider: null, model: null } };
    if (p.endsWith('/canvases')) return [];
    if (p === '/api/models') return { models: [], providers: {} };
  }, { streams: 'open', settings: true });
  /** What the extension in a chat says to its browser half, as the chat's stream carries it. */
  const hears = (chat: string, data: unknown) =>
    page.evaluate(([chat, extension, data]) => {
      const stream = (window as any).streams.find((s: any) => !s.closed && s.url.includes(`/api/sessions/${chat}/events`));
      stream.emit('message', { seq: -1, type: 'portal_extension_ui', payload: { type: 'portal_extension_ui', extension, data } });
    }, [chat, NAME, data] as const);
  /** What a server half says to the pages open on a chat, as the chat's stream carries it under its own name. */
  const pushed = (chat: string, extension: string, data: unknown) =>
    page.evaluate(([chat, extension, data]) => {
      (window as any).streams.find((s: any) => !s.closed && s.url.includes(`/api/sessions/${chat}/events`)).emit('extension', { extension, data });
    }, [chat, extension, data] as const);
  /** Something the chat's pi said, as the chat's stream carries it. */
  let seq = 100;
  const said2 = (chat: string, type: string, payload: unknown, live = false) =>
    page.evaluate(([chat, event]) => {
      (window as any).streams.find((s: any) => !s.closed && s.url.includes(`/api/sessions/${chat}/events`)).emit('message', event);
    }, [chat, { seq: live ? -++seq : ++seq, type, at: Date.now(), payload }] as const);
  /** What is installed changed, as Settings says when it installs, removes or switches a package. */
  const changed = (to: Partial<typeof state>) => {
    Object.assign(state, to);
    return page.evaluate(() => window.dispatchEvent(new Event('pithagoras:extensions-changed')));
  };
  /** The chat's stream has sent what there was: from here what its pi says is shown as it comes. */
  const caughtUp = async (chat: string) => {
    await page.waitForFunction((chat) => (window as any).streams?.some((s: any) => !s.closed && s.url.includes(`/api/sessions/${chat}/events`)), chat);
    await page.evaluate((chat) => (window as any).streams.find((s: any) => !s.closed && s.url.includes(`/api/sessions/${chat}/events`)).emit('caught-up', {}), chat);
  };
  return { said, hears, changed, pushed, says: said2, caughtUp };
}

/**
 * A second extension, for what the Notes one has no use for: a panel that
 * lists what the agent ran in its shell, read from the chat as the page has
 * it, as a terminal brought by an extension would.
 */
const PROBE = `export default function (portal) {
  const { React } = portal;
  const h = React.createElement;
  let renders = 0;
  // Only the shell's calls are picked from the chat: the panel is drawn again when one of them changes, and for nothing else.
  const shell = (feed) => feed.items.filter((item) => item.kind === "tool" && item.name === "bash");
  function Runs({ chat, panel }) {
    const runs = portal.chats.use(chat.id, shell);
    renders++;
    return h("div", { "data-testid": "runs", "data-renders": renders, "data-params": JSON.stringify(panel.params ?? null) },
      runs.map((run) => h("pre", { key: run.id, "data-status": run.status }, "$ " + run.args.command + "\\n" + (run.output ?? ""))));
  }
  portal.slots.register("chat.panel", {
    id: "runs", title: "Runs", component: Runs,
    actions: ({ close }) => h("button", { type: "button", onClick: close }, "Done"),
    // Not there until the agent has run something, and live while a command runs.
    useButton: ({ chat }) => {
      const state = portal.chats.use(chat.id, (feed) => ({ any: shell(feed).length > 0, running: shell(feed).some((run) => run.status === "running") }));
      return { hidden: !state.any, live: state.running };
    },
  });
  // Draws nothing: it opens the panel when the server half says there is something to see.
  portal.slots.register("chat.background", { id: "watch", component: ({ chat, panels }) => {
    React.useEffect(() => portal.server.on((chatId, data) => { if (chatId === chat.id && data.type === "show") panels.open("runs", { from: data.from }); }), [chat.id, panels]);
    return null;
  } });
  portal.slots.register("chat.overlay", { id: "corner", component: ({ chat }) => h("div", { "data-testid": "overlay", style: { position: "absolute", left: 8, bottom: 8, zIndex: 30 } },
    "Over " + chat.title + " · " + portal.api.url("/state") + " ",
    h("button", { type: "button", onClick: () => portal.panels.open("files", { path: "README.md" }) }, "Show the README")) });
  portal.slots.register("chat.composer.above", { id: "chip", component: ({ chat }) => h("div", { "data-testid": "above" }, "Above the box of " + chat.id) });
  portal.slots.register("settings.page", { id: "own", component: () => h("p", { "data-testid": "probe-settings" }, "Probe's own settings") });
}`;

/** What was said besides asking where things stand: development React draws each part twice, and each asks. */
const acts = (said: { data: any }[]) => said.map((s) => s.data).filter((data) => data.type !== 'ready');
const header = (page: Page) => page.locator('.chat-header');
const panel = (page: Page) => page.locator('.chat-aside').filter({ has: page.locator(`[data-extension="${NAME}"]`) });
const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Destinations' });

test('an extension\'s panel is opened from the chat\'s header, talks to its extension in that chat, and closes like the portal\'s own', async ({ page }) => {
  await page.setViewportSize({ width: 1300, height: 800 });
  const { said, hears } = await portal(page);
  await page.goto('/s/a');
  const toggle = header(page).getByRole('button', { name: 'Notes', exact: true });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  // Its button, and the extension's own control beside it, are the size of the portal's.
  const sizes = await header(page).getByRole('button').evaluateAll((items) => Object.fromEntries(items.map((b) => [b.getAttribute('aria-label'), [b.getBoundingClientRect().height, b.querySelector('svg')?.getBoundingClientRect().width]])));
  expect(sizes.Notes).toEqual(sizes.Files);
  expect(sizes["Pin the agent's last reply to Notes"]).toEqual(sizes.Files);
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(panel(page)).toBeVisible();
  // Drawn, it asks its extension where things stand.
  await expect(panel(page)).toContainText('Loading…');
  await expect.poll(() => said[0]).toEqual({ chat: 'a', extension: NAME, data: { type: 'ready' } });
  await hears('a', { type: 'notes', notes: [{ id: 1, text: 'Ship on Friday', by: 'agent' }] });
  await expect(panel(page).getByRole('listitem')).toHaveText(['AgentShip on Friday✕']);
  // In the portal's own colours, from the stylesheet it brought.
  await expect(page.locator(`link[data-extension="${NAME}"]`)).toHaveCount(1);
  expect(await panel(page).locator('.pn-list li').evaluate((li) => getComputedStyle(li).borderTopLeftRadius)).toBe('10px');

  await panel(page).getByRole('textbox', { name: 'New note' }).fill('Call the printer');
  await panel(page).getByRole('button', { name: 'Pin', exact: true }).click();
  await panel(page).getByRole('button', { name: 'Remove this note' }).click();
  await expect.poll(() => acts(said)).toEqual([{ type: 'add', text: 'Call the printer' }, { type: 'remove', id: 1 }]);
  // What another extension is told is not this one's.
  await page.evaluate(() => (window as any).streams.find((s: any) => !s.closed && s.url.includes('/api/sessions/a/events')).emit('message', { seq: -2, type: 'portal_extension_ui', payload: { extension: 'another', data: { type: 'notes', notes: [] } } }));
  await expect(panel(page).getByRole('listitem')).toHaveCount(1);

  // Two panels beside the conversation is what fits: a third closes the one open longest, whoever brought it.
  await header(page).getByRole('button', { name: 'Terminal', exact: true }).click();
  await header(page).getByRole('button', { name: 'Files', exact: true }).click();
  await expect(panel(page)).toHaveCount(0);
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();
  await panel(page).getByRole('button', { name: 'Close Notes' }).click();
  await expect(panel(page)).toHaveCount(0);
});

test('an extension\'s control in the header acts on the chat it is in, and opens the extension\'s own panel', async ({ page }) => {
  await page.setViewportSize({ width: 1300, height: 800 });
  const { said, hears } = await portal(page);
  await page.goto('/s/a');
  await header(page).getByRole('button', { name: "Pin the agent's last reply to Notes" }).click();
  await expect(panel(page)).toBeVisible();
  await expect.poll(() => acts(said)).toEqual([{ type: 'pin-last' }]);
  expect(said.every((s) => s.chat === 'a' && s.extension === NAME)).toBe(true);
  await hears('a', { type: 'nothing-to-pin' });
  await expect(header(page).getByRole('button', { name: 'The agent has not replied yet' })).toBeVisible();

  // In another chat it is that chat's: drawn anew, asking that chat's extension.
  await hears('a', { type: 'notes', notes: [{ id: 1, text: 'Only in the first chat', by: 'you' }] });
  await expect(panel(page)).toContainText('Only in the first chat');
  await page.getByRole('complementary', { name: 'Sidebar' }).getByText('Second chat', { exact: true }).click();
  await expect(page).toHaveURL(/\/s\/b$/);
  await expect(panel(page)).toContainText('Loading…');
  await expect.poll(() => said.at(-1)).toEqual({ chat: 'b', extension: NAME, data: { type: 'ready' } });
});

test('an extension\'s page is in the sidebar, at an address of its own, and can go to the portal\'s pages', async ({ page }) => {
  await portal(page);
  // Opened by its address, before the extension is in the page.
  await page.goto(`/x/${NAME}/notes`);
  await expect(page.getByRole('heading', { name: 'Notes' })).toBeVisible();
  await expect(sidebar(page).getByRole('button', { name: 'Notes' })).toHaveAttribute('aria-current', 'page');
  // Its icon is a bare <svg>: the portal gives it the size its own icons have.
  const icons = await sidebar(page).getByRole('button').evaluateAll((items) => Object.fromEntries(items.map((b) => [b.textContent!.trim(), b.querySelector('svg')!.getBoundingClientRect().width])));
  expect(icons.Notes).toBeGreaterThan(0);
  expect(icons.Notes).toBe(icons.Audit);
  // Every chat's notes, from the extension's own route: no chat's pi is asked.
  await expect(page.locator('.pn-chat')).toContainText('Kept with the second chat');
  await page.locator('.pn-chat').getByRole('button', { name: 'Second chat' }).click();
  await expect(page).toHaveURL(/\/s\/b$/);
  await sidebar(page).getByRole('button', { name: 'Notes' }).click();
  await expect(page).toHaveURL(new RegExp(`/x/${NAME}/notes$`));
});

test('an extension removed, or changed, is taken out of the page and loaded again without a reload of the portal', async ({ page }) => {
  await page.setViewportSize({ width: 1300, height: 800 });
  const { changed } = await portal(page);
  await page.goto('/s/a');
  const toggle = header(page).getByRole('button', { name: 'Notes', exact: true });
  await toggle.click();
  await expect(panel(page)).toBeVisible();

  await changed({ installed: false });
  await expect(toggle).toHaveCount(0);
  await expect(panel(page)).toHaveCount(0);
  await expect(sidebar(page).getByRole('button', { name: 'Notes' })).toHaveCount(0);
  await expect(page.locator(`link[data-extension="${NAME}"]`)).toHaveCount(0);
  await page.goto(`/x/${NAME}/notes`);
  await expect(page.getByRole('alert')).toHaveText("This page's extension is not installed, or is switched off.");

  // Installed again, under another revision: its module is fetched anew.
  await changed({ installed: true, revision: 2 });
  await expect(page.getByRole('heading', { name: 'Notes' })).toBeVisible();
  await expect(sidebar(page).getByRole('button', { name: 'Notes' })).toHaveCount(1);
});

test('an extension that fails to load, or to draw, fails alone', async ({ page }) => {
  const broken = `export default function (portal) {
    portal.slots.register("nav.page", { id: "fine", title: "Registered first", component: () => null });
    portal.slots.register("no.such.slot", { id: "x", component: () => null });
  }`;
  await portal(page, broken);
  await page.goto(`/x/${NAME}/fine`);
  const failed = page.getByRole('alert');
  await expect(failed).toContainText("This page's extension could not be loaded.");
  await expect(failed).toContainText('There is no slot called "no.such.slot"');
  // What it registered before it failed is gone with it, and the portal is as it was.
  await expect(sidebar(page).getByRole('button', { name: 'Registered first' })).toHaveCount(0);
  await expect(sidebar(page).getByRole('button', { name: 'Sessions' })).toBeVisible();

  const { changed } = await portal(page, `export default function (portal) {
    portal.slots.register("nav.page", { id: "fine", title: "Draws badly", component: () => { throw new Error("drew badly"); } });
  }`);
  await changed({ revision: 3 });
  await expect(page.getByRole('alert')).toContainText('drew badly');
  await expect(sidebar(page).getByRole('button', { name: 'Draws badly' })).toBeVisible();
});

test('a panel says more of itself: tabs in its head, a button that follows the chat, kept and asking while something in it would be lost', async ({ page }) => {
  await page.setViewportSize({ width: 1300, height: 800 });
  const { hears, pushed } = await portal(page);
  await page.goto('/s/a');
  const toggle = header(page).getByRole('button', { name: 'Notes', exact: true });
  await expect(toggle).toHaveAttribute('title', 'Notes');
  // Its button says how many there are, as the server half told this page: the chat's pi is not asked.
  await pushed('a', NAME, { type: 'count', count: 2 });
  await expect(toggle).toHaveAttribute('title', 'Notes (2)');
  await toggle.click();
  await hears('a', { type: 'notes', notes: [{ id: 1, text: 'From the agent', by: 'agent' }, { id: 2, text: 'From me', by: 'you' }] });

  // Whose notes are shown is chosen in the panel's head, where its title was, and its body follows.
  const tabs = page.locator('.chat-aside-head').getByRole('tablist', { name: 'Notes' });
  await expect(tabs.getByRole('tab')).toHaveText(['All', 'Agent', 'You']);
  await expect(panel(page).getByRole('listitem')).toHaveCount(2);
  await tabs.getByRole('tab', { name: 'You' }).click();
  await expect(tabs.getByRole('tab', { name: 'You' })).toHaveAttribute('aria-selected', 'true');
  await expect(panel(page).getByRole('listitem')).toHaveText(['YouFrom me✕']);
  await tabs.getByRole('tab', { name: 'All' }).click();

  // A note being written: closed by hand, it asks first, and stays on no.
  await panel(page).getByRole('textbox', { name: 'New note' }).fill('Half a thought');
  await panel(page).getByRole('button', { name: 'Close Notes' }).click();
  await expect(page.getByRole('alertdialog')).toContainText('Discard the note you were writing?');
  await page.getByRole('alertdialog').getByRole('button', { name: 'Cancel' }).click();
  await expect(panel(page).getByRole('textbox', { name: 'New note' })).toHaveValue('Half a thought');
  // And it is not the one closed to make room for a third: the terminal, opened after it, goes instead.
  const terminal = header(page).getByRole('button', { name: 'Terminal', exact: true });
  await terminal.click();
  await header(page).getByRole('button', { name: 'Files', exact: true }).click();
  await expect(panel(page)).toBeVisible();
  await expect(terminal).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Discard' }).click();
  await expect(panel(page)).toHaveCount(0);
  // Opened again it has none of what it had: nothing to ask about.
  await toggle.click();
  await expect(panel(page).getByRole('textbox', { name: 'New note' })).toHaveValue('');
  await panel(page).getByRole('button', { name: 'Close Notes' }).click();
  await expect(panel(page)).toHaveCount(0);
});

test("a call of an extension's tool is drawn by the extension, and any other call, or its own while it runs, by the portal", async ({ page }) => {
  await page.setViewportSize({ width: 1300, height: 800 });
  const { says, caughtUp } = await portal(page);
  await page.goto('/s/a');
  await caughtUp('a');
  await says('a', 'tool_execution_start', { toolCallId: 'n1', toolName: 'note', args: { text: 'Ship on Friday' } });
  await expect(page.locator('.tool-row')).toHaveCount(1);
  await expect(page.locator('.pn-call')).toHaveCount(0);
  await says('a', 'tool_execution_end', { toolCallId: 'n1', toolName: 'note', isError: false, result: { content: [{ type: 'text', text: 'Pinned note #1' }] } });
  const call = page.locator('.tool-row .pn-call');
  await expect(call).toContainText('Pinned to Notes');
  await expect(call).toContainText('Ship on Friday');
  await call.getByRole('button', { name: 'Open Notes' }).click();
  await expect(panel(page)).toBeVisible();
  await says('a', 'tool_execution_start', { toolCallId: 'b1', toolName: 'bash', args: { command: 'ls' } });
  await expect(page.locator('.tool-row')).toHaveCount(2);
  await expect(page.locator('.pn-call')).toHaveCount(1);
});

test('an extension follows what the agent runs from the chat itself, and is drawn again only for what it reads of it', async ({ page }) => {
  await page.setViewportSize({ width: 1300, height: 800 });
  const { says, pushed, caughtUp } = await portal(page, undefined, PROBE);
  await page.goto('/s/a');
  await caughtUp('a');
  // Nothing run yet: its button is not in the header, where the other extension's is.
  await expect(header(page).getByRole('button', { name: 'Notes', exact: true })).toBeVisible();
  const toggle = header(page).getByRole('button', { name: 'Runs', exact: true });
  await expect(toggle).toHaveCount(0);

  // The agent runs a command: the button is there, and says something is running.
  await says('a', 'tool_execution_start', { toolCallId: 'b1', toolName: 'bash', args: { command: 'ls -la' } });
  await expect(toggle.locator('.header-live-dot')).toHaveCount(1);
  await toggle.click();
  const runs = page.getByTestId('runs');
  await expect(runs.locator('pre')).toHaveText(['$ ls -la\n']);
  // Its output as it comes, and its end.
  await says('a', 'tool_execution_update', { toolCallId: 'b1', partialResult: { content: [{ type: 'text', text: 'total 8\n' }] } });
  await expect(runs.locator('pre')).toContainText('total 8');
  await says('a', 'tool_execution_end', { toolCallId: 'b1', toolName: 'bash', isError: false, result: { content: [{ type: 'text', text: 'total 8\nREADME.md\n' }] } });
  await expect(runs.locator('pre')).toHaveAttribute('data-status', 'done');
  await expect(runs.locator('pre')).toContainText('README.md');

  // The reply that follows comes a token at a time. None of it is what the panel reads: it is not drawn again.
  const drawn = await runs.getAttribute('data-renders');
  for (const word of ['The ', 'folder ', 'has ', 'one ', 'file.']) await says('a', 'message_update', { streamId: 's1', assistantMessageEvent: { type: 'text_delta', delta: word } }, true);
  await expect(page.getByText('The folder has one file.')).toBeVisible();
  expect(await runs.getAttribute('data-renders')).toBe(drawn);
  await says('a', 'tool_execution_start', { toolCallId: 'b2', toolName: 'bash', args: { command: 'cat README.md' } });
  await expect(runs.locator('pre')).toHaveCount(2);

  // What it put in the panel's head closes it; its server half's word opens it again, with what to show.
  await page.locator('.chat-aside-head').getByRole('button', { name: 'Done' }).click();
  await expect(runs).toHaveCount(0);
  await pushed('a', 'probe', { type: 'show', from: 'the server half' });
  await expect(page.getByTestId('runs')).toHaveAttribute('data-params', '{"from":"the server half"}');

  // Over the chat and above the message box, with where its own routes are.
  await expect(page.getByTestId('overlay')).toContainText('Over First chat · /api/x/probe/state');
  await expect(page.getByTestId('above')).toHaveText('Above the box of a');
  // Any panel of the chat by its name, the portal's own included.
  const files = header(page).getByRole('button', { name: 'Files', exact: true });
  await expect(files).toHaveAttribute('aria-expanded', 'false');
  await page.getByTestId('overlay').getByRole('button', { name: 'Show the README' }).click();
  await expect(files).toHaveAttribute('aria-expanded', 'true');
});

test("an extension's own page in Settings, and why its server half is not running", async ({ page }) => {
  const { changed } = await portal(page, undefined, PROBE);
  await page.goto('/settings/extensions');
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  const row = dialog.getByRole('listitem').filter({ hasText: 'probe' });
  // It reads no settings the portal could find, and has a page all the same: its own.
  await row.getByRole('button', { name: /Configure/ }).click();
  await expect(dialog.getByTestId('probe-settings')).toHaveText("Probe's own settings");
  await page.goto('/settings/extensions');
  await changed({ probeServerError: 'cannot start here' });
  await expect(dialog.getByRole('listitem').filter({ hasText: 'probe' }).getByRole('alert')).toHaveText('Its server half could not be started: cannot start here');
});

test('a window an extension brought to voice mode opens from its button, is placed like the portal\'s own, and closes', async ({ page }) => {
  await page.addInitScript(() => {
    (window as any).EventSource = class { onmessage: any; onopen: any; addEventListener() {} close() {} };
  });
  await page.route('**/api/sessions/test/commands', (route) => route.fulfill({ json: { commands: [] } }));
  await page.route('**/api/sessions/test/config', (route) => route.fulfill({ status: 503, json: {} }));
  await page.route('**/api/voice', (route) => route.fulfill({ json: { enabled: true } }));
  await page.route('**/api/browser', (route) => route.fulfill({ json: { install: { container: 'running' } } }));
  await page.setViewportSize({ width: 1400, height: 860 });
  await page.goto('/tests/voice.html?brought=1');
  await page.getByRole('button', { name: 'Turn on hands-free voice' }).click();
  await expect(page.getByRole('status')).toHaveText('Listening', { timeout: 25000 });

  await page.getByRole('button', { name: 'Show Probe' }).click();
  const brought = page.locator('.voice-extension-window');
  await expect(brought).toHaveClass(/is-open/);
  await expect(brought).toHaveClass(/as-side/);
  await expect(page.getByTestId('probe-window')).toContainText('Probe for A little room to think');
  await expect(page.getByRole('button', { name: 'Show Probe' })).toHaveCount(0);
  // The terminal's place is the side: the extension's window moves to the middle, as Files would.
  await page.getByRole('button', { name: 'Show terminal' }).click();
  await expect(brought).toHaveClass(/as-main/);
  await page.getByTestId('probe-window').getByRole('button', { name: 'Done' }).click();
  await expect(brought).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Show Probe' })).toBeVisible();
});
