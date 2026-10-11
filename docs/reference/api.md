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
| `GET /api/auth/status` | `{ authRequired, authed, shortPassword? }`. `shortPassword: true` is sent only to a signed-in caller, and only when the portal runs on a password shorter than 8 characters that it kept from before the minimum |
| `POST /api/auth/login` | `{ password }` → sets the cookie |
| `POST /api/auth/logout` | clears the cookie, and refuses the login it held from then on |

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
| `GET /api/sessions` | `{ sessions, executor }` — pinned first, then most recent. The chats, and the conversations started on an agent's page; not those that came through a channel, nor routine runs. |
| `GET /api/agent/sessions` | `{ sessions, agentHome }` — one agent's conversations (`?agent=`, the first agent without it): every chat in its home, each with the channel that owns it or `null` for a chat started in the portal |
| `POST /api/sessions` | `{ workspace?, agent?, title? }` — `agent` starts it in that agent's home; neither means Home, the first agent's; no title means "New chat", replaced by the first message |
| `GET /api/sessions/:id` | One session |
| `PATCH /api/sessions/:id` | `{ title?, pinned? }` — a title is cut to 120 characters |
| `DELETE /api/sessions/:id` | Stops it if running, then deletes it, its events and pi's conversation file for it (in `SESSION_DIR`). The folder it worked in is left alone. |

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

## Files

The files in the folder a session works in, whether that is a project, the
workspace root or Home. Every path is relative to that folder; one that leads
out of it, by `..` or by a link, is refused with 400.

