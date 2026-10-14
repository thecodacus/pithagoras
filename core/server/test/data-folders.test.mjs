import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { freePort, runToEnd, serverEnv, startServer, testHome } from "./server-harness.mjs";

// A portal started from source, as somebody who is not root: the folders it keeps for itself that nothing
// names are inside its data directory. They used to be under a fixed /data, which only the image has,
// and the server did not start without it.
const home = testHome("pithagoras-data-folders-");
rmSync(path.join(home, "agent-home"), { recursive: true });
// What this process itself reads is another one, as the server is running in the first.
const own = testHome("pithagoras-data-folders-own-");

test("with only DATA_DIR given, the bin folder, the agent's home and the channels folder are made inside it", async () => {
  const env = serverEnv(home, await freePort());
  for (const name of ["BIN_DIR", "AGENT_HOME", "CHANNELS_DIR"]) delete env[name];
  const { base } = await startServer(env);
  assert.equal((await fetch(`${base}/api/auth/status`)).ok, true);
  for (const name of ["bin", "agent-home", "channels"]) assert.ok(existsSync(path.join(home, name)), `${name} is in the data directory`);
});

test("the folders it names itself are where it says, and the local browser's profile is in the data directory", async () => {
  process.env.DATA_DIR = own;
  process.env.AGENT_HOME = path.join(own, "elsewhere");
  const { agentHomePath } = await import("../dist/agent-home.js");
  assert.equal(agentHomePath(), path.join(own, "elsewhere"));
  delete process.env.AGENT_HOME;
  assert.equal(agentHomePath(), path.join(own, "agent-home"));
  const { dataFolder } = await import("../dist/data-dir.js");
  process.env.BIN_DIR = "/somewhere/else";
  assert.equal(dataFolder("BIN_DIR", "bin"), "/somewhere/else");
  delete process.env.BIN_DIR;
  assert.equal(dataFolder("BIN_DIR", "bin"), path.join(own, "bin"));
  const local = await import("../dist/extensions/browser-local.js");
  assert.equal(local.status().profile, path.join(own, "browser-profile"));
});

test("with no DATA_DIR at all, the local browser's profile is in ./data, not in /data", async () => {
  const cwd = testHome("pithagoras-data-folders-cwd-");
  const env = { ...process.env };
  delete env.DATA_DIR;
  const module = fileURLToPath(new URL("../dist/extensions/browser-local.js", import.meta.url));
  const { code, out, err } = await runToEnd(["--input-type=module", "-e", `const { status } = await import(${JSON.stringify(module)}); console.log(status().profile);`], env, { cwd });
  assert.equal(code, 0, err);
  assert.equal(out.trim(), path.join(cwd, "data", "browser-profile"));
});
