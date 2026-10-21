import { before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { freePort, inProcessHome, serverEnv, startServer, testHome } from "./server-harness.mjs";

/**
 * What the login's tests share. They are in several files because one file is one test to the runner, which gives
 * it a time of its own to end in (`--test-timeout`): a file of thirty-odd tests, most of them starting a server, came
 * to that limit on a slow machine and failed without an error of its own. Each file imports this and gets its own
 * home, its own process, and a portal of its own where it asks for one (`sharedPortal`).
 */
export const PASSWORD = "correct horse battery";
export const SECRET = "a-fixed-secret-for-the-tests";
export const home = testHome("pithagoras-auth-");

// The same login in this process, on the server's own database, to make the cookies a server would not
// hand out: one that has run out. The password is moved in from the environment, as a server does it.
inProcessHome("pithagoras-auth-in-process-", home);
process.env.PORTAL_PASSWORD = PASSWORD;
process.env.PORTAL_SECRET = SECRET;
export const auth = await import("../dist/auth.js");
export const security = await import("../dist/http-security.js");
export const kept = await import("../dist/password.js");

/** What `issueCookie` sets, taken from a response that is only listening. */
export function issued({ secure = false } = {}) {
  let cookie;
  auth.issueCookie({ cookie: (name, value, options) => { cookie = { name, value, options }; }, req: { secure } });
  return cookie;
}

// --- a certificate, for a portal that speaks TLS itself ---

export const tls = path.join(home, "tls");
mkdirSync(tls);
execFileSync("openssl", [
  "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-subj", "/CN=127.0.0.1",
  "-days", "1", "-keyout", path.join(tls, "key.pem"), "-out", path.join(tls, "cert.pem"),
], { stdio: "ignore" });

// --- an extension's streams, stood in for: what the login holds every stream to ---

/** Where the stand-in takes streams, under its routes: what `upgrade` asks for unless told another. */
export const STREAM = "/api/x/test-streams/stream";

/**
 * An extension installed in `at` whose server half takes streams under its routes (`portal.http.upgrade`), greets each
 * at once, as a VNC server does, and sends back what it is sent: the portal asks for the login and checks the page a
 * stream comes from before any extension is asked, and ends a stream with the login it was opened under. pi, as far
 * as the portal asks it which packages there are, lists it. Returns what the portal is started with, to find that pi.
 */
export function withStreams(at) {
  const pkg = path.join(at, "packages", "streams");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "test-streams", version: "1.0.0", pi: {}, pithagoras: { server: "./server.js" } }));
  writeFileSync(
    path.join(pkg, "server.js"),
    `export default function (portal) {
  portal.http.upgrade((req, socket) => {
    socket.on("error", () => {});
    if (req.url !== "/stream") return void socket.end("HTTP/1.1 404 Not Found\\r\\nContent-Length: 0\\r\\n\\r\\n");
    socket.write("HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\n\\r\\nRFB 003.008\\n");
    socket.on("data", (d) => socket.write(d));
  });
}
`,
  );
  const bin = path.join(at, "fake-bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(path.join(bin, "pi"), `#!/bin/bash\n[ "$1" = list ] || exit 0\nprintf 'User packages:\\n  npm:test-streams\\n    ${pkg}\\n'\n`);
  chmodSync(path.join(bin, "pi"), 0o755);
  mkdirSync(path.join(at, "agent"), { recursive: true });
  writeFileSync(path.join(at, "agent", "settings.json"), JSON.stringify({ packages: ["npm:test-streams"] }));
  return { PATH: `${bin}${path.delimiter}${process.env.PATH}` };
}

/**
 * The portal the file's tests share, started before the first of them: `base`, `port` and `server` are set once it
 * listens. Called by a file that has tests against it; the others start portals of their own (`portalOf`).
 */
export let base;
export let port;
export let server;
export function sharedPortal() {
  before(async () => {
    ({ base, child: server, port } = await startServer(serverEnv(home, await freePort(), {
      PORTAL_PASSWORD: PASSWORD, PORTAL_ALLOW_NO_PASSWORD: "", PORTAL_SECRET: SECRET, ...withStreams(home),
    })));
  });
}

