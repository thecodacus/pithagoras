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
| `GET /api/auth/status` | `{ authRequired, authed, oidc?, shortPassword? }`. `oidc: { name, only }` is there when single sign-on is set up and usable (the login page's button, and whether it is the only way in). `shortPassword: true` is sent only to a signed-in caller, and only when the portal runs on a password shorter than 8 characters that it kept from before the minimum |
| `POST /api/auth/login` | `{ password }` → sets the cookie; 403 when OIDC only has switched the password login off |
| `POST /api/auth/logout` | clears the cookie, and refuses the login it held from then on. `{ ok, endSession? }`: `endSession` is the provider's sign-out address, when the settings ask for it |
| `GET /api/auth/sso` | The single sign-on settings: `{ mode, callbackPath, settings, only }`. `settings` is `null` when it is not set up, otherwise the issuer, client ID, redirect URL, scopes, button name and `endSession`, and `hasSecret` instead of the client secret, which is never sent back |
| `PUT /api/auth/sso` | `{ current, settings, only? }` → saves them, or takes single sign-on out with `settings: null`. `current` is the current password (403 if wrong); 409 without a password set. The provider's discovery document and keys are read before anything is kept, so settings it does not answer to are 400 with the reason. `only` is the same flag that `GET` returns beside `settings`; left out, it stays as it is. A change of issuer, client ID or `only` ends every other login, and the caller is signed in again |
| `GET /api/auth/oidc/start` | Browser route, not JSON: sets the state cookie and redirects (303) to the provider. `?returnTo=` is a path on the portal. 404 when single sign-on is not set up, 502 when the provider cannot be reached |
| `GET /api/auth/oidc/callback` | Browser route: the provider's redirect back. Checks the state, `iss`, the code and the ID token, then sets the login cookie and redirects to `returnTo`; a refusal is a short HTML page. This path is the redirect URI to register at the provider |

## Workspaces

| | |
| --- | --- |
| `GET /api/workspaces` | `{ root, workspaces: [{ name, path, isGit }] }` |

## Projects

The folders made on purpose for chats to work in: every folder directly under the
workspace root. Home, where chats start, is the agent's directory and not one of
them. See [Projects](/guide/projects).

| | |
| --- | --- |
| `GET /api/projects` | `{ root, projects: [{ name, path, isGit, hasInstructions, hasTools, sessions, lastActive }] }`; `hasTools` is whether the project switches tools differently from the portal-wide default |
| `POST /api/projects` | `{ name, instructions?, toolsOff? }` → creates the folder (slugified) and writes `AGENTS.md` if there are instructions; 409 if it exists, 400 for `home`. `toolsOff` is the tools its chats start with off, as for `PUT /api/projects/:name/tools`, checked before the folder is made. If the folder is made and the tools cannot be stored, the answer is the project with a `toolsError` |
| `GET /api/projects/:name` | The project plus `{ files, bytes, complete }` — what deleting it would remove |
| `GET /api/projects/:name/instructions` | `{ text, mtime }` — `mtime` is when `AGENTS.md` last changed, 0 where there is none |
| `PUT /api/projects/:name/instructions` | `{ text, mtime? }` → writes `AGENTS.md` whole; blank removes it. With `mtime`, a file that has changed since is not overwritten: 409. |
| `GET /api/projects/:name/tools` | `{ tools, live, off, names }`, shaped like a conversation's list: every tool the portal has seen and whether it is on for chats in this project, with `defaultOn` the portal-wide default. `live` is always false |
| `PUT /api/projects/:name/tools` | `{ off: string[] }` — the tools chats in this project start with; what is not named is on. Stored as the difference from the portal-wide default, and told to the running chats in the project. Answers `{ off, applied }` |
| `DELETE /api/projects/:name` | Deletes its chats (with their conversation files) and its folder; 409 while one is running. The jobs running in its folder are stopped (`jobsStopped`) |

## Sessions

| | |
| --- | --- |
| `GET /api/sessions` | `{ sessions, executor, extensions }` — pinned first, then most recent. The chats, and the conversations started on an agent's page; not those that came through a channel, nor routine runs. A [child chat](/guide/extension-ui#child-chats) a server half made has `parent`, its parent's id, and `listed: true`; one made unlisted is not in the list, and is found by its id alone. `extensions` is a revision of what is installed: of the packages pi's settings list and what is switched on of each, of the browser halves, server halves and themes the portal loads, and of where each server half stands. It changes when installing, removing, updating or switching a package changes any of that, and when a server half crashes, and a page that sees it differ from the `revision` of the list it last went through goes through `GET /api/extension-ui` again ([What is loaded, and when](/guide/extension-ui#what-is-loaded-and-when)) |
| `GET /api/agent/sessions` | `{ sessions, agentHome }` — one agent's conversations (`?agent=`, the first agent without it): every chat in its home, each with the channel that owns it or `null` for a chat started in the portal |
| `POST /api/sessions` | `{ workspace?, agent?, title? }` — `agent` starts it in that agent's home; neither means the agent picked for new chats, the first agent (Home) by default; no title means "New chat", replaced by the first message |
| `GET /api/sessions/:id` | One session; a child chat with `parent` and `listed` |
| `PATCH /api/sessions/:id` | `{ title?, pinned? }` — a title is cut to 120 characters |
| `GET /api/sessions/:id/modes` | `{ modes: [{ id, label, description, confirm?, extension? }] }` — the [modes](/guide/sessions#modes) the chat may be put in, the portal's own first, then [the ones you made](#chat-modes) by their names, and the extensions' last ([Chat modes](/guide/extension-ui#chat-modes)), whether or not it has started. An extension's `id` is `"<package>/<id>"`, which is what a chat in it stores, and it has `extension`, its package, and `confirm`, the warning it asks first with, where it has one; its texts are in English. None for a routine's run, a heartbeat, a chat that came through a channel, a colleague's chat, or any chat with `EXECUTOR=container`. Does not start pi |
| `PUT /api/sessions/:id/modes` | `{ mode, confirmed? }` — puts a chat that has said nothing yet in a mode, by its `id`; a pi that was started for it is let go, and the next message starts it in the mode. Answers `{ mode }`. A mode with `confirm` takes `confirmed: true`, sent once the person has said yes to its warning, and is then recorded in the audit log (`mode`); without it, 409 `{ error, confirm }`. `confirmed` is the caller's word, no proof that the warning was shown. 409 where the chat is offered no modes, once it has sent a message or a command, or while it is running; 409 `This conversation is already being edited.` while an edit or a reload holds it; 400 for a mode it is not offered |
| `DELETE /api/sessions/:id` | Stops it if running, then deletes it, its events and pi's conversation file for it (in `SESSION_DIR`), and its child chats with theirs. The folder it worked in is left alone. |

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
  "last_error": null,
  "mode": null
}
```

`status` is one of `idle`, `running`, `error`, `interrupted`. `live` is whether
a pi process is up right now, which is not the same thing — an idle session can
still be live. `mode` is the [mode](/guide/sessions#modes) the chat was started
in: `null` for Standard, the portal's own by its name (`"code"`), one you made
as `"custom/<id>"` (see [Chat modes](#chat-modes)), an extension's as
`"<package>/<id>"`.

## Chat modes

The [modes you make](/guide/sessions#modes-you-make), in Settings → Modes. A chat
in one stores `custom/<id>`, and `GET /api/sessions/:id/modes` offers them after
the portal's own and before the extensions', by their names. With `EXECUTOR=container` each of these
answers 400 with `code: "tools-unsupported"`, as the tool routes do.

| | |
| --- | --- |
| `GET /api/chat-modes` | `{ modes }`, by their names |
| `POST /api/chat-modes` | `{ label, description? }` → the mode. Its `id` is a slug of the label that no mode has and no chat stores, numbered where it has to be (`research-2`); a new label later does not change it. 400 for a name that is empty, of more than one line, or longer than 60 characters |
| `PUT /api/chat-modes/:id` | `{ label?, description?, instructions?, codemode?, provider?, model?, thinkingLevel? }` → the mode; what is not named stays. `codemode: true` switches the code tool on in the mode's tools too, and `false` takes that back. The running chats in the mode are told its tools and its instructions at once; whether they work through the code tool, when each one's pi next starts. 404 for an unknown mode, 400 for a field it cannot take |
| `DELETE /api/chat-modes/:id` | `{ ok: true }`. The chats in it keep `custom/<id>`, and lose its tools and instructions at once; it is offered to no chat |
| `GET /api/chat-modes/:id/tools` | `{ tools, live, off, names }`, shaped as a project's: what every chat in the mode starts with, `defaultOn` the portal-wide default it is held against. `live` is always false |
| `PUT /api/chat-modes/:id/tools` | `{ off: string[] }` — what is not named is on. Stored as the difference from the portal-wide default, and told to the running chats in the mode. Answers `{ off, applied }` |

A mode:

```json
{
  "id": "research",
  "label": "Research",
  "description": "Reads everything before it writes",
  "codemode": false,
  "instructions": "Cite the file and line of everything you claim.",
  "provider": null,
  "model": null,
  "thinkingLevel": "high",
  "createdAt": "…",
  "updatedAt": "…"
}
```

`label` and `description` are one line each, the description at most 200
characters; `instructions` at most 8,000, said in the system prompt of its
chats. `provider`, `model` and `thinkingLevel` are text or `null`, a blank is
`null`: where a model is set, the mode writes it, with its provider, into a chat
as the chat is put in it (`PUT /api/sessions/:id/modes`), and its
`thinkingLevel` likewise. Another mode chosen before the chat's first message
puts back what the mode wrote, unless the chat's own was changed since.

## Files

What the portal itself serves of the folder a session works in, whether that
is a project, the workspace root or Home: a picture or a clip to draw in the
page, and a file put there from the message box. Every path is relative to that
folder; one that leads out of it, by `..` or by a link, is refused with 400.
Browsing and changing the folder is the [Files](/guide/files#its-routes)
extension's, at `/api/x/pithagoras-files/…`, and an extension's server half does
it with [`portal.files`](/guide/extension-ui#a-chat-s-folder). Every refusal of
these routes answers `{ error, code }`.

| | |
| --- | --- |
| `GET /api/sessions/:id/picture?path=` | A PNG, JPEG, GIF or WebP in the folder, to be drawn in the page, with the type its first bytes say it is and a `sandbox` content security policy. 400 for anything that is not one of those four, whatever its name; 413 over 25 MB. Files and canvases use it, and the chat draws the pictures that tool calls give with it |
| `GET /api/sessions/:id/video?path=` | A WebM or an MP4 in the folder, to be played in the page, with the type its first bytes say it is and a `sandbox` content security policy, in the parts a player asks for: `Range` is answered `206` with `Content-Range` (a single range of bytes; several, or another unit, get the whole file, and one past the end `416`), `Accept-Ranges: bytes`, `ETag`/`304`, and `If-Range` is honoured. 400 for anything that is not a WebM or an MP4, whatever its name; 413 over 100 MB. The chat's player uses it for the clips that tool calls give |
| `GET /api/sessions/:id/file?path=` | Any plain file in the folder, to be saved and never shown: `application/octet-stream`, `Content-Disposition: attachment`, a `sandbox` content security policy, and ranges as for a clip. 400 for a folder or a link out of the folder, 404 for one that is not there. The chat links to it for a file a call gave that is neither a picture nor a clip |
| `POST /api/sessions/:id/upload?path=&name=` | The file as the request body, sent as `application/octet-stream` → put in the folder at `path` as `name`, or `name (2)` and so on if that is taken; answers `{ path, size }`. Streamed to disk and put in place only once complete. 413 over 2 GB |

## Prompting

| | |
| --- | --- |
| `POST /api/sessions/:id/prompt` | `{ message, images?, voice?, steer? }` — `images` is up to eight `{ data }`, each base64 or a `data:` URL of a PNG, JPEG, GIF or WebP under 5 MB. The type is read from the bytes. `message` may be empty when there are pictures. Sent while a run is going, a message waits for the run to end; with `steer: true` it goes into that run instead, after the tools running now |
| `GET /api/sessions/:id/images/:name` | A picture sent with a message; `portal_prompt` events name them in `payload.images` |
| `POST /api/sessions/:id/abort` | Stop the current run |
| `POST /api/sessions/:id/ui-response` | `{ id, value?, cancelled? }` — answer an extension dialog. For a `confirm`, Yes is `value: true`; the guard's question about a [held call](/guide/security#asked-or-refused) takes anything else as No. For the agent's `ask_question` the value is an object of answers by question id; its questions are stored as the chat's `portal_question` events, and how each ended (`answered` with its `answers`, `cancelled`, `expired`, `stopped`) as a `portal_question_end`, so a stream sends the ones still open again ahead of `caught-up`. A dialog has no time limit unless the extension names one, and a page that opens the chat while one waits is sent it again, ahead of `caught-up`. A routine run, a heartbeat look and a chat reached through a channel raise none: the extension is answered at once with no answer |
| `GET /api/tools` | `{ tools, off, names, lazy, questionWaitMinutes }` — every tool the portal has seen, which are off by default, how long the agent's questions wait (see `PUT /api/ask-question`), and what is marked [lazy](/guide/extensions#lazy-tools): tool sets and single tools (`<tool>name`). A lazy tool carries `lazy: true`: it is on like any other but is reached through the `tools` tool instead of being offered one by one. An MCP server's tool carries `lazy: true` when its server leaves it to the adapter's `mcp` tool (no `directTools`; that is the default), and `mcp`: the server, whose setting says so (see `PUT /api/mcp/servers/:name/direct`). A tool that cannot be lazy, one of pi's own or the adapter's `mcp`, carries `noLazy: true`. Nothing else is lazy until marked. With `EXECUTOR=container` this and the other tool routes answer 400 with `code: "tools-unsupported"` |
| `PUT /api/ask-question` | `{ waitMinutes }` — how long a question from the agent's `ask_question` waits for an answer: `0` (until it is answered, the default), `5`, `15`, `30` or `60`; anything else is a 400. The tool is offered wherever a person answers in the web UI (a chat, a conversation on the Agent page), not in a routine, a heartbeat or a chat reached through a channel. Read when a question is asked, so it applies to the next one |
| `PUT /api/tools` | `{ off: string[] }` — the default for every conversation; applied to the running ones too. A [project](#projects) can bend it with `PUT /api/projects/:name/tools`, and a conversation then holds its exceptions against that |
| `PUT /api/tools/lazy` | `{ lazy: string[] }` — the lazy marks: tool sets, named as the tools list names its boxes (a package, such as `pithagoras-media` for Media's picture and video tools, or `pithagoras-browser` for the browser's), and single tools as `<tool>name`. Answers `{ lazy, applied }`. Marking switches nothing: the tools stay on or off as they are, and a running conversation stops offering the lazy ones that are on one by one. A mark that names an MCP server's tools (they are lazy by their server's setting) or pi's built-in tools (the `built in` group) is refused with 400 and `code: "lazy-refused"`, and nothing is stored |
| `GET /api/sessions/:id/tools` | `{ tools, live, off }` — every tool the conversation could use and whether it is on. `live` is false when pi is not running to be asked. A [lazy](/guide/extensions#lazy-tools) tool (not offered one by one, reached through the `tools` tool) carries `lazy: true` whether it is on or off here; off, it is not reachable. The project and routine tool lists mark it the same. In a chat whose [mode](/guide/sessions#modes) switches `codemode` on, `codemode` carries `byMode: true` while it is on: its switch cannot turn it off |
| `PUT /api/sessions/:id/tools` | `{ off: string[] }` — switch tools off by name; everything not named is on. 409 with `code: "codemode-held"`, and nothing written, for a list that turns `codemode` off in a chat whose mode switches it on |
| `GET /api/tool-names` | What each package is called here; everything unnamed keeps its own name |
| `PUT /api/tool-names` | `{ names }` — a name per package, MCP server or `built in`. An empty one removes it |

`prompt` returns as soon as pi accepts the message, **not** when the work
finishes. Watch the event stream for progress.

If a Stop got there first, while pi was still starting for the message, the
answer is `{ ok: true, unsent: true }` and the message was **not** sent: the
chat shows it as not sent (a `portal_unsent` event), and nothing will answer it.

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

The stream also carries named events (`event: extension`, and
a few of the portal's own). `extension` is what an installed extension's server
half tells what it drew on the page: `{ "extension": "<package>", "data": … }`,
first where things stand as the stream opens, then each thing as it is said.
None of them has a `seq`, and none is stored.

::: warning Negative seq
Live-only events — streaming message/tool updates, queue updates, prefill progress and extension dialogs — carry a negative `seq`. They are never
persisted, so they must not move your cursor. Ignore anything `<= 0` when
tracking position, or reconnecting will skip real history.
:::

Types worth knowing: `portal_prompt`, `portal_unsent`, `portal_status`, `portal_notice`,
`agent_end`, `extension_ui_request`, `extension_ui_cancel`, `extension_error`,
`stderr`, `queue_update`, `portal_prefill`, `message_update`, `message_end`, `tool_execution_update`, and `tool_execution_end`, plus other pi lifecycle events.

Completed assistant messages and tool results are saved; their streaming updates stay in memory. On connection, the named `live-reset` event tells a client to discard stale in-memory updates before replay. A `message_snapshot` restores the current assistant message; tool updates restore current tool output. The named `caught-up` event carries the last durable sequence. Render completed `message_end.message` content even when no deltas were replayed.

## Session config

| | |
| --- | --- |
| `GET /api/sessions/:id/config` | `{ state, thinking, models, stats, contextLimit }` |
| `POST /api/sessions/:id/config` | `{ provider?, modelId?, thinkingLevel?, autoCompaction?, autoRetry? }` |
| `PUT /api/context-limit` | `{ provider, model, tokens }` — the context window this model really has here; `tokens: null` goes back to the default, or the model's own |
| `PUT /api/context-default` | `{ tokens }` — a ceiling on the window of every model; `null` removes it. Also returned by `GET /api/settings` as `contextDefault` |
| `POST /api/sessions/:id/compact` | Compact now |
| `GET /api/sessions/:id/commands` | The slash command palette |

`GET` does not start pi. While it is not running the response is `live: false`
with the stored model and effort, empty `thinking` and `models`, and
`stats: null`; once it is, it carries context usage and token counts.

When pi is running, the response also has `contextLimit`, the window set with
`PUT /api/context-limit` or `null`, and `contextDefault`, the ceiling from
`PUT /api/context-default`. Both apply to open chats at once, and `contextLimit`
is per model rather than per chat. `contextLimitSupported` is `false` when pi
cannot be given a window (see below). None of the three is in the `live: false`
response.

With `EXECUTOR=container` both `PUT` routes answer 400: pi runs in the container
behind an RPC client, and the portal cannot change the model it measures
against. `tokens` must
be a whole number from 1,024 to 10,000,000.

`GET /api/sessions/:id/models` starts pi when necessary and returns the live model list and state.

`POST` returns `{ ok, applied, state }`, where `applied` lists what actually
changed. Only those fields are persisted — an effort change does not rewrite the
model.

`compact` fails with a message when the session is too short for pi to bother.

## Editing messages

| | |
| --- | --- |
| `DELETE /api/sessions/:id/messages/:seq` | Removes a message and the agent's answer to it. 409 while the chat is running, 404 for an unknown message |
| `POST /api/sessions/:id/messages/:seq/edit` | `{ message }` — replaces the message: it and everything after it are dropped, and the new text is sent. The old text stays as another version |
| `DELETE /api/sessions/:id/queued/:seq` | Takes back a message that was sent while the agent was working and has not been read yet. 409 once the agent has taken it in. The other queued messages keep their order (they are sent again under new numbers) |
| `POST /api/sessions/:id/queued/:seq/send` | Sends a queued message now: stops the run and sends it first, with the other queued messages behind it in their order. 409 once the agent has taken it in |
| `POST /api/sessions/:id/messages/:seq/version` | `{ to }` — shows another version of the message, and what followed it then |
| `PUT /api/sessions/:id/draft` | `{ text, caret?: { start, end } }` — what is in the chat box, which an extension can ask for. Starts nothing |
| `GET /api/sessions/:id/stats` | Context usage and token counts, without the model catalogue |

## Git

The [Git](/guide/git) extension's routes (`extensions/git`), while it is installed,
all for the folder of chat `:id`. Each is refused when the folder is not a
repository, except `init` and `repos`. `?repo=` picks one of the repositories
inside the folder, by its path relative to it.

| | |
| --- | --- |
| `GET /api/x/pithagoras-git/chats/:id` | Branch, upstream, ahead/behind, changed files, an operation in progress. Reads the disk only |
| `GET …/chats/:id/repos` | The repositories inside the chat's folder, for the Repository picker |
| `GET …/chats/:id/gh` | Whether pull requests can be had through `gh`, and for which GitHub repository. `?fresh=1` asks again |
| `POST …/chats/:id/init` | Make the folder a repository |
| `GET …/chats/:id/diff?of=` | A diff: `of` is `unstaged`, `staged`, `untracked` (with `path`), `commit` (`sha`), `range` (`base`) or `stash` (`stash`) |
| `POST …/chats/:id/stage` · `/unstage` · `/discard` | `{ paths }` or `{ all: true }` (not for `discard`) |
| `POST …/chats/:id/commit` | `{ message, amend? }` |
| `POST …/chats/:id/abort` · `/continue` | Abort or continue a paused merge or rebase |
| `GET …/chats/:id/log` · `GET …/chats/:id/commits/:sha` | History, in pages; one commit with its files |
| `GET …/chats/:id/branches` · `POST …/chats/:id/branches` · `POST …/chats/:id/branches/delete` | List, `{ name, from? }`, `{ name, force? }` |
| `POST …/chats/:id/switch` | `{ name, remote? }` |
| `POST …/chats/:id/fetch` · `/pull` · `/push` | Each answers `{ said }`; pull is fast-forward only |
| `GET …/chats/:id/stashes` · `POST …/chats/:id/stashes` | List; `{ message? }` stashes the changes. `POST …/stashes/apply` · `/pop` · `/drop` with `{ ref, sha? }` act on one |
| `GET …/chats/:id/compare?base=` | The branch against its base |
| `GET …/chats/:id/pulls?state=` · `…/pulls/current` · `…/pulls/:n` · `…/pulls/:n/diff` | Pull requests, through `gh` |
| `POST …/chats/:id/pulls` | `{ title, body, base?, draft? }` |
| `POST …/chats/:id/pulls/:n/checkout` · `/merge` · `/comment` · `/review` | `merge`: `{ method, deleteBranch? }`; `comment`: `{ body }`; `review`: `{ action, body }` |

## Terminal, background jobs and subagents

| | |
| --- | --- |
| `POST /api/x/pithagoras-terminal/terminal` | `{ chat? }` → opens a shell in that chat's folder (home otherwise); answers `{ id, cwd }`. The terminal extension's, while it is installed |
| `GET /api/x/pithagoras-terminal/terminal/:id/stream` | Server-sent events: its output |
| `POST /api/x/pithagoras-terminal/terminal/:id/input` · `/resize` | Keystrokes; the size of the panel |
| `DELETE /api/x/pithagoras-terminal/terminal/:id` | Ends the shell |
| `GET /api/sessions/:id/background` | `{ supported, jobs, …extension status, piRunning }` — background jobs are listed on the host executor on Linux only |
| `GET /api/sessions/:id/background/:key/output` | A job's output; 404 when it is not in a file the portal can follow |
| `POST /api/sessions/:id/background/:key/stop` · `/background/clear` | Stop one; clear the finished ones |
| `POST /api/sessions/:id/subagents/:agent/input` | `{ text }` — say something to a running subagent of the [subagent protocol](/guide/extensions#the-subagent-protocol), which the subagent extension's panel does. 409 when it cannot be reached |
| `POST /api/sessions/:id/subagents/:agent/stop` | Stop it |
| `POST /api/sessions/:id/extension-ui` | `{ extension, data }` — what an extension's browser half says to its own pi extension in the chat ([Building an extension](/guide/extension-ui)); starts the chat's agent if it was let go. 409 when the chat's agent does not run its extensions inside the portal |

## Model providers

| | |
| --- | --- |
| `GET /api/providers` | The providers pi knows, without their keys |
| `GET /api/providers/status` | Whether each server answers now |
| `POST /api/providers/probe` | Ask a server for its models, before or after it is saved |
| `PUT /api/providers/:id` | `{ kind, adding?, baseUrl?, api?, apiKey?, models? }` — 409 if `adding` and the id is taken |
| `DELETE /api/providers/:id` | Remove one |
| `GET /api/models` | Every model pi can use now — the ones with a key |
| `GET /api/packages/catalog?q=&topic=` | Packages published for pi; `topic=provider` narrows to provider packages |
| `GET /api/features/flags` | Only what holds the agent's memory — for the Projects page: `{ memory: { held, by } }`, whether an extension holds it in place of MEMORY.md ([`portal.memory.hold`](/guide/extension-ui#the-agent-s-memory)), and `by` its name (`null` while none does) |

See [Models and providers](/guide/models).

## Browser

The [Browser](/guide/browser) extension's routes (`extensions/browser`), while it
is installed, under `/api/x/pithagoras-browser`. A refusal is `{ error }` with the
status given.

| | |
| --- | --- |
| `GET /api/x/pithagoras-browser/state` | `{ running, unprotected, version, pages, uiPort, uiExposed, uiOutdated, cursor, connected, install, config, byDefault, chats, routines }`. `running` is that the browser answers on its debugging port (`BROWSER_CDP_URL`), with its `version` and the open tabs (`pages`, `{ title, url }`); `unprotected` that it runs with no password. `uiPort` is its own HTTPS port, `uiExposed` whether that answers other machines, `uiOutdated` a container made before the port was kept to one address. `cursor`: the agent's cursor is shown; `connected`: the chats have the browser's tools. `install` is `{ available, mode, image, container, pulling }`: `mode` `docker`, `local` (with `binary` and `headless`) or `external`, `container` `absent`, `stopped`, `running` or `unavailable`, and `pulling` `{ active, line, error? }`, how the download of the image goes. `config` is `{ user, hasPassword }`, never the password. `byDefault`, `chats` (`{ id, title, kind, allowed }`) and `routines` (`{ slug, name, allowed }`) say who has the browser's tools otherwise than the default (`portal.tools.exceptions`) |
| `POST …/install` | Pulls the image, takes over the profile volume and a container of the portal's from before, makes and starts the container (or starts the machine's Chrome), and connects the chats. 409 while an install runs; 400 without a password, with `BROWSER_EXTERNAL=true`, and with what failed |
| `DELETE …/install` | Removes the container (or stops the machine's Chrome) and disconnects the chats; `?profile=forget` deletes the profile volume too |
| `POST …/start` · `…/stop` | Starts or stops the container, or the machine's Chrome. 400 with `BROWSER_EXTERNAL=true` |
| `PUT …/config` | `{ user?, password?, port?, httpsPort? }` — for the container Install makes next; empty values are left as they were. The view uses a new password at once. Answers `{ user, hasPassword }` |
| `GET …/suggest-password` | `{ password }`: 24 random hex characters |
| `POST …/connect` · `DELETE …/connect` | Give the chats the browser's tools, or take them away. Idle chats are loaded again. Answers `{ connected }` |
| `PUT …/cursor` | `{ on }` — whether the tools show their cursor, from the next action. Answers `{ cursor }`; 400 when `on` is not a boolean |
| `…/ui/…` | The browser's own web UI, every method, and its websockets: proxied to its HTTPS port with its login added, the visitor's cookie and `Authorization` left out, and `frame-ancestors 'self'` added to its content security policy. 502 when the browser does not answer |

## Voice service

The [voice service](/guide/voice-service)'s routes (`extensions/voice`), while it is installed, under
`/api/x/pithagoras-voice`. A refusal is `{ error }` with the status given.

| | |
| --- | --- |
| `GET /api/x/pithagoras-voice/state` | `{ available, state, busy, progress, error, choice?, lazyLoad, chosen }`: whether Docker answers, the voice container's `state` (`unavailable`, `absent`, `installing`, `starting`, `running`, `stopped` or `failed`; `failed` too for a container by its name that is not the voice service's, with why in `error`), the setup log or the container's last lines (`progress`), the engines it was built for (`choice`), whether its speech model is let go of once voice mode no longer uses it (`lazyLoad`), and whether it is voice mode's source now (`chosen`). A setup started with `install` or `start` that has come up makes it voice mode's source, once |
| `POST …/install` · `…/start` · `…/stop` | `install` takes `{ tts, ttsDevice?, asr, asrModel, asrDevice? }` — `tts` is `breeze`, `chatterbox`, `kokoro` or `none` (speech recognition only, which needs no GPU); `ttsDevice` is `cpu` or `gpu` (the default), where `cpu` is for Kokoro alone and puts recognition on the CPU too; `asr` and `asrModel` are `whisper` with `base` or `small`, or `qwen3-asr` with `0.6b` or `1.7b`; `asrDevice` is `cpu` or `gpu`, where `gpu` is the default for Qwen3-ASR beside a speech engine on the GPU, and Whisper, recognition-only and recognition beside Kokoro on the CPU are always `cpu` — and builds for it, recreating an installed container that has other engines. Without a body it keeps the installed engines, or picks the combination that fits the GPU; where there is none, Kokoro on the CPU with the recognition that fits beside it, or recognition alone where the host has too little memory or too few threads for Kokoro. A choice the GPU or the host's memory cannot hold at all, and anything on the GPU on a host without one, is refused after the check, in the state's `error`; `400` for a combination that does not exist, and with `Docker is unavailable` without Docker. `install` and `start` mark a setup that is to be chosen as voice mode's source once it is up; `stop` does not |
| `GET …/hardware` | The GPUs the voice container can use (`gpus`, each with `index`, `uuid`, `name`, `totalMiB`, `freeMiB`; `source` says how they were read), the one it would take (`selected`, an index), the one chosen with `PUT …/gpu` (`chosen`, a UUID, empty where none is or the one chosen is no longer there), the memory kept free (`reserveMiB`), the combination that fits (`suggestion`), what recognition on the CPU has to run on (`host`: `totalMiB`, `freeMiB`, `threads`), whether the check could tell (`checked`) and whether it found there is no GPU (`cpuOnly`, with Kokoro on the CPU as the suggestion, or recognition alone where the host is too small for it). No GPU and no tool is `gpus: []`, not an error |
| `PUT …/gpu` | Choose the GPU the voice service runs on: `{ gpu: uuid }` (a UUID from `GET …/hardware`), or `""` to leave it to `VOICE_GPU`, else to the card with the most free memory when engines are installed or rebuilt (a restart keeps the card the service is on). `400` for a UUID that no GPU has, and for a GPU that cannot hold the engines installed (the error says what would fit); nothing is saved or stopped then. A running service is recreated on a new choice at once, any other on its next start; `409` says the choice is saved but the restart could not begin |
| `POST …/uninstall` | Remove the voice container: `{ removeData? }`, `true` deletes the volume with the downloaded engines and models as well, `false` (the default) keeps it; `400` for anything else. Stops a running container, then removes it; answers `{ ok: true }`, also where there is no container (a volume that is not there is no error either). Voice mode, where the service is its source, has none then; the voices and their settings are kept. Where the container is removed and the volume cannot be (`removeData: true`; Docker refuses it, say), that happens all the same and the answer is `409` with what Docker said. `400` with `Docker is unavailable` without Docker, with `Wait for voice setup to finish before uninstalling` while a setup is under way, and for a container named `pithagoras-voice` that is not the voice service's |
| `PUT …/chosen` | `{ chosen }`: `true` makes the running service voice mode's source, `false` stops it being that where it is (`portal.voice.choose`). Answers `{ chosen }`; `400` when `chosen` is not a boolean, and `Wait for voice setup to finish before using it for voice mode` for `true` while the service is not running |
| `PUT …/lazy-load` | `{ on }` — whether the speech model is let go of once voice mode no longer uses it. Answers `{ lazyLoad }`; 400 when `on` is not a boolean |
| `GET …/speech` · `PUT …/speech` | The service's own voice settings, [Your voice](/guide/voice-service#your-voice), with the defaults filled in: `voice` (`"design"` or a voice's id: what Breeze and Chatterbox speak with where the agent has no voice they have), `instruction` (the designed voice's description, 1–1000 characters), `cfgScale` (`1` or `4`), `exaggeration` (0–2), `kokoroVoice` (one of Kokoro's voice ids), `speed` (`0.85`, `1` or `1.15`) and `language` (an input language, or `auto`). `PUT` takes all of them and answers like `GET`; `400` with what is wrong, with Chatterbox's rules (a language it speaks, not `auto`, and a voice with a recording) where the container speaks Chatterbox |
| `GET …/voices` · `POST …/voices` | The voice library, each `{ id, name, kind, instruction, transcript }`, `kind` being `design` or `clone`. `POST` takes `{ name, kind, instruction, transcript?, audio? }` (for a clone, the exact words and the recording: base64 of a mono 16 kHz 16-bit WAV of 1–30 seconds) and answers the voice; `400` with what is wrong |
| `PATCH …/voices/:id` | `{ instruction }`, the voice description (1–1000 characters); answers the voice. `404` for a voice not in the library |
| `GET …/voices/:id/audio` | A clone's recording, `audio/wav`; `404` for a designed voice or one not in the library |
| `DELETE …/voices/:id` | Removes the voice and its recording; where it was the service's own choice, the designed voice is again. Agents' voices are not changed. `{ ok: true }`; `404` for a voice not in the library |

## Voice servers

The [Voice servers](/guide/voice-servers) extension's routes (`extensions/voice-servers`), while it is installed,
under `/api/x/pithagoras-voice-servers`. A refusal is `{ error }` with the status given.

| | |
| --- | --- |
| `GET /api/x/pithagoras-voice-servers/settings` | `{ sttUrl, sttModel, language, dictationUrl, dictationModel, ttsUrl, ttsModel, voices, voice, customVoices, speechServer, chosen }`: the speech recognition address and model, the input language, dictation's own address and model, the speech synthesis address and model, the voices (`{ id, name }`) and its own choice of the voices offered (one of them, or with custom voices on and Breeze or Chatterbox, a voice of the library), whether [custom voices](/guide/voice-servers#custom-voices) are on (`customVoices: true`) and what the speech server is (`speechServer`: `breeze-audiocpp`, `breeze-tts`, `chatterbox-audiocpp` or `chatterbox-tts-server`, kept while custom voices are off), each left out while it is empty or off (a server with fixed voices is left out), and whether it is voice mode's source now |
| `PUT …/settings` | The same fields but `customVoices`, `speechServer` and `chosen`, all of them: one left out is empty. `customVoices` and `speechServer` are kept as they are. `400` with what is wrong: an address that is not `http:` or `https:`, or has a user, a password or a fragment; a model of more than 100 characters, or of others than letters, digits, `.`, `_`, `:` and `-`; a language that is not two or three small letters; more than 500 voices, or an id of more than 200 characters; a voice not among those offered; with custom voices on, no language for `chatterbox-audiocpp` and no model for `chatterbox-tts-server`. Answers like `GET` |
| `POST …/server-voices` | `{ ttsUrl }`: the voices the speech server lists at `…/audio/voices`, beside a `ttsUrl` that ends in `/audio/speech`, as `{ voices }`, each `{ id, name }`. Nothing is saved. `400` for an address that does not end that way, and for a list that is not `{ voices: [...] }` of ids or `{ id, name? }`; `502` with why the server could not be read, also where it has not answered within 10 seconds |
| `PUT …/chosen` | `{ chosen }`: make it voice mode's source, or stop that where it is. Answers `{ chosen }`; `400` when `chosen` is not a boolean, and `Set a speech recognition address first` for `true` without a saved `sttUrl` |
| `PUT …/custom-voices` | `{ on }`: custom voices on or off, at once. Off, the library is kept and not offered, and each phrase is sent as OpenAI's request; a `voice` the change no longer offers is no longer the page's choice. Answers like `GET`; `400` when `on` is not a boolean, and for `true` where the speech server saved needs a language or a model that is not set |
| `PUT …/speech-server` | `{ speechServer }`: what the speech server is and how it is reached, `fixed`, `breeze-audiocpp`, `breeze-tts`, `chatterbox-audiocpp` or `chatterbox-tts-server` (what each is sent: [What each form sends](/guide/voice-servers#what-each-form-sends)). A `voice` it does not offer is no longer the page's choice. Answers like `GET`; `400` for another value, and with custom voices on, for `chatterbox-audiocpp` with no language and `chatterbox-tts-server` with no model |
| `GET …/voices` · `POST …/voices` | The voice library, each `{ id, name, kind, instruction, transcript, stored? }`, `kind` being `design` or `clone`, sorted by name; `stored` is `{ url, at }`, where a clone was last stored on Chatterbox-TTS-Server and when. `POST` takes `{ name, kind, instruction, transcript?, audio? }` — a name of 1–100 characters, a description of 1–1000, and for a clone the exact words (up to 4,000 characters) and the recording, base64 of a mono 16 kHz 16-bit WAV of 1–30 seconds, in a body of at most 2 MB — and answers the voice; with custom voices on and `chatterbox-tts-server`, a clone is stored there as well, and where that fails, the voice is kept and the answer has `storeError`, why. `400` with what is wrong, `413` for a larger body |
| `PATCH …/voices/:id` | `{ name?, instruction? }`, either or both: a new name (1–100 characters) or description (1–1000). Answers the voice; `400` with what is wrong, and nothing is changed; `404` for a voice not in the library |
| `GET …/voices/:id/audio` | A clone's recording, `audio/wav`, not cached; `404` for a designed voice or one not in the library |
| `POST …/voices/:id/store` | Stores a clone's recording on Chatterbox-TTS-Server now, at `/upload_reference` beside the speech synthesis URL, and answers the voice with `stored`. `400` where the speech server is not `chatterbox-tts-server` (with custom voices on), for a designed voice, and for a speech synthesis URL that does not end in `/v1/audio/speech`; `404` for a voice not in the library; `502` with why the server did not store it, also where it has not answered within 30 seconds |
| `DELETE …/voices/:id` | Removes the voice and its recording; where it was the page's own choice, the server's own voice is again. Agents' voices are not changed, and a copy stored on Chatterbox-TTS-Server stays there, as the server cannot delete one. `{ ok: true }`; `404` for a voice not in the library |

## Voice

| | |
| --- | --- |
| `GET /api/voice` · `PUT /api/voice` | Voice mode's settings: `{ provider, label?, ready, speech, voices, enabled, conversation, vad, responseInstructions, defaultResponseInstructions, responseInstructionsOff, skipThinkingProviders, defaultSkipThinkingProviders, voiceModel, comparison, statusSpeech, ttsPrefetch, sentenceChunks, pipelineMode }`. `provider` is voice mode's source, the package's name of the extension it listens and speaks through, or `""` for none; `label` is its label while its server half runs; `ready` that it can be used now; `speech` whether it speaks (`false` for recognition alone, `true` while it is not running: voice mode then says why it cannot start); `voices` the voices it offers now, each `{ id, name, builtIn? }` (`[]` unless `ready`); `enabled` that there is a source; `conversation` whether voice mode, the spoken conversation, is offered (`false` leaves dictation alone; on where nothing is saved). `PUT` takes `{ vad?, responseInstructions?, skipThinkingProviders?, voiceModel?, conversation? }` (a `conversation` left out is `true`) and leaves the source as it is, which an extension chooses itself (`portal.voice.choose`); it answers like `GET`, and `400` with what is wrong |
| `DELETE /api/voice/provider` | Stop using: voice mode has no source until one is chosen on an extension's page. Answers like `GET /api/voice` |
| `POST /api/sessions/:id/voice/connection` | `{ client, active }`: take (`true`) or give back (`false`) a voice session's lease, `client` being the tab's own id. Every voice session takes one before it listens and renews it every 25 seconds; one not renewed for 75 seconds runs out. The first tells the source that voice mode is in use, and the end of the last that it is not. `{ ok: true }`; `409` for taking one while voice conversations are off (giving one back still works); `503` with what failed, among it the source not running |
| `POST /api/sessions/:id/voice/transcribe` | `audio/wav` body (12 MB at most) → `{ text }`, from the source. `?purpose=dictation` tells it the recording is dictation. `400` for a body that is not a WAV; `502` with what the source said |
| `POST /api/sessions/:id/voice/speech` | `{ text }` (1–600 characters) → `audio/pcm`: mono, 24 kHz, signed 16-bit little-endian (`X-Sample-Rate: 24000`, `X-Sample-Format: s16le`), in the voice of the chat's agent, or the source's own choice. `409` while voice conversations are off, and while the source recognises speech alone; `502` with what the source said, or why its audio was refused |

The session routes answer 409 while voice mode has no source, and 503 while its source is not running or offers nothing. See [Voice control](/guide/voice).

## Canvases

The [Canvases](/guide/canvases) extension's routes (`extensions/canvas`), while
it is installed, for chat `:id`. What changes is told to the pages open on the
chat on its stream, as `event: extension` with `pithagoras-canvas`: all of its
canvases when a page opens it, then each change.

| | |
| --- | --- |
| `GET /api/x/pithagoras-canvas/chats/:id/canvases` · `POST` | List; `{ title }` creates one |
| `PUT …/chats/:id/canvases/:cid` | `{ revision, title, content }` — 409 when `revision` is stale |
| `POST …/chats/:id/canvases/:cid/persist` | Store a temporary canvas |
| `POST …/chats/:id/canvases/:cid/restore` | `{ revision }` — put back the text from before a write that was cut off (`restorable` in the canvas). 409 when `revision` is stale, a write is going on, or there is no earlier text |
| `DELETE …/chats/:id/canvases/:cid` | `{ revision }` — Delete |

## Updating the portal

Settings → About → Update. Whoever is signed in may use it. A portal that does not run from a git checkout, or that runs from its source files under a file watcher, answers 404 `unavailable` to the last two.

| | |
| --- | --- |
| `GET /api/update` | `{ kind, boot, branch, current, notice, checkedAt, rebuild, run }` from the portal's memory, the remote is not asked. `kind` is `git`, `container` (a container cannot rebuild itself), `dev` (source files under a watcher) or `none`; only `git` has the rest. `notice` is `{ count, target, since }` while `origin/main` has commits the checkout lacks. `rebuild` is true when `core/server/dist/.built-from` names another commit than the one checked out, and the build is still the one it was written for (a build made by hand is not). `boot` changes with each start of the portal. `run` is the update going on or the last one that failed: `{ state: "running" \| "restarting" \| "failed", steps, from, to, startedAt, failed? }`, with `failed` being `{ step, message, output, oldFilesBack }` (`oldFilesBack`: the old node_modules and builds are in place, as they were or put back; false once they have been thrown away for the new build, which is how a failed restart ends, or where putting them back failed) |
| `POST /api/update/check` | Fetches `origin/main` and answers `{ branch, current, target, behind, ahead, changed, rebuild, problem, running }`. `problem` is `{ code, message }` with `code` `fetch`, `detached`, `dirty`, `diverged` or `restart` (a systemd service not set to start again), or `null`. `running` is the number of chats and runs the restart would stop. Changes nothing |
| `POST /api/update` | `{ expect }` — required: the commit that was shown. Without it, or with anything but a commit id, 400 `invalid`, and nothing starts. Starts the update: 202 `{ run }`. Refused with 409 and a `code`: `busy` (one is running), `moved` (`origin/main` is not `expect` any more), `current` (nothing to update to, and the build is of the commit checked out), or the `problem` of a check |

## Restarting the portal

Settings → About → Restart. Whoever is signed in may use it.

| | |
| --- | --- |
| `GET /api/restart` | `{ possible, by?, code?, reason?, running, loaded, keepsLogins }`. `possible` is true when something would start the portal again (`by`: `systemd`, `container`, `manager` or `copy`); otherwise `code` is `unsupervised`, `policy` or `update` (an update is running) and `reason` says why. `loaded` is the list of extensions this start of the portal runs (null until known), `keepsLogins` whether a login outlives the restart (`PORTAL_SECRET` is set). `running` is the number of chats and runs a restart would stop. Changes nothing |
| `POST /api/restart` | `{ confirm: true }` — required; without it 400 `confirm`, and nothing happens. 202 `{ restarting: true, boot }`, and the portal ends with status 75 a moment later. 409 `unsupervised` or `policy` where nothing would start it again, 409 `update` while an update runs, 409 `busy` while a restart is on its way (`POST /api/update` answers 409 `restarting` then). Written to the log |
| `GET /api/health` | `{ ok: true, boot }`, without a login, while the portal is up. `boot` changes with each start of the portal, so a client that asked for a restart waits for another one |

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
| `POST /api/packages` | `{ spec }`: a spec of a form pi documents, or `npm:<name>@<range>` with a semver range, as an extension that requires the package installs it. Answers `{ ok, output, reloaded, waiting }`: the open sessions are reloaded, an idle one at once and a working one at its next step (`waiting`). A folder installed again is loaded again in place |
| `DELETE /api/packages` | `{ spec }`; reloads the open sessions as installing does |
| `POST /api/packages/update` | Update the installed pi packages (`pi update --extensions`); pi itself comes with the portal's version. Reloads the open sessions as installing does |
| `GET /api/extensions` | Parsed packages with their recovered settings, each with `kinds`: what it brings, of `pi`, `pithagoras` and `themes`; and, for one in an extension's own data folder, `installedFrom` (`{ extension, note?, at? }`): that extension, and the note it gave and when, where it installed it itself ([Extensions it installs](/guide/extension-ui#extensions-it-installs)) |
| `GET /api/extensions/shipped` | `{ extensions: [{ name, version?, description?, kinds, spec, requires? }] }` — the extensions that come with the portal; `spec` is the folder each is installed by, `requires` the extensions each cannot work without |
| `GET /api/extensions/plan?spec=` | `{ name?, version?, needs: [{ name, range, for, action, spec?, from?, version?, error? }] }` — what installing `spec` brings with it: each extension it requires, and each those require, that is not there as it is needed, each before what needs it. `action` is `install` (by `spec`, `from` the portal's folder or npm), `switch-on`, `missing` or `version` (there in a version not taken: installed, or with `from`, the portal's folder's or the one npm gives what needed it first). No `name` and no needs for a spec that cannot be read beforehand: a git URL, a folder ([Installing what it requires](/guide/extension-ui#installing-what-it-requires)) |
| `GET /api/extension-ui` | `{ revision, extensions: [{ name, version, rev?, entry?, style?, clientError?, clientStack?, server?, serverError?, crash?, requires?, themes? }] }` — the installed packages, switched on, that bring a browser half, a server half or themes, with the revision of what is installed this list is of (as `GET /api/sessions` says it): the revision of its browser half (of the files of its web folder, [What is loaded, and when](/guide/extension-ui#what-is-loaded-and-when)) and the addresses its module and stylesheet are fetched from under it, why that half failed in a page and where if one said so of this revision, where its server half's routes are, why that half is not running if it could not be started, and what it requires. `crash` (`{ name, rev, at, error, stack?, lines }`) is there while the server half is held off for a crash: when, the revision that crashed, the error, and its last lines as a log file has them ([When the server half crashes](/guide/extension-ui#when-the-server-half-crashes)) |
| `POST /api/extension-ui/failures` | `{ name, rev, error, stack? }` — a page says that the browser half of `name`, at revision `rev`, failed there: to load, to draw, or in what it runs of its own; `stack` is where, as the page had it. The latest is kept for each package and said as its `clientError` and `clientStack` until another revision of it is installed. 400 without `name`, `rev` and `error`, 404 when no browser half of that name is installed at that revision |
| `GET /api/extension-ui/<package>/~<rev>/<file>` | A file of that package's web folder, under the revision of its browser half; without `~<rev>/`, or under another revision, the same file |
| `/api/x/<package>/…` | The routes of that package's server half, whatever it serves there, behind the portal's login; no body is read for them unless the route asks. WebSocket upgrades under the same address go to it, checked for the login and for the page they come from |
| `PUT /api/extensions/enabled` | `{ spec, enabled }` — switch a package off or on without uninstalling it; reloads the open sessions, an idle one at once, and says how many are working and reloaded at their next step (`waiting`) |
| `PUT /api/extensions/settings` | `{ key, value }` — empty value removes the key |
| `GET /api/pi-settings` | Raw `settings.json` |
| `PUT /api/pi-settings` | `{ content }` — refused unless it parses as JSON; reloads the open sessions as installing a package does, and answers `{ ok, path, reloaded, waiting }` |

## Opt-in features

| | |
| --- | --- |
| `GET /api/x/pithagoras-subagent/settings` | `{ mode, maxParallel, maxParallelLimit, model }` — the subagent extension's settings; there while the extension is on |
| `PUT /api/x/pithagoras-subagent/settings` | `{ mode?: "interrupt" \| "background", maxParallel?: 1–16, model?: "auto" \| "provider/model" }` — each it names; reloads the open sessions, as the mode and the limit are in the tool's description, and answers the settings with `{ reloaded, waiting }`. `enabled: false` is refused: the extension is switched in Settings → Extensions (`PUT /api/extensions/enabled`) |
| `GET`, `PUT /api/features/subagent` | Moved: a 307 (which no browser keeps) to `/api/x/pithagoras-subagent/settings`, the method and the body kept |
| `GET /api/x/pithagoras-subagent/chats/:id/model` | `{ model, default }` — what this chat's subagents run on: its own choice, `null` for `default`, the extension's `model`. 404 for a chat there is not |
| `PUT /api/x/pithagoras-subagent/chats/:id/model` | `{ model: null \| "auto" \| "provider/model" }`; answers as `GET`. Read as a subagent starts: nothing is reloaded |
| `GET`, `PUT /api/sessions/:id/subagent-model` | Moved: a 307 to `/api/x/pithagoras-subagent/chats/:id/model`, the method and the body kept |

## Understory

The [Understory](/guide/features#memory-understory) extension's routes
(`extensions/understory`), while it is installed, under
`/api/x/pithagoras-understory`. A refusal is `{ error }` with the status given.
A change answers `{ understory }`, the state after it, and where it wrote or
removed the agent's MCP entry also `reloaded` and `waiting`: the idle chats
loaded again to have it, and the busy ones that have it after `/reload`.

| | |
| --- | --- |
| `GET /api/x/pithagoras-understory/state` | `{ enabled, url, tokenSet, reachable, managed }`: whether Understory is the agent's memory now (its `understory` server in `mcp.json`, not switched off, and `pi-mcp-adapter` on), the address the chats reach it at, whether a token is sent, and whether anything answers there. `managed` is the Understory run here: `{ available, image, container, pulling, url, config, autoPossible, providers, dreaming, lastDream, nextDream, timeZone }` — `container` is `absent`, `stopped`, `running` or `foreign` (one by its name that is not Understory's), `pulling` `{ active, line, error? }`, `config` never holds a key (`hasKey` instead), `autoPossible` whether its model server listens (`UNDERSTORY_LLM_PORT`), so that the chat's model can be chosen |
| `PUT …/use` | `{ enabled, url? }` — writes or removes the `understory` MCP server (installing `pi-mcp-adapter` if needed), and adds it to the trusted servers in Settings → Guard, or takes it out. 409 while `mcp.json` cannot be read, and, for the Understory run here, while what the portal kept of it has not been taken up |
| `PUT …/config` | `{ llm: { source: "auto" } \| { source: "provider", provider, model } \| { source: "custom", baseUrl, model, format, apiKey? }, dreamInterval, dreamAt }` — `auto` (the default) thinks with the model of the chat asking — `dreamAt` ("03:00") tidies up once a day at that time and wins over `dreamInterval` — the model and tidying up of the Understory run here; an installed one is made again with them, started where it was running. `apiKey` left out keeps the saved one. 400 for `auto` while the model server could not take its port; 409 for an installed one while what the portal kept of it has not been taken up |
| `POST …/install` | Pull, create and start the Understory run here, and make it the agent's memory. 409 for a container by its name that is not Understory's |
| `DELETE …/install` | Remove it (the memory stays in its volume; `?memory=forget` deletes it too), and switch it off as the memory where it was |
| `POST …/start` · `…/stop` | Its container. Not started in the chat's model mode while the model server could not take its port |
| `POST …/dream` | Tidy the memory up now; answers when the pass is done, with what it did (`run`). 502 for a pass that failed, 409 while one runs |
| `GET …/tree` | Understory's memory bundle as a tree of folders and notes — read while Understory is the agent's memory (409 when it is not) |
| `GET …/concept?path=` | One note: `{ path, frontmatter, body }`; 404 when it is not there |
| `GET …/search?q=` | Notes matching, best first |
| `GET …/log` | What changed, newest first |
| `GET …/graph` | `{ nodes: [{ path, title, type, links }], edges: [{ source, target }] }` |
| `GET …/traces` | The paths Understory's own queries and changes took |
| `GET …/trace?id=` | One of those runs with its steps: `{ id, kind, input, notation, outcome, steps: [{ seq, tool, summary, paths, write }] }`, `paths` being the full paths of the notes a step read, wrote or found; 404 when it is not there |
| `GET …/validate` | `{ conformant, conceptCount, directoryCount, issues }` |
| `GET …/health` | `{ writable, health? }` — whether notes can be changed here (the Understory run here, running and the memory), and what its checks find: `{ healthy, orphans, brokenLinks, issues }` |
| `PUT …/concept` | `{ path, frontmatter, body }` — write a note through Understory's own write path (its index and log follow); `frontmatter` needs `type` and `title`. Answers `{ concept, health }`; 409 unless writable, or while a pass of the model holds Understory |
| `DELETE …/concept?path=` | Delete a note the same way; answers `{ health }` |
| `POST …/reindex` | Every folder's index.md written anew and empty folders removed, no model; answers `{ pruned, reindexed, health }` |
| `POST …/repair` | The model mends links to nothing and wires in orphans, only when there are any; answers `{ ran, reason?, summary?, filesChanged?, health }` |
| `POST …/clear-log` | log.md back to its heading and the query paths removed; the notes stay |
| `POST …/wipe` | Every note and folder deleted, the root index and log as new, Understory stopped and started again; answers once it answers again |
| `POST …/chat` | `{ messages }` — a conversation with the librarian, Understory's own agent (at most 200 messages, ending with the person's). Answers Understory's stream of UI message chunks as it comes; one cut off midway ends in an `error` chunk. 409 unless writable, and while the librarian still works on the last question |

The model server Understory thinks with in the chat's model mode is not one of
these routes: the extension serves it itself, on `127.0.0.1` at
`UNDERSTORY_LLM_PORT` (3801), as `GET /v1/models` and
`POST /v1/chat/completions`, for Understory alone, with a bearer token of its
own. A request goes to the model of the chat whose memory tool is running.

## Media

The [Media](/guide/media) extension's routes (`extensions/media`), while it is
installed: the settings of its endpoints, and the pictures and videos of its
page with the gallery of those. No key is ever in an answer.

| | |
| --- | --- |
| `GET /api/x/pithagoras-media/state` | Only whether each is on, for the sidebar and the page: `{ images: { enabled }, videos: { enabled } }`, where `images.enabled` is that image generation, or editing, is on and has an address, and `videos.enabled` that video generation is on and has an address; the Media page is listed while either is |
| `GET …/settings/images` | `{ images: { enabled, baseUrl, model, size, keySet, editEnabled, editBaseUrl, editModel, editMultiple, editMaxSize, timeoutSeconds, sdExtras, editKeySet, ready, editReady } }` — the image endpoint alone; no key is ever returned. `ready` is whether pictures can be made: it is switched on and has an address to ask. `editReady` is whether editing is available: it is switched on and has an address to ask, its own or generation's. It is what makes the agent's `edit_image` tool exist. `sdExtras` is whether the endpoint is said to be a stable-diffusion.cpp server, which the Media page may then send the settings only it reads (see below); false when never saved. `editMultiple` is whether the editing endpoint is said to take several pictures: with it, and `editReady`, the tool has a list of pictures (`paths`) instead of one (`path`) |
| `PUT …/settings/images` | `{ enabled?, baseUrl?, model?, size?, apiKey?, editEnabled?, editBaseUrl?, editModel?, editApiKey?, editMultiple?, editMaxSize?, timeoutSeconds?, sdExtras? }` — `baseUrl` is an http(s) base with no login, query or fragment (empty clears it), `size` is `WIDTHxHEIGHT` or `auto` (empty clears it), `apiKey` left out keeps the saved one and `""` removes it; an address of another origin than the saved one, without a key, drops the saved key (a key saved before any address stays for the first). The `edit…` fields are editing's own switch, address, model and key, checked and kept the same way: an empty `editBaseUrl` means the address of generation, `editModel` is the only model sent on an edit (the one of generation never is), and the key of generation goes to the edit address only when it is the same server, while `editApiKey` is the key of the address edits go to and is dropped when that address changes to another server without one. `editMaxSize` is `WIDTHxHEIGHT` (empty, the default, is no limit): the most pixels a picture sent to be edited may have, either way up: a larger one is scaled down to it (its ratio kept, never enlarged) before it is sent, and the job or the tool's answer says so. It is read at each call, so it needs no reload. `editMultiple` (a boolean, off by default) says the editing endpoint takes several pictures in one request, up to 8 and 50 MB together, sent as `image[]`; it is said of that endpoint, so an `editBaseUrl` (or, with none of its own, a `baseUrl`) of another origin takes it off again unless the same request says it. `sdExtras` (a boolean, off by default) is about the endpoint as a whole, for generating and editing, so a `baseUrl` or `editBaseUrl` of another origin takes it off again unless the same request says it: on, the Media page may put `negative_prompt`, `seed`, `sample_params.sample_steps` and, for an edit, `strength` and `init_image: null` in a `<sd_cpp_extra_args>` block in the prompt, which only stable-diffusion.cpp servers understand; off, nothing of this kind is sent whatever a request carries, and the agent's tools never send any of it. Read at each request, so it reloads no chat. `timeoutSeconds` is how long a request for a picture, generated or edited, may take, in whole seconds from 30 to 3600 (300 when none was saved; `null` takes a saved one away; anything else is a 400); it is read at each request, so changing it reloads no chat. 400 for anything else, for `enabled: true` with no address, and for `editEnabled: true` with no address, its own or generation's. Answers `{ images, changed, reloaded, waiting }`; idle open sessions are reloaded only when a tool came or went, or the edit tool's shape changed (`changed`: generation's or editing's, or whether the edit tool takes a list) |
| `GET …/settings/videos` | `{ videos: { enabled, backend, backends: [{ id, label }], baseUrl, model, size, frames, fps, timeoutSeconds, storageLimitMb, keySet, ready } }` — the video endpoint alone; no key is ever returned. `frames` and `fps` are `null` for the server's own, `storageLimitMb` is 0 for no limit, `ready` is whether videos can be made: switched on, and with an address to ask |
| `PUT …/settings/videos` | `{ enabled?, backend?, baseUrl?, model?, size?, frames?, fps?, apiKey?, timeoutSeconds?, storageLimitMb? }` — `baseUrl` is an http(s) base with no login, query or fragment (empty clears it), `size` is `WIDTHxHEIGHT` with each side from 64 to 4096 or empty, `frames` (1–1000) and `fps` (1–120) are whole numbers or `null`, `timeoutSeconds` is whole seconds from 30 to 14400 or `null` for the default (half an hour), `storageLimitMb` is whole megabytes or `null` for no limit, `backend` is one of `backends` (`sdcpp` now), `apiKey` `""` removes the saved key. Switching on needs an address (400 otherwise); a key belongs to the server it was given for, so another origin without a key drops it. Answers `{ videos, changed, reloaded, waiting }`, where `changed` is that the agent got or lost its video tools, which reloads the idle chats |

### Images

The pictures of the [Media page](/guide/media): pictures made with the image endpoint without a
chat, and the gallery of those, the ones the agent made in chats and the ones that lie in
the folders its tools write into. A picture is named by its **id**, twelve lowercase hex
digits, never by a path: Media opens files only in the folder of the page's own
pictures and in `generated-images` of the agents' homes, of the projects and of the folders chats work
in, with the checks a picture of a chat's folder has. Reading the list from the top also
looks in those `generated-images` folders for pictures nobody recorded, such as ones made
before the gallery kept an index, and lists each plain file there whose bytes show a PNG,
JPEG, GIF or WebP of at most 25 MB (no link is followed, nothing is looked at that is not in
such a folder), as a picture of `origin` `folder`. The endpoint's address, key and model are the
settings' (see [above](#media)).

| | |
| --- | --- |
| `GET /api/x/pithagoras-media/images?origin=&kind=&before=&limit=&again=` | A page of the gallery, newest first: `{ pictures, next, total, pageBytes }`, where `pageBytes` is what all the page's own pictures take of the disk, whatever the filters match. `origin` is `page`, `chat` or `folder`, `kind` is `generated`, `edited`, `uploaded` or `unknown`, `limit` is 1–100 (48 by default), and `before` is the `next` of the page before (`null` at the end). `again=1` says the caller asks again for the top of a list it has, as on a timer: the look through the folders (below) is then not made again within a minute of the last one, and the page is what that look found. Without it the top of the list is looked through at once. `total` counts what the filters match. A picture whose file is gone, or that cannot be served any more (its `generated-images` became a link out of the folder), is dropped from the list when it is read from the top; one in a chat's folder that cannot be reached for the moment (a drive that is not mounted) is kept. When a chat is deleted its pictures become pictures of its folder (`origin: "folder"`, with their `prompt` and `params`), unless the folder cannot be reached then. A picture found in a folder has `origin: "folder"` (which chat made it cannot be told), no `chat`, an empty `prompt`, a `kind` read from its file's name (`generated` for the tools' `image-…` names, `edited` for `…-edited`, else `unknown`), and is dropped with its folder, not kept. A picture is `{ id, origin, chat: { id, title } \| null, folder: { name, home } \| null, kind, prompt, params: { model?, size?, outputFormat?, outputCompression?, negativePrompt?, seed?, sampleSteps?, strength?, fromNoise?, extra?, sources?, masked? }, from, createdAt, bytes, fileName, thumb }`, where `thumb` says whether the picture is shown by its small copy (see `/thumb` below): false for a file of 48 KB or less and for a GIF, `folder` is where a picture of origin `folder` was found (`name` is the agent's name for an agent's home, `home` being true for the first agent's, else the project or the path under the workspace root; the folder of an agent deleted with its folder kept is named by its folder), `params` are the settings it was asked with (only those that were sent; `extra` is the free fields an older version sent, and is no longer written), `createdAt` of such a picture is its file's modification time, and `from` is the picture an edit was made from, when that is in the list |
| `GET …/images?ids=a,b` | Those pictures alone, in the order given, as far as they are in the list: `{ pictures }`. At most 200 |
| `GET …/images/:id/file` | The picture as a file, with its type from its bytes (PNG, JPEG, GIF or WebP, else 400; 413 over 25 MB) and `ETag`/`304`. 404 when it is not in the list or its file is gone, which takes it from the list (not while a chat's folder cannot be reached: the picture stays, and is served again when it is back). The page's own pictures are sent to be kept a day, those in a chat's or another folder to be asked about again |
| `GET …/images/:id/thumb` | The small copy of the picture, at most 480 pixels on its longest side, as WebP (which keeps transparency). It is made when it is asked for and there is none for the file as it is (the same file by its size and time), and kept; a file that is written over gets a new one. It is made for whoever may read the picture's file in full, like `/file`, and for nobody else (404 as there). A file of 48 KB or less, a GIF, an animated picture and one that cannot be decoded are sent as they are, as `/file` sends them. At most two copies are made at once. The page's own pictures are sent to be kept a day, the others to be asked about again |
| `POST …/images/generate` | `{ prompt, size?, model?, outputFormat?, outputCompression?, count?, negativePrompt?, seed?, sampleSteps? }` — makes `count` pictures (1–4, one if left out), one request and one job for each (each takes the next seed from `seed`, a random `-1` stays random), and answers `202 { jobs }` at once. A setting that is left out, `null` or empty is not sent. `size` is `WIDTHxHEIGHT` (each side 64–8192) or `auto`, `outputFormat` is `png`, `jpeg` or `webp`, and `outputCompression` (0–100) needs `jpeg` or `webp`. These, with `model` and the prompt, are the only fields of the request to the endpoint, which is the OpenAI image format. `negativePrompt` (up to 4000 characters), `seed` (−1 or more) and `sampleSteps` (1–100) are not in that format: they are sent only inside the prompt, as a `<sd_cpp_extra_args>` JSON block that stable-diffusion.cpp's server reads (`negative_prompt`, `seed`, and `sample_params.sample_steps`), and only while the **Stable Diffusion extra settings** switch is on (`sdExtras`); with it off, a request that has one is refused with 409 and nothing is sent. The block is refused too (400) when the prompt has a block of its own. `extra` is no longer taken (400). 400 for a bad request, 409 while image generation is off or has no address, 429 when `count` would go over the four that run at once |
| `POST …/images/edit` | `{ prompt, sources: [id…], mask?, model?, size?, outputFormat?, outputCompression?, count?, negativePrompt?, seed?, sampleSteps?, strength?, fromNoise? }` — changes the pictures, as `edit_image` does (the first is the one the result is named after; more than one only where editing is set to take several), and answers `202 { jobs }`, one for each of `count` (1–4) changes. The settings are as for generation, `model` taking the place of the editing model, and a `size` being sent only when given. `strength` (0–1) and `fromNoise` are for an edit and, like the other non-OpenAI settings, go in the `<sd_cpp_extra_args>` block and only with `sdExtras` on (409 otherwise): `strength` as `strength`, and `fromNoise: true` as `"init_image": null`, which starts from noise with the pictures as references (all of them are still sent as `image[]`); a `strength` or a `mask` with `fromNoise` is refused (400). `mask` is a PNG, as base64 or a `data:` URL, up to 25 MB, checked as a picture. The pictures are read and checked, with the tool's rules and limits, before anything is sent: 400 with the reason, 409 while editing is off, 429 when four are being made. The only route that takes a body this large |
| `POST …/images/upload?name=` | The raw bytes of a picture as the body, up to 25 MB; kept only if they are a PNG, JPEG, GIF or WebP, as a picture of kind `uploaded` listed under `name`. Answers `201 { picture }`; 400 for anything else |
| `GET …/images/jobs` | `{ jobs, limit }`, newest first: `{ id, kind: "generate" \| "edit", state: "running" \| "done" \| "failed", prompt, size?, from?, startedAt, finishedAt?, pictureId?, notes?, error? }`. A done job has the `pictureId` of the picture in the gallery, and `notes` (strings) saying what was scaled down or compressed to fit what an edit takes, when something was; a failed one says why, never with a key or a path. Finished jobs are kept an hour, up to 30; jobs are in memory and a restart ends the ones that run |
| `DELETE …/images/jobs/:id` | Stops a job that runs (its request is dropped, and no picture comes of it) or forgets one that has finished. 404 for none |
| `DELETE …/images/:id` | Takes the picture away, file and all, from the page's own folder, a chat's or the folder it was found in; a file that is gone already counts as deleted, but a chat's folder that cannot be reached is an error (404) and the picture stays in the list |
| `POST …/images/delete` | `{ ids }` (at most 200) — the same for several: `{ deleted, failed: [{ id, error }] }`, each as asked and what could not be said for each |

### Videos

The videos of the [Media page](/guide/media): videos made with the video endpoint without a chat, and the gallery of those,
the ones the agent made in chats and the ones that lie in the folders its tool writes into. It is the [Images](#images) API's
counterpart and has the same rules: a video is named by its **id**, twelve lowercase hex digits, never by a path; Media opens
files only in the folder of the page's own videos (`videos` in its own folder of the data folder) and in `generated-videos` of the agents' homes, of the
projects and of the folders chats work in, with the checks a picture of a chat's folder has (a path inside the folder, no link followed
out of it, and what the bytes say it is — here a WebM or an MP4). Reading the list from the top also looks in those folders for videos
nobody recorded, and lists each plain file there whose bytes show a WebM or an MP4 of at most 100 MB, as a video of `origin` `folder`.
The endpoint's address, key and model are the settings' (see [above](#media)).

| | |
| --- | --- |
| `GET /api/x/pithagoras-media/videos?origin=&kind=&before=&limit=&again=` | A page of the gallery, newest first: `{ videos, next, total, pageBytes }`, where `pageBytes` is what all the page's own videos take of the disk, whatever the filters match. `origin` is `page`, `chat` or `folder`, `kind` is `generated`, `animated` (made from a picture as its first frame or its last) or `unknown`, `limit` is 1–100 (24 if left out), `before` is the `next` of the page before. A video is `{ id, origin, chat: { id, title } \| null, folder: { name, home } \| null, kind, prompt, params, createdAt, bytes, fileName, poster, format, copy? }`; `format` is `{ id, label, mimeType, playable }`, what the file is by its first bytes (`id` is `webm`, `mp4`, `mov`, `avi`, `webp`, `gif`, `mkv`, `ogg` or `bin` for a file of no known kind), and only a WebM and an MP4 are `playable`; `copy` is `"ready"` or `"available"` for a clip that is not playable, where a playable copy is made or ffmpeg is there to make one; `params` is what it was asked for with, as far as that is known (`model`, `size`, `frames`, `fps`, `seed`, `sampleSteps`, `strength`, `negativePrompt`, and `madeFrames` and `madeFps`, which the server said it made, and `firstFrame` and `lastFrame`, each `{ picture?, path? }`). `poster` is whether the portal can make a poster picture of it (there is an `ffmpeg`). Reading from the top (no `before`) first drops what is gone and finds what nobody listed; `again=1` is for a page that asks again for a list it has, and does not look through the files within a minute of the last look. 400 for a filter that is none |
| `GET …/videos?ids=a,b` | Those videos alone, in the order given, as far as they are in the list: `{ videos }`. At most 200 |
| `GET …/videos/:id/file` | The file, with its type from its bytes (413 over 100 MB). A WebM and an MP4 are sent to be played; **any other file is sent as an attachment** (`Content-Disposition: attachment`), as the type its bytes say or `application/octet-stream`, and never shown. In the parts a player asks for (see `GET /api/sessions/:id/video`), and `ETag`/`304`. 404 when it is not in the list or its file is gone, which takes it from the list (not while a chat's folder cannot be reached: the video stays, and is served again when it is back) |
| `GET …/videos/:id/poster` | The poster picture of the video, its first frame at most 480 pixels on its longest side, as WebP. It is made by `ffmpeg` (on the `PATH`, or `FFMPEG_PATH`) when it is asked for and there is none for the file as it is, and kept; a file that is written over gets a new one. The clip is given to ffmpeg on its standard input, which may open no other file. **404** where there is no ffmpeg, or it cannot make a frame of this video: the page then shows the video's own first frame |
| `GET …/videos/:id/copy` | The playable WebM copy of a clip that is not playable, where one was made; **404** otherwise |
| `POST …/videos/:id/copy` | Makes that copy with `ffmpeg` (the clip goes to its standard input, which may open nothing else) and answers `{ ok: true }` when it is made, which takes a while for a long clip; kept in `video-copies`, and made once for a file as it is. **400** for a clip that plays as it is, **409** without ffmpeg, **502** when it could not make one; the original is kept in every case |
| `POST …/videos/generate` | `{ prompt, model?, size?, frames?, fps?, seed?, sampleSteps?, strength?, negativePrompt?, firstFrame?, lastFrame?, count? }` — makes `count` videos (1–4, one if left out), one request and one job for each (each takes the next seed from `seed`, a random `-1` stays random), and answers `202 { jobs }` at once. `strength` is a number from 0 to 1, sent as `strength` only when given. `firstFrame` is the id of a picture of the [Images](#images) gallery, sent as the first frame, and `lastFrame` the id of one sent as the last frame (`end_image`), only to a server whose capabilities list `end_image` for video: for any other the job fails, with the reason in its `error`, and the picture is never dropped. 400 for a prompt that is empty or over 4000 characters, a setting out of its range, or a first or last frame that is not a picture of the gallery; 409 when video generation is off or has no address, or when the page's own videos take the disk limit; 429 when four are being made already, or fewer are free than asked for |
| `GET …/videos/jobs` | `{ jobs, limit }`, newest first: `{ id, kind: "generate" \| "animate", state: "running" \| "done" \| "failed", stage?: "waiting" \| "making", queuePosition?, prompt, size?, from?, startedAt, finishedAt?, videoId?, error? }`. A running job says whether it waits its turn on the server or is being made, and which place it has in the server's queue when the server says; a done job has the `videoId` of the video in the gallery; a failed one says why in the server's words, with no key in them. Jobs live in memory: a restart ends them, and finished ones are forgotten after an hour, or past thirty |
| `DELETE …/videos/jobs/:id` | Stops a job that runs (the portal stops waiting and tells the server to drop it, which only a job still in the queue can be, and no video comes of it) or forgets one that has finished. 404 for none |
| `DELETE …/videos/:id` | Takes the video away, file and all, from the page's own folder, a chat's or the folder it was found in; a file that is gone already counts as deleted, but a chat's folder that cannot be reached is an error (404) and the video stays in the list |
| `POST …/videos/delete` | `{ ids }` (at most 200) — the same for several: `{ deleted, failed: [{ id, error }] }`, each as asked and what could not be said for each |

## Kanban

The [Kanban](/guide/kanban) extension's routes (`extensions/kanban`), while it is
installed. A board is `{ id, name, description, version, created, updated, columns, cards }`: `columns` left to right,
each `{ id, name }`, and `cards` in their order, each `{ id, title, description, labels, assignee, due, column, archived,
created, updated, activity }`, a column's cards being those with its id, top first. `version` changes with every write. A
change answers with the board as it is after it, and is put down in a card's activity as the person's. A refusal is 400
(`code: "invalid"`), 404 (`missing`) or 409 (`conflict`), with `error` saying why.

| | |
| --- | --- |
| `GET /api/x/pithagoras-kanban/boards?have=` | `{ version, boards }`, each board `{ id, name, description, version, updated, columns: [{ id, name, cards }], archived }` with the number of cards in each column and archived. With `have`, the list's `version` the caller has: `{ version, unchanged: true }` while it is that |
| `POST …/boards` | `{ name, description?, columns? }` — a new board, with the columns named or To do, In progress and Done. 409 for a name another board has, capitals aside |
| `GET …/boards/:board?have=` | The board; with `have`, the version the caller has, `{ version, unchanged: true }` while it is that |
| `PATCH …/boards/:board` · `DELETE` | `{ name?, description? }`; delete it, with its cards: `{ deleted }` |
| `POST …/boards/:board/columns` | `{ name, index? }` — a column, at the end or at `index` |
| `PATCH …/columns/:column` · `POST …/columns/:column/move` · `DELETE …/columns/:column?to=` | `{ name }`; `{ index }`; take it away: one with cards, archived ones included, only with `to`, the column they go to (409 otherwise) |
| `POST …/boards/:board/cards` | `{ title, column?, index?, description?, labels?, assignee?, due? }` — a card, at the bottom of `column` (the first column without one) or at `index` among its cards that are not archived. `due` is `YYYY-MM-DD` |
| `PATCH …/cards/:card` · `DELETE` | Any of `title`, `description`, `labels`, `assignee`, `due` (`null` or `""` for none); delete it |
| `POST …/cards/:card/move` | `{ column, index? }` |
| `POST …/cards/:card/archive` · `…/restore` · `…/notes` | Archive it; restore it to the bottom of its column; `{ text }`, a note in its activity |
| `GET …/chats/:chat/board` | `{ board }`: the id of the board the chat's agent last worked on with a kanban tool, or `null` |

## Creator mode

The [Creator mode](/guide/creator-mode) extension's routes (`extensions/creator`), while it is installed, under
`/api/x/pithagoras-creator`: what agents made in Creator mode chats. The mode itself is chosen with
`PUT /api/sessions/:id/modes` ([Chat modes](#chat-modes)), as `pithagoras-creator/creator` with `confirmed: true`. A
refusal is `{ error }` with the status given.

| | |
| --- | --- |
| `GET /api/x/pithagoras-creator/made` | `{ made }`, the one installed last first, each `{ name, version?, digest, at, chat, draft, installed, enabled? }`: the copy's sha256, when it was last installed, the chat it was made in now (`{ id, title }`, or `null` for one that was deleted), its folder in that chat's folder, whether its copy in Creator's folder is installed now, and, where it is, whether it is switched on |
| `DELETE …/made/:name` | Forgets one that is not installed: its copy and its entry go. `{ forgotten: name }`; **404** for a name Creator made nothing of, **409** while it is installed (remove it with `DELETE /api/packages` first). It waits for an install of that name that is running |

## Channels

| | |
| --- | --- |
| `GET /api/channels` | `{ channels, kinds, broken, agentHome, channelsDir }` |
| `POST /api/channels` | `{ kind, name, config, agentId? }` — it talks as the first agent unless given another |
| `PATCH /api/channels/:id` | `{ name?, slug?, enabled?, config?, instructions?, agentId? }` — `agentId` is the agent it talks as |
| `DELETE /api/channels/:id` | Keeps its conversations; `?sessions=delete` discards them too |
| `POST /api/channel-packages` | `{ spec }` — install a channel package |
| `DELETE /api/channel-packages/:name` | Uninstall; refuses builtins |

A channel's `slug` is what agent sessions are keyed on, and it survives the
channel being deleted and recreated. Creating a channel with an explicit `slug`
reconnects it to the conversations that slug already had.

Secrets are never returned. A channel carries `secretsSet` listing which secret
fields have a value, and sending a blank secret keeps the stored one.

`broken` lists packages that failed to load, with the reason.

## Agents

Each agent has a home folder of its own, with its own `SOUL.md`,
`PrimaryUser.md` and `MEMORY.md`. The first agent (`home`) is the one at
`AGENT_HOME`; the others are made in `agents/` beside it.

| Route | Purpose |
| --- | --- |
| `GET /api/agents` | `{ agents }`, each `{ id, name, home, first, newChats, initialised, chats, channels, orb, voice, heartbeat, unread }` |
| `POST /api/agents` | `{ name, setup? }` — a new agent and its folder; `setup` takes the wizard's answers. A folder kept from a deleted agent of the same name is taken up again, and the files in it are not rewritten: `kept` in the answer names the agent's own files (`SOUL.md`, `PrimaryUser.md`, `MEMORY.md`) that the folder already had, with `setup` or without it, and the wizard's answers did not replace them. |
| `PATCH /api/agents/:id` | `{ name }` — its folder stays where it is, and records the new name in `.agent-name`, which is what makes an agent of that name take the folder up again once this one is deleted with it kept |
| `DELETE /api/agents/:id` | Deletes it and its chats, and its folder with `?folder=delete`. Refused for the first agent, for one a channel talks as, and while one of its chats or routines is working. The jobs running in its folder are stopped (`jobsStopped`), whichever way the folder goes. Its routines are switched off (`routinesSwitchedOff`), or with `?folder=delete` deleted (`routinesDeleted`); their runs are kept either way. |
| `GET /api/agents/:id/setup` | Setup status and its editable files, each `{ name, exists, content, mtime }`. `memory` is `file`, or `extension` while something holds the agent's memory and its MEMORY.md is not read, with `by` naming it (`null` while nothing does) |
| `POST /api/agents/:id/setup` | Writes the identity files that are not there from the wizard's answers; the others are left, and `kept` names them |
| `PUT /api/agents/:id/files/:name` | `{ content, mtime? }` — saves one of its files whole. With `mtime` (0 for a file that was not there), a file that has changed since is not overwritten: 409. A link is refused. |
| `PUT /api/agents/:id/new-chats` | `{ on }` (boolean, else 400) — whether the **New** button starts chats with it. Turning it off hands New back to the first agent; off for an agent that is not the pick changes nothing. Answers the agent |
| `PUT /api/agents/:id/orb` | Saves its avatar, `avatar` included (`"orb"`, or `<package>/<id>` of an extension's); answers the style as stored |
| `PUT /api/agents/:id/heartbeat` | `{ minutes, quietStart, quietEnd }` — how often it looks around on its own (0 never, else 15 minutes to a week) and the hours it keeps quiet (`"HH:MM"`, both or neither) |
| `POST /api/agents/:id/heartbeat/run` | A look now. Answers at once; `heartbeat.running` and `heartbeat.status` follow it |
| `GET /api/agents/:id/activity` | `{ notes, unread }` — what it noticed on its own, newest first |
| `POST /api/agents/:id/activity/read` | Marks its notes read |
| `POST /api/agents/:id/activity/:note/read` | Marks one note read; answers `{ unread }`, 404 for an unknown note |
| `DELETE /api/agents/:id/activity/:note` | Deletes a note |
| `PUT /api/agents/:id/voice` | `{ voice }` — the voice it speaks with in voice mode: an id from the voices voice mode's source offers now (`voices` of `GET /api/voice`), or `""` for the source's own choice. `400` `Choose one of the voices voice mode's source offers now, or none` for any other id, and for any id while there is no source or it is not running |
| `GET /api/agent/orb?session=` | The avatar voice mode shows for that chat: its agent's, or the first agent's |
| `GET /api/agent/avatar?session=` | `{ agent: { id, name }, orb }`: the agent that chat is with and its avatar, which voice mode shows |
| `POST /api/agent/sessions` | `{ agent?, title? }` — a conversation with that agent, the first without one |
| `GET /api/agent/setup`, `POST /api/agent/setup`, `PUT /api/agent/files/:name` | The same for the first agent, answered by the same handlers: the 409 for a file that changed, and `kept` |

## People and audit

| Route | Purpose |
| --- | --- |
| `GET /api/people` | List known people and roles. |
| `PATCH /api/people/:key` | Update name, role or notes. Moving the last primary user to another role is refused with 409 and `code: "last-primary"`; `force: true` in the body does it anyway. |
| `DELETE /api/people/:key` | Forget a person. The last primary user is refused the same way, unless the query has `?force=1`. |
| `GET /api/audit?limit=2000` | Read up to all 2,000 retained decisions (default 200), newest first. |
| `DELETE /api/audit?through=<id>` | Clear the log: every decision up to and including `through` (the newest one the caller saw, so a decision recorded since survives), or every decision without it. Earlier `cleared` entries stay. A `through` that is not an entry id is refused with 400. Answers `{ removed }`, and a clear that removed something leaves one `cleared` entry saying how many. |
| `GET /api/tool-rules` | List standing tool permissions. |
| `POST /api/tool-rules` | Add a role/tool/pattern rule. The role is `colleague`, `guest`, `heartbeat` (an agent looking around on its own) or `all`. A rule for `subagent`, `routine_create`, `routine_update` or `routine_run` is refused (400) for every role but `heartbeat`: they would run what the person writes with the primary user's rights. |
| `DELETE /api/tool-rules/:id` | Remove a rule. |

## Guard

| Route | Purpose |
| --- | --- |
| `GET /api/guard` | What Settings → Guard shows, with `allowlist`: the sites the agent's tools may reach, one domain per line, `*.example.com` for its subdomains. Empty means any site. |
| `PUT /api/guard/allowlist` | `{ domains }` — that list, as text. Answers `{ allowlist }` as it is kept; 400 when `domains` is not text. |

## MCP servers

| Route | Purpose |
| --- | --- |
| `GET /api/mcp` | Read configured servers and settings. |
| `PUT /api/mcp/servers/:name` | Add or update a server. `{ entry, from? }`: with `from` it is a rename. A name that another server has is refused with 409 and `code: "exists"`. |
| `PUT /api/mcp/servers/:name/direct` | `{ direct }` — the server's "Register tools directly" (`directTools`) on its own, nothing else of the entry changed. `true` registers the tools one by one; `false` leaves them to the adapter's `mcp` tool, which the tool lists call lazy. 404 for a server that is not there, 400 for a `direct` that is not a boolean. Read when a chat starts |
| `DELETE /api/mcp/servers/:name` | Remove a server. |
| `PUT /api/mcp/settings` | Update MCP settings. |
| `POST /api/mcp/import` | `{ text }` — import pasted server configuration. A server whose name is taken is not replaced: it is listed in `skipped` with the reason, beside those it could not use. |
| `PUT /api/mcp/raw` | Save the raw configuration after JSON validation. |

## Skills

| Route | Purpose |
| --- | --- |
| `GET /api/skills` | List skills, diagnostics and editable content. |
| `POST /api/skills` | Create a skill with name, description and body. |
| `PUT /api/skills/:name` | Save a skill's content. |
| `DELETE /api/skills/:name` | Delete an editable skill. |
| `POST /api/skills/:name/enabled` | Enable or disable a skill. |
| `POST /api/skills/preview-import` | Preview a repository import: the skills found, those that cannot be imported and why, and the commit looked at (`sha`). |
| `POST /api/skills/import` | Import selected skills. `sha` (optional) is the commit the preview saw, which is then what is installed; the answer lists `imported` and `skipped`. |
| `POST /api/skills/:name/update` | Refresh an imported skill. A skill that was not imported answers 400, and one that is not in its repository any more 404; when nothing was updated the answer is `{ error, imported, skipped }`, `skipped` saying why. |

## Routines

| Route | Purpose |
| --- | --- |
| `GET /api/routines` | List routines and defaults. |
| `POST /api/routines` | Create a recurring or one-off routine. Its slug is its name's, or the next free one: not one whose runs are still kept after a routine was deleted, so that it does not continue that conversation. An explicit `slug` is taken as it is, and reconnects the routine to the runs that slug had. |
| `PATCH /api/routines/:id` | Update a routine. |
| `DELETE /api/routines/:id` | Delete a routine. |
| `POST /api/routines/:id/run` | Start a run now; it answers when the run ends. A routine deleted while it ran is answered 404. |
| `POST /api/routines/preview` | The next three runs of a schedule, without saving it: `{ expression, runs }`. |
| `GET /api/routines/:id/sessions` | List the routine's runs. |
| `GET /api/routines/report-targets` | List available report destinations. |
| `PUT /api/routines/report-default` | Set the default report destination. |

Recurring routines resume at their next future slot after a restart. Overdue one-off routines catch up.
