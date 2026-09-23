# HTTP API

Everything the web UI does goes through this API, so anything the UI can do you
can script.

All routes are under `/api`. When password authentication is enabled, everything except `/api/auth/*` requires the login cookie.

```bash
curl -s -c jar -X POST localhost:4100/api/auth/login \
  -H 'content-type: application/json' \
  -d '{"password":"…"}'

curl -s -b jar localhost:4100/api/sessions
```

## Auth

| | |
| --- | --- |
| `GET /api/auth/status` | `{ authRequired, authed }` |
| `POST /api/auth/login` | `{ password }` → sets the cookie |

## Workspaces

| | |
| --- | --- |
| `GET /api/workspaces` | `{ root, workspaces: [{ name, path, isGit }] }` |
| `POST /api/workspaces` | `{ name }` → creates a directory; the name is slugified |

## Sessions

| | |
| --- | --- |
| `GET /api/sessions` | `{ sessions, executor }` — pinned first, then most recent. Task sessions only. |
| `GET /api/agent/sessions` | `{ sessions, agentHome }` — conversations reached through a channel, each with the channel that owns it |
| `POST /api/sessions` | `{ workspace, title? }` |
| `GET /api/sessions/:id` | One session |
| `PATCH /api/sessions/:id` | `{ title?, pinned? }` |
| `DELETE /api/sessions/:id` | Stops it if running, then deletes it and its events |

A session:

```json
{
  "id": "12_A1zVAa2rk",
  "title": "test-project",
  "workspace": "/workspaces/test-project",
  "executor": "host",
  "status": "idle",
  "pinned": false,
  "live": true,
  "created_at": "…",
  "updated_at": "…",
  "last_error": null
}
```

`status` is one of `idle`, `running`, `error`, `interrupted`. `live` is whether
a pi process is up right now, which is not the same thing — an idle session can
still be live.

## Prompting

| | |
| --- | --- |
| `POST /api/sessions/:id/prompt` | `{ message }` |
| `POST /api/sessions/:id/abort` | Stop the current run |
| `POST /api/sessions/:id/ui-response` | `{ id, value?, cancelled? }` — answer an extension dialog |

`prompt` returns as soon as pi accepts the message, **not** when the work
finishes. Watch the event stream for progress.

A message matching a portal builtin is handled without reaching the model — see
[Slash commands](/guide/commands).

## Events

```
GET /api/sessions/:id/events?since=<seq>
```

Server-sent events. A nonzero `since` replays stored events after that cursor, in batches, then tails live. A cold load (`since=0`) starts with up to the latest 1,200 stored events. Use `GET /api/sessions/:id/events/before?before=<seq>&limit=1200` for earlier pages (maximum 3,000 per page).

Each data message is one event:

```json
{ "seq": 78, "type": "portal_notice", "payload": { "text": "…" } }
```

Track the highest `seq` you have seen and pass it as `since` when reconnecting.

::: warning Negative seq
Live-only events — streaming message/tool updates, queue updates, prefill progress and extension dialogs — carry a negative `seq`. They are never
persisted, so they must not move your cursor. Ignore anything `<= 0` when
tracking position, or reconnecting will skip real history.
:::

Types worth knowing: `portal_prompt`, `portal_status`, `portal_notice`,
`agent_end`, `extension_ui_request`, `extension_ui_cancel`, `extension_error`,
`stderr`, `queue_update`, `portal_prefill`, `message_update`, `message_end`, `tool_execution_update`, and `tool_execution_end`, plus other pi lifecycle events.

Completed assistant messages and tool results are saved; their streaming updates stay in memory. On connection, the named `live-reset` event tells a client to discard stale in-memory updates before replay. A `message_snapshot` restores the current assistant message; tool updates restore current tool output. The named `caught-up` event carries the last durable sequence. Render completed `message_end.message` content even when no deltas were replayed.

## Session config

| | |
| --- | --- |
| `GET /api/sessions/:id/config` | `{ state, thinking, models, stats }` |
| `POST /api/sessions/:id/config` | `{ provider?, modelId?, thinkingLevel?, autoCompaction?, autoRetry? }` |
| `POST /api/sessions/:id/compact` | Compact now |
| `GET /api/sessions/:id/commands` | The slash command palette |

`GET /config` does not start pi. For a stopped session it returns stored/inherited model settings with `live: false`, `stats: null`, and empty model/thinking lists. For an already-live session it returns current state and statistics.

`GET /api/sessions/:id/models` starts pi when necessary and returns the live model list and state.

`POST` returns `{ ok, applied, state }`, where `applied` lists what actually
changed. Only those fields are persisted — an effort change does not rewrite the
model.

