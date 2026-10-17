import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
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
const { dockerFor, OWNER_LABEL } = await import("../src/docker.ts");
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

test("the server half gives each extension its own, and its page sees and acts on every extension's, and nobody's is not shown", async () => {
  const given: ((consumer: { name: string }) => unknown)[] = [];
  const router = express.Router();
  serverHalf({ dataDir: dataDir, provide: (factory: (consumer: { name: string }) => unknown) => given.push(factory), router } as never);
  assert.equal(given.length, 1);
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
