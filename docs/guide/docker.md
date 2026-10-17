# Docker for extensions

**Docker** (`extensions/docker`, the package `pithagoras-docker`) lets other
extensions run containers: a browser, a speech model, a database. It does
nothing by itself. It gives each extension that
[builds on it](/guide/extension-ui#building-on-another-extension) a way to
download images and to make, start, stop and remove containers and volumes,
and shows you in Settings what each of them runs.

It is not installed by default. Install it from Settings → Extensions →
Discover, where the extensions that come with the portal are listed, when an
extension you want needs it: one that requires it does not start without it,
and says so in Settings → Extensions.

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
shown, and not acted on from here.

## For an extension that builds on it

Name it in your package.json, and ask for it in your server half:

```json
"pithagoras": { "server": "./server.js", "requires": { "pithagoras-docker": "^0.1.0" } }
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
| `images.present(image)`, `images.ensure(image, onProgress?)` | Whether an image is there; downloads it when it is not, telling `onProgress` how it goes. One download of an image at a time, whoever asks |
| `containers.list()`, `containers.get(name)` | Your containers; a container by name, with `owner` saying whose it is |
| `containers.create(name, spec)` | Makes one, not started, from Docker's own create body (`Image`, `Env`, `Cmd`, `HostConfig`, …). One of yours by that name is removed first |
| `containers.start`, `stop`, `remove`, `logs(name, { tail })` | Your container's life, and the end of what it wrote |
| `containers.adopt(name)` | Takes over a container that carries no extension's name: one made before your app was an extension, so that what it kept is kept |
| `volumes.list`, `create`, `remove`, `adopt` | The same for volumes |

Each extension has its own. What it makes carries its name (the label
`pithagoras.extension`), and it may start, stop, remove and read only those,
and the ones it took over: another extension's, or a container nobody made
through Docker, is refused until it is taken over. Which ones it took over is
kept in Docker's own folder in the portal's data folder.
