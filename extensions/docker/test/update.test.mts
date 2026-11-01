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
const { pinned, recreation } = await import("../src/update.ts");
const { FORWARDER_IMAGE, FORWARDS_LABEL } = await import("../src/forward.ts");
const { default: serverHalf } = await import("../src/server.ts");
test.after(() => docker.close());

const dataDir = () => mkdtempSync(path.join(os.tmpdir(), "dk-data-"));
const VOICE = "pithagoras-voice";
const SETTLE = 30;

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
  for (const key of Object.keys(docker.runs)) delete (docker.runs as Record<string, unknown>)[key];
  docker.registry.clear();
  delete docker.hold.pull;
});

/** Wants `image` of `name` for the extension, and gives the Docker it is asked through. */
function wanting(who: string, image: string, wanted: (name: string) => Partial<WantedImage> = () => ({})) {
  // The container made again has to stay up for a moment (SETTLE): a short one here.
  const { forExtension, person } = dockerFor(dataDir(), undefined, SETTLE);
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

test("a container is outdated where its extension wants another pinned image; the extension's wish is all that says so", async () => {
  images();
  const { d, forExtension } = wanting(VOICE, "img:2");
  await d.containers.create("up-a", { Image: "img:1", Labels: { "pithagoras.voice-recipe": "x" } });
  const seen: Record<string, string>[] = [];
  d.containers.wantImage((c) => (seen.push(c.labels), c.name === "up-a" ? { image: "img:2", busy: "its setup is running" } : undefined));
  assert.deepEqual(await d.containers.outdated("up-a"), { running: "img:1", wanted: "img:2", busy: "its setup is running" });
  assert.equal(seen.at(-1)!["pithagoras.voice-recipe"], "x", "the wish is asked with the labels the container was made with");

  // The same image under another name is the same image.
  docker.images.add("img:1b");
  docker.imageInfo.set("img:1b", OLD);
  d.containers.wantImage(() => ({ image: "img:1b" }));
  assert.equal(await d.containers.outdated("up-a"), undefined);
  // Wanting the reference it runs, it is current: also when a registry has moved that tag and it was downloaded again (the same version still).
  d.containers.wantImage(() => ({ image: "img:1" }));
  assert.equal(await d.containers.outdated("up-a"), undefined);
  docker.imageInfo.set("img:1", NEW);
  assert.equal(await d.containers.outdated("up-a"), undefined, "a pinned tag that was moved is not another version");
  docker.imageInfo.set("img:1", OLD);
  // A wanted image that is not downloaded yet is not the one it runs.
  d.containers.wantImage(() => ({ image: "img:3" }));
  assert.deepEqual(await d.containers.outdated("up-a"), { running: "img:1", wanted: "img:3" });

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

test("which references are pinned: a tag other than latest, or a digest", () => {
  for (const image of ["redis:8", "ubuntu:22.04", "nvidia/cuda:12.4.1-devel-ubuntu22.04", "localhost:5000/app:2", "ghcr.io/a/b:v1", "app@sha256:" + "a".repeat(64), "app:latest@sha256:" + "a".repeat(64)]) assert.equal(pinned(image), true, image);
  for (const image of ["redis", "redis:latest", "ghcr.io/a/b", "ghcr.io/a/b:latest", "localhost:5000/app", "localhost:5000/app:latest"]) assert.equal(pinned(image), false, image);
});

test("only a pinned image is a warning: a container on another image than a floating one the extension wants is told of nothing, and one on another than a pinned tag or a digest is", async () => {
  images();
  const { d } = wanting(VOICE, "img:2");
  await d.containers.create("up-a", { Image: "img:1" });
  docker.imageInfo.set("img:latest", NEW);
  const warns = async (image: string) => {
    d.containers.wantImage(() => ({ image }));
    return d.containers.outdated("up-a");
  };
  assert.equal(await warns("img"), undefined, "no tag");
  assert.equal(await warns("img:latest"), undefined, "latest, also where it is another image than the one the container runs");
  assert.deepEqual(await warns("img:2"), { running: "img:1", wanted: "img:2" });
  const digest = `img@sha256:${"b".repeat(64)}`;
  assert.deepEqual(await warns(digest), { running: "img:1", wanted: digest });
  // A container made on a pinned image that is now to run a floating one: nothing is pinned any more.
  assert.equal(await warns("img:latest"), undefined);
});

test("a forwarder on another image than the one forwarders are made on is a warning, though no extension said a wish for it", async () => {
  images();
  const { d, person } = wanting(VOICE, "img:2");
  d.containers.wantImage(() => undefined);
  await d.containers.create("up-a-forward", { Image: "node:old", Labels: { [FORWARDS_LABEL]: "up-net" } });
  await d.containers.create("up-b-forward", { Image: "node:old" });
  const rows = ((await person.overview()) as { containers: any[] }).containers;
  assert.deepEqual(rows.find((c) => c.name === "up-a-forward").imageWarning, { running: "node:old", wanted: FORWARDER_IMAGE });
  assert.equal(rows.find((c) => c.name === "up-b-forward").imageWarning, undefined, "a container by that name that is no forwarder is not one");
  docker.images.add(FORWARDER_IMAGE);
  await d.containers.create("up-c-forward", { Image: FORWARDER_IMAGE, Labels: { [FORWARDS_LABEL]: "up-net" } });
  assert.equal(await d.containers.outdated("up-c-forward"), undefined, "and one on that image is as wanted");
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
  assert.equal(row.imageWarning.wanted, "img:2", "and it still says it is outdated");

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
    assert.deepEqual(first.imageWarning, { running: "img:1", wanted: "img:2" });
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
    for (let i = 0; i < 1200 && (!done?.update || done.update.active); i++) {
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

/** An image a chat's agent built under a reference: it carries the label the agent's builds get. */
const BUILT: FakeImage = { Id: "sha256:built", Config: { Entrypoint: ["/evil"], Labels: { [OWNER_LABEL]: "pithagoras-docker" } } };
const STAYS = () => new Promise<void>(() => {});

test("what was checked before the download is checked again before the swap: a container replaced meanwhile, a wish that changed, or one that is in use now ends the update, and the other container is untouched", async () => {
  images();
  let wish = "img:2";
  let busy: string | undefined;
  const { d, person, forExtension } = wanting(VOICE, "img:2");
  d.containers.wantImage((c) => (c.name.startsWith("up-") ? { image: wish, busy } : undefined));
  const hold = () => {
    docker.images.delete("img:2");
    let release!: () => void;
    docker.hold.pull = new Promise<void>((resolve) => (release = resolve));
    return release;
  };
  const going = async (name: string) => {
    for (let i = 0; i < 400 && !docker.pulls.length; i++) await delay(5);
    assert.ok(docker.pulls.length, `the download for ${name} began`);
  };

  // Another extension's container takes the name while the image is downloaded.
  await d.containers.create("up-a", { Image: "img:1" });
  await d.containers.start("up-a");
  let release = hold();
  await person.updateImage("up-a");
  await going("up-a");
  await d.containers.remove("up-a");
  const other = forExtension("pithagoras-browser");
  await other.containers.create("up-a", { Image: "img:1", Env: ["SECRET=of-other"] });
  release();
  let row = await ended(person, "up-a");
  assert.match(row.update.error, /up-a was replaced while the image was downloaded/);
  const theirs = docker.containers.find((c) => c.Name === "up-a")!;
  assert.equal(theirs.Labels[OWNER_LABEL], "pithagoras-browser", "still the other extension's, not made again as Voice's");
  assert.deepEqual((theirs.made as any).Env, ["SECRET=of-other"]);
  assert.deepEqual(docker.renames, []);

  // The extension wants another image when the download ends.
  docker.containers.length = 0;
  docker.pulls.length = 0;
  await d.containers.create("up-b", { Image: "img:1" });
  release = hold();
  await person.updateImage("up-b");
  await going("up-b");
  wish = "img:3";
  release();
  row = await ended(person, "up-b");
  assert.match(row.update.error, /up-b's extension wants img:3 now, not img:2/);
  assert.deepEqual(docker.renames, []);

  // It is in use when the download ends (a setup began).
  wish = "img:2";
  docker.pulls.length = 0;
  docker.images.delete("img:2");
  release = hold();
  await person.updateImage("up-b");
  await going("up-b");
  busy = "its setup is running";
  release();
  row = await ended(person, "up-b");
  assert.match(row.update.error, /up-b is in use now: its setup is running/);
  assert.deepEqual(docker.renames, []);
});

test("while the containers are swapped, the extension and the page cannot make, start, stop or remove them", async () => {
  images();
  const { forExtension, person } = dockerFor(dataDir(), undefined, 300);
  const d = forExtension(VOICE);
  d.containers.wantImage((c) => (c.name.startsWith("up-") ? { image: "img:2" } : undefined));
  docker.images.add("img:2");
  await d.containers.create("up-a", { Image: "img:1" });
  await d.containers.start("up-a");
  docker.runs.onStart = STAYS;
  await person.updateImage("up-a");
  for (let i = 0; i < 400 && docker.starts.length < 2; i++) await delay(2);
  assert.equal(docker.starts.length, 2, "the new container is started and settling");
  const refused = /is being updated: wait until that is done/;
  await assert.rejects(d.containers.create("up-a", { Image: "img:1" }), refused);
  await assert.rejects(d.containers.remove("up-a"), refused);
  await assert.rejects(d.containers.stop("up-a"), refused);
  await assert.rejects(d.containers.start("up-a"), refused);
  await assert.rejects(person.remove("up-a"), refused);
  await assert.rejects(person.stop("up-a"), refused);
  await assert.rejects(d.containers.remove("up-a-before-update"), refused);
  await ended(person, "up-a");
  // And the name is free again.
  await d.containers.stop("up-a");
});

test("the update is told as failed only where the container is as it was; where only the old container could not be removed it is done, and where it could not be named back the row it is on says so", async () => {
  images();
  const { d, person } = wanting(VOICE, "img:2");
  docker.images.add("img:2");
  await d.containers.create("up-a", { Image: "img:1" });
  await d.containers.start("up-a");
  docker.runs.onStart = STAYS;
  const old = docker.containers.find((c) => c.Name === "up-a")!;
  docker.runs.refuseRemove = (c) => (c === old ? "removal of the container is already in progress" : undefined);
  await person.updateImage("up-a");
  let row = await ended(person, "up-a");
  assert.deepEqual(row.update, { active: false, line: "", done: { from: "img:1", to: "img:2" }, leftover: "up-a-before-update" });
  assert.equal(row.imageWarning, undefined);
  assert.deepEqual(docker.containers.map((c) => [c.Name, c.Image, c.State]).sort(), [["up-a", "img:2", "running"], ["up-a-before-update", "img:1", "exited"]]);

  // The new one does not stay up, and the old one cannot be named back: it is told on the old one's row.
  docker.runs.refuseRemove = undefined;
  docker.containers.length = 0;
  await d.containers.create("up-b", { Image: "img:1" });
  await d.containers.start("up-b");
  docker.runs.onStart = async (c) => {
    if (c.Image === "img:2") await delay(5);
    else await STAYS();
  };
  docker.runs.refuseRename = (_c, to) => (to === "up-b" ? "rename failed" : undefined);
  await person.updateImage("up-b");
  row = await ended(person, "up-b-before-update");
  assert.equal(row.update.stranded, true);
  assert.match(row.update.error, /did not stay up on img:2.* It is still named up-b-before-update\./);
  assert.equal(((await person.overview()) as any).containers.find((c: any) => c.name === "up-b"), undefined, "no row of the name it lost");
});

test("a container made again that does not stay up is taken away and the old one runs again; one that stays up is done", async () => {
  images();
  const { d, person } = wanting(VOICE, "img:2");
  docker.images.add("img:2");
  await d.containers.create("up-a", { Image: "img:1" });
  await d.containers.start("up-a");
  const old = docker.containers.find((c) => c.Name === "up-a")!;
  // It starts, and its command fails a moment later.
  docker.runs.onStart = async (c) => {
    if (c.Image === "img:2") await delay(5);
    else await STAYS();
  };
  await person.updateImage("up-a");
  const row = await ended(person, "up-a");
  assert.match(row.update.error, /up-a did not stay up on img:2: it exited, exit code 0/);
  assert.deepEqual(docker.containers.map((c) => [c.Name, c.Image, c.State]), [["up-a", "img:1", "running"]]);
  assert.equal(docker.containers[0], old);
  assert.equal(row.imageWarning.wanted, "img:2");

  docker.runs.onStart = STAYS;
  await person.updateImage("up-a");
  assert.deepEqual((await ended(person, "up-a")).update, { active: false, line: "", done: { from: "img:1", to: "img:2" } });
});

test("a container with an entrypoint of its own keeps its command, even where it is the old image's; a volume of the mount API with no source stays mounted", () => {
  const old = (config: Record<string, unknown>, host: Record<string, unknown> = {}, mounts: Record<string, unknown>[] = []) => ({ Id: "abcdef0123456789", Name: "/up-b", Config: { Image: "img:1", ...config }, HostConfig: host, Mounts: mounts }) as never;
  const image = { Cmd: ["serve"], Entrypoint: ["/image-entry"] };
  const own = recreation(old({ Entrypoint: ["/run.sh"], Cmd: ["serve"] }), image, "img:2") as any;
  assert.deepEqual([own.Entrypoint, own.Cmd], [["/run.sh"], ["serve"]]);
  // Both from the old image: the new image's.
  const both = recreation(old({ Entrypoint: ["/image-entry"], Cmd: ["serve"] }), image, "img:2") as any;
  assert.deepEqual([both.Entrypoint, both.Cmd], [undefined, undefined]);
  // Only the command of its own over the image's entrypoint.
  const cmd = recreation(old({ Entrypoint: ["/image-entry"], Cmd: ["other"] }), image, "img:2") as any;
  assert.deepEqual([cmd.Entrypoint, cmd.Cmd], [undefined, ["other"]]);

  const mounted = recreation(
    old({}, { Mounts: [{ Type: "volume", Target: "/data" }, { Type: "volume", Source: "named", Target: "/named" }, { Type: "tmpfs", Target: "/tmp" }] }, [
      { Type: "volume", Name: "anon123", Destination: "/data", RW: true },
      { Type: "volume", Name: "named", Destination: "/named", RW: true },
    ]),
    undefined,
    "img:2",
  ) as any;
  assert.deepEqual(mounted.HostConfig.Mounts, [{ Type: "volume", Source: "anon123", Target: "/data" }, { Type: "volume", Source: "named", Target: "/named" }, { Type: "tmpfs", Target: "/tmp" }]);
  assert.equal(mounted.HostConfig.Binds, undefined, "and not mounted a second time by a bind");
});

test("an image a chat's build holds a reference with is not the downloaded one: no warning from it for the reference the container runs, and an update downloads the image, and makes the container on that", async () => {
  images();
  const { d, person } = wanting(VOICE, "img:1");
  await d.containers.create("up-a", { Image: "img:1" });
  await d.containers.start("up-a");
  // The agent's build took the reference over.
  docker.imageInfo.set("img:1", BUILT);
  assert.equal(await d.containers.outdated("up-a"), undefined);

  // The wanted reference is held by a build; the registry's image is what a download brings.
  d.containers.wantImage(() => ({ image: "img:2" }));
  docker.images.add("img:2");
  docker.imageInfo.set("img:2", BUILT);
  docker.registry.set("img:2", NEW);
  assert.deepEqual(await d.containers.outdated("up-a"), { running: "img:1", wanted: "img:2" }, "not downloaded, as far as the extension is concerned");
  docker.runs.onStart = STAYS;
  await person.updateImage("up-a");
  const row = await ended(person, "up-a");
  assert.deepEqual(row.update.done, { from: "img:1", to: "img:2" });
  assert.deepEqual(docker.pulls, ["img:2"], "it was downloaded although a reference of that name was there");
  assert.equal(docker.containers.find((c) => c.Name === "up-a")!.ImageId, NEW.Id);
  assert.equal((docker.containers.find((c) => c.Name === "up-a")!.made as any).Entrypoint, undefined);
});

test("a container is made on the image that was checked: where the reference points to another one at the moment it is made, the update fails and the old container runs", async () => {
  images();
  const { d, person } = wanting(VOICE, "img:2");
  docker.images.add("img:2");
  await d.containers.create("up-a", { Image: "img:1" });
  await d.containers.start("up-a");
  docker.runs.onStart = STAYS;
  docker.runs.beforeCreate = (body) => {
    if (body.Image === "img:2") docker.imageInfo.set("img:2", { ...BUILT, Id: "sha256:tagged-meanwhile", Config: {} });
  };
  await person.updateImage("up-a");
  const row = await ended(person, "up-a");
  assert.match(row.update.error, /img:2 is another image now than the one that was downloaded/);
  assert.deepEqual(docker.containers.map((c) => [c.Name, c.Image, c.State]), [["up-a", "img:1", "running"]]);
});

test("a wish is an object with an image: a promise (from an isolated half), no image, or a busy that is no text is no wish, and a rejecting promise is not left unheard", async () => {
  images();
  const { d } = wanting(VOICE, "img:2");
  await d.containers.create("up-a", { Image: "img:1" });
  const unheard: unknown[] = [];
  const onUnhandled = (reason: unknown) => unheard.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    d.containers.wantImage((() => Promise.reject(new Error("released"))) as never);
    assert.equal(await d.containers.outdated("up-a"), undefined);
    d.containers.wantImage((() => Promise.resolve({ image: "img:2" })) as never);
    assert.equal(await d.containers.outdated("up-a"), undefined);
    for (const bad of [{ image: "" }, { image: 5 }, {}, { image: "img:2", busy: 1 }, "img:2"]) {
      d.containers.wantImage((() => bad) as never);
      assert.equal(await d.containers.outdated("up-a"), undefined, JSON.stringify(bad));
    }
    await delay(20);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
  assert.deepEqual(unheard, []);
});

test("another extension's container by the name an update waits under does not stop the update: the old one waits under another name", async () => {
  images();
  const { d, person, forExtension } = wanting(VOICE, "img:2");
  docker.images.add("img:2");
  docker.runs.onStart = STAYS;
  await d.containers.create("up-c", { Image: "img:1" });
  await d.containers.start("up-c");
  await forExtension("pithagoras-browser").containers.create("up-c-before-update", { Image: "img:1" });
  docker.containers.push({ Id: "hand000000000", Name: "up-c-before-update-by-hand", Image: "img:1", State: "exited", Labels: {}, Tty: false, out: "", err: "" });
  await person.updateImage("up-c");
  const row = await ended(person, "up-c");
  assert.deepEqual(row.update.done, { from: "img:1", to: "img:2" });
  assert.match(docker.renames[0].to, /^up-c-before-update-[0-9a-f]{6}$/);
  assert.equal(docker.containers.find((c) => c.Name === "up-c-before-update")?.Labels[OWNER_LABEL], "pithagoras-browser", "theirs is untouched");
  assert.equal(docker.containers.find((c) => c.Name === "up-c")!.Image, "img:2");
});
