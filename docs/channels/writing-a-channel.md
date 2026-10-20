# Writing a channel

A channel package is a normal npm package with a marker, a manifest, and a
`start()` that owns its transport. Publish it to a GitHub repo and it installs
straight into the portal.

The five packages in the repo's `channels/` directory are reference
implementations of exactly this format — read them alongside this page.

## Layout

```
my-channel/
  package.json
  index.js
```

### package.json

The marker is what the loader looks for. Without it the package is ignored, so
an ordinary dependency in the same directory is never mistaken for a channel.

```json
{
  "name": "pithagoras-channel-my-thing",
  "version": "0.1.0",
  "type": "module",
  "main": "index.js",
  "pithagoras": { "channel": true }
}
```

A name starting `pithagoras-channel-` also counts, but the explicit marker is
clearer.

### index.js

```js
export const manifest = {
  id: "my-thing",
  label: "My Thing",
  blurb: "One line shown under the name in settings.",
  fields: [
    { key: "apiKey", label: "API key", secret: true, required: true },
    { key: "room", label: "Room", hint: "Optional" },
  ],
};

export async function start(ctx) {
  // set up your transport here
  return {
    async stop() {
      // release whatever start() acquired
    },
  };
}
```

## The manifest

| Key | Meaning |
| --- | --- |
| `id` | Unique across all loaded packages. A clash is rejected at load time. |
| `label` | Shown in settings. |
| `blurb` | One line under the name. |
| `fields` | Generates the configuration form. |

Validation is strict and the error is surfaced in the UI, so a typo shows up as
a red row naming your package rather than a channel that silently never appears.

### Fields

| Key | Meaning |
| --- | --- |
| `key` | Property name in `ctx.config`. Must be a valid identifier. |
| `label` | Shown above the input. |
| `secret` | Stored server-side, never sent to the browser. |
| `required` | The channel cannot be saved without it. |
| `hint` | Small print under the input. |
| `placeholder` | Placeholder text. |

Mark anything credential-shaped as `secret`. The browser is told only whether a
value is set, and a blank secret on save means "keep the stored one" — so a user
editing an unrelated field cannot wipe your token.

## start(ctx)

Called once when the channel is enabled. Return an object with `stop()`.

