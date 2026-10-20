import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { inProcessHome } from "./server-harness.mjs";

// The server's WebSocket upgrades in one place (attachUpgrades). The tests of the login over the whole server
// (auth-browser, auth-streams) hold the portal's own streams there; this holds what none of them asks: a stream under
// an extension's routes that no extension takes is answered and closed once the login lets it through.
inProcessHome("pithagoras-upgrades-");
// A portal that runs without a login, chosen: every stream has one.
process.env.PORTAL_PASSWORD = "";
process.env.PORTAL_ALLOW_NO_PASSWORD = "1";
const { attachUpgrades } = await import("../dist/upgrades.js");

const server = http.createServer();
attachUpgrades(server);
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
test.after(() => new Promise((resolve) => server.close(resolve)));

/** The first line of the answer to an upgrade asked for at `url`. */
function ask(url) {
  return new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1");
    let text = "";
    socket.on("data", (d) => (text += d));
    socket.on("error", () => {});
    socket.on("close", () => resolve(text.split("\r\n")[0]));
    socket.write(`GET ${url} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`);
  });
}

test("a stream of an extension that is not there is answered and closed after the login", async () => {
  assert.equal(await ask("/api/x/nobody/socket"), "HTTP/1.1 404 Not Found");
});
