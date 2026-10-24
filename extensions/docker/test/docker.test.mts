import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import net, { type AddressInfo } from "node:net";
import express from "express";
import { fakeDocker, type FakeContainer } from "./fake-docker.ts";
import type { Docker } from "../src/api.ts";

// Docker for the extensions that build on it (src/docker.ts), against a daemon of the tests' own on a socket.
const docker = await fakeDocker();
process.env.DOCKER_SOCKET = docker.socket;
const { dockerFor, OWNER_LABEL, sharedNetwork } = await import("../src/docker.ts");
const { demux, pull, request } = await import("../src/engine.ts");
const { FORWARD_SCRIPT, FORWARDER_IMAGE } = await import("../src/forward.ts");
const { default: serverHalf } = await import("../src/server.ts");
test.after(() => docker.close());

const dataDir = () => mkdtempSync(path.join(os.tmpdir(), "dk-data-"));

test("an extension's containers carry its name, and it lists, starts, stops and removes its own, and no other's", async () => {
  const { forExtension } = dockerFor(dataDir());
  const browser = forExtension("pithagoras-browser");
  const voice = forExtension("pithagoras-voice");
  assert.equal(await browser.available(), true);
  const made = await browser.containers.create("dk-chromium", { Image: "chromium:1", Labels: { keep: "this" } });
  assert.deepEqual([made.name, made.owner, made.state], ["dk-chromium", "pithagoras-browser", "created"]);
  assert.deepEqual(docker.containers.find((c) => c.Name === "dk-chromium")!.Labels, { keep: "this", [OWNER_LABEL]: "pithagoras-browser" }, "its own labels kept, its name added");
  assert.deepEqual(made.labels, { keep: "this", [OWNER_LABEL]: "pithagoras-browser" }, "and it reads them back");
  assert.deepEqual((await browser.containers.list())[0]?.labels, { keep: "this", [OWNER_LABEL]: "pithagoras-browser" });
  await voice.containers.create("dk-voice", { Image: "voice:1" });
  assert.deepEqual((await browser.containers.list()).map((c) => c.name), ["dk-chromium"]);
  await browser.containers.start("dk-chromium");
  assert.equal((await browser.containers.get("dk-chromium"))!.state, "running");
  // Another's is not its to touch, nor to make anew under the same name.
  for (const touch of [() => voice.containers.stop("dk-chromium"), () => voice.containers.remove("dk-chromium"), () => voice.containers.logs("dk-chromium"), () => voice.containers.create("dk-chromium", { Image: "x" })]) {
    await assert.rejects(touch(), /dk-chromium is pithagoras-browser's container, not pithagoras-voice's/);
  }
  assert.equal((await voice.containers.get("dk-chromium"))!.owner, "pithagoras-browser", "but it may see whose it is");
  // Its own made again under the same name: the old one goes first.
  const again = await browser.containers.create("dk-chromium", { Image: "chromium:2" });
  assert.equal(again.image, "chromium:2");
  assert.equal(docker.containers.filter((c) => c.Name === "dk-chromium").length, 1);
  await browser.containers.remove("dk-chromium");
  await browser.containers.remove("dk-chromium");
  assert.equal(await browser.containers.get("dk-chromium"), undefined, "gone, and gone again is no error");
  await voice.containers.remove("dk-voice");
  await assert.rejects(browser.containers.create("../up", { Image: "x" }), /is not a name Docker takes/);
});

