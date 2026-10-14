import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { addLocale, ENGLISH, formatDate, formatDateTime, formatsFor, formatTime, labelOf, languages, loadLanguage, offerLocale, resolve, selfName, setLanguage, t, tc, tp, tx, type Locale, type Plural } from "../core/web/src/i18n.ts";

const SRC = path.resolve(import.meta.dirname, "../core/web/src");
const LOCALES = path.join(SRC, "locales");

const sources = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return p === LOCALES ? [] : sources(p);
    return /\.tsx?$/.test(e.name) && !e.name.endsWith(".d.ts") ? [p] : [];
  });

/** Every text the code in `dir` shows, as it is written there, and whether it is a count's. */
function texts(dir = SRC): Map<string, { plural: boolean; where: string }> {
  const found = new Map<string, { plural: boolean; where: string }>();
  for (const file of sources(dir)) {
    const src = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const literal = (e: ts.Expression | undefined) => (e && (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) ? e.text : undefined);
    const visit = (n: ts.Node) => {
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
        const where = `${path.relative(dir, file)}:${src.getLineAndCharacterOfPosition(n.getStart(src)).line + 1}`;
        const name = n.expression.text;
        if (name === "t" || name === "tx" || name === "msg") {
          const key = literal(n.arguments[0]);
          if (key !== undefined) found.set(key, { plural: false, where });
        } else if (name === "tc") {
          const text = literal(n.arguments[0]);
          const context = literal(n.arguments[1]);
          assert.ok(text !== undefined && context !== undefined, `${where}: tc takes its text and context as they are written`);
          found.set(`${text}\u0004${context}`, { plural: false, where });
        } else if (name === "tp") {
          const one = literal(n.arguments[1]);
          const other = literal(n.arguments[2]);
          assert.ok(one !== undefined && other !== undefined, `${where}: tp takes its two forms as they are written`);
          found.set(other!, { plural: true, where });
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(src);
  }
  return found;
}

const localeFiles = () => fs.readdirSync(LOCALES).filter((f) => f.endsWith(".ts") && f !== "index.ts");
const load = async (file: string): Promise<Locale> => (await import(path.join(LOCALES, file))).default;
const words = (s: string) => new Set([...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]));

test("there is something to translate, and German is offered", async () => {
  assert.ok(texts().size > 1000);
  assert.ok(localeFiles().includes("de.ts"));
  assert.equal((await load("de.ts")).code, "de");
});

test("every language has every text the code shows, and nothing it no longer does", async () => {
  const want = texts();
  for (const file of localeFiles()) {
    const locale = await load(file);
    const missing = [...want.keys()].filter((k) => !(k in locale.strings));
    const stale = Object.keys(locale.strings).filter((k) => !want.has(k));
    assert.deepEqual(missing.map((k) => `${want.get(k)!.where}: ${k}`), [], `${file} lacks these`);
    assert.deepEqual(stale, [], `${file} has these the code no longer shows`);
  }
});

test("an extension of the portal's own that speaks German has every text it shows, and nothing it no longer does", async () => {
  // Its texts are its own (`portal.locale.add`), kept in its src/de.ts, and shown by its `t`, or marked with `msg` for later.
  const root = path.resolve(import.meta.dirname, "../extensions");
  const speaking = fs.readdirSync(root).filter((name) => fs.existsSync(path.join(root, name, "src", "de.ts")));
  assert.ok(speaking.includes("terminal"));
  for (const name of speaking) {
    const want = texts(path.join(root, name, "src"));
    const { de } = (await import(path.join(root, name, "src", "de.ts"))) as { de: Record<string, string> };
    const missing = [...want.keys()].filter((k) => !(k in de));
    const stale = Object.keys(de).filter((k) => !want.has(k));
    assert.deepEqual(missing.map((k) => `${want.get(k)!.where}: ${k}`), [], `${name} lacks these`);
    assert.deepEqual(stale, [], `${name} has these its code no longer shows`);
    for (const [key, text] of Object.entries(de)) assert.deepEqual(words(text), words(key), `${name}: ${key}`);
  }
});

test("a translation fills in the same words, and a count's has every form", async () => {
  const want = texts();
  for (const file of localeFiles()) {
    const locale = await load(file);
    for (const [key, said] of Object.entries(locale.strings)) {
      const plural = want.get(key)?.plural;
      if (plural) {
        assert.equal(typeof said, "object", `${file}: "${key}" is a count, with a form for each number`);
        const forms = said as Plural;
        assert.ok(forms.other, `${file}: "${key}" needs its "other" form`);
        const known = new Set([...words(key), "n"]);
        for (const [form, text] of Object.entries(forms)) {
          for (const w of words(text!)) assert.ok(known.has(w), `${file}: "${key}" (${form}) fills in {${w}}, which is never given`);
        }
        assert.deepEqual(new Set([...words(forms.other)].filter((w) => w !== "n")), new Set([...words(key)].filter((w) => w !== "n")), `${file}: "${key}"`);
      } else {
        assert.equal(typeof said, "string", `${file}: "${key}" is no count`);
        assert.deepEqual(words(said as string), words(key), `${file}: "${key}" fills in other words than the English`);
        assert.ok((said as string).trim(), `${file}: "${key}" is empty`);
      }
    }
  }
});

test("German says Kanal for a channel, and not the English word beside it", async () => {
  const { strings } = await load("de.ts");
  const said = Object.entries(strings).flatMap(([key, text]) => (typeof text === "string" ? [[key, text]] : Object.values(text as Plural).map((form) => [key, form ?? ""])));
  const english = said.filter(([, text]) => /\bChannels?\b/.test(text.replace(/\{\w+\}/g, "")));
  assert.deepEqual(english.map(([key]) => key), []);
});

test("English is what the code says; another language where it has the text", () => {
  addLocale({ code: "xx", name: "Test", strings: { "Hello {name}": "Hallo {name}", "{n} files": { one: "eine Datei", other: "{n} Dateien" } } });
  try {
    setLanguage("en");
    assert.equal(t("Hello {name}", { name: "Ada" }), "Hello Ada");
    assert.equal(tp(1, "{n} file", "{n} files"), "1 file");
    assert.equal(tp(1234, "{n} file", "{n} files"), `${(1234).toLocaleString(formatsFor("en"))} files`, "written as this browser writes numbers");
    setLanguage("xx");
    assert.equal(t("Hello {name}", { name: "Ada" }), "Hallo Ada");
    assert.equal(t("Not there"), "Not there", "what a language lacks is shown in English");
    assert.equal(tp(1, "{n} file", "{n} files"), "eine Datei");
    assert.equal(tp(3, "{n} file", "{n} files"), "3 Dateien");
    assert.equal(t("Left {alone}"), "Left {alone}", "a word not given stays as it is");
  } finally {
    setLanguage("system");
  }
});

test("a text with something drawn in it keeps it in its place", () => {
  const node = tx("Press {key} to send", { key: "⏎" }) as { props: { children: unknown[] } };
  assert.deepEqual(node.props.children, ["Press ", "⏎", " to send"]);
});

test("the browser's language is used when there is one for it", () => {
  addLocale({ code: "de", name: "Deutsch", strings: {} });
  assert.equal(resolve("system", ["de-AT", "en"]).code, "de", "de-AT is German");
  assert.equal(resolve("system", ["fr-FR", "de"]).code, "de", "the first one there is");
  assert.equal(resolve("system", ["fr-FR"]).code, "en", "English without one");
  assert.equal(resolve("de", ["en-US"]).code, "de", "what was chosen, over the browser");
  assert.equal(resolve("zz", ["de"]).code, "en", "a language no longer there is English");
  assert.equal(languages()[0].code, ENGLISH.code, "English is offered first");
});

test("a value's name comes from its table, and one the table does not know is shown as it is", () => {
  addLocale({ code: "yy", name: "Other", strings: { running: "läuft" } });
  try {
    setLanguage("yy");
    const states = { running: "running" };
    assert.equal(labelOf(states, "running"), "läuft");
    assert.equal(labelOf(states, "paused"), "paused");
    assert.equal(labelOf(states, "PAUSED_NOW", (v) => v.toLowerCase()), "paused_now");
    assert.equal(labelOf(states, "toString"), "toString", "not a name any object has");
  } finally {
    setLanguage("system");
  }
});

test("dates are written as toLocaleString would, from formatters made once", () => {
  setLanguage("en");
  try {
    const d = new Date(Date.UTC(2026, 8, 29, 13, 4, 5));
    const locale = formatsFor("en");
    assert.equal(formatDateTime(d), d.toLocaleString(locale));
    assert.equal(formatDate(d), d.toLocaleDateString(locale));
    assert.equal(formatTime(d), d.toLocaleTimeString(locale));
    assert.equal(formatDate(d, { month: "short", day: "numeric" }), d.toLocaleDateString(locale, { month: "short", day: "numeric" }));
  } finally {
    setLanguage("system");
  }
});

test("a date that cannot be read says so instead of failing the page", () => {
  assert.equal(formatDateTime("not a date"), "Invalid Date");
  assert.equal(formatDate(NaN), "Invalid Date");
  assert.equal(formatTime(new Date("")), "Invalid Date");
});

test("numbers and dates follow the browser where it speaks the language, or is on the English page for want of its own", () => {
  assert.equal(formatsFor("de", ["de-AT", "en"]), "de-AT", "the browser's German");
  assert.equal(formatsFor("de", ["en-US"]), "de", "a German page on an American browser writes German dates");
  assert.equal(formatsFor("en", ["en-GB", "de"]), "en-GB");
  assert.equal(formatsFor("en", ["fr-FR"]), "fr-FR", "a French browser, with no French file, keeps French dates");
  assert.equal(formatsFor("en", []), "en");
});

test("a word in braces is filled in only from what was given", () => {
  setLanguage("en");
  try {
    assert.equal(t("Set {constructor} and {name}", { name: "x" }), "Set {constructor} and x");
  } finally {
    setLanguage("system");
  }
});

test("the same English word with two meanings is told apart by what it is", () => {
  addLocale({ code: "zz", name: "Zett", strings: { Open: "Öffnen", "Open\u0004state": "Offen" } });
  try {
    setLanguage("en");
    assert.equal(tc("Open", "state"), "Open", "English shows the word");
    setLanguage("zz");
    assert.equal(t("Open"), "Öffnen");
    assert.equal(tc("Open", "state"), "Offen");
    assert.equal(tc("Closed", "state"), "Closed", "one the language lacks is the English");
  } finally {
    setLanguage("system");
  }
});

test("a language that is only offered is fetched once, when it is chosen, and the page waits for it", async () => {
  let fetched = 0;
  offerLocale("qq", async () => (fetched++, { code: "qq", name: "Qq", strings: { Hello: "Hallo" } }));
  try {
    assert.ok(languages().some((l) => l.code === "qq"), "offered with its name, before its text is here");
    setLanguage("en");
    await loadLanguage();
    assert.equal(fetched, 0, "not fetched while another language is in use");
    setLanguage("qq");
    assert.equal(t("Hello"), "Hello", "English until the text has come, not a blank or a key");
    await Promise.all([loadLanguage(), loadLanguage()]);
    assert.equal(t("Hello"), "Hallo");
    assert.equal(fetched, 1, "once, however many ask");
    setLanguage("en");
    setLanguage("qq");
    assert.equal(t("Hello"), "Hallo", "kept, not fetched again");
    assert.equal(fetched, 1);
  } finally {
    setLanguage("system");
  }
});

test("a language that cannot be fetched leaves the page as it was", async () => {
  offerLocale("rr", async () => {
    throw new Error("offline");
  });
  try {
    setLanguage("en");
    setLanguage("rr");
    await loadLanguage();
    assert.equal(t("Hello"), "Hello");
  } finally {
    setLanguage("system");
  }
});

test("each language is offered, before it is fetched, by the code its file is named for and the name it gives itself", async () => {
  for (const file of localeFiles()) {
    const locale = await load(file);
    assert.equal(file, `${locale.code}.ts`, "the file is named by the code: that is how it is found without being read");
    assert.equal(selfName(locale.code), locale.name);
  }
});
