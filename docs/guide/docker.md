# Docker for extensions

**Docker** (`extensions/docker`, the package `pithagoras-docker`) lets other
extensions run containers: a browser, a speech model, a database. The agent's
[browser](/guide/browser) (the `pithagoras-browser` extension) and the
[voice service](/guide/voice-service) (`pithagoras-voice`) come with the portal
and build on it. It gives each
extension that
[builds on it](/guide/extension-ui#building-on-another-extension) a way to
download images and to make, start, stop and remove containers and volumes,
and shows you in Settings what each of them runs. It also gives the agent
[tools](#the-agent-s-tools) to run containers from a Dockerfile or a compose
file in its chat's folder, which are off until you switch them on.

It is not installed by default. Install it from Settings → Extensions →
Discover, where the extensions that come with the portal are listed, when an
extension you want needs it: one that requires it does not start without it,
and says so in Settings → Extensions. Installing that extension from Settings →
Extensions installs Docker with it, first
([Installing what it requires](/guide/extension-ui#installing-what-it-requires)),
as installing Browser or Voice does.

## Giving the portal Docker

The portal reaches Docker through its socket. Run in a container, it has that
socket only if it is given it, in `docker-compose.yml` under the portal's
`volumes`:

```yaml
- /var/run/docker.sock:/var/run/docker.sock
```

Then start the portal again. `DOCKER_SOCKET` names another socket than
`/var/run/docker.sock`. Without one, Docker's page says that the portal cannot
reach Docker, and how to give it the socket.

::: warning Docker's socket is root on the machine
Whatever can use the socket can start a container that mounts the whole disk.
An extension's server half already runs with the portal's own rights, and could
open the socket itself: Docker keeps extensions apart from one another and
shows you what each runs, but it does not make an extension safe that is not.
Install the extensions you trust.
:::

## Docker's page

Settings → Extensions → **Configure** on Docker (or its entry in Settings'
list) shows:

- whether the portal reaches Docker, and Docker's version;
- the containers the extensions run, under the extension that runs each, with
  its image and how it stands ("Up 2 minutes", "Exited (0)"). **Stop** or
  **Start** it, read the end of what it wrote (**Logs**), or **Remove** it,
  which asks first. What an extension keeps in a volume stays, and the
  extension may make its container again;
- the volumes they keep, which **Delete** takes away with all they hold, once
  you say so.

A container that no extension made, such as one you started by hand, is not
shown, and not acted on from here. What the agent runs is listed under Docker
itself.

## The agent's tools

With Docker installed, each chat has these tools, **off until you switch them
on** in Settings → Tools (for every chat) or in a chat's own tools:

| | |
| --- | --- |
| `docker_run` | Builds and starts containers from a Dockerfile or a compose file in the chat's folder. A `.yml` or `.yaml` file is a compose file, any other a Dockerfile. Run again, it brings them up to date |
| `docker_list` | The containers the chat's folder runs: name, project, service, image, state and published ports |
| `docker_start`, `docker_stop` | A container, or every container of a project |
| `docker_delete` | A container, or a project's. Once a project has no container left, its networks and the images built for it go too, and its volumes only when the agent asks |
| `docker_logs` | The end of what a container wrote |

What the agent runs belongs to the chat's folder: the chats in one folder share
it, and the agent can see and act on only that. Each file is a project of its
own, named after its folder. A Dockerfile is a project of one service, and the
agent may give it ports (`"8080:80"`, the machine's port first) and an
environment; a compose file publishes the ports it says.

compose runs in Docker's own command-line image (`docker:29.8.1-cli`, downloaded
the first time), which needs no compose installed in the portal's. It is given
the chat's folder read-only, at the path the folder has on Docker's machine:
where the portal runs in a container, the folder it mounts there (your
`/workspaces` may be `/root/pithagoras-workspaces` on the machine), found from
the portal's own container. A chat's folder that is in the portal's container
only, on no folder mounted into it, cannot be run from.

Before any of it starts, what compose made is read back from Docker, and the
run is refused, and what it made removed, where a container:

- mounts a folder outside the chat's folder, or one reached by a link;
- runs privileged, adds capabilities, or is given the machine's devices;
- shares the machine's network, processes, IPC, host name, users or cgroups,
  or another container's that is not the project's;
- drops its confinement (`security_opt` other than `no-new-privileges`,
  `systempaths=unconfined` among them);
- uses a volume or joins a network the project did not make, or a volume
  made with a driver or options of its own.

What compose would do before that is refused from the file: a build on the
machine's network, privileged or with entitlements, a `provider` service (a
program compose runs itself), and models. GPUs (`gpus`, or a device
reservation under `deploy`) are allowed.

::: warning Ports and the network
A published port is open on the machine's network, as with `docker run -p`.
And a container reaches whatever the machine reaches. The limits above keep it
in the chat's folder; they do not keep it off the network.
:::

### With the sandbox on

With the [sandbox](/guide/sandbox) on, the agent runs as a user of its own,
and a container that ran as root would read and change, in the folders it
mounts, what that user may not. So then everything Docker does with the chat's
folder is done as the agent:

- every container runs as the agent's user, with its groups, whatever the file
  says (`user`, `group_add`), and cannot gain privileges (`no-new-privileges`);
  a `post_start` or `pre_stop` hook that runs as another user, or privileged, is
  refused;
- compose runs as the agent too, so a file, an `env_file` and what an image is
  built from are read only where the agent may read: a build that would take
  in a folder closed to the agent fails;
- a folder to mount that is not there yet is made by the agent, not by Docker
  as root.

What a container writes in the chat's folder is then the agent's, to change or
delete. An image that needs root inside its container (some databases and web
servers) does not work this way: use a variant made to run as any user, or run
it with the sandbox off.

Two things the limits do not cover. A link in the chat's folder that is
changed between the check and the start could still lead a mount elsewhere.
And with the [sandbox](/guide/sandbox) off, the agent runs as the portal's own
user, which can use Docker's socket without these tools. Switch them on for an
agent you would let run containers.

## For an extension that builds on it

Name it in your package.json, and ask for it in your server half:

```json
"pithagoras": { "server": "./server.js", "requires": { "pithagoras-docker": "^1.1.0" } }
```

```js
const docker = portal.extensions.use("pithagoras-docker");
if (await docker.available()) {
  await docker.images.ensure("redis:7", (state) => portal.log(state.line));
  await docker.volumes.create("my-redis-data");
  await docker.containers.create("my-redis", { Image: "redis:7", HostConfig: { Binds: ["my-redis-data:/data"] } });
  await docker.containers.start("my-redis");
}
```

Use `optional` instead where your extension works without Docker, and runs a
container only where there is one: `use` then gives nothing while Docker is not
installed.

What it gives (`extensions/docker/src/api.ts`, with its types):

| | |
| --- | --- |
| `available()` | Whether the portal reaches Docker now |
| `sharedNetwork()` | The network mode for a container on the portal's own network ([below](#a-container-on-the-portal-s-network)) |
| `images.present(image)`, `images.ensure(image, onProgress?)` | Whether an image is there; downloads it when it is not, telling `onProgress` how it goes. One download of an image at a time, whoever asks |
| `containers.list()`, `containers.get(name)` | Your containers; a container by name, with `owner` saying whose it is and `labels` the labels it was made with |
| `containers.create(name, spec)` | Makes one, not started, from Docker's own create body (`Image`, `Env`, `Cmd`, `HostConfig`, …). One of yours by that name is removed first |
| `containers.inspect(name)` | How your container was made and how it stands: Docker's own inspect body (`Config`, `HostConfig`, `State`, …), as `create` takes Docker's own create body. Nothing where there is none |
| `containers.exec(name, cmd, options?)` | Runs a command in your running container, and gives what it wrote and how it ended ([below](#running-a-command-in-a-container)) |
| `containers.start`, `stop`, `remove`, `logs(name, { tail })` | Your container's life, and the end of what it wrote |
| `containers.adopt(name)` | Takes over a container that carries no extension's name: one made before your app was an extension, so that what it kept is kept. Browser takes over the `pithagoras-browser` container and its profile volume this way each time it starts, and Voice the `pithagoras-voice` container (where it is labelled as the voice service) and its models volume |
| `volumes.list`, `create`, `remove`, `adopt` | The same for volumes |

`sharedNetwork`, `containers.inspect` and `containers.exec` came with Docker
1.1.0: an extension that uses them requires `^1.1.0`.

Each extension has its own. What it makes carries its name (the label
`pithagoras.extension`), and it may start, stop, remove, read and run commands
in only those, and the ones it took over: another extension's, or a container
nobody made through Docker, is refused until it is taken over. Which ones it
took over is kept in Docker's own folder in the portal's data folder.

### Running a command in a container

`containers.exec(name, cmd, { env, workingDir, tty, timeoutMs })` runs `cmd`
(`["node", "-e", script]`, say) in one of your containers, which has to be
running: Docker refuses it in one that is not. `env` is its environment besides
the container's (`{ INPUT: "…" }`), `workingDir` the folder it runs in, and
`tty` gives it a terminal, so that what it wrote comes back as it wrote it. It
gives:

- `output`: what it wrote, its output and its errors, as text;
- `exitCode`: the code it ended with;
- `timedOut`: it did not end within `timeoutMs`.

Without `timeoutMs`, or with 0, it waits as long as the command takes. Docker's
other calls, apart from a download (`images.ensure`), are given up on after 30
seconds; this one is not. A command given up on is not a failure: `output` is
what it wrote by then, and `exitCode` is `null`. Docker has no way to end it, so
it may still be running in the container; ending it is yours, with another
command that does (`pkill -f …`).

```js
const run = await docker.containers.exec("my-redis", ["redis-cli", "ping"], { timeoutMs: 10_000 });
if (run.timedOut) portal.log("redis did not answer in time");
else if (run.exitCode !== 0) portal.log(run.output);
```

### A container on the portal's network

A service the portal reaches on `127.0.0.1`, and that reaches the portal there,
runs on the portal's own network: give its container
`HostConfig: { NetworkMode: await docker.sharedNetwork() }`. That is:

- `host` where the portal runs on the machine itself. This works on Linux only;
  elsewhere it is refused, and the portal has to run in Docker;
- `container:<id>` where the portal runs in a container: the running container
  named by `PORTAL_CONTAINER_NAME`, which the Compose files set, or else by
  `HOSTNAME`. Where neither names a running container, it is refused, saying to
  set `PORTAL_CONTAINER_NAME`.

The id is that of the portal's container now. When the portal's container is
made again, as an update with Compose does, a container made with the old id
has lost its network: compare `HostConfig.NetworkMode` from `containers.inspect`
with `sharedNetwork()`, and make the container again where they differ. The
voice service does this as it starts and every 30 seconds for a running
container, keeping its engines and the GPU it was given.

### When a call fails

A call that fails throws an Error with `status`: Docker's own HTTP status where
it said no (403 for a container or volume that is another extension's, or
nobody's; 404 where there is none to act on; 409 for `exec` in a container
that is not running), and 0 where Docker was not reached or gave no HTTP status:
there is no socket, it did not answer in time, its answer was cut off partway,
the name is not one Docker takes, or a download failed partway. Where
`sharedNetwork` does not find the portal's network, its Error has no `status`,
and says what to set.
