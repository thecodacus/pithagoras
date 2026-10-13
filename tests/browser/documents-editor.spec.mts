import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { type Page } from '@playwright/test';
import { test, expect } from './portal-mock';

/**
 * The Documents extension's editor, as `npm run build` builds it
 * (extensions/docs/build.mjs): Markdown in, Markdown out, the same as it came
 * where a person would write it so.
 */
const BUNDLE = fileURLToPath(new URL('../../extensions/docs/web/editor.js', import.meta.url));

test.beforeAll(() => {
  execFileSync(process.execPath, [fileURLToPath(new URL('../../extensions/docs/build.mjs', import.meta.url))], { stdio: 'ignore' });
});

/** A page with nothing but the editor's module on it, reachable as `window.editor`. */
async function editorPage(page: Page) {
  await page.route('http://editor.test/**', (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/editor.js') return route.fulfill({ contentType: 'text/javascript', body: readFileSync(BUNDLE, 'utf8') });
    return route.fulfill({ contentType: 'text/html', body: '<!doctype html><div id="root"></div><script type="module">window.editor = await import("/editor.js");</script>' });
  });
  await page.goto('http://editor.test/');
  await page.waitForFunction(() => (window as any).editor);
}

const roundTrip = (page: Page, markdown: string) =>
  page.evaluate(async (markdown) => {
    const root = document.createElement('div');
    document.body.append(root);
    const editor = await (window as any).editor.createEditor({ root, markdown });
    const out = editor.markdown();
    await editor.destroy();
    root.remove();
    return out as string;
  }, markdown);

const CORPUS: Record<string, string> = {
  headings: '# Title\n\nText.\n\n## Second\n\n### Third\n\n#### Fourth\n\n##### Fifth\n\n###### Sixth\n',
  lists: '- One\n- Two\n\n1. First\n2. Second\n\n- Parent\n  - Child\n    - Grandchild\n- Back\n\n1. Ordered\n   - Bullet child\n2. Again\n',
  links: 'See [the guide](https://example.com/guide "The guide") and [another document](./other.md).\n\nAn autolink: <https://example.com>.\n',
  code: 'Run `npm ci` first.\n\n```js\nconst answer = 42;\n```\n\n```\nplain\n  indented\n```\n',
  images: '![A diagram](images/diagram.png)\n\n![With a title](./photo.jpg "A photo")\n',
  emphasis: 'This is *emphasis*, **strong**, ***both*** and ~~struck~~.\n\nA hard break\\\nand on.\n\n> A quote with **bold**.\n\n---\n\nThe end.\n',
  html: 'A key: <kbd>Ctrl</kbd> + <kbd>C</kbd>.\n\n<details>\n<summary>More</summary>\n\nHidden text.\n\n</details>\n\nLine one<br>line two.\n\n<!-- a comment -->\n',
  long: `# Long\n\n${Array.from({ length: 300 }, (_, i) => `Paragraph ${i + 1} of a long document, with some words in it.`).join('\n\n')}\n`,
};

test('a document opened in the editor and read back is the Markdown it was', async ({ page }) => {
  await editorPage(page);
  for (const [name, markdown] of Object.entries(CORPUS)) expect(await roundTrip(page, markdown), name).toBe(markdown);
  // A table keeps its cells and alignment; only its rule under the head is written shorter.
  const table = '| Name | Role | Count |\n| --- | :---: | ---: |\n| Alice | *Owner* | `3` |\n';
  expect(await roundTrip(page, table)).toBe('| Name | Role | Count |\n| - | :-: | -: |\n| Alice | *Owner* | `3` |\n');
});

test('the editor says what was typed into it as Markdown, and brings no React of its own', async ({ page }) => {
  await editorPage(page);
  await page.evaluate(async () => {
    (window as any).changes = [];
    (window as any).typed = await (window as any).editor.createEditor({ root: document.getElementById('root'), markdown: '# Plan\n\nShip it.\n', onChange: (md: string) => (window as any).changes.push(md) });
  });
  await page.locator('#root p').click();
  await page.keyboard.press('End');
  await page.keyboard.type(' On Friday.');
  await expect.poll(() => page.evaluate(() => (window as any).changes.at(-1))).toBe('# Plan\n\nShip it. On Friday.\n');
  expect(await page.evaluate(() => (window as any).typed.markdown())).toBe('# Plan\n\nShip it. On Friday.\n');
  // The page's React draws everything around it: a second one in the bundle would be dead weight.
  expect(readFileSync(BUNDLE, 'utf8')).not.toMatch(/react\.production|__SECRET_INTERNALS|from\s*["']react["']/);
});
