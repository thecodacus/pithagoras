import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import path from "node:path";
import test from "node:test";
import { inProcessHome } from "./server-harness.mjs";

/**
 * What a server half sees of the host's processes (`portal.proc`): the fields of one process's stat, and every process of
 * a session signalled. Linux's /proc, as where the portal runs.
 */
const home = inProcessHome("extension-proc-");
const pkg = path.join(home, "packages", "shells");
mkdirSync(pkg, { recursive: true });
const NAME = "pithagoras-shells";
const file = path.join(pkg, "server.js");
writeFileSync(file, "export default async function (portal) { globalThis.shells = portal; }\n");
const stat = statSync(file);

const host = await import("../dist/extension-host.js");
await host.syncServerHalves([{ name: NAME, version: "1.0.0", file, rev: `${stat.mtimeMs}-1` }]);
test.after(() => host.stopServerHalves());

test("the stat of a process is its fields after the command's name, and nothing for a process that is not there", { skip: process.platform !== "linux" }, () => {
  const { proc } = globalThis.shells;
  const mine = proc.stat(process.pid);
  assert.match(mine[0], /^[A-Za-z]$/, "the state");
  assert.equal(Number(mine[1]), process.ppid, "the parent");
  assert.ok(Number(mine[3]) > 0, "the session");
  assert.equal(proc.stat(String(process.pid))[3], mine[3], "a pid is taken as a number or as text");
  assert.equal(proc.stat(2 ** 22 + 1), undefined);
});

test("every process of a session is signalled and said, and none of another", { skip: process.platform !== "linux" }, async () => {
  const { proc } = globalThis.shells;
  // A session of its own (setsid), with a child in it, and a process of this session that must be left alone.
  const leader = spawn("setsid", ["sh", "-c", "sleep 30 & echo $$; wait"], { stdio: ["ignore", "pipe", "ignore"] });
  const bystander = spawn("sleep", ["30"], { stdio: "ignore" });
  try {
    const [first] = await once(leader.stdout, "data");
    const shell = Number(String(first).trim());
    const session = Number(proc.stat(shell)[3]);
    assert.equal(session, shell, "the shell is the leader of the session setsid made");
    assert.notEqual(session, Number(proc.stat(process.pid)[3]));
    const members = await proc.signalSession(session, "SIGTERM");
    assert.ok(members.includes(shell) && members.length >= 2, `the shell and its sleep: ${members}`);
    assert.ok(!members.includes(process.pid) && !members.includes(bystander.pid));
    await once(leader, "exit");
    assert.equal(bystander.exitCode, null, "a process of another session is left running");
    assert.deepEqual(await proc.signalSession(session, "SIGTERM"), [], "none left to signal");
  } finally {
    leader.kill("SIGKILL");
    bystander.kill("SIGKILL");
  }
});
