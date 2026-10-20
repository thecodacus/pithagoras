import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

/**
 * What installing an extension brings with it: the extensions it requires that are not there as it needs them, each
 * before what needs it, with what is done for each. Over a registry of its own, as the npm search's test has, and
 * what is installed and in the portal's own folder as the route would find them.
 */
const asked = [];
/** The addresses asked for, as they came. */
const addresses = [];
const packages = {};
/** A package on the registry: its versions, each with what its package.json says under `pithagoras`. */
const publish = (name, versions, latest = Object.keys(versions).at(-1)) => {
  packages[name] = {
    name,
    "dist-tags": { latest },
    versions: Object.fromEntries(Object.entries(versions).map(([version, pithagoras]) => [version, { name, version, ...(pithagoras ? { pithagoras } : {}) }])),
  };
};
const registry = createServer((req, res) => {
  const name = decodeURIComponent(req.url.slice(1));
  asked.push(name);
  addresses.push(req.url);
  res.setHeader("content-type", "application/json");
  if (name === "pi-broken") {
    res.statusCode = 500;
    return res.end("{}");
  }
  if (!packages[name]) {
    res.statusCode = 404;
    return res.end(JSON.stringify({ error: "Not found" }));
  }
  res.end(JSON.stringify(packages[name]));
});
await new Promise((r) => registry.listen(0, "127.0.0.1", r));
process.env.NPM_REGISTRY_URL = `http://127.0.0.1:${registry.address().port}`;
const { planInstall } = await import("../dist/install-plan.js");
test.after(() => registry.close());

const docker = { name: "pithagoras-docker", version: "1.0.0", spec: "/app/extensions/docker" };
const browser = { name: "pithagoras-browser", version: "0.1.0", spec: "/app/extensions/browser", requires: { "pithagoras-docker": "^1.0.0" } };
const plan = (spec, here = {}) => planInstall(spec, { installed: [], folder: [docker, browser], ...here });

test("one in the portal's own folder that requires another there: that one is installed first, from the folder", async () => {
  assert.deepEqual(await plan(browser.spec), {
    name: "pithagoras-browser",
    version: "0.1.0",
    needs: [{ name: "pithagoras-docker", range: "^1.0.0", for: "pithagoras-browser", action: "install", spec: "/app/extensions/docker", from: "shipped", version: "1.0.0" }],
  });
});

test("what is installed and on, in a version taken, needs nothing; one that is off is switched on", async () => {
  const on = { ...docker, spec: "/app/extensions/docker", enabled: true };
  assert.deepEqual((await plan(browser.spec, { installed: [on] })).needs, []);
  assert.deepEqual((await plan(browser.spec, { installed: [{ ...on, enabled: false }] })).needs, [
    { name: "pithagoras-docker", range: "^1.0.0", for: "pithagoras-browser", action: "switch-on", spec: "/app/extensions/docker", version: "1.0.0" },
  ]);
  // One with nothing it requires asks for nothing.
  assert.deepEqual(await plan(docker.spec), { name: "pithagoras-docker", version: "1.0.0", needs: [] });
});

test("installed in a version not taken: said, and nothing is done for it", async () => {
  const old = { ...docker, version: "0.2.0", spec: "npm:pithagoras-docker", enabled: true };
  assert.deepEqual((await plan(browser.spec, { installed: [old] })).needs, [
    { name: "pithagoras-docker", range: "^1.0.0", for: "pithagoras-browser", action: "version", version: "0.2.0" },
  ]);
});

test("a name the portal ships, in its folder in a version not taken: said, and npm is not asked for it", async () => {
  // Anyone could publish a package under the name on npm, in a version the range takes.
  publish("pithagoras-docker", { "1.0.0": null, "1.2.0": null });
  asked.length = 0;
  const folder = [{ ...docker, version: "0.2.0" }, browser];
  assert.deepEqual((await plan(browser.spec, { folder })).needs, [
    { name: "pithagoras-docker", range: "^1.0.0", for: "pithagoras-browser", action: "version", from: "shipped", version: "0.2.0" },
  ]);
  assert.deepEqual(asked, []);
  delete packages["pithagoras-docker"];
});

test("one the portal does not ship: npm's within the range, by the range; and nowhere at all, missing", async () => {
  publish("pithagoras-docker", { "0.9.0": null, "1.0.0": null, "1.2.0": null, "2.0.0": null }, "2.0.0");
  const folder = [browser];
  assert.deepEqual((await plan(browser.spec, { folder })).needs, [
    { name: "pithagoras-docker", range: "^1.0.0", for: "pithagoras-browser", action: "install", spec: "npm:pithagoras-docker@^1.0.0", from: "npm", version: "1.2.0" },
  ]);
  delete packages["pithagoras-docker"];
  assert.deepEqual((await plan(browser.spec, { folder })).needs, [{ name: "pithagoras-docker", range: "^1.0.0", for: "pithagoras-browser", action: "missing" }]);
  // On npm, but in no version it takes.
  publish("pithagoras-docker", { "2.0.0": null });
  assert.deepEqual((await plan(browser.spec, { folder })).needs, [{ name: "pithagoras-docker", range: "^1.0.0", for: "pithagoras-browser", action: "missing" }]);
  delete packages["pithagoras-docker"];
});

