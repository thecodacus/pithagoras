# Deploying

Pithagoras ships as a container. It expects to run somewhere private — there is
a single password and no per-user separation, so put it behind Tailscale or a
VPN rather than on a public address.

## Docker Compose

```bash
git clone https://github.com/thecodacus/Pithagoras.git
cd Pithagoras
```

Create a `.env` next to `docker-compose.yml`. This writes one, with a secret of
its own (change the password and the folder first, between the single quotes,
where `%`, `$` and `\` are taken as they are, and neither can hold a `'`):

```bash
printf "PORTAL_PASSWORD='%s'\nWORKSPACES_DIR='%s'\nPORTAL_SECRET=%s\n" 'something-long' '/path/to/repos' "$(openssl rand -hex 32)" > .env
```

The two typed values go into the file in single quotes on purpose. Compose reads
a `.env` value without quotes as its own syntax: `$name` becomes a variable (or
nothing), `$$` becomes one `$`, and ` #` starts a comment. The portal would then
get another password than the one you typed, and the sign-in would refuse it.
Between single quotes the value is taken as it is. If you write the file by
hand, quote a password that has a `$` or a `#` in it the same way.

Write `PORTAL_SECRET=` followed by the output of `openssl rand -hex 32` if you
make the file by hand. Compose does not run commands in a `.env`: the text
`PORTAL_SECRET=$(openssl rand -hex 32)` would be the secret itself, the same for
everyone who copied it from here. The portal says so when it starts with one.

`.env.example` lists every variable Compose reads. `WORKSPACES_DIR` is the host
folder your repositories are in, and it is required: there is no default, and
Compose stops with a message until it is set, rather than mount a folder nobody
chose. `PORTAL_DATA_DIR` (optional) is an absolute host path to keep the
portal's data in, instead of the `portal-data` Docker volume. Keep it apart from
`WORKSPACES_DIR`.

`PORTAL_SECRET` signs the login cookie. Leave it out and logins are invalidated
on every restart, which is exactly the annoyance you would expect. The cookie is
marked `Secure` when the portal serves HTTPS, so the browser does not send it to
the plain-HTTP services on the same host.

Then:

```bash
docker compose up -d --build
```

Open `http://<host>:4100`, sign in, and add a model provider under **Settings →
Providers** — the setup assistant offers to find a local server, or take a key.
Nothing else is needed for a first chat.

The portal listens on `:4100`. Compose uses `network_mode: host`, so it binds
that port directly on the host — which is also what lets pi reach a llama-server
running on the same machine at `localhost`.

## HTTPS

Browsers offer notifications and installing the portal as an app only over
HTTPS or on `localhost`, and the embedded browser needs it. Either put a proxy
in front (`tailscale serve` is the shortest), or give the portal the
certificate itself: mount the folder with `PORTAL_TLS_DIR` (it appears at
`/certs`) and set `PORTAL_TLS_CERT` and `PORTAL_TLS_KEY` to the files in it.

## Workspace paths

For a native installation, set `WORKSPACE_ROOT` to the directory containing your
projects. The legacy `WORKSPACES_DIR` variable is also accepted when
`WORKSPACE_ROOT` is unset. If both are set, `WORKSPACE_ROOT` wins; with neither
set, the server uses `/workspaces`.

With the supplied Compose files, `WORKSPACES_DIR` selects the **host** directory
mounted at `/workspaces`, and has to be set. Keep the portal's
`WORKSPACE_ROOT=/workspaces` so it uses the path visible inside its container.

## Installing add-ons

To install Browser or Voice from Settings:

- Keep the **Docker socket mount** and **host networking**.
- For Voice, configure **NVIDIA Container Toolkit** on the host.

Follow [Docker add-ons](/guide/add-ons) for installation, controls, storage and cleanup.

## The runner image

`EXECUTOR=container` starts each task from `PI_IMAGE` (default
`pithagoras-runner:latest`) by running `pi` in it. The repository does not ship
that image, so build one — anything with `pi`, `git` and whatever your tasks
need:

```dockerfile
FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends git openssh-client ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g @earendil-works/pi-coding-agent@latest
```

```bash
docker build -t pithagoras-runner:latest .
```

The per-task limits are `TASK_MEMORY_MB`, `TASK_CPUS` and `TASK_PIDS_LIMIT`.
The default `host` executor needs no image: pi runs inside the portal.

## Resuming container sessions

The container executor automatically removes completed runners. Before starting
a session, it also removes a leftover stopped runner with the same name, but
only when its ownership labels match that session.

A running runner is left alone. Wait for its current task to finish before
resuming. If an unrelated container uses the same name, the portal reports the
collision; inspect that container and rename or remove it yourself once you
have identified it. The portal does not force-delete it.

## Only one portal per data directory

The portal holds a socket in its data directory (`portal.sock`); a second
server started on the same data — including one an agent starts from a chat with
another `PORT` — exits with *already running* instead of marking the first one's
chats interrupted.

## Updating

```bash
git pull && docker compose up -d --build
```

A portal in a container cannot rebuild itself, so it is updated this way, from
outside, or by pulling the new image in Portainer. Settings → About says the same
there. A portal [run from source](#running-from-source) has an **Update** button
in Settings → About that pulls, builds and restarts it, see
[Settings](/guide/settings#update).

Your data lives in a volume, not in the image (`portal-data`, or `pithagoras-data` in the Portainer stack). Sessions,
transcripts, installed pi packages and installed channel packages all survive a
rebuild. When the new version changes the database, the portal copies it aside
and upgrades it before it starts serving; see [Upgrading](/guide/upgrading).

The image runs the version of pi that the portal's lock file names, built in
with it, so a new pi arrives with a new image and not with **Update all** in
Settings → Extensions, which updates the installed packages only.

## What the web app is sent

The build leaves a brotli and a gzip copy beside each script, style and model
that gains from one, and the portal sends the copy the browser asks for: the web
app is about a third of its size over a plain-HTTP LAN, and the voice models,
which are fourteen megabytes uncompressed, about a fifth. Files named by their
content (everything under `/assets/`) are kept by the browser for a year; the
page itself and the voice models are asked about again each time, and answered
with a short "not changed" when they have not.

Running from source, `npm run build -w web` makes the copies; a build copied
into place by hand without them is sent as it is.

## Volumes

| Path | Holds |
| --- | --- |
| `/data` | Everything stateful — see below |
| `/workspaces` | The directories pi works in, mounted from `WORKSPACES_DIR` |
| `/var/run/docker.sock` | Managed Browser/Voice add-ons and `EXECUTOR=container` |

The portal closes `/data` to every account but the one it runs as (mode `0700`)
each time it starts, a folder made by hand or by an older version too:
`portal.db` holds the channels' bot tokens, the add-ons' passwords and every
conversation. A data folder on the host, mounted as `/data`, is closed the same way.

Inside `/data`:

| Path | Holds |
| --- | --- |
| `/data/portal.db` | Sessions, event log, channels, agents, routines, settings |
| `/data/portal.sock` | Held while the portal runs, so a second one cannot start on this data |
| `/data/backups` | The copies of the database made before an [upgrade](/guide/upgrading) |
| `/data/sessions/<id>` | Per-session working area, and pi's file of the chat's conversation: it is what the agent remembers. Do not clear it |
| `/data/home` | `HOME` for pi — `~/.pi/agent`, its settings, skills and packages |
| `/data/channels` | Installed third-party channel packages |
| `/data/agent-home` | The first agent's home: its `SOUL.md`, `PrimaryUser.md`, `MEMORY.md` |
| `/data/agents/<id>` | The home of every other [agent](/guide/agents) |
| `/data/images` | The pictures the [Images page](/guide/images) made itself, and the pictures sent with each chat's messages, in a folder per chat. What the agent makes is in the chat's folder, under `generated-images` |
| `/data/bin` | CLIs you add yourself — on `PATH`, survives rebuilds |

`HOME` deliberately points at the volume. Otherwise every image rebuild would
silently wipe the pi packages you installed.

Move `/data` as a whole, or keep `/data/sessions` with `portal.db`. A chat whose
file is gone still shows its transcript, but the agent starts over without
remembering it, and a notice in the chat says so. A moved folder is found again
by the file's name, so a data folder copied to another path keeps its chats.

## Backing up

The upgrade backs the database up by itself, but only when it changes it (see
[Upgrading](/guide/upgrading)). A backup of your own is up to you. What holds
your work:

- **`/data`**: the folder `PORTAL_DATA_DIR` names, or else the volume the Compose
  file declares (`<project>_portal-data`, and `<stack>_pithagoras-data` in
  Portainer: Docker puts the project's or the stack's name in front). The
  database, the chats' files, pi's settings and packages, the agents, the pictures.
- **The memory of the Understory the portal runs**, if you use it: the volume
  `pithagoras_understory-memory` (`UNDERSTORY_VOLUME`), plain markdown files.
- **The browser's logins**, if you want to keep them: the volume
  `pithagoras_browser-profile`. The voice models are downloads and can be fetched again.
- **Your workspaces** are your own repositories: back them up as you do now.

`portal.db` is in write-ahead mode: recent writes sit in `portal.db-wal` beside it
until SQLite folds them in. Copying the files of a running portal one after the
other can take them at different moments, and the copy then fails SQLite's check or
lacks the last hours. There are two ways around that.

**Stop, copy, start.** The simplest, and it takes everything in one consistent step:

```sh
docker stop pithagoras
DATA=$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/data"}}{{if .Name}}{{.Name}}{{else}}{{.Source}}{{end}}{{end}}{{end}}' pithagoras)
docker run --rm -v "$DATA:/data:ro" -v "$PWD:/backup" alpine tar czf /backup/pithagoras-data.tgz -C /data .
docker start pithagoras
```

**While it runs.** Have SQLite make the copy of the database, which is consistent
while it is read and holds what the log holds, then copy the rest of `/data`:

```sh
docker exec pithagoras node -e 'new (require("better-sqlite3"))("/data/portal.db", { fileMustExist: true }).backup("/data/portal-backup.db").then(() => console.log("done"))'
```

This is the call the portal makes before an upgrade. Copy `/data` as you copy any
folder, but take the database from `portal-backup.db` and leave `portal.db`,
`portal.db-wal`, `portal.db-shm` and `portal.sock` out of the copy. Remove
`portal-backup.db` afterwards: it is as large as the database.

The memory of Understory is files, so it can be archived like any volume. Stop
Understory first (**Settings → Add-ons → Memory → Stop**) if you want to be sure no
tidy-up pass is writing:

```sh
docker run --rm -v pithagoras_understory-memory:/memory:ro -v "$PWD:/backup" alpine tar czf /backup/understory-memory.tgz -C /memory .
```

**Restoring.** Stop the portal, unpack into the data folder, and for a copy made
the second way put the database copy in as `portal.db` and remove `portal.db-wal`
and `portal.db-shm`; then start it. A backup from an older version is upgraded on
that start, with the check and the backup described in [Upgrading](/guide/upgrading);
one from a newer version is refused.

## Installing command-line tools

Updating rebuilds the image, so anything installed into the container's own
filesystem is lost — `apt-get install` or `npm i -g` inside a running container
survives a restart, which makes it look like it stuck, and then disappears on
the next deploy.

Three places that do survive, in the order worth reaching for:

**Nowhere.** `npx -y <package>` needs no install. Its cache lives under `HOME`,
which is on the volume, so only the first run pays the download. Most MCP
servers are published this way. The Python equivalent is `uvx <tool>`; `uv` and
`uvx` ship in the image, and `uv` fetches its own interpreter on first use, so
there is no Python to install either.

**`/data/bin`.** On `PATH` for the portal and everything pi launches, and on the
volume. Drop a binary there — no redeploy, no image change. It comes last on
`PATH`, so a file there adds a tool and never replaces `node`, `git`, `docker` or
`pi`:

```bash
docker exec pithagoras sh -c "curl -fsSL <url> -o /data/bin/tool && chmod +x /data/bin/tool"
```

**The Dockerfile.** For anything that should be part of the deployment rather
than a local fix — it is versioned, reproducible, and rebuilt on every update
anyway. This is the right home for `apt-get install` lines.

## Environment

Everything here is optional except the password and, with the Compose files,
`WORKSPACES_DIR`.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORTAL_PASSWORD` | — | Required. The single login password, at least 8 characters and not the example from `.env.example`; the portal will not start without one. A portal that already ran with a shorter password keeps starting with it, with a warning in the log and in Settings, but a new or changed one has to be long enough. Changing it ends every login made under the old one. |
| `PORTAL_ALLOW_NO_PASSWORD` | — | `1` runs with no login at all. Only safe behind a reverse proxy that authenticates, with the port unreachable otherwise. See [Running without a password](#running-without-a-password). |
| `ALLOW_OPEN` | — | `1` makes a portal with no password listen on every interface instead of `127.0.0.1` only. Both Compose files pass it. |
| `PORTAL_SECRET` | random | Signs the session cookie. Set it to survive restarts. |
| `PORT` | `4100` | Port to listen on. |
| `PORTAL_UPDATE_RESTART` | — | From source: how the **Update** button in Settings → About restarts the portal after it has built the new version. `exit` only stops it, with status 75, for a portal that something else starts again (pm2, a restart policy); `self` starts the new one itself. Unset, a portal that runs as a systemd service exits, and any other starts its own. A systemd unit needs `Restart=on-failure` or `Restart=always`. See [Settings](/guide/settings#update). |
| `TZ` | UTC | The time zone of the portal's clock, such as `Europe/Berlin`. A container keeps UTC unless it is told one. The quiet hours of an [agent's heartbeat](/guide/agents#its-heartbeat) and the schedule of a repeating [routine](/guide/routines) are read on this clock. Both Compose files pass it from `.env` or the shell. |
| `PORTAL_UPGRADE_BACKUP` | — | `skip` upgrades the database without the backup it is otherwise made first, for a volume with no room for the copy. Both Compose files pass it; see [Upgrading](/guide/upgrading#no-room-for-the-backup). |
| `PORTAL_UPDATE_CHECK` | — | From source: `off` stops the portal from fetching `origin/main` by itself at the start and every six hours to see whether there is something new. The **Update** button in Settings → About still asks when it is pressed. See [Settings](/guide/settings#update). |
| `EXECUTOR` | `host` | `host` or `container` — see [Architecture](/reference/architecture#executors). |
| `WORKSPACE_ROOT` | `/workspaces` | Where workspaces live inside the container. |
| `WORKSPACES_DIR` | — (required) | Compose only: the host folder mounted at `/workspaces`. |
| `PORTAL_DATA_DIR` | `portal-data` volume (`pithagoras-data` in the Portainer stack) | Compose only: an absolute host path to mount at `/data` instead of the volume. |
| `PORTAL_TLS_CERT` / `PORTAL_TLS_KEY` | — | Serve over HTTPS when both name a file; both Compose files mount `PORTAL_TLS_DIR` at `/certs`, so name the files there (`/certs/portal.crt`). |
| `PORTAL_CONTAINER_NAME` | `pithagoras` (Compose) | The portal's own container name, for managed add-ons and container mounts. Unset natively. |
| `PI_IMAGE` | `pithagoras-runner:latest` | Container executor's image. |
| `TASK_MEMORY_MB` / `TASK_CPUS` / `TASK_PIDS_LIMIT` | `2048` / `2` / `512` | Container executor limits. |
| `DOCKER_SOCKET` | `/var/run/docker.sock` | The Docker socket the add-ons and container executor talk to. |
| `VOICE_GPU` / `VOICE_VRAM_RESERVE_MIB` | — | Managed voice: the GPU it uses where none is chosen on the voice page, and memory in MiB to keep free on it. Both Compose files pass them from `.env`; see [Docker add-ons](/guide/add-ons#engines-devices-and-memory). |
| `NPM_REGISTRY_URL` | `https://registry.npmjs.org` | Registry the package catalogue searches. |
| `CHANNELS_DIR` | `/data/channels` (from source: `$DATA_DIR/channels`) | Where third-party channel packages install. |
| `AGENT_HOME` | `/data/agent-home` (from source: `$DATA_DIR/agent-home`) | The first agent's directory. Other agents are made in `agents/` beside it. |
| `PI_PROVIDER` | — | Overrides pi's `defaultProvider`. |
| `PI_MODEL` | — | Overrides pi's `defaultModel`. |
| `PI_THINKING_LEVEL` | — | Overrides pi's `defaultThinkingLevel`. |

The three `PI_*` variables are **overrides, not defaults**. Leave them empty and
pi's own `settings.json` decides — see
[the resolution order](/guide/settings#where-a-model-comes-from). They are empty
in the compose file for exactly that reason.

Provider credentials (`OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY` and
`OPENAI_API_KEY`) are passed from `.env` to pi by both Compose files. For another
provider, add its variable to the `environment:` list of the file, or save the
key under **Settings → Providers**, which needs no change to the file.

## Portainer

`docker-compose.portainer.yml` pulls a prebuilt image from GHCR instead of
building locally. Point a Portainer stack at it and set the same environment
variables: it passes everything `docker-compose.yml` does, the certificates and
the TLS variables, the password settings and the provider keys included, and
`WORKSPACES_DIR` is required there too. `PORTAL_DATA_DIR` works as it does there:
without it the data is in the volume `pithagoras-data`, which Docker names
`<stack>_pithagoras-data`. Set `PITHAGORAS_VERSION` to a release
(see [Upgrading](/guide/upgrading#pin-a-version)).

## Running from source

Node 22.19 or newer — pi requires it. The SQLite dependency supports Node 26
as well. After changing Node versions, run `npm ci` again before starting the
server so dependencies match the selected runtime.

To check that SQLite loads with your Node installation, run this from the
repository root after installing dependencies:

```bash
node --input-type=module -e 'import Database from "better-sqlite3"; const db = new Database(":memory:"); console.log(db.prepare("SELECT 1 AS ok").get()); db.close();'
```

A working installation prints `{ ok: 1 }`.

The server needs the `pi` CLI on your `PATH`, as the image has it, and a
password, as above. Everything it keeps for itself goes in `./data` unless you
set `DATA_DIR`: the database, `bin/`, `agent-home/`, `channels/` and the local
browser's profile. Nothing is written to `/data`, which only the image has.
The one exception is pi's conversation files, which go to `./data/sessions`
unless `SESSION_DIR` is set, also when `DATA_DIR` is: set both, or a moved
`DATA_DIR` leaves the conversations behind.

```bash
npm install
PORTAL_PASSWORD='a password of 8 or more characters' npm run dev:server   # API on :4100
npm run dev:web      # Vite dev server, proxying to it
```

`npm run dev:server` restarts the server when a source file changes. That is for
developing, and Settings → About has no **Update** button for it. To run the
portal from a checkout and update it from the page, build it and start the build:
`npm run build && npm start`, or as a service:

```ini
[Service]
WorkingDirectory=/srv/pithagoras
Environment=PORTAL_PASSWORD=…
ExecStart=/usr/bin/node server/dist/index.js
Restart=on-failure
```

The update ends the portal with status 75, which `Restart=on-failure` (or
`Restart=always`) starts again; see [Settings → Update](/guide/settings#update).

To try it without a login, set
`PORTAL_ALLOW_NO_PASSWORD=1` instead of the password; the server then listens on
`127.0.0.1` only, unless `ALLOW_OPEN=1` is set.

And the docs site you are reading:

```bash
npm run docs
```

## Publishing the docs

`.github/workflows/docs.yml` builds and deploys them to GitHub Pages on every
push to `main` that touches `docs/` or the workflow itself.

The workflow turns Pages on itself the first time it runs — `configure-pages`
is given `enablement: true` and the permission to use it — so a fork publishes
without anyone opening the settings screen. If your organisation restricts who
may enable Pages, do it once by hand instead: **Settings → Pages → Source →
GitHub Actions**.

The site is served from `/<repository name>/`, so the workflow sets `base` to
that, spelled as the repository is: GitHub Pages paths are case-sensitive, and a
fork has a name of its own. A build by hand uses `/pithagoras/`, the upstream's,
unless `DOCS_BASE` says otherwise. On a custom domain, where the site sits at the
root, set it to `/` in the workflow's build step:

```yaml
- run: npm run docs:build
  env:
    DOCS_BASE: /
```

## Container executor mounts

When the portal itself runs in Docker, set `PORTAL_CONTAINER_NAME` to its Docker container name. Both shipped Compose files set it to `pithagoras`, matching `container_name`. Update both values if you rename the container.

With `EXECUTOR=container`, the portal inspects its own mounts and translates workspace and session paths to their actual host locations, including named volumes and nested bind mounts. Paths outside those mounts are rejected rather than silently creating an empty host directory. The runtime image includes the Docker CLI and needs the Docker socket mount.

For a native portal talking to a Docker daemon on the same machine, leave `PORTAL_CONTAINER_NAME` unset: its paths already refer to the host. A remote daemon needs the same filesystem available on that daemon; local paths are not uploaded automatically. Set `PI_IMAGE` to an available runner image containing the `pi` CLI.

## Runner session permissions

The container executor creates each session directory before starting Docker and runs the runner with the portal process's numeric UID:GID. This overrides an image's `USER` directive so the process writing session files matches the owner of the mounted directory. It is root only when the portal itself runs as root. Capability dropping and `no-new-privileges` remain enabled.

Existing session directories must be writable by that portal user. For a custom non-root runner, ensure its executable and required configuration are readable by the portal UID, and any additional cache/home paths are writable. Fix ownership on the host rather than making the session directory world-writable.

## Running without a password

Without `PORTAL_PASSWORD` the portal does not start: it runs arbitrary commands, so an empty or misspelt password must not quietly open the port. Two settings, both deliberate, change that:

- `PORTAL_ALLOW_NO_PASSWORD=1` lets it start with no login. It then listens on `127.0.0.1` only, so a reverse proxy on the same host reaches it and nothing else does.
- `ALLOW_OPEN=1` on top of that makes it listen on every interface. This is what a proxy in another container, or on another machine, needs; anyone who can reach the port can then run commands, so the port must be closed to everything but the proxy.

Both Compose files pass both variables on. They bind to the host (`network_mode: host`), so `127.0.0.1` there is the host's own loopback, which a container on Docker's bridge network cannot reach: for a proxy in such a container, set `ALLOW_OPEN=1` and keep the port closed with the host's firewall. With a password, the portal listens on every interface and neither is needed.

Login attempts are limited per direct network source. A reverse proxy shares that limit across its clients; untrusted forwarding headers do not bypass it. The production UI sends a Content Security Policy that permits the local browser, microphone processing, and configured HTTP/WebSocket services.

Channel credentials are stored in the SQLite data volume without application-level encryption. Protect the volume and backups with filesystem permissions and disk encryption.
