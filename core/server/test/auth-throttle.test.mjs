import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import net from "node:net";
import { security, issued, base, port, server, sharedPortal, signedIn, api, upgrade, opened, until } from "./auth-harness.mjs";

/**
 * The login throttle, and the login on every stream, which an extension's server half takes under its routes
 * (a stand-in's here, see auth-harness.mjs) only once the portal has let it through (see auth.test.mjs for the login).
 */
sharedPortal();

// --- the login throttle ---

const attempts = (limiter, address, times) => {
  let through = 0;
  let refused = 0;
  const res = { setHeader() {}, status() { refused++; return this; }, json() {}, on() {} };
  for (let i = 0; i < times; i++) limiter({ socket: { remoteAddress: address } }, res, () => through++);
  return { through, refused };
};

test("an IPv6 /64 is one address to the throttle, and a mapped IPv4 address is the IPv4 one", () => {
  const { throttleKey } = security;
  assert.equal(throttleKey("2001:db8:1:2:aaaa:bbbb:cccc:dddd"), throttleKey("2001:db8:1:2::1"));
  assert.equal(throttleKey("2001:db8:1:2::1"), throttleKey("2001:0db8:0001:0002:ffff::"));
  assert.notEqual(throttleKey("2001:db8:1:2::1"), throttleKey("2001:db8:1:3::1"));
  assert.equal(throttleKey("::1"), throttleKey("0:0:0:0:5::7"));
  assert.equal(throttleKey("::ffff:10.0.0.7"), "10.0.0.7");
  assert.equal(throttleKey("192.0.2.5"), "192.0.2.5");
  assert.equal(throttleKey(undefined), "unknown");

  // Eleven attempts, each from another address of one block: the eleventh is refused.
  const limiter = security.loginThrottle();
  const block = Array.from({ length: 11 }, (_, i) => `2001:db8:5:6:${i.toString(16)}::1`);
  const seen = block.map((address) => attempts(limiter, address, 1));
  assert.equal(seen.filter((r) => r.refused).length, 1, "the one that was one too many");
  assert.equal(attempts(limiter, "2001:db8:5:7::1", 1).through, 1, "the next block is not affected");
});

test("when the throttle is full, the oldest entry makes room and a new address still gets its attempts", () => {
  const limiter = security.loginThrottle();
  for (let i = 0; i < 4096; i++) attempts(limiter, `10.${i >> 8}.${i & 255}.1`, 1);
  // Every one of the 4096 has an attempt on record: the owner, from a 4097th
  // address, must not be locked out because of them.
  assert.deepEqual(attempts(limiter, "198.51.100.9", 1), { through: 1, refused: 0 });
  // And the first of them was the one that made room.
  assert.deepEqual(attempts(limiter, "10.0.0.1", 10), { through: 10, refused: 0 });
});

test("a locked address stays locked however many others pass through a full throttle", () => {
  const limiter = security.loginThrottle();
  const attacker = "2001:db8:0:1::1";
  assert.deepEqual(attempts(limiter, attacker, 10), { through: 10, refused: 0 });
  assert.equal(attempts(limiter, attacker, 1).refused, 1, "locked after ten");
  // 4096 other blocks fail once each: the map is full and the attacker is its oldest entry.
  for (let i = 0; i < 4096; i++) attempts(limiter, `2001:db8:1:${i.toString(16)}::1`, 1);
  assert.equal(attempts(limiter, attacker, 1).refused, 1, "evicting the lock would be ten more guesses for 4096 others");
  // The ones that failed once are what makes room, so a newcomer still gets in.
  assert.deepEqual(attempts(limiter, "198.51.100.9", 1), { through: 1, refused: 0 });
});

test("when every entry of a full throttle is locked, a newcomer is refused rather than a lock dropped", () => {
  const limiter = security.loginThrottle();
  for (let i = 0; i < 4096; i++) attempts(limiter, `10.${i >> 8}.${i & 255}.1`, 10);
  assert.equal(attempts(limiter, "198.51.100.9", 1).refused, 1);
  assert.equal(attempts(limiter, "10.0.0.1", 1).refused, 1, "and nobody's lock is gone");
});

