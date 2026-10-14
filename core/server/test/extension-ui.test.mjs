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
  mkdirSync(dir, { recursive: true });
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
const SERVER = "export default function (portal) { portal.router.get('/hello', (_req, res) => res.json({ from: portal.extension })); }";
const scoped = pkg("scoped", "@codacus/notes", { ...WEB, server: "./server.js" }, { ...files("scoped"), "server.js": SERVER });
const off = pkg("off", "switched-off", { ...WEB, server: "./server.js" }, { ...files("off"), "server.js": SERVER });
const plain = pkg("plain", "no-interface", undefined, { "index.ts": "export default () => {};" });
const project = pkg("project", "from-a-folder", { ...WEB, server: "./server.js" }, { ...files("project"), "server.js": SERVER });
// A server half and no browser half, and one whose server half cannot start.
const headless = pkg("headless", "server-only", { server: "./lib/server.js" }, { "lib/server.js": SERVER });
// Nothing but themes: no code at all.
const themed = pkg("themed", "only-themes", { themes: [{ id: "dusk", name: "Dusk", dark: { accent: "#ff79c6" } }] }, {});
// A second package under a name another has: the first is the one, whole.
const twin = pkg("twin", "@codacus/notes", { server: "./server.js", themes: [{ id: "twin", name: "Twin", dark: { accent: "#000000" } }] }, { "server.js": "export default function (portal) { portal.router.get('/hello', (_req, res) => res.json({ from: 'the twin' })); }" });
const broken = pkg("broken", "breaks", { ...WEB, server: "./server.js" }, { ...files("broken"), "server.js": "export default function () { throw new Error('no licence'); }" });

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
  npm:server-only
    ${headless}
  npm:breaks
    ${broken}
  npm:only-themes
    ${themed}
  npm:twin
    ${twin}
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
    packages: ["npm:@codacus/notes", { source: "npm:switched-off", extensions: [], skills: [], prompts: [], themes: [] }, "npm:no-interface", "npm:server-only", "npm:breaks", "npm:only-themes", "npm:twin"],
  }),
);

const { default: express } = await import("express");
const { extensionsRouter, syncExtensionServers } = await import("../dist/api/extensions.js");
const { extensionRoutes, stopServerHalves } = await import("../dist/extension-host.js");
const app = express();
app.use("/api/x", extensionRoutes);
app.use("/api", extensionsRouter());
const server = await new Promise((resolve) => {
  const s = app.listen(0, "127.0.0.1", () => resolve(s));
});
test.after(async () => {
  await stopServerHalves();
  server.close();
});
const at = (p) => `http://127.0.0.1:${server.address().port}${p}`;

test("the browser halves listed are those of the portal's own packages that are switched on", async () => {
  const { extensions } = await (await fetch(at("/api/extension-ui"))).json();
  assert.deepEqual(extensions.map((e) => e.name).sort(), ["@codacus/notes", "breaks", "only-themes", "server-only"], "not one switched off, one with nothing for the portal, or one a folder brings");
  // A package that is only themes is listed with them, as written, and with nothing to load.
  assert.deepEqual(extensions.find((e) => e.name === "only-themes"), { name: "only-themes", version: "1.0.0", themes: [{ id: "dusk", name: "Dusk", dark: { accent: "#ff79c6" } }] });
  const notes = extensions.find((e) => e.name === "@codacus/notes");
  assert.equal(notes.version, "1.0.0");
  assert.match(notes.entry, /^\/api\/extension-ui\/%40codacus\/notes\/client\.js\?v=[0-9a-z]+-[0-9a-z]+$/);
  assert.match(notes.style, /^\/api\/extension-ui\/%40codacus\/notes\/client\.css\?v=/);
});

test("each installed package is listed with what it brings, for the page to tell them apart by", async () => {
  const { extensions } = await (await fetch(at("/api/extensions"))).json();
  const kinds = Object.fromEntries(extensions.map((e) => [e.spec, e.kinds]));
  assert.deepEqual(kinds["npm:no-interface"], ["pi"]);
  assert.deepEqual(kinds["npm:@codacus/notes"], ["pi", "pithagoras"]);
  assert.deepEqual(kinds["npm:server-only"], ["pi", "pithagoras"]);
  assert.deepEqual(kinds["npm:only-themes"], ["pi", "themes"]);
  // Said of what the package is, whether or not it is loaded: one switched off, and one a folder brings.
  assert.deepEqual(kinds["npm:switched-off"], ["pi", "pithagoras"]);
  assert.deepEqual(kinds["npm:from-a-folder"], ["pi", "pithagoras"]);
});

test("what comes with the portal is listed to install from its own folder, without the add-on that has a switch of its own", async () => {
  const { extensions } = await (await fetch(at("/api/extensions/shipped"))).json();
  assert.deepEqual(extensions.map((e) => [e.name, e.kinds]), [["pithagoras-docs", ["pithagoras"]], ["pithagoras-notes", ["pi", "pithagoras"]], ["pithagoras-theme-dusk", ["themes"]], ["pithagoras-theme-warm", ["themes"]]]);
  for (const shipped of extensions) {
    assert.ok(path.isAbsolute(shipped.spec) && shipped.spec.endsWith(path.join("extensions", shipped.name.replace(/^pithagoras-/, ""))), shipped.spec);
    assert.ok(shipped.version && shipped.description, shipped.name);
  }
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

test("the server halves that run are those of the same packages, each said with where its routes are or why it is not running", async () => {
  // Before any is started a page is told of no routes: there are none yet.
  const before = (await (await fetch(at("/api/extension-ui"))).json()).extensions;
  assert.deepEqual(before.map((e) => e.server).filter(Boolean), []);
  assert.equal((await fetch(at("/api/x/@codacus/notes/hello"))).status, 404);

  await syncExtensionServers();
  const byName = Object.fromEntries((await (await fetch(at("/api/extension-ui"))).json()).extensions.map((e) => [e.name, e]));
  assert.equal(byName["@codacus/notes"].server, "/api/x/%40codacus/notes");
  assert.deepEqual(await (await fetch(at(byName["@codacus/notes"].server + "/hello"))).json(), { from: "@codacus/notes" });
  // Of two packages under one name the first is the one: its page is not given the other's server, or its themes.
  assert.equal(byName["@codacus/notes"].themes, undefined);
  // A server half alone is listed without a module for the page.
  assert.deepEqual({ entry: byName["server-only"].entry, server: byName["server-only"].server }, { entry: undefined, server: "/api/x/server-only" });
  assert.deepEqual(await (await fetch(at("/api/x/server-only/hello"))).json(), { from: "server-only" });
  // One that could not start says why, and its browser half is still offered.
  assert.equal(byName.breaks.server, undefined);
  assert.equal(byName.breaks.serverError, "no licence");
  assert.match(byName.breaks.entry, /^\/api\/extension-ui\/breaks\/client\.js/);
  // Switched off, or a folder's: never loaded into the portal.
  for (const none of ["/api/x/switched-off/hello", "/api/x/from-a-folder/hello"]) assert.equal((await fetch(at(none))).status, 404, none);
});
