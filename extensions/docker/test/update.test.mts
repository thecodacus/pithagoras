import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import express from "express";
import { fakeDocker, type FakeImage } from "./fake-docker.ts";
import type { Docker, WantedImage } from "../src/api.ts";

// A container whose image is not the one its extension wants (src/docker.ts, src/update.ts): how it is told, and the
// update that makes it again on the wanted image, against a daemon of the tests' own on a socket.
const docker = await fakeDocker();
process.env.DOCKER_SOCKET = docker.socket;
const { dockerFor, OWNER_LABEL } = await import("../src/docker.ts");
const { recreation } = await import("../src/update.ts");
const { default: serverHalf } = await import("../src/server.ts");
test.after(() => docker.close());

const dataDir = () => mkdtempSync(path.join(os.tmpdir(), "dk-data-"));
const VOICE = "pithagoras-voice";

/** What the old image gives its containers, and the new one. */
const OLD: FakeImage = { Id: "sha256:old", Config: { Env: ["PATH=/bin", "CUDA_VERSION=12.4.1", "KEEP=same"], Cmd: ["bash"], WorkingDir: "/w-old", Labels: { "com.image": "old" }, ExposedPorts: { "8080/tcp": {} }, Volumes: { "/imgdata": {} } } };
const NEW: FakeImage = { Id: "sha256:new", Config: { Env: ["PATH=/bin", "CUDA_VERSION=12.9.1", "KEEP=same"], Cmd: ["bash"], WorkingDir: "/w-new", Labels: { "com.image": "new" }, ExposedPorts: { "8080/tcp": {} }, Volumes: { "/imgdata": {} } } };
/** `img:1` is downloaded, as the container was made on it; `img:2` is what a download of it brings. */
function images() {
  docker.images.add("img:1");
  docker.imageInfo.set("img:1", OLD);
  docker.imageInfo.set("img:2", NEW);
}

afterEach(() => {
  for (const list of [docker.containers, docker.networks, docker.volumes, docker.pulls, docker.renames, docker.created, docker.starts] as unknown[][]) list.length = 0;
  docker.images.clear();
  docker.imageInfo.clear();
  docker.failing.clear();
  delete docker.runs.refuseStart;
  delete docker.hold.pull;
});

/** Wants `image` of `name` for the extension, and gives the Docker it is asked through. */
function wanting(who: string, image: string, wanted: (name: string) => Partial<WantedImage> = () => ({})) {
  const { forExtension, person } = dockerFor(dataDir());
  const d = forExtension(who);
  d.containers.wantImage((c) => (c.name.startsWith("up-") ? { image, ...wanted(c.name) } : undefined));
  return { d, person, forExtension };
}
/** The container in the overview once its update has ended. */
async function ended(person: ReturnType<typeof dockerFor>["person"], name: string) {
  for (let i = 0; i < 400; i++) {
    const c = ((await person.overview()) as { containers: any[] }).containers.find((x) => x.name === name);
    if (c?.update && !c.update.active) return c;
    await delay(5);
  }
  assert.fail(`the update of ${name} did not end`);
}

test("a container is outdated where its extension wants another image, or the one it runs has been downloaded again; the extension's wish is all that says so", async () => {
  images();
  const { d, forExtension } = wanting(VOICE, "img:2");
  await d.containers.create("up-a", { Image: "img:1", Labels: { "pithagoras.voice-recipe": "x" } });
  const seen: Record<string, string>[] = [];
  d.containers.wantImage((c) => (seen.push(c.labels), c.name === "up-a" ? { image: "img:2", busy: "its setup is running" } : undefined));
  assert.deepEqual(await d.containers.outdated("up-a"), { kind: "other", running: "img:1", wanted: "img:2", busy: "its setup is running" });
  assert.equal(seen.at(-1)!["pithagoras.voice-recipe"], "x", "the wish is asked with the labels the container was made with");

  // The same image under another name is the same image.
  docker.images.add("img:1b");
  docker.imageInfo.set("img:1b", OLD);
  d.containers.wantImage(() => ({ image: "img:1b" }));
  assert.equal(await d.containers.outdated("up-a"), undefined);
  // Wanting the reference it runs, it is current until that reference points to another image.
  d.containers.wantImage(() => ({ image: "img:1" }));
  assert.equal(await d.containers.outdated("up-a"), undefined);
  docker.imageInfo.set("img:1", NEW);
  assert.deepEqual(await d.containers.outdated("up-a"), { kind: "pulled", running: "img:1", wanted: "img:1" });
  // A wanted image that is not downloaded yet is not the one it runs.
  d.containers.wantImage(() => ({ image: "img:3" }));
  assert.equal((await d.containers.outdated("up-a"))?.kind, "other");

  // No wish for it, a wish that throws, and a container that is not there: nothing to say.
  d.containers.wantImage(() => undefined);
  assert.equal(await d.containers.outdated("up-a"), undefined);
  d.containers.wantImage(() => {
    throw new Error("broken");
  });
  assert.equal(await d.containers.outdated("up-a"), undefined);
  assert.equal(await d.containers.outdated("up-none"), undefined);
  // Another extension's is not its to ask about.
  await assert.rejects(forExtension("pithagoras-browser").containers.outdated("up-a"), /up-a is pithagoras-voice's container, not pithagoras-browser's/);
});

