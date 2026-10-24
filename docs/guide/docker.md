# Docker for extensions

**Docker** (`extensions/docker`, the package `pithagoras-docker`) lets other
extensions run containers: a browser, a speech model, a database. The agent's
[browser](/guide/browser) (the `pithagoras-browser` extension), the
[voice service](/guide/voice-service) (`pithagoras-voice`) and
[Understory](/guide/features#memory-understory), the agent's memory
(`pithagoras-understory`), come with the portal and build on it. It gives each
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
as installing Browser, Voice or Understory does.

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
  await docker.containers.create("my-redis", { Image: "redis:7", HostConfig: { Binds: ["my-redis-data:/data"], RestartPolicy: { Name: "unless-stopped" } } });
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
| `containers.create(name, spec)` | Makes one, not started, from Docker's own create body (`Image`, `Env`, `Cmd`, `HostConfig`, …). One of yours by that name is removed first. One on a network that is not yours, or sharing the network of a container that is neither yours nor the portal's, is refused |
| `containers.inspect(name)` | How your container was made and how it stands: Docker's own inspect body (`Config`, `HostConfig`, `State`, …), as `create` takes Docker's own create body. Nothing where there is none |
| `containers.update(name, changes)` | Changes your container as it is, running or not, from Docker's own update body (`RestartPolicy`, and the resources: `Memory`, `NanoCpus`, …): it is neither made again nor restarted, and what the change does not name stays ([below](#when-the-machine-restarts)) |
| `containers.exec(name, cmd, options?)` | Runs a command in your running container, and gives what it wrote and how it ended ([below](#running-a-command-in-a-container)) |
| `containers.start`, `stop`, `remove`, `logs(name, { tail })` | Your container's life, and the end of what it wrote |
| `containers.adopt(name)` | Takes over a container that carries no extension's name: one made before your app was an extension, so that what it kept is kept. Browser takes over the `pithagoras-browser` container and its profile volume this way each time it starts, Voice the `pithagoras-voice` container (where it is labelled as the voice service) and its models volume, and Understory the `pithagoras-understory` container (where it is labelled as the portal's Understory) and its memory volume |
| `volumes.list`, `create`, `remove`, `adopt` | The same for volumes |
| `networks.create(name)`, `networks.get(name)` | A network of your own that has no way out, made or kept; a network by its name, with whose it is ([below](#a-container-on-a-network-of-its-own)) |
| `networks.reach(name, container, port)` | Where the portal reaches a port of your container on it: [below](#a-container-on-a-network-of-its-own) |
| `networks.remove(name)` | Your network gone, with what `reach` made for it |

`sharedNetwork`, `containers.inspect` and `containers.exec` came with Docker
1.1.0: an extension that uses them requires `^1.1.0`. `containers.update` came
with 1.2.0, and requires `^1.2.0`. `networks` came with 1.3.0, and requires
`^1.3.0` and Docker Engine 28.0 or later.

Each extension has its own. The containers, volumes and networks it makes carry
its name (the label `pithagoras.extension`), and it may start, stop, change,
remove, read and run commands in only those, and the ones it took over: another
extension's, or a container nobody made through Docker, is refused until it is
taken over. Which ones it took over is kept in Docker's own folder in the
portal's data folder. A container is made on your networks and Docker's own
(`bridge`, `host`, `none`) alone: `containers.create` reads back from Docker
the networks it put the container on, by `HostConfig.NetworkMode` and by
`NetworkingConfig.EndpointsConfig`, whether the body named them by name or by
id, and refuses one on another extension's network or on one nobody made, with
403, taking what Docker made away again. It refuses in the same way a container
that would share the network (`container:<name or id>`) of a container that is
neither yours nor the portal's own, or that is not there: Docker would keep that
one by its name, and the container would share the network of whichever is made
under it later.

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
container, keeping its engines and the GPU it was given, and Understory the
same, keeping its memory and its token.

A container on the portal's network reaches everything the portal reaches. One
that runs code from elsewhere goes on a network of its own instead
([below](#a-container-on-a-network-of-its-own)). What one on the portal's
network listens for on 0.0.0.0 is reached, where the portal runs in a container
of its own, by every container on a network of an extension's that the portal
is put on ([below](#a-container-on-a-network-of-its-own)): listen on 127.0.0.1
where the portal is all that calls it.

### A container on a network of its own

A container that runs code from elsewhere (code the agent writes, a program it
builds) must not reach the portal's services, the machine, your local network
or the internet. Put it on a network of your extension's own, which has no way
out, and let the portal reach it there:

```js
await docker.networks.create("my-server-net");
await docker.containers.create("my-server", {
  Image: "my-server:1",
  Env: ["HOST=0.0.0.0"],
  HostConfig: { NetworkMode: "my-server-net", RestartPolicy: { Name: "unless-stopped" } },
});
await docker.containers.start("my-server");
const { host, port } = await docker.networks.reach("my-server-net", "my-server", 3870);
await fetch(`http://${host}:${port}/state`);
```

`networks.create(name)` makes a bridge network that is internal and in the
gateway mode `isolated`, with no IPv6. Internal alone is not enough: Docker
then gives the machine an address on the network, and a container on it reaches
every service the machine listens for on 0.0.0.0 (sshd, the portal itself)
through that address. In the gateway mode `isolated` the machine has no address
on it, and no route onto it: the containers on it reach one another, by name,
and nothing else. What Docker made is read back, and a Docker that made it with
a gateway after all (Docker before 28.0, which has no `isolated`) is refused,
with the network taken away again. One of yours by that name is kept as it is;
one with a way out is refused. The machine's side of the bridge still has an
IPv6 link-local address (`fe80::`), as every bridge of Docker's has; on a
network with no IPv6, Docker turns IPv6 off on each container's interface on it
(`net.ipv6.conf.<interface>.disable_ipv6`), so a container there has no IPv6
but its own loopback, and code in it cannot turn it on again: a container's
`/proc/sys` is read-only. A create body that turns it on, with the endpoint's
driver option `com.docker.network.endpoint.sysctls`, gives the container that
way to the machine back. Your server listens on 0.0.0.0 of its own
container, as only what is on its network reaches it.

`networks.reach(name, container, port)` gives where the portal reaches `port`
of your container on that network, which need not be running yet. It depends
on where the portal runs:

- in a container with a network of its own (Docker's default bridge, or a
  network of its own): its container is put on your network, and the host is
  your container's name, which Docker's own DNS on the network answers;
- in the machine's network namespace, on the machine itself or in a container
  with `network_mode: host`, as both of the portal's Compose files run it:
  Docker can add no network to that, so a forwarder runs, the container
  `<container>-forward`. It is on your network and on a network of its own
  by the same name, publishes `port` on the machine's 127.0.0.1 alone, and
  passes each connection on to your container. The host is `127.0.0.1`. It is
  your extension's container, shown under it in Settings → Docker, unprivileged
  and read-only, and started again by Docker after the machine restarts. Its
  image (`node:22.23.4-alpine3.23`) is downloaded the first time one is made;
- in a container that shares another container's network: refused, with 409,
  as Docker can add no network to that either. Run the portal with a network
  of its own, or on the machine's.

The host is a name or 127.0.0.1, never your container's address, which changes
as it starts again: what `reach` gave stays right while the portal runs. Each
`reach` also puts right what is not as it should be: a portal's container that
was made again, with a new id, is put on the network; a forwarder that is gone,
or not as it would be made now (another port, a network made again), is made
again, and one that is stopped is started. So ask for it as your server starts,
and again where it does not answer. A forwarder that was just made or started
takes a moment to listen: a connection in that moment is closed.

Restarting a container, Docker or the machine keeps all of it: the networks,
their gateway mode, and the containers on them. A network that was removed
and made again is another network, on which a container made on the old one
does not start (`network … not found`): compare
`NetworkSettings.Networks[<name>].NetworkID` from `containers.inspect` with
the network's `id` (`networks.get`), and make the container again where they
differ. Docker sets that id when the container first starts: it is empty for
one that was made and never started.

What a container on the network still reaches, where the portal runs in a
container of its own, is what is listened for on 0.0.0.0 in the portal's
container's network namespace: the portal's own port, behind its sign-in, and
the port of every container that shares that namespace
([above](#a-container-on-the-portal-s-network)) and listens on every interface.
Of the portal's own extensions, Understory's does (3800), and asks for its
token. Not the namespace's 127.0.0.1, its other networks or the containers on
them. Where the portal is in the machine's network namespace, and a forwarder
leads onto the network, a container on it reaches the forwarder's port alone,
which leads back to your container. A forwarder's port on 127.0.0.1 is open to
every process on the machine, as a port of a server on the portal's loopback is.

Each network takes one of Docker's address pools, of which there are about 31
by default; a forwarder's own network takes one more.

`networks.remove(name)` removes the forwarders that lead onto it, with their
networks, takes the portal's container off it, and removes it. While one of
your containers is still on it, Docker refuses, with 403: remove that container
first.

### When the machine restarts

A container that runs your extension's service, as Browser's, Voice's and
Understory's do, is made with Docker's `unless-stopped` restart policy:
`HostConfig: { RestartPolicy: { Name: "unless-stopped" } }`. Docker then
starts it again after the machine, or Docker itself, restarts, and after it
exits on its own, but not once the person has stopped it, on your page or with
**Stop** on Docker's page: it stays stopped until it is started again. A
container you made before with another policy is given it in place, with
`containers.update(name, { RestartPolicy: { Name: "unless-stopped" } })`, which
neither makes it again nor restarts it: Voice does this as it starts, and
wherever it finds its container.

A container on the portal's network that is given `container:<id>`
([above](#a-container-on-the-portal-s-network)), as Voice's and Understory's
are, needs the portal's container running before it can start. As the machine
starts, Docker 29 and later wait up to five seconds for the portal's to start
first; older Docker starts them all at once, and one it starts before the
portal's is running stays stopped, with `cannot join network namespace of a
non running container` in `State.Error`, until it is started again. Voice's
page then shows it as failed, and **Retry setup** starts it.

A container that keeps failing is started again by Docker each time, after a
wait that doubles up to a minute (and starts again from a tenth of a second
once it has run for ten seconds). `containers.inspect` shows that:
`State.Restarting` is `true` while Docker waits for the next try, with the
last try's code in `State.ExitCode`, and `State.StartedAt` is when the run
under way began, at each try anew. `RestartCount` counts Docker's own starts
since it was last started by a call (`start`), or by Docker as the machine
started, and Docker keeps that count for as long as a run it began goes on:
a container that came back after one failure still has `1`, so the count alone
does not say a try is under way. While it waits, Docker counts it as running,
so `start` leaves it to Docker's next try; `stop` ends the tries, and `stop`
and then `start` runs it now. Voice's page shows such a container as failed,
with its log and **Stop · release VRAM**, until its services answer in the run
Docker began.

What the agent runs with its [tools](#the-agent-s-tools) is not an extension's
service: a Dockerfile's container has no restart policy, and a compose file's
has the one the file gives it.

### When a call fails

A call that fails throws an Error with `status`: Docker's own HTTP status where
it said no (403 for a container, volume or network that is another extension's,
or nobody's, and for removing a network a container is still on; 404 where
there is none to act on; 409 for `exec` in a container that is not running,
and for `reach` to a container that is not on the network, from a portal that
shares another container's network, or on a network of yours that has a way
out), and 0 where Docker was not reached or gave no HTTP status: there is no
socket, it did not answer in time, its answer was cut off partway, the name is
not one Docker takes, a download failed partway, or a Docker older than 28.0
made a network with a way out (taken away again). Where Docker refuses a
forwarder's start, as for a port on 127.0.0.1 that is in use, `reach` fails
with Docker's own status and words. Where `sharedNetwork`, `networks.reach` or
`networks.remove` does not find the portal's container, its Error has no
`status`, and says what to set.
