<p align="center">
  <img src="assets/hero.png" alt="Pithagoras" width="620">
</p>

<p align="center">
  A web front end for the <a href="https://github.com/earendil-works/pi">pi coding agent</a>, built to be
  left alone.<br>
  <strong>Give it a task, close the browser, come back later and read what it did.</strong>
</p>

<p align="center">
  <a href="https://thecodacus.github.io/pithagoras/">Documentation</a> ·
  <a href="https://thecodacus.github.io/pithagoras/guide/deploying">Deploying</a> ·
  <a href="https://thecodacus.github.io/pithagoras/channels/writing-a-channel">Write a channel</a>
</p>

---

Runs are owned by the server, not by your tab. Every event pi emits is appended to a log, so
reconnecting replays exactly what you missed and then continues live.

A fresh agent session starts at **roughly 3.8k tokens** of system context — the agent's
identity and memory, its tool schemas, and a one-line listing of every installed skill. Skill
bodies are read when the agent reaches for one, not loaded up front. Measured rather than
budgeted, and it grows with what you install: each MCP server registered as direct tools
adds 150–300 tokens per tool.

## Quick start

```bash
git clone https://github.com/thecodacus/pithagoras.git && cd pithagoras
cp .env.example .env      # uncomment WORKSPACES_DIR with the folder your repos are in
docker compose up -d --build
```

Then open `http://<host>:4100` and choose a password: the portal has none until you do, so do it as soon as it is up. The setup assistant in **Settings → Providers**
walks you through adding a model provider (a local llama.cpp / Ollama server, OpenRouter,
Anthropic, …); you can also set a key in `.env`.

The container uses host networking, so pi and its extensions reach services on the box at
`127.0.0.1` — a llama.cpp server on `:8080`, for example — exactly as they would outside a
container. It needs the Docker socket mount for the Docker extension, which runs the containers
of the agent's browser, the voice service and Understory.
Running from source, the Portainer stack and the full variable list are in
[Deploying](https://thecodacus.github.io/pithagoras/guide/deploying).

Browsers install the portal as an app (PWA) only over HTTPS or on `localhost`.

## What is in it

- **Chats that outlive the tab** — runs belong to the server; reconnecting replays the log.
  Edit or delete a message, steer a running chat, switch tools off per chat.
- **Home and projects** — chats work in the agent's Home or in a project folder with its own
  `AGENTS.md`; the sidebar lists them by folder.
- **Panels beside the chat** — Files (browse, edit, follow the agent), Git (changes, history,
  branches, pull requests through `gh`), a terminal, canvases, subagents and background jobs,
  each dockable on its own side.
- **Models and extensions** — set up providers from Settings, per-model context windows, pi
  packages from a catalogue, MCP servers, skills, and a switch to turn a package off without
  removing it.
- **Voice mode** — local speech-to-text and text-to-speech, from the voice service (the Voice
  extension, with Docker) or speech servers of your own (the Voice servers extension), pictures
  both ways, push-to-talk.
- **Opt-in features** — the agent's own browser (the Browser extension, with Docker, both installed from
  Settings → Extensions), a subagent tool (the Subagents extension, switched on in Settings → Extensions), Understory
  memory with a Memory page (the Understory extension, with Docker, installed from Settings →
  Extensions), and, from the Media extension the portal installs, image generation
  and editing through an endpoint you choose and video generation through a stable-diffusion.cpp
  server, with one Media page to make pictures and short videos without a chat (from a description,
  or from a picture), a gallery of both, and a player for the videos.
- **Channels and people** — reach the agent from Telegram, Slack, Discord, Signal or a webhook, with
  roles, approvals and an audit log.
- **Routines** — scheduled runs that report to a channel.
- **Portal** — installable app, light/dark theme, English and German.

## How it works

```
Browser ──SSE (replay + tail)──▶ portal ──▶ pi (SDK, in process — or in a container)
                                    │
                                    └─▶ SQLite: sessions + full event log
```

