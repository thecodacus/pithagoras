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
| `sessions` | Title, workspace, status, per-session model and effort, pinned, pi session file |
| `events` | Append-only log, one row per event, indexed by `(session_id, seq)` |
| `channels` | Configured channels and their credentials |
| `settings` | Portal-wide overrides |

Migrations run in place with `ALTER TABLE` rather than recreating anything, so
upgrades keep existing sessions and their history.

## Front end

React with react-router. Every meaningful view has a URL — a session, the
sessions list, the agents page, each settings tab — so deep links and the back
button work, with an SPA fallback on the server.

State is polled every five seconds and pushed over SSE for the open session.

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
