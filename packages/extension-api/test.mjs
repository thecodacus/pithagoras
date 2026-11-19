import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/**
 * What a UI or an extension that speaks more than English checks in its own tests: that every text its code passes to
 * `t`, `tx`, `tc` and `tp` has an entry in each language it ships, and that no entry is left for a text the code no longer
 * shows. The same rule as the portal's own test of its language files (tests/i18n.test.mts).
 *
 *   import { checkStrings } from "@pithagoras/extension-api/test";
 *   import { de } from "../src/de";
 *   test("every text has its German", () => assert.deepEqual(checkStrings({ dir: "src", locales: { de } }), []));
 *
 * This is for tests and nothing else: it reads source files, and a bundle never imports it.
 */

const CALLS = new Set(["t", "tx", "tc", "tp", "msg"]);
const SOURCE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const IDENTIFIER = /[\p{ID_Continue}$‌‍]/u;
/**
 * What a `/` after these starts is a regular expression, not a division. Not `<` and `}`: after them it is far more often the
 * `</` of a closing tag and the `/>` of an element in markup.
 */
const BEFORE_REGEX = new Set(["", "(", ",", "=", ":", "[", "!", "&", "|", "?", "{", ";", "+", "-", "*", "%", ">", "~", "^"]);

/** The words after which a string can follow with no space: `return'x'`, `case'a':`. */
const KEYWORDS_BEFORE_VALUE = new Set(["return", "typeof", "case", "in", "of", "void", "delete", "throw", "new", "yield", "await", "instanceof", "else", "do"]);

const ESCAPES = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", v: "\v", 0: "\0" };

/**
 * The texts the code in `source` passes to the translating functions, as the key a language file has for each:
 * the text for `t`, `tx` and `msg`, the English plural for `tp`, "text\u0004context" for `tc`. A text that is not written
 * out (a variable, a sum) cannot be known and is left out, except that a `tc` or a `tp` must write out its parts: that is
 * what is reported in `dynamic`.
 */
