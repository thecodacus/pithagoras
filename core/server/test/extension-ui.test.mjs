import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createServer, request } from "node:http";
import test from "node:test";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
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
  "web/client.js": `import { dep } from "./dep.js";\nexport default function () { /* ${marker} */ dep; }`,
  "web/dep.js": `import "./deeper/two.js";\nimport "./x@1+b$c.js";\nexport const dep = 1;\nexport const lazy = () => import("./lazy.js");`,
  "web/deeper/two.js": "export const two = 2;",
  "web/lazy.js": "export const lazy = 3;",
  "web/x@1+b$c.js": "export const odd = 4;",
  "web/client.css": ".x { color: red; }",
  "web/img/logo.svg": "<svg xmlns='http://www.w3.org/2000/svg'/>",
  "web/.env": "KEY=value",
  "web/huge.json": JSON.stringify({ text: "a line of a file far too large to be worth reading whole to compress it, ".repeat(Math.ceil(9 * 1024 * 1024 / 77)) }),
  "web/big.js": `export const lines = [\n${Array.from({ length: 400 }, (_, i) => `  "line ${i} of a module that is long enough to be worth compressing",`).join("\n")}\n];\n`,
});
const SERVER = "export default function (portal) { portal.router.get('/hello', (_req, res) => res.json({ from: portal.extension })); }";
const scoped = pkg("scoped", "@codacus/notes", { ...WEB, server: "./server.js" }, { ...files("scoped"), "server.js": SERVER });
const off = pkg("off", "switched-off", { ...WEB, server: "./server.js" }, { ...files("off"), "server.js": SERVER });
const plain = pkg("plain", "no-interface", undefined, { "index.ts": "export default () => {};" });
const project = pkg("project", "from-a-folder", { ...WEB, server: "./server.js" }, { ...files("project"), "server.js": SERVER });
// A server half and no browser half, which requires another, and one whose server half cannot start.
const headless = pkg("headless", "server-only", { server: "./lib/server.js", requires: { "@codacus/notes": "^1.0.0" } }, { "lib/server.js": SERVER });
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
const { extensionsRouter, shippedExtensions, syncExtensionServers } = await import("../dist/api/extensions.js");
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
  // Under its revision, of the files of its web folder, which is listed for a page to say a failure of it under.
  assert.match(notes.rev, /^[\w-]{16}$/);
  assert.equal(notes.entry, `/api/extension-ui/%40codacus/notes/~${notes.rev}/client.js`);
  assert.equal(notes.style, `/api/extension-ui/%40codacus/notes/~${notes.rev}/client.css`);
});

