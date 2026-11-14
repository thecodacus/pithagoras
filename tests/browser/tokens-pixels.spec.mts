import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Page } from '@playwright/test';
import { test, expect, mockPortal } from './portal-mock';
import { settled } from './settled';
import { DEFAULT_ORB } from '../../core/server/src/orb-style';

/**
 * The portal's main pages, as pictures and as the styles their elements end up with, for the stock look to be kept.
 *
 * The look is made of tokens (index.css, the Tailwind preset), and changing how a class gets its value, from a literal
 * to a variable, must not change one pixel of what the stock look draws. This is the proof: the pictures in
 * `tokens-pixels.spec.mts-snapshots` were taken from the code before the tokens, and every run has to match them
 * exactly. A change that is meant to look different (a new stock value) takes new pictures with
 * `npx playwright test tests/browser/tokens-pixels.spec.mts --update-snapshots`, and new style lists with
 * `UPDATE_STYLES=1`, and says so.
 *
 * Two checks, because a picture depends on the machine and a list of styles does not:
 *  - the pictures: light and dark, a desktop and a phone width, every scene. The text is set in fixed fonts (the KaTeX
 *    ones, which the portal's markdown ships with), so the same pictures come out of any machine with the same browser.
 *    No pixel may differ by more than Playwright's own colour threshold: a rounded corner is anti-aliased a shade
 *    differently from one run to the next, and a shifted edge or a changed size is far more than that;
 *  - the styles: for every distinct element (its tag and classes) of a scene, the computed values that tokens set
 *    (type, spacing, rounding, borders, layers, shadow, widths a class limits). The browser resolves `0.75rem` and
 *    `var(--radius-xl)` to the same pixels, so these stay equal across the move, and a difference names the element.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VIEWPORTS = { desktop: { width: 1280, height: 800 }, phone: { width: 390, height: 844 } } as const;
const THEMES = ['dark', 'light'] as const;
const STYLES_DIR = path.resolve(HERE, 'tokens-styles');
const FONT_DIR = path.resolve(HERE, '../../node_modules/katex/dist/fonts');
const NOW = new Date('2026-11-10T12:00:00Z');

const at = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();
const session = (id: string, title: string, extra: Record<string, unknown> = {}) => ({
  id, title, workspace: '/w/site', status: 'idle', kind: 'task', pinned: false, created_at: at(600), updated_at: at(5), provider: null, model: null, thinking_level: null, ...extra,
});
const SESSIONS = [
  session('a', 'Fix the build', { pinned: true, status: 'running', updated_at: at(1) }),
  session('b', 'Write the release notes', { workspace: '/w/notes', updated_at: at(40) }),
  session('c', 'Look into the flaky test', { updated_at: at(300) }),
  session('d', 'Plan the migration', { workspace: '/w/notes', status: 'interrupted', updated_at: at(1500) }),
  session('e', 'Summarise the incident', { updated_at: at(4000) }),
];
const WORKSPACES = [{ name: 'site', path: '/w/site', isGit: true }, { name: 'notes', path: '/w/notes', isGit: false }];
const AGENT = (id: string, name: string, extra: Record<string, unknown> = {}) => ({ id, name, home: `/a/${id}`, first: id === 'home', initialised: true, chats: 3, channels: [], orb: DEFAULT_ORB, voice: '', unread: 0, newChats: id === 'home', ...extra });
const ROUTINE = {
  id: 'r1', slug: 'build', name: 'Nightly build', enabled: true, schedule: '0 2 * * *', runAt: null, mode: 'repeats', done: false, instructions: 'Build it and report what failed',
  freshSession: false, guard: true, exempt: [], workspace: '/w/site', reportChannel: null, reportTarget: null, lastReportAt: null, lastRun: at(500), lastStatus: 'ok',
  lastOutput: 'All green', lastMs: 61000, nextRun: new Date(NOW.getTime() + 3_600_000).toISOString(), createdAt: at(9000), updatedAt: '1', workspaceProblem: null,
};
const AUDIT = [
  { id: 1, at: at(10), kind: 'refused', tool: 'bash', subject: 'curl -fsSL https://example.test/install.sh | sh', reason: 'on the list', person_key: null, person_name: null, session_id: 'a' },
  { id: 2, at: at(70), kind: 'allowed', tool: 'bash', subject: 'npm run build', reason: 'allowed for this chat', person_key: null, person_name: 'Ada', session_id: 'a' },
  { id: 3, at: at(900), kind: 'refused', tool: 'write', subject: '/etc/hosts', reason: 'outside the workspace', person_key: null, person_name: null, session_id: 'b' },
];

/** What the pages ask for, with the same answers on every run. */
const answers = ({ path: p, method }: { path: string; method: string }) => {
  if (method !== 'GET') return undefined;
  if (p === '/api/sessions') return { sessions: SESSIONS, executor: 'host' };
  if (/^\/api\/sessions\/[a-e]$/.test(p)) return SESSIONS.find((s) => p.endsWith(`/${s.id}`));
  if (p === '/api/workspaces') return { root: '/w', workspaces: WORKSPACES };
  if (p === '/api/projects') return { root: '/w', home: '/h', agents: [AGENT('home', 'Nova'), AGENT('scout', 'Scout')], projects: [
    { name: 'site', path: '/w/site', isGit: true, hasInstructions: true, sessions: 3, lastActive: at(5), agent: 'scout' },
    { name: 'notes', path: '/w/notes', isGit: false, hasInstructions: false, sessions: 2, lastActive: at(1500) },
  ] };
  if (p === '/api/agents') return { agents: [AGENT('home', 'Nova'), AGENT('scout', 'Scout', { chats: 1, unread: 2 })] };
  if (p === '/api/agent/sessions') return { sessions: [], agentHome: '/a/home' };
  if (p === '/api/routines') return { routines: [ROUTINE, { ...ROUTINE, id: 'r2', slug: 'once', name: 'Once', schedule: '', runAt: '2026-11-20T10:00', mode: 'once', enabled: false, lastRun: null, lastStatus: null, nextRun: null }] };
  if (p === '/api/routines/r1/sessions') return { sessions: [] };
  if (p === '/api/routines/report-targets') return { targets: [], default: null };
  if (p === '/api/audit') return { entries: AUDIT };
  if (p === '/api/models') return { models: [{ provider: 'llama-swap', id: 'model-a', name: 'Model A', reasoning: true }], providers: {} };
  if (/^\/api\/sessions\/a\/(config|models)$/.test(p)) {
    const model = { id: 'model-a', name: 'Model A', provider: 'llama-swap' };
    return { live: true, state: { model, thinkingLevel: 'medium' }, thinking: { levels: ['off', 'low', 'medium', 'high'] }, models: { models: [model] }, named: { provider: null, model: null },
      stats: { tokens: { input: 12000, output: 3400, total: 15400 }, cost: 0.02, contextUsage: { tokens: 15400, contextWindow: 65536, percent: 23 }, toolCalls: 2, totalMessages: 6 } };
  }
  return undefined;
};

