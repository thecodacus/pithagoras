import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { inProcessHome } from "../../../tests/helpers.mts";
import { describe } from "../src/pi.ts";
import { serveSubagent } from "./portal.mts";

/**
 * A portal whose subagent tool was a pi package, with its settings in pi's settings.json, upgraded: the database's
 * upgrade leaves them for the extension and takes them out of pi's file, and the extension's server half, as it starts,
 * takes them up. The tool then tells the model what it told it before.
 */

inProcessHome("pithagoras-subagent-upgrade-");
const piSettings = path.join(process.env.PI_CODING_AGENT_DIR!, "settings.json");
writeFileSync(piSettings, JSON.stringify({ packages: ["../../extensions/subagent"], subagentMode: "background", subagentMaxParallel: 3, defaultProvider: "llama-swap" }));
const portal = await serveSubagent();

test("the mode and the limit pi's settings held are the extension's after the upgrade, and the tool says them as before", async () => {
  assert.deepEqual(await (await fetch(`${portal.at}/settings`)).json(), { mode: "background", maxParallel: 3, model: "auto", maxParallelLimit: 16 });
  portal.db.createSession({ id: "chat-1", title: "t", workspace: process.env.WORKSPACE_ROOT!, executor: "host", kind: "task" });
  assert.equal(portal.toolsIn("chat-1").get("subagent")?.description, describe("background", 3));
  // Out of pi's file, and the rest of it as it was; the hand-off taken and done with.
  assert.deepEqual(JSON.parse(readFileSync(piSettings, "utf8")), { packages: ["../../extensions/subagent"], defaultProvider: "llama-swap" });
  assert.equal(existsSync(path.join(process.env.DATA_DIR!, "handoff", "subagent")), false);
  assert.equal(existsSync(path.join(portal.data, "handoff-subagent")), false);
});