test("addresses that stop at nine and let 4096 others push them out are held to the window's budget", () => {
  const limiter = security.loginThrottle();
  // 4097 addresses take turns, each with nine wrong logins and then out of the way: none is ever locked, and
  // each comes back to a count of nothing. Without a budget for the window every round is as free as the first.
  let through = 0;
  for (let round = 0; round < 5; round++) {
    for (let i = 0; i < 4097; i++) through += attempts(limiter, `2001:db8:${(i + 1).toString(16)}::1`, 9).through;
  }
  // The window's budget, the last attempt of each one in the map at that moment, and the nine of the one that found it spent.
  assert.ok(through <= 4096 * 10 + 4096 + 9, `${through} guesses in one window`);
  // And a newcomer is told to wait, which the window's end undoes.
  assert.equal(attempts(limiter, "198.51.100.9", 1).refused, 1);
});

test("the window's budget is a fresh one when the window is over", () => {
  let clock = 1_000_000;
  const limiter = security.loginThrottle(() => clock);
  for (let i = 0; i < 4097; i++) attempts(limiter, `10.${i >> 8}.${i & 255}.1`, 9);
  for (let i = 0; i < 500; i++) attempts(limiter, `172.16.${i >> 8}.${i & 255}`, 9);
  assert.equal(attempts(limiter, "198.51.100.9", 1).refused, 1, "the budget is spent");
  clock += 15 * 60_000 + 1;
  assert.deepEqual(attempts(limiter, "198.51.100.9", 1), { through: 1, refused: 0 }, "and it is new once the window is over");
});

// --- streams ---

test("a stream is behind the login: no extension is asked for it without one", async () => {
  const stream = upgrade();
  await until(() => stream.text().includes("\r\n\r\n"), "an answer");
  assert.match(stream.text(), /^HTTP\/1\.1 401 /);
  stream.socket.destroy();
  const wrong = upgrade({ Cookie: `${issued().name}=9999999999999.00` });
  await until(() => wrong.text().includes("\r\n\r\n"), "an answer to a made-up cookie");
  assert.match(wrong.text(), /^HTTP\/1\.1 401 /);
  wrong.socket.destroy();
  // And none that is not there is told apart from one that is, without it.
  const nobody = upgrade({}, "", "/api/x/nobody/stream");
  await until(() => nobody.text().includes("\r\n\r\n"), "an answer for an extension that is not there");
  assert.match(nobody.text(), /^HTTP\/1\.1 401 /);
  nobody.socket.destroy();
});

test("an upgrade that is not an extension's is answered and closed, not held open for whoever sent it", async () => {
  // Only an extension takes upgrades, so each of these is the portal's to answer: the page, the API, and an extension's
  // routes without the login.
  for (const url of ["/", "/api/sessions", "/api/xfoo", "/api/x/test-streams/stream"]) {
    const stream = upgrade({}, "", url);
    await until(() => stream.text().includes("\r\n\r\n"), `an answer to ${url}`);
    assert.match(stream.text(), url.startsWith("/api/x/") ? /^HTTP\/1\.1 401 / : /^HTTP\/1\.1 404 /, url);
    // Closed from the portal's side too, with the client still connected.
    await Promise.race([stream.closed, new Promise((_, reject) => setTimeout(() => reject(new Error(`${url} was left open`)), 3000))]);
  }
});

/** Whether the server process itself still holds the connection a client opened from `clientPort`, which is what a left-open one costs it. */
function heldByServer(clientPort) {
  const hex = (n) => n.toString(16).toUpperCase().padStart(4, "0");
  let inode;
  for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    for (const line of readFileSync(file, "utf8").split("\n").slice(1)) {
      const f = line.trim().split(/\s+/);
      if (f.length > 9 && f[1].endsWith(`:${hex(port)}`) && f[2].endsWith(`:${hex(clientPort)}`)) inode = f[9];
    }
  }
  // A connection nobody holds any more is listed with no inode: the kernel's, waiting out its own timeout.
  if (!inode || inode === "0") return false;
  return readdirSync(`/proc/${server.pid}/fd`).some((fd) => {
    try {
      return readlinkSync(`/proc/${server.pid}/fd/${fd}`) === `socket:[${inode}]`;
    } catch {
      return false;
    }
  });
}

