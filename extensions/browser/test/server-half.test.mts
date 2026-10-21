import { mock, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { inProcessHome } from "../../../tests/helpers.mts";
import { startBrowser } from "./portal.mts";

/**
 * Browser's server half in the portal's own extension host: it builds on Docker, starts only after it, and starts and
 * stops without waiting on Docker or touching the browser. The container and the profile the portal made before
 * Browser was an extension are taken over by their names as it starts, never made again.
 */

const home = inProcessHome("pithagoras-browser-half-");
const { host, halves, docker } = await startBrowser();
const both = [halves.docker, halves.browser];

/** What Docker keeps of what each extension took over. */
const adopted = () => {
  const file = path.join(realpathSync(home), "extension-data", "pithagoras-docker", "adopted.json");
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { containers: {}, volumes: {} };
};
const until = async (done: () => boolean, what: string) => {
  for (let n = 0; n < 200; n++) {
    if (done()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`not ${what} in time`);
};
/** What the half says, as the portal's log has it, while `fn` runs and until `done` holds of it (or a second has gone by). */
async function logged(fn: () => Promise<void>, done: (said: string) => boolean = () => false): Promise<string> {
  const lines = mock.method(console, "log", () => {});
  const said = () => lines.mock.calls.map((call) => String(call.arguments[0])).join("\n");
  try {
    await fn();
    for (let n = 0; n < 100 && !done(said()); n++) await new Promise((resolve) => setTimeout(resolve, 10));
    return said();
  } finally {
    lines.mock.restore();
  }
}
/** Browser's half started again, as Docker's update or switching it off and on does. */
const restart = async () => {
  await host.stopServerHalves();
  await host.syncServerHalves(both);
};

/** The container the portal made before Browser was an extension: no extension's name on it, and running. */
const OLD = { Id: "825eb3e279a0".padEnd(64, "0"), Name: "pithagoras-browser", Image: "lscr.io/linuxserver/chromium:latest", State: "running", Labels: { build_version: "linuxserver" }, Tty: false, out: "", err: "" };

test("Browser's server half does not start without Docker, which it requires, and starts after it", async () => {
  await host.syncServerHalves([halves.browser]);
  assert.equal(host.isServing("pithagoras-browser"), false);
  assert.match(host.serverFailure("pithagoras-browser") ?? "", /It needs pithagoras-docker \(\^1\.0\.0\), which is not installed, or is switched off/);

  await host.syncServerHalves(both);
  assert.equal(host.serverFailure("pithagoras-browser"), undefined);
  assert.deepEqual([host.isServing("pithagoras-docker"), host.isServing("pithagoras-browser")], [true, true]);
});

test("as it starts, the container and the profile the portal made are taken over as they are: nothing is made again, or started", async () => {
  docker.containers.push({ ...OLD });
  docker.volumes.push({ Name: "pithagoras_browser-profile", Labels: null });
  await restart();
  await until(() => Object.keys(adopted().containers).length > 0, "taken over");
  assert.deepEqual(adopted(), { containers: { [OLD.Id]: "pithagoras-browser" }, volumes: { "pithagoras_browser-profile": "pithagoras-browser" } });
  assert.deepEqual(docker.containers.map(({ Id, State, made }) => ({ Id, State, made })), [{ Id: OLD.Id, State: "running", made: undefined }], "the same container, running, never made");
  assert.deepEqual(docker.starts, []);
  assert.deepEqual(docker.volumes, [{ Name: "pithagoras_browser-profile", Labels: null }]);

  // Every start: a record Docker lost is made again.
  const said = await logged(restart);
  assert.doesNotMatch(said, /could not take over/);
  assert.deepEqual(adopted().volumes, { "pithagoras_browser-profile": "pithagoras-browser" });
});

test("the half stops without stopping the browser, and leaves it to the next start", async () => {
  await host.stopServerHalves();
  assert.deepEqual(docker.containers.map(({ Id, State }) => ({ Id, State })), [{ Id: OLD.Id, State: "running" }]);
  await host.syncServerHalves(both);
  assert.equal(host.isServing("pithagoras-browser"), true);
});

test("none there is nothing to take over, and another extension's is not Browser's to take, which is said", async () => {
  docker.containers.length = 0;
  docker.volumes.length = 0;
  let said = await logged(restart);
  assert.doesNotMatch(said, /could not take over/);

  docker.containers.push({ ...OLD, Id: "other".padEnd(64, "0"), Labels: { "pithagoras.extension": "pithagoras-elsewhere" } });
  docker.volumes.push({ Name: "pithagoras_browser-profile", Labels: { "pithagoras.extension": "pithagoras-elsewhere" } });
  said = await logged(restart, (text) => /could not take over the browser's container/.test(text));
  assert.match(said, /\[extension pithagoras-browser\] could not take over the browser's profile, the volume pithagoras_browser-profile: pithagoras_browser-profile is pithagoras-elsewhere's volume, not pithagoras-browser's/);
  assert.match(said, /\[extension pithagoras-browser\] could not take over the browser's container pithagoras-browser: pithagoras-browser is pithagoras-elsewhere's container, not pithagoras-browser's/);
  assert.equal(docker.containers[0].Labels["pithagoras.extension"], "pithagoras-elsewhere");
});

test("a start does not wait for a Docker that is slow to answer", async () => {
  // A daemon that answers that it is there, and holds every other question: Docker's requests may take 30 seconds,
  // and a half has 15 to start.
  let asked = 0;
  const slow = http.createServer((req) => {
    if (req.url === "/_ping") return void req.socket.end("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nOK");
    asked++;
  });
  const socket = path.join(docker.dir, "slow.sock");
  await new Promise<void>((resolve) => slow.listen(socket, resolve));
  const fast = process.env.DOCKER_SOCKET;
  process.env.DOCKER_SOCKET = socket;
  try {
    await host.stopServerHalves();
    const began = Date.now();
    await host.syncServerHalves(both);
    assert.equal(host.isServing("pithagoras-browser"), true);
    await until(() => asked > 0, "asked of Docker");
    assert.ok(Date.now() - began < 3000, `started in ${Date.now() - began} ms, Docker not answering`);
  } finally {
    process.env.DOCKER_SOCKET = fast;
    slow.closeAllConnections();
    slow.close();
    await restart();
  }
});
