import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import https from "node:https";
import net from "node:net";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { inProcessHome } from "../../../tests/helpers.mts";
import { serveBrowser } from "./portal.mts";

/**
 * The browser's own UI through the portal, at /api/x/pithagoras-browser/ui/: its page and its streams, signed into
 * with the browser's own password, which the portal holds, and without the portal's login, which stays with the
 * portal. That the login is asked first, of every stream, is the portal's (core's auth tests, on a stand-in).
 */
const home = inProcessHome("pithagoras-browser-proxy-");

// The browser, stood in for: an https server of its own, as the container is.
const tls = path.join(home, "tls");
mkdirSync(tls);
execFileSync("openssl", [
  "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-subj", "/CN=127.0.0.1",
  "-days", "1", "-keyout", path.join(tls, "key.pem"), "-out", path.join(tls, "cert.pem"),
], { stdio: "ignore" });
const seen = { requests: [] as { url?: string; headers: Record<string, unknown> }[], upgrades: [] as { url?: string; headers: Record<string, unknown> }[], received: "", mode: "accept" as "accept" | "refuse" | "slow", release: undefined as (() => void) | undefined, closed: undefined as Promise<unknown> | undefined };
const upstream = https.createServer({ key: readFileSync(path.join(tls, "key.pem")), cert: readFileSync(path.join(tls, "cert.pem")) }, (req, res) => {
  seen.requests.push({ url: req.url, headers: req.headers });
  res.writeHead(200, { "content-type": "text/plain", ...(req.url?.startsWith("/own-policy") ? { "content-security-policy": "default-src 'self'" } : {}) });
  res.end("the desktop");
});
upstream.on("upgrade", async (req, socket, head) => {
  seen.upgrades.push({ url: req.url, headers: req.headers });
  socket.on("error", () => {});
  seen.closed = new Promise((resolve) => socket.on("close", resolve));
  if (seen.mode === "refuse") return void socket.end("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n");
  if (seen.mode === "slow") await new Promise<void>((resolve) => (seen.release = resolve));
  seen.received = head.toString();
  socket.on("data", (d) => (seen.received += d));
  // The greeting follows the headers at once, as a VNC server's does.
  socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\nRFB 003.008\n");
});
upstream.listen(0, "127.0.0.1");
await new Promise((resolve) => upstream.once("listening", resolve));
after(() => upstream.close());
process.env.BROWSER_HTTPS_PORT = String((upstream.address() as AddressInfo).port);
process.env.BROWSER_USER = "agent";
process.env.BROWSER_PASSWORD = "the-browsers-own-password";

const browser = await serveBrowser();

const basic = (user: string, password: string) => "Basic " + Buffer.from(`${user}:${password}`).toString("base64");
const until = async (check: () => boolean, what: string) => {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  assert.fail(`never: ${what}`);
};
/** A request for the upgrade to a stream at `url` under Browser's routes, with `first` as the bytes the page sends first. */
function upgrade(url: string, headers: Record<string, string> = {}, first = "") {
  const socket = net.connect(browser.port, "127.0.0.1");
  let text = "";
  socket.on("data", (d) => (text += d));
  socket.on("error", () => {});
  const lines = [
    `GET /api/x/pithagoras-browser${url} HTTP/1.1`, `Host: 127.0.0.1:${browser.port}`, "Connection: Upgrade", "Upgrade: websocket",
    "Sec-WebSocket-Version: 13", "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
    ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
  ];
  // One write, so that what follows the headers arrives with them, as it does from a browser.
  socket.write(`${lines.join("\r\n")}\r\n\r\n${first}`);
  return { socket, text: () => text, closed: new Promise((resolve) => socket.once("close", resolve)) };
}

test("the page is the browser's, with the browser's own login added, the portal's left out, and framed only by the portal's pages", async () => {
  seen.requests.length = 0;
  const page = await fetch(`${browser.at}/ui/vnc.html?x=1`, { headers: { Cookie: "pithagoras=signed-in; other=1", Authorization: basic("someone", "else") } });
  assert.equal(page.status, 200);
  assert.equal(await page.text(), "the desktop");
  assert.equal(page.headers.get("content-security-policy"), "frame-ancestors 'self'");
  const [asked] = seen.requests;
  assert.equal(asked.url, "/vnc.html?x=1");
  assert.equal(asked.headers.authorization, basic("agent", "the-browsers-own-password"), "the client's own credentials are not passed on");
  assert.equal(asked.headers.cookie, undefined, "the portal's login stays with the portal");

  // The page's own address, with its slash, and a policy of the browser's own kept beside the portal's.
  assert.equal((await fetch(`${browser.at}/ui/`)).status, 200);
  assert.equal(seen.requests.at(-1)!.url, "/");
  const own = await fetch(`${browser.at}/ui/own-policy`);
  assert.equal(own.headers.get("content-security-policy"), "default-src 'self', frame-ancestors 'self'");
});

