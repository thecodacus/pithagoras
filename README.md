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

## Quick start

```bash
cp .env.example .env      # set PORTAL_PASSWORD and your provider key
docker compose up -d --build
```

Then open `http://<host>:4100`.

The container uses host networking, so pi and its extensions reach services on
the box at `127.0.0.1` — a llama.cpp server on `:8080`, for example — exactly as
they would outside a container.

## How it works

```
Browser ──SSE (replay + tail)──▶ portal ──JSONL over stdio──▶ pi --mode rpc
                                    │
                                    └─▶ SQLite: sessions + full event log
```

The browser never drives the agent. Submitting a prompt returns as soon as pi *accepts* it;
the run continues server-side. The client reconnects with the last event id it saw
(`?since=`), so nothing is lost and nothing is duplicated.

## Execution modes

| `EXECUTOR` | What it does |
|---|---|
| `host` (default) | pi runs inside the portal container, working directly on the repos mounted at `/projects`. Fast, real git, full access to those directories. |
| `container` | Each task gets its own container with only its project mounted, dropped capabilities, `no-new-privileges`, and memory/CPU/PID caps. Needs the Docker socket mount. |

pi has **no approval prompts** — by design it runs with the permissions of its process
("real isolation needs to come from the OS or a container boundary"). That is what makes
unattended runs possible, and also why `PORTAL_PASSWORD` is required and why the portal
should stay on Tailscale/LAN rather than the public internet.

## Config panel

The **Config** button in a task opens the web equivalent of pi's TUI slash commands, in three tabs:

- **Session** — model (searchable across the whole provider catalogue), thinking level, live
  context usage / tokens / cost, auto-compaction toggle, and compact-now. Read from the running
  pi process, so it reflects what that session is actually using.
- **Global** — provider, default model and default thinking level applied to every **newly
  started** session. Stored in the portal database, so they outlive restarts and override the
  env defaults. Running sessions keep their own settings.
- **Packages** — install, remove and update pi packages (extensions, skills, prompts, themes)
  from npm, git, a URL or a path. They install under a persistent home directory, so they
  survive container rebuilds.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PORTAL_PASSWORD` | — | **Required.** Shared password for the UI. |
| `PORTAL_SECRET` | random | HMAC key for the auth cookie. Set it so logins survive restarts. |
| `WORKSPACES_DIR` | `/root/repos` | Host directory holding the workspaces pi may work in. |
| `EXECUTOR` | `host` | `host` or `container`. |
| `PI_PROVIDER` / `PI_MODEL` | `openrouter` / `anthropic/claude-sonnet-5` | Passed through to pi. |
| `OPENROUTER_API_KEY` etc. | — | Provider credentials, forwarded to pi. |
| `TASK_MEMORY_MB` / `TASK_CPUS` / `TASK_PIDS_LIMIT` | `2048` / `2` / `512` | Per-task caps in `container` mode. |

## Sessions and workspaces

A **workspace** is a folder pi works in; a **session** is a conversation against one.
Creating a session defaults to making a fresh workspace — name it however you like and the
folder is slugified (`"Cool Project"` becomes `cool-project`), with the session taking that
same name. Pick an existing workspace from the dropdown to continue in one you already have.

Each session has its own pi conversation, workspace, and status. The sidebar shows
them all with a live status dot: running, idle, error, or **interrupted** — meaning the
server restarted while that task was mid-run. Sessions are marked interrupted rather than
left spinning forever; sending another message resumes the conversation.

## Limitations

- A session does not survive a **portal restart**, only a browser disconnect. pi persists its
  own session files, so the conversation is intact and can be continued, but the in-flight
  run stops.
- Two sessions pointed at the same workspace in `host` mode will edit the same working tree.
  Use `container` mode or separate workspaces if you want to run those in parallel.

## Documentation

Full docs live in `docs/` and are a VitePress site.

```bash
npm run docs         # dev server
npm run docs:build   # static build into docs/.vitepress/dist
```
