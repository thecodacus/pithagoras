# Agent and channels

Sessions are per-task: one workspace, one job, its own conversation. An
**agent** is the opposite — a character with a home directory and a memory that
you talk to continuously. The portal starts with one, and [more](/guide/agents)
can be added, each with a home of its own.

Chats you start with **New** in the portal work in the home of the agent New is set to (the first agent unless you picked another, see [Agents](/guide/agents)), so its
SOUL.md, PrimaryUser.md and MEMORY.md are there in those as well; a chat started
on another agent's page works in that agent's home. Chats in a
[project](/guide/projects) are ordinary per-task sessions and have none of them.

A **channel** is a two-way link into an agent. Messages arrive through it and
the agent's replies go back out the same way. A channel talks as the first agent
unless you pick another under **Talks as** on its page: the agent that answers
there, with its own character and memory. Moved to another agent, a channel
starts new conversations there; moved back, it picks up the ones it had.

## One session per conversation

A channel is not one conversation. A bot in a group chat and the same bot in
your DMs are two different discussions with two different sets of people, and
they should not share a memory.

So the channel package supplies a **session key** for every message — whatever
identifies a conversation on that platform — and the portal turns each key into
its own isolated session, all rooted at the home of the agent the channel talks as.

```
Telegram ─┬─ chat:-100987  ──▶  session  "Engineering"
          └─ chat:12345    ──▶  session  "DM"
Discord  ──── channel:987  ──▶  session  "#ops"
```

Keys are prefixed with the channel's **slug**, so two channels both picking
`general` stay separate.

The slug and not the channel's internal id, because ids are regenerated: delete
a channel and add it back — after a token rotation, say — and every conversation
it had would be orphaned. Same bot, same chat, same token, and an agent with
amnesia. A slug is stable and yours to choose, so recreating a channel under the
same one picks its conversations back up, and choosing a different one is a
deliberate fresh start. It also reads better: `my-bot:chat:999`.

Removing a channel keeps its conversations rather than deleting them. They show
on the [Agents page](/guide/agents) marked "no channel" until something claims
that slug again. They are ordinary sessions — same transcript, same replay, same
model handling — and each agent's **Conversations** tab lists them by channel,
where clicking one opens it in the normal chat view.

