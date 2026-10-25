# Architecture

Express server, React front end, SQLite for state, pi driven through its SDK.

```
browser ──HTTP──▶ express ──▶ session manager ──▶ pi (SDK, in process)
   ▲                              │
   └──────── SSE ─────────────────┴──▶ event log (SQLite)
```

## Fire and forget

The property everything else follows from: **a run belongs to the server, not to
a request**.

`POST /prompt` resolves as soon as pi accepts the message. The browser can close
immediately. Every event pi emits is appended to the `events` table with a
monotonic `seq`, and the SSE endpoint replays from a client's cursor before
tailing. Reconnect after a week and you get everything you missed.

The one exception is extension dialogs, which are strictly live. A persisted
dialog would be replayed to every future reader — reloading the page reopened a
menu whose extension had stopped waiting years in agent-time. They are emitted
with a negative `seq` so they can never be confused with stored history.

## Executors

An executor decides where pi actually runs. Both satisfy the same `PiClient`
interface, so the rest of the portal does not care which is in use.

### host (default)

pi runs **in the portal's process** through its SDK. Fast, and it is what makes
extension slash commands work — `session.prompt()` runs registered commands,
which the RPC transport accepted and then silently dropped.

The trade is isolation: a crash takes the portal with it, and pi has the
portal's own permissions.

### container

pi runs in a throwaway Docker container with only the workspace mounted,
speaking the JSONL RPC protocol over stdio. Capabilities dropped,
`no-new-privileges`, memory and CPU ceilings, labelled so a crashed portal can
still reap it.

Set `EXECUTOR=container` and mount the Docker socket.

## Session lifecycle

A pi process starts lazily — on the first prompt, or when something reads the
session's config. On start:

1. `ModelRuntime.create()`
2. A `DefaultResourceLoader` for extensions, skills and prompt templates. It
   needs **both** `cwd` and `agentDir`; omitting either throws, which once left
   every session with no extensions at all.
3. Resolve the requested model — may miss, see below
4. `SessionManager.open(file, sessionDir, cwd)` if the session has a stored file,
   else `create(cwd, sessionDir)`
5. `bindExtensions()` with a UI context, which is what makes interactive
   commands work
6. **Resolve the model again.** Extensions register their own providers, so a
   `llama-server` model does not exist until step 5 has run. Without the second
   pass, a session asking for a local model silently ran on pi's fallback.

::: tip Why the session file is stored
`SessionManager.create()` starts a *new* conversation every time. Calling it on
each boot meant a restart lost the history and reset context usage to zero.
Storing pi's session file path and reopening it by path is what makes a session
survive a redeploy — `continueRecent()` would also work but guesses, and one
stray file would attach the wrong conversation.
:::

## Data

| Table | Holds |
| --- | --- |
| `sessions` | Title, workspace, status, per-session model and effort, pinned, pi session file, and the channel or routine it belongs to |
| `events` | Append-only log, one row per event, indexed by `(session_id, seq)` |
| `message_versions` | The earlier versions of an edited message, and what followed them |
| `agents` | Each agent's name, home, avatar, voice and heartbeat schedule |
| `activity` | The notes an agent's heartbeat left, and whether they have been read |
| `channels` | Configured channels and their credentials, and the agent each talks as |
| `routines` | Scheduled instructions: schedule or one-off time, where they run and report, the guard switch and their own tool switches |
| `people` | Who the agent has met, and their role |
| `questions`, `grants` | A colleague's requests for approval, and the single-use permissions approving one gives |
| `notes` | What a person told the agent about a conversation, until it is delivered |
| `tool_rules` | The standing permissions of [Allowed anyway](/people/rules) |
| `audit` | The guard's decisions, trimmed to the latest 2,000 |
| `settings` | Portal-wide overrides, and the small things the portal remembers (the tools it has seen, the model's context windows) |
| `project_tools` | A project's tool switches |
| `open_subagents` | The subagents still running in a session |
| `signed_out` | Logins that were ended early, until they would have expired anyway |

Changes to the schema are made in place — `ALTER TABLE` rather than recreating
anything — so upgrades keep existing sessions and their history. They are made
safely: when a start finds an older schema, the portal checks the database,
copies it to `backups/` in the data directory, and upgrades it in one
transaction, showing an Upgrading page meanwhile. See
[Upgrading](/guide/upgrading).

## Beside the run

Not everything goes through pi. An extension's server half registers its tools
in the portal's process, not as an MCP server: [Media](/guide/media)'s picture
tools (`generate_image`, `edit_image`, `show_image`) and video tools
(`generate_video`, `show_video`), and the [Browser](/guide/browser) extension's
tools, which drive a Chromium over its debugging port.
Files, Git and the terminal are extensions too, whose server halves work in the
session's folder through what the portal gives every extension
([Building an extension](/guide/extension-ui)): `portal.files`
(`core/server/src/workspace-files.ts`) and `portal.git` (`git.ts`); the
terminal runs a pty for each terminal itself. The containers of Browser, of the voice service (Voice) and of
Understory, the agent's memory, are run through the
[Docker](/guide/docker) extension, which every extension that runs containers builds on; the voice and Understory containers share the
portal's network namespace so their services need no published ports. An extension's container that runs code from
elsewhere is on a network of its own instead (Docker's `networks`). The extensions the
portal ships (`extensions/`, the subagent tool among them) are installed as local pi
packages from that folder; the ones a fresh portal starts with are in `extensions/defaults.json`. The server holds one socket in its data
directory so only one portal runs on it.

Two things run on a clock of their own. The routine supervisor
(`core/server/src/routines/`) starts a run of a routine when its schedule says so,
and the heartbeat (`heartbeat.ts`) lets an agent look around in a session of its
own, as the read-only role `heartbeat`, when it is its turn: a look never starts
while a chat or a routine is working.

## Front end

React with react-router. Every meaningful view has a URL — a session, the
sessions list, the agents page, each settings tab — so deep links and the back
button work, with an SPA fallback on the server. The first draw needs only the
shell, the chat and the sign-in page: the other pages, Settings, the setup
assistant, the terminal emulator and the text of the language in use are
fetched when first needed (`lazyComponent` in `core/web/src/lazy.ts`).

State is polled every five seconds and pushed over SSE for the open session.
Text is translated in the browser: every English string goes through `t()`, and a
language is one file in `core/web/src/locales/`. See [Settings → Language](/guide/settings#language).

## Channel loading

Channel packages are discovered from two roots: the repo's `channels/` directory
for builtins, and `CHANNELS_DIR/node_modules` for installed ones. A package is
considered if `package.json` carries the `pithagoras.channel` marker or its package name starts with `pithagoras-channel-`.

Each module is imported with a cache-busting query so a reinstall is picked up
without a restart, its manifest is validated, and duplicate channel ids are
rejected. A package that throws is collected into a `broken` list with its error
rather than being skipped.

Installation shells out to `npm install` in `CHANNELS_DIR`, which is why every
spec form npm understands works without the portal parsing any of them.