| | |
| --- | --- |
| `GET /api/sessions/:id/files?path=` | `{ path, entries: [{ name, type, link?, size, mtime }], truncated }` — `type` is `dir`, `file` or `link` (a link that leads out of the folder or nowhere); `link: true` marks every link, including one to a folder inside this one that is listed as a `dir`. Folders first; `.git` is left out; at most 2,000 entries |
| `GET /api/sessions/:id/file?path=` | `{ binary: false, size, mtime, content }`, or `{ binary: true, size, mtime }` for what is not text or is over 1 MB |
| `GET /api/sessions/:id/file?path=&download=1` | The file, as a download |
| `GET /api/sessions/:id/picture?path=` | A PNG, JPEG, GIF or WebP in the folder, to be drawn in the page, with the type its first bytes say it is and a `sandbox` content security policy. 400 for anything that is not one of those four, whatever its name; 413 over 25 MB. The Files panel, canvases and `show_image` use it |
| `PUT /api/sessions/:id/file?path=` | `{ content, mtime? }` → saves it. With `mtime`, the time it was read at, the save is refused with 409 and `code: "conflict"` if the file has changed since. 413 over 1 MB. Every refusal of the file routes answers `{ error, code }` with `code` one of `invalid`, `missing`, `conflict`, `exists`, `too_large`, `failed` and `unsaved-work` |
| `PUT /api/sessions/:id/file?path=` with `create: true` | `{ content, create: true }` → makes the file, and refuses with 409 if something already has the name |
| `POST /api/sessions/:id/folder?path=` | `{ name }` → makes a folder in the folder at `path`, answers `{ path }`. 409 if the name is taken |
| `POST /api/sessions/:id/upload?path=&name=` | The file as the request body, sent as `application/octet-stream` → put in the folder at `path` as `name`, or `name (2)` and so on if that is taken; answers `{ path, size }`. Streamed to disk and put in place only once complete. 413 over 2 GB |
| `PATCH /api/sessions/:id/file?path=` | `{ name }` → gives a file or folder another name in the same folder, and answers `{ path }`. 400 for a name with a `/` or `\`, or `.` or `..`; 409 if the name is taken. A link is renamed as the link |
| `DELETE /api/sessions/:id/file?path=` | Removes a file, or a folder and all in it; a link is removed as the link. The folder itself is refused. A folder holding git work that exists nowhere else — uncommitted changes, commits no remote has, stashes — is refused with 409 and `code: "unsaved-work"` unless `discard=1` says it may go |
| `GET /api/sessions/:id/unsaved?path=` | `{ unsaved }` — what deleting `path` would lose that nothing else has: `{ changed, unpushed, stashes, unknown? }`, or `null` for nothing. `unknown` means not everything could be read |
| `GET /api/sessions/:id/archive?path=` | The folder — or, with `path`, a folder in it — as a `.tar.gz`, without `node_modules`, `.git`, `dist`, `build` and virtual environments. If `tar` cannot run the answer is a 500; if it fails part-way the download is cut off, so it does not end as if it were whole. A file that changes while it is read is not a failure |

## Prompting

| | |
| --- | --- |
| `POST /api/sessions/:id/prompt` | `{ message, images?, voice?, steer? }` — `images` is up to eight `{ data }`, each base64 or a `data:` URL of a PNG, JPEG, GIF or WebP under 5 MB. The type is read from the bytes. `message` may be empty when there are pictures. Sent while a run is going, a message waits for the run to end; with `steer: true` it goes into that run instead, after the tools running now |
| `GET /api/sessions/:id/images/:name` | A picture sent with a message; `portal_prompt` events name them in `payload.images` |
| `POST /api/sessions/:id/abort` | Stop the current run |
| `POST /api/sessions/:id/ui-response` | `{ id, value?, cancelled? }` — answer an extension dialog |
| `GET /api/tools` | `{ tools, off }` — every tool the portal has seen, and which are off by default. With `EXECUTOR=container` this and the other tool routes answer 400 with `code: "tools-unsupported"` |
| `PUT /api/tools` | `{ off: string[] }` — the default for every conversation; applied to the running ones too. A [project](#projects) can bend it with `PUT /api/projects/:name/tools`, and a conversation then holds its exceptions against that |
| `GET /api/sessions/:id/tools` | `{ tools, live, off }` — every tool the conversation could use and whether it is on. `live` is false when pi is not running to be asked |
| `PUT /api/sessions/:id/tools` | `{ off: string[] }` — switch tools off by name; everything not named is on |
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
| `POST /api/sessions/:id/messages/:seq/version` | `{ to }` — shows another version of the message, and what followed it then |
| `PUT /api/sessions/:id/draft` | `{ text, caret?: { start, end } }` — what is in the chat box, which an extension can ask for. Starts nothing |
| `GET /api/sessions/:id/stats` | Context usage and token counts, without the model catalogue |

## Git

The Git panel's routes, all for the folder of session `:id`. Each is refused when
the folder is not a repository, except `init`. See [Git](/guide/git).

| | |
| --- | --- |
| `GET /api/sessions/:id/git` | Branch, upstream, ahead/behind, changed files, an operation in progress. Reads the disk only |
| `GET /api/sessions/:id/git/gh` | Whether pull requests can be had through `gh`, and for which GitHub repository. `?fresh=1` asks again |
| `POST /api/sessions/:id/git/init` | Make the folder a repository |
| `GET /api/sessions/:id/git/diff?of=` | A diff: `of` is `unstaged`, `staged`, `untracked` (with `path`), `commit` (`sha`), `range` (`base`) or `stash` (`stash`) |
| `POST …/git/stage` · `/unstage` · `/discard` | `{ paths }` or `{ all: true }` (not for `discard`) |
| `POST …/git/commit` | `{ message, amend? }` |
| `POST …/git/abort` · `/continue` | Abort or continue a paused merge or rebase |
| `GET …/git/log` · `GET …/git/commits/:sha` | History, in pages; one commit with its files |
| `GET …/git/branches` · `POST …/git/branches` · `POST …/git/branches/delete` | List, `{ name, from? }`, `{ name, force? }` |
| `POST …/git/switch` | `{ name, remote? }` |
| `POST …/git/fetch` · `/pull` · `/push` | Each answers `{ said }`; pull is fast-forward only |
| `GET …/git/stashes` · `POST …/git/stashes` | List; `{ message? }` stashes the changes. `POST …/git/stashes/apply` · `/pop` · `/drop` with `{ ref, sha? }` act on one |
| `GET …/git/compare?base=` | The branch against its base |
| `GET …/git/pulls?state=` · `…/pulls/current` · `…/pulls/:n` · `…/pulls/:n/diff` | Pull requests, through `gh` |
| `POST …/git/pulls` | `{ title, body, base?, draft? }` |
| `POST …/git/pulls/:n/checkout` · `/merge` · `/comment` · `/review` | `merge`: `{ method, deleteBranch? }`; `comment`: `{ body }`; `review`: `{ action, body }` |

## Terminal, background jobs and subagents

| | |
| --- | --- |
| `POST /api/terminal` | `{ sessionId? }` → opens a shell in that session's folder (home otherwise); answers `{ id, cwd }` |
| `GET /api/terminal/:id/stream` | Server-sent events: its output |
| `POST /api/terminal/:id/input` · `/resize` | Keystrokes; the size of the panel |
| `DELETE /api/terminal/:id` | Ends the shell |
| `GET /api/sessions/:id/background` | `{ supported, jobs, …extension status, piRunning }` — background jobs are listed on the host executor on Linux only |
| `GET /api/sessions/:id/background/:key/output` | A job's output; 404 when it is not in a file the portal can follow |
| `POST /api/sessions/:id/background/:key/stop` · `/background/clear` | Stop one; clear the finished ones |
| `POST /api/sessions/:id/subagents/:agent/input` | `{ text }` — say something to a running subagent. 409 when it cannot be reached |
| `POST /api/sessions/:id/subagents/:agent/stop` | Stop it |

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
| `GET /api/features/flags` | Only which opt-in features are on — for the sidebar and menus: `{ subagent: { enabled }, understory: { enabled }, images: { enabled } }`, where `images.enabled` is that image generation, or editing, is on and has an address, which is when the Images page is offered |

See [Models and providers](/guide/models).

## Browser add-on

| | |
| --- | --- |
| `GET /api/browser` | State, connection and settings |
| `POST /api/browser/install` · `/start` · `/stop` | Lifecycle of the managed container. A second install while one is running is refused with 409. Installing wires the agent to the browser and removing unwires it |
| `DELETE /api/browser/install` | Remove it; `?profile=forget` drops the logins too |
| `POST /api/browser/connect` · `DELETE /api/browser/connect` | Give the agent the browser's tools, or take them away |
| `PUT /api/browser/config` · `GET /api/browser/suggest-password` | The login of the browser view; a suggestion |
| `PUT /api/browser/allowlist` | Domains it may be pointed at; empty means no restriction |
| `PUT /api/sessions/:id/browser` | Whether this chat may use it |

See [The agent's browser](/guide/browser).

## Voice

| | |
| --- | --- |
| `GET /api/voice` · `PUT /api/voice` | The voice settings, including the speaking instructions in use and the built-in ones to go back to. `runtime` may be `kokoro`, which speaks with `kokoroVoice` (one of Kokoro's voice ids, `af_heart` by default) at `speed` (`0.85`, `1` or `1.15`), or `none` (no speech synthesis, with no speech URL), and `speech` is then `false`: the page offers dictation and not voice mode, and `…/voice/speech` answers 409 |
| `GET /api/voice/install` · `POST /api/voice/install` · `/start` · `/stop` | The managed voice container and its readiness, with the `choice` it was built for, and `connected`: whether the saved settings point at the managed service, with or without its container. `POST /api/voice/install` takes `{ tts, ttsDevice?, asr, asrModel, asrDevice? }` — `tts` is `breeze`, `chatterbox`, `kokoro` or `none` (speech recognition only, which needs no GPU); `ttsDevice` is `cpu` or `gpu` (the default), where `cpu` is for Kokoro alone and puts recognition on the CPU too; `asr` and `asrModel` are `whisper` with `base` or `small`, or `qwen3-asr` with `0.6b` or `1.7b`; `asrDevice` is `cpu` or `gpu`, where `gpu` is the default for Qwen3-ASR beside a speech engine on the GPU, and Whisper, recognition-only and recognition beside Kokoro on the CPU are always `cpu` — and builds for it, recreating an installed container that has other engines. Without a body it keeps the installed engines, or picks the combination that fits the GPU; where there is none, Kokoro on the CPU with the recognition that fits beside it, or recognition alone where the host has too little memory or too few threads for Kokoro. A choice the GPU or the host's memory cannot hold at all, and anything on the GPU on a host without one, is refused after the check, in the status `error`; `400` for a combination that does not exist |
| `GET /api/voice/hardware` | The GPUs the voice container can use (`gpus`, each with `index`, `uuid`, `name`, `totalMiB`, `freeMiB`; `source` says how they were read), the one it would take (`selected`, an index), the one chosen with `PUT /api/voice/gpu` (`chosen`, a UUID, empty where none is or the one chosen is no longer there), the memory kept free (`reserveMiB`), the combination that fits (`suggestion`), what recognition on the CPU has to run on (`host`: `totalMiB`, `freeMiB`, `threads`), whether the check could tell (`checked`) and whether it found there is no GPU (`cpuOnly`, with Kokoro on the CPU as the suggestion, or recognition alone where the host is too small for it). No GPU and no tool is `gpus: []`, not an error |
| `POST /api/voice/connect` | Use the managed services in the settings. What it replaces (`runtime`, `whisperUrl`, `breezeUrl`, `sttModel` and whether voice was `enabled`) is remembered, unless it is the managed service's already, for `POST /api/voice/uninstall`; the install does the same when it connects |
| `POST /api/voice/uninstall` | Remove the managed voice container and put the settings back. Takes `{ removeData? }`: `true` deletes the volume with the downloaded engines and models as well, `false` (the default) keeps it; `400` for anything else. Stops a running container, then removes it; answers `{ ok: true }`, also where there is no container (a volume that is not there is no error either). The settings are put back to what the connect remembered, for what points at the managed service only; where nothing was remembered, that is reset to the defaults of a portal with nothing set up, with voice off. Addresses that are not the managed service's are never changed. Where the container is removed and the volume cannot be (`removeData: true`; Docker refuses it, say), the settings are put back all the same and the answer is `409` with what Docker said. `400` with `Docker is unavailable` without Docker, as for an install, with `Wait for voice setup to finish before uninstalling` while a setup is under way, and for a container named `pithagoras-voice` that the portal did not make |
| `PUT /api/voice/gpu` | Choose the GPU the managed voice runs on: `{ gpu: uuid }` (a UUID from `GET /api/voice/hardware`), or `""` to leave it to `VOICE_GPU`, else to the card with the most free memory when engines are installed or rebuilt (a restart keeps the card the service is on). `400` for a UUID that no GPU has, and for a GPU that cannot hold the engines installed (the error says what would fit); nothing is saved or stopped then. A running service is recreated on a new choice at once, any other on its next start; `409` says the choice is saved but the restart could not begin |
| `GET/POST /api/voice/presets` · `GET …/presets/:id/audio` · `PATCH …/presets/:id` · `DELETE …/presets/:id` | Saved voices. `PATCH` takes `{ instruction }`, the voice description (1–1000 characters), and returns the voice; 404 for an unknown voice |
| `POST /api/sessions/:id/voice/connection` | Take or give back a lease on the voice services |
| `POST /api/sessions/:id/voice/transcribe` | `audio/wav` body (12 MB at most) → `{ text }` |
| `POST /api/sessions/:id/voice/speech` | Text → audio |

The session routes answer 409 until Voice is enabled in Settings → Add-ons. See [Voice control](/guide/voice).

## Canvases

| | |
| --- | --- |
| `GET /api/sessions/:id/canvases` · `POST` | List; `{ title }` creates one |
| `PUT /api/sessions/:id/canvases/:cid` | `{ revision, title, content }` — 409 when `revision` is stale |
| `POST /api/sessions/:id/canvases/:cid/persist` | Store a temporary canvas |
| `POST /api/sessions/:id/canvases/:cid/restore` | `{ revision }` — put back the text from before a write that was cut off (`restorable` in the canvas). 409 when `revision` is stale, a write is going on, or there is no earlier text |
| `DELETE /api/sessions/:id/canvases/:cid` | Delete |

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
| `POST /api/packages/update` | Update the installed pi packages (`pi update --extensions`); pi itself comes with the portal's version |
| `GET /api/extensions` | Parsed packages with their recovered settings |
| `PUT /api/extensions/enabled` | `{ spec, enabled }` — switch a package off or on without uninstalling it; reloads idle open sessions and says how many were left waiting |
| `PUT /api/extensions/settings` | `{ key, value }` — empty value removes the key |
| `GET /api/pi-settings` | Raw `settings.json` |
| `PUT /api/pi-settings` | `{ content }` — refused unless it parses as JSON |

## Opt-in features

| | |
| --- | --- |
| `GET /api/features` | `{ subagent: { available, installed, enabled, source, mode, maxParallel }, understory: { enabled, url, tokenSet, adapterInstalled, reachable, managed: { available, image, container, pulling, url, config, providers } }, images: { enabled, baseUrl, model, size, keySet, editEnabled, editBaseUrl, editModel, editMultiple, editMaxSize, timeoutSeconds, sdExtras, editKeySet, ready, editReady } }` — `config` never holds a key, and `images` only whether one is set |
| `GET /api/features/images` | `{ images: { enabled, baseUrl, model, size, keySet, editEnabled, editBaseUrl, editModel, editMultiple, editMaxSize, timeoutSeconds, sdExtras, editKeySet, ready, editReady } }` — the image endpoint alone; no key is ever returned. `ready` is whether pictures can be made: it is switched on and has an address to ask. `editReady` is whether editing is available: it is switched on and has an address to ask, its own or generation's. It is what makes the agent's `edit_image` tool exist. `sdExtras` is whether the endpoint is said to be a stable-diffusion.cpp server, which the Images page may then send the settings only it reads (see below); false when never saved. `editMultiple` is whether the editing endpoint is said to take several pictures: with it, and `editReady`, the tool has a list of pictures (`paths`) instead of one (`path`) |
| `PUT /api/features/images` | `{ enabled?, baseUrl?, model?, size?, apiKey?, editEnabled?, editBaseUrl?, editModel?, editApiKey?, editMultiple?, editMaxSize?, timeoutSeconds?, sdExtras? }` — `baseUrl` is an http(s) base with no login, query or fragment (empty clears it), `size` is `WIDTHxHEIGHT` or `auto` (empty clears it), `apiKey` left out keeps the saved one and `""` removes it; an address of another origin than the saved one, without a key, drops the saved key (a key saved before any address stays for the first). The `edit…` fields are editing's own switch, address, model and key, checked and kept the same way: an empty `editBaseUrl` means the address of generation, `editModel` is the only model sent on an edit (the one of generation never is), and the key of generation goes to the edit address only when it is the same server, while `editApiKey` is the key of the address edits go to and is dropped when that address changes to another server without one. `editMaxSize` is `WIDTHxHEIGHT` (empty, the default, is no limit): the most pixels a picture sent to be edited may have, either way up, checked before anything is sent and read at each call, so it needs no reload. `editMultiple` (a boolean, off by default) says the editing endpoint takes several pictures in one request, up to 8 and 50 MB together, sent as `image[]`; it is said of that endpoint, so an `editBaseUrl` (or, with none of its own, a `baseUrl`) of another origin takes it off again unless the same request says it. `sdExtras` (a boolean, off by default) is about the endpoint as a whole, for generating and editing, so a `baseUrl` or `editBaseUrl` of another origin takes it off again unless the same request says it: on, the Images page may put `negative_prompt`, `seed`, `sample_params.sample_steps` and, for an edit, `strength` and `init_image: null` in a `<sd_cpp_extra_args>` block in the prompt, which only stable-diffusion.cpp servers understand; off, nothing of this kind is sent whatever a request carries, and the agent's tools never send any of it. Read at each request, so it reloads no chat. `timeoutSeconds` is how long a request for a picture, generated or edited, may take, in whole seconds from 30 to 3600 (300 when none was saved; `null` takes a saved one away; anything else is a 400); it is read at each request, so changing it reloads no chat. 400 for anything else, for `enabled: true` with no address, and for `editEnabled: true` with no address, its own or generation's. Answers `{ images, changed, reloaded, waiting }`; idle open sessions are reloaded only when a tool came or went, or the edit tool's shape changed (`changed`: generation's or editing's, or whether the edit tool takes a list) |
| `GET /api/features/subagent` | `{ subagent }` — the subagent tool's state alone |
| `PUT /api/features/subagent` | `{ enabled?, mode?: "interrupt" \| "background", maxParallel?: 1–16, model?: "auto" \| "provider/model" }` — installs or removes the bundled subagent tool, writes `subagentMode`, `subagentMaxParallel` and `subagentModel`; reloads idle open sessions |
| `GET /api/sessions/:id/subagent-model` | `{ model, default }` — what this chat's subagents run on: its own choice (`null` follows `default`) |
| `PUT /api/sessions/:id/subagent-model` | `{ model: null \| "auto" \| "provider/model" }` |
| `PUT /api/features/understory` | `{ enabled, url? }` — writes or removes the `understory` MCP server (installing `pi-mcp-adapter` if needed); reloads idle open sessions |
| `PUT /api/features/understory/config` | `{ llm: { source: "auto" } \| { source: "provider", provider, model } \| { source: "custom", baseUrl, model, format, apiKey? }, dreamInterval, dreamAt }` — `auto` (the default) thinks with the model of the chat asking — `dreamAt` ("03:00") tidies up once a day at that time and wins over `dreamInterval` — the model and tidying up of the portal's own Understory; a running one is made again with them. `apiKey` left out keeps the saved one |
| `POST /api/features/understory/install` | Pull, create and start the portal's own Understory, and make it the agent's memory |
| `POST /api/features/understory/start` · `/stop` | Its container |
| `POST /api/features/understory/dream` | Tidy the memory up now; answers when the pass is done, with what it did |
| `DELETE /api/features/understory/install` | Remove it (the memory stays in its volume; `?memory=forget` deletes it too), and switch it off as the memory |
| `GET /api/memory/tree` | Understory's memory bundle as a tree of folders and notes — read through the portal while Understory is on (409 when it is not) |
| `GET /api/memory/concept?path=` | One note: `{ path, frontmatter, body }`; 404 when it is not there |
| `GET /api/memory/search?q=` | Notes matching, best first |
| `GET /api/memory/log` | What changed, newest first |
| `GET /api/memory/graph` | `{ nodes: [{ path, title, type, links }], edges: [{ source, target }] }` |
| `GET /api/memory/traces` | The paths Understory's own queries and changes took |
| `GET /api/memory/validate` | `{ conformant, conceptCount, directoryCount, issues }` |
| `GET /api/memory/health` | `{ writable, health? }` — whether notes can be changed here (the portal's own Understory, running), and what its checks find: `{ healthy, orphans, brokenLinks, issues }` |
| `PUT /api/memory/concept` | `{ path, frontmatter, body }` — write a note through Understory's own write path (its index and log follow); `frontmatter` needs `type` and `title`. Answers `{ concept, health }`; 409 unless writable |
| `DELETE /api/memory/concept?path=` | Delete a note the same way; answers `{ health }` |
| `POST /api/memory/reindex` | Every folder's index.md written anew and empty folders removed, no model; answers `{ pruned, reindexed, health }` |
| `POST /api/memory/repair` | The model mends links to nothing and wires in orphans, only when there are any; answers `{ ran, reason?, summary?, filesChanged?, health }` |
| `POST /api/memory/clear-log` | log.md back to its heading and the query paths removed; the notes stay |
| `POST /api/memory/wipe` | Every note and folder deleted, the root index and log as new, Understory started again |
| `GET /understory-llm/v1/models` · `POST /understory-llm/v1/chat/completions` | Not under `/api`, and not for browsers: an OpenAI-compatible model server for the portal's own Understory, which signs in with its own bearer token rather than a portal login. A request goes to the model of the chat whose memory tool is running |

## Images

The [Images page](/guide/images): pictures made with the image add-on's endpoint without a
chat, and the gallery of those, the ones the agent made in chats and the ones that lie in
the folders its tools write into. A picture is named by its **id**, twelve lowercase hex
digits, never by a path: the portal opens files only in the folder of the page's own
pictures and in `generated-images` of the agents' homes, of the projects and of the folders chats work
in, with the checks the Files panel's pictures have. Reading the list from the top also
looks in those `generated-images` folders for pictures nobody recorded, such as ones made
before the gallery kept an index, and lists each plain file there whose bytes show a PNG,
JPEG, GIF or WebP of at most 25 MB (no link is followed, nothing is looked at that is not in
such a folder), as a picture of `origin` `folder`. The endpoint's address, key and model are the add-on's
(see [Opt-in features](#opt-in-features)); no key is ever in an answer.

| | |
| --- | --- |
| `GET /api/images?origin=&kind=&before=&limit=&again=` | A page of the gallery, newest first: `{ pictures, next, total, pageBytes }`, where `pageBytes` is what all the page's own pictures take of the disk, whatever the filters match. `origin` is `page`, `chat` or `folder`, `kind` is `generated`, `edited`, `uploaded` or `unknown`, `limit` is 1–100 (48 by default), and `before` is the `next` of the page before (`null` at the end). `again=1` says the caller asks again for the top of a list it has, as on a timer: the look through the folders (below) is then not made again within a minute of the last one, and the page is what that look found. Without it the top of the list is looked through at once. `total` counts what the filters match. A picture whose file is gone, or that cannot be served any more (its `generated-images` became a link out of the folder), is dropped from the list when it is read from the top; one in a chat's folder that cannot be reached for the moment (a drive that is not mounted) is kept. When a chat is deleted its pictures become pictures of its folder (`origin: "folder"`, with their `prompt` and `params`), unless the folder cannot be reached then. A picture found in a folder has `origin: "folder"` (which chat made it cannot be told), no `chat`, an empty `prompt`, a `kind` read from its file's name (`generated` for the tools' `image-…` names, `edited` for `…-edited`, else `unknown`), and is dropped with its folder, not kept. A picture is `{ id, origin, chat: { id, title } \| null, folder: { name, home } \| null, kind, prompt, params: { model?, size?, outputFormat?, outputCompression?, negativePrompt?, seed?, sampleSteps?, strength?, fromNoise?, extra?, sources?, masked? }, from, createdAt, bytes, fileName }`, where `folder` is where a picture of origin `folder` was found (`name` is the agent's name for an agent's home, `home` being true for the first agent's, else the project or the path under the workspace root; the folder of an agent deleted with its folder kept is named by its folder), `params` are the settings it was asked with (only those that were sent; `extra` is the free fields an older version sent, and is no longer written), `createdAt` of such a picture is its file's modification time, and `from` is the picture an edit was made from, when that is in the list |
| `GET /api/images?ids=a,b` | Those pictures alone, in the order given, as far as they are in the list: `{ pictures }`. At most 200 |
| `GET /api/images/:id/file` | The picture as a file, with its type from its bytes (PNG, JPEG, GIF or WebP, else 400; 413 over 25 MB) and `ETag`/`304`. 404 when it is not in the list or its file is gone, which takes it from the list (not while a chat's folder cannot be reached: the picture stays, and is served again when it is back). The page's own pictures are sent to be kept a day, those in a chat's or another folder to be asked about again |
| `POST /api/images/generate` | `{ prompt, size?, model?, outputFormat?, outputCompression?, count?, negativePrompt?, seed?, sampleSteps? }` — makes `count` pictures (1–4, one if left out), one request and one job for each (each takes the next seed from `seed`, a random `-1` stays random), and answers `202 { jobs }` at once. A setting that is left out, `null` or empty is not sent. `size` is `WIDTHxHEIGHT` (each side 64–8192) or `auto`, `outputFormat` is `png`, `jpeg` or `webp`, and `outputCompression` (0–100) needs `jpeg` or `webp`. These, with `model` and the prompt, are the only fields of the request to the endpoint, which is the OpenAI image format. `negativePrompt` (up to 4000 characters), `seed` (−1 or more) and `sampleSteps` (1–100) are not in that format: they are sent only inside the prompt, as a `<sd_cpp_extra_args>` JSON block that stable-diffusion.cpp's server reads (`negative_prompt`, `seed`, and `sample_params.sample_steps`), and only while the **Stable Diffusion extra settings** switch is on (`sdExtras`); with it off, a request that has one is refused with 409 and nothing is sent. The block is refused too (400) when the prompt has a block of its own. `extra` is no longer taken (400). 400 for a bad request, 409 while image generation is off or has no address, 429 when `count` would go over the four that run at once |
| `POST /api/images/edit` | `{ prompt, sources: [id…], mask?, model?, size?, outputFormat?, outputCompression?, count?, negativePrompt?, seed?, sampleSteps?, strength?, fromNoise? }` — changes the pictures, as `edit_image` does (the first is the one the result is named after; more than one only where editing is set to take several), and answers `202 { jobs }`, one for each of `count` (1–4) changes. The settings are as for generation, `model` taking the place of the editing model, and a `size` being sent only when given. `strength` (0–1) and `fromNoise` are for an edit and, like the other non-OpenAI settings, go in the `<sd_cpp_extra_args>` block and only with `sdExtras` on (409 otherwise): `strength` as `strength`, and `fromNoise: true` as `"init_image": null`, which starts from noise with the pictures as references (all of them are still sent as `image[]`); a `strength` or a `mask` with `fromNoise` is refused (400). `mask` is a PNG, as base64 or a `data:` URL, up to 25 MB, checked as a picture. The pictures are read and checked, with the tool's rules and limits, before anything is sent: 400 with the reason, 409 while editing is off, 429 when four are being made. The only route that takes a body this large |
| `POST /api/images/upload?name=` | The raw bytes of a picture as the body, up to 25 MB; kept only if they are a PNG, JPEG, GIF or WebP, as a picture of kind `uploaded` listed under `name`. Answers `201 { picture }`; 400 for anything else |
| `GET /api/images/jobs` | `{ jobs, limit }`, newest first: `{ id, kind: "generate" \| "edit", state: "running" \| "done" \| "failed", prompt, size?, from?, startedAt, finishedAt?, pictureId?, error? }`. A done job has the `pictureId` of the picture in the gallery; a failed one says why, never with a key or a path. Finished jobs are kept an hour, up to 30; jobs are in memory and a restart ends the ones that run |
| `DELETE /api/images/jobs/:id` | Stops a job that runs (its request is dropped, and no picture comes of it) or forgets one that has finished. 404 for none |
| `DELETE /api/images/:id` | Takes the picture away, file and all, from the page's own folder, a chat's or the folder it was found in; a file that is gone already counts as deleted, but a chat's folder that cannot be reached is an error (404) and the picture stays in the list |
| `POST /api/images/delete` | `{ ids }` (at most 200) — the same for several: `{ deleted, failed: [{ id, error }] }`, each as asked and what could not be said for each |

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
| `GET /api/agents` | `{ agents }`, each `{ id, name, home, first, initialised, chats, channels, orb, voice, heartbeat, unread }` |
| `POST /api/agents` | `{ name, setup? }` — a new agent and its folder; `setup` takes the wizard's answers. A folder kept from a deleted agent of the same name is taken up again, and the files in it are not rewritten: `kept` in the answer names the agent's own files (`SOUL.md`, `PrimaryUser.md`, `MEMORY.md`) that the folder already had, with `setup` or without it, and the wizard's answers did not replace them. |
| `PATCH /api/agents/:id` | `{ name }` — its folder stays where it is, and records the new name in `.agent-name`, which is what makes an agent of that name take the folder up again once this one is deleted with it kept |
| `DELETE /api/agents/:id` | Deletes it and its chats, and its folder with `?folder=delete`. Refused for the first agent, for one a channel talks as, and while one of its chats or routines is working. The jobs running in its folder are stopped (`jobsStopped`), whichever way the folder goes. Its routines are switched off (`routinesSwitchedOff`), or with `?folder=delete` deleted (`routinesDeleted`); their runs are kept either way. |
| `GET /api/agents/:id/setup` | Setup status and its editable files, each `{ name, exists, content, mtime }` |
| `POST /api/agents/:id/setup` | Writes the identity files that are not there from the wizard's answers; the others are left, and `kept` names them |
| `PUT /api/agents/:id/files/:name` | `{ content, mtime? }` — saves one of its files whole. With `mtime` (0 for a file that was not there), a file that has changed since is not overwritten: 409. A link is refused. |
| `PUT /api/agents/:id/orb` | Saves its avatar; answers the style as stored |
| `PUT /api/agents/:id/heartbeat` | `{ minutes, quietStart, quietEnd }` — how often it looks around on its own (0 never, else 15 minutes to a week) and the hours it keeps quiet (`"HH:MM"`, both or neither) |
| `POST /api/agents/:id/heartbeat/run` | A look now. Answers at once; `heartbeat.running` and `heartbeat.status` follow it |
| `GET /api/agents/:id/activity` | `{ notes, unread }` — what it noticed on its own, newest first |
| `POST /api/agents/:id/activity/read` | Marks its notes read |
| `POST /api/agents/:id/activity/:note/read` | Marks one note read; answers `{ unread }`, 404 for an unknown note |
| `DELETE /api/agents/:id/activity/:note` | Deletes a note |
| `PUT /api/agents/:id/voice` | `{ voice }` — the voice it speaks with in voice mode: `"design"`, a voice library id, one of Kokoro's voice ids (used while Kokoro speaks), or `""` for the one in the voice settings |
| `GET /api/agent/orb?session=` | The avatar voice mode shows for that chat: its agent's, or the first agent's |
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

## MCP servers

| Route | Purpose |
| --- | --- |
| `GET /api/mcp` | Read configured servers and settings. |
| `PUT /api/mcp/servers/:name` | Add or update a server. `{ entry, from? }`: with `from` it is a rename. A name that another server has is refused with 409 and `code: "exists"`. |
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
