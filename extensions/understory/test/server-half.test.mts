import { test } from "node:test";
import assert from "node:assert/strict";
import { inProcessHome } from "../../../tests/helpers.mts";
import { startUnderstory } from "./portal.mts";

/** Understory's server half in the portal's own extension host: it builds on Docker, and starts only after it. */

inProcessHome("pithagoras-understory-half-");
const { host, halves } = await startUnderstory();

test("Understory's server half does not start without Docker, which it requires, and starts after it", async () => {
  await host.syncServerHalves([halves.understory]);
  assert.equal(host.isServing("pithagoras-understory"), false);
  assert.match(host.serverFailure("pithagoras-understory") ?? "", /It needs pithagoras-docker \(\^1\.1\.0\), which is not installed, or is switched off/);

  await host.syncServerHalves([halves.understory, halves.docker]);
  assert.equal(host.serverFailure("pithagoras-understory"), undefined);
  assert.deepEqual([host.isServing("pithagoras-docker"), host.isServing("pithagoras-understory")], [true, true]);
});
