# Deploying

Pithagoras ships as a container. It expects to run somewhere private — there is
a single login (a password, and optionally a [single sign-on](#single-sign-on)
provider) and no per-user separation, so put it behind Tailscale or a VPN rather
than on a public address.

## Docker Compose

```bash
git clone https://github.com/thecodacus/Pithagoras.git
cd Pithagoras
```

Create a `.env` next to `docker-compose.yml`. This writes one, with a secret of
its own (change the folder first, between the single quotes, where `%`, `$` and
`\` are taken as they are, and it cannot hold a `'`):

```bash
printf "WORKSPACES_DIR='%s'\nPORTAL_SECRET=%s\n" '/path/to/repos' "$(openssl rand -hex 32)" > .env
```

The typed value goes into the file in single quotes on purpose. Compose reads a
`.env` value without quotes as its own syntax: `$name` becomes a variable (or
nothing), `$$` becomes one `$`, and ` #` starts a comment. The portal would then
get another folder than the one you typed. Between single quotes the value is
taken as it is. If you write the file by hand, quote a value that has a `$` or a
`#` in it the same way.

There is no password in it: the portal asks for one in the browser the first
time you open it, see [The password](#the-password).

Write `PORTAL_SECRET=` followed by the output of `openssl rand -hex 32` if you
make the file by hand. Compose does not run commands in a `.env`: the text
`PORTAL_SECRET=$(openssl rand -hex 32)` would be the secret itself, the same for
everyone who copied it from here. The portal says so when it starts with one.

`.env.example` lists every variable Compose reads, bar `PORTAL_PASSWORD`, which only
an install from before has. `WORKSPACES_DIR` is the host
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

Open `http://<host>:4100`, choose a password when the page asks for one, and add
a model provider under **Settings → Providers** — the setup assistant offers to
find a local server, or take a key. Nothing else is needed for a first chat.

The portal listens on `:4100`. Compose uses `network_mode: host`, so it binds
that port directly on the host — which is also what lets pi reach a llama-server
running on the same machine at `localhost`.

## The password

The portal runs arbitrary commands on the host, so it is behind one password. The
password is chosen in the browser and kept, hashed (scrypt), in the portal's
database; there is no `PORTAL_PASSWORD` to set, in Compose, in `.env` or anywhere
else.

**The first start.** A portal with no password shows a page that asks for one, at
least 8 characters, typed twice, and signs you in with it. Until it is chosen the
portal answers nothing else, and **whoever opens it first chooses the password**:
open it yourself as soon as it is up, and keep the port closed to others until
you have, which is easy on Tailscale or a VPN and not on a public address. The
log says it is waiting. This works the same in Docker and on a headless machine:
open the address from any browser that can reach it.

**Changing it.** **Settings → Authentication** takes the current password and the new
one twice; it signs out every other browser, and closes every chat view, terminal and
browser stream that was open, in the one you changed it in as well (that page opens
them again with its new login). See [Settings](/guide/settings#password).

**An install from before.** A portal that took its password from `PORTAL_PASSWORD`
moves it into the database on its first start after the upgrade and says so in the
log. The variable is ignored from then on (a value that differs from the password
in the database is said to be ignored at each start), so remove it from `.env`.
Logins made before the upgrade are asked for the password once more. See
[Upgrading](/guide/upgrading#the-password-moves-into-the-database).

### A lost password

Nothing recovers a password from the portal, which keeps only its hash. A server
command removes it instead, after asking you to type `reset`:

```bash
# Docker Compose (the container is called pithagoras in both Compose files)
docker exec -it pithagoras node core/server/dist/reset-password.js

# Native, from the folder the portal runs from (or with the same DATA_DIR)
npm run reset-password
```

A running portal needs no restart: it is waiting on its setup screen at once, every
login is ended and so is every chat view, terminal and browser stream that was open
(within a couple of seconds), and you choose a new password as on the first start (so
do it straight away, for the same reason). A leftover `PORTAL_PASSWORD` is not read
again, so the reset cannot be undone by a restart.

A portal that was started with `PORTAL_ALLOW_NO_PASSWORD=1` and a password is not
opened by the reset either: it waits on the setup screen like any other. A *restart*
with the variable still set and no password does run with no login (on this machine
only, unless `ALLOW_OPEN=1`), so choose a new password before restarting, or take the
variable out. The command says so when the variable is set where it runs.

## Single sign-on

The portal can also sign you in through an OpenID Connect provider (Authentik,
Keycloak, Entra ID, Google, Zitadel, Authelia and the like), beside the password or
instead of it. It is set up in the browser, under **Settings → Authentication**
(the **Single sign-on** section, closed until you open it),
and kept in the portal's database like the password; there are no variables to
set. The login page then has a **Sign in with …** button. What the provider lets in
gets the same login cookie the password gives, so the API, the event streams and the
agent's browser work as they do with the password. It is still one login for one
person: everyone the provider signs in is the same user.

Single sign-on needs the portal's password: it is set up after the password is
chosen, saving its settings asks for the password, and the login cookie is signed
with it. On a portal waiting on its setup screen (after `reset-password`, say) the
button is not shown until a password is chosen again; the settings are kept. A portal
with `PORTAL_ALLOW_NO_PASSWORD=1` has no login, and so no single sign-on.

At the provider, make an OpenID Connect client for the authorization code flow:

- Redirect URI: the portal's address followed by `/api/auth/oidc/callback`, such
  as `https://portal.example.com/api/auth/oidc/callback`. The settings page fills it
  in from the address it is open at; register what it says.
- Confidential, with a client secret, or public without one: the portal uses PKCE
  either way.
- With **End the session at the provider too**, also allow the portal's address
  with a `/` at the end (`https://portal.example.com/`) as the post-logout redirect URI.

Then fill in the settings page: the **issuer URL** exactly as the provider names
itself in `/.well-known/openid-configuration` (a trailing `/` counts; `https` only,
plain `http` only for a provider on the same machine), the **client ID** and
**secret** and the **redirect URL**. The scopes default to
`openid email profile`, the button to "SSO". The client secret is never shown again
once saved; leaving the field empty keeps it. That holds for the same issuer and
client only: with another one the kept secret is not sent, and saving asks you to
type the secret again, or to remove it for a public client.

**Who may sign in is decided at the provider**, not in the portal: the portal has
no list of emails, groups or accounts. Every account the provider signs in, with an
ID token that checks out (its signature, issuer, audience, nonce and expiry), gets
in. Limit the client to your people at the provider before you point the portal at
it:

- Authentik: group or user bindings on the application.
- Keycloak: a realm of your own people, with user registration off.
- Entra ID: *Assignment required* on the enterprise application.
- Authelia: an authorization policy on the client that names your people.
- Google: the consent screen's audience *Internal* (a Google Workspace
  organisation), or *Testing* with your people listed as test users. An *External*
  app that is published (*In production*) lets in every Google account there is, so
  do not publish it.

Other providers have a switch of their own for this; find it first. Do not point the
portal at a provider that signs in anybody, such as one with open registration.

When the settings are saved, the portal reads the provider's discovery document and
keys, and refuses settings it does not answer to, with the reason: a provider that
cannot be reached, calls itself by another issuer, does not offer PKCE with `S256`,
or signs ID tokens with nothing but a shared secret. A provider that is down later
does not open anything: its button says it cannot be reached, and the password
still signs in (unless OIDC only is on).

The sign-in ends at the address of the redirect URL. A button pressed on the portal
opened by another name (its IP address, another host name) first sends the browser
to that address, and you are signed in there, so open the portal at that address.

A login lasts 30 days, as with the password. When the provider's own session or
token runs out, the portal's login does not end, and blocking an account at the
provider does not end a login the account already has. Changing the issuer, the
client ID or **OIDC only** ends every login, the provider's and the
password's (the browser that saved it is signed in again), as changing the password does.

### OIDC only

**OIDC only** hides the password form on the login page and refuses the password
login: the provider is the only way in. The password stays set, and saving the
single sign-on settings still asks for it. Turning it on ends every login, so a
password login somebody else holds stops working too. Sign in through the provider
once before you turn it on.

If the provider stops letting you in, a server command switches the password login
back on, after asking you to type `on`:

```bash
# Docker Compose
docker exec -it pithagoras node core/server/dist/sso-only-off.js

# Native, from the folder the portal runs from (or with the same DATA_DIR)
npm run sso-only-off
```

A running portal takes it at once: the password signs in again, every login ends,
and the provider's settings stay as they were. A lost password as well is removed
with `reset-password` (above), which leaves OIDC only as it is; run both.

### Authentik

Under **Applications**, create an application with an **OAuth2/OpenID Provider**,
client type *Confidential*, and the redirect URI above (mode *strict*). The issuer
is shown on the provider's page, with a `/` at the end, such as
`https://authentik.example.com/application/o/pithagoras/`. To limit who signs in,
bind the application to a group or to users (its **Policy / Group / User
Bindings** tab).

### Keycloak

In the realm, create a client: *OpenID Connect*, **Client authentication** on,
**Standard flow** on, the redirect URI above under **Valid redirect URIs**, and the
portal's address with a `/` at the end (`https://portal.example.com/`) under
**Valid post logout redirect URIs**, since Keycloak compares it as written. Copy the
secret from **Credentials**. The issuer is `https://keycloak.example.com/realms/<realm>`. Every
user of the realm can sign in, so use a realm that holds your people only.

## HTTPS

Browsers offer notifications and installing the portal as an app only over
HTTPS or on `localhost`, and the [Browser](/guide/browser) extension's embedded browser needs it. Either put a proxy
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

## Installing the voice service and the agent's browser

To install the voice service through the Voice and Docker extensions, or the
agent's browser through the Browser and Docker extensions (Voice servers, for
speech servers you run yourself, needs neither):

- Keep the **Docker socket mount** and **host networking**.
- For voice service engines on an NVIDIA GPU, configure **NVIDIA Container
  Toolkit** on the host. Kokoro and speech recognition run on the CPU without a
  GPU or the toolkit ([GPU access for Voice](/guide/voice-service#gpu-access-for-voice)).

Follow [The voice service](/guide/voice-service) for its installation, controls,
storage and cleanup, [Voice servers](/guide/voice-servers) for your own speech
servers, and [The agent's browser](/guide/browser) for the browser's.

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

## Restarting

Settings → About has a **Restart** button (see [Settings](/guide/settings#restart)).
It ends the portal with **status 75** and leaves the start to whatever runs it,
so that nothing needs a shell on the host. The portal first winds down what is
running, as it does on SIGTERM; a request that is being answered gets two seconds
to finish. What starts it again:

| Run as | Restarts on 75 because |
| --- | --- |
| `docker compose` (`docker-compose.yml`, `docker-compose.portainer.yml`) | `restart: unless-stopped` starts a container again whatever its status, and `init: true` passes the status on |
| a systemd service | `Restart=on-failure` (or `always`): systemd counts a status other than 0 as a failure and starts the unit after `RestartSec` |
| pm2, `while true` and the like | set `PORTAL_UPDATE_RESTART=exit`; they start it again on any status |

A container started with `docker run` and no `--restart` stays stopped. The portal
asks Docker over its socket for the container's restart policy (by
`PORTAL_CONTAINER_NAME`, or the hostname) and turns the button off when Docker says
there is none. Where Docker cannot be asked (no socket, the daemon does not answer)
or does not know the container (a `--hostname` that is not its name, with no
`PORTAL_CONTAINER_NAME`), it assumes the policy is there, so set
`PORTAL_CONTAINER_NAME` for a container that was not started from the Compose files.
A portal started by hand, with nothing that starts it again, says that a restart is
not possible here and does nothing. Each restart that is started is logged:
`[restart] the owner asked for a restart at <time> from <address>`; a request that
is refused writes nothing. A restart is refused while an update runs.

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
| `/var/run/docker.sock` | The [Docker](/guide/docker) extension (which runs the containers of the [Browser](/guide/browser), [Voice](/guide/voice-service) and [Understory](/guide/features#memory-understory) extensions) and `EXECUTOR=container` |

The portal closes `/data` to every account but the one it runs as (mode `0700`)
each time it starts, a folder made by hand or by an older version too:
`portal.db` holds the channels' bot tokens and every conversation. A data
folder on the host, mounted as `/data`, is closed the same way.

Inside `/data`:

| Path | Holds |
| --- | --- |
| `/data/portal.db` | Sessions, event log, channels, agents, routines, settings |
| `/data/portal.sock` | Held while the portal runs, so a second one cannot start on this data |
| `/data/backups` | The copies of the database made before an [upgrade](/guide/upgrading), and Media's and Browser's folders where they were set aside to go back to a version before each was an extension (see [Upgrading](/guide/upgrading#going-back)) |
| `/data/sessions/<id>` | Per-session working area, and pi's file of the chat's conversation: it is what the agent remembers. Do not clear it |
| `/data/home` | `HOME` for pi — `~/.pi/agent`, its settings, skills and packages |
| `/data/channels` | Installed third-party channel packages |
| `/data/channel-state` | What a channel keeps between its starts, such as where Signal's stream was |
| `/data/agent-home` | The first agent's home: its `SOUL.md`, `PrimaryUser.md`, `MEMORY.md` |
| `/data/agents/<id>` | The home of every other [agent](/guide/agents) |
| `/data/images` | The pictures sent with each chat's messages, in a folder per chat. What the agent makes is in the chat's folder, under `generated-images`, and what the [Media page](/guide/media) makes is in Media's folder (below) |
| `/data/extension-data/<package>` | What an extension keeps for itself, out of the agents' reach (see [where it keeps things](/guide/extension-ui#where-it-keeps-things)) |
| `/data/extension-data/pithagoras-media` | [Media](/guide/media)'s: `media.db`, its galleries' lists and the settings of its endpoints, keys included; `images` and `videos`, the pictures and videos the Media page made itself, kept until you delete them; `image-thumbs` and `video-posters`, the small copies of pictures and the first-frame pictures of videos (those only when there is an `ffmpeg`), which can be deleted at any time and are made again; `video-copies`, the playable WebM copies made on request, with an `ffmpeg`, of clips a browser cannot play (see [Media](/guide/media#clips-a-browser-cannot-play)), each of which can be deleted at any time |
| `/data/extension-data/pithagoras-browser` | [Browser](/guide/browser)'s: `settings.json`, its settings with the password of the browser's web UI; `profile`, the profile of the machine's own Chrome where Browser runs one (the container's is the volume `pithagoras_browser-profile`) |
| `/data/handoff` | What an upgrade left for an extension to take up, such as `handoff/media` until Media has taken it up and `handoff/browser` until Browser has (see [Upgrading](/guide/upgrading#media-is-an-extension)) |
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
- **The memory of the Understory run here**, if you use it: the volume
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
Understory first (**Settings → Extension settings → Memory → Stop**) if you want to
be sure no tidy-up pass is writing:

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

Everything here is optional except, with the Compose files, `WORKSPACES_DIR`.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORTAL_PASSWORD` | — | Not a setting any more: the password is chosen in the browser ([The password](#the-password)). An install from before that has it set has it moved into the database once, on the first start after the upgrade, and the variable is ignored from then on. |
| `PORTAL_ALLOW_NO_PASSWORD` | — | `1` runs with no login at all, and with no password to choose. Only safe behind a reverse proxy that authenticates, with the port unreachable otherwise. See [Running without a password](#running-without-a-password). |
| `ALLOW_OPEN` | — | `1` makes a portal with no login listen on every interface instead of `127.0.0.1` only. Both Compose files pass it. |
| `PORTAL_SECRET` | random | Signs the session cookie. Set it to survive restarts. |
| `PORT` | `4100` | Port to listen on. |
| `PITHAGORAS_LOG_LEVEL` | `info` | `debug` also keeps and prints the debug lines in the server's log and in Settings → Logs: so far one per tool call and approval, with the tool, the outcome and the time it took, and nothing a tool was given or returned. Both Compose files pass it. See [Settings](/guide/settings#logs). |
| `PITHAGORAS_LOG_LINES` / `PITHAGORAS_LOG_CHARS` | `2000` / `2000000` | How many lines, and how many characters of them, Settings → Logs keeps in memory (100 to 50000 lines, 200000 to 20000000 characters). Debug lines count against the same limits, so raise the lines with `PITHAGORAS_LOG_LEVEL=debug`. Both Compose files pass them. |
| `PORTAL_UPDATE_RESTART` | — | From source: how the **Update** button in Settings → About restarts the portal after it has built the new version, and whether the **Restart** button may start a copy of it itself (`self`) or only stop it (`exit`, see [Restarting](#restarting)). `exit` only stops it, with status 75, for a portal that something else starts again (pm2, a restart policy); `self` starts the new one itself. Unset, a portal that is a systemd service's own process exits; one that only is in a service's control group (`npm start` under dash, a wrapper script, a cron job) starts its own copy and exits with status 75 as well; any other starts its own. A systemd unit needs `Restart=on-failure` or `Restart=always`. See [Settings](/guide/settings#update). |
| `TZ` | UTC | The time zone of the portal's clock, such as `Europe/Berlin`. A container keeps UTC unless it is told one. The quiet hours of an [agent's heartbeat](/guide/agents#its-heartbeat) and the schedule of a repeating [routine](/guide/routines) are read on this clock. Both Compose files pass it from `.env` or the shell. |
| `PORTAL_UPGRADE_BACKUP` | — | `skip` upgrades the database without the backup it is otherwise made first, for a volume with no room for the copy. Both Compose files pass it; see [Upgrading](/guide/upgrading#no-room-for-the-backup). |
| `PORTAL_DEFAULT_EXTENSIONS` | — | `off` keeps the portal from installing the extensions it starts with (the terminal, Git, Files, Canvases, Media and the theme pack) on its first start: you choose every extension yourself, in Settings → Extensions. See [What a portal starts with](/guide/extensions#what-a-portal-starts-with). |
| `PORTAL_UPDATE_CHECK` | — | From source: `off` stops the portal from fetching `origin/main` by itself at the start and every six hours to see whether there is something new. The **Update** button in Settings → About still asks when it is pressed. See [Settings](/guide/settings#update). |
| `EXECUTOR` | `host` | `host` or `container` — see [Architecture](/reference/architecture#executors). |
| `WORKSPACE_ROOT` | `/workspaces` | Where workspaces live inside the container. |
| `WORKSPACES_DIR` | — (required) | Compose only: the host folder mounted at `/workspaces`. |
| `PORTAL_DATA_DIR` | `portal-data` volume (`pithagoras-data` in the Portainer stack) | Compose only: an absolute host path to mount at `/data` instead of the volume. |
| `PORTAL_TLS_CERT` / `PORTAL_TLS_KEY` | — | Serve over HTTPS when both name a file; both Compose files mount `PORTAL_TLS_DIR` at `/certs`, so name the files there (`/certs/portal.crt`). |
| `PORTAL_CONTAINER_NAME` | `pithagoras` (Compose) | The portal's own container name, for the containers extensions run on its network (the voice service's, Understory's) and container mounts. Unset natively. |
| `PI_IMAGE` | `pithagoras-runner:latest` | Container executor's image. |
| `TASK_MEMORY_MB` / `TASK_CPUS` / `TASK_PIDS_LIMIT` | `2048` / `2` / `512` | Container executor limits. |
| `DOCKER_SOCKET` | `/var/run/docker.sock` | The Docker socket the [Docker](/guide/docker) extension and the container executor talk to. The portal also reads its own container's restart policy through it, for Settings → About → Restart. |
| `VOICE_GPU` / `VOICE_VRAM_RESERVE_MIB` | — | The voice service: the GPU it uses where none is chosen on its page, and memory in MiB to keep free on it. Read by the Voice extension; both Compose files pass them from `.env`; see [The voice service](/guide/voice-service#engines-devices-and-memory). |
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

The server needs the `pi` CLI on your `PATH`, as the image has it. Everything it keeps for itself goes in `./data` unless you
set `DATA_DIR`: the database, `bin/`, `agent-home/`, `channels/` and the local
browser's profile. Nothing is written to `/data`, which only the image has.
The one exception is pi's conversation files, which go to `./data/sessions`
unless `SESSION_DIR` is set, also when `DATA_DIR` is: set both, or a moved
`DATA_DIR` leaves the conversations behind.

```bash
npm install
npm run dev:server   # API on :4100
npm run dev:web      # Vite dev server, proxying to it
```

`npm run dev:server` restarts the server when a source file changes. That is for
developing, and Settings → About has no **Update** button for it. To run the
portal from a checkout and update it from the page, build it and start the build:
`npm run build && npm start`, or as a service:

```ini
[Service]
WorkingDirectory=/srv/pithagoras
ExecStart=/usr/bin/node core/server/dist/index.js
Restart=on-failure
```

The update ends the portal with status 75, which `Restart=on-failure` (or
`Restart=always`) starts again; see [Settings → Update](/guide/settings#update).

The page asks for a password the first time. To try it without a login, set
`PORTAL_ALLOW_NO_PASSWORD=1` for the server instead; it then listens on
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

A portal with no password does not run without a login by itself: it waits on the page that asks for one ([The password](#the-password)), and answers nothing else. Two settings, both deliberate, run it with no login at all instead:

- `PORTAL_ALLOW_NO_PASSWORD=1` lets it start with no login and no password to choose (there is none to change in Settings either). It then listens on `127.0.0.1` only, so a reverse proxy on the same host reaches it and nothing else does.
- `ALLOW_OPEN=1` on top of that makes it listen on every interface. This is what a proxy in another container, or on another machine, needs; anyone who can reach the port can then run commands, so the port must be closed to everything but the proxy.

A password the portal already holds wins over `PORTAL_ALLOW_NO_PASSWORD`: the login applies, and a password removed with the reset command leaves the running portal on its setup screen, not open. Only a start with no password at all runs with no login.

Both Compose files pass both variables on. They bind to the host (`network_mode: host`), so `127.0.0.1` there is the host's own loopback, which a container on Docker's bridge network cannot reach: for a proxy in such a container, set `ALLOW_OPEN=1` and keep the port closed with the host's firewall. With a password, or while it waits for one, the portal listens on every interface and neither is needed.

Login attempts are limited per direct network source. A reverse proxy shares that limit across its clients; untrusted forwarding headers do not bypass it. The production UI sends a Content Security Policy that permits the local browser, microphone processing, and configured HTTP/WebSocket services.

Channel credentials are stored in the SQLite data volume without application-level encryption. Protect the volume and backups with filesystem permissions and disk encryption.
