/**
 * Unit tests for src/container.ts: DS container lifecycle over a MOCK Docker (object literal cast as Docker) that
 * records every call, plus real tmp dirs for settings/jwt-secret/ds.json/user-stopped. The mock never reaches the
 * socket and nothing here reaches portal() -- docker and root are always passed explicitly.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ContainerInfo, Docker, ExecResult, VolumeInfo } from "../../docker/src/api";
import { DS_NAME, DS_VOLUME, ensureContainer, lookAfter, readDsRecord, status, stopContainer, userStopped } from "../src/container";

const DEFAULT_TAG = "onlyoffice/documentserver:10.0";
const TAG92 = "onlyoffice/documentserver:9.2";

function tmpRoot(withSettings?: Record<string, unknown>, secret = "s3cret\n"): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "office-container-"));
  if (withSettings) fs.writeFileSync(path.join(root, "settings.json"), JSON.stringify({ enabled: false, imageTag: DEFAULT_TAG, coEdit: true, ...withSettings }));
  else fs.writeFileSync(path.join(root, "settings.json"), JSON.stringify({ enabled: false, imageTag: DEFAULT_TAG, coEdit: true }));
  if (secret !== null) fs.writeFileSync(path.join(root, "jwt-secret"), secret);
  return root;
}

type MockState = {
  availableFlag: boolean;
  networkMode: string;
  container: ContainerInfo | undefined;
  volumes: VolumeInfo[];
  inspectBody: Record<string, unknown> | undefined;
  execResult: ExecResult;
};

function makeDocker(opts: { networkMode?: string } = {}) {
  const state: MockState = {
    availableFlag: true,
    networkMode: opts.networkMode ?? "host",
    container: undefined,
    volumes: [],
    inspectBody: undefined,
    execResult: { output: "", exitCode: 1, timedOut: false },
  };
  const calls = {
    available: 0,
    ensure: [] as string[],
    get: [] as string[],
    create: [] as Array<[string, Record<string, unknown>]>,
    start: [] as string[],
    stop: [] as string[],
    inspect: [] as string[],
    exec: [] as Array<[string, string[]]>,
    volumeList: 0,
    volumeCreate: [] as string[],
    sharedNetwork: 0,
  };
  const docker = {
    available: async () => {
      calls.available++;
      return state.availableFlag;
    },
    sharedNetwork: async () => {
      calls.sharedNetwork++;
      return state.networkMode;
    },
    images: {
      present: async (image: string) => true,
      ensure: async (image: string, onProgress?: (s: { active: boolean; line: string; error?: string }) => void) => {
        calls.ensure.push(image);
        onProgress?.({ active: true, line: "downloading layers…" });
        onProgress?.({ active: false, line: "done" });
      },
    },
    containers: {
      list: async () => (state.container ? [state.container] : []),
      get: async (name: string) => {
        calls.get.push(name);
        return state.container;
      },
      create: async (name: string, spec: Record<string, unknown>) => {
        calls.create.push([name, spec]);
        const info: ContainerInfo = { name, id: `cid-${calls.create.length}`, image: String(spec.Image), state: "created", status: "Created", owner: "", labels: {} };
        state.container = info;
        return info;
      },
      start: async (name: string) => {
        calls.start.push(name);
        if (state.container && name === DS_NAME) state.container.state = "running";
      },
      stop: async (name: string) => {
        calls.stop.push(name);
        if (state.container && name === DS_NAME) state.container.state = "exited";
      },
      remove: async () => {},
      logs: async () => "",
      inspect: async (name: string) => {
        calls.inspect.push(name);
        return state.inspectBody;
      },
      exec: async (name: string, cmd: string[]) => {
        calls.exec.push([name, cmd]);
        return state.execResult;
      },
      adopt: async () => {
        throw Object.assign(new Error("no container to adopt"), { status: 404 });
      },
    },
    volumes: {
      list: async () => {
        calls.volumeList++;
        return [...state.volumes];
      },
      create: async (name: string) => {
        calls.volumeCreate.push(name);
        state.volumes.push({ name, owner: "" });
      },
      remove: async () => {},
      adopt: async () => {
        throw Object.assign(new Error("no volume to adopt"), { status: 404 });
      },
    },
  } as unknown as Docker;
  return { docker, calls, state };
}

async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timed out waiting for lookAfter");
    await new Promise((r) => setTimeout(r, 10));
  }
}

/* ---------------- ensure: the fresh path ---------------- */