test("an update downloads the wanted image and makes the container again on it with its settings, mounts, networks and volumes, the new image's own settings in place of the old one's", async () => {
  images();
  const { d, person } = wanting(VOICE, "img:2");
  await d.volumes.create("up-vol");
  await d.networks.create("up-net");
  await d.containers.create("up-a", {
    Image: "img:1",
    // An environment entry of its own over the image's, one of its own, and the image's CUDA_VERSION it did not set.
    Env: ["MINE=yes", "PATH=/mine"],
    Labels: { mine: "label" },
    Cmd: ["sleep", "9"],
    HostConfig: { Binds: ["up-vol:/vol"], NetworkMode: "up-net", RestartPolicy: { Name: "unless-stopped" } },
    NetworkingConfig: { EndpointsConfig: { "up-net": { Aliases: ["svc"] } } },
  });
  await d.containers.start("up-a");
  const old = docker.containers.find((c) => c.Name === "up-a")!;

  await person.updateImage("up-a");
  const row = await ended(person, "up-a");
  assert.deepEqual(row.update, { active: false, line: "", done: { from: "img:1", to: "img:2" } });
  assert.deepEqual(docker.pulls, ["img:2"]);
  assert.equal(row.imageWarning, undefined, "and it is current now");

  const now = docker.containers.filter((c) => c.Name.startsWith("up-a"));
  assert.deepEqual(now.map((c) => c.Name), ["up-a"], "the old one is gone");
  const made = now[0];
  assert.notEqual(made.Id, old.Id);
  assert.equal(made.State, "running");
  assert.deepEqual(docker.renames, [{ from: "up-a", to: "up-a-before-update" }]);
  const body = made.made as any;
  assert.equal(body.Image, "img:2");
  // The image's own settings are the new image's: what the old one gave is not carried, what the container had of its own is.
  assert.deepEqual(body.Env, ["PATH=/mine", "MINE=yes"], "CUDA_VERSION and KEEP come from the new image");
  assert.deepEqual(body.Cmd, ["sleep", "9"]);
  assert.equal(body.WorkingDir, undefined);
  assert.equal(body.ExposedPorts, undefined);
  assert.equal(body.Volumes, undefined);
  assert.deepEqual(body.Labels, { mine: "label", [OWNER_LABEL]: VOICE });
  // Its mounts: the folder the old image made a volume for is bound to that volume by its name, as the named one is.
  const unnamed = (old.Mounts ?? []).find((m) => m.Destination === "/imgdata")!;
  assert.match(String(unnamed.Name), /^anon/);
  assert.deepEqual(body.HostConfig.Binds, ["up-vol:/vol", `${unnamed.Name}:/imgdata`]);
  assert.deepEqual(body.HostConfig.RestartPolicy, { Name: "unless-stopped" });
  assert.equal(body.HostConfig.NetworkMode, "up-net");
  // The names it has on its network, but not the one Docker gave the old container.
  assert.deepEqual(body.NetworkingConfig, { EndpointsConfig: { "up-net": { Aliases: ["svc"] } } });
});

