import { test } from "node:test";
import assert from "node:assert/strict";
import { inProcessHome } from "../../../tests/helpers.mts";
import { startVoice } from "./portal.mts";

/** Voice's server half in the portal's own extension host: it builds on Docker, and starts only after it. */

inProcessHome("pithagoras-voice-half-");
const { host, halves } = await startVoice();

test("Voice's server half does not start without Docker, which it requires, and starts after it", async () => {
  await host.syncServerHalves([halves.voice]);
  assert.equal(host.isServing("pithagoras-voice"), false);
  assert.match(host.serverFailure("pithagoras-voice") ?? "", /It needs pithagoras-docker \(\^1\.1\.0\), which is not installed, or is switched off/);

  await host.syncServerHalves([halves.voice, halves.docker]);
  assert.equal(host.serverFailure("pithagoras-voice"), undefined);
  assert.deepEqual([host.isServing("pithagoras-docker"), host.isServing("pithagoras-voice")], [true, true]);
});
