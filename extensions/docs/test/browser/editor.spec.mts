import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { type Page } from '@playwright/test';
import { test, expect } from '../../../../tests/browser/portal-mock';
import { clickIntoText } from './caret';

/**
 * The Documents extension's editor, as `npm run build` builds it
 * (extensions/docs/build.mjs): Markdown in, Markdown out, the same as it came
 * where a person would write it so.
 */
const BUNDLE = fileURLToPath(new URL('../../web/editor.js', import.meta.url));

test.beforeAll(() => {
  execFileSync(process.execPath, [fileURLToPath(new URL('../../build.mjs', import.meta.url))], { stdio: 'ignore' });
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
  tasks: '- [ ] To do\n- [x] Done\n',
  footnote: 'A note[^1].\n\n[^1]: The note.\n',
  // What the editor cannot hold is kept apart, and comes back as it was (extensions/docs/src/frame.js).
  frontMatter: '---\ntitle: Plan\ntags: [a, b]\n---\n\n# Plan\n\nText.\n',
  crlf: '# Title\r\n\r\nOne\r\n\r\n- a\r\n- b\r\n',
  byteOrderMark: '\uFEFF# Title\n\nText.\n',
  long: `# Long\n\n${Array.from({ length: 300 }, (_, i) => `Paragraph ${i + 1} of a long document, with some words in it.`).join('\n\n')}\n`,
};

test('a document opened in the editor and read back is the Markdown it was', async ({ page }) => {
  await editorPage(page);
  for (const [name, markdown] of Object.entries(CORPUS)) expect(await roundTrip(page, markdown), name).toBe(markdown);
  // A table keeps its cells and alignment; only its rule under the head is written shorter.
  const table = '| Name | Role | Count |\n| --- | :---: | ---: |\n| Alice | *Owner* | `3` |\n';
  expect(await roundTrip(page, table)).toBe('| Name | Role | Count |\n| - | :-: | -: |\n| Alice | *Owner* | `3` |\n');
});

/** Hand-written styles the editor writes in its own: each as it ends up, and that is where it stays. */
const STYLES: Record<string, [string, string]> = {
  stars: ['* One\n* Two\n\n1) First\n2) Second\n', '- One\n- Two\n\n1. First\n2. Second\n'],
  blanks: ['One\n\n\n\nTwo\n', 'One\n\nTwo\n'],
  hardBreak: ['One  \nTwo\n', 'One\\\nTwo\n'],
  reference: ['[a][1]\n\n[1]: https://example.com\n', '[a](https://example.com)\n'],
  noNewline: ['# Title', '# Title\n'],
  frontMatterBlanks: ['---\na: 1\n---\n\n\n* One\n', '---\na: 1\n---\n\n\n- One\n'],
};

test('a document written in another style comes back in the editor\'s, and writing that again changes nothing', async ({ page }) => {
  await editorPage(page);
  for (const [name, [written, expected]] of Object.entries(STYLES)) {
    const once = await roundTrip(page, written);
    expect(once, name).toBe(expected);
    expect(await roundTrip(page, once), name).toBe(once);
  }
  // Every text of the corpus is where it stays, also after the editor has held another document in between.
  const text = await page.evaluate(async ([a, b]) => {
    const root = document.createElement('div');
    document.body.append(root);
    const editor = await (window as any).editor.createEditor({ root, markdown: a });
    editor.replace(b);
    const out = editor.markdown();
    await editor.destroy();
    root.remove();
    return out as string;
  }, [CORPUS.frontMatter, CORPUS.crlf]);
  expect(text).toBe(CORPUS.crlf);
});

test('another document put in its place cannot be undone back into the first', async ({ page }) => {
  await editorPage(page);
  await page.evaluate(async () => {
    (window as any).held = await (window as any).editor.createEditor({ root: document.getElementById('root'), markdown: '# First\n\nOne.\n' });
  });
  await clickIntoText(page.locator('#root p'));
  await page.keyboard.press('End');
  await page.keyboard.type(' More.');
  await page.waitForTimeout(100);
  await page.evaluate(() => (window as any).held.replace('# Second\n\nTwo.\n'));
  await page.locator('#root p').click();
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+z');
  expect(await page.evaluate(() => (window as any).held.markdown())).toBe('# Second\n\nTwo.\n');
});

test('the editor says what was typed into it as Markdown, and brings no React of its own', async ({ page }) => {
  await editorPage(page);
  await page.evaluate(async () => {
    (window as any).changes = [];
    (window as any).typed = await (window as any).editor.createEditor({ root: document.getElementById('root'), markdown: '# Plan\n\nShip it.\n', onChange: (md: string) => (window as any).changes.push(md) });
  });
  await clickIntoText(page.locator('#root p'));
  await page.keyboard.press('End');
  await page.keyboard.type(' On Friday.');
  await expect.poll(() => page.evaluate(() => (window as any).changes.at(-1))).toBe('# Plan\n\nShip it. On Friday.\n');
  expect(await page.evaluate(() => (window as any).typed.markdown())).toBe('# Plan\n\nShip it. On Friday.\n');
  // The page's React draws everything around it: a second one in the bundle would be dead weight.
  expect(readFileSync(BUNDLE, 'utf8')).not.toMatch(/react\.production|__SECRET_INTERNALS|from\s*["']react["']/);
});

/** The text the passages of comments are marked on in an editor holding `markdown`, by the quotes they were kept as. */
const MARKED = '# Plan\n\nShip it on **Friday**, [see the guide](https://example.com/guide) now, and `run` it.\n\n- one\n- two *three* four\n\n| a | b |\n| - | - |\n| cell one | cell *two* |\n\n```js\nconst x = 1;\n```\n\n> A quote with **bold** words.\n\nThe build is green.\n';

test('the passage of a comment is marked on the words it was kept as, whatever Markdown marks are inside them or at their edges', async ({ page }) => {
  await editorPage(page);
  const quotes: Record<string, string> = {
    heading: 'Plan',
    word: 'Ship it',
    bold: '**Friday**',
    insideBold: 'rida',
    acrossMarks: 'Friday**, [see the guide](https://example.com/guide) now',
    link: '[see the guide](https://example.com/guide)',
    linkText: 'see the',
    code: '`run`',
    listItems: 'one\n- two *three* four',
    inItalic: 'hre',
    cell: 'cell *two*',
    codeBlock: 'x = 1',
    inQuote: 'with **bold** words',
    last: 'The build is green.',
  };
  const placed = await page.evaluate(async ([markdown, quotes]) => {
    const root = document.getElementById('root')!;
    let last = new Map<string, string>();
    const editor = await (window as any).editor.createEditor({ root, markdown, onPlaced: (m: Map<string, string>) => (last = m) });
    const text = editor.markdown() as string;
    // One at a time: where passages overlap, the editor's marks leave only one of their ids on the words they share.
    const onPage: Record<string, string> = {};
    const reported: Record<string, string> = {};
    for (const [id, quote] of Object.entries(quotes)) {
      editor.threads([{ id, quote, prefix: '', suffix: '', start: text.indexOf(quote) }]);
      onPage[id] = [...root.querySelectorAll(`[data-pd-thread="${id}"]`)].map((s) => s.textContent).join('');
      if (last.has(id)) reported[id] = last.get(id)!;
    }
    return { reported, onPage };
  }, [MARKED, quotes] as const);
  expect(placed.onPage).toEqual({
    heading: 'Plan', word: 'Ship it', bold: 'Friday', insideBold: 'rida', acrossMarks: 'Friday, see the guide now', link: 'see the guide', linkText: 'see the', code: 'run',
    listItems: 'onetwo three four', inItalic: 'hre', cell: 'cell two', codeBlock: 'x = 1', inQuote: 'with bold words', last: 'The build is green.',
  });
  // What the page is told is what is marked, read as the editor shows it.
  expect(placed.reported.listItems).toBe('one\ntwo three four');
  expect(placed.reported.acrossMarks).toBe('Friday, see the guide now');
  expect(Object.keys(placed.reported).sort()).toEqual(Object.keys(quotes).sort());
});

test('a selection is the passage as the Markdown holds it: the marks at its edges are in it when it takes all of what they mark, and out of it when it takes part', async ({ page }) => {
  await editorPage(page);
  await page.evaluate(async (markdown) => {
    (window as any).ed = await (window as any).editor.createEditor({ root: document.getElementById('root'), markdown });
  }, MARKED);
  const passageOf = async (text: string) => {
    await page.locator('#root .ProseMirror').click();
    await page.evaluate((text) => {
      const root = document.querySelector('#root .ProseMirror')!;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      const nodes: { node: Node; from: number }[] = [];
      let all = '';
      for (let n = walker.nextNode(); n; n = walker.nextNode()) { nodes.push({ node: n, from: all.length }); all += n.textContent; }
      const at = all.indexOf(text);
      if (at < 0) throw new Error(`${text} is not in the editor`);
      const place = (position: number, end: boolean) => { const found = [...nodes].reverse().find((n) => (end ? n.from < position : n.from <= position))!; return [found.node, position - found.from] as const; };
      const range = document.createRange();
      range.setStart(...place(at, false));
      range.setEnd(...place(at + text.length, true));
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
    }, text);
    // The editor learns of a selection a moment after the browser has it.
    await page.waitForFunction((text) => (window as any).ed.selection()?.text === text, text);
    return page.evaluate(() => (window as any).ed.selection());
  };
  const markdown = MARKED;
  for (const [selected, quote] of [
    ['Friday', '**Friday**'],
    ['rida', 'rida'],
    ['Ship it on Friday', 'Ship it on **Friday**'],
    ['guide now', 'guide](https://example.com/guide) now'],
    ['see the guide', '[see the guide](https://example.com/guide)'],
    ['run', '`run`'],
    ['cell two', 'cell *two*'],
    ['x = 1', 'x = 1'],
    ['with bold words', 'with **bold** words'],
    ['The build is green.', 'The build is green.'],
  ] as const) {
    const got = await passageOf(selected);
    expect(got.quote, selected).toBe(quote);
    expect(markdown.slice(got.start, got.end), selected).toBe(quote);
    expect(got.text, selected).toBe(selected);
    expect(markdown.slice(got.start - got.prefix.length, got.start)).toBe(got.prefix);
    expect(markdown.slice(got.end, got.end + got.suffix.length)).toBe(got.suffix);
  }
  // Nothing selected is no passage; neither is a selection of white space.
  await clickIntoText(page.locator('#root p').first());
  await page.keyboard.press('End');
  await page.waitForFunction(() => (window as any).ed.selection() === null);
});

test('a mark moves with the text as it is typed, a click on it is told with the caret put where it was clicked, and the one looked at is drawn without touching the caret', async ({ page }) => {
  await editorPage(page);
  await page.evaluate(async (markdown) => {
    (window as any).clicked = [];
    (window as any).placed = [];
    const ed = (window as any).ed = await (window as any).editor.createEditor({
      root: document.getElementById('root'), markdown,
      // The page makes a thread the one looked at when it is clicked, and does it at once.
      onThread: (id: string) => { (window as any).clicked.push(id); ed.activate(id); },
      onPlaced: (m: Map<string, string>) => (window as any).placed.push([...m]),
    });
    const text = ed.markdown();
    (window as any).list = [{ id: 'green', quote: 'The build is green.', prefix: '', suffix: '', start: text.indexOf('The build') }, { id: 'one', quote: 'Friday', prefix: '', suffix: '', start: text.indexOf('Friday') }];
    ed.threads((window as any).list);
  }, MARKED);
  const mark = (id: string) => page.locator(`#root [data-pd-thread="${id}"]`);
  const caret = () => page.evaluate(() => { const s = window.getSelection()!; return [s.anchorNode?.textContent, s.anchorOffset]; });
  await expect(mark('green')).toHaveText('The build is green.');
  // Text typed before it, in the paragraph above.
  await clickIntoText(page.locator('#root p').first());
  await page.keyboard.press('Home');
  await page.keyboard.type('Early. ');
  await expect(mark('green')).toHaveText('The build is green.');
  // A click on it is told, and puts the caret where it was clicked, though the page draws the thread as the one looked at at once.
  await mark('green').click({ position: { x: 20, y: 5 } });
  expect(await page.evaluate(() => (window as any).clicked)).toContain('green');
  expect((await caret())[0]).toBe('The build is green.');
  expect(await page.locator('#root').evaluate((root) => (root as HTMLElement).dataset.activeThread)).toBe('green');
  // The caret in it is how the keyboard finds the thread; a click in no passage is told too, with no id (what is open is to be closed).
  expect(await page.evaluate(() => (window as any).ed.threadAtCaret())).toBe('green');
  await page.locator('#root p').first().click();
  expect(await page.evaluate(() => (window as any).clicked.at(-1))).toBe(null);
  expect(await page.evaluate(() => (window as any).ed.threadAtCaret())).toBe(null);
  await mark('green').click({ position: { x: 20, y: 5 } });
  expect(await page.evaluate(() => (window as any).clicked.at(-1))).toBe('green');
  // Typed at its start, it is not in it.
  await page.keyboard.press('Home');
  await page.keyboard.type('Now ');
  await expect(mark('green')).toHaveText('The build is green.');
  // Typed inside it, it is; and after its words are not the words it was kept as, it is still on the same place.
  for (let n = 0; n < 4; n++) await page.keyboard.press('ArrowRight');
  await page.keyboard.type('very ');
  await expect(mark('green')).toHaveText('The very build is green.');
  // What the passage reads as is told to the page while it is typed.
  await expect.poll(() => page.evaluate(() => new Map((window as any).placed.at(-1)).get('green'))).toBe('The very build is green.');
  await page.evaluate(() => (window as any).ed.threads((window as any).list));
  await expect(mark('green')).toHaveText('The very build is green.');
  // Typed at its end, it is not in it.
  await page.keyboard.press('End');
  await page.keyboard.type(' More.');
  await expect(mark('green')).toHaveText('The very build is green.');
  // (A space typed where it would be lost at the edge of a line is a non-breaking one, as the browser makes it.)
  expect(await page.evaluate(() => (window as any).ed.markdown())).toMatch(/Now\s+The very build is green\.\s+More\.\n$/);
  // The one looked at is drawn: no change to the editor's state, so the caret is where it was.
  const before = await caret();
  await page.evaluate(() => (window as any).ed.activate('one'));
  expect(await page.locator('#root').evaluate((root) => (root as HTMLElement).dataset.activeThread)).toBe('one');
  expect(await caret()).toEqual(before);
  await page.evaluate(() => (window as any).ed.activate(null));
  expect(await page.locator('#root').evaluate((root) => (root as HTMLElement).dataset.activeThread)).toBe('');
});

test('the marks are where they were when the document is put in the editor again, by change or whole', async ({ page }) => {
  await editorPage(page);
  await page.evaluate(async (markdown) => {
    const ed = (window as any).ed = await (window as any).editor.createEditor({ root: document.getElementById('root'), markdown });
    const text = ed.markdown();
    ed.threads([{ id: 'friday', quote: 'Friday', prefix: '', suffix: '', start: text.indexOf('Friday') }, { id: 'green', quote: 'The build is green.', prefix: '', suffix: '', start: text.indexOf('The build') }]);
  }, MARKED);
  const mark = (id: string) => page.locator(`#root [data-pd-thread="${id}"]`);
  await expect(mark('friday')).toHaveText('Friday');
  // A change to the paragraph a mark is in: the paragraph is replaced, and the mark is put on the words again.
  await page.evaluate((markdown) => (window as any).ed.apply(markdown.replace('now,', 'then,')), MARKED);
  await expect(page.locator('#root p').first()).toContainText('then,');
  await expect(mark('friday')).toHaveText('Friday');
  await expect(mark('green')).toHaveText('The build is green.');
  // The whole document taken in its place (an earlier revision brought back, the other version taken).
  await page.evaluate((markdown) => (window as any).ed.replace(`# Other\n\n${markdown}`), MARKED);
  await expect(page.locator('#root h1').first()).toHaveText('Other');
  await expect(mark('friday')).toHaveText('Friday');
  await expect(mark('green')).toHaveText('The build is green.');
});

/** What each quote of `markdown` is marked on in the editor, one at a time. */
async function markedOn(page: Page, markdown: string, quotes: Record<string, string>) {
  return page.evaluate(async ([markdown, quotes]) => {
    const root = document.getElementById('root')!;
    // Nothing left of an editor that held another document.
    root.replaceChildren();
    const ed = await (window as any).editor.createEditor({ root, markdown });
    const text = ed.markdown() as string;
    const out: Record<string, string> = {};
    for (const [id, quote] of Object.entries(quotes)) {
      ed.threads([{ id, quote, prefix: '', suffix: '', start: text.indexOf(quote) }]);
      out[id] = [...root.querySelectorAll(`[data-pd-thread="${id}"]`)].map((s) => s.textContent).join('');
    }
    await ed.destroy();
    return out;
  }, [markdown, quotes] as const);
}

test('a passage in text whose Markdown the editor writes differently with a mark in it is not marked on the wrong words, and the rest of the document is marked', async ({ page }) => {
  await editorPage(page);
  // A paragraph that starts like a list item is written with an escape that a mark in front of it takes away.
  const marked = await markedOn(page, '\\- not a list\n\nSecond one.\n', { escaped: 'not a list', second: 'Second one.' });
  // Marked on the right words, or not marked: not on some others. Only the paragraph the marks change is left out.
  expect(['not a list', '']).toContain(marked.escaped);
  expect(marked.second).toBe('Second one.');
  // Meeting notes, as a German user writes them: a date at the start of a paragraph, which the editor writes as `15\. März`, and a hashtag.
  const notes = await markedOn(page, '# Plan\n\nShip it on Friday.\n\n15\\. März: Treffen mit dem Team.\n\n\\#hashtag at the start.\n\nDone for today.\n', {
    ship: 'Ship it', date: 'Treffen mit', tag: 'at the start', done: 'Done for today.', heading: 'Plan',
  });
  expect(notes.ship).toBe('Ship it');
  expect(notes.done).toBe('Done for today.');
  expect(notes.heading).toBe('Plan');
  expect(['Treffen mit', '']).toContain(notes.date);
  expect(['at the start', '']).toContain(notes.tag);
  // Meeting notes with a dated paragraph for each meeting, as many as there are meetings: the ones that cannot be marked are found one by one on
  // their own and left out, and all the others are marked, however many there are and wherever they are.
  const notesOf = (count: number, every: number) => Array.from({ length: count }, (_, i) => (i % every === 0 ? `${i + 1}\\. März: Treffen mit dem Team.` : `Paragraph number ${i} of the document.`)).join('\n\n');
  for (const [count, every, picked] of [[40, 4, [1, 5, 10, 21, 30, 38]], [200, 5, [1, 2, 49, 101, 151, 197, 199]]] as const) {
    const quotes = Object.fromEntries(picked.map((i) => [`p${i}`, `number ${i} of`]));
    const long = await markedOn(page, `${notesOf(count, every)}\n`, quotes);
    for (const i of picked) expect(long[`p${i}`], `paragraph ${i} of ${count}`).toBe(`number ${i} of`);
  }
  // The same as a bullet list with an item for each meeting, a numbered list, a quote, and a list of tasks: their text is at the start of a line
  // in the same way, and is escaped the same way.
  const item = (i: number, every: number) => (i % every === 0 ? `${i + 1}\\. März: Treffen mit dem Team.` : `Item number ${i} of the list.`);
  const nested: Record<string, (i: number, every: number) => string> = {
    bullets: (i, every) => `- ${item(i, every)}`,
    numbered: (i, every) => `${i + 1}. ${item(i, every)}`,
    quote: (i, every) => `> ${item(i, every)}`,
    tasks: (i, every) => `- [ ] ${item(i, every)}`,
  };
  for (const [kind, line] of Object.entries(nested)) {
    for (const [count, every, picked] of [[40, 4, [1, 5, 10, 21, 30, 38]], [200, 5, [1, 2, 49, 101, 151, 197, 199]]] as const) {
      // A quote is a paragraph for each line, set apart by a line of its own with the quote mark on it.
      const lines = Array.from({ length: count }, (_, i) => line(i, every));
      const markdown = `${kind === 'quote' ? lines.join('\n>\n') : lines.join('\n')}\n`;
      const got = await markedOn(page, markdown, Object.fromEntries(picked.map((i) => [`p${i}`, `number ${i} of`])));
      for (const i of picked) expect(got[`p${i}`], `${kind}: item ${i} of ${count}`).toBe(`number ${i} of`);
    }
  }
  // A cell of a table that starts like a date is not one of them (a bar is in front of it), and is marked along with the rest.
  const table = await markedOn(page, '| Date | What |\n| - | - |\n| 15. März | Treffen mit dem Team |\n\n15\\. März: Treffen mit dem Team.\n\nShip it on Friday.\n', { cell: '15. März', ship: 'Ship it' });
  expect(table.cell).toBe('15. März');
  expect(table.ship).toBe('Ship it');
  // And a numbered heading among them, which is not one of them.
  const heading = await markedOn(page, `# 1. The plan\n\n${notesOf(12, 3)}\n`, { plan: 'plan', last: 'number 10 of' });
  expect(['plan', '1. The plan']).toContain(heading.plan);
  expect(heading.last).toBe('number 10 of');
});

test('a passage in a block whose Markdown is not the same on its own as in the document is marked on the whole of it, or on the right words', async ({ page }) => {
  await editorPage(page);
  // A heading that starts like a numbered item: written as it is in the heading, and with an escape on its own in a paragraph.
  const marked = await markedOn(page, '# 1. The plan\n\nSecond one.\n', { heading: 'plan', second: 'Second one.' });
  expect(['plan', '1. The plan']).toContain(marked.heading);
  expect(marked.second).toBe('Second one.');
});

test('a passage whose words are not in the text the editor writes, and are too few to be found without its marks, is not marked, and the others are', async ({ page }) => {
  await editorPage(page);
  const out = await page.evaluate(async (markdown) => {
    const root = document.getElementById('root')!;
    let reported: string[] = [];
    const editor = await (window as any).editor.createEditor({ root, markdown, onPlaced: (m: Map<string, string>) => (reported = [...m.keys()]) });
    editor.threads([
      { id: 'there', quote: 'Ship it', prefix: '', suffix: '', start: 8 },
      { id: 'gone', quote: 'Not in this document at all', prefix: '', suffix: '', start: 3 },
      { id: 'few', quote: '* a', prefix: '', suffix: '', start: null },
    ]);
    return reported;
  }, '# Plan\n\nShip it on Friday.\n\n* a\n* b\n');
  expect(out).toEqual(['there']);
});
