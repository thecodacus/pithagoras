import assert from "node:assert/strict";
import { appendFileSync, chmodSync, cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { freePort, serverEnv, startServer, testHome } from "./server-harness.mjs";

/**
 * What every page follows of what is installed: the revision `GET /api/sessions` answers with, which changes when an
 * install made through the API changes what is installed or what the pages load, a stylesheet alone included, and with
 * which `GET /api/extension-ui` says what it lists; and what a page says failed of a browser half, kept until another
 * revision of it is installed. Against the whole server, with the Notes test extension installed by its folder, as an
 * agent or another tab would install it.
 */
const home = testHome("extensions-follow-");
const notes = path.join(home, "packages", "notes");
cpSync(fileURLToPath(new URL("../../../tests/fixtures/extensions/notes", import.meta.url)), notes, { recursive: true });
const settings = path.join(home, "agent", "settings.json");
writeFileSync(settings, JSON.stringify({ packages: [] }));
// pi, as far as the portal asks it to install, remove and list: what it installs is a folder, listed where it is. One
// switched off is listed in its settings with what it may load, under `source`.
const bin = path.join(home, "fake-bin");
mkdirSync(bin, { recursive: true });
writeFileSync(
  path.join(bin, "pi"),
  `#!${process.execPath}
const fs = require("node:fs");
const [command, spec] = process.argv.slice(2);
const file = ${JSON.stringify(settings)};
const all = JSON.parse(fs.readFileSync(file, "utf8"));
const source = (p) => (typeof p === "string" ? p : p.source);
if (command === "list") {
  process.stdout.write("User packages:\\n" + all.packages.map((p) => "  " + source(p) + "\\n    " + source(p) + "\\n").join(""));
} else if (command === "remove" || (command === "install" && !all.packages.some((p) => source(p) === spec))) {
  all.packages = all.packages.filter((p) => source(p) !== spec).concat(command === "install" ? [spec] : []);
  fs.writeFileSync(file, JSON.stringify(all));
}
`,
);
chmodSync(path.join(bin, "pi"), 0o755);

const env = serverEnv(home, await freePort());
const { base } = await startServer({ ...env, PATH: `${bin}${path.delimiter}${env.PATH}` });
const call = async (method, url, body) => {
  const res = await fetch(`${base}${url}`, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
};
/** What is installed, as every page is told it with the chats. */
const revision = async () => (await call("GET", "/api/sessions")).body.extensions;
const listed = async () => (await call("GET", "/api/extension-ui")).body.extensions.find((e) => e.name === "pithagoras-notes");
const install = async () => assert.equal((await call("POST", "/api/packages", { spec: notes })).status, 200);

test("an install made through the API changes what every page is told is installed, a stylesheet alone included", async () => {
  // The portal goes through what is installed as it starts, after it listens.
  let before = await revision();
  for (let i = 0; i < 100 && !before; i++) {
    await new Promise((r) => setTimeout(r, 100));
    before = await revision();
  }
  assert.ok(before, "a revision once the portal has gone through what is installed");
  assert.equal(await listed(), undefined);

  await install();
  const installed = await revision();
  assert.notEqual(installed, before);
  const first = await listed();
  assert.ok(first.entry.endsWith(`/~${first.rev}/client.js`), first.entry);
  assert.ok(first.server, "its server half runs");
  assert.equal(await revision(), installed, "nothing changed, nothing to follow");
  // The list of what the pages load is said with the revision it is of.
  assert.equal((await call("GET", "/api/extension-ui")).body.revision, installed);

  // Only the stylesheet changed: installed again by the same folder, the module is another revision for the page.
  appendFileSync(path.join(notes, "web", "client.css"), "\n.pn-page { letter-spacing: 1px; }\n");
  await install();
  const restyled = await listed();
  assert.notEqual(restyled.rev, first.rev);
  assert.notEqual(restyled.entry, first.entry);
  assert.notEqual(restyled.style, first.style);
  assert.notEqual(await revision(), installed);

  const removed = await call("DELETE", "/api/packages", { spec: notes });
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  assert.equal(await listed(), undefined);
  assert.equal(await revision(), before, "as it was before it was installed");
});

test("what a page says failed of a browser half is said with it, until another revision of it is installed", async () => {
  await install();
  const { rev } = await listed();
  assert.equal((await listed()).clientError, undefined);
  for (const body of [{ name: "pithagoras-notes", rev }, { name: "pithagoras-notes", error: "x" }, { rev, error: "x" }, { name: "pithagoras-notes", rev, error: "" }]) {
    assert.equal((await call("POST", "/api/extension-ui/failures", body)).status, 400, JSON.stringify(body));
  }
  // Of an extension that has no browser half here, or of a revision that is not the one installed: a page that still had an old one.
  assert.equal((await call("POST", "/api/extension-ui/failures", { name: "not-installed", rev, error: "x" })).status, 404);
  assert.equal((await call("POST", "/api/extension-ui/failures", { name: "pithagoras-notes", rev: "old", error: "x" })).status, 404);

  assert.equal((await call("POST", "/api/extension-ui/failures", { name: "pithagoras-notes", rev, error: "x", stack: 1 })).status, 400);

  assert.deepEqual((await call("POST", "/api/extension-ui/failures", { name: "pithagoras-notes", rev, error: "notes is not defined" })).body, { ok: true });
  assert.equal((await listed()).clientError, "notes is not defined");
  assert.equal((await listed()).clientStack, undefined);
  // The latest is the one kept, with where it failed.
  const stack = "Error: drew badly\n    at Page (/api/extension-ui/pithagoras-notes/~r/client.js:3:9)\n    in Page";
  await call("POST", "/api/extension-ui/failures", { name: "pithagoras-notes", rev, error: "drew badly", stack });
  assert.equal((await listed()).clientError, "drew badly");
  assert.equal((await listed()).clientStack, stack);

  // Mended, and installed again: the new revision has not failed.
  const module = path.join(notes, "web", "client.js");
  writeFileSync(module, `${readFileSync(module, "utf8")}\n// mended\n`);
  await install();
  const mended = await listed();
  assert.notEqual(mended.rev, rev);
  assert.equal(mended.clientError, undefined);
});

test("a package with nothing for the pages, installed, switched or removed, changes what every page is told is installed", async () => {
  // A pi half and nothing else: Settings → Extensions lists it all the same.
  const only = path.join(home, "packages", "pi-only");
  mkdirSync(only, { recursive: true });
  writeFileSync(path.join(only, "package.json"), JSON.stringify({ name: "pi-only", version: "1.0.0", keywords: ["pi-package"], pi: {} }));
  const before = await revision();
  assert.equal((await call("POST", "/api/packages", { spec: only })).status, 200);
  const installed = await revision();
  assert.notEqual(installed, before);
  assert.equal((await call("PUT", "/api/extensions/enabled", { spec: only, enabled: false })).status, 200);
  assert.notEqual(await revision(), installed);
  assert.equal((await call("DELETE", "/api/packages", { spec: only })).status, 200);
  assert.equal(await revision(), before);
});

test("a server half that starts on a later sync, though nothing it is made of changed, changes what every page is told", async () => {
  const pkg = path.join(home, "packages", "late");
  mkdirSync(pkg, { recursive: true });
  const marker = path.join(home, "late-may-start");
  writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "late", version: "1.0.0", type: "module", keywords: ["pi-package"], pithagoras: { server: "./server.js" } }));
  writeFileSync(path.join(pkg, "server.js"), `import { existsSync } from "node:fs";\nexport default function () { if (!existsSync(${JSON.stringify(marker)})) throw new Error("not yet"); }\n`);
  const ui = async () => (await call("GET", "/api/extension-ui")).body.extensions.find((e) => e.name === "late");
  assert.equal((await call("POST", "/api/packages", { spec: pkg })).status, 200);
  const failed = await revision();
  assert.match((await ui()).serverError ?? "", /not yet/);
  writeFileSync(marker, "");
  assert.equal((await call("POST", "/api/packages", { spec: pkg })).status, 200);
  assert.ok((await ui()).server);
  assert.notEqual(await revision(), failed);
});