test("a password set on the Browser page is the one the page is opened with, at once", async () => {
  const saved = await fetch(`${browser.at}/config`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "set-here" }) });
  assert.deepEqual(await saved.json(), { user: "agent", hasPassword: true });
  try {
    await fetch(`${browser.at}/ui/`);
    assert.equal(seen.requests.at(-1)!.headers.authorization, basic("agent", "set-here"));
  } finally {
    const { putSettings } = await import("../src/server/store.ts");
    putSettings({ password: undefined });
  }
});

test("a browser that does not answer is said, as the page is asked for", async () => {
  const { putSettings } = await import("../src/server/store.ts");
  putSettings({ httpsPort: "1" });
  try {
    const page = await fetch(`${browser.at}/ui/`);
    assert.equal(page.status, 502);
    assert.match(await page.text(), /^The browser is not answering: /);
  } finally {
    putSettings({ httpsPort: undefined });
  }
});

test("its stream is passed on, each side's first bytes to the other, signed in with the browser's own login", async () => {
  seen.upgrades.length = 0;
  seen.mode = "accept";
  const mine = upgrade("/ui/websockify", { Cookie: "pithagoras=signed-in; other=1", Authorization: basic("someone", "else") }, "client-first");
  await until(() => mine.text().includes("RFB 003.008"), "the container's greeting reaching the page");
  assert.match(mine.text(), /^HTTP\/1\.1 101 /);
  await until(() => seen.received.includes("client-first"), "the page's first bytes reaching the container");
  assert.doesNotMatch(mine.text(), /client-first/, "not sent back to where they came from");
  assert.doesNotMatch(seen.received, /RFB/, "nor the container's");
  const [asked] = seen.upgrades;
  assert.equal(asked.url, "/websockify");
  assert.equal(asked.headers.authorization, basic("agent", "the-browsers-own-password"));
  assert.equal(asked.headers.cookie, undefined);
  mine.socket.destroy();
  await seen.closed;

  // The page's own stream, with a query and in other letters, as Express takes the route.
  const again = upgrade("/UI?token=1");
  await until(() => again.text().includes("RFB 003.008"), "the stream at the page's own address");
  assert.equal(seen.upgrades.at(-1)!.url, "/?token=1");
  again.socket.destroy();
  await seen.closed;
});

test("only the streams under /ui are the browser's: another is answered and closed", async () => {
  seen.upgrades.length = 0;
  for (const url of ["/state", "/uifoo", "/"]) {
    const stream = upgrade(url);
    await until(() => stream.text().includes("\r\n\r\n"), `an answer to ${url}`);
    assert.match(stream.text(), /^HTTP\/1\.1 404 /, url);
    await Promise.race([stream.closed, new Promise((_, reject) => setTimeout(() => reject(new Error(`${url} was left open`)), 3000))]);
  }
  assert.equal(seen.upgrades.length, 0, "and nothing went to the browser");
});

test("a stream the browser refuses is answered, not left waiting", async () => {
  seen.mode = "refuse";
  try {
    const stream = upgrade("/ui/websockify");
    await until(() => stream.text().includes("\r\n\r\n"), "an answer");
    assert.match(stream.text(), /^HTTP\/1\.1 401 /);
    stream.socket.destroy();
  } finally {
    seen.mode = "accept";
  }
});

test("a visitor who leaves during the handshake takes the request to the browser with them", async () => {
  seen.mode = "slow";
  seen.release = undefined;
  try {
    const stream = upgrade("/ui/websockify");
    await until(() => seen.release !== undefined, "the browser being asked");
    stream.socket.resetAndDestroy();
    await Promise.race([seen.closed, new Promise((_, no) => setTimeout(() => no(new Error("the browser is still being asked for a stream nobody is waiting for")), 3000))]);
  } finally {
    seen.release?.();
    seen.mode = "accept";
  }
});