test("ensure (fresh): pulls image with progress, creates volume + container host-networked with exact JWT env, starts, writes ds.json", async () => {
  const root = tmpRoot({ enabled: true, imageTag: TAG92 }); // tag comes from settings, not a constant
  const m = makeDocker();

  const seen: Array<{ active: boolean; line: string }> = [];
  const res = await ensureContainer(m.docker, (s) => seen.push({ active: s.active, line: s.line }), root);
  assert.deepEqual(res, { started: true });

  // image ensured exactly once, with the settings tag, and onPull progress captured end-to-end
  assert.deepEqual(m.calls.ensure, [TAG92]);
  assert.deepEqual(seen, [
    { active: true, line: "downloading layers…" },
    { active: false, line: "done" },
  ]);

  // volume created exactly once, from an empty list
  assert.equal(m.calls.volumeList, 1);
  assert.deepEqual(m.calls.volumeCreate, [DS_VOLUME]);
  assert.ok(m.state.volumes.some((v) => v.name === DS_VOLUME));

  // container created under the exact name with the spec the contract fixes (no Memory cap -- plan says 4 GB
  // recommended, no enforced limit; NetworkMode from sharedNetwork(); the volume bound at the DS data path)
  assert.equal(m.calls.create.length, 1);
  const [name, spec] = m.calls.create[0];
  assert.equal(name, DS_NAME);
  assert.equal(spec.Image, TAG92);
  assert.deepEqual(spec.HostConfig, {
    NetworkMode: "host",
    Binds: [`${DS_VOLUME}:/var/www/onlyoffice/Data`],
  });
  // the JWT env is exactly the four documented vars; the secret is the trimmed content of root/jwt-secret
  assert.deepEqual(spec.Env, [
    "JWT_ENABLED=true",
    "JWT_SECRET=s3cret",
    "JWT_HEADER=X-Auth-Token",
    "JWT_IN_BODY=false",
  ]);

  // started once, by name
  assert.deepEqual(m.calls.start, [DS_NAME]);

  // ds.json: id from the create result, host origin, the tag; single source of truth readable back
  const ds = JSON.parse(fs.readFileSync(path.join(root, "ds.json"), "utf8"));
  assert.deepEqual(ds, { containerId: "cid-1", origin: "http://127.0.0.1", imageTag: TAG92 });
  assert.deepEqual(readDsRecord(root), ds);

  // pull state is module-level in-memory and now surfaced by status() (also: container is running there)
  const s = await status(m.docker, root);
  assert.equal(s.state, "running");
  assert.deepEqual(s.pull, { active: false, line: "done" });
});

/* ---------------- ensure: adopt path ---------------- */

test("ensure (already running): {started:false}, no create/start, volume not re-created, ds.json stays consistent", async () => {
  const root = tmpRoot({ enabled: true, imageTag: TAG92 });
  const m = makeDocker();
  await ensureContainer(m.docker, undefined, root); // first pass fills the mock
  assert.equal(m.state.container?.state, "running");
  const before = fs.readFileSync(path.join(root, "ds.json"), "utf8");

  const res = await ensureContainer(m.docker, undefined, root);
  assert.deepEqual(res, { started: false });
  assert.equal(m.calls.create.length, 1); // not created again
  assert.equal(m.calls.start.length, 1); // and never restarted
  assert.equal(m.calls.volumeCreate.length, 1); // volume not duplicated on the second call
  assert.equal(m.state.volumes.filter((v) => v.name === DS_VOLUME).length, 1);
  assert.equal(fs.readFileSync(path.join(root, "ds.json"), "utf8"), before); // ds.json kept consistent
});

test("ensure (container-mode origin): networkMode container:<id> is recorded verbatim in ds.json", async () => {
  const root = tmpRoot();
  const m = makeDocker({ networkMode: "container:9f3a1c2d" });
  await ensureContainer(m.docker, undefined, root);
  const ds = JSON.parse(fs.readFileSync(path.join(root, "ds.json"), "utf8"));
  assert.equal(ds.origin, "container:9f3a1c2d"); // marker string a later wave turns into a URL
  const [name, spec] = m.calls.create[0];
  assert.equal(name, DS_NAME);
  assert.equal((spec.HostConfig as Record<string, unknown>).NetworkMode, "container:9f3a1c2d");
});

test("ensure (docker unavailable): throws the no_docker error code", async () => {
  const root = tmpRoot();
  const m = makeDocker();
  m.state.availableFlag = false;
  await assert.rejects(ensureContainer(m.docker, undefined, root), (e: Error & { code?: string }) => e.code === "no_docker");
  assert.deepEqual(m.calls.ensure, []); // nothing was attempted past the guard
});

test("ensure (missing jwt-secret): the plain fs error surfaces", async () => {
  const root = tmpRoot(undefined, null); // no secret file written
  const m = makeDocker();
  await assert.rejects(ensureContainer(m.docker, undefined, root), /ENOENT/);
});

/* ---------------- stop + user-stopped intent ---------------- */