test("what a module imports along with itself is listed, for the page to ask for at once, and what it only imports when it is called is not", async () => {
  const { extensions } = await (await fetch(at("/api/extension-ui"))).json();
  const notes = extensions.find((e) => e.name === "@codacus/notes");
  // Under the revision the module is asked for under: its import resolves to the file there, and the page's fetch ahead must be that one.
  const under = `/api/extension-ui/%40codacus/notes/~${notes.rev}`;
  assert.deepEqual(notes.preload, [`${under}/dep.js`, `${under}/deeper/two.js`, `${under}/x@1+b$c.js`]);
  // A name with characters a browser leaves as they are in an address is listed as it makes the address, or the import would fetch it again.
  assert.equal(notes.preload[2], new URL("./x@1+b$c.js", at(`${under}/dep.js`)).pathname);
  assert.equal(new URL("./dep.js", at(notes.entry)).pathname, notes.preload[0]);
  for (const address of notes.preload) assert.equal((await fetch(at(address))).status, 200, address);
  assert.equal(extensions.find((e) => e.name === "only-themes").preload, undefined);
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

test("what a server half requires is listed with it, and what comes with the portal says what each requires, before it is installed", async () => {
  const { extensions } = await (await fetch(at("/api/extension-ui"))).json();
  assert.deepEqual(extensions.find((e) => e.name === "server-only").requires, { "@codacus/notes": "^1.0.0" });
  assert.equal(extensions.find((e) => e.name === "@codacus/notes").requires, undefined);
  // A folder of the portal's own, as `extensions` is: one package in each folder. What is not a package's name is not read.
  const folder = path.join(home, "shipped");
  const ship = (dir, name, declared) => {
    mkdirSync(path.join(folder, dir), { recursive: true });
    writeFileSync(path.join(folder, dir, "package.json"), JSON.stringify({ name, version: "1.0.0", pithagoras: declared }));
  };
  ship("viewer", "pithagoras-viewer", { server: "./server.js", requires: { "pithagoras-docker": "^1.0.0", "../odd": "1" } });
  ship("docker", "pithagoras-docker", { server: "./server.js" });
  assert.deepEqual(shippedExtensions(folder).map((e) => [e.name, e.requires]), [["pithagoras-docker", undefined], ["pithagoras-viewer", { "pithagoras-docker": "^1.0.0" }]]);
});

test("what installing a package brings with it is worked out from what is installed: one switched off is switched on, one on is left", async () => {
  const wants = { name: "pi-needs", version: "1.0.0", pithagoras: { requires: { "switched-off": "^1.0.0", "server-only": "^1.0.0" } } };
  const registry = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url !== "/pi-needs") return res.writeHead(404).end("{}");
    res.end(JSON.stringify({ name: "pi-needs", "dist-tags": { latest: "1.0.0" }, versions: { "1.0.0": wants } }));
  });
  await new Promise((r) => registry.listen(0, "127.0.0.1", r));
  process.env.NPM_REGISTRY_URL = `http://127.0.0.1:${registry.address().port}`;
  try {
    const plan = await (await fetch(at(`/api/extensions/plan?spec=${encodeURIComponent("npm:pi-needs")}`))).json();
    assert.deepEqual(plan, { name: "pi-needs", version: "1.0.0", needs: [{ name: "switched-off", range: "^1.0.0", for: "pi-needs", action: "switch-on", spec: "npm:switched-off", version: "1.0.0" }] });
    assert.equal((await fetch(at("/api/extensions/plan"))).status, 400);
  } finally {
    delete process.env.NPM_REGISTRY_URL;
    registry.close();
  }
});

test("of two installed under one name, the one switched on is the one a plan finds, as the host does; a folder's is not the portal's", async () => {
  const wants = { name: "pi-wants", version: "1.0.0", pithagoras: { requires: { "@codacus/notes": "^1.0.0", "from-a-folder": "^1.0.0" } } };
  const registry = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url !== "/pi-wants") return res.writeHead(404).end("{}");
    res.end(JSON.stringify({ name: "pi-wants", "dist-tags": { latest: "1.0.0" }, versions: { "1.0.0": wants } }));
  });
  await new Promise((r) => registry.listen(0, "127.0.0.1", r));
  process.env.NPM_REGISTRY_URL = `http://127.0.0.1:${registry.address().port}`;
  const settings = path.join(process.env.PI_CODING_AGENT_DIR, "settings.json");
  const was = readFileSync(settings, "utf8");
  const switchedOff = (source) => ({ source, extensions: [], skills: [], prompts: [], themes: [] });
  const needs = async (packages) => {
    writeFileSync(settings, JSON.stringify({ packages }));
    return (await (await fetch(at(`/api/extensions/plan?spec=${encodeURIComponent("npm:pi-wants")}`))).json()).needs;
  };
  // The one a project brings is not installed for the portal: it is looked for as any other, and is nowhere.
  const nowhere = { name: "from-a-folder", range: "^1.0.0", for: "pi-wants", action: "missing" };
  try {
    // The first switched off, the second (the twin) on: the host runs the twin, and nothing is to be switched on.
    assert.deepEqual(await needs([switchedOff("npm:@codacus/notes"), "npm:twin"]), [nowhere]);
    // Both off: the first is the one switched on.
    assert.deepEqual(await needs([switchedOff("npm:@codacus/notes"), switchedOff("npm:twin")]), [
      { name: "@codacus/notes", range: "^1.0.0", for: "pi-wants", action: "switch-on", spec: "npm:@codacus/notes", version: "1.0.0" },
      nowhere,
    ]);
  } finally {
    writeFileSync(settings, was);
    delete process.env.NPM_REGISTRY_URL;
    registry.close();
  }
});

