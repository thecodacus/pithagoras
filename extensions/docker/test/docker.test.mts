import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import express from "express";
import { fakeDocker } from "./fake-docker.ts";
import type { Docker } from "../src/api.ts";

// Docker for the extensions that build on it (src/docker.ts), against a daemon of the tests' own on a socket.
const docker = await fakeDocker();
process.env.DOCKER_SOCKET = docker.socket;
const { dockerFor, OWNER_LABEL, sharedNetwork } = await import("../src/docker.ts");
const { demux } = await import("../src/engine.ts");
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
    HostConfig: { NetworkMode: "container:portal", DeviceRequests: [{ Driver: "nvidia", DeviceIDs: ["GPU-1"], Capabilities: [["gpu"]] }], RestartPolicy: { Name: "no" } },
  });
  const made = (await voice.containers.inspect("dk-inspect")) as any;
  assert.deepEqual([made.Config.Env, made.Config.Cmd, made.Config.Labels[OWNER_LABEL]], [["VOICE_TTS=breeze"], ["bash", "-c", "serve"], "pithagoras-voice"]);
  assert.equal(made.HostConfig.NetworkMode, "container:portal");
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

test("an extension runs a command in its own running container, with the environment, folder and terminal asked for, and reads what it wrote and its exit code; not in another's, nor in one that is not running", async () => {
  const { forExtension } = dockerFor(dataDir());
  const own = forExtension("pithagoras-understory"), other = forExtension("someone-else");
  await own.containers.create("dk-exec", { Image: "understory:1" });
  docker.runs.onExec = (e) => ({ out: `ran ${e.Cmd.join(" ")}\n`, err: "a warning\n", code: 3 });
  try {
    await assert.rejects(own.containers.exec("dk-exec", ["true"]), { status: 409, message: /is not running/ });
    await own.containers.start("dk-exec");
    const ran = await own.containers.exec("dk-exec", ["node", "-e", "write()"], { env: { PORTAL_INPUT: "e30=" }, workingDir: "/app/server" });
    assert.deepEqual(ran, { output: "ran node -e write()\na warning\n", exitCode: 3, timedOut: false });
    const asked = docker.execs.at(-1)!;
    assert.deepEqual([asked.Env, asked.WorkingDir, asked.Tty], [["PORTAL_INPUT=e30="], "/app/server", false]);
    // With a terminal: as it was written.
    docker.runs.onExec = () => ({ out: "\x1b[32mok\x1b[0m\n" });
    assert.deepEqual(await own.containers.exec("dk-exec", ["ls"], { tty: true }), { output: "\x1b[32mok\x1b[0m\n", exitCode: 0, timedOut: false });
    assert.equal(docker.execs.at(-1)!.Tty, true);
    const asks = docker.execs.length;
    await assert.rejects(other.containers.exec("dk-exec", ["true"]), { status: 403, message: /dk-exec is pithagoras-understory's container, not someone-else's/ });
    await assert.rejects(own.containers.exec("dk-none", ["true"]), { status: 404, message: /There is no container dk-none/ });
    assert.equal(docker.execs.length, asks, "nothing is run where it is refused");
  } finally {
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