The browser never drives the agent. Submitting a prompt returns as soon as pi *accepts* it;
the run continues server-side. The client reconnects with the last event id it saw
(`?since=`), so nothing is lost and nothing is duplicated.

## Execution modes

| `EXECUTOR` | What it does |
|---|---|
| `host` (default) | pi runs inside the portal process, working directly on the repos mounted at `/workspaces`. Fast, real git, full access to those directories. |
| `container` | Each task gets its own container (`PI_IMAGE`, default `pithagoras-runner:latest`) with only its project mounted, dropped capabilities, `no-new-privileges`, and memory/CPU/PID caps. Needs the Docker socket mount. |

pi has **no approval prompts** — by design it runs with the permissions of its process
("real isolation needs to come from the OS or a container boundary"). That is what makes
unattended runs possible, and also why a password is required and why the portal should stay
on Tailscale/LAN rather than the public internet.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PORTAL_ALLOW_NO_PASSWORD` | — | `1` runs with no login behind an authenticating proxy. The password itself is chosen in the browser on the first start and changed under Settings → Authentication; there is no variable for it. |
| `PORTAL_SECRET` | random | HMAC key for the auth cookie. Set it so logins survive restarts. |
| `WORKSPACES_DIR` | — (required) | Host directory mounted at `/workspaces` (Compose only; it will not start without one). |
| `PORTAL_DATA_DIR` | named volume | Host directory for the data volume, instead of a Docker volume (Compose only). |
| `TZ` | UTC | Time zone of the portal's clock, such as `Europe/Berlin`: an agent's quiet hours and repeating routines are read on it. |
| `EXECUTOR` | `host` | `host` or `container`. |
| `PI_PROVIDER` / `PI_MODEL` / `PI_THINKING_LEVEL` | inherit | Overrides only; pi's `settings.json` decides when unset. |
| `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY` | — | Provider credentials, forwarded to pi. |
| `TASK_MEMORY_MB` / `TASK_CPUS` / `TASK_PIDS_LIMIT` | `2048` / `2` / `512` | Per-task caps in `container` mode. |

The rest is in [Configuration](https://thecodacus.github.io/pithagoras/reference/configuration).

## Settings

**Settings** (bottom of the sidebar) is the web equivalent of pi's slash commands:
**Providers** and **Defaults** for models, **Tools**, **Skills**, **MCP** and
**Extensions** for the agent, **Channels** and **People**, and **This browser**, **Shortcuts**,
**About** and **Advanced** for the portal, with a page for each extension that has settings, such as
**Media**. What a chat uses lives on the pills under its
composer. Defaults you set apply to **newly started** sessions only.

## Sessions and workspaces

A **session** is a conversation, and it works in a folder. **New** starts one in **Home**, the
own directory of the first agent (or of the one you picked for New), where its SOUL.md, PrimaryUser.md and MEMORY.md are. A **project** is an
extra folder you make on purpose, on the Projects tab: `"Cool Project"` becomes `cool-project`,
with instructions of its own saved as its `AGENTS.md`. Opening a project opens its chat, and
`/new` or `/clear` starts a fresh one in it. Deleting a session never deletes a folder.

The sidebar shows every session with a live status dot: running, idle, error, or
**interrupted** — the server restarted while that task was mid-run. Sending another message
resumes the conversation.

## Limitations

- A run does not survive a **portal restart**, only a browser disconnect. pi persists its own
  session files, so the conversation is intact and can be continued, but the in-flight run stops.
- Two sessions pointed at the same workspace in `host` mode edit the same working tree. Use
  `container` mode or separate workspaces to run those in parallel.
- One portal per data directory: a second one on the same data refuses to start.

## Documentation

Full docs live in `docs/` and are a VitePress site.

```bash
npm run docs         # dev server
npm run docs:build   # static build into docs/.vitepress/dist
```

## License

Pithagoras is licensed under the [Apache License 2.0](LICENSE) (see also [NOTICE](NOTICE)). The voice
mode ships a voice activity model and a WebAssembly runtime from other projects, under their own
licences: see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