test("what comes with the portal is listed to install from its own folder, the subagent tool among them", async () => {
  const { extensions } = await (await fetch(at("/api/extensions/shipped"))).json();
  assert.deepEqual(extensions.map((e) => [e.name, e.kinds]), [["pithagoras-browser", ["pithagoras"]], ["pithagoras-canvas", ["pithagoras"]], ["pithagoras-creator", ["pithagoras"]], ["pithagoras-docker", ["pithagoras"]], ["pithagoras-docs", ["pithagoras"]], ["pithagoras-files", ["pithagoras"]], ["pithagoras-git", ["pithagoras"]], ["pithagoras-kanban", ["pithagoras"]], ["pithagoras-media", ["pithagoras"]], ["pithagoras-subagent", ["pithagoras"]], ["pithagoras-terminal", ["pithagoras"]], ["pithagoras-themes", ["themes"]], ["pithagoras-understory", ["pithagoras"]], ["pithagoras-voice", ["pithagoras"]], ["pithagoras-voice-servers", ["pithagoras"]]]);
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
  // Under a revision that is not the one there now, as a page that has an older one asks: the file there now.
  assert.match(await (await fetch(at("/api/extension-ui/@codacus/notes/~older/client.js"))).text(), /scoped/);
});

/** A GET with the headers as given, and the body as it came, not unpacked. */
const raw = (address, headers = {}) =>
  new Promise((resolve, reject) => {
    request(at(address), { headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on("error", reject).end();
  });

test("a text file of a package's web folder is sent compressed to a browser that takes it, and not sent again to one that has it", async () => {
  const { extensions } = await (await fetch(at("/api/extension-ui"))).json();
  const address = extensions[0].entry.replace(/client\.js.*/, "big.js");
  const plain = await raw(address, { "accept-encoding": "identity" });
  assert.equal(plain.status, 200);
  assert.equal(plain.headers["content-encoding"], undefined);
  assert.match(plain.headers["content-type"], /javascript/);

  const packed = await raw(address, { "accept-encoding": "gzip, br" });
  assert.equal(packed.status, 200);
  assert.equal(packed.headers["content-encoding"], "br");
  assert.match(packed.headers.vary, /Accept-Encoding/i);
  assert.equal(packed.headers["cache-control"], "no-cache");
  assert.match(packed.headers["content-type"], /javascript/);
  assert.ok(packed.body.length < plain.body.length / 4, `${packed.body.length} of ${plain.body.length}`);
  assert.equal(brotliDecompressSync(packed.body).toString(), plain.body.toString());

  const zipped = await raw(address, { "accept-encoding": "gzip" });
  assert.equal(zipped.headers["content-encoding"], "gzip");
  assert.equal(gunzipSync(zipped.body).toString(), plain.body.toString());
  // Quality 0 refuses an encoding.
  assert.equal((await raw(address, { "accept-encoding": "br;q=0, gzip;q=0" })).headers["content-encoding"], undefined);

  // What the browser holds is revalidated, and not sent again; and one encoding's copy is not the other's.
  const etag = packed.headers.etag;
  assert.ok(etag);
  const again = await raw(address, { "accept-encoding": "br", "if-none-match": etag });
  assert.equal(again.status, 304);
  assert.equal(again.body.length, 0);
  assert.equal((await raw(address, { "accept-encoding": "gzip", "if-none-match": etag })).status, 200);
  // One far larger than any module is streamed as it is, not read whole and compressed before its first byte.
  const huge = await raw(address.replace("big.js", "huge.json"), { "accept-encoding": "br" });
  assert.equal(huge.status, 200);
  assert.equal(huge.headers["content-encoding"], undefined);
  assert.ok(huge.body.length > 8 * 1024 * 1024);
  // A small file, a picture and a hidden file are not compressed here: the first two as they are, the last refused.
  const small = await raw(address.replace("big.js", "client.js"), { "accept-encoding": "br" });
  assert.equal(small.headers["content-encoding"], undefined);
  assert.equal((await raw(address.replace("big.js", ".env"), { "accept-encoding": "br" })).status, 404);
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
    "/api/extension-ui/@codacus/notes/~1/",
    "/api/extension-ui/@codacus/notes/~1/%2e%2e/index.ts",
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
  assert.match(byName.breaks.entry, /^\/api\/extension-ui\/breaks\/~[^/]+\/client\.js$/);
  // Switched off, or a folder's: never loaded into the portal.
  for (const none of ["/api/x/switched-off/hello", "/api/x/from-a-folder/hello"]) assert.equal((await fetch(at(none))).status, 404, none);
});
