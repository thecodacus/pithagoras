# Agent and channels

Sessions are per-task: one workspace, one job, its own conversation. The **agent**
is the opposite — a single long-lived pi session rooted at a fixed directory,
`agentHome`, that you talk to continuously.

A **channel** is a two-way link into that agent. Messages arrive through it and
the agent's replies go back out the same way.

## One session per conversation

A channel is not one conversation. A bot in a group chat and the same bot in
your DMs are two different discussions with two different sets of people, and
they should not share a memory.

So the channel package supplies a **session key** for every message — whatever
identifies a conversation on that platform — and the portal turns each key into
its own isolated session, all rooted at `agentHome`.

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
on the Agent tab marked "no channel" until something claims that slug again. They are ordinary sessions — same transcript,
same replay, same model handling — and they are listed on the **Agent** tab,
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

Four ship in the repo, between them covering every shape a transport takes:

| Package | Shape | Notes |
| --- | --- | --- |
| `pithagoras-channel-telegram` | Long polling | Outbound only. The Bot API has no socket — see below. |
| `pithagoras-channel-slack` | WebSocket | Socket Mode, which exists so an app needs no public URL. |
| `pithagoras-channel-discord` | WebSocket | The Gateway, with the heartbeat it demands. |
| `pithagoras-channel-webhook` | A listener | POST a message, the reply comes back in the response. |

None of them needs a dependency: `fetch` and `WebSocket` are both globals on
Node 22, which the portal requires anyway.

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
alongside its **instructions**.

## Per-channel instructions

Each channel can carry standing instructions, appended to the agent's system
prompt for every message that arrives through that door and no other. The agent
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

### What happens to a message

1. The package receives it and calls `ctx.ask(text, { session, title })`.
2. The key is prefixed with the channel's slug and resolved to a session,
   created on first sight.
3. The channel's [instructions](#per-channel-instructions) are appended to the
   message in a `<channel-instructions>` block.
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

An extension command can stop and ask something — `/models` from `pi-llama-cpp`
opens a menu. In the portal that draws a modal. In a chat there is nowhere to
draw one, so the question is sent as a message and the next reply answers it:

```
Llama.cpp models:
1. qwen36-35b-a3b-mtp
2. ornith-1.0-35b

Reply with a number, or "cancel".
```

Numbers work, so does typing the option. `confirm` takes yes or no; `input` and
`editor` take whatever you send.

**Anything that is not a valid answer cancels the question.** Asking again would
trap the conversation: the run stays blocked, and every attempt to talk about
something else gets the same prompt back.

The answer jumps the queue — the run is stopped waiting for it, so it cannot be
made to wait its turn behind itself.

Questions are relayed whatever the progress toggles say. They are not chatter:
the command hangs until somebody answers, and staying quiet would just leave it
to time out.

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
end to end. The four builtin packages have not been run against real Telegram,
Slack or Discord credentials — that needs tokens I do not have. Treat the first
connection to each as the real test.
:::
