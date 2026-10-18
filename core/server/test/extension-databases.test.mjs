import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { inProcessHome } from "./server-harness.mjs";

/**
 * The extensions the portal ships that keep a database (Canvas, Documents), started by the portal's own host: they open it with
 * the driver the host gives them (`portal.sqlite`) and bring none, so what they need is in the portal. Canvas's database is made as
 * it starts. Needs the extensions built (`npm run build:extensions`).
 */
const home = inProcessHome("extension-databases-");
const EXTENSIONS = fileURLToPath(new URL("../../../extensions/", import.meta.url));
const host = await import("../dist/extension-host.js");
const built = (name) => existsSync(path.join(EXTENSIONS, name, "server.js"));
test.after(() => host.stopServerHalves());

test("Canvas and Documents start on the portal's driver, with no package of their own for it, and Canvas's database is made in its data folder", { skip: !built("canvas") && "the extensions are not built" }, async () => {
  const halves = ["canvas", "docs"].map((folder) => {
    const file = path.join(EXTENSIONS, folder, "server.js");
    return { name: `pithagoras-${folder}`, version: "0.1.0", file, rev: `${statSync(file).mtimeMs}-1` };
  });
  await host.syncServerHalves(halves);
  await host.serversSettled();
  for (const { name } of halves) assert.ok(host.isServing(name), `${name} is serving`);
  const data = path.join(home, "extension-data", "pithagoras-canvas", "canvases.db");
  assert.ok(existsSync(data), `${data} is made`);
  // Nothing of theirs reaches for a driver of its own, and their packages do not name one.
  for (const folder of ["canvas", "docs"]) {
    assert.ok(!readFileSync(path.join(EXTENSIONS, folder, "server.js"), "utf8").includes("better-sqlite3"), `${folder}'s server half names no driver`);
    const manifest = JSON.parse(readFileSync(path.join(EXTENSIONS, folder, "package.json"), "utf8"));
    assert.deepEqual(Object.keys({ ...manifest.dependencies, ...manifest.devDependencies }).filter((name) => name.includes("sqlite")), [], `${folder}'s package names no driver`);
  }
});
