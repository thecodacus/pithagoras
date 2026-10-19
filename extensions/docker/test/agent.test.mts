import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fakeDocker, type FakeContainer } from "./fake-docker.ts";

// Docker for a chat's agent (src/agent.ts, src/compose.ts, src/host-paths.ts), against a daemon of the tests' own. compose
// itself is played by `compose` below: it makes in the daemon what the real one would make of the project it is given.
const docker = await fakeDocker();
process.env.DOCKER_SOCKET = docker.socket;
const { agentDocker, FOLDER_LABEL, projectName } = await import("../src/agent.ts");
const { composeRunner, RUNNER_IMAGE } = await import("../src/compose.ts");
const { hostPaths, ownContainer } = await import("../src/host-paths.ts");
const { OWNER_LABEL } = await import("../src/docker.ts");
test.after(() => docker.close());

const OWNER = "pithagoras-docker";
const folderFor = () => realpathSync(mkdtempSync(path.join(os.tmpdir(), "dk-chat-")));

/** `portal.files.inside`, as far as these tests need it: inside `base`, with every link along the way followed. */
function inside(base: string, rel: string): string {
  const resolved = path.resolve(base, rel);
  let existing = resolved;
  const rest: string[] = [];
  while (!existsSync(existing) && !(() => { try { return lstatSync(existing).isSymbolicLink(); } catch { return false; } })()) {
    rest.unshift(path.basename(existing));
    existing = path.dirname(existing);
  }
  const real = path.join(realpathSync(existing), ...rest);
  if (real !== base && !real.startsWith(`${base}${path.sep}`)) throw new Error("That path leads outside the folder");
  return real;
}

type Call = { args: string[]; input?: string; folder: string; as?: { uid: number; gid: number; groups: number[] } };
/**
 * compose, as the real one does it to the daemon: `config` reads the file (here, what the test says it says, or the
 * project it was given), `up --no-start` makes each service's container (with what the test says Docker made of it),
 * its networks and its built images, and `up --detach` starts them.
 */
function compose(says: { config?: unknown; made?: Record<string, Partial<FakeContainer>> } = {}) {
  const calls: Call[] = [];
  const runner = async (args: string[], options: { folder: string; input?: string; as?: unknown }) => {
    calls.push({ args, input: options.input, folder: options.folder, ...(options.as ? { as: options.as as Call["as"] } : {}) });
    const project = args[args.indexOf("-p") + 1];
    if (args.includes("config")) {
      const read = options.input ? JSON.parse(options.input) : (says.config as any);
      // compose's own network for the project, which it names in what it read.
      return { code: 0, stdout: JSON.stringify({ ...read, networks: { default: { name: `${project}_default` }, ...read.networks } }), stderr: "" };
    }
    const given = JSON.parse(options.input!);
    if (args.includes("--no-start")) {
      for (const [name, network] of Object.entries<any>(given.networks ?? {})) {
        if (docker.networks.some((n) => n.Id === `${project}_${name}`)) continue;
        docker.networks.push({ Id: `${project}_${name}`, Name: `${project}_${name}`, Labels: { ...network.labels, "com.docker.compose.project": project } });
      }
      for (const [service, spec] of Object.entries<any>(given.services)) {
        const name = `${project}-${service}-1`;
        const old = docker.containers.findIndex((c) => c.Name === name);
        if (old >= 0) docker.containers.splice(old, 1);
        if (spec.build) docker.built.push({ Id: `sha256:${project}-${service}`, Labels: { ...spec.build.labels, "com.docker.compose.project": project } });
        docker.containers.push({
          Id: `${project}-${service}-id`, Name: name, Image: spec.image ?? `${project}-${service}`, State: "created", Tty: false, out: "", err: "",
          Labels: { ...spec.labels, "com.docker.compose.project": project, "com.docker.compose.service": service, "com.docker.compose.depends_on": Object.keys(spec.depends_on ?? {}).map((d) => `${d}:service_started:false`).join(",") },
          Networks: { [`${project}_default`]: {} },
          // As Docker makes them of what the service says.
          ...(spec.user ? { User: spec.user } : {}),
          HostConfig: { ...(spec.group_add ? { GroupAdd: spec.group_add.map(String) } : {}), ...(spec.security_opt ? { SecurityOpt: spec.security_opt } : {}) },
          ...says.made?.[service],
        });
      }
      return { code: 0, stdout: "", stderr: " Container made\n" };
    }
    for (const c of docker.containers) if (c.Labels["com.docker.compose.project"] === project && c.State === "created") c.State = "running";
    return { code: 0, stdout: "", stderr: "" };
  };
  return { calls, runner };
}

