# Deploying

Pithagoras ships as a container. It expects to run somewhere private — there is
a single password and no per-user separation, so put it behind Tailscale or a
VPN rather than on a public address.

## Docker Compose

```bash
git clone https://github.com/thecodacus/Pithagoras.git
cd Pithagoras
```

Create a `.env` next to `docker-compose.yml`:

```bash
PORTAL_PASSWORD=something-long
PORTAL_SECRET=$(openssl rand -hex 32)
WORKSPACES_DIR=/root/repos
```

`PORTAL_SECRET` signs the login cookie. Leave it out and logins are invalidated
on every restart, which is exactly the annoyance you would expect.

Then:

```bash
docker compose up -d --build
```

The portal listens on `:4100`. Compose uses `network_mode: host`, so it binds
that port directly on the host — which is also what lets pi reach a llama-server
running on the same machine at `localhost`.

## Installing add-ons

To install Browser or Voice from Settings:

- Keep the **Docker socket mount** and **host networking**.
- For Voice, configure **NVIDIA Container Toolkit** on the host.

Follow [Docker add-ons](/guide/add-ons) for installation, controls, storage and cleanup.

## Resuming container sessions

The container executor automatically removes completed runners. Before starting
a session, it also removes a leftover stopped runner with the same name, but
only when its ownership labels match that session.

A running runner is left alone. Wait for its current task to finish before
resuming. If an unrelated container uses the same name, the portal reports the
collision; inspect that container and rename or remove it yourself once you
have identified it. The portal does not force-delete it.

## Updating

```bash
git pull && docker compose up -d --build
```

Your data lives on the `portal-data` volume, not in the image. Sessions,
transcripts, installed pi packages and installed channel packages all survive a
rebuild.

## Volumes

| Path | Holds |
| --- | --- |
| `/data` | Everything stateful — see below |
| `/workspaces` | The directories pi works in, mounted from `WORKSPACES_DIR` |
| `/var/run/docker.sock` | Managed Browser/Voice add-ons and `EXECUTOR=container` |

Inside `/data`:

| Path | Holds |
| --- | --- |
| `/data/portal.db` | Sessions, event log, channels, settings |
| `/data/sessions/<id>` | Per-session working area |
| `/data/home` | `HOME` for pi — `~/.pi/agent`, its settings and packages |
| `/data/channels` | Installed third-party channel packages |
| `/data/agent-home` | The agent's fixed working directory |
| `/data/bin` | CLIs you add yourself — on `PATH`, survives rebuilds |

`HOME` deliberately points at the volume. Otherwise every image rebuild would
silently wipe the pi packages you installed.

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
volume. Drop a binary there — no redeploy, no image change:

```bash
docker exec pithagoras sh -c "curl -fsSL <url> -o /data/bin/tool && chmod +x /data/bin/tool"
```

**The Dockerfile.** For anything that should be part of the deployment rather
than a local fix — it is versioned, reproducible, and rebuilt on every update
anyway. This is the right home for `apt-get install` lines.

## Environment

Everything here is optional except the password.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORTAL_PASSWORD` | — | Required. The single login password. |
| `PORTAL_SECRET` | random | Signs the session cookie. Set it to survive restarts. |
| `PORT` | `4100` | Port to listen on. |
| `EXECUTOR` | `host` | `host` or `container` — see [Architecture](/reference/architecture#executors). |
| `WORKSPACE_ROOT` | `/workspaces` | Where workspaces live inside the container. |
| `CHANNELS_DIR` | `/data/channels` | Where third-party channel packages install. |
| `AGENT_HOME` | `/data/agent-home` | The agent session's working directory. |
| `PI_PROVIDER` | — | Overrides pi's `defaultProvider`. |
| `PI_MODEL` | — | Overrides pi's `defaultModel`. |
| `PI_THINKING_LEVEL` | — | Overrides pi's `defaultThinkingLevel`. |

The three `PI_*` variables are **overrides, not defaults**. Leave them empty and
pi's own `settings.json` decides — see
[the resolution order](/guide/settings#where-a-model-comes-from). They are empty
in the compose file for exactly that reason.

Provider credentials (`OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, and anything
else pi understands) pass straight through to pi.

## Portainer

`docker-compose.portainer.yml` pulls a prebuilt image from GHCR instead of
building locally. Point a Portainer stack at it and set the same environment
variables.

## Running from source

Node 22.19 or newer — pi requires it.

```bash
npm install
npm run dev:server   # API on :4100
npm run dev:web      # Vite dev server, proxying to it
```

And the docs site you are reading:

```bash
npm run docs
```

## Publishing the docs

`.github/workflows/docs.yml` builds and deploys them to GitHub Pages on every
push to `main` that touches `docs/`, `channels/` or the workflow itself.

The workflow turns Pages on itself the first time it runs — `configure-pages`
is given `enablement: true` and the permission to use it — so a fork publishes
without anyone opening the settings screen. If your organisation restricts who
may enable Pages, do it once by hand instead: **Settings → Pages → Source →
GitHub Actions**.

The site is served from `/pithagoras/`, so `base` is set to match. On a custom
domain, where the site sits at the root, override it:

```yaml
- run: npm run docs:build
  env:
    DOCS_BASE: /
```