test("clients that reset the connection while an upgrade is refused do not take the portal down", async () => {
  // Written, and reset as soon as the bytes are out: the answer the portal then writes meets a closed connection.
  const resets = [];
  for (const url of ["/", "/api/x/test-streams/stream", "/api/x/test-streams/stream"]) {
    for (let i = 0; i < 30; i++) {
      resets.push(new Promise((resolve) => {
        const socket = net.connect(port, "127.0.0.1");
        socket.on("error", () => {});
        socket.on("close", resolve);
        socket.write(
          [`GET ${url} HTTP/1.1`, `Host: 127.0.0.1:${port}`, "Connection: Upgrade", "Upgrade: websocket", "Sec-WebSocket-Version: 13", "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==", "", ""].join("\r\n"),
          () => socket.resetAndDestroy(),
        );
      }));
    }
  }
  await Promise.all(resets);
  // Whatever the portal did with them, it is the same portal, and it answers.
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(server.exitCode, null, "the portal is still running");
  assert.equal((await fetch(`${base}/api/auth/status`)).status, 200);
});

test("a refused upgrade whose client keeps its side open is let go of after a few seconds", { skip: process.platform !== "linux" }, async () => {
  const client = net.connect({ port, host: "127.0.0.1", allowHalfOpen: true });
  let text = "";
  client.on("data", (d) => { text += d; });
  client.on("error", () => {});
  client.write([`GET /api/sessions HTTP/1.1`, `Host: 127.0.0.1:${port}`, "Connection: Upgrade", "Upgrade: websocket", "Sec-WebSocket-Version: 13", "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==", "", ""].join("\r\n"));
  try {
    await until(() => text.includes("\r\n\r\n"), "an answer");
    assert.match(text, /^HTTP\/1\.1 404 /);
    // Answered and closed on the portal's side; ours is never closed. The portal has it until it gives up.
    assert.equal(heldByServer(client.localPort), true, "the portal still has the connection just after the answer");
    // It gives up after five seconds; a loaded machine may be later than that.
    for (let end = Date.now() + 20_000; heldByServer(client.localPort) && Date.now() < end; ) await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(heldByServer(client.localPort), false, "and no longer once it has given up");
  } finally {
    client.destroy();
  }
});

test("a stream of another site's page is refused, and the one of the portal's own is handed to the extension that takes it", async () => {
  const cookie = await signedIn();
  const foreign = upgrade({ Cookie: cookie, Origin: "https://elsewhere.example" });
  await until(() => foreign.text().includes("\r\n\r\n"), "an answer to another site's page");
  assert.match(foreign.text(), /^HTTP\/1\.1 403 /);
  foreign.socket.destroy();

  const mine = await opened({ Cookie: cookie, Origin: `http://127.0.0.1:${port}` });
  assert.match(mine.text(), /^HTTP\/1\.1 101 /);
  mine.socket.destroy();
});

test("behind a reverse proxy that rewrites Host, the page of the host it was asked for is accepted, and another site's still is not", async () => {
  const cookie = await signedIn();
  // Host is the portal's own address behind the proxy; the page's origin is what the visitor typed.
  const asked = { Cookie: cookie, "X-Forwarded-Host": "portal.example" };
  const mine = await opened({ ...asked, Origin: "https://portal.example" });
  assert.match(mine.text(), /^HTTP\/1\.1 101 /);
  mine.socket.destroy();

  // The default port of the scheme is the same host, and a list of proxies names the visitor's first.
  const withPort = await opened({ Cookie: cookie, "X-Forwarded-Host": "portal.example:443, inner.proxy:8080", Origin: "https://portal.example" });
  withPort.socket.destroy();

  for (const origin of ["https://elsewhere.example", "https://portal.example.elsewhere.example", "null"]) {
    const foreign = upgrade({ ...asked, Origin: origin });
    await until(() => foreign.text().includes("\r\n\r\n"), `an answer to ${origin}`);
    assert.match(foreign.text(), /^HTTP\/1\.1 403 /, origin);
    foreign.socket.destroy();
  }
  // A forwarded host that is no address does not stand for anything.
  const tricked = upgrade({ Cookie: cookie, "X-Forwarded-Host": "elsewhere.example@portal.example", Origin: "https://elsewhere.example" });
  await until(() => tricked.text().includes("\r\n\r\n"), "an answer to a made-up host");
  assert.match(tricked.text(), /^HTTP\/1\.1 403 /);
  tricked.socket.destroy();
  assert.equal((await api(cookie)).status, 200, "and the portal is still there");
});
