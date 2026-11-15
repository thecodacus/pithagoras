# The data contract

The portal's own interface reads what the page knows (the chat list, a chat, what is written in its box, the models)
and does what a person does (send, stop, rename, delete) through one set of small, typed members of `portal`. An
extension's browser half is given the same ones. They are the *data contract*, and what follows is what an extension
may rely on and what it may not.

::: warning Experimental
While the portal is on 0.x, every member on this page is **experimental**: a minor version may change it. The types in
`@pithagoras/extension-api` say so on each one (`@experimental`). [Versioning](#versioning) is how an extension says
which contract it was written for, and how it finds out whether the portal has what it needs.
:::

## What it is, and is not

- **View models, not routes.** `portal.sessions`, `portal.chats.controller(id)`, `portal.composer` and the others give
  small shapes (`SessionRow`, `ChatController`, `ComposerView`, …) that the package defines. A change to one of the
  portal's HTTP routes does not break them. They are not a second REST API: only what the portal's own chat, sidebar
  and frame need is in them.
- **Read by hooks, act by functions.** A hook gives a component an immutable snapshot, drawn again only when it
  changes. An action is an async function that resolves with the portal's answer. The chat's events are the truth: an
  action does not write into the snapshot, the stream does.
- **The page owns what a person typed.** A draft, the pictures waiting to go with it, a queued message, a mode, a
  model: the portal keeps them per chat, so changing the interface in the middle of a message loses nothing. A part
  owns only its view state (this menu is open).
- **Nothing secret.** A provider's key, a token or a password is in none of them.
- **Codes, not display strings.** A status, a connection, a mode is an identifier. The part says it in the page's
  language with `portal.t`. What a tool printed comes as it is.
- **Settings and the big pages are not in it.** Providers, guard rules, agents, routines, projects and the rest of
  Settings keep their own access to the portal. A part links to them (`portal.navigate("/s/<id>/settings/general")`) and
  does not rebuild them.
- **Your own routes are `portal.api.json`.** It reaches the server half of your own package
  (`/api/x/<name>`). For the portal's data, use the contract.

## Reading

| Hook | Gives |
| --- | --- |
| `portal.sessions.use(pick?)` | `{ list, status, executor, error }`: the task list (agent and routine chats are not in it), `status` `"loading"`, `"ready"` or `"offline"`. The same array while a poll finds nothing new |
| `portal.sessions.find(id)` | A chat by its id from what the page holds |
| `portal.chats.use(id, pick?)` | The chat as a transcript needs it: see [the chat's events](/guide/extension-ui#the-chat-s-events) |
| `portal.chats.useEvents(id)` | Its events, `status`, `loading`, `missing`, and what paging and the version switch need: `versions`, `hasEarlier`, `loadingEarlier`, `live` |
| `portal.composer.use(id)` | `{ draft, attachments, adding, commands, sending }` of a chat's box |
| `portal.models.use()` | `{ models, status }`: each model is `{ provider, id, name, contextWindow?, reasoning, images }` |
| `portal.models.useChat(id)` | What the chat uses now: `{ model, thinking, levels }` |
| `portal.settings.use()` | Four public settings: `provider`, `model`, `thinkingLevel`, `executor` |
| `portal.me.use()` | `{ name, role }`; the role is always `"owner"` for now |
| `portal.status.use()` | `{ connection, update, executor }` as codes |
| `portal.prefs.use(key, fallback)` | A preference of this browser, kept apart from other packages' |
| `portal.env.useViewport()` | `"phone"` or `"desk"`, by the width the frame and the chat use (voice mode lays itself out by its own) |

`pick` is what `portal.chats.use` has: say what of the value the component uses, and it is drawn again only when
that changes.

`portal.media` gives the addresses of a chat's files (`image`, `picture`, `video`, `file`), for an `img`, a `video` or a
link. Nothing is asked.

## Acting

| Function | Does |
| --- | --- |
| `portal.sessions.actions.create(workspace?)` | Starts a chat |
| `….rename(id, title)`, `….pin(id, pinned)` | As the list does |
| `….remove(id)`, `….removeMany(ids)` | Deletes, after the portal's question |
| `portal.chats.controller(id).send(message, options?)` | Sends a message; `options` is `{ voice, images, steer }` |
| `….abort()`, `….edit(seq, message)` | Stops the run; replaces a sent message and everything after it |
| `….deleteMessage(seq)`, `….removeTurn(seq)` | Removes a message and the answer to it, after the portal's question |
| `….trustFlagged(result)` | Trusts a result flagged as a suspected prompt injection, after the portal's question |
| `….queued.takeBack(seq)`, `….queued.sendNow(seq)` | A message that waits for the agent to read it |
| `….switchVersion(seq, to)`, `….compact()`, `….loadEarlier()`, `….rename(title)` | As the chat's own controls |
| `….respond(requestId, answer)` | Answers a question the agent asked in the chat (its `ask_question` tool), or cancels any question. A question an extension of the agent asks in the portal's own dialog (the guard's, before a call it held) is answered there: here it can only be cancelled, and any other answer resolves `{ ok: false }` |
| `….modes()`, `….setMode(mode)` | The modes a chat may be put in; puts it in one |
| `portal.composer.actions.setDraft`, `attach`, `detach`, `loadCommands`, `canSubmit`, `submit` | What the box does |
| `portal.models.set(id, choice)` | Another model or effort for a chat |
| `portal.prefs.set(key, value)`, `remove(key)` | A preference of this browser |

Each is bound to a chat's id, so a part cannot do something in another chat by mistake.

### What the portal asks before it does

An action that destroys something or raises what the agent may do asks the person first, in the portal's own dialog,
and calls the portal only after a yes. It resolves `false` where they said no. A part cannot leave the question out,
and cannot make it easy to answer without reading it:

- `sessions.actions.remove` and `removeMany` (every chat, listed or not, and its sub-chats, named in the question)
- `chats.controller(id).deleteMessage` and `removeTurn` (the question quotes the start of the message)
- `chats.controller(id).trustFlagged` (the question names the tool the result came from)
- `chats.controller(id).setMode` to a mode that asks (an extension's mode with a `confirm`)

A question about something in a chat that is not the one on screen names that chat too, so that the person can check it
against what they meant.

This protects a person from a careless part. It does not protect them from a hostile one: an extension's browser half
runs with the person's login and can call any route through `fetch`.

## Streams and connections

A browser allows six connections to one origin, shared by all its tabs, and the portal speaks HTTP/1.1. A chat's
events come on a stream of its own, so the page keeps **at most four live streams per tab**: the chat on screen first,
then the chats in the order something first read them, one stream each however many parts read the chat. A chat past
the fourth is read as a snapshot (`live: false`) of its latest events, asked for again every five seconds, and takes
over a stream as soon as one is free. Design a dashboard of chats for that: the fifth and later update every five
seconds, not as they type.

While the tab is hidden, only the chat on screen keeps its stream: the others are not asked for at all, and are read
again from the start as the tab comes back. A hidden tab so holds at most one of the six connections.

The chat list is asked for every five seconds while the page is on screen, so a change made in another tab shows
within five seconds.

## Preferences

`portal.prefs` keeps strings in the browser under `ui.<package name>:<key>`, which no other package reads. Nothing in it
follows the person to another browser. The portal's own interface keeps its keys as they have always been, so nobody
loses a layout.

## Versioning

The contract has a version of its own, which is not the portal's and not the package's: `portal.api.version`, as a
[semver](https://semver.org) number. A minor version adds, a major version breaks. The portal's own version, and the
`@pithagoras/extension-api` package's, stay equal to each other for publishing, but an extension does not have to
follow either.

| Contract | What it has |
| --- | --- |
| 1.0.0 | `sessions`, `chats.controller`, `composer`, `models`, `settings`, `me`, `status`, `prefs`, `env`, `media`, and `has`; `versions`, `hasEarlier`, `loadingEarlier` and `live` on `chats.useEvents` |

`portal.version`, `1`, is kept as it is for the extensions already out.

**Say what you need.** An extension that uses the contract says which versions it was written for in its
`package.json`, as a semver range:

```json
{ "pithagoras": { "client": "./web/client.js", "api": "^1.0" } }
```

The page reads it before it loads the module. A portal whose contract is not one of them does not load the browser
half, and says why in Settings → Extensions: "Needs interface API ^1.2; this portal has 1.0.0". A range the page
cannot read is said the same way, and so is an `api` that is not text (`"api": 2` is read as the range `2`, a list is
refused) or one longer than 100 characters. An extension that declares nothing is taken as `^1.0` and loads as it
always did.

**Ask for a feature.** `portal.has("data.sessions")` says whether this portal has a part of the contract, for an
extension that can do without it. The names are `data.sessions`, `data.chats`, `data.composer`, `data.models`,
`data.settings`, `data.me`, `data.status`, `data.prefs`, `data.env` and `data.media`; `portal.api.features` lists them
all. A name the portal does not know is `false`.

**Experimental.** Until the portal leaves 0.x, an experimental member may change in a minor version of the contract,
which the range `"^1.0"` takes. An extension that relies on one pins the minor it was written for (`"~1.0"`), or asks
`portal.has` and does without. A change that breaks a member that is not experimental is a major version. The
release flow of the package is the one in
[Building an extension](/guide/extension-ui#releasing-pithagoras-extension-api); a change to the contract adds a row to
the table above.
