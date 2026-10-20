import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { inProcessHome } from "./server-harness.mjs";

// The server's WebSocket upgrades in one place (attachUpgrades): the login and the page a stream comes from asked
// once for every one, then each handed to what takes it, an extension's under its routes or one of the portal's own
// by the path it is under, and anything else answered and closed. The portal's own browser view is one of the
// latter; the tests of the login over the whole server (auth-browser, auth-streams) hold it there.
inProcessHome("pithagoras-upgrades-");
// A portal that runs without a login, chosen: every stream has one.
process.env.PORTAL_PASSWORD = "";
process.env.PORTAL_ALLOW_NO_PASSWORD = "1";
const { attachUpgrades } = await import("../dist/upgrades.js");

const taken = [];
const server = http.createServer();
attachUpgrades(server, {
  "/stand-in": (req, socket) => {
    taken.push(req.url);
    socket.end("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
  },
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
test.after(() => new Promise((resolve) => server.close(resolve)));

/** The first line of the answer to an upgrade asked for at `url`. */
function ask(url, headers = {}) {
  return new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1");
    let text = "";
    socket.on("data", (d) => (text += d));
    socket.on("error", () => {});
    socket.on("close", () => resolve(text.split("\r\n")[0]));
    const lines = [`GET ${url} HTTP/1.1`, `Host: 127.0.0.1:${port}`, "Connection: Upgrade", "Upgrade: websocket", ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`)];
    socket.write(`${lines.join("\r\n")}\r\n\r\n`);
  });
}

test("one of the portal's own takes the streams under its path, however the path is cased", async () => {
  for (const url of ["/stand-in", "/stand-in/socket", "/STAND-IN/socket", "/stand-in?x=1"]) {
    assert.equal(await ask(url), "HTTP/1.1 101 Switching Protocols", url);
  }
  assert.deepEqual(taken, ["/stand-in", "/stand-in/socket", "/STAND-IN/socket", "/stand-in?x=1"]);
});

test("a stream under no path that is taken is answered and closed, an extension's that is not there too", async () => {
  taken.length = 0;
  for (const url of ["/", "/stand-inx", "/api/sessions", "/api/x/nobody/socket"]) assert.equal(await ask(url), "HTTP/1.1 404 Not Found", url);
  assert.deepEqual(taken, []);
});

test("a page of another site does not open one", async () => {
  taken.length = 0;
  assert.equal(await ask("/stand-in/socket", { Origin: "https://elsewhere.example" }), "HTTP/1.1 403 Forbidden");
  assert.equal(await ask("/stand-in/socket", { Origin: `http://127.0.0.1:${port}` }), "HTTP/1.1 101 Switching Protocols");
  assert.deepEqual(taken, ["/stand-in/socket"]);
});
