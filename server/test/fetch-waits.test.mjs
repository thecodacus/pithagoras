import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";

// The waits the whole process's fetch is given — set short, as a run of the portal would ask for.
process.env.PORTAL_FETCH_HEADERS_TIMEOUT_MS = "400";
process.env.PORTAL_FETCH_BODY_TIMEOUT_MS = "600";
// A runner with its own proxies must not take the loopback test out to them; the install and the
// requests that follow stay on the machine.
delete process.env.NODE_USE_ENV_PROXY;
process.env.NO_PROXY = "127.0.0.1,localhost";
// Importing no longer changes how fetch behaves — the test, like the portal's entry, asks for it.
const { waitMs, globalWaits, installFetchWaits, waitsAgent } = await import("../dist/fetch-waits.js");
installFetchWaits();

test("the waits are read from where the portal starts", () => {
  assert.equal(globalWaits.headers, 400);
  assert.equal(globalWaits.body, 600);
});

test("a wait as said keeps its edges: whole, or the default", () => {
  const f = 1_000;
  assert.equal(waitMs(undefined, f), f); // asked for nothing
  assert.equal(waitMs("", f), f);
  assert.equal(waitMs("  ", f), f);
  assert.equal(waitMs("12.5", f), f); // finer than a whole millisecond is not a saying of one
  assert.equal(waitMs("-30", f), f); // negative: no such wait
  assert.equal(waitMs("soon", f), f);
  assert.equal(waitMs("99999999999999", f), 2_147_483_647); // past what a timer may hold
  assert.equal(waitMs("0", f), 0); // zero said, zero taken: no wait at all
});

test("the proxy rule takes only what node takes", () => {
  // EnvHttpProxyAgent is made when the rule fires; a plain Agent's name carries no such telling.
  const plain = () => !waitsAgent({ headers: 1, body: 1 }).constructor.name.includes("Proxy");
  try {
    delete process.env.NODE_USE_ENV_PROXY;
    assert.ok(plain(), "no asking, no proxying");
    process.env.NODE_USE_ENV_PROXY = "0";
    assert.ok(plain(), "a zero is not an asking");
    process.env.NODE_USE_ENV_PROXY = "true"; // node would not take this — neither does the portal
    assert.ok(plain());
    process.env.NODE_USE_ENV_PROXY = "1";
    assert.ok(!plain(), "the one saying node takes is taken");
  } finally {
    delete process.env.NODE_USE_ENV_PROXY;
  }
});

test("a fetch given the process's wait is cut off at it, not at node's five minutes", async () => {
  // An address that receives the ask and answers none of it — as Understory does while its model thinks.
  const late = new Set();
  const server = http.createServer((req, res) => late.add(setTimeout(() => res.end("{}"), 5_000)));
  await once(server.listen(0, "127.0.0.1"), "listening");
  const port = server.address().port;

  let failed = false;
  const began = Date.now();
  try {
    try {
      await fetch(`http://127.0.0.1:${port}/`);
    } catch (e) {
      failed = true;
      assert.equal(e?.cause?.code ?? e?.code, "UND_ERR_HEADERS_TIMEOUT");
    }
    const elapsed = Date.now() - began;
    assert.ok(failed, "a headers timeout was raised");
    // The wait that cut it off was the one asked for. Undici's timers fire coarse — about a second — so
    // only the order is asserted: this side of the server's own five-second answer, long out of node's
    // five quiet minutes.
    assert.ok(elapsed >= 300 && elapsed < 4_000, `it was cut at its own wait (${elapsed} ms), not node's`);
  } finally {
    // Even on an assertion failure: the delayed answers would outlive a failed test and hold the event
    // loop, and the open listener the sockets.
    for (const t of late) clearTimeout(t);
    server.closeAllConnections();
    server.close();
  }
});