`compact` fails with a message when the session is too short for pi to bother.

## Portal settings

| | |
| --- | --- |
| `GET /api/settings` | `{ settings, stored, defaults, piSettingsPath, executor, workspaceRoot }` |
| `PUT /api/settings` | `{ provider?, model?, thinkingLevel? }` |

`settings` is what pi is launched with; `stored` is only your explicit
overrides; `defaults` is what an unset field falls back to. An empty string in
`PUT` clears an override rather than storing a blank.

## pi extensions

| | |
| --- | --- |
| `GET /api/packages` | Raw `pi list` output |
| `POST /api/packages` | `{ spec }` |
| `DELETE /api/packages` | `{ spec }` |
| `POST /api/packages/update` | Update everything |
| `GET /api/extensions` | Parsed packages with their recovered settings |
| `PUT /api/extensions/settings` | `{ key, value }` — empty value removes the key |
| `GET /api/pi-settings` | Raw `settings.json` |
| `PUT /api/pi-settings` | `{ content }` — refused unless it parses as JSON |

## Channels

| | |
| --- | --- |
| `GET /api/channels` | `{ channels, kinds, broken, agentHome, channelsDir }` |
| `POST /api/channels` | `{ kind, name, config }` |
| `PATCH /api/channels/:id` | `{ name?, slug?, enabled?, config?, instructions? }` |
| `DELETE /api/channels/:id` | Keeps its conversations; `?sessions=delete` discards them too |
| `POST /api/channel-packages` | `{ spec }` — install a channel package |
| `DELETE /api/channel-packages/:name` | Uninstall; refuses builtins |

A channel's `slug` is what agent sessions are keyed on, and it survives the
channel being deleted and recreated. Creating a channel with an explicit `slug`
reconnects it to the conversations that slug already had.

Secrets are never returned. A channel carries `secretsSet` listing which secret
fields have a value, and sending a blank secret keeps the stored one.

`broken` lists packages that failed to load, with the reason.

## Agent setup

| Route | Purpose |
| --- | --- |
| `GET /api/agent/setup` | Read setup status and editable agent files. |
| `POST /api/agent/setup` | Initialize agent identity files. |
| `PUT /api/agent/files/:name` | Save an editable identity/context file. |
| `POST /api/agent/sessions` | Create an agent conversation. |

## People and audit

| Route | Purpose |
| --- | --- |
| `GET /api/people` | List known people and roles. |
| `PATCH /api/people/:key` | Update name, role or notes. |
| `DELETE /api/people/:key` | Forget a person. |
| `GET /api/audit?limit=2000` | Read up to all 2,000 retained decisions (default 200), newest first. |
| `GET /api/tool-rules` | List standing tool permissions. |
| `POST /api/tool-rules` | Add a role/tool/pattern rule. |
| `DELETE /api/tool-rules/:id` | Remove a rule. |

## MCP servers

| Route | Purpose |
| --- | --- |
| `GET /api/mcp` | Read configured servers and settings. |
| `PUT /api/mcp/servers/:name` | Add or update a server. |
| `DELETE /api/mcp/servers/:name` | Remove a server. |
| `PUT /api/mcp/settings` | Update MCP settings. |
| `POST /api/mcp/import` | Import server configuration. |
| `PUT /api/mcp/raw` | Save the raw configuration after JSON validation. |

## Skills

| Route | Purpose |
| --- | --- |
| `GET /api/skills` | List skills, diagnostics and editable content. |
| `POST /api/skills` | Create a skill with name, description and body. |
| `PUT /api/skills/:name` | Save a skill's content. |
| `DELETE /api/skills/:name` | Delete an editable skill. |
| `POST /api/skills/:name/enabled` | Enable or disable a skill. |
| `POST /api/skills/preview-import` | Preview a repository import. |
| `POST /api/skills/import` | Import selected skills. |
| `POST /api/skills/:name/update` | Refresh an imported skill. |

## Routines

| Route | Purpose |
| --- | --- |
| `GET /api/routines` | List routines and defaults. |
| `POST /api/routines` | Create a recurring or one-off routine. |
| `PATCH /api/routines/:id` | Update a routine. |
| `DELETE /api/routines/:id` | Delete a routine. |
| `POST /api/routines/:id/run` | Start a run now. |
| `POST /api/routines/preview` | Preview schedule timing. |
| `GET /api/routines/:id/sessions` | List the routine's runs. |
| `GET /api/routines/report-targets` | List available report destinations. |
| `PUT /api/routines/report-default` | Set the default report destination. |

Recurring routines resume at their next future slot after a restart. Overdue one-off routines catch up.
