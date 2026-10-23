import { mock, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { inProcessHome } from "../../../tests/helpers.mts";
import { startVoice } from "./portal.mts";
import { CONTAINER } from "./service.mts";

/**
 * Voice's server half in the portal's own extension host: it builds on Docker, starts only after it, and starts and
 * stops without waiting on Docker or touching the voice container. The container and the volume the portal made before
 * Voice was an extension are taken over by their names as it starts, and a running container whose network is no
 * longer the portal's is made again on it, with its engines and its card.
 */

const home = inProcessHome("pithagoras-voice-half-");
const { host, halves, docker, machine } = await startVoice();
const both = [halves.docker, halves.voice];

/** What Docker keeps of what each extension took over. */
const adopted = () => {
  const file = path.join(realpathSync(home), "extension-data", "pithagoras-docker", "adopted.json");
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { containers: {}, volumes: {} };
};
const until = async (done: () => boolean, what: string) => {
  for (const end = Date.now() + 30_000; Date.now() < end; ) {
    if (done()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`not ${what} in time`);
};
/** What the half says, as the portal's log has it, while `fn` runs and until `done` holds of it (or ten seconds have gone by), or for a second after. */
async function logged(fn: () => Promise<void>, done?: (said: string) => boolean): Promise<string> {
  const lines = mock.method(console, "log", () => {});
  const said = () => lines.mock.calls.map((call) => String(call.arguments[0])).join("\n");
  try {
    await fn();
    for (const end = Date.now() + (done ? 10_000 : 1_000); Date.now() < end && !done?.(said()); ) await new Promise((resolve) => setTimeout(resolve, 10));
    return said();
  } finally {
    lines.mock.restore();
  }
}
/** Voice's half started again, as Docker's update or switching it off and on does. */
const restart = async () => {
  await host.stopServerHalves();
  await host.syncServerHalves(both);
};
/** The voice container the portal made: labelled as the voice service, no extension's name on it, running on the portal's loopback and pinned to a card. */
const OLD = {
  Id: "c0ffee000000".padEnd(64, "0"),
  Labels: { "pithagoras.addon": "voice", "pithagoras.voice-network": "shared-v1", "pithagoras.voice-recipe": "breeze+whisper:base" },
  HostConfig: { NetworkMode: "container:portal-one", DeviceRequests: [{ Driver: "nvidia", Count: 0, DeviceIDs: ["GPU-648bf6c5-346e-81f5-f155-dc8061172da3"], Capabilities: [["gpu"]] }] },
  State: "running",
};
const VOLUME = "pithagoras_voice-models";

test("Voice's server half does not start without Docker, which it requires, and starts after it", async () => {
  await host.syncServerHalves([halves.voice]);
  assert.equal(host.isServing("pithagoras-voice"), false);
  assert.match(host.serverFailure("pithagoras-voice") ?? "", /It needs pithagoras-docker \(\^1\.2\.0\), which is not installed, or is switched off/);

  await host.syncServerHalves(both);
  assert.equal(host.serverFailure("pithagoras-voice"), undefined);
  assert.deepEqual([host.isServing("pithagoras-docker"), host.isServing("pithagoras-voice")], [true, true]);
});

test("as it starts, the container and the volume the portal made are taken over as they are: a current one is not made again", async () => {
  machine.reset();
  machine.putVoice(OLD);
  docker.volumes.push({ Name: VOLUME, Labels: null });
  await restart();
  await until(() => Object.keys(adopted().containers).length > 0, "taken over");
  assert.deepEqual(adopted(), { containers: { [OLD.Id]: "pithagoras-voice" }, volumes: { [VOLUME]: "pithagoras-voice" } });
  // And looked after: on the portal's loopback already, so nothing is made, started or stopped.
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(docker.containers.filter((c) => c.Name === CONTAINER).map(({ Id, State }) => ({ Id, State })), [{ Id: OLD.Id, State: "running" }]);
  assert.deepEqual([docker.created, docker.starts], [[], []]);
  assert.deepEqual(docker.volumes, [{ Name: VOLUME, Labels: null }]);

  // Every start: a record Docker lost is made again.
  const said = await logged(restart);
  assert.doesNotMatch(said, /could not take over/);
  assert.deepEqual(adopted().volumes, { [VOLUME]: "pithagoras-voice" });
});

test("as it starts, a container Voice made with no restart policy is given unless-stopped as it is: not made again, started or stopped", async () => {
  // As Voice made them until now, and as the one on friday is: Voice's own, running on the portal's loopback.
  machine.reset();
  machine.putVoice({ ...OLD, Labels: { ...OLD.Labels, "pithagoras.extension": "pithagoras-voice" }, HostConfig: { ...OLD.HostConfig, RestartPolicy: { Name: "no" } } });
  let stops = 0;
  docker.runs.onStop = (c) => { if (c.Name === CONTAINER) stops++; };
  await restart();
  await until(() => docker.updates.length > 0, "changed");
  assert.deepEqual(docker.updates, [{ name: CONTAINER, changes: { RestartPolicy: { Name: "unless-stopped" } } }]);
  assert.deepEqual((machine.voice()!.HostConfig as any).RestartPolicy, { Name: "unless-stopped" });
  // Looked after as well, which finds it as it is now: nothing more is changed, made, started or stopped.
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(docker.updates.length, 1);
  assert.deepEqual([machine.voice()!.Id, machine.voice()!.State, docker.created, docker.starts, stops], [OLD.Id, "running", [], [], 0]);
});

test("a running container on the portal's old container is made again on its new one as the half starts, with its engines and its card", async () => {
  machine.reset();
  machine.portalIs("portal-two");
  const was = "c0ffee111111".padEnd(64, "0");
  machine.putVoice({ ...OLD, Id: was });
  docker.volumes.push({ Name: VOLUME, Labels: null });
  await restart();
  await until(() => machine.made().length > 0 && machine.voice()?.State === "running", "made again");
  const made = machine.voice()!.made as any;
  assert.equal(made.HostConfig.NetworkMode, "container:portal-two");
  assert.deepEqual(made.HostConfig.DeviceRequests, [{ Driver: "nvidia", DeviceIDs: ["GPU-648bf6c5-346e-81f5-f155-dc8061172da3"], Capabilities: [["gpu"]] }]);
  assert.equal(made.Labels["pithagoras.voice-recipe"], "breeze+whisper:base");
  assert.equal(made.Labels["pithagoras.extension"], "pithagoras-voice");
  assert.equal(made.Labels["pithagoras.addon"], "voice", "a portal that goes back still knows it");
  assert.deepEqual(made.HostConfig.Binds, [`${VOLUME}:/voice`]);
  // The one taken over is let go of with it, and the volume is kept.
  await until(() => !(was in adopted().containers), "let go of");
  assert.deepEqual(docker.volumes.map((volume) => volume.Name), [VOLUME]);
  assert.deepEqual(docker.pulls, [], "no image is downloaded: the one it runs is there");
});

test("the half stops without stopping the voice container, and leaves it to the next start", async () => {
  await host.stopServerHalves();
  assert.equal(machine.voice()!.State, "running");
  await host.syncServerHalves(both);
  assert.equal(host.isServing("pithagoras-voice"), true);
});

test("none there is nothing to take over; one that is not the voice service's, or another extension's, is not Voice's to take, which is said", async () => {
  machine.reset();
  let said = await logged(restart);
  assert.doesNotMatch(said, /could not take over/);

  machine.putVoice({ Labels: {}, State: "running" });
  said = await logged(restart, (text) => /could not take over the voice container/.test(text));
  assert.match(said, /\[extension pithagoras-voice\] could not take over the voice container pithagoras-voice: The pithagoras-voice container is not the voice service's, so it is left alone/);
  assert.equal(machine.voice()!.Id in adopted().containers, false);

  machine.putVoice({ Labels: { "pithagoras.extension": "pithagoras-elsewhere", "pithagoras.addon": "voice" }, State: "running" });
  docker.volumes.push({ Name: VOLUME, Labels: { "pithagoras.extension": "pithagoras-elsewhere" } });
  said = await logged(restart, (text) => /could not take over the voice container/.test(text) && /downloads/.test(text));
  assert.match(said, /\[extension pithagoras-voice\] could not take over the voice service's downloads, the volume pithagoras_voice-models: pithagoras_voice-models is pithagoras-elsewhere's volume, not pithagoras-voice's/);
  assert.match(said, /could not take over the voice container pithagoras-voice/);
  assert.equal(machine.voice()!.Labels["pithagoras.extension"], "pithagoras-elsewhere");
  assert.deepEqual(docker.created, []);
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
    assert.equal(host.isServing("pithagoras-voice"), true);
    await until(() => asked > 0, "asked of Docker");
    assert.ok(Date.now() - began < 3000, `started in ${Date.now() - began} ms, Docker not answering`);
  } finally {
    process.env.DOCKER_SOCKET = fast;
    slow.closeAllConnections();
    slow.close();
    await restart();
  }
});
