import { test } from "node:test";
import assert from "node:assert/strict";
import { inProcessHome } from "../../../tests/helpers.mts";
import { startBrowser } from "./portal.mts";

/** Browser's server half in the portal's own extension host: it builds on Docker, and starts only after it. */

inProcessHome("pithagoras-browser-half-");
const { host, halves } = await startBrowser();

test("Browser's server half does not start without Docker, which it requires, and starts after it", async () => {
  await host.syncServerHalves([halves.browser]);
  assert.equal(host.isServing("pithagoras-browser"), false);
  assert.match(host.serverFailure("pithagoras-browser") ?? "", /It needs pithagoras-docker \(\^1\.0\.0\), which is not installed, or is switched off/);

  await host.syncServerHalves([halves.browser, halves.docker]);
  assert.equal(host.serverFailure("pithagoras-browser"), undefined);
  assert.deepEqual([host.isServing("pithagoras-docker"), host.isServing("pithagoras-browser")], [true, true]);
});
