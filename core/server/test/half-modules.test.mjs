import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { scratch } from "./server-harness.mjs";

/**
 * Where a server half's module is imported from (half-modules.ts): the first revision of it at its own address, so what
 * it imports is what any other import of those files gets, and each revision after it under the revision, every file
 * of its folder it imports too: a sub-import, and its own imports in turn, by a relative address or a file URL. What it
 * imports by a bare name, and what a module outside any half's folder imports, is left as Node resolves it.
 */
const { REVISION, moduleAt } = await import("../dist/half-modules.js");

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
export * as libModule from "./lib.js";
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
write("other/server.js", 'export { url as lib } from "./lib.js";\n');
write("other/lib.js", "export const url = import.meta.url;\n");
write("outside/x.js", 'export const url = import.meta.url;\nexport { url as near } from "./near.js";\n');
write("outside/near.js", "export const url = import.meta.url;\n");
write("outside/into.js", 'export { url } from "../half/sub/deep.js";\n');

const file = path.join(root, "half/server.js");
const under = (file, rev) => {
  const address = new URL(url(file));
  address.searchParams.set(REVISION, rev);
  return address.href;
};

test("the first revision of a half's module is at its own address, and what it imports is what any other import of those files gets", async () => {
  assert.equal(moduleAt(file, "r1"), url("half/server.js"));
  const half = await import(moduleAt(file, "r1"));
  assert.equal(half.lib, url("half/lib.js"));
  assert.equal(half.deep, url("half/sub/deep.js"));
  assert.equal(half.libModule, await import(url("half/lib.js")), "one module, the half's and the one imported here");
  assert.equal(globalThis.libRuns, 1);
  // Started again at that revision: the modules already loaded.
  assert.equal(await import(moduleAt(file, "r1")), half);
  assert.equal(globalThis.libRuns, 1);
});

test("a revision after the first is loaded whole under its own, as far down as the imports go, and its files are modules of its own", async () => {
  assert.equal(moduleAt(file, "r2"), under("half/server.js", "r2"));
  const half = await import(moduleAt(file, "r2"));
  assert.equal(half.url, under("half/server.js", "r2"));
  assert.equal(half.lib, under("half/lib.js", "r2"));
  assert.equal(half.deep, under("half/sub/deep.js", "r2"), "an import of an import");
  assert.equal(half.byUrl, under("half/sub/by-url.js", "r2"), "by its file URL");
  assert.notEqual(half.libModule, await import(url("half/lib.js")), "what was imported at the file's own address keeps the first revision's");
  assert.equal(globalThis.libRuns, 2);

  const again = await import(moduleAt(file, "r3"));
  assert.equal(again.lib, under("half/lib.js", "r3"));
  assert.equal(again.deep, under("half/sub/deep.js", "r3"));
  assert.equal(globalThis.libRuns, 3);

  // The first revision is each module's own: another half's is at its own address, whatever revision this one is at.
  const other = await import(moduleAt(path.join(root, "other/server.js"), "r3"));
  assert.equal(other.lib, url("other/lib.js"));
});

test("what a half imports by a bare name, or from outside its folder, is the module Node already has", async () => {
  const half = await import(moduleAt(file, "r4"));
  assert.equal(half.dependency, url("half/node_modules/dep/index.js"));
  assert.equal(half.dependencyOwn, url("half/node_modules/dep/own.js"), "nor what the dependency imports");
  assert.equal(half.outside, url("outside/x.js"));
  assert.equal(half.outsideNear, url("outside/near.js"));
});

test("a module outside any half's folder is left alone, even under an address that carries a revision", async () => {
  const outside = await import(under("outside/x.js", "r5"));
  assert.equal(outside.near, url("outside/near.js"));
  // Nor a file of a half's folder it imports: only a module of that folder gives its files its revision.
  const into = await import(under("outside/into.js", "r6"));
  assert.equal(into.url, url("half/sub/deep.js"));
});
