import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { scratch } from "./server-harness.mjs";

/**
 * Every file of a server half's folder that its module imports is loaded under the half's revision (half-modules.ts):
 * a sub-import, and its own imports in turn, by a relative address or a file URL. What it imports by a bare name, and
 * what a module outside any half's folder imports, is left as Node resolves it.
 */
const { REVISION, underRevision } = await import("../dist/half-modules.js");

const root = realpathSync(scratch("half-modules-"));
const write = (file, text) => {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  writeFileSync(path.join(root, file), text);
};
const url = (file) => pathToFileURL(path.join(root, file)).href;
write("package.json", JSON.stringify({ type: "module" }));
// The half: its module imports a file of its folder, which imports one further down, and one by its file URL; a
// dependency by its name; and a file outside its folder.
write("half/server.js", `export { url as lib, deep } from "./lib.js";
export { url as byUrl } from ${JSON.stringify(url("half/sub/by-url.js"))};
export { url as dependency, own as dependencyOwn } from "dep";
export { url as outside, near as outsideNear } from "../outside/x.js";
export const url = import.meta.url;
`);
write("half/lib.js", 'export const url = import.meta.url;\nexport { url as deep } from "./sub/deep.js";\nglobalThis.libRuns = (globalThis.libRuns ?? 0) + 1;\n');
write("half/sub/deep.js", "export const url = import.meta.url;\n");
write("half/sub/by-url.js", "export const url = import.meta.url;\n");
write("half/node_modules/dep/package.json", JSON.stringify({ name: "dep", type: "module", exports: "./index.js" }));
write("half/node_modules/dep/index.js", 'export const url = import.meta.url;\nexport { url as own } from "./own.js";\n');
write("half/node_modules/dep/own.js", "export const url = import.meta.url;\n");
write("outside/x.js", 'export const url = import.meta.url;\nexport { url as near } from "./near.js";\n');
write("outside/near.js", "export const url = import.meta.url;\n");

underRevision(path.join(root, "half"));
const under = (file, rev) => {
  const address = new URL(url(file));
  address.searchParams.set(REVISION, rev);
  return address.href;
};

test("what a half's module imports from its folder is loaded under its revision, as far down as it goes", async () => {
  const half = await import(under("half/server.js", "r1"));
  assert.equal(half.url, under("half/server.js", "r1"));
  assert.equal(half.lib, under("half/lib.js", "r1"));
  assert.equal(half.deep, under("half/sub/deep.js", "r1"), "an import of an import");
  assert.equal(half.byUrl, under("half/sub/by-url.js", "r1"), "by its file URL");
  assert.equal(globalThis.libRuns, 1);

  // Another revision: every file of the half is evaluated again.
  const again = await import(under("half/server.js", "r2"));
  assert.equal(again.lib, under("half/lib.js", "r2"));
  assert.equal(again.deep, under("half/sub/deep.js", "r2"));
  assert.equal(globalThis.libRuns, 2);
});

test("what a half imports by a bare name, or from outside its folder, is the module Node already has", async () => {
  const half = await import(under("half/server.js", "r3"));
  assert.equal(half.dependency, url("half/node_modules/dep/index.js"));
  assert.equal(half.dependencyOwn, url("half/node_modules/dep/own.js"), "nor what the dependency imports");
  assert.equal(half.outside, url("outside/x.js"));
  assert.equal(half.outsideNear, url("outside/near.js"));
});

test("a module outside any half's folder is left alone, even under an address that carries a revision", async () => {
  const outside = await import(under("outside/x.js", "r4"));
  assert.equal(outside.near, url("outside/near.js"));
});