| `ctx` | |
| --- | --- |
| `config` | The configured values, secrets included. |
| `ask(text, meta)` | Send to the agent; resolves with its reply. `meta.session` is required. |
| `log(message)` | Surfaced in the channel's status. |
| `signal` | `AbortSignal`, aborted when the channel is disabled or the portal shuts down. |
| `showPairing(pairing)` | Shows `{ code, hint }` on the channel's page as a QR code, until `showPairing(null)`. See [Something to scan](#something-to-scan). |
| `state` | `get()` and `set(value)`: a little JSON kept across starts. See [Keeping your place](#keeping-your-place). |

`ask` is the entire interface to the agent.

### The session key

**`meta.session` is required, and picking it well is your main design decision.**

Each distinct key gets its own session — its own conversation, its own memory.
Your job is to decide what counts as one conversation on your platform; the
portal turns each key into an isolated session and keeps them apart.

```js
const reply = await ctx.ask(text, {
  session: `chat:${chatId}`,   // one conversation
  title: "Engineering",        // human label, used the first time only
  from: { id: userId, name },  // who sent it: see Identity below
  chatId,                      // anything else you need to route the reply
});
```

Get it wrong in one direction and a group chat and your DM share a memory; get
it wrong in the other and the agent forgets everything between messages. What
the builtins settled on:

| Package | Key | Why |
| --- | --- | --- |
| Telegram | `chat:<chat id>` | A DM and a group have different chat ids, so they separate for free. |
| Slack | `channel:<channel>` | Per channel, not per thread — a thread is a digression inside one conversation. |
| Discord | `channel:<channel id>` | A DM is a channel too, so servers and DMs separate for free. |
| Signal | `chat:<account id>`, `group:<group id>` | A group has an id of its own; a direct chat is the other person's account id, which stays the same whether their number is known or not. |
| Webhook | whatever the caller sends, else `default` | Only the caller knows what a conversation is. |

Your key is prefixed with the channel's slug before it is stored, so two
channels both choosing `general` stay separate without either knowing about the
other. Slugs are stable across a channel being deleted and recreated, which ids
are not — see [the note](/channels/#one-session-per-conversation).

### Relaying progress

A real task takes minutes and pi talks in stretches broken up by tool calls.
Pass `meta.onReply` and each stretch is handed to you as it completes, so the
chat shows the agent working instead of going silent:

```js
const reply = await ctx.ask(text, {
  session: `chat:${chatId}`,
  from: { id: userId, name },
  onReply: (body) => send(chatId, body),
});
if (reply) await send(chatId, reply);
```

You also get a line for every tool as it starts, so the chat shows what the
agent is doing rather than only that it is busy:

```
⚙ bash · npm test
⚙ read · src/index.ts
```

What actually reaches you is the channel's choice, not yours — **Progress** and
**Tool activity** are toggles on the channel's page in settings. Your package
passes `onReply` and the portal decides what to put through it.

When progress is on, `ask` resolves with `""` — the prose has already been given
to you, and returning it too would post everything twice. When it is off, only
tool lines are relayed and `ask` resolves with the whole answer at the end. Both
off and nothing is relayed at all. So the safe shape is: send everything
`onReply` gives you, then send the return value if it is non-empty. The portal's
own answers — `Stopped.`, `Nothing running.`, the refusal a stranger gets, the
confirmation of an approval — are always the return value and never go through
`onReply`, so a package that drops it posts nothing for them, and with
**Progress** off nothing at all.

### Interrupting

A message that is *only* `stop`, `wait`, `cancel`, `abort`, `halt`, `hold on`
or `nevermind` aborts whatever the agent is doing and answers `Stopped.` It is
checked before the queue, so it takes effect immediately rather than waiting
behind the run it is trying to stop.

Matched on the whole message, so `stop using the staging bucket` is an
instruction and reaches the agent intact.

Anything else in `meta` is yours — it travels with the message so you can route
the reply back where it came from.

### Pictures

A picture sent with a message goes in `meta.images`, as base64:

```js
const reply = await ctx.ask(text, {
  session: `chat:${chatId}`,
  from: { id: userId, name },
  images: [{ data: base64, mimeType: "image/png" }],
  onReply: (body) => send(chatId, body),
  onPicture: (picture) => sendPicture(chatId, picture),
  onVideo: (video) => sendVideo(chatId, video),
});
```

They are held to the rules of a picture sent in the browser: PNG, JPEG, GIF or
WebP by their bytes, whatever `mimeType` says, at most 5 MB each and eight with
a message. Anything else and `ask` answers with what was wrong, and the agent
sees none of it. Leave out what your platform says is not a picture, or too
large, before you ask, and tell the person: what is dropped silently is waited
for. `text` may be empty when there are pictures.

`meta.onPicture` is how pictures come back, and `meta.onVideo` clips. When a
call of the agent's gives one ([any tool's](/guide/extension-ui#files-a-tool-gives):
[Media](/guide/media)'s `show_image` and `generate_image`, or another extension's), it is handed to you as
`{ data, mimeType, name, title? }`, `data` in base64, at the moment it is given
and whatever **Progress** and **Tool activity** say. A picture is a PNG, JPEG,
GIF or WebP of at most 25 MB, a clip a WebM or MP4 of at most 100 MB, by their
bytes. With **Progress** on it falls between the words around it, as long as you
send in the order you are handed things. Any other file, and a picture or clip
your package has no way to send, is named among the words instead
(`📎 Sales by month (plots/sales.png)`).

Honour `ctx.signal`. A polling loop should check `signal.aborted` and pass the
signal to `fetch`, or disabling the channel will leave it running.

::: danger Do not await ask() in your receive loop
A running `ask` can be ended by a later message — `stop` — and that message has
to be received while it runs. Await `ask` inside the loop
that fetches messages and it can never arrive: the chat hangs until the agent
finishes.

Hand each message to an async function and do not await it. Ordering is safe
without you: the portal serialises messages per conversation, and a `stop` jumps
that queue.
:::

You do not handle the channel's [instructions](/channels/#per-channel-instructions).
They are configured in the portal and attached on its side of `ask()`, so your
package gets the feature without doing anything.

## Three shapes

**Polling**, from the Telegram package. Outbound only, which is what makes it
work on a machine with no inbound route:

```js
const handle = async (update) => {
  const reply = await ctx.ask(update.text, {
    session: `chat:${update.chatId}`,
    from: { id: String(update.userId), name: update.userName },
  });
  await send(update.chatId, reply);
};

while (running && !ctx.signal.aborted) {
  const updates = await getUpdates({ offset, timeout: 50 }, ctx.signal);
  // Not awaited: see the box above.
  for (const update of updates) void handle(update);
}
```

**A socket**, from the Slack and Discord packages. `WebSocket` is a global on
Node 22, so this needs no dependency either. Reconnect on close unless you are
being stopped, and honour whatever keepalive the service demands — Discord drops
a connection that misses its heartbeats:

```js
const connect = () => {
  if (stopped || ctx.signal.aborted) return;
  const socket = new WebSocket(url);
  socket.addEventListener("message", async (frame) => {
    const { text, channel, user, userName } = parse(frame.data);
    const reply = await ctx.ask(text, {
      session: `channel:${channel}`,
      from: { id: String(user), name: userName },
    });
    await send(channel, reply);
  });
  socket.addEventListener("close", () => {
    if (!stopped && !ctx.signal.aborted) setTimeout(connect, 3000);
  });
};
```

**Listening**, from the webhook package. Needs a reachable port, and you should
authenticate every request:

```js
const server = createServer(async (req, res) => {
  if (!validSecret(req)) return unauthorized(res);
  const { message } = JSON.parse(await readBody(req));
  const reply = await ctx.ask(message, {
    session: "default",
    from: { id: "ci", name: "CI" },   // who is speaking, never left out
  });
  res.end(JSON.stringify({ reply }));
});
```

## Installing yours

Push it to GitHub, then from Settings → Channels:

```
user/repo
```

Or via the API:

```bash
curl -X POST http://portal:4100/api/channel-packages \
  -H 'content-type: application/json' \
  -d '{"spec":"user/repo"}'
```

Anything npm understands works: `user/repo`, `github:user/repo#v2`, a git URL,
an https tarball, or a published npm name. The loader picks it up immediately —
a reinstall of the same version is cache-busted, so you do not need a restart to
see a change.

## Something to scan

A platform that is joined by scanning a code — Signal's linked devices, say —
puts the code on the channel's page with `ctx.showPairing`:

```js
ctx.showPairing({ code: uri, hint: "Open the app → Linked devices, and scan this." });
// … once it is scanned, or when the code is replaced by a new one:
ctx.showPairing(null);
```

The page draws `code` as a QR code with `hint` above it and the code as text
below, and polls, so a new code replaces the old one within seconds. It is not a
log line: nothing of it stays once it is taken back or the channel stops. The
code goes to the browser, so it must be something to scan, never a key.

Do the waiting after `start()` has returned, not in it. `start()` holds up the
other channels until it settles, and a code can wait minutes for somebody to
pick up their phone.

## Keeping your place

A package is stopped and started again whenever the portal restarts or the
channel's form is saved, and forgets everything in between. `ctx.state` is the
exception: a value that is still there at the next start.

```js
const kept = ctx.state.get();          // what was set last, or undefined
ctx.state.set({ cursor: lastEventId }); // replaces it; null forgets it
```

It is for a cursor, the Signal package's last event id say, so that a stream
that can be resumed is resumed rather than missing what came while the channel
was stopped. At most 64 KB of JSON, kept in a file per channel. It is kept
across a restart of the portal and a save of the form, and forgotten when the
channel is switched off or removed: switched on again, a channel starts from
then, not from where it was before somebody turned it off. `set` from a start that has been stopped is ignored, so a package
that is still shutting down does not write over the one that replaced it. Not
for secrets: those are fields marked `secret`.

## Things to know

- **Dependencies work.** `npm install` runs normally, so a package that needs a
  library gets one. Keep it light — it loads in the portal's process.
- **Ids must be unique.** Two packages claiming `telegram` and the second is
  rejected, named in the UI.
- **Uninstalling keeps configured channels.** Removing a package does not
  discard credentials; those channels report the missing package until it is
  reinstalled or deleted.
- **A key is mandatory.** `ask` without `meta.session` throws rather than
  quietly lumping everything into one conversation.
- **Editing configuration restarts your channel.** `stop()` is called and
  `start()` runs again with the new values, so do not hold state that matters
  outside them. `stop()` has five seconds: a package that is still waiting by
  then (say, for a request that is open for the length of an agent turn) is left
  behind, with a line in the log, so that editing a channel and shutting the
  portal down never wait on it. Answer what is open instead of waiting for it,
  as the webhook does with a 503.
- **`ask` waits for the agent.** It can take minutes on a real task; there is a
  15 minute ceiling after which it rejects.

## Speaking first, and asking natively

`start()` returns `{ stop }`, and may return two more:

```js
return {
  async stop() { /* … */ },

  // Optional. Send without being asked — a routine's report, an answer coming
  // back later. A transport that can only fill in a response it already has
  // open, like a webhook without a callback URL, omits this.
  //
  // options, when present, are one-tap replies: each carries exactly the
  // message that would have been typed. Draw them as buttons if your platform
  // has buttons and ignore them if it does not — the text is the protocol
  // either way.
  async send(target, text, options) { /* [{ label, reply }] */ },

  // Optional. Render a question the way this platform renders questions, and
  // capture the answer.
  async prompt(target, request) {
    // request: { id, method: "select" | "confirm" | "input", question, options? }
    // return { value } or { cancelled: true }
    // return null if this is not something you can present
  },
};
```

`target` is the conversation key your package supplied to `ctx.ask` — the portal
scopes it internally, but hands it back to you as you gave it.

### Why prompt returns null

Plain numbered text is the **default**, not the failure case. The portal asks in
words whenever a channel has no `prompt`, and whenever `prompt` returns `null`
for a particular question. A free-text question has no keyboard to draw, so
returning `null` there is the correct answer, not a limitation.

The Telegram package shows the shape: an inline keyboard for `select` and
`confirm`, `null` for anything else. Because Telegram caps `callback_data` at 64
bytes, the button carries an index rather than the option itself, and the
message is edited afterwards to show what was chosen — so the chat reads as a
record of the decision rather than a question nobody answered.

## When a channel cannot be spoken to

Omitting `send` is not a dead end. A message meant for that conversation is held
and goes out with the reply to whatever is said next, so an answer is late
rather than lost. The portal reports which happened, and tells whoever is
waiting.

The portal also speaks first, through `send`, after it has restarted in the middle
of a conversation: the platform has acknowledged the messages it cut off and will
not deliver them again, so the person is asked to send theirs once more. A
channel without `send` is not written to for that, since the note would arrive
with the answer to a message they have already repeated.

A webhook can opt into being spoken to by taking a **callback URL**: the portal
POSTs `{session, message}` there, and the conversation becomes two-way.

## Identity

Pass `from: { id, name }` on `ctx.ask` — the platform's own id, never a display
name. **`id` has to be a string**: where the platform gives a number, as
Telegram's JSON does, write `String(user.id)`. Anything else counts as no
sender at all. Without it every message is anonymous, which means it cannot be attributed
to anybody in the [roster](/people/) and is refused once a primary user is
named, with a reply saying the message did not name its sender. A package written
without `from` stops answering the day somebody is named primary, which is the
safe way round: it would otherwise run with a primary user's rights.

A webhook can pin its identity in config instead, so the secret is one person's
credential rather than a licence to claim any name.
