import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { check } from "../src/server/check.ts";

/**
 * What a copy of a draft must be before Creator installs it: a package.json with an unscoped name, `"pi": {}` with
 * nothing that runs code in pi, and the halves it declares where the portal looks for them. Each refusal says what to
 * change. Whether the server half is ESM is not asked.
 */
const root = mkdtempSync(path.join(tmpdir(), "creator-check-"));
let n = 0;
/** A copy with `meta` as its package.json (none for undefined) and `files`. */
function copy(meta: unknown, files: Record<string, string> = {}): string {
  const dir = path.join(root, String(++n));
  mkdirSync(dir);
  if (meta !== undefined) writeFileSync(path.join(dir, "package.json"), typeof meta === "string" ? meta : JSON.stringify(meta));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), text);
  }
  return dir;
}
const good = { name: "moon", version: "1.0.0", type: "module", pi: {}, pithagoras: { server: "./server.js", client: "./web/client.js", style: "./web/client.css" } };
const halves = { "server.js": "export default function () {}\n", "web/client.js": "export default function () {}\n", "web/client.css": "" };

test("a package as the template has it passes, with its name and version", () => {
  assert.deepEqual(check(copy(good, halves)), { name: "moon", version: "1.0.0" });
  assert.deepEqual(check(copy({ name: "bare", pi: {} })), { name: "bare" });
});

test("each refusal says why: no package.json, a scoped or invalid name, no pi key or a pi half, a folder pi would load, a client at the root", () => {
  const PI_HALF = /^A pi half \(pi\.extensions\) runs in every chat's pi, inside the portal and outside its own process: give tools through portal\.chats\.extend in the server half$/;
  for (const [dir, refused] of [
    [copy(undefined), /^It has no package\.json that can be read/],
    [copy("{ not json"), /^It has no package\.json that can be read/],
    [copy({ ...good, name: "@me/moon" }, halves), /^Give it a name without a scope: it is one folder$/],
    [copy({ ...good, name: ".moon" }, halves), /^Its name, "\.moon", is not one npm takes/],
    [copy({ ...good, name: "moon phase" }, halves), /^Its name, "moon phase", is not one npm takes/],
    [copy({ ...good, name: undefined }, halves), /^Its name, undefined, is not one npm takes/],
    [copy({ ...good, pi: undefined }, halves), /^Its package\.json needs "pi": \{\}/],
    [copy({ ...good, pi: [] }, halves), /^Its package\.json needs "pi": \{\}/],
    [copy({ ...good, pi: { extensions: ["./index.ts"] } }, { ...halves, "index.ts": "" }), PI_HALF],
    [copy({ ...good, pi: { extensions: [] } }, halves), PI_HALF],
    [copy(good, { ...halves, "extensions/tools.ts": "" }), PI_HALF],
    [copy({ ...good, pithagoras: { client: "./client.js" } }, { "client.js": "" }), /^Put the browser half in a folder of its own \(web\/client\.js\): the portal serves that whole folder$/],
    [copy({ ...good, pithagoras: { client: "../web/client.js" } }), /^Put the browser half in a folder of its own/],
    [copy({ ...good, pithagoras: { client: "./web/missing.js" } }, halves), /^pithagoras\.client is "\.\/web\/missing\.js", which is no file in its folder$/],
    [copy({ ...good, pithagoras: { server: "./missing.js" } }), /^pithagoras\.server is "\.\/missing\.js", which is no file in its folder$/],
    [copy({ ...good, pithagoras: { server: "../outside.js" } }), /^pithagoras\.server is "\.\.\/outside\.js", which is no file in its folder$/],
    [copy({ ...good, pithagoras: { server: 3 } }), /^pithagoras\.server is 3, which is no file in its folder$/],
  ] as const) {
    assert.throws(() => check(dir), { message: refused }, dir);
  }
});

test("skills, prompts and themes are allowed, and so is a server half in CommonJS", () => {
  assert.equal(check(copy({ ...good, pi: { skills: ["./skills"], prompts: ["./prompts"], themes: ["./themes"] } }, halves)).name, "moon");
  const cjs = copy({ name: "old-style", pi: {}, pithagoras: { server: "./server.js" } }, { "server.js": "module.exports = function () {};\n" });
  assert.equal(check(cjs).name, "old-style");
});
