# Configuration

Configuration comes from four places. Knowing which one wins saves a lot of
confusion.

## The four layers

| Layer | Set from | Applies to |
| --- | --- | --- |
| Session | The pills under the composer | One session |
| Portal | Settings → Defaults | New sessions |
| Environment | Compose / `.env` | The deployment |
| pi | `~/.pi/agent/settings.json` | pi itself, everywhere |

For model, effort and provider, they resolve in that order — first non-empty
wins, with a last-resort constant behind pi:

```
session → portal override → environment → pi settings.json → fallback
```

Everything past the session layer is a *default*. A session that has made its
own choice keeps it, and changing a default never rewrites a running session.

::: tip Empty means inherit
`PI_PROVIDER`, `PI_MODEL` and `PI_THINKING_LEVEL` are overrides, and they are
empty in the compose file on purpose. Give them a value and pi's own
`settings.json` can never be reached. The same is true in Settings → Defaults:
an empty field inherits, and clearing one hands the setting back.
:::

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORTAL_PASSWORD` | — | Not a setting any more: the password is chosen in the browser on the first start and kept hashed in the database ([Deploying](/guide/deploying#the-password)). A portal upgraded from a release that read it moves the value into the database on the first start, and ignores the variable from then on. |
| `PORTAL_ALLOW_NO_PASSWORD` | — | `1` runs with no login at all and no password to choose, on `127.0.0.1` only. Only safe behind a reverse proxy that authenticates, with the port unreachable otherwise. |
| `PORTAL_SECRET` | random | Signs the cookie. Set it to survive restarts. |
| `PORT` | `4100` | Listen port. |
| `TZ` | UTC in the image | The time zone of the portal's clock, such as `Europe/Berlin`. The quiet hours of an agent's heartbeat and the schedule of a repeating routine are read on it, and Settings → Add-ons → Memory's tidy-up time. Both Compose files pass it on. |
| `DATA_DIR` | `./data` (image: `/data`) | Where `portal.db` lives, with the `backups/` made before a database upgrade and `images/`: the Media page's own pictures, and the pictures sent with a chat's messages, in a folder per chat (removed with it). The pictures the agent makes go in a `generated-images` folder inside the chat's own folder instead. `videos/`, `video-posters/` and `video-copies/` hold the [Media page's](/guide/media) own videos (every format an endpoint sent, as files), their posters and the playable copies of those a browser cannot play, and the agent's videos go in a `generated-videos` folder inside the chat's folder. Only one portal may run on it at a time. |
| `FFMPEG_PATH` | `ffmpeg` on the `PATH` | The `ffmpeg` the portal runs to make the small first-frame pictures of videos on the [Media page](/guide/media#the-gallery), and the WebM copies of clips a browser cannot play (on request). Optional: without one the page shows each video's first frame as the browser draws it, offers no copies, and nothing else changes. The container image does not have ffmpeg; install it in a derived image or set this to a binary that is mounted in. |
| `PITHAGORAS_VERSION` | `latest` | The release the Portainer stack runs, such as `0.2.0`. See [Upgrading](/guide/upgrading#pin-a-version). |
| `PORTAL_UPGRADE_BACKUP` | — | `skip` upgrades the database without backing it up first, for a disk that cannot hold the copy. Both Compose files pass it on. See [Upgrading](/guide/upgrading#no-room-for-the-backup). |
| `SESSION_DIR` | `./data/sessions` (image: `/data/sessions`) | One folder per session, holding pi's conversation file. Removed when the session is deleted — with the container executor, a file written by another user can keep a folder from going; that is logged. |
| `WORKSPACE_ROOT` | `/workspaces` | Directories sessions can be created against. `WORKSPACES_DIR` is read as well, when this is unset. |
| `WORKSPACES_DIR` | — (required in Compose) | Compose only: the host folder mounted at `/workspaces`. Both Compose files refuse to start without it. |
| `BIN_DIR` | `$DATA_DIR/bin` (image: `/data/bin`) | Persistent folder for command-line tools. The portal creates it. The image puts `/data/bin` last on `PATH`; with another value, or when you run from source, add the folder to `PATH` yourself. |
| `PI_CODING_AGENT_DIR` | `$HOME/.pi/agent` | Override pi’s settings/package directory. |
| `LLAMA_BASE_URL` | — | Read by pi’s installed llama extension; not by the portal directly. |
| `CHANNELS_DIR` | `$DATA_DIR/channels` (image: `/data/channels`) | Installed channel packages. |
| `AGENT_HOME` | `$DATA_DIR/agent-home` (image: `/data/agent-home`) | The first agent's directory. Any other agent gets one under `agents/`, beside it. See [Agents](/guide/agents). |
| `HOME` | `/data/home` | pi's home — its settings and packages. |
| `EXECUTOR` | `host` | `host` or `container`. |
| `PI_IMAGE` | `pithagoras-runner:latest` | Image for the container executor. |
| `TASK_MEMORY_MB` | `2048` | Container executor memory ceiling. |
| `TASK_CPUS` | `2` | Container executor CPU ceiling. |
| `TASK_PIDS_LIMIT` | `512` | Container executor process ceiling. |
| `PI_PROVIDER` | — | Override for pi's `defaultProvider`. |
| `PI_MODEL` | — | Override for pi's `defaultModel`. |
| `PI_THINKING_LEVEL` | — | Override for pi's `defaultThinkingLevel`. |
| `PI_SUBAGENT_BIN` | `pi` | The `pi` the bundled subagent tool starts. |
| `MEMORY_UNDERSTORY_URL` | `http://localhost:3800/mcp` | Where Settings → Add-ons → Memory looks for Understory first. |
| `MEMORY_UNDERSTORY_AUTH_TOKEN` | — | Understory's bearer token, named in `mcp.json` rather than copied into it. |
| `UNDERSTORY_PORT` | `3800` | The port the Understory the portal runs listens on (host network). |
| `UNDERSTORY_LLM_HEADERS_TIMEOUT_MS` | `1800000` | How long, in ms, the portal waits for an answer from the model Understory thinks with before it gives up and says so — until its headers arrive; an answer that does not stream (what Understory gets today) sends no byte until it is done, so this covers the whole of it there. Node's own fetch cuts one off after five quiet minutes. `0` sets no wait. |
| `UNDERSTORY_LLM_BODY_TIMEOUT_MS` | `1800000` | How long, in ms, a streaming answer from that model may go quiet between bytes before it is cut off. `0` turns the wait off. |
| `PORTAL_FETCH_HEADERS_TIMEOUT_MS` | `1800000` | A ceiling of quiet, not of work: how long, in ms, any fetch the portal's process makes — pi's MCP tool calls among them — may wait for an answer's first byte before it is cut off; Node's own fetch cuts one off after five quiet minutes. The default outlasts Understory's own model wait, so a run allowed to think half an hour is not cut off mid-thought by the client waiting on it. `0` sets no wait. |
| `PORTAL_FETCH_BODY_TIMEOUT_MS` | `1800000` | How long, in ms, a streaming answer to such a fetch may go quiet between its bytes before it is cut off; an answer that keeps moving is never cut by these waits. `0` turns the wait off. |
| `NPM_REGISTRY_URL` | `https://registry.npmjs.org` | Registry the package catalogue in Settings → Extensions searches. |
| `DOCKER_SOCKET` | `/var/run/docker.sock` | The Docker socket the managed add-ons use. |
| `PORTAL_CONTAINER_NAME` | — (Compose: `pithagoras`) | The portal's own container name; managed voice joins its network, the container executor finds its mounts through it, and the database repair steps shown by the upgrade page use it. |
| `PORTAL_TLS_CERT` / `PORTAL_TLS_KEY` | — | Serve over HTTPS when both name a file. |
| `PORTAL_UPDATE_CHECK` | — | `off` stops the portal from fetching `origin/main` by itself, at the start and every six hours, to see whether there are new commits; the Update button in Settings → About still asks when it is pressed. |
| `PITHAGORAS_LOG_LEVEL` | `info` | `debug` also keeps and prints the debug lines, in the server's log and in Settings → Logs. They cover tool calls and approvals so far (the tool, the outcome and the time it took, never what a tool was given or returned). Both Compose files pass it on. See [Settings → Logs](/guide/settings#logs). |
| `PITHAGORAS_LOG_LINES` / `PITHAGORAS_LOG_CHARS` | `2000` / `2000000` | How many lines, and how many characters of them, Settings → Logs keeps in memory: from 100 to 50000 lines and from 200000 to 20000000 characters. A value that is not a whole number leaves the default. Debug lines count against the same limits, so raise the lines with `PITHAGORAS_LOG_LEVEL=debug`. Both Compose files pass them on. |
| `PORTAL_UPDATE_RESTART` | — | How the Update button restarts the portal after the build, and whether the Restart button may start a copy (`self`) or only stop it (`exit`): `exit` stops it with status 75 and leaves starting it to its manager (pm2, a container's restart policy, systemd with `Restart=on-failure` or `always`), `self` starts the new copy itself. Unset: a portal that is a systemd service's own process exits; one that is only in a service's control group (`npm start` under dash, a wrapper script, a cron job) starts its own copy and also exits with status 75; anything else starts its own copy. See [Settings → About](/guide/settings#update). |
| `ALLOW_OPEN` | — | `1` lets a portal with no login listen on every interface; without it, `PORTAL_ALLOW_NO_PASSWORD=1` binds `127.0.0.1` only. Both Compose files pass it on. See [Running without a password](/guide/deploying#running-without-a-password). |
| `GIT_SSH_COMMAND` | `ssh -o BatchMode=yes` | What the Git panel's fetch, pull and push run ssh with. |
| `LLAMA_DISK_CACHE_MODELS` | — | Comma-separated model names whose llama.cpp prompt cache is kept on disk between chats. The server needs `--parallel 1` and a `--slot-save-path`; chats on that model then run one at a time. See [Session prefill snapshots](/guide/voice#session-prefill-snapshots). |
| `UNDERSTORY_VOLUME` | `pithagoras_understory-memory` | The volume holding that Understory's memory. |
| `VOICE_GPU` | — | The GPU index the managed voice container uses, as `nvidia-smi` lists them, where no GPU is chosen on the page (which wins). Empty: the card with the most free memory. See [Docker add-ons](/guide/add-ons#engines-devices-and-memory). |
| `VOICE_VRAM_RESERVE_MIB` | — | GPU memory in MiB the voice installer keeps free on its card for something else. |
| `NVIDIA_SMI` | `nvidia-smi` | The binary the voice installer reads the GPUs with, for a native portal where it is not on `PATH`. |

The Browser add-on's `BROWSER_*` variables are in [Docker add-ons](/guide/add-ons), and the `VOICE_*` ones in [Voice control](/guide/voice).

Settings that are kept in the browser rather than on the server — theme, language,
notifications, confirmations, shortcuts — are in [The interface](/guide/interface).

The host executor inherits the portal environment. The container executor forwards `PI_PROVIDER`, `PI_MODEL` and, of `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY` and `OPENAI_API_KEY`, only the key of the provider the chat runs on (none for a provider of its own, such as llama.cpp); it does not forward arbitrary extension variables. Explicit session provider/model choices are passed as CLI arguments.

Both Compose files forward `PI_IMAGE` and the three `TASK_*` limits. These limits apply only to `EXECUTOR=container`: memory must be an integer of at least 6 MiB, CPUs must be positive (fractions are allowed), and the process limit must be a positive integer. Empty values inherit defaults; zero, negative and non-numeric values are rejected explicitly.

`HOME` on the data volume is load-bearing. Point it back at the container
filesystem and every image rebuild silently wipes the pi packages you installed.

## pi's settings.json

Lives at `$HOME/.pi/agent/settings.json` — `/data/home/.pi/agent/settings.json`
in the container. Editable from Settings → Advanced, which validates it as JSON
before writing; a broken file stops every future session from starting.

```json
{
  "defaultProvider": "anthropic",
  "defaultModel": "my-model",
  "defaultThinkingLevel": "high",
  "packages": ["npm:pi-lens"],
  "compaction": { "enabled": true }
}
```

`subagentMode` (`"background"`, or absent for interrupt),
`subagentMaxParallel` (how many at once; absent for 1, at most 16) and
`subagentModel` (`"provider/model"`, or absent for the chat's own) are read by
the bundled subagent tool; Settings → Add-ons → Subagents writes them. See
[Opt-in features](/guide/features).

Extension settings live here too, alongside pi's own. That is why the portal
writes single keys rather than replacing the file: a wholesale overwrite would
take the `packages` list with it.

## Portal settings

Stored in the `settings` table, edited in Settings → Defaults. Saving an empty
value **deletes** the row rather than storing an empty string, which is what
makes "inherit" reachable again after you have set something.

The `GET /api/settings` response separates the three so a client can tell them
apart:

```json
{
  "settings": { "provider": "my-provider", "model": "my-model" },
  "stored":   {},
  "defaults": { "provider": "my-provider", "model": "my-model" }
}
```

`stored` empty and `settings` matching `defaults` means everything is inherited
— nothing is pinned.