export const login = (password = PASSWORD, at = base) =>
  fetch(`${at}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password }) });
/** The cookie a login set, as a request header. */
export const cookieOf = (res) => (res.headers.getSetCookie()[0] ?? "").split(";")[0];
export const signedIn = async () => cookieOf(await login());
export const api = (cookie, route = "/api/settings") => fetch(base + route, { headers: cookie ? { Cookie: cookie } : {} });

// --- choosing, changing and moving the password ---

/** Reads the JSON of a response; the status is for the caller's own assert. */
export const post = (at, route, body, cookie) =>
  fetch(`${at}${route}`, { method: "POST", headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body) });
export const statusAt = async (at, cookie) => (await fetch(`${at}/api/auth/status`, { headers: cookie ? { Cookie: cookie } : {} })).json();
export const settingsAt = (at, cookie) => fetch(`${at}/api/settings`, { headers: cookie ? { Cookie: cookie } : {} });

/** A portal of its own, in a home of its own unless one is given: for the tests that change what the shared one must keep. */
export async function portalOf(overrides = {}, at = testHome("pithagoras-auth-own-")) {
  const started = await startServer(serverEnv(at, await freePort(), { PORTAL_PASSWORD: "", PORTAL_ALLOW_NO_PASSWORD: "", PORTAL_SECRET: SECRET, ...overrides }));
  // Safe to call again once it has stopped: a test stops it where it restarts, and its `finally` does too.
  const stop = async () => {
    if (started.child.exitCode !== null || started.child.signalCode !== null) return;
    started.child.kill();
    await new Promise((resolve) => started.child.once("exit", resolve));
  };
  return { ...started, home: at, stop };
}

const RESET = fileURLToPath(new URL("../dist/reset-password.js", import.meta.url));
/** Runs the command that removes a lost password on `at`'s data, answering what it asks with `input`. */
export function resetPassword(at, input, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [RESET], { env: serverEnv(at, 0, { PORTAL_ALLOW_NO_PASSWORD: "", ...env }), stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { out += d; });
    child.on("close", (code) => resolve({ code, out }));
    child.stdin.end(input);
  });
}

/** A stream open on a portal, read in the background: `ended` says whether the portal has closed it. */
export async function openStream(at, cookie, route, method = "GET") {
  const res = await fetch(`${at}${route}`, { method, headers: { Cookie: cookie } });
  assert.equal(res.status, 200, route);
  const stream = { ended: false };
  (async () => {
    try { for await (const chunk of res.body) void chunk; } catch { /* reset */ }
    stream.ended = true;
  })();
  return stream;
}
// The command that removes a password is another process: the portal finds out on a timer of two seconds.
export const ends = async (stream, what) => {
  for (let end = Date.now() + 10_000; !stream.ended && Date.now() < end; ) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(stream.ended, true, `${what} was not ended`);
};
export const staysOpen = async (stream, what) => {
  await new Promise((resolve) => setTimeout(resolve, 3000));
  assert.equal(stream.ended, false, what);
};

// --- streams ---

/** A request for the upgrade to a stream, as a browser makes it, with `after` as the bytes the page sends first. */
export function upgrade(headers = {}, after = "", url = STREAM, at = port) {
  const socket = net.connect(at, "127.0.0.1");
  let text = "";
  socket.on("data", (d) => { text += d; });
  // Refused and closed on is what some of these are about; the answer is what is read.
  socket.on("error", () => {});
  const lines = [
    `GET ${url} HTTP/1.1`, `Host: 127.0.0.1:${at}`, "Connection: Upgrade", "Upgrade: websocket",
    "Sec-WebSocket-Version: 13", "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
    ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
  ];
  // One write, so that what follows the headers arrives with them, as it does from a browser.
  socket.write(`${lines.join("\r\n")}\r\n\r\n${after}`);
  const closed = new Promise((resolve) => socket.once("close", resolve));
  return { socket, text: () => text, closed };
}
export const until = async (check, what) => {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 30));
  }
  assert.fail(`never: ${what}`);
};
export const basic = (user, password) => "Basic " + Buffer.from(`${user}:${password}`).toString("base64");

/**
 * A stream of the stand-in's opened on the portal at `at`, once its server half, which starts after the portal
 * listens, takes it: asked again until it is.
 */
export async function opened(headers, at = port) {
  for (let i = 0; i < 100; i++) {
    const stream = upgrade(headers, "", STREAM, at);
    await until(() => stream.text().includes("\r\n\r\n"), "an answer");
    if (/^HTTP\/1\.1 101 /.test(stream.text())) {
      await until(() => stream.text().includes("RFB 003.008"), "the greeting");
      return stream;
    }
    stream.socket.destroy();
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail("the stand-in's server half never took a stream");
}
