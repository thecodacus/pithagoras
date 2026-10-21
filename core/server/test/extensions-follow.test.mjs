import assert from "node:assert/strict";
import { appendFileSync, chmodSync, cpSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { freePort, serverEnv, startServer, testHome } from "./server-harness.mjs";

/**
 * What every page follows of what is installed: the revision `GET /api/sessions` answers with, which changes when an
 * install made through the API changes what the pages load, a stylesheet alone included. Against the whole server, with
 * the Notes test extension installed by its folder, as an agent or another tab would install it.
 */
const home = testHome("extensions-follow-");
const notes = path.join(home, "packages", "notes");
cpSync(fileURLToPath(new URL("../../../tests/fixtures/extensions/notes", import.meta.url)), notes, { recursive: true });
const settings = path.join(home, "agent", "settings.json");
writeFileSync(settings, JSON.stringify({ packages: [] }));
// pi, as far as the portal asks it to install, remove and list: what it installs is a folder, listed where it is.
const bin = path.join(home, "fake-bin");
mkdirSync(bin, { recursive: true });
writeFileSync(
  path.join(bin, "pi"),
  `#!${process.execPath}
const fs = require("node:fs");
const [command, spec] = process.argv.slice(2);
const file = ${JSON.stringify(settings)};
const all = JSON.parse(fs.readFileSync(file, "utf8"));
if (command === "list") {
  process.stdout.write("User packages:\\n" + all.packages.map((p) => "  " + p + "\\n    " + p + "\\n").join(""));
} else if (command === "install" || command === "remove") {
  all.packages = all.packages.filter((p) => p !== spec).concat(command === "install" ? [spec] : []);
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
  assert.ok(first.server, "its server half runs");
  assert.equal(await revision(), installed, "nothing changed, nothing to follow");

  // Only the stylesheet changed: installed again by the same folder, the module is another revision for the page.
  appendFileSync(path.join(notes, "web", "client.css"), "\n.pn-page { letter-spacing: 1px; }\n");
  await install();
  const restyled = await listed();
  assert.notEqual(restyled.entry, first.entry);
  assert.notEqual(restyled.style, first.style);
  assert.notEqual(await revision(), installed);

  const removed = await call("DELETE", "/api/packages", { spec: notes });
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  assert.equal(await listed(), undefined);
  assert.equal(await revision(), before, "as it was before it was installed");
});
