import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const SRC = path.resolve(import.meta.dirname, "../core/web/src");

const sources = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return sources(p);
    return /\.tsx$/.test(e.name) ? [p] : [];
  });

// Elements with no role of their own: a name given to one is not exposed, so it is read by nobody. A skeleton, a count
// or a dot that has its words only there is silent; the words go in text a screen reader reads (a status's `sr-only`
// text), or the element is given the role that names it (`img`, `group`, `region`).
const GENERIC = new Set(["div", "span", "i", "b", "em", "strong", "small", "p"]);

test("no element without a role carries an aria-label or aria-labelledby that nobody would read", () => {
  const found: string[] = [];
  for (const file of sources(SRC)) {
    const src = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const visit = (n: ts.Node) => {
      if ((ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) && GENERIC.has(n.tagName.getText(src))) {
        const names = n.attributes.properties.map((a) => (ts.isJsxAttribute(a) ? a.name.getText(src) : "..."));
        if ((names.includes("aria-label") || names.includes("aria-labelledby")) && !names.includes("role") && !names.includes("...")) {
          found.push(`${path.relative(SRC, file)}:${src.getLineAndCharacterOfPosition(n.getStart(src)).line + 1} <${n.tagName.getText(src)}>`);
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(src);
  }
  assert.deepEqual(found, []);
});