export function textsOf(source, where = "source") {
  const found = new Map();
  const dynamic = [];
  const line = (at) => `${where}:${source.slice(0, at).split("\n").length}`;

  /** The string literal that starts at `at` (a quote), or null: its text and where it ends. A quote with no end on its line is a letter of the text of a page (don't), not a string. */
  const literal = (at) => {
    const quote = source[at];
    let text = "";
    for (let i = at + 1; i < source.length; i++) {
      const c = source[i];
      if (c === "\\") {
        const next = source[i + 1];
        const unicode = next === "u" && source[i + 2] === "{" ? /^\{([0-9a-f]+)\}/i.exec(source.slice(i + 2, i + 12)) : null;
        if (unicode) { text += String.fromCodePoint(parseInt(unicode[1], 16)); i += 1 + unicode[0].length; }
        else if (next === "u" || next === "x") {
          const length = next === "u" ? 4 : 2;
          text += String.fromCharCode(parseInt(source.slice(i + 2, i + 2 + length), 16));
          i += 1 + length;
        } else { text += ESCAPES[next] ?? (next === "\n" ? "" : next); i += 1; }
      } else if (c === quote) return { text, end: i + 1 };
      else if (c === "\n" && quote !== "`") return null;
      else if (quote === "`" && c === "$" && source[i + 1] === "{") return null;
      else text += c;
    }
    return null;
  };

  /**
   * Whether the `'` at `at` is a letter of the text of a page (`<p>don't {t("a")} isn't</p>`), not the start of a string: in
   * code a string never follows a name or a number straight away, except after a word such as `return` or `case`.
   */
  const apostrophe = (at) => {
    if (at === 0 || !IDENTIFIER.test(source[at - 1])) return false;
    let start = at;
    while (start > 0 && IDENTIFIER.test(source[start - 1])) start--;
    return !KEYWORDS_BEFORE_VALUE.has(source.slice(start, at));
  };

  const space = (i) => {
    for (;;) {
      while (i < source.length && /\s/.test(source[i])) i++;
      if (source.startsWith("//", i)) i = lineEnd(i);
      else if (source.startsWith("/*", i)) i = blockEnd(i);
      else return i;
    }
  };
  const lineEnd = (i) => (source.indexOf("\n", i) < 0 ? source.length : source.indexOf("\n", i));
  const blockEnd = (i) => (source.indexOf("*/", i + 2) < 0 ? source.length : source.indexOf("*/", i + 2) + 2);

  /** Past the expression that starts at `i`, to the `,` or the closing bracket that ends it. */
  const expressionEnd = (i) => {
    let depth = 0;
    const stop = scan(i, (c, at) => {
      if (c === "(" || c === "[" || c === "{") depth++;
      else if (c === ")" || c === "]" || c === "}") {
        if (depth === 0) return at;
        depth--;
      } else if (c === "," && depth === 0) return at;
    });
    return stop ?? source.length;
  };

  /**
   * Goes through the code from `from`, past comments, strings, regular expressions and template literals, calling `each`
   * with each other character and where it is; returns what `each` returns when it is not undefined.
   */
  function scan(from, each) {
    let before = "";
    for (let i = from; i < source.length; i++) {
      const c = source[i];
      if (c === "/" && source[i + 1] === "/") { i = lineEnd(i) - 1; continue; }
      if (c === "/" && source[i + 1] === "*") { i = blockEnd(i) - 1; continue; }
      if (c === "'" && apostrophe(i)) {
        // Text of a page: `don't` in markup.
      } else if (c === "'" || c === '"') {
        const made = literal(i);
        if (made) { i = made.end - 1; before = "x"; continue; }
      }
      if (c === "`") { i = templateEnd(i) - 1; before = "x"; continue; }
      if (c === "/" && BEFORE_REGEX.has(before)) {
        let inClass = false, j = i + 1;
        for (; j < source.length && source[j] !== "\n"; j++) {
          if (source[j] === "\\") j++;
          else if (source[j] === "[") inClass = true;
          else if (source[j] === "]") inClass = false;
          else if (source[j] === "/" && !inClass) break;
        }
        if (source[j] === "/") { i = j; before = "x"; continue; }
      }
      const given = each(c, i);
      if (given !== undefined) return given;
      if (!/\s/.test(c)) before = IDENTIFIER.test(c) ? "x" : c;
    }
    return undefined;
  }

  /** Past the template literal that starts at `at`, the code in its `${ }` gone through for calls on the way. */
  function templateEnd(at) {
    for (let i = at + 1; i < source.length; i++) {
      if (source[i] === "\\") i++;
      else if (source[i] === "`") return i + 1;
      else if (source[i] === "$" && source[i + 1] === "{") {
        let depth = 0;
        const close = scan(i + 2, (c, here) => {
          if (c === "{") depth++;
          else if (c === "}") {
            if (depth === 0) return here;
            depth--;
          }
          return calls(c, here);
        });
        i = close ?? source.length;
      }
    }
    return source.length;
  }

  /** Called with every character of code: at the start of a name that is one of the translating functions, with a `(` after it, reads its arguments. */
  function calls(c, at) {
    if (!IDENTIFIER.test(c) || (at > 0 && IDENTIFIER.test(source[at - 1]))) return undefined;
    let end = at;
    while (end < source.length && IDENTIFIER.test(source[end])) end++;
    const name = source.slice(at, end);
    if (!CALLS.has(name)) return undefined;
    // `function t(text)` declares one, and `x.t = ` and `t: (…) =>` are not calls.
    if (/\bfunction\s*$/.test(source.slice(Math.max(0, at - 12), at))) return undefined;
    const open = space(end);
    if (source[open] !== "(") return undefined;
    read(name, open + 1, at);
    return undefined;
  }

  /** The text that is the whole of the argument starting at `i`, or null when the argument is anything more or other. */
  const argument = (i) => {
    const start = space(i);
    const quote = source[start];
    if (quote !== "'" && quote !== '"' && quote !== "`") return null;
    const made = literal(start);
    if (!made) return null;
    const next = space(made.end);
    return source[next] === "," || source[next] === ")" ? { text: made.text, after: next } : null;
  };

  /** The first `count` arguments from `i`, each as the string it is written as or null where it is anything else. */
  const args = (i, count) => {
    const given = [];
    while (given.length < count) {
      const written = argument(i);
      given.push(written);
      i = written ? written.after : expressionEnd(space(i));
      if (source[i] !== ",") break;
      i++;
    }
    return given;
  };

  function read(name, from, at) {
    if (name === "tp" || name === "tc") {
      // tp(count, one, other, vars?): the count is any expression.
      const start = name === "tp" ? expressionEnd(from) + 1 : from;
      const [first, second] = args(start, 2);
      const given = [first, second];
      // Both handed on by name is a wrapper (`portal.tp(n, one, other)`), which cannot be known; one written out and one not is a mistake.
      if (given.some((part) => part === null || part === undefined) && !(first === null && second === null)) {
        dynamic.push(`${line(at)}: ${name} takes its ${name === "tp" ? "two forms" : "text and context"} as they are written`);
      } else if (first && second) {
        if (name === "tp") found.set(second.text, { plural: true, where: line(at) });
        else found.set(`${first.text}\u0004${second.text}`, { plural: false, where: line(at) });
      }
    } else {
      const [text] = args(from, 1);
      if (text) found.set(text.text, { plural: false, where: line(at) });
    }
  }

  scan(0, calls);
  return { texts: found, dynamic };
}