const agentFor = (runner: any, onHost = async (p: string) => p) => agentDocker({ owner: OWNER, runner, onHost, inside });

test("a compose file's containers are made, read back, started, and the folder's; the agent lists, stops, starts, reads and deletes them, and no others", async () => {
  const folder = folderFor();
  writeFileSync(path.join(folder, "compose.yaml"), "services: {}\n");
  const { calls, runner } = compose({
    config: { services: { web: { image: "nginx", depends_on: { db: {} } }, db: { build: { context: folder } } }, networks: { default: { name: "x_default" } }, volumes: { data: {} } },
    made: { web: { Ports: [{ PrivatePort: 80, PublicPort: 8080, Type: "tcp", IP: "0.0.0.0" }, { PrivatePort: 80, PublicPort: 8080, Type: "tcp", IP: "::" }] } },
  });
  const agent = agentFor(runner)(folder);
  const project = projectName(folder, "compose.yaml");
  const ran = await agent.run("compose.yaml");
  assert.equal(ran.project, project);
  assert.deepEqual(ran.containers.map((c) => [c.name, c.service, c.state, c.ports]), [[`${project}-db-1`, "db", "running", []], [`${project}-web-1`, "web", "running", ["8080->80/tcp"]]]);
  // Read as the file is, then made from what was read, carrying the folder, and started only after.
  assert.deepEqual(calls.map((c) => c.args.filter((a) => !a.startsWith("/") && a !== project)), [
    ["-p", "-f", "config", "--format", "json"],
    ["-p", "--project-directory", "-f", "-", "up", "--no-start", "--build", "--remove-orphans"],
    ["-p", "--project-directory", "-f", "-", "up", "--detach", "--no-recreate", "--no-build"],
  ]);
  assert.equal(calls[0].args[calls[0].args.indexOf("-f") + 1], path.join(folder, "compose.yaml"));
  const labels = { [OWNER_LABEL]: OWNER, [FOLDER_LABEL]: folder };
  const given = JSON.parse(calls[1].input!);
  assert.deepEqual(given.services.web.labels, labels);
  assert.deepEqual(given.services.db.build.labels, labels, "and the image built for it");
  assert.deepEqual([given.networks.default.labels, given.volumes.data.labels], [labels, labels]);
  assert.equal(calls[2].input, calls[1].input, "started as it was made");

  // Another folder's agent sees none of it, and may touch none of it.
  const other = agentFor(runner)(folderFor());
  assert.deepEqual(await other.list(), []);
  for (const touch of [() => other.stop(project), () => other.remove(`${project}-web-1`), () => other.logs(`${project}-db-1`), () => other.start(project)]) {
    await assert.rejects(touch(), /There is no container or project .* of this chat's/);
  }
  // Nor a container nobody made through here, though it be in the folder's project by name.
  docker.containers.push({ Id: "hand", Name: "by-hand", Image: "x", State: "running", Labels: { "com.docker.compose.project": project }, Tty: false, out: "", err: "" });
  assert.equal((await agent.list()).some((c) => c.name === "by-hand"), false);
  await assert.rejects(agent.stop("by-hand"), /There is no container or project by-hand/);
  docker.containers.splice(docker.containers.findIndex((c) => c.Name === "by-hand"), 1);

  // A project by its name, or one container.
  assert.deepEqual((await agent.stop(project)).stopped.sort(), [`${project}-db-1`, `${project}-web-1`]);
  docker.starts.length = 0;
  await agent.start(project);
  assert.deepEqual(docker.starts, [`${project}-db-1`, `${project}-web-1`], "what a container needs, first");
  Object.assign(docker.containers.find((c) => c.Name === `${project}-web-1`)!, { out: "listening\n" });
  assert.deepEqual(await agent.logs(`${project}-web-1`), { text: "listening\n" });
  assert.deepEqual((await agent.logs(project)).containers?.map((c: { name: string }) => c.name), [`${project}-db-1`, `${project}-web-1`]);

  // Deleted: one container, and the project goes on; the last, and what was made for it goes too, but its volumes.
  docker.volumes.push({ Name: `${project}_data`, Labels: { ...labels, "com.docker.compose.project": project } });
  await agent.remove(`${project}-web-1`);
  assert.equal(docker.networks.length, 1, "the project still has a container");
  assert.deepEqual(await agent.remove(project), { deleted: [`${project}-db-1`] });
  assert.deepEqual([docker.networks, docker.built], [[], []]);
  assert.equal(docker.volumes.length, 1, "what it holds is kept, unless asked");
  docker.volumes.length = 0;
});

test("a project is deleted with its volumes where asked", async () => {
  const folder = folderFor();
  writeFileSync(path.join(folder, "compose.yml"), "services: {}\n");
  const { runner } = compose({ config: { services: { db: { image: "postgres" } } } });
  const agent = agentFor(runner)(folder);
  const { project } = await agent.run("compose.yml");
  docker.volumes.push({ Name: `${project}_data`, Labels: { [OWNER_LABEL]: OWNER, [FOLDER_LABEL]: folder, "com.docker.compose.project": project } });
  docker.volumes.push({ Name: "someone-elses", Labels: { "com.docker.compose.project": project } });
  assert.deepEqual(await agent.remove(project, true), { deleted: [`${project}-db-1`], volumesDeleted: [`${project}_data`] });
  assert.deepEqual(docker.volumes.map((v) => v.Name), ["someone-elses"]);
  docker.volumes.length = 0;
});

test("what compose would build or run itself is refused from the file, before anything is made", async () => {
  const folder = folderFor();
  writeFileSync(path.join(folder, "compose.yaml"), "services: {}\n");
  const { calls, runner } = compose({
    config: {
      services: {
        model: { provider: { type: "/anything" } },
        app: { build: { context: folder, network: "host", privileged: true, entitlements: ["security.insecure"] } },
      },
      networks: { lan: { external: true } },
      volumes: { disk: { driver_opts: { type: "none", o: "bind", device: "/" } } },
      secrets: { key: { external: true } },
    },
  });
  await assert.rejects(agentFor(runner)(folder).run("compose.yaml"), (e: Error) => {
    assert.match(e.message, /^Refused, and nothing was made:/);
    for (const said of [/model: a provider service/, /app: is built on the machine's network/, /app: is built privileged/, /app: is built with security\.insecure/, /lan: one of the networks that is there already/, /disk: a volume with a driver or options of its own/, /key: one of the secrets/]) {
      assert.match(e.message, said);
    }
    return true;
  });
  assert.equal(calls.length, 1, "only read");
});

test("what Docker made is read back and refused before any of it starts, where it reaches past the folder, and what was made goes", async () => {
  const folder = folderFor();
  writeFileSync(path.join(folder, "compose.yaml"), "services: {}\n");
  mkdirSync(path.join(folder, "data"));
  symlinkSync("data", path.join(folder, "alias"));
  symlinkSync(os.tmpdir(), path.join(folder, "out"));
  docker.volumes.push({ Name: "theirs", Labels: { "com.docker.compose.project": "another" } }, { Name: "anon", Labels: { "com.docker.volume.anonymous": "" } });
  docker.networks.push({ Id: "lan", Name: "lan", Labels: {} });
  const project = projectName(folder, "compose.yaml");
  const { calls, runner } = compose({
    config: { services: { web: { image: "nginx" }, db: { image: "postgres" } } },
    made: {
      web: {
        HostConfig: {
          Privileged: true, CapAdd: ["SYS_ADMIN"], Devices: [{ PathOnHost: "/dev/sda" }], NetworkMode: "host", PidMode: "container:someone", IpcMode: `container:${project}-db-id`,
          // label=disable as Docker adds it to a privileged container: not the file's, and not said.
          SecurityOpt: ["no-new-privileges:true", "seccomp=unconfined", "label=disable"], VolumesFrom: ["someone:ro"],
          // As compose sends `systempaths=unconfined`.
          MaskedPaths: [], ReadonlyPaths: [],
        },
        Mounts: [
          { Type: "bind", Source: path.join(folder, "data") },
          { Type: "bind", Source: path.join(folder, "new", "dir") },
          { Type: "bind", Source: "/var/run/docker.sock" },
          { Type: "bind", Source: path.join(folder, "alias") },
          { Type: "bind", Source: path.join(folder, "out", "x") },
          { Type: "volume", Name: "theirs" },
          { Type: "volume", Name: "anon" },
          { Type: "tmpfs" },
        ],
        Networks: { [`${project}_default`]: {}, lan: {} },
      },
      // One the file asked for, on a container that is not privileged: said.
      db: { HostConfig: { SecurityOpt: ["label=disable"] } },
    },
  });
  await assert.rejects(agentFor(runner)(folder).run("compose.yaml"), (e: Error) => {
    assert.match(e.message, /^Refused, and none of it was started:/);
    const said = e.message.split("\n- ").slice(1);
    assert.deepEqual(said, [
      "web: runs privileged",
      "web: adds the capabilities SYS_ADMIN",
      "web: is given the machine's devices /dev/sda",
      "web: shares the machine's network",
      "web: shares the processes of someone, which is not this project's",
      "web: is run with seccomp=unconfined",
      "web: is run with the kernel's files under /proc unmasked",
      "web: is run with the kernel's files under /proc writable",
      "web: takes the volumes of someone, which is not this project's",
      "web: mounts /var/run/docker.sock, which is outside this chat's folder",
      "web: mounts alias, which is reached by a link: mount the folder it leads to by its own path",
      "web: mounts out/x, which leads outside this chat's folder",
      "web: uses the volume theirs, which this project did not make",
      "web: joins the network lan, which this project did not make",
      "db: is run with label=disable",
    ]);
    return true;
  });
  assert.equal(calls.length, 2, "never started");
  assert.equal(docker.containers.some((c) => c.Labels["com.docker.compose.project"] === project), false, "what was made for it is gone");
  docker.volumes.length = 0;
  docker.networks.length = 0;
});

test("with the sandbox on, compose and every container run as the agent, with its groups and no way to gain more, and a folder to mount is made by the agent", async () => {
  const folder = folderFor();
  writeFileSync(path.join(folder, "compose.yaml"), "services: {}\n");
  mkdirSync(path.join(folder, "site"));
  const asked: string[][] = [];
  const agentUser = { uid: 10100, gid: 10100, groups: [10010], run: async (argv: string[]) => (asked.push(argv), { code: 0, stderr: "" }) };
  const { calls, runner } = compose({
    config: {
      services: {
        web: {
          image: "nginx", user: "root", group_add: ["0"], security_opt: ["no-new-privileges"],
          volumes: [{ type: "bind", source: path.join(folder, "data") }, { type: "bind", source: path.join(folder, "site") }, { type: "volume", source: "cache" }],
        },
      },
    },
  });
  const agent = agentFor(runner)(folder, async () => agentUser);
  const ran = await agent.run("compose.yaml");
  assert.deepEqual(ran.containers.map((c) => c.state), ["running"]);
  // compose itself, each time, as the agent.
  assert.deepEqual(calls.map((c) => c.as), [{ uid: 10100, gid: 10100, groups: [10010] }, { uid: 10100, gid: 10100, groups: [10010] }, { uid: 10100, gid: 10100, groups: [10010] }]);
  // Whatever the file said.
  const web = JSON.parse(calls[1].input!).services.web;
  assert.deepEqual([web.user, web.group_add, web.security_opt], ["10100:10100", ["10010"], ["no-new-privileges", "no-new-privileges:true"]]);
  // Only the folder that is not there, by the agent.
  assert.deepEqual(asked, [["mkdir", "-p", "--", path.join(folder, "data")]]);
  await agent.remove(ran.project);

  // A hook that runs as another user is refused from the file.
  const hooked = compose({ config: { services: { web: { image: "nginx", post_start: [{ command: "id", user: "root" }], pre_stop: [{ command: "id", privileged: true }] } } } });
  await assert.rejects(agentFor(hooked.runner)(folder, async () => agentUser).run("compose.yaml"), (e: Error) => {
    assert.match(e.message, /web: its post_start runs as root, and with the sandbox on everything runs as the agent/);
    assert.match(e.message, /web: its pre_stop runs privileged/);
    return true;
  });
  // What Docker made is held to it too.
  const otherwise = compose({ config: { services: { web: { image: "nginx" } } }, made: { web: { User: "0", HostConfig: { GroupAdd: ["10010", "0"], SecurityOpt: [] } } } });
  await assert.rejects(agentFor(otherwise.runner)(folder, async () => agentUser).run("compose.yaml"), (e: Error) => {
    assert.deepEqual(e.message.split("\n- ").slice(1), ["web: runs as 0, not as the agent (10100:10100)", "web: is given the groups 0", "web: can gain privileges (no-new-privileges is not set)"]);
    return true;
  });
  // A folder the agent may not make is said.
  const refusing = { ...agentUser, run: async () => ({ code: 1, stderr: "mkdir: cannot create directory: Permission denied" }) };
  const plain = compose({ config: { services: { web: { image: "nginx", volumes: [{ type: "bind", source: path.join(folder, "locked", "x") }] } } } });
  await assert.rejects(agentFor(plain.runner)(folder, async () => refusing).run("compose.yaml"), /locked\/x could not be made for a container to mount: mkdir: cannot create directory: Permission denied/);
  docker.networks.length = 0;
});

test("a Dockerfile is a project of one service, with the ports and environment it is given; a file outside the folder, or none, is refused", async () => {
  const folder = folderFor();
  mkdirSync(path.join(folder, "api"));
  writeFileSync(path.join(folder, "api", "Dockerfile"), "FROM alpine\n");
  writeFileSync(path.join(folder, "compose.yaml"), "services: {}\n");
  // The portal's /workspaces is somewhere else on Docker's machine.
  const onHost = async (p: string) => p.replace(folder, "/srv/ws/chat");
  const { calls, runner } = compose();
  const agent = agentFor(runner, onHost)(folder);
  const ran = await agent.run("api/Dockerfile", { ports: ["8080:80"], environment: { MODE: "dev" } });
  assert.match(ran.project, /^api-[0-9a-f]{8}$/);
  assert.deepEqual(JSON.parse(calls[0].input!), { services: { app: { build: { context: "/srv/ws/chat/api", dockerfile: "Dockerfile" }, ports: ["8080:80"], environment: { MODE: "dev" } } } });
  assert.deepEqual(calls.map((c) => c.folder), ["/srv/ws/chat", "/srv/ws/chat", "/srv/ws/chat"], "compose works in the folder as Docker has it");
  assert.equal(calls[1].args[calls[1].args.indexOf("--project-directory") + 1], "/srv/ws/chat/api");
  // By its path in the portal too.
  assert.equal((await agent.run(path.join(folder, "api", "Dockerfile"))).project, ran.project);

  await assert.rejects(agent.run("compose.yaml", { ports: ["80:80"] }), /ports and environment are for a Dockerfile/);
  await assert.rejects(agent.run("../elsewhere/compose.yaml"), /leads outside the folder/);
  await assert.rejects(agent.run("missing.yaml"), /There is no file missing\.yaml in this chat's folder/);
  await agent.remove(ran.project);
});

test("two runs of one project go one after the other; compose's failure is told in its own words", async () => {
  const folder = folderFor();
  writeFileSync(path.join(folder, "compose.yaml"), "services: {}\n");
  let open = 0;
  let most = 0;
  const base = compose({ config: { services: { web: { image: "nginx" } } } });
  const runner = async (args: string[], options: any) => {
    most = Math.max(most, ++open);
    await new Promise((r) => setTimeout(r, 5));
    open--;
    return base.runner(args, options);
  };
  const agent = agentFor(runner)(folder);
  await Promise.all([agent.run("compose.yaml"), agent.run("compose.yaml")]);
  assert.equal(most, 1);
  await agent.remove(projectName(folder, "compose.yaml"));

  const failing = async () => ({ code: 1, stdout: "", stderr: "line 1\nservices.web Additional property imagez is not allowed\n" });
  await assert.rejects(agentFor(failing)(folder).run("compose.yaml"), /docker compose could not read compose\.yaml:\nline 1\nservices\.web Additional property imagez is not allowed/);
});

test("compose runs in Docker's command-line image, a container of this extension's with the socket and the folder read-only; its output and its errors apart; stopped with the call", async () => {
  const folder = folderFor();
  const ensured: string[] = [];
  const runner = composeRunner(OWNER, async (image) => void ensured.push(image), async (p) => (p === docker.socket ? "/var/run/docker.sock" : p));
  docker.runs.onStart = (c) => Object.assign(c, { out: '{"services":{}}', err: "a warning\n", code: 0 });
  const ran = await runner(["-f", "-", "config"], { folder, input: '{"services":{}}' });
  assert.deepEqual(ran, { code: 0, stdout: '{"services":{}}', stderr: "a warning\n" });
  assert.deepEqual(ensured, [RUNNER_IMAGE]);
  assert.equal(docker.containers.some((c) => c.Name.startsWith("pithagoras-docker-compose-")), false, "removed once it ended");

  // What it was made with, seen while it runs.
  let made: FakeContainer | undefined;
  let release = () => {};
  docker.runs.onStart = (c) => {
    made = c;
    return new Promise<void>((r) => (release = r));
  };
  const abort = new AbortController();
  const going = runner(["up"], { folder, signal: abort.signal });
  while (!made) await new Promise((r) => setTimeout(r, 5));
  assert.equal(made.Image, RUNNER_IMAGE);
  assert.equal(made.Labels[OWNER_LABEL], OWNER);
  assert.deepEqual(made.made!.Cmd, ["docker", "compose", "up"]);
  assert.deepEqual((made.made!.HostConfig as any).Binds, ["/var/run/docker.sock:/var/run/docker.sock", `${folder}:${folder}:ro`]);
  assert.equal(made.made!.WorkingDir, folder);
  abort.abort();
  assert.equal((await going).code, 137, "killed");
  release();
  docker.runs.onStart = undefined;

  // Stopped before this step, or while the image downloads: nothing is made.
  const before = docker.containers.length;
  await assert.rejects(runner(["up"], { folder, signal: AbortSignal.abort() }), { name: "AbortError" });
  const stopping = new AbortController();
  const slow = composeRunner(OWNER, async () => void stopping.abort(), async (p) => p);
  await assert.rejects(slow(["up"], { folder, signal: stopping.signal }), { name: "AbortError" });
  assert.equal(docker.containers.length, before);

  // With input: given by its environment, and read by compose from `-`.
  docker.runs.onStart = (c) => {
    made = c;
  };
  await runner(["-f", "-", "config"], { folder, input: '{"a":"$$b"}' });
  assert.deepEqual(made!.made!.Cmd, ["sh", "-c", 'printf %s "$COMPOSE_INPUT" | docker compose "$@"', "compose", "-f", "-", "config"]);
  assert.deepEqual(made!.made!.Env, ['COMPOSE_INPUT={"a":"$$b"}']);

  // As the chat's agent: its user and groups, with the group Docker's socket is reached by, and a home it may write.
  await runner(["config"], { folder, as: { uid: 10100, gid: 10100, groups: [10010] } });
  assert.equal(made!.made!.User, "10100:10100");
  assert.deepEqual((made!.made!.HostConfig as any).GroupAdd, ["10010", String(statSync(docker.socket).gid)]);
  assert.deepEqual(made!.made!.Env, ["HOME=/tmp"]);
  docker.runs.onStart = undefined;
});

test("a folder of the portal's, as Docker's machine has it: where it is mounted into the portal's container, the one mounted deepest", async () => {
  const id = "c".repeat(64);
  const mountinfo = path.join(folderFor(), "mountinfo");
  writeFileSync(mountinfo, `1788 1726 0:48 /var/lib/docker/containers/${id}/hostname /etc/hostname rw,relatime - zfs rpool rw\n`);
  assert.equal(ownContainer(mountinfo), id);
  assert.equal(ownContainer(path.join(folderFor(), "none")), undefined);

  docker.containers.push({ Id: id, Name: "portal", Image: "pithagoras", State: "running", Labels: {}, Tty: false, out: "", err: "", Mounts: [{ Source: "/root/ws", Destination: "/workspaces" }, { Source: "/mnt/deep", Destination: "/workspaces/deep" }] } as FakeContainer);
  // The fake answers its inspect with the mounts it was given.
  const onHost = hostPaths(id);
  assert.equal(await onHost("/workspaces/chat/a"), "/root/ws/chat/a");
  assert.equal(await onHost("/workspaces"), "/root/ws");
  assert.equal(await onHost("/workspaces/deep/x"), "/mnt/deep/x");
  await assert.rejects(onHost("/data/chat"), /\/data\/chat is in the portal's container only/);
  await assert.rejects(hostPaths("d".repeat(64))("/workspaces"), /The portal runs in a container this Docker does not know/);
  assert.equal(await hostPaths(undefined)("/Users/me/chat"), "/Users/me/chat", "on the machine itself: where it is");
  docker.containers.splice(docker.containers.findIndex((c) => c.Id === id), 1);
});
