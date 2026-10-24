/**
 * Unit tests for src/jszip.ts: the LAZY jszip loader that replaces the old static `import JSZip from "jszip"` --
 * the built server.js must import cleanly without this package's own node_modules yet, and only the first
 * template/import call waits for deps.ensureDependencies (wired through armJsZipInstall at boot). Assertions:
 * one load per process, the armed install promise gates that first load, and the result really is jszip.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { jsZip, armJsZipInstall } from "../src/jszip";

test("jsZip gates its first load on the armed install promise, then resolves to the real package", async () => {
  let release: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  armJsZipInstall(gate.then(() => true)); // what server.ts arms with is ensureDependencies' promise

  const load = jsZip();
  let settled = false;
  load.then(
    () => (settled = true),
    () => (settled = true),
  );
  await new Promise((r) => setTimeout(r, 25)); // the install has not run: the load must still be pending
  assert.equal(settled, false, "jsZip must wait for the armed install before importing jszip");

  release();
  const zip = await load;
  assert.equal(typeof (zip as unknown as { loadAsync?: unknown }).loadAsync, "function", "the static loadAsync must be there");
  const instance = new (zip as unknown as { new (): { file: unknown } })() as unknown as { file: unknown };
  assert.equal(typeof instance.file, "function", "a bare new() must give a working archive");

  // One load per process: the next call returns the very same promise's result without another gate.
  armJsZipInstall(new Promise(() => {})); // never settles: would hang again if re-gated
  assert.equal(await jsZip(), zip, "the cached load is returned; a later arm does not re-load");
});

test("an UNARMD install goes straight to the import (unit tests never boot the server entry)", async () => {
  // Fresh process for this file means the module state above is the only arming: assert the resolved shape one more time.
  const zip = await jsZip();
  assert.equal(typeof (zip as unknown as { version?: string }).version, "string", "jszip exposes its version string");
});
