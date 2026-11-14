import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { checkStrings, textsOf } from '@pithagoras/extension-api/test';
import { scratch } from './helpers.mts';

/**
 * The helper a UI or an extension that speaks more than English tests its language files with
 * (`@pithagoras/extension-api/test`): the same rule as the portal's own test of its languages.
 */

const keys = (source: string) => [...textsOf(source).texts.entries()].map(([key, { plural }]) => (plural ? `${key} (count)` : key));

test('the texts a source passes to t, tx, tc, tp and msg are found by their keys, written out', () => {
  assert.deepEqual(keys(`
    const label = portal.t("Save {name}", { name });
    const other = t('Don\\'t save') + tx(\`Press {key}\`, { key }) + msg("Later");
    const sorted = tc("Sort", "a verb") + tp(items.length, "{n} file", "{n} files");
    const joined = t("a" + b) + t(variable) + t(\`has \${x}\`) + t("Escaped \\u00e9 \\n");
  `), ['Save {name}', "Don't save", 'Press {key}', 'Later', 'Sort\u0004a verb', '{n} files (count)', 'Escaped é \n']);
});

test('a name that only ends the same, a declaration, a comment, a string and a regular expression are not calls', () => {
  assert.deepEqual(keys(`
    // t("In a comment")
    /* tx("In a block") */
    function t(text: string) { return text; }
    const a = set("Not a call"), b = x.get('nor this'), c = "t('in a string')", d = /t\\("in a regex"\\)/.test(y);
    const e = { t: (text: string) => text, tp: 1 };
    const f = point.tx.length / 2 + t("But this is");
  `), ['But this is']);
});

test('a text between calls in markup is found, and an apostrophe in the words of a page is not a string', () => {
  assert.deepEqual(keys(`
    export const Row = () => (
      <div title={t("The title")}>
        <p>Don't forget {t("First")} and {tp(n, "{n} item", "{n} items")}</p>
        <p>It isn't {\`\${t("Inside a template")}\`}</p>
        {cond ? t("Yes") : t("No")}
        <Icon name={x} /> {t("After a closing slash")} <Markdown>{y}</Markdown> {t("After a closing tag")}
      </div>
    );
    const half = total / 2 + t("After a division") + /["']/.test(z) + t("After a regex");
  `), ['The title', 'First', '{n} items (count)', 'Inside a template', 'Yes', 'No', 'After a closing slash', 'After a closing tag', 'After a division', 'After a regex']);
});

test('a tc or a tp with one text written out and one not is reported; a wrapper that hands both on, and a t of a variable, are not', () => {
  const { texts, dynamic } = textsOf('tc(a, "context"); tp(n, one, "{n} things"); tp(n, "{n} thing", "{n} things"); t(thing); tp(n, one, other, vars); tc(text, context);', 'x.ts');
  assert.deepEqual([...texts.keys()], ['{n} things']);
  assert.deepEqual(dynamic, ['x.ts:1: tc takes its text and context as they are written', 'x.ts:1: tp takes its two forms as they are written']);
});

/** A UI's source folder with these files, and the folder's path. */
function code(files: Record<string, string>) {
  const dir = scratch('strings-');
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    writeFileSync(path.join(dir, name), text);
  }
  return dir;
}

test('every text has its entry in every language, and no entry is left for a text that is gone', () => {
  const dir = code({
    'a.tsx': 'export const A = () => t("Hello {name}") + tp(n, "{n} file", "{n} files") + tc("Open", "a door");',
    'sub/b.ts': 'export const b = portal.t("Goodbye");',
    'node_modules/x/c.ts': 't("Not ours")',
    'types.d.ts': 't("Nor this")',
  });
  const de = { 'Hello {name}': 'Hallo {name}', '{n} files': { one: '{n} Datei', other: '{n} Dateien' }, 'Open\u0004a door': 'Öffnen', Goodbye: 'Tschüss' };
  assert.deepEqual(checkStrings({ dir, locales: { de } }), []);
  assert.deepEqual(checkStrings({ dir: [dir], locales: { de, fr: { Goodbye: 'Au revoir' } } }), [
    `fr lacks "Hello {name}" (${path.relative(process.cwd(), path.join(dir, 'a.tsx'))}:1)`,
    `fr lacks "{n} files" (${path.relative(process.cwd(), path.join(dir, 'a.tsx'))}:1)`,
    `fr lacks "Open" (a door) (${path.relative(process.cwd(), path.join(dir, 'a.tsx'))}:1)`,
  ]);
  const { Goodbye, ...less } = de;
  assert.deepEqual(checkStrings({ dir, locales: { de: { ...less, 'Old text': 'Alter Text' } } }), [
    `de lacks "Goodbye" (${path.relative(process.cwd(), path.join(dir, 'sub', 'b.ts'))}:1)`,
    'de has "Old text", which the code no longer shows',
  ]);
});

test('a translation fills in the words the English does, and a count has the forms of a count', () => {
  const dir = code({ 'a.ts': 't("Hello {name}"); tp(n, "{n} file in {where}", "{n} files in {where}"); t("Plain");' });
  const problems = checkStrings({
    dir,
    locales: {
      de: { 'Hello {name}': 'Hallo {nom}', '{n} files in {where}': { one: '{n} Datei in {there}', other: '{n} Dateien' }, Plain: '  ' },
      fr: { 'Hello {name}': 'Salut {name}', '{n} files in {where}': 'Des fichiers', Plain: { other: 'Simple' } as any },
    },
  });
  assert.deepEqual(problems, [
    'de: "Hello {name}" fills in other words than the English',
    'de: "{n} files in {where}" (one) fills in {there}, which is never given',
    'de: "{n} files in {where}" fills in other words than the English',
    'de: "Plain" is empty',
    'fr: "{n} files in {where}" is a count, with a form for each number and an "other"',
    'fr: "Plain" is no count, and its entry is a string',
  ]);
});

test('a folder with no texts in it is a mistake, and not a pass', () => {
  assert.deepEqual(checkStrings({ dir: code({ 'a.ts': 'export const a = 1;' }), locales: { de: {} } }).map((p) => p.replace(/below .*:/, 'below DIR:')), ['no text found to translate below DIR: is the folder right?']);
});

test("the portal's own extensions that speak German pass it: it finds what the portal's own test of their languages does", async () => {
  const root = path.resolve(import.meta.dirname, '../extensions');
  const speaking = readdirSync(root).filter((name) => existsSync(path.join(root, name, 'src', 'de.ts')));
  assert.ok(speaking.includes('terminal'));
  for (const name of speaking) {
    const { de } = await import(path.join(root, name, 'src', 'de.ts'));
    assert.deepEqual(checkStrings({ dir: path.join(root, name, 'src'), locales: { de } }), [], name);
  }
});