From that list a conversation can be renamed or deleted. Deleting one does not
block the chat it belonged to: the next message in it starts a new conversation,
with none of the old memory. That makes it the way to reset a chat the agent has
got wrong. The messages themselves can be edited or deleted as in any session —
see [Sent messages](/guide/sessions#sent-messages) — but that changes what the
agent remembers, not what was already delivered to the channel.

## Channel types are packages

Nothing about Telegram is hardcoded. A channel type is a package with a
manifest and a `start()`, and the ones that ship in the repo are ordinary
examples of the format rather than privileged cases. Install another from a
GitHub repo and it behaves identically.

Five ship in the repo, between them covering every shape a transport takes:

| Package | Shape | Notes |
| --- | --- | --- |
| `pithagoras-channel-telegram` | Long polling | Outbound only. The Bot API has no socket — see below. |
| `pithagoras-channel-slack` | WebSocket | Socket Mode, which exists so an app needs no public URL. |
| `pithagoras-channel-discord` | WebSocket | The Gateway, with the heartbeat it demands. |
| `pithagoras-channel-webhook` | A listener | POST a message, the reply comes back in the response. |
| `pithagoras-channel-signal` | Server-sent events | Through a [signal-cli](https://github.com/AsamK/signal-cli) daemon you run, on its own number or linked to yours. See [Signal](/channels/signal). |

Slack sends a mention in a channel the app also reads twice, once as a message
and once as a mention, and the agent answers it once. People joining, and
messages being edited or deleted, are not said to the agent. The webhook, when
it is disabled or edited while a request is open, answers that request with a 503
rather than waiting for the agent to finish.

None of them needs a dependency: `fetch` and `WebSocket` are both globals on
Node 22, which the portal requires anyway.

Signal ignores everybody it is not told to answer, without a word: on a
personal number the agent writes as you, and a stranger must not get an answer
from it. Who it answers, and how to set up signal-cli for it, is on
[its own page](/channels/signal).

::: tip Why Telegram polls and the others do not
Telegram's Bot API offers two delivery modes — `getUpdates`, or a webhook it
POSTs to. There is no Socket Mode equivalent. Since the portal is meant to run
somewhere with no inbound route, polling is what is left.

It is *long* polling, though: the request parks on Telegram's servers for up to
50 seconds and returns the instant a message arrives. One mostly-idle held
connection, not a request every second — close enough to a socket that you will
not notice.
:::

Builtins ship inside the image and cannot be uninstalled. Everything else
installs to `CHANNELS_DIR` on the data volume and survives image rebuilds.

## Setting one up

Settings → Channels.

1. **Install a package**, if you need a type that is not already there. Any spec
   npm understands: `user/repo`, `github:user/repo#v2`, a git URL, an npm name.
2. **Add a channel** of that type and fill in its fields. Required fields are
   enforced server-side.
3. **Enable it** with the toggle.

Clicking a configured channel opens its own page, where the credentials live
alongside its **instructions**. A channel that needs something scanned to finish
setting up, as Signal does to link to your phone, shows it there as a QR code
under **Scan to connect**, for as long as it waits for it.

## Per-channel instructions

Each channel can carry standing instructions, appended to every message that
arrives through that door and no other, in a `<channel-instructions>` block. The agent
is one conversation with one memory, but who is on the other end differs by
channel, and so should the way it answers.

> You are answering over Telegram. Keep replies short — they are read on a
> phone. Never paste secrets or full file contents.

A Slack channel shared with a team might instead say to explain reasoning before
acting; a webhook driven by cron might say to reply with a single line and
nothing else. Leave it empty for none.

This is portal-side, not package-side: a channel package never sees the
instructions and does not need to. The portal attaches them when it hands the
message to the agent, so every channel type gets the feature for free.

Secret fields are write-only from the browser's side. The stored value is never
sent back — the UI is told only that one exists — and saving a blank secret
keeps what is stored, so editing an unrelated field cannot wipe a token you
cannot see.

A package that fails to load is listed with its error rather than disappearing,
and two packages claiming the same channel id are rejected at load time instead
of one silently shadowing the other.

## The supervisor

An enabled channel is started when you save it and again when the portal
restarts. The supervisor owns that: it calls the package's `start()`, hands it
the context, and keeps the `stop()` it gets back.

Editing a token, changing the slug or disabling a channel all restart or stop
it — the running channel is compared against its stored configuration, and a
mismatch means it is stale.

Each channel shows its real state on its page: `running`, `starting`,
`stopped` or `error`, with the reason and the last fifty things it logged.
A channel enabled with a package that has no `start()` reports that rather than
looking healthy.

A restart can cut a conversation off: the run that was answering is gone, and a
message sent into it never reached the agent. The platform has acknowledged those
messages and will not send them again, so once the channels are up again the
portal writes to each such conversation — *The portal restarted while I was
working on this, so my answer was cut off. Please send your message again.* —
through the channel's `send()`. A channel that cannot speak first is not written
to.

A channel whose `start()` fails — the network was not up yet when the portal
booted, the platform had a bad minute — is tried again on its own: after 30
seconds, then twice as long each time, up to every fifteen minutes. Saving it
tries at once, and so does installing a channel package, so a channel set up
before its package was there starts when the package arrives.

### What happens to a message

1. The package receives it and calls `ctx.ask(text, { session, title, from })`.
2. The key is prefixed with the channel's slug and resolved to a session,
   created on first sight.
3. The channel's [instructions](#per-channel-instructions) are appended to the
   message in a `<channel-instructions>` block. For anybody but the primary user
   the portal's note about who is speaking goes in front of their words; what they
   wrote cannot make a block of its own.
4. The session is prompted, and `ask` **waits** — unlike the portal's own
   prompting, which returns immediately, because somebody is sitting in a chat
   expecting an answer.
5. The assistant's text goes back to the package, along with a line for each
   tool as it starts (`⚙ bash · npm test`).

Each channel decides how much of that it wants, on its own page:

| Toggle | Effect |
| --- | --- |
| **Progress** | Relay what the agent says between tool calls, as it says it |
| **Tool activity** | Relay the name of each tool as it runs |

Both off and the channel stays quiet until there is an answer. A phone over
Telegram probably wants less than a war-room Slack channel does.

### Questions from extensions

An extension command can stop and ask something — a model picker from a
provider package, say — and opens a menu. In the portal that draws a modal. A
chat reached through a channel has nobody at a screen to answer it, so the
question is not asked there: the dialog is answered at once with no answer
(`confirm` says no, `select`, `input` and `editor` are cancelled), nothing waits,
and nothing is sent to the channel or to any page. The same goes for a routine's
run and a heartbeat's look. The agent's own `ask_question` tool is not offered in
these chats either; when the agent needs something from the person on a
channel, it asks in plain text and the person's next message is the answer.

A message that is only `stop`, `wait`, `cancel`, `abort`, `halt`, `hold on` or
`nevermind` aborts the current run instead. It is checked before the queue, so
it lands immediately rather than waiting behind what it is stopping — and it
matches the whole message, so `stop using the staging bucket` still reaches the
agent as an instruction.

Other messages in one conversation are answered in turn. Two arriving while the agent
is still working queue rather than interleaving, and each caller gets its own
reply rather than whichever finished first.

::: warning Untested against a real service
The supervisor, the session resolution and the reply path are exercised
end to end. The builtin packages have not been run against real Telegram,
Slack, Discord or Signal accounts — that needs tokens and numbers I do not have.
The Signal package has been run against a real signal-cli daemon up to the
code that links it, not past it. Treat the first connection to each as the real
test.
:::
