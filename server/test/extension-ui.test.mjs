import assert from "node:assert/strict";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { inProcessHome } from "./server-harness.mjs";

/**
 * Which installed packages the portal loads a browser half of, and what of
 * each it serves. pi is a stand-in that lists what the test installed: one
 * package of the portal's own, one switched off, one without a browser half,
 * and one a folder brings.
 */
const home = inProcessHome("extension-ui-");
const bin = path.join(home, "bin");
mkdirSync(bin);

/** A package folder under `home`, with these files and this under `pithagoras` in its package.json. */
function pkg(folder, name, declared, files) {
  const dir = path.join(home, "packages", folder);
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), text);
  }
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name, version: "1.0.0", pi: { extensions: ["./index.ts"] }, ...(declared ? { pithagoras: declared } : {}) }));
  return dir;
}
const WEB = { client: "./web/client.js", style: "./web/client.css" };
const files = (marker) => ({
  "index.ts": "export const secret = 'the half pi loads';",
  "web/client.js": `export default function () { /* ${marker} */ }`,
  "web/client.css": ".x { color: red; }",
  "web/img/logo.svg": "<svg xmlns='http://www.w3.org/2000/svg'/>",
  "web/.env": "KEY=value",
});
const scoped = pkg("scoped", "@codacus/notes", WEB, files("scoped"));
const off = pkg("off", "switched-off", WEB, files("off"));
const plain = pkg("plain", "no-interface", undefined, { "index.ts": "export default () => {};" });
const project = pkg("project", "from-a-folder", WEB, files("project"));

writeFileSync(
  path.join(bin, "pi"),
  `#!/bin/bash
[ "$1" = list ] || exit 0
cat <<'LIST'
User packages:
  npm:@codacus/notes
    ${scoped}
  npm:switched-off
    ${off}
  npm:no-interface
    ${plain}
Project packages:
  npm:from-a-folder
    ${project}
LIST
`,
);
chmodSync(path.join(bin, "pi"), 0o755);
process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;

mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
writeFileSync(
  path.join(process.env.PI_CODING_AGENT_DIR, "settings.json"),
  JSON.stringify({
    packages: ["npm:@codacus/notes", { source: "npm:switched-off", extensions: [], skills: [], prompts: [], themes: [] }, "npm:no-interface"],
  }),
);

const { default: express } = await import("express");
const { extensionsRouter } = await import("../dist/api/extensions.js");
const app = express();
app.use("/api", extensionsRouter());
const server = await new Promise((resolve) => {
  const s = app.listen(0, "127.0.0.1", () => resolve(s));
});
test.after(() => server.close());
const at = (p) => `http://127.0.0.1:${server.address().port}${p}`;

test("the browser halves listed are those of the portal's own packages that are switched on", async () => {
  const { extensions } = await (await fetch(at("/api/extension-ui"))).json();
  assert.deepEqual(extensions.map((e) => e.name), ["@codacus/notes"], "not one switched off, one without a browser half, or one a folder brings");
  const [notes] = extensions;
  assert.equal(notes.version, "1.0.0");
  assert.match(notes.entry, /^\/api\/extension-ui\/%40codacus\/notes\/client\.js\?v=[0-9a-z]+-[0-9a-z]+$/);
  assert.match(notes.style, /^\/api\/extension-ui\/%40codacus\/notes\/client\.css\?v=/);
});

test("a package's web folder is served as the addresses listed say, and as what each file is", async () => {
  const { extensions } = await (await fetch(at("/api/extension-ui"))).json();
  const module = await fetch(at(extensions[0].entry));
  assert.equal(module.status, 200);
  assert.match(module.headers.get("content-type"), /javascript/);
  assert.equal(module.headers.get("cache-control"), "no-cache");
  assert.match(await module.text(), /scoped/);
  assert.match((await fetch(at(extensions[0].style))).headers.get("content-type"), /text\/css/);
  const picture = await fetch(at("/api/extension-ui/@codacus/notes/img/logo.svg"));
  assert.equal(picture.status, 200);
  assert.match(picture.headers.get("content-type"), /svg/);
});

test("nothing else of a package is served, and nothing of a package that has no browser half here", async () => {
  for (const asked of [
    "/api/extension-ui/@codacus/notes/../index.ts",
    "/api/extension-ui/@codacus/notes/%2e%2e/index.ts",
    "/api/extension-ui/@codacus/notes/..%2Findex.ts",
    "/api/extension-ui/@codacus/notes/%2e%2e%2f%2e%2e%2foff/web/client.js",
    "/api/extension-ui/@codacus/notes/.env",
    "/api/extension-ui/@codacus/notes/missing.js",
    "/api/extension-ui/@codacus/notes/",
    "/api/extension-ui/@codacus/client.js",
    "/api/extension-ui/switched-off/client.js",
    "/api/extension-ui/from-a-folder/client.js",
    "/api/extension-ui/no-interface/index.ts",
  ]) {
    const res = await fetch(at(asked));
    assert.equal(res.status, 404, asked);
    assert.doesNotMatch(await res.text(), /the half pi loads|KEY=value|project|off \*\//, asked);
  }
});
