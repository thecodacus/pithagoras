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
    return /\.tsx?$/.test(e.name) && !e.name.endsWith(".d.ts") ? [p] : [];
  });

// Reaching for `localStorage` throws, on the property access itself, in a private window or with site data blocked:
// read while a component is first drawn, that is a white screen. safe-storage.ts is the one place that knows to catch
// it, so the next module that remembers something goes through it instead of writing the try again, or leaving it out.
test("only safe-storage.ts reaches for the browser's storage", () => {
  const found: string[] = [];
  for (const file of sources(SRC)) {
    if (path.basename(file) === "safe-storage.ts") continue;
    const src = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const visit = (n: ts.Node) => {
      if (ts.isIdentifier(n) && (n.text === "localStorage" || n.text === "sessionStorage")) found.push(`${path.relative(SRC, file)}:${src.getLineAndCharacterOfPosition(n.getStart(src)).line + 1}`);
      ts.forEachChild(n, visit);
    };
    visit(src);
  }
  assert.deepEqual(found, [], "use `local` or `session` from safe-storage.ts");
});