test("one required by two, in a version the second does not take: said for the second, wherever the first has it from", async () => {
  const root = { name: "root", version: "1.0.0", spec: "/x/root", requires: { a: "^1.0.0", b: "^1.0.0" } };
  const b = { name: "b", version: "1.0.0", spec: "/x/b", requires: { a: "^2.0.0" } };
  const a = { name: "a", version: "1.0.0", spec: "/x/a" };
  // From the portal's folder.
  assert.deepEqual((await plan(root.spec, { folder: [root, a, b] })).needs, [
    { name: "a", range: "^1.0.0", for: "root", action: "install", spec: "/x/a", from: "shipped", version: "1.0.0" },
    { name: "a", range: "^2.0.0", for: "b", action: "version", from: "shipped", version: "1.0.0" },
    { name: "b", range: "^1.0.0", for: "root", action: "install", spec: "/x/b", from: "shipped", version: "1.0.0" },
  ]);
  // Installed, and on: nothing is done for it, and the second is told.
  assert.deepEqual((await plan(root.spec, { folder: [root, b], installed: [{ ...a, spec: "npm:a", enabled: true }] })).needs, [
    { name: "a", range: "^2.0.0", for: "b", action: "version", version: "1.0.0" },
    { name: "b", range: "^1.0.0", for: "root", action: "install", spec: "/x/b", from: "shipped", version: "1.0.0" },
  ]);
  // From npm, which has a 2.0.0 the first range does not take.
  publish("a", { "1.0.0": null, "1.4.0": null, "2.0.0": null }, "2.0.0");
  assert.deepEqual((await plan(root.spec, { folder: [root, b] })).needs.map((n) => [n.name, n.for, n.action, n.from, n.version]), [
    ["a", "root", "install", "npm", "1.4.0"],
    ["a", "b", "version", "npm", "1.4.0"],
    ["b", "root", "install", "shipped", "1.0.0"],
  ]);
  // A second range that takes it says nothing more.
  assert.deepEqual((await plan(root.spec, { folder: [root, { ...b, requires: { a: "^1.2.0" } }] })).needs.map((n) => [n.name, n.for, n.action]), [
    ["a", "root", "install"],
    ["b", "root", "install"],
  ]);
  delete packages.a;
});

test("what a requirement requires comes before it, each once, and a circle ends", async () => {
  const folder = [
    { name: "a", version: "1.0.0", spec: "/x/a", requires: { b: "^1.0.0", c: "^1.0.0" } },
    { name: "b", version: "1.0.0", spec: "/x/b", requires: { c: "^1.0.0", d: "^1.0.0" } },
    { name: "c", version: "1.0.0", spec: "/x/c", requires: { b: "^1.0.0", a: "^1.0.0" } },
  ];
  const off = { name: "d", version: "1.1.0", spec: "npm:d", enabled: false, requires: { e: "^1.0.0" } };
  const { needs } = await plan("/x/a", { folder, installed: [off] });
  assert.deepEqual(needs.map((n) => [n.name, n.for, n.action]), [
    // c needs b and a, which are on the way: it is not waited for.
    ["c", "b", "install"],
    // e is not installed anywhere: what an installed one requires is looked at too.
    ["e", "d", "missing"],
    ["d", "b", "switch-on"],
    ["b", "a", "install"],
  ]);
});

test("an npm spec is read from the registry: the version it asks for, its own requirements, and theirs from npm", async () => {
  publish("pi-viewer", { "1.0.0": null, "2.0.0": { requires: { "pi-screen": "^0.3.0" } } });
  publish("pi-screen", { "0.3.0": { requires: { "pithagoras-docker": "^1.0.0" } }, "0.3.5": { requires: { "pithagoras-docker": "^1.0.0" } }, "0.4.0": null });
  assert.deepEqual(await plan("npm:pi-viewer"), {
    name: "pi-viewer",
    version: "2.0.0",
    needs: [
      { name: "pithagoras-docker", range: "^1.0.0", for: "pi-screen", action: "install", spec: "/app/extensions/docker", from: "shipped", version: "1.0.0" },
      { name: "pi-screen", range: "^0.3.0", for: "pi-viewer", action: "install", spec: "npm:pi-screen@^0.3.0", from: "npm", version: "0.3.5" },
    ],
  });
  // The version the spec asks for is the one read: this one requires nothing.
  assert.deepEqual(await plan("npm:pi-viewer@1.0.0"), { name: "pi-viewer", version: "1.0.0", needs: [] });
  assert.deepEqual((await plan("npm:pi-viewer@^2")).needs.length, 2);
});

test("a scoped name is asked for as npm writes it", async () => {
  publish("@me/pi-scoped", { "1.0.0": { requires: { "pithagoras-docker": "^1.0.0" } } });
  addresses.length = 0;
  assert.equal((await plan("npm:@me/pi-scoped")).needs.length, 1);
  // Its slash is part of the name: "@scope%2Fname".
  assert.deepEqual(addresses, ["/@me%2Fpi-scoped"]);
});

test("what cannot be known beforehand is planned as nothing: a git URL, a folder, a package npm has not, a registry that fails", async () => {
  asked.length = 0;
  for (const spec of ["git:github.com/user/repo", "https://github.com/user/repo", "/srv/my-extension", "./mine"]) assert.deepEqual(await plan(spec), { needs: [] });
  assert.deepEqual(asked, [], "npm was not asked for what is not on it");
  assert.deepEqual(await plan("npm:pi-nowhere"), { needs: [] });
  assert.deepEqual(await plan("npm:pi-broken"), { needs: [] });
});

test("a requirement npm cannot be asked about is said with why", async () => {
  const folder = [{ name: "x", version: "1.0.0", spec: "/x/x", requires: { "pi-broken": "^1.0.0" } }];
  const [need] = (await plan("/x/x", { folder })).needs;
  assert.equal(need.action, "missing");
  assert.match(need.error, /npm answered 500/);
});