test("a container that was stopped stays stopped, and one with a network of another container's takes neither its host name nor its ports", async () => {
  images();
  const { d, person } = wanting(VOICE, "img:2");
  await d.containers.create("up-a", { Image: "img:1" });
  await person.updateImage("up-a");
  await ended(person, "up-a");
  assert.equal(docker.containers.find((c) => c.Name === "up-a")!.State, "created", "made again, not started");
  assert.deepEqual(docker.starts, []);

  // Docker fills the host name in from the container it shares, and the image's ports are the other's.
  const spec = recreation(
    { Id: "abcdef0123456789", Name: "/up-b", Config: { Hostname: "portal-host", Domainname: "d", Image: "img:1", ExposedPorts: { "8080/tcp": {} } }, HostConfig: { NetworkMode: "container:portal" } },
    OLD.Config,
    "img:2",
  );
  assert.deepEqual(spec, { Image: "img:2", HostConfig: { NetworkMode: "container:portal" } });
  // On its own network, a host name it was given stays, and one Docker gave it (the start of its id) does not.
  assert.equal((recreation({ Id: "abcdef0123456789", Name: "/up-b", Config: { Hostname: "mine" }, HostConfig: {} }, undefined, "img:2") as any).Hostname, "mine");
  assert.equal((recreation({ Id: "abcdef0123456789", Name: "/up-b", Config: { Hostname: "abcdef012345" }, HostConfig: {} }, undefined, "img:2") as any).Hostname, undefined);
});

test("where the download fails, or the new container cannot be made or started, the container is as it was, and runs", async () => {
  images();
  const { d, person } = wanting(VOICE, "img:2");
  await d.containers.create("up-a", { Image: "img:1" });
  await d.containers.start("up-a");
  const before = docker.containers.find((c) => c.Name === "up-a")!;

  docker.failing.set("img:2", "pull access denied for img");
  await person.updateImage("up-a");
  let row = await ended(person, "up-a");
  assert.match(row.update.error, /pull access denied for img/);
  assert.deepEqual([docker.renames, docker.created.length, before.State, before.Name], [[], 1, "running", "up-a"], "nothing was touched");

  // Downloaded, but the new one does not start: it is taken away again, and the old one has its name and runs again.
  docker.failing.clear();
  docker.runs.refuseStart = (c) => (c.Image === "img:2" ? "failed to create task: exec: no such file" : undefined);
  await person.updateImage("up-a");
  row = await ended(person, "up-a");
  assert.match(row.update.error, /failed to create task: exec: no such file/);
  assert.deepEqual(docker.containers.map((c) => [c.Name, c.Image, c.State]), [["up-a", "img:1", "running"]]);
  assert.equal(docker.containers[0], before);
  assert.deepEqual(docker.renames, [
    { from: "up-a", to: "up-a-before-update" },
    { from: "up-a-before-update", to: "up-a" },
  ]);
  assert.equal(row.imageWarning.kind, "other", "and it still says it is outdated");

  // One the daemon refuses to make (on a network that is not the extension's) is refused before the old one is stopped.
  docker.runs.refuseStart = undefined;
  docker.renames.length = 0;
  docker.networks.push({ Id: "net-other00", Name: "up-theirs", Labels: { [OWNER_LABEL]: "pithagoras-browser" } });
  Object.assign(before, { HostConfig: { NetworkMode: "up-theirs" } });
  await person.updateImage("up-a");
  row = await ended(person, "up-a");
  assert.match(row.update.error, /would be on up-theirs/);
  assert.equal(before.State, "running");
  assert.equal(before.Name, "up-a");
});

