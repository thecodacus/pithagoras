import { test } from "node:test";
import assert from "node:assert/strict";
import { inProcessHome } from "./server-harness.mjs";

inProcessHome("pithagoras-update-schedule-");
const { startUpdateChecks, portalUpdater } = await import("../dist/api/update.js");

test("the portal looks for new commits by itself unless PORTAL_UPDATE_CHECK says off", () => {
  let begun = 0;
  portalUpdater.begin = async () => void begun++;
  try {
    delete process.env.PORTAL_UPDATE_CHECK;
    startUpdateChecks();
    assert.equal(begun, 1);
    for (const off of ["off", "OFF", "0", "false", "no"]) {
      process.env.PORTAL_UPDATE_CHECK = off;
      startUpdateChecks();
    }
    assert.equal(begun, 1, "none of the ways of saying no looked");
    process.env.PORTAL_UPDATE_CHECK = "on";
    startUpdateChecks();
    assert.equal(begun, 2);
  } finally {
    delete process.env.PORTAL_UPDATE_CHECK;
  }
});
