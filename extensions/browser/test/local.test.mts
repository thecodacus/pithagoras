import { after, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { inProcessHome } from "../../../tests/helpers.mts";
import { serveBrowser } from "./portal.mts";

/**
 * Without Docker (no socket, as a portal run from source has), the browser is the machine's own Chrome, with its
 * profile in Browser's own folder in the portal's data folder, so that its logins outlive a restart; and a Chrome that
 * already answers on the debugging port, as the one a half started before a restart does, is not started again.
 */
const home = inProcessHome("pithagoras-browser-local-");
// A Chrome that only says what it was started with.
const started = path.join(home, "started.txt");
const binary = path.join(home, "chrome");
writeFileSync(binary, `#!/bin/sh\necho "$@" > ${JSON.stringify(started)}\n`);
chmodSync(binary, 0o755);
process.env.BROWSER_BINARY = binary;
delete process.env.BROWSER_EXTERNAL;
// What answers on the debugging port, when a test says one does.
let answering = false;
const cdp = http.createServer((_req, res) => (answering ? res.end(JSON.stringify({ Browser: "Chrome/141.0.0.0" })) : res.writeHead(404).end()));
cdp.listen(0, "127.0.0.1");
await new Promise((resolve) => cdp.once("listening", resolve));
after(() => cdp.close());
process.env.BROWSER_CDP_URL = `http://127.0.0.1:${(cdp.address() as AddressInfo).port}`;

const browser = await serveBrowser();
// Docker is installed, and finds no socket.
process.env.DOCKER_SOCKET = path.join(home, "no-docker.sock");
const install = async () => (await fetch(`${browser.at}/state`)).json().then((state) => state.install);

test("the machine's own Chrome is started with its profile in Browser's folder, on the debugging port", async () => {
  assert.deepEqual(await install(), { available: true, mode: "local", image: true, container: "stopped", binary, headless: !process.env.DISPLAY, pulling: { active: false, line: "" } });
  const res = await fetch(`${browser.at}/install`, { method: "POST" });
  assert.deepEqual(await res.json(), { ok: true });
  for (let n = 0; n < 100 && !existsSync(started); n++) await new Promise((resolve) => setTimeout(resolve, 10));
  const args = readFileSync(started, "utf8").trim().split(" ");
  assert.ok(args.includes(`--user-data-dir=${path.join(browser.data, "profile")}`), args.join(" "));
  assert.ok(args.includes("--remote-debugging-port=9222"));
  assert.ok(existsSync(path.join(browser.data, "profile")));
});

test("one that answers on the debugging port already is the browser: running, and not started a second time", async () => {
  rmSync(started, { force: true });
  answering = true;
  try {
    assert.equal((await install()).container, "running");
    assert.deepEqual(await (await fetch(`${browser.at}/start`, { method: "POST" })).json(), { ok: true });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(existsSync(started), false, "no second Chrome on the same profile and port");
  } finally {
    answering = false;
  }
});