/** The source files below `dir` (not `node_modules`, not `.d.ts`). */
function sourcesIn(dir) {
  return readdirSync(dir).flatMap((name) => {
    const file = path.join(dir, name);
    if (name === "node_modules" || name.startsWith(".")) return [];
    if (statSync(file).isDirectory()) return sourcesIn(file);
    return SOURCE.test(name) && !name.endsWith(".d.ts") ? [file] : [];
  });
}

/** A key as a sentence says it: the text, and in brackets what tells it from the same text elsewhere. */
const shown = (key) => (key.includes("\u0004") ? `"${key.split("\u0004")[0]}" (${key.split("\u0004")[1]})` : `"${key}"`);
const words = (text) => new Set([...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]));
const same = (a, b) => a.size === b.size && [...a].every((word) => b.has(word));

/**
 * The problems with the languages of the code in `dir` (or each of `dir`, when it is a list), as sentences; none when
 * every text has an entry in every language, and no entry is for a text the code does not show. `locales` is each language
 * by its code, with what `portal.locale.add(code, strings)` is given: a text by the English text, as a string, or, for a count
 * (`tp`), by the English plural, as an object with a form for each number and an `other`.
 *
 * Found by reading the code for calls of `t`, `tx`, `tc`, `tp` and `msg` (`portal.t(...)` and a `t` taken from the portal
 * alike) whose texts are written out; `tc` and `tp` must write theirs out. A text built at run time is not found, and
 * so is not asked for: keep it out of the language file as well, or write it out.
 */
export function checkStrings({ dir, locales }) {
  const problems = [];
  const texts = new Map();
  for (const folder of [dir].flat()) {
    for (const file of sourcesIn(path.resolve(folder))) {
      const read = textsOf(readFileSync(file, "utf8"), path.relative(process.cwd(), file));
      for (const [key, value] of read.texts) if (!texts.has(key)) texts.set(key, value);
      problems.push(...read.dynamic);
    }
  }
  if (!texts.size) problems.push(`no text found to translate below ${[dir].flat().join(", ")}: is the folder right?`);
  for (const [code, strings] of Object.entries(locales)) {
    for (const [key, value] of texts) {
      if (!(key in strings)) problems.push(`${code} lacks ${shown(key)} (${value.where})`);
    }
    for (const [key, said] of Object.entries(strings)) {
      const asked = texts.get(key);
      if (!asked) {
        problems.push(`${code} has ${shown(key)}, which the code no longer shows`);
      } else if (asked.plural) {
        if (!said || typeof said !== "object" || typeof said.other !== "string") {
          problems.push(`${code}: ${shown(key)} is a count, with a form for each number and an "other"`);
          continue;
        }
        const known = new Set([...words(key), "n"]);
        for (const [form, text] of Object.entries(said)) {
          for (const word of words(String(text))) if (!known.has(word)) problems.push(`${code}: ${shown(key)} (${form}) fills in {${word}}, which is never given`);
        }
        const without = (set) => new Set([...set].filter((word) => word !== "n"));
        if (!same(without(words(said.other)), without(words(key)))) problems.push(`${code}: ${shown(key)} fills in other words than the English`);
      } else if (typeof said !== "string") {
        problems.push(`${code}: ${shown(key)} is no count, and its entry is a string`);
      } else if (!said.trim()) {
        problems.push(`${code}: ${shown(key)} is empty`);
      } else if (!same(words(said), words(key.split("\u0004")[0]))) {
        problems.push(`${code}: ${shown(key)} fills in other words than the English`);
      }
    }
  }
  return problems;
}
