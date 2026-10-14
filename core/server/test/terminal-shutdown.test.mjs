import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { freePort, serverEnv, startServer, testHome } from "./server-harness.mjs";

// What becomes of the shells in the terminal panel when the portal is stopped: its stop is a restart or
// an update, and a shell left behind keeps whatever it started, with no panel to close it.

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** A portal of its own, with a terminal whose shell has started jobs, and the processes to look for. */
async function portalWithShell(t) {
  const home = testHome("pithagoras-term-stop-");
  // `script` runs its command through $SHELL, so it has to be a lone path.
  const { base, child } = await startServer(serverEnv(home, await freePort(), { SHELL: "/bin/sh" }));
  const post = (url, body) =>
    fetch(base + url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) }).then((r) => r.json());

  /** What the shell wrote, until `until` shows up in it. */
  async function read(id, until) {
    const controller = new AbortController();
    const res = await fetch(`${base}/api/terminal/${id}/stream`, { signal: controller.signal });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let text = "";
    let pending = "";
    const deadline = Date.now() + 8000;
    while (!until.test(text) && Date.now() < deadline) {
      const timeout = new Promise((resolve) => setTimeout(() => resolve({ done: true }), deadline - Date.now()));
      const { value, done } = await Promise.race([reader.read(), timeout]);
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      const lines = pending.split("\n");
      pending = lines.pop();
      for (const line of lines) if (line.startsWith("data: ")) text += JSON.parse(line.slice(6));
    }
    controller.abort();
    return text;
  }

  const { id } = await post("/api/terminal");
  await post(`/api/terminal/${id}/input`, { data: "echo up-$((40+2))\n" });
  assert.match(await read(id, /up-42/), /up-42/, "the shell came up");
  await post(`/api/terminal/${id}/input`, { data: "nohup sleep 300 >/dev/null 2>&1 & echo ignores=$! shell=$$ script=$PPID\n" });
  const found = /ignores=(\d+) shell=(\d+) script=(\d+)/.exec(await read(id, /script=\d+/));
  assert.ok(found, "the shell answered");
  const [, ignores, shell, script] = found.map(Number);
  // A job in the foreground, which the hangup reaches.
  await post(`/api/terminal/${id}/input`, { data: "sleep 301 & echo hangs=$!\n" });
  const hangs = Number(/hangs=(\d+)/.exec(await read(id, /hangs=\d+/))?.[1]);
  const all = [ignores, shell, script, hangs];
  assert.ok(all.every((pid) => pid > 0 && alive(pid)), "all of them are running");
  // What the test started is not left running when it fails.
  t.after(() => { for (const pid of all) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } } });
  return { child, all };
}

/** Not left for init: the stop waited for them, or they are gone a moment after it. */
async function assertGone(all) {
  const deadline = Date.now() + 5000;
  while (all.some(alive) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(all.filter(alive), [], "the shell, `script` and both jobs are gone");
}

test("stopping the portal ends its terminals' shells and what they started, even what ignores the hangup", { skip: process.platform !== "linux" }, async (t) => {
  const { child, all } = await portalWithShell(t);
  child.kill("SIGTERM");
  await once(child, "exit");
  await assertGone(all);
});

test("a second signal in the middle of the stop leaves the shells their two seconds, then kills what ignores the hangup", { skip: process.platform !== "linux" }, async (t) => {
  const { child, all } = await portalWithShell(t);
  // As a second Ctrl-C does, or a package that ends its own children on SIGTERM and raises the signal again.
  child.kill("SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, 100));
  child.kill("SIGTERM");
  await once(child, "exit");
  await assertGone(all);
});
