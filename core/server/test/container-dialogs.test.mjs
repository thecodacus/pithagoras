import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * A dialog an extension opens where nobody can answer it (issue #114) is answered at once in a container
 * too: pi's RPC mode sends it as a request, and the portal answers "cancelled" instead of handing it to a
 * page. A fake `docker` stands in for the container: it sends a confirm and a status line, and keeps
 * whatever the portal writes back.
 */
const dir = mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), "pithagoras-container-dialogs-"));
writeFileSync(
  path.join(dir, "docker"),
  `#!/bin/sh
case "$1" in
  container) echo "Error: No such container: x" >&2; exit 1 ;;
  run)
    echo '{"type":"extension_ui_request","id":"c1","method":"confirm","title":"Sure?","message":"Really"}'
    echo '{"type":"extension_ui_request","id":"s1","method":"setStatus","statusKey":"k","statusText":"hi"}'
    cat >> "$FAKE_DOCKER_LOG" ;;
esac
`,
);
chmodSync(path.join(dir, "docker"), 0o755);
process.env.PATH = `${dir}:${process.env.PATH}`;

const { ContainerExecutor } = await import("../dist/executors/index.js");

/** The events the container's pi sends, once the fake has said everything. */
async function run(sessionId, dialogs) {
  process.env.FAKE_DOCKER_LOG = path.join(dir, `${sessionId}.log`);
  const executor = new ContainerExecutor("img", path.join(dir, "sessions"), { memoryMb: 64, cpus: 1, pidsLimit: 16 });
  const client = await executor.launch({ sessionId, workspacePath: dir, dialogs });
  const events = [];
  client.on("event", (e) => events.push(e));
  await new Promise((resolve) => setTimeout(resolve, 500));
  return { client, events, log: process.env.FAKE_DOCKER_LOG };
}

test("a container's dialog is answered at once with cancelled where nobody can answer, and goes to no page", async () => {
  const { client, events, log } = await run("nobody", false);
  try {
    assert.deepEqual(events.map((e) => e.method), ["setStatus"], "only the one-way news went out");
    const answers = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(answers, [{ type: "extension_ui_response", id: "c1", cancelled: true }]);
  } finally {
    client.dispose();
  }
});

test("a container's dialog in a chat of the person's goes to the page and waits for its answer", async () => {
  const { client, events, log } = await run("somebody", true);
  try {
    assert.deepEqual(events.map((e) => e.method), ["confirm", "setStatus"]);
    assert.equal(readFileSync(log, "utf8"), "", "nothing was answered for the person");
    assert.equal(client.respondUi("c1", { value: true }), true);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.deepEqual(JSON.parse(readFileSync(log, "utf8")), { type: "extension_ui_response", id: "c1", value: true });
  } finally {
    client.dispose();
  }
});