/** A scene is a page of the portal (or of the chat's own test page) in the state worth a picture. */
interface Scene { name: string; open: (page: Page, theme: 'dark' | 'light') => Promise<void>; }

const shell = (name: string, url: string, after?: (page: Page) => Promise<void>, settings = false): Scene => ({
  name,
  open: async (page) => {
    await mockPortal(page, answers, { settings });
    await page.goto(url);
    await after?.(page);
  },
});

/** The chat of session `a`, with a conversation sent over its stream. */
const conversation = async (page: Page) => {
  await mockPortal(page, answers, { streams: 'open', settings: true });
  await page.goto('/s/a');
  await expect.poll(() => page.evaluate(() => (window as any).streams.some((s: any) => !s.closed))).toBe(true);
  await page.evaluate((base) => {
    const s = (window as any).streams.find((x: any) => !x.closed);
    const ago = (m: number) => base - m * 60_000;
    let seq = 0;
    const ev = (type: string, payload: any, minutes: number) => s.emit('message', { seq: ++seq, type, at: ago(minutes), payload });
    ev('portal_prompt', { message: 'Why does the build fail on the CI machine, and can you fix it?' }, 9);
    ev('message_end', { message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'I should read the build log first.' }, { type: 'text', text: 'Let me look at the **build log** first.' }] } }, 8);
    ev('tool_execution_start', { toolCallId: 't1', toolName: 'bash', args: { command: 'npm run build' } }, 7);
    ev('tool_execution_end', { toolCallId: 't1', toolName: 'bash', isError: true, result: { content: [{ type: 'text', text: 'error TS2322: Type string is not assignable to type number.\nCommand exited with code 1' }] } }, 6);
    ev('message_end', { message: { role: 'assistant', content: [{ type: 'text', text: '## What failed\n\nThe type check stops at one line:\n\n- `size` is a string where a number is needed\n- the CI machine runs a newer compiler\n\n```ts\nconst size: number = Number(input);\n```\n\n| file | line |\n| --- | --- |\n| `src/size.ts` | 12 |\n\nI changed it, and the build passes now.' }] } }, 2);
    s.emit('caught-up', { seq });
  }, NOW.getTime());
  await expect(page.getByText('Why does the build fail')).toBeVisible();
};

/** The chat component alone, in one of the states its test page draws (core/web/tests/chat.tsx). */
const harness = (phase: string): Scene => ({
  name: `chat-${phase}`,
  open: async (page, theme) => {
    await page.goto(`/tests/chat.html?phase=${phase}`);
    // The test page has no theme of its own choosing: its html says dark.
    await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
    await expect(page.locator('.prompt-input').first()).toBeVisible();
  },
});