test("an update is refused where there is nothing to update, where the extension says the container is in use, where another container shares its network, and while one is under way; a leftover of an unfinished one stops it", async () => {
  images();
  let busy: string | undefined;
  const { d, person } = wanting(VOICE, "img:2", () => ({ busy }));
  await d.containers.create("up-a", { Image: "img:2" });
  await d.containers.create("up-b", { Image: "img:1" });
  await d.containers.start("up-b");
  docker.images.add("img:2");

  await assert.rejects(person.updateImage("up-a"), /up-a runs the image its extension wants/);
  await assert.rejects(person.updateImage("up-none"), /There is no container up-none of an extension's/);
  busy = "its setup is running";
  await assert.rejects(person.updateImage("up-b"), /up-b is in use: its setup is running/);
  assert.deepEqual([docker.pulls, docker.renames], [[], []]);
  busy = undefined;

  docker.containers.push({ Id: "sharer000000", Name: "sharer", Image: "x", State: "running", Labels: {}, Tty: false, out: "", err: "", HostConfig: { NetworkMode: "container:up-b" } });
  await assert.rejects(person.updateImage("up-b"), /sharer shares the network of up-b, which it would lose: remove it first/);
  docker.containers.splice(docker.containers.findIndex((c) => c.Name === "sharer"), 1);

  // Under way: a second request for the same container is refused, and one for another goes on.
  let release!: () => void;
  docker.images.delete("img:2");
  docker.hold.pull = new Promise<void>((resolve) => (release = resolve));
  await person.updateImage("up-b");
  await assert.rejects(person.updateImage("up-b"), /up-b is being updated already/);
  const going = ((await person.overview()) as any).containers.find((c: any) => c.name === "up-b");
  assert.equal(going.update.active, true);
  release();
  await ended(person, "up-b");

  // A container left by an update that did not finish holds the name the old one is renamed to.
  await d.containers.create("up-c", { Image: "img:1" });
  await d.containers.create("up-c-before-update", { Image: "img:1" });
  await person.updateImage("up-c");
  const row = await ended(person, "up-c");
  assert.match(row.update.error, /up-c-before-update is there already, left by an update that did not finish/);
  assert.deepEqual(docker.containers.map((c) => c.Name).sort(), ["up-a", "up-b", "up-c", "up-c-before-update"]);
});

test("the page's route starts an update and answers at once; Docker's overview tells how the image stands and how the update goes; refusals are 409, and a container nobody's is not its to update", async () => {
  images();
  const given: ((consumer: { name: string }) => unknown)[] = [];
  const router = express.Router();
  serverHalf({
    extension: "pithagoras-docker",
    dataDir,
    provide: (factory: (consumer: { name: string }) => unknown) => given.push(factory),
    router,
    chats: { extend: () => {}, folder: () => dataDir() },
    files: { inside: (base: string, rel: string) => path.join(base, rel) },
  } as never);
  const voice = given[0]({ name: VOICE }) as Docker;
  voice.containers.wantImage((c) => (c.name === "up-a" ? { image: "img:2" } : undefined));
  await voice.containers.create("up-a", { Image: "img:1" });
  await voice.containers.start("up-a");
  docker.containers.push({ Id: "hand000000000", Name: "up-by-hand", Image: "img:1", State: "running", Labels: {}, Tty: false, out: "", err: "" });

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
    const first = (await call("GET", "/overview")).body.containers.find((c: any) => c.name === "up-a");
    assert.deepEqual(first.imageWarning, { kind: "other", running: "img:1", wanted: "img:2" });
    assert.equal(first.update, undefined);

    let release!: () => void;
    docker.hold.pull = new Promise<void>((resolve) => (release = resolve));
    assert.deepEqual(await call("POST", "/containers/up-a/update"), { status: 202, body: { ok: true } });
    let going: any;
    for (let i = 0; i < 400 && !/Downloading/.test(going?.update?.line ?? ""); i++) {
      await delay(5);
      going = (await call("GET", "/overview")).body.containers.find((c: any) => c.name === "up-a");
    }
    assert.equal(going.update.active, true);
    assert.match(going.update.line, /Downloading/, "with how the download goes, in Docker's words");
    const again = await call("POST", "/containers/up-a/update");
    assert.deepEqual([again.status, again.body.error], [409, "up-a is being updated already"]);
    release();
    let done: any;
    for (let i = 0; i < 400 && (!done?.update || done.update.active); i++) {
      await delay(5);
      done = (await call("GET", "/overview")).body.containers.find((c: any) => c.name === "up-a");
    }
    assert.deepEqual(done.update, { active: false, line: "", done: { from: "img:1", to: "img:2" } });
    assert.equal(done.imageWarning, undefined);
    const current = await call("POST", "/containers/up-a/update");
    assert.deepEqual([current.status, current.body.error], [409, "up-a runs the image its extension wants"]);
    assert.equal((await call("POST", "/containers/up-by-hand/update")).status, 404, "nobody's: not the page's to act on");
  } finally {
    server.close();
  }
});