test("a container nobody's is no extension's until one takes it over, kept by its id, and lets go of it when it is removed", async () => {
  const dir = dataDir();
  const { forExtension } = dockerFor(dir);
  docker.containers.push({ Id: "old0000000000", Name: "pithagoras-browser", Image: "chromium:old", State: "running", Labels: {}, Tty: false, out: "", err: "" });
  const browser = forExtension("pithagoras-browser");
  const other = forExtension("someone-else");
  await assert.rejects(browser.containers.stop("pithagoras-browser"), /is no extension's container: take it over first \(adopt\)/);
  await assert.rejects(browser.containers.create("pithagoras-browser", { Image: "x" }), /take it over first/);
  const taken = await browser.containers.adopt("pithagoras-browser");
  assert.equal(taken.owner, "pithagoras-browser");
  await assert.rejects(other.containers.adopt("pithagoras-browser"), /is pithagoras-browser's container, not someone-else's/);
  // Kept where the extension keeps its things: so after a restart too.
  const after = dockerFor(dir).forExtension("pithagoras-browser");
  assert.deepEqual((await after.containers.list()).map((c) => c.name), ["pithagoras-browser"]);
  await after.containers.stop("pithagoras-browser");
  // Made anew by the extension that took it over: the old one goes, and is let go of where it was kept.
  await after.containers.create("pithagoras-browser", { Image: "chromium:2" });
  assert.deepEqual(JSON.parse(readFileSync(path.join(dir, "adopted.json"), "utf8")).containers, {}, "the old id is not kept");
  assert.equal((await after.containers.get("pithagoras-browser"))!.owner, "pithagoras-browser", "the new one is its own by its label");
  // Made again by somebody else under the same name: another container, and nobody's.
  await after.containers.remove("pithagoras-browser");
  docker.containers.push({ Id: "new0000000000", Name: "pithagoras-browser", Image: "chromium:new", State: "running", Labels: {}, Tty: false, out: "", err: "" });
  assert.equal((await after.containers.get("pithagoras-browser"))!.owner, "");
  docker.containers.splice(docker.containers.findIndex((c) => c.Id === "new0000000000"), 1);
});

test("an image is downloaded once when it is not there, whoever asks, with how it goes told; Docker's own failure is the error", async () => {
  const { forExtension } = dockerFor(dataDir());
  const a = forExtension("a"), b = forExtension("b");
  const told: string[] = [];
  await Promise.all([a.images.ensure("chromium:1", (s) => told.push(s.line)), b.images.ensure("chromium:1")]);
  assert.deepEqual(docker.pulls.filter((p) => p === "chromium:1"), ["chromium:1"], "one download for both");
  assert.deepEqual(told, ["starting", "Pulling from chromium:1", "Downloading [=====>   ] 5MB/10MB", "Downloaded newer image", "done"]);
  await a.images.ensure("chromium:1");
  assert.equal(docker.pulls.filter((p) => p === "chromium:1").length, 1, "there already: not downloaded again");
  assert.equal(await a.images.present("chromium:1"), true);
  docker.failing.set("broken:1", "manifest for broken:1 not found");
  const states: { error?: string }[] = [];
  await assert.rejects(a.images.ensure("broken:1", (s) => states.push(s)), /manifest for broken:1 not found/);
  assert.equal(states.at(-1)!.error, "manifest for broken:1 not found");
  // A registry's port is not taken for a tag.
  await a.images.ensure("registry.local:5000/tools/chromium");
  assert.ok(docker.pulls.includes("registry.local:5000/tools/chromium:latest"));
});

test("what a container wrote is its output and its errors as text, from Docker's frames or as a terminal wrote it", async () => {
  const { forExtension } = dockerFor(dataDir());
  const own = forExtension("a");
  await own.containers.create("dk-logs", { Image: "x" });
  Object.assign(docker.containers.find((c) => c.Name === "dk-logs")!, { out: "started\nlistening on 9222\n", err: "a warning\n" });
  assert.equal(await own.containers.logs("dk-logs"), "started\nlistening on 9222\na warning\n");
  await own.containers.create("dk-tty", { Image: "x", Tty: true });
  Object.assign(docker.containers.find((c) => c.Name === "dk-tty")!, { out: "raw text" });
  assert.equal(await own.containers.logs("dk-tty"), "raw text");
  await own.containers.remove("dk-logs");
  await own.containers.remove("dk-tty");
  // A frame cut short at the end gives what came of it, and nothing past the end is read.
  assert.equal(demux(Buffer.from([1, 0, 0, 0, 0, 0, 0, 9, 104, 105]), false), "hi");
});

test("an extension reads how its own containers were made and how they stand, and those it took over, and not another's", async () => {
  const { forExtension } = dockerFor(dataDir());
  const voice = forExtension("pithagoras-voice"), other = forExtension("someone-else");
  await voice.containers.create("dk-inspect", {
    Image: "voice:1",
    Env: ["VOICE_TTS=breeze"],
    Cmd: ["bash", "-c", "serve"],
    HostConfig: { NetworkMode: "host", DeviceRequests: [{ Driver: "nvidia", DeviceIDs: ["GPU-1"], Capabilities: [["gpu"]] }], RestartPolicy: { Name: "no" } },
  });
  const made = (await voice.containers.inspect("dk-inspect")) as any;
  assert.deepEqual([made.Config.Env, made.Config.Cmd, made.Config.Labels[OWNER_LABEL]], [["VOICE_TTS=breeze"], ["bash", "-c", "serve"], "pithagoras-voice"]);
  assert.equal(made.HostConfig.NetworkMode, "host");
  assert.deepEqual(made.HostConfig.DeviceRequests[0].DeviceIDs, ["GPU-1"]);
  assert.deepEqual([made.State.Running, made.State.ExitCode], [false, 0]);
  Object.assign(docker.containers.find((c) => c.Name === "dk-inspect")!, { State: "exited", code: 1, error: "could not select device driver" });
  const ended = (await voice.containers.inspect("dk-inspect")) as any;
  assert.deepEqual([ended.State.Status, ended.State.ExitCode, ended.State.Error], ["exited", 1, "could not select device driver"]);
  await assert.rejects(other.containers.inspect("dk-inspect"), { status: 403, message: /dk-inspect is pithagoras-voice's container, not someone-else's/ });
  assert.equal(await voice.containers.inspect("dk-none"), undefined, "nothing where there is none");
  // One the portal made before its app was an extension: nobody's until it is taken over, then read as one's own.
  docker.containers.push({ Id: "core000000000", Name: "dk-core-made", Image: "voice:old", State: "running", Labels: { "pithagoras.addon": "voice" }, Tty: true, out: "", err: "", HostConfig: { NetworkMode: "container:old-portal", DeviceRequests: [{ DeviceIDs: ["GPU-2"] }] } });
  await assert.rejects(voice.containers.inspect("dk-core-made"), { status: 403, message: /take it over first/ });
  await voice.containers.adopt("dk-core-made");
  const adopted = (await voice.containers.inspect("dk-core-made")) as any;
  assert.deepEqual([adopted.Id, adopted.HostConfig.NetworkMode, adopted.HostConfig.DeviceRequests[0].DeviceIDs], ["core000000000", "container:old-portal", ["GPU-2"]]);
  await voice.containers.remove("dk-core-made");
  await voice.containers.remove("dk-inspect");
});

test("an extension changes its own container as it is, running, without its being made again or restarted; not another's, nor one there is none of", async () => {
  const { forExtension } = dockerFor(dataDir());
  const voice = forExtension("pithagoras-voice"), other = forExtension("someone-else");
  await voice.containers.create("dk-update", { Image: "voice:1", HostConfig: { NetworkMode: "host", RestartPolicy: { Name: "no" } } });
  await voice.containers.start("dk-update");
  const [made, started] = [docker.created.length, docker.starts.length];
  await voice.containers.update("dk-update", { RestartPolicy: { Name: "unless-stopped" } });
  assert.deepEqual(docker.updates.at(-1), { name: "dk-update", changes: { RestartPolicy: { Name: "unless-stopped" } } }, "Docker's own update, with the body as it was given");
  const changed = (await voice.containers.inspect("dk-update")) as any;
  assert.deepEqual(changed.HostConfig.RestartPolicy, { Name: "unless-stopped" });
  assert.equal(changed.HostConfig.NetworkMode, "host", "what the change does not name stays");
  assert.equal(changed.State.Running, true);
  assert.deepEqual([docker.created.length, docker.starts.length], [made, started], "neither made again nor started again");
  const updates = docker.updates.length;
  await assert.rejects(other.containers.update("dk-update", { RestartPolicy: { Name: "no" } }), { status: 403, message: /dk-update is pithagoras-voice's container, not someone-else's/ });
  await assert.rejects(voice.containers.update("dk-none", { RestartPolicy: { Name: "no" } }), { status: 404, message: /There is no container dk-none/ });
  assert.equal(docker.updates.length, updates, "neither reached Docker");
  await voice.containers.remove("dk-update");
});

test("an extension runs a command in its own running container, with the environment, folder and terminal asked for, and reads what it wrote and its exit code; not in another's, nor in one that is not running", async () => {
  const { forExtension } = dockerFor(dataDir());
  const own = forExtension("pithagoras-understory"), other = forExtension("someone-else");
  const made = await own.containers.create("dk-exec", { Image: "understory:1" });
  docker.runs.onExec = (e) => ({ out: `ran ${e.Cmd.join(" ")}\n`, err: "a warning\n", code: 3 });
  try {
    await assert.rejects(own.containers.exec("dk-exec", ["true"]), { status: 409, message: /is not running/ });
    await own.containers.start("dk-exec");
    const ran = await own.containers.exec("dk-exec", ["node", "-e", "write()"], { env: { PORTAL_INPUT: "e30=" }, workingDir: "/app/server" });
    assert.deepEqual(ran, { output: "ran node -e write()\na warning\n", exitCode: 3, timedOut: false });
    const asked = docker.execs.at(-1)!;
    assert.deepEqual([asked.ContainerID, asked.Env, asked.WorkingDir, asked.Tty], [made.id, ["PORTAL_INPUT=e30="], "/app/server", false]);
    // With a terminal: as it was written.
    docker.runs.onExec = () => ({ out: "\x1b[32mok\x1b[0m\n" });
    assert.deepEqual(await own.containers.exec("dk-exec", ["ls"], { tty: true }), { output: "\x1b[32mok\x1b[0m\n", exitCode: 0, timedOut: false });
    assert.equal(docker.execs.at(-1)!.Tty, true);
    const asks = docker.execs.length;
    await assert.rejects(other.containers.exec("dk-exec", ["true"]), { status: 403, message: /dk-exec is pithagoras-understory's container, not someone-else's/ });
    await assert.rejects(own.containers.exec("dk-none", ["true"]), { status: 404, message: /There is no container dk-none/ });
    assert.equal(docker.execs.length, asks, "nothing is run where it is refused");
    // Stopped after the command was made, before it started: Docker refuses it at the start.
    docker.runs.onExecCreate = (c) => (c.State = "exited");
    await assert.rejects(own.containers.exec("dk-exec", ["true"]), { status: 409, message: /is not running/ });
  } finally {
    docker.runs.onExecCreate = undefined;
    docker.runs.onExec = undefined;
    await own.containers.remove("dk-exec");
  }
});

test("a command that does not end in time is given up on with what it wrote by then, not as a failure; with no limit it waits past the 30 s a request is given", async (t) => {
  const { forExtension } = dockerFor(dataDir());
  const own = forExtension("a");
  await own.containers.create("dk-slow", { Image: "x" });
  await own.containers.start("dk-slow");
  docker.runs.onExec = () => ({ out: "working\n" });
  let end!: () => void;
  docker.hold.exec = new Promise((resolve) => (end = resolve));
  try {
    assert.deepEqual(await own.containers.exec("dk-slow", ["dream"], { timeoutMs: 100 }), { output: "working\n", exitCode: null, timedOut: true });
    assert.equal(docker.execs.at(-1)!.Running, true, "it may still be running in the container");
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const asks = docker.execs.length;
    let settled = false;
    const going = own.containers.exec("dk-slow", ["dream"]);
    void going.finally(() => (settled = true)).catch(() => {});
    while (!(docker.execs.length > asks && docker.execs.at(-1)!.Running)) await new Promise((resolve) => setImmediate(resolve));
    t.mock.timers.tick(60_000);
    for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false, "still waited on a minute later");
    end();
    assert.deepEqual(await going, { output: "working\n", exitCode: 0, timedOut: false });
  } finally {
    t.mock.timers.reset();
    docker.runs.onExec = undefined;
    docker.hold.exec = undefined;
    end();
    await own.containers.remove("dk-slow");
  }
});