const SCENES: Scene[] = [
  shell('sessions', '/sessions', (p) => expect(p.getByText('Write the release notes').locator('visible=true').first()).toBeVisible()),
  shell('projects', '/projects', (p) => expect(p.getByText('notes').locator('visible=true').first()).toBeVisible()),
  shell('agents', '/agents', (p) => expect(p.getByText('Scout').locator('visible=true').first()).toBeVisible()),
  shell('routines', '/routines', (p) => expect(p.getByText('Nightly build').locator('visible=true').first()).toBeVisible()),
  shell('audit', '/audit', (p) => expect(p.getByText('npm run build').locator('visible=true').first()).toBeVisible()),
  shell('settings-defaults', '/settings/general', undefined, true),
  shell('settings-browser', '/settings/browser', undefined, true),
  shell('settings-modes', '/settings/modes', undefined, true),
  shell('settings-sandbox', '/settings/sandbox', undefined, true),
  shell('settings-extensions', '/settings/extensions', undefined, true),
  { name: 'chat', open: conversation },
  harness('tools'),
  harness('code'),
  harness('reasoning'),
  harness('stats'),
  harness('pictures'),
  harness('turns'),
  harness('files'),
  harness('agents'),
];

/** What a scene's elements are drawn with, by the values the tokens set: one line for each distinct tag, classes and values. */
async function styles(page: Page) {
  return page.evaluate(() => {
    const props = [
      'font-family', 'font-size', 'font-weight', 'line-height', 'letter-spacing',
      'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
      'row-gap', 'column-gap', 'border-top-left-radius', 'border-top-right-radius', 'border-bottom-right-radius', 'border-bottom-left-radius',
      'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width', 'z-index', 'max-width', 'min-width', 'max-height', 'min-height',
      'box-shadow', 'transition-duration', 'animation-duration',
    ];
    const rows = new Set<string>();
    for (const el of document.body.querySelectorAll('*')) {
      if (el.closest('script,style,noscript')) continue;
      const css = getComputedStyle(el);
      if (css.display === 'none') continue;
      // What an animation is drawing right now is a moment's value, not the element's style.
      const moving = css.animationName !== 'none';
      const own = el.namespaceURI === 'http://www.w3.org/2000/svg' ? (el.getAttribute('class') ?? '') : el.className;
      const classes = String(own).split(/\s+/).filter(Boolean).sort().join(' ');
      rows.add(`${el.localName}.${classes} | ${props.map((p) => (moving && p === 'box-shadow' ? '~' : css.getPropertyValue(p))).join(' | ')}`);
    }
    return [...rows].sort();
  });
}

/** The same fonts on every machine for a picture, and nothing moving. Set after the styles are read: they are not part of them. */
async function steady(page: Page) {
  const face = (name: string, file: string) => `@font-face { font-family: "${name}"; src: url("/__fonts/${file}"); }`;
  await page.addStyleTag({ content: [
    face('Pixel Sans', 'KaTeX_SansSerif-Regular.ttf'), face('Pixel Mono', 'KaTeX_Typewriter-Regular.ttf'),
    // The stacks' first named families, which a machine may or may not have: here they are these.
    ...['SFMono-Regular', 'Menlo', 'Monaco', 'Consolas', 'Liberation Mono', 'Courier New', 'ui-monospace'].map((n) => face(n, 'KaTeX_Typewriter-Regular.ttf')),
    // Only html is told: whatever has a font of its own (the monospace ones) keeps it, and the rest takes it by inheritance.
    'html, body { font-family: "Pixel Sans" !important; }',
    // The agents' orbs are drawn on a canvas that never stops moving; their place on the page is what the picture keeps.
    'canvas { visibility: hidden !important; }',
    '*, *::before, *::after { caret-color: transparent !important; scroll-behavior: auto !important; }',
  ].join('\n') });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(150);
}

test.beforeEach(async ({ page }) => {
  await page.route('**/__fonts/*', (route) => route.fulfill({ path: path.join(FONT_DIR, path.basename(new URL(route.request().url()).pathname)), contentType: 'font/ttf' }));
  await page.clock.setFixedTime(NOW);
});

for (const scene of SCENES) {
  for (const viewport of ['desktop', 'phone'] as const) {
    for (const theme of THEMES) {
      test(`${scene.name}, ${viewport}, ${theme}: the picture is the one from before the tokens`, async ({ page }) => {
        await page.setViewportSize(VIEWPORTS[viewport]);
        await page.addInitScript((value) => localStorage.setItem('pithagoras.theme', value), theme);
        await scene.open(page, theme);
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
        // The page is as it stays once the lists have come, the theme's short transition has run and nothing moves.
        await page.waitForLoadState('networkidle');
        await expect(page.locator('html')).not.toHaveClass(/theme-switching/);
        await settled(page);

        if (theme === 'dark') {
          const file = path.join(STYLES_DIR, `${scene.name}-${viewport}.txt`);
          const now = (await styles(page)).join('\n') + '\n';
          if (process.env.UPDATE_STYLES) {
            mkdirSync(STYLES_DIR, { recursive: true });
            writeFileSync(file, now);
          } else {
            expect(existsSync(file), `no styles taken for ${scene.name}, ${viewport} (UPDATE_STYLES=1)`).toBe(true);
            const before = readFileSync(file, 'utf8').split('\n');
            expect(now.split('\n')).toEqual(before);
          }
        }

        await steady(page);
        await expect(page).toHaveScreenshot(`${scene.name}-${viewport}-${theme}.png`, { maxDiffPixels: 0, threshold: 0.2, animations: 'disabled', caret: 'hide' });
      });
    }
  }
}