test("stop: containers.stop called + intent recorded; lookAfter stays quiet; ensure (user start) clears the intent", async () => {
  const root = tmpRoot({ enabled: true });
  const m = makeDocker();
  await ensureContainer(m.docker, undefined, root); // now running

  await stopContainer(m.docker, root);
  assert.deepEqual(m.calls.stop, [DS_NAME]);
  assert.ok(fs.existsSync(path.join(root, "user-stopped")), "intent marker file written");
  assert.equal(userStopped(root), true);

  // lookAfter must NOT ensure/revive while the intent is set (the mock already flipped it to exited on stop)
  lookAfter(m.docker, root);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(m.calls.ensure.length, 1); // still only the first pass' pull -- no revive attempt
  assert.equal(m.calls.start.length, 1);

  // clearing path: an explicit ensure is a user start request -> starts it and removes the marker
  const res = await ensureContainer(m.docker, undefined, root);
  assert.deepEqual(res, { started: true });
  assert.equal(userStopped(root), false);
  assert.equal(fs.existsSync(path.join(root, "user-stopped")), false);
  assert.equal(m.calls.start.length, 2);
});

test("stop (no container yet): intent still recorded, no stop call", async () => {
  const root = tmpRoot();
  const m = makeDocker();
  await stopContainer(m.docker, root);
  assert.deepEqual(m.calls.stop, []);
  assert.equal(userStopped(root), true);
});

/* ---------------- lookAfter ---------------- */

test("lookAfter (settings disabled): no ensure", async () => {
  const root = tmpRoot({ enabled: false }); // default
  const m = makeDocker();
  lookAfter(m.docker, root);
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(m.calls.ensure, []);
  assert.deepEqual(m.calls.create, []);
});

test("lookAfter (enabled + stopped container): ensures -- pulls, adopts by id, starts", async () => {
  const root = tmpRoot({ enabled: true });
  const m = makeDocker();
  // a made-and-exited container by that name: adopted, not recreated
  m.state.container = { name: DS_NAME, id: "cid-adopted", image: DEFAULT_TAG, state: "exited", status: "Exited (0)", owner: "", labels: {} };

  lookAfter(m.docker, root);
  await until(() => m.calls.start.length === 1);
  assert.deepEqual(m.calls.ensure, [DEFAULT_TAG]); // default settings tag
  assert.equal(m.calls.create.length, 0); // existing container reused
  const ds = JSON.parse(fs.readFileSync(path.join(root, "ds.json"), "utf8"));
  assert.deepEqual(ds, { containerId: "cid-adopted", origin: "http://127.0.0.1", imageTag: DEFAULT_TAG });
});

test("lookAfter (user-stopped): not called at all", async () => {
  const root = tmpRoot({ enabled: true });
  fs.writeFileSync(path.join(root, "user-stopped"), "");
  const m = makeDocker();
  lookAfter(m.docker, root);
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(m.calls.ensure, []);
  assert.equal(userStopped(root), true); // untouched
});

/* ---------------- status ---------------- */

test("status (absent container): stopped", async () => {
  const root = tmpRoot();
  const m = makeDocker();
  const s = await status(m.docker, root);
  assert.equal(s.state, "stopped");
  assert.equal(s.version, undefined);
  assert.equal(s.memBytes, undefined);
});

test("status (running with inspect): running + version from the GitVersion exec probe + memBytes", async () => {
  const root = tmpRoot();
  const m = makeDocker();
  m.state.container = { name: DS_NAME, id: "cid-run", image: DEFAULT_TAG, state: "running", status: "Up 3 hours", owner: "", labels: {} };
  m.state.inspectBody = { State: { Status: "running", Running: true }, Memory: 419_430_400 };
  m.state.execResult = { output: JSON.stringify({ DocEditorVersion: "10.0.1" }), exitCode: 0, timedOut: false };

  const s = await status(m.docker, root);
  assert.equal(s.state, "running");
  assert.equal(s.version, "10.0.1");
  assert.equal(s.memBytes, 419_430_400);
  // the exact probe: cat of the build file in the DS container
  assert.deepEqual(m.calls.exec, [[DS_NAME, ["cat", "/var/www/onlyoffice/documentserver/GitVersion.json"]]]);
});

test("status (exited by inspect): stopped; starting flag honored", async () => {
  const m = makeDocker();
  m.state.container = { name: DS_NAME, id: "cid-x", image: DEFAULT_TAG, state: "running", status: "Up 0 seconds", owner: "", labels: {} };
  m.state.inspectBody = { State: { Status: "running", Starting: true } };
  const s1 = await status(m.docker);
  assert.equal(s1.state, "starting");

  m.state.inspectBody = { State: { Status: "exited" } };
  const s2 = await status(m.docker);
  assert.equal(s2.state, "stopped");
});

test("status (docker unavailable): stopped, no probe attempted", async () => {
  const m = makeDocker();
  m.state.availableFlag = false;
  const s = await status(m.docker);
  assert.equal(s.state, "stopped");
  assert.deepEqual(m.calls.get, []);
});
