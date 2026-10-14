import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");

const files = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === "node_modules" || e.name === "fixtures" ? [] : files(p);
    return /\.(mjs|mts|ts)$/.test(e.name) ? [p] : [];
  });

// A port from a range picked at random is a port that another test file's server may hold at that moment: the
// operating system hands the same range to every `listen(0)` running beside it. `freePort()` of the harness asks it
// for one that is free.
test("no test takes a port from a range of its own", () => {
  const found: string[] = [];
  for (const dir of ["core/server/test", "tests"]) {
    for (const file of files(path.join(ROOT, dir))) {
      if (file === import.meta.filename) continue;
      fs.readFileSync(file, "utf8").split("\n").forEach((line, i) => {
        if (/\b\d{4,5}\s*\+\s*Math\.(floor|random)/.test(line) || /Math\.random\(\)\s*\*\s*\d+\s*\)?\s*\+\s*\d{4,5}/.test(line)) found.push(`${path.relative(ROOT, file)}:${i + 1}`);
      });
    }
  }
  assert.deepEqual(found, [], "use freePort() from core/server/test/server-harness.mjs");
});
