import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { freePort, serverEnv, startServer, testHome } from "./server-harness.mjs";

// What a test is told is its server is the server it started, not whatever answers on the port it was given.

test("a port that something else answers on is not taken for the server that was started", async () => {
  const port = await freePort();
  // Another test's server, or a fake one, that took the port between `freePort` and the server opening it.
  const other = createServer((req, res) => res.end(JSON.stringify({ ok: true, from: "other" }))).listen(port, "127.0.0.1");
  await new Promise((resolve) => other.once("listening", resolve));
  try {
    const server = await startServer(serverEnv(testHome("pithagoras-harness-port-"), port));
    assert.notEqual(server.port, port, "it listens on a port of its own");
    assert.equal(server.base, `http://127.0.0.1:${server.port}`);
    const answer = await (await fetch(`${server.base}/api/auth/status`)).json();
    assert.notEqual(answer.from, "other", "and what answers there is that server");
    assert.equal(typeof answer.authRequired, "boolean");
  } finally {
    other.close();
  }
});