test("a call whose answer is cut off partway fails as one that does not reach Docker does, with status 0", async () => {
  // A Docker that begins its answer and goes before it ends it.
  const socket = path.join(mkdtempSync(path.join(os.tmpdir(), "dk-cut-")), "docker.sock");
  const cut = net.createServer((s) => s.once("data", () => s.end('HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n4\r\n{"st\r\n')));
  await new Promise<void>((resolve) => cut.listen(socket, resolve));
  process.env.DOCKER_SOCKET = socket;
  try {
    await assert.rejects(request("GET", "/containers/dk-x/json"), { status: 0, message: /Docker's answer was cut off/ });
    await assert.rejects(pull("redis:7", () => {}), { status: 0, message: /Docker's answer was cut off/ });
  } finally {
    process.env.DOCKER_SOCKET = docker.socket;
    await new Promise((resolve) => cut.close(resolve));
  }
});

test("a container shares the portal's network: the machine's for a portal on it, on Linux only, else the portal's own running container's, by PORTAL_CONTAINER_NAME or else HOSTNAME", async () => {
  const was = { PORTAL_CONTAINER_NAME: process.env.PORTAL_CONTAINER_NAME, HOSTNAME: process.env.HOSTNAME };
  delete process.env.PORTAL_CONTAINER_NAME;
  docker.containers.push({ Id: "portal0000000", Name: "dk-portal", Image: "pithagoras-portal", State: "running", Labels: {}, Tty: false, out: "", err: "" });
  try {
    assert.equal(await sharedNetwork(false, "linux"), "host");
    await assert.rejects(sharedNetwork(false, "darwin"), /only on Linux/);
    process.env.HOSTNAME = "dk-portal";
    assert.equal(await sharedNetwork(true, "linux"), "container:portal0000000", "in a container: the one its host name names");
    process.env.PORTAL_CONTAINER_NAME = "dk-portal";
    process.env.HOSTNAME = "0123456789ab";
    assert.equal(await dockerFor(dataDir()).forExtension("a").sharedNetwork(), "container:portal0000000", "the one named, wherever the portal runs");
    docker.containers.find((c) => c.Name === "dk-portal")!.State = "exited";
    await assert.rejects(sharedNetwork(true, "linux"), /Cannot identify the running portal container/);
    process.env.PORTAL_CONTAINER_NAME = "dk-missing";
    await assert.rejects(sharedNetwork(true, "linux"), /Cannot identify the running portal container/);
  } finally {
    for (const [key, value] of Object.entries(was)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    docker.containers.splice(docker.containers.findIndex((c) => c.Name === "dk-portal"), 1);
  }
});

test("an extension's volumes are its own as its containers are", async () => {
  const { forExtension } = dockerFor(dataDir());
  const browser = forExtension("pithagoras-browser"), voice = forExtension("pithagoras-voice");
  await browser.volumes.create("dk-profile");
  await browser.volumes.create("dk-profile");
  assert.deepEqual(await browser.volumes.list(), [{ name: "dk-profile", owner: "pithagoras-browser" }]);
  assert.deepEqual(await voice.volumes.list(), []);
  await assert.rejects(voice.volumes.remove("dk-profile"), /dk-profile is pithagoras-browser's volume, not pithagoras-voice's/);
  await assert.rejects(voice.volumes.create("dk-profile"), /pithagoras-browser's volume/);
  docker.volumes.push({ Name: "pithagoras_browser-profile", Labels: null });
  await assert.rejects(browser.volumes.remove("pithagoras_browser-profile"), /no extension's volume: take it over first/);
  await browser.volumes.adopt("pithagoras_browser-profile");
  assert.deepEqual((await browser.volumes.list()).map((v) => v.name).sort(), ["dk-profile", "pithagoras_browser-profile"]);
  await browser.volumes.remove("pithagoras_browser-profile");
  await browser.volumes.remove("dk-profile");
  assert.deepEqual(docker.volumes, []);
});

const ISOLATED = { "com.docker.network.bridge.gateway_mode_ipv4": "isolated" };
/** A running portal container in the fake, named by PORTAL_CONTAINER_NAME, in the network mode given; taken away again, with the name, after `work`. */
async function withPortal(mode: string, work: (portal: FakeContainer) => Promise<void>, id = `portal-${mode}`.replace(/[^a-z0-9]/g, "").padEnd(12, "0")) {
  const was = process.env.PORTAL_CONTAINER_NAME;
  const portal: FakeContainer = { Id: id, Name: "dk-the-portal", Image: "pithagoras-portal", State: "running", Labels: {}, Tty: false, out: "", err: "", HostConfig: { NetworkMode: mode } };
  docker.containers.push(portal);
  process.env.PORTAL_CONTAINER_NAME = portal.Name;
  try {
    await work(portal);
  } finally {
    if (was === undefined) delete process.env.PORTAL_CONTAINER_NAME;
    else process.env.PORTAL_CONTAINER_NAME = was;
    if (docker.containers.includes(portal)) docker.containers.splice(docker.containers.indexOf(portal), 1);
  }
}
/** What is left in the fake of a test's networks and containers, by the start of their names, taken away. */
function sweep(prefix: string) {
  for (const list of [docker.containers, docker.networks] as { Name: string }[][]) {
    for (let i = list.length - 1; i >= 0; i--) if (list[i].Name.startsWith(prefix)) list.splice(i, 1);
  }
}

test("an extension's network has no way out and carries its name; one of its own is kept, another's or nobody's is refused", async () => {
  const { forExtension } = dockerFor(dataDir(), false);
  const blender = forExtension("pithagoras-blender"), godot = forExtension("pithagoras-godot");
  try {
    const made = await blender.networks.create("dk-island");
    const there = docker.networks.find((n) => n.Name === "dk-island")!;
    assert.deepEqual(made, { name: "dk-island", id: there.Id, owner: "pithagoras-blender" });
    assert.deepEqual([there.Internal, there.EnableIPv6, there.Options, there.Labels], [true, false, ISOLATED, { [OWNER_LABEL]: "pithagoras-blender" }], "internal, isolated, no IPv6, and the extension's");
    assert.deepEqual(there.IPAM!.Config.map((c) => c.Gateway), [undefined], "so no gateway");
    const count = docker.networks.length;
    assert.deepEqual(await blender.networks.create("dk-island"), made, "one of its own is kept");
    assert.equal(docker.networks.length, count, "and nothing is made");
    await assert.rejects(godot.networks.create("dk-island"), { status: 403, message: /dk-island is pithagoras-blender's network, not pithagoras-godot's/ });
    docker.networks.push({ Id: "bridge000000", Name: "dk-bridge", Labels: {} });
    await assert.rejects(blender.networks.create("dk-bridge"), { status: 403, message: /dk-bridge is no extension's network/ });
    await assert.rejects(blender.networks.create("../up"), { status: 0, message: /is not a name Docker takes/ });
    assert.deepEqual(await godot.networks.get("dk-island"), made, "another's may be seen, with whose it is");
    assert.deepEqual(await blender.networks.get("dk-bridge"), { name: "dk-bridge", id: "bridge000000", owner: "" });
    assert.equal(await blender.networks.get("dk-none"), undefined);
    assert.equal(await blender.networks.get(there.Id), undefined, "by its name only: Docker's inspect also takes an id");
  } finally {
    sweep("dk-");
  }
});

test("a container is made on the extension's own networks and Docker's own alone, and shares the network of its own container or the portal's alone: what Docker made otherwise is taken away again", async () => {
  const was = process.env.PORTAL_CONTAINER_NAME;
  process.env.PORTAL_CONTAINER_NAME = "dk-portal";
  docker.containers.push({ Id: "portal1000000", Name: "dk-portal", Image: "pithagoras-portal", State: "running", Labels: {}, Tty: false, out: "", err: "" });
  docker.networks.push({ Id: "dockers00000", Name: "bridge", Labels: {} }, { Id: "nobodys00000", Name: "dk-nobodys", Labels: {} });
  const { forExtension } = dockerFor(dataDir(), true);
  const blender = forExtension("pithagoras-blender"), godot = forExtension("pithagoras-godot");
  const gone = (name: string) => assert.equal(docker.containers.find((c) => c.Name === name), undefined, `${name} is taken away again`);
  try {
    const theirs = await blender.networks.create("dk-b-island");
    await godot.networks.create("dk-g-island");
    await blender.containers.create("dk-b", { Image: "blender:1", HostConfig: { NetworkMode: "dk-b-island" } });
    for (const [label, spec] of [
      ["by its name", { HostConfig: { NetworkMode: "dk-b-island" } }],
      ["by its id", { HostConfig: { NetworkMode: theirs.id } }],
      ["as one more endpoint, under the name of the other's container", { HostConfig: { NetworkMode: "dk-g-island" }, NetworkingConfig: { EndpointsConfig: { "dk-g-island": {}, "dk-b-island": { Aliases: ["dk-b"] } } } }],
    ] as const) {
      await assert.rejects(godot.containers.create("dk-g", { Image: "godot:1", ...spec }), { status: 403, message: /dk-g would be on dk-b-island, which is pithagoras-blender's network, not pithagoras-godot's/ }, label);
      gone("dk-g");
    }
    await assert.rejects(godot.containers.create("dk-g", { Image: "godot:1", HostConfig: { NetworkMode: "dk-nobodys" } }), { status: 403, message: /dk-g would be on dk-nobodys, which is no extension's network, not pithagoras-godot's/ });
    gone("dk-g");
    await assert.rejects(godot.containers.create("dk-g", { Image: "godot:1", HostConfig: { NetworkMode: "container:dk-b" } }), { status: 403, message: /dk-g would share the network of dk-b, which is neither pithagoras-godot's container nor the portal's/ });
    gone("dk-g");
    await assert.rejects(godot.containers.create("dk-g", { Image: "godot:1", HostConfig: { NetworkMode: "container:dk-later" } }), { status: 403, message: /dk-g would share the network of dk-later, which there is no container of/ });
    gone("dk-g");
    assert.equal((await godot.containers.create("dk-g", { Image: "godot:1", HostConfig: { NetworkMode: "dk-g-island" } })).owner, "pithagoras-godot", "on its own network");
    assert.ok(docker.containers.find((c) => c.Name === "dk-g")!.Networks!["dk-g-island"]);
    await godot.containers.create("dk-g-bridge", { Image: "godot:1", HostConfig: { NetworkMode: "bridge" } });
    assert.ok(docker.containers.find((c) => c.Name === "dk-g-bridge")!.Networks!.bridge, "on Docker's own");
    await godot.containers.create("dk-g-side", { Image: "godot:1", HostConfig: { NetworkMode: "container:dk-g" } });
    await godot.containers.create("dk-g-portal", { Image: "godot:1", HostConfig: { NetworkMode: "container:portal1000000" } });
    assert.deepEqual(["dk-g-side", "dk-g-portal"].map((n) => Boolean(docker.containers.find((c) => c.Name === n))), [true, true], "sharing its own container's network, and the portal's");
  } finally {
    if (was === undefined) delete process.env.PORTAL_CONTAINER_NAME;
    else process.env.PORTAL_CONTAINER_NAME = was;
    docker.networks.splice(docker.networks.findIndex((n) => n.Name === "bridge"), 1);
    sweep("dk-");
  }
});

test("a Docker that makes the network with a way out is refused, and what it made is taken away again", async () => {
  const own = dockerFor(dataDir(), false).forExtension("a");
  docker.runs.oldNetworks = true;
  try {
    await assert.rejects(own.networks.create("dk-old"), { status: 0, message: /^This Docker cannot make a network with no way out: that takes Docker Engine 28.0 or later.$/ });
    assert.equal(docker.networks.some((n) => n.Name === "dk-old"), false, "taken away again");
    docker.runs.oldNetworks = undefined;
    // One of its own that lacks any of it, as one made by hand may: refused, and left as it is.
    const noWayOut = { Labels: { [OWNER_LABEL]: "a" }, Internal: true, EnableIPv6: false, Options: ISOLATED, IPAM: { Config: [{ Subnet: "10.200.0.0/16" }] } };
    const lacking = {
      "dk-gateway": { IPAM: { Config: [{ Subnet: "10.200.0.0/16", Gateway: "10.200.0.1" }] } },
      "dk-not-isolated": { Options: {} },
      "dk-not-internal": { Internal: false },
      "dk-ipv6": { EnableIPv6: true },
    };
    for (const [name, lacks] of Object.entries(lacking)) {
      docker.networks.push({ Id: `${name}-id`, Name: name, ...noWayOut, ...lacks });
      await assert.rejects(own.networks.create(name), { status: 409, message: new RegExp(`^${name} has a way out to the machine, which an extension's network may not have: remove it, and it is made again$`) });
      assert.ok(docker.networks.some((n) => n.Name === name), "not removed");
    }
  } finally {
    docker.runs.oldNetworks = undefined;
    sweep("dk-");
  }
});

test("for a portal in a container of its own network, reach puts the portal's container on the network once and gives the container's name", async () => {
  const own = dockerFor(dataDir(), false).forExtension("pithagoras-blender");
  try {
    await withPortal("bridge", async (portal) => {
      const island = await own.networks.create("dk-net");
      await own.containers.create("dk-srv", { Image: "blender:1", HostConfig: { NetworkMode: "dk-net" } });
      const asked = docker.connects.length;
      assert.deepEqual(await own.networks.reach("dk-net", "dk-srv", 3870), { host: "dk-srv", port: 3870 }, "for one not running yet too");
      assert.deepEqual(docker.connects.slice(asked), [{ network: "dk-net", container: "dk-the-portal" }]);
      assert.deepEqual(portal.Networks, { "dk-net": { NetworkID: island.id } });
      assert.deepEqual(await own.networks.reach("dk-net", "dk-srv", 3870), { host: "dk-srv", port: 3870 });
      assert.equal(docker.connects.length, asked + 1, "a second reach connects nothing");

      // Connected by another just then: Docker's 403 counts as done, as the portal is on it.
      delete portal.Networks!["dk-net"];
      docker.runs.onConnect = (n, c) => (c.Networks = { ...c.Networks, [n.Name]: { NetworkID: n.Id } });
      assert.deepEqual(await own.networks.reach("dk-net", "dk-srv", 3870), { host: "dk-srv", port: 3870 });
      assert.equal(docker.connects.length, asked + 2);
      // A refusal that leaves it off the network is passed on, in Docker's words.
      delete portal.Networks!["dk-net"];
      docker.runs.onConnect = (_n, c) => (c.HostConfig = { NetworkMode: "host" });
      await assert.rejects(own.networks.reach("dk-net", "dk-srv", 3870), { status: 400, message: /cannot be connected to any other network/ });
      docker.runs.onConnect = undefined;
      portal.HostConfig = { NetworkMode: "bridge" };

      // The portal's container made again, with another id: on no network but its own, and connected at the next reach.
      docker.containers.splice(docker.containers.indexOf(portal), 1);
      const again: FakeContainer = { ...portal, Id: "portalagain0", Networks: undefined };
      docker.containers.push(again);
      assert.deepEqual(await own.networks.reach("dk-net", "dk-srv", 3870), { host: "dk-srv", port: 3870 });
      assert.deepEqual(again.Networks, { "dk-net": { NetworkID: island.id } });
      assert.equal(docker.containers.some((c) => c.Name === "dk-srv-forward") || docker.networks.some((n) => n.Name === "dk-srv-forward"), false, "nothing was published");
      docker.containers.splice(docker.containers.indexOf(again), 1);
    });
  } finally {
    docker.runs.onConnect = undefined;
    sweep("dk-");
  }
});

test("for a portal on the machine's network, reach runs a forwarder that publishes the port on 127.0.0.1", async () => {
  const own = dockerFor(dataDir(), false).forExtension("pithagoras-godot");
  const forwarder = () => docker.containers.find((c) => c.Name === "dk-gsrv-forward")!;
  try {
    await withPortal("host", async () => {
      const island = await own.networks.create("dk-gnet");
      await own.containers.create("dk-gsrv", { Image: "godot:1", HostConfig: { NetworkMode: "dk-gnet" } });
      const pulls = docker.pulls.length;
      assert.deepEqual(await own.networks.reach("dk-gnet", "dk-gsrv", 3880), { host: "127.0.0.1", port: 3880 });
      assert.deepEqual(docker.pulls.slice(pulls), [FORWARDER_IMAGE], "its image downloaded, the first time");
      assert.equal(FORWARDER_IMAGE, "node:22.23.4-alpine3.23");
      const door = docker.networks.find((n) => n.Name === "dk-gsrv-forward")!;
      assert.deepEqual([door.Internal, door.Labels], [false, { [OWNER_LABEL]: "pithagoras-godot", "pithagoras.forwards": "dk-gnet" }], "its own network, with a way out for its port, and the extension's");
      const made = forwarder().made as any;
      assert.deepEqual([made.Image, made.User, made.Cmd, made.Env], [FORWARDER_IMAGE, "1000:1000", ["node", "-e", FORWARD_SCRIPT], ["FORWARD_PORT=3880", "FORWARD_TO_HOST=dk-gsrv", "FORWARD_TO_PORT=3880"]]);
      assert.deepEqual(made.ExposedPorts, { "3880/tcp": {} });
      assert.deepEqual(made.HostConfig.PortBindings, { "3880/tcp": [{ HostIp: "127.0.0.1", HostPort: "3880" }] }, "published on the machine's 127.0.0.1 alone");
      assert.deepEqual([made.HostConfig.NetworkMode, Object.keys(made.NetworkingConfig.EndpointsConfig)], ["dk-gsrv-forward", ["dk-gsrv-forward", "dk-gnet"]], "on both networks from its create");
      assert.deepEqual(
        [made.HostConfig.CapDrop, made.HostConfig.SecurityOpt, made.HostConfig.ReadonlyRootfs, made.HostConfig.RestartPolicy, made.HostConfig.Memory, made.HostConfig.PidsLimit],
        [["ALL"], ["no-new-privileges"], true, { Name: "unless-stopped" }, 128 * 1024 ** 2, 64],
      );
      assert.deepEqual(forwarder().Networks, { "dk-gsrv-forward": { NetworkID: door.Id }, "dk-gnet": { NetworkID: island.id } });
      assert.equal(forwarder().Labels[OWNER_LABEL], "pithagoras-godot");
      assert.equal(forwarder().Labels["pithagoras.forwards"], "dk-gnet");
      assert.equal(forwarder().State, "running", "started");
      assert.deepEqual((await own.containers.list()).map((c) => c.name).sort(), ["dk-gsrv", "dk-gsrv-forward"], "listed as the extension's, in Settings too");

      const count = () => [docker.created.length, docker.starts.length, docker.pulls.length, docker.networks.length];
      let before = count();
      assert.deepEqual(await own.networks.reach("dk-gnet", "dk-gsrv", 3880), { host: "127.0.0.1", port: 3880 });
      assert.deepEqual(count(), before, "a second reach makes and starts nothing");

      // Another port: made again, the old one gone.
      const first = forwarder();
      assert.deepEqual(await own.networks.reach("dk-gnet", "dk-gsrv", 3881), { host: "127.0.0.1", port: 3881 });
      assert.notEqual(forwarder(), first);
      assert.deepEqual((forwarder().made as any).HostConfig.PortBindings, { "3881/tcp": [{ HostIp: "127.0.0.1", HostPort: "3881" }] });
      assert.equal(docker.containers.filter((c) => c.Name === "dk-gsrv-forward").length, 1);
      // The island made again under its name, with another id, and the server made again on it: made again too.
      const second = forwarder();
      const there = docker.networks.find((n) => n.Name === "dk-gnet")!;
      there.Id = "renewed00000";
      docker.containers.find((c) => c.Name === "dk-gsrv")!.Networks = { "dk-gnet": { NetworkID: there.Id } };
      await own.networks.reach("dk-gnet", "dk-gsrv", 3881);
      assert.notEqual(forwarder(), second);
      // A stopped one is started, and not made again.
      forwarder().State = "exited";
      before = count();
      await own.networks.reach("dk-gnet", "dk-gsrv", 3881);
      assert.deepEqual([docker.created.length, docker.starts.at(-1), forwarder().State], [before[0], "dk-gsrv-forward", "running"]);
    });
    // A portal on the machine itself, with no container: the same.
    const asked = docker.connects.length;
    assert.deepEqual(await own.networks.reach("dk-gnet", "dk-gsrv", 3881), { host: "127.0.0.1", port: 3881 });
    assert.equal(docker.connects.length, asked, "nothing is connected");
    // The portal moved into a container of its own: the forwarder left from before goes, with its network.
    await withPortal("bridge", async () => {
      assert.deepEqual(await own.networks.reach("dk-gnet", "dk-gsrv", 3881), { host: "dk-gsrv", port: 3881 });
      assert.equal(docker.containers.some((c) => c.Name === "dk-gsrv-forward"), false);
      assert.equal(docker.networks.some((n) => n.Name === "dk-gsrv-forward"), false);
    });
  } finally {
    sweep("dk-");
  }
});

test("two reaches at once make one forwarder", async () => {
  const own = dockerFor(dataDir(), false).forExtension("a");
  try {
    await own.networks.create("dk-twice");
    await own.containers.create("dk-twice-srv", { Image: "x", HostConfig: { NetworkMode: "dk-twice" } });
    const made = docker.created.length;
    assert.deepEqual(await Promise.all([own.networks.reach("dk-twice", "dk-twice-srv", 3890), own.networks.reach("dk-twice", "dk-twice-srv", 3890)]), [{ host: "127.0.0.1", port: 3890 }, { host: "127.0.0.1", port: 3890 }]);
    assert.equal(docker.created.length, made + 1);
  } finally {
    sweep("dk-");
  }
});

test("reach is refused for another's network or container, one not on the network, a port that is none, and a portal that shares another container's network", async () => {
  const { forExtension } = dockerFor(dataDir(), false);
  const blender = forExtension("pithagoras-blender"), godot = forExtension("pithagoras-godot");
  try {
    await blender.networks.create("dk-bnet");
    await blender.containers.create("dk-bsrv", { Image: "blender:1", HostConfig: { NetworkMode: "dk-bnet" } });
    // Godot's container on Blender's network, which `create` refuses: as if it were made with the docker command.
    docker.containers.push({ Id: "gsrv00000000", Name: "dk-gsrv", Image: "godot:1", State: "created", Labels: { [OWNER_LABEL]: "pithagoras-godot" }, Tty: false, out: "", err: "", Networks: { "dk-bnet": { NetworkID: "" } } });
    await blender.containers.create("dk-loose", { Image: "blender:1" });
    docker.networks.push({ Id: "nobody000000", Name: "dk-nobodys", Labels: {} });
    docker.networks.push({ Id: "gateway00000", Name: "dk-gateway", Labels: { [OWNER_LABEL]: "pithagoras-blender" }, Internal: true, Options: ISOLATED, IPAM: { Config: [{ Gateway: "10.200.0.1" }] } });
    await assert.rejects(godot.networks.reach("dk-bnet", "dk-gsrv", 3880), { status: 403, message: /dk-bnet is pithagoras-blender's network, not pithagoras-godot's/ });
    await assert.rejects(blender.networks.reach("dk-nobodys", "dk-bsrv", 3870), { status: 403, message: /dk-nobodys is no extension's network/ });
    await assert.rejects(blender.networks.reach("dk-none", "dk-bsrv", 3870), { status: 404, message: /There is no network dk-none/ });
    await assert.rejects(blender.networks.reach("dk-gateway", "dk-bsrv", 3870), { status: 409, message: /dk-gateway has a way out to the machine/ });
    await assert.rejects(blender.networks.reach("dk-bnet", "dk-gsrv", 3880), { status: 403, message: /dk-gsrv is pithagoras-godot's container, not pithagoras-blender's/ });
    await assert.rejects(blender.networks.reach("dk-bnet", "dk-nosrv", 3870), { status: 404, message: /There is no container dk-nosrv/ });
    await assert.rejects(blender.networks.reach("dk-bnet", "dk-loose", 3870), { status: 409, message: /dk-loose is not on dk-bnet/ });
    for (const port of [0, 65536, 3870.5, Number.NaN]) await assert.rejects(blender.networks.reach("dk-bnet", "dk-bsrv", port), { status: 0, message: /is not a port/ });
    await withPortal("container:0123456789ab", async () => {
      await assert.rejects(blender.networks.reach("dk-bnet", "dk-bsrv", 3870), {
        status: 409,
        message: /^The portal's container shares the network of another container, to which no network can be added: run the portal with a network of its own, or on the machine's \(network_mode: host\)\.$/,
      });
    });
    assert.equal(docker.containers.some((c) => c.Name.endsWith("-forward")), false, "nothing was made for any of them");
  } finally {
    sweep("dk-");
  }
});

test("remove takes the forwarder and its network and the portal's container off first, and is refused while one of the extension's containers is on it", async () => {
  const { forExtension } = dockerFor(dataDir(), false);
  const own = forExtension("pithagoras-blender");
  try {
    await own.networks.create("dk-rnet");
    await own.containers.create("dk-rsrv", { Image: "blender:1", HostConfig: { NetworkMode: "dk-rnet" } });
    await own.containers.start("dk-rsrv");
    await withPortal("host", async () => {
      await own.networks.reach("dk-rnet", "dk-rsrv", 3870);
    });
    assert.ok(docker.containers.some((c) => c.Name === "dk-rsrv-forward"));
    await assert.rejects(own.networks.remove("dk-rnet"), { status: 403, message: /network dk-rnet has active endpoints \(name:"dk-rsrv"/ });
    assert.equal(docker.containers.some((c) => c.Name === "dk-rsrv-forward"), false, "the forwarder went first");
    assert.equal(docker.networks.some((n) => n.Name === "dk-rsrv-forward"), false, "and its network");
    assert.ok(docker.networks.some((n) => n.Name === "dk-rnet"), "the network stays while the server is on it");
    await assert.rejects(forExtension("pithagoras-godot").networks.remove("dk-rnet"), { status: 403, message: /dk-rnet is pithagoras-blender's network, not pithagoras-godot's/ });
    await withPortal("bridge", async (portal) => {
      await own.networks.reach("dk-rnet", "dk-rsrv", 3870);
      assert.ok(portal.Networks?.["dk-rnet"]);
      await own.containers.remove("dk-rsrv");
      await own.networks.remove("dk-rnet");
      assert.deepEqual(portal.Networks, {}, "the portal's container taken off it");
    });
    assert.equal(docker.networks.some((n) => n.Name === "dk-rnet"), false, "gone");
    await own.networks.remove("dk-rnet");
  } finally {
    sweep("dk-");
  }
});

test("the forwarder passes HTTP and a WebSocket on, both ways, looks its target up at each connection, closes a connection whose target does not answer, and ends at Docker's stop", async () => {
  const target = http.createServer((req, res) => res.end(`ok ${req.method} ${req.url}`));
  // An upgrade that echoes what it is sent after its answer, as a WebSocket does with its frames, and ends as the other side does.
  target.on("upgrade", (_req, socket) => {
    socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
    socket.on("data", (d) => socket.write(d));
    socket.on("end", () => socket.end());
  });
  target.listen(0, "127.0.0.1");
  await once(target, "listening");
  const targetPort = (target.address() as AddressInfo).port;
  const free = net.createServer().listen(0, "127.0.0.1");
  await once(free, "listening");
  const port = (free.address() as AddressInfo).port;
  await new Promise((resolve) => free.close(resolve));
  const forwarding = spawn(process.execPath, ["-e", FORWARD_SCRIPT], { env: { ...process.env, FORWARD_PORT: String(port), FORWARD_TO_HOST: "127.0.0.1", FORWARD_TO_PORT: String(targetPort) }, stdio: "inherit" });
  /**
   * What a connection through the forwarder is answered with, after `send` and its end where asked, until it closes,
   * and how: a connection closed with what was sent still unread is reset.
   */
  const exchange = (send: string, end: boolean) =>
    new Promise<{ got: string; error?: string }>((resolve) => {
      const s = net.connect(port, "127.0.0.1");
      let got = "";
      let error: string | undefined;
      s.on("data", (d) => (got += d));
      s.on("error", (e: NodeJS.ErrnoException) => (error = e.code));
      s.on("close", () => resolve({ got, ...(error ? { error } : {}) }));
      s.write(send);
      if (end) s.end();
    });
  try {
    for (let tries = 0; ; tries++) {
      try {
        await new Promise<void>((resolve, reject) => net.connect(port, "127.0.0.1").on("connect", function (this: net.Socket) { this.destroy(); resolve(); }).on("error", reject));
        break;
      } catch (e) {
        if (tries > 200) throw e;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    assert.equal(await (await fetch(`http://127.0.0.1:${port}/state`)).text(), "ok GET /state");
    // A request whose writing ends before its answer comes: the answer still comes.
    const half = await exchange("GET /half HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n", true);
    assert.equal(half.error, undefined);
    assert.match(half.got, /^HTTP\/1\.1 200 OK[\s\S]*ok GET \/half$/);
    // A WebSocket: the upgrade's answer, then what is sent comes back, as it goes, both ways.
    const ws = net.connect(port, "127.0.0.1");
    let heard = "";
    ws.on("data", (d) => (heard += d));
    ws.write("GET /ws HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n");
    while (!heard.includes("\r\n\r\n")) await once(ws, "data");
    assert.match(heard, /^HTTP\/1\.1 101 Switching Protocols/);
    heard = "";
    ws.write("\x81\x05hello");
    while (heard.length < 7) await once(ws, "data");
    assert.equal(heard, "\x81\x05hello");
    ws.destroy();
    // The target gone: a connection is closed, with nothing said.
    target.closeAllConnections();
    await new Promise((resolve) => target.close(resolve));
    const gone = await exchange("GET / HTTP/1.1\r\nHost: x\r\n\r\n", false);
    assert.equal(gone.got, "");
    assert.ok([undefined, "ECONNRESET"].includes(gone.error), gone.error);
    // Back on the same port: the next connection reaches it.
    target.listen(targetPort, "127.0.0.1");
    await once(target, "listening");
    assert.equal(await (await fetch(`http://127.0.0.1:${port}/again`)).text(), "ok GET /again");
    // Docker's stop: it ends, as itself, where Node would be killed by the signal.
    forwarding.kill("SIGTERM");
    assert.deepEqual(await once(forwarding, "exit"), [0, null]);
  } finally {
    forwarding.kill();
    target.closeAllConnections();
    target.close();
  }
});

test("without Docker's socket it is not available, and what is asked of it says why", async () => {
  const was = process.env.DOCKER_SOCKET;
  process.env.DOCKER_SOCKET = path.join(dataDir(), "none.sock");
  try {
    const { forExtension, person } = dockerFor(dataDir());
    const own = forExtension("a");
    assert.equal(await own.available(), false);
    await assert.rejects(own.containers.list(), /Docker cannot be reached: there is no socket at .*none\.sock/);
    assert.deepEqual(await person.overview(), { available: false, socket: false });
  } finally {
    process.env.DOCKER_SOCKET = was;
  }
});

test("the server half gives each extension its own, each chat the agent's tools, off until switched on, and its page sees and acts on every extension's, and nobody's is not shown", async () => {
  const given: ((consumer: { name: string }) => unknown)[] = [];
  const extended: ((pi: unknown, chat: { id: string }) => void)[] = [];
  const router = express.Router();
  serverHalf({
    extension: "pithagoras-docker",
    dataDir: dataDir,
    provide: (factory: (consumer: { name: string }) => unknown) => given.push(factory),
    router,
    chats: { extend: (factory: (pi: unknown, chat: { id: string }) => void) => extended.push(factory), folder: () => dataDir() },
    files: { inside: (base: string, rel: string) => path.join(base, rel) },
  } as never);
  assert.equal(given.length, 1);
  const tools: { name: string; offByDefault?: boolean }[] = [];
  extended[0]({ registerTool: (tool: { name: string; offByDefault?: boolean }) => tools.push(tool) }, { id: "chat" });
  assert.deepEqual(tools.map((t) => [t.name, t.offByDefault]), ["docker_run", "docker_list", "docker_start", "docker_stop", "docker_delete", "docker_logs"].map((name) => [name, true]));
  const browser = given[0]({ name: "pithagoras-browser" }) as Docker;
  await browser.containers.create("dk-page", { Image: "chromium:1" });
  Object.assign(docker.containers.find((c) => c.Name === "dk-page")!, { out: "hello\n" });
  docker.containers.push({ Id: "hand000000000", Name: "by-hand", Image: "nginx", State: "running", Labels: {}, Tty: false, out: "", err: "" });

  const app = express();
  app.use("/x", router);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const at = `http://127.0.0.1:${(server.address() as AddressInfo).port}/x`;
  const call = async (method: string, url: string) => {
    const res = await fetch(at + url, { method });
    return { status: res.status, body: (await res.json()) as any };
  };
  try {
    const { body: overview } = await call("GET", "/overview");
    assert.equal(overview.available, true);
    assert.equal(overview.version, "27.3.1");
    assert.deepEqual(overview.containers.map((c: any) => [c.name, c.owner]), [["dk-page", "pithagoras-browser"]], "the one made by hand is not shown");
    assert.equal((await call("POST", "/containers/dk-page/start")).status, 200);
    assert.equal(docker.containers.find((c) => c.Name === "dk-page")!.State, "running");
    assert.deepEqual((await call("GET", "/containers/dk-page/logs?tail=50")).body, { text: "hello\n" });
    assert.equal((await call("POST", "/containers/by-hand/stop")).status, 404, "nobody's: not the page's to act on");
    assert.equal(docker.containers.find((c) => c.Name === "by-hand")!.State, "running");
    assert.equal((await call("DELETE", "/containers/dk-page")).status, 200);
    assert.equal(docker.containers.some((c) => c.Name === "dk-page"), false);
  } finally {
    server.close();
    docker.containers.splice(docker.containers.findIndex((c) => c.Name === "by-hand"), 1);
  }
});
