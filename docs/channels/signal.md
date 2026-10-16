# Signal

The Signal channel lets you message the agent from Signal, in a direct chat or
in a group. Signal has no bot API, so the channel talks to
[signal-cli](https://github.com/AsamK/signal-cli), an unofficial Signal client
that you run next to the portal. The portal reaches it through its JSON-RPC
daemon over HTTP.

The portal does not run signal-cli itself. signal-cli holds the account's keys,
and those keys can read and send everything the account can, just like the
phone. So they stay on the machine that runs signal-cli: they never pass
through the portal or the browser, and the portal image does not have to carry
Java or signal-cli's 400 MB native build. Setting it up is therefore up to you.
This page shows how.

## Two kinds of account

Decide first which number the agent writes as.

| | Your own number, linked | A number of its own |
| --- | --- | --- |
| What it is | The portal becomes a linked device of your account, like Signal Desktop | A second number (a SIM, a landline, a VoIP number) registered for the agent |
| Who the agent writes as | **You.** Its replies come from your number, and people cannot tell them from yours | The agent's own number, with its own name and picture |
| What it can read | Everything your account receives | Only what is sent to its number |
| How you talk to it | Note to Self, or in a group you allow | A chat with its number, or a group it is in |
| Setup | Scan a code in the portal | Register the number with signal-cli first |

A linked device needs no second number, but the agent then speaks with your
voice, and every message your account receives reaches the portal host. For a
bot that several people use, a number of its own is cleaner.

## Install signal-cli

Take a release from [signal-cli's releases](https://github.com/AsamK/signal-cli/releases).
The `Linux-native` build is one file that needs nothing else. The plain build
needs the Java version named in signal-cli's README. Use a recent release:
Signal changes its protocol, and an old signal-cli stops working.

Then start the daemon with an HTTP endpoint and a folder for its data:

```bash
signal-cli --config /var/lib/signal-cli daemon --http 127.0.0.1:8080
```

Keep it running with whatever starts services on that machine, for example
systemd. In the portal's `docker-compose.yml` the portal uses host networking,
so it reaches a daemon on the same host at `http://127.0.0.1:8080`. To run
signal-cli in Docker as well, give it host networking too, mount its binary and
data folder, and bind it to `127.0.0.1`:

```bash
docker run -d --name signal-cli --restart unless-stopped --network host \
  -v /opt/signal-cli/signal-cli:/usr/local/bin/signal-cli:ro \
  -v signal-cli-data:/var/lib/signal-cli \
  ubuntu:22.04 signal-cli --config /var/lib/signal-cli daemon --http 127.0.0.1:8080
```

::: danger The daemon has no password
Anybody who can reach its port can read every message and send as the account.
Bind it to `127.0.0.1`, or to a network only the portal is on, and never publish
the port. When signal-cli is bound to `127.0.0.1` it only answers requests made
to `localhost`, `127.0.0.1` or `::1`. It answers other host names only when it
listens on `0.0.0.0`, and then it checks none.
:::

### A number of its own

Register the number before you start the daemon, with the same `--config`.
Signal asks for a captcha first. Solve one at
<https://signalcaptchas.org/registration/generate.html> and copy the
`signalcaptcha://…` link that the "Open Signal" button points to:

```bash
signal-cli --config /var/lib/signal-cli -a +15551234567 register --captcha 'signalcaptcha://…'
signal-cli --config /var/lib/signal-cli -a +15551234567 verify 123-456
signal-cli --config /var/lib/signal-cli -a +15551234567 updateProfile --given-name 'Agent'
```

`verify` takes the code that arrives by SMS. For a landline, add `--voice` to
`register` and the code is read out in a call. The daemon can serve this one
account (`-a +15551234567 daemon …`) or all accounts in its folder (no `-a`).
The channel works with both. A daemon for one account answers for that one
whatever the channel asks for: if it is another number than the channel's, the
activity says `ignored messages for …` with the daemon's number.

### Your own number

Start the daemon without `-a` and without registering anything. The portal
links itself to your account in the next step.

## Set up the channel

In **Settings → Channels**, add a **Signal** channel:

| Field | What goes in it |
| --- | --- |
| **signal-cli daemon** | The daemon's address, such as `http://127.0.0.1:8080`. |
| **Signal number** | The number the agent writes as, with its country code: `+15551234567`. |
| **Allowed senders** | Who may write to the agent directly, comma separated: their number, or their Signal account id (a UUID). Either lets them through, whichever of the two signal-cli knows. A person who hides their number can only be given by their account id. |
| **Allowed groups** | The ids of the groups where the agent reads and answers every message. |
| **Device name** | What your phone lists the portal as once it is linked. `Pithagoras` if left empty. |

Then turn it on.

**For your own number**, the channel's page shows a QR code under **Scan to
connect**. On your phone open Signal, go to **Settings → Linked devices → Link
new device**, and scan it. A code is only good for two minutes, and a new one
replaces it until one is scanned. Once it is scanned the code goes away and the
activity says `linked as +15551234567`. If the phone that scanned it belongs to
another number, the channel says so and does not answer. Put that number in
**Signal number** and save. To unlink the portal, remove it under **Linked
devices** on the phone.

**For a number of its own**, the activity says `connected as +15551234567` and
it is ready.

## Who it answers

A bot on a personal number must not answer strangers. So the channel ignores
every message that is not from an allowed sender or in an allowed group. It
sends no answer, no "I don't know you", nothing. The activity names each
ignored sender and group once, with the number and account id or the group id
to copy into the fields above. Groups have no readable id in the Signal app, so writing in the
group once and reading the activity is how to find it.

On a linked number, what you write yourself reaches the agent only through
**Note to Self** and in allowed groups. Your conversations with other people are
yours: the copies your phone sends to its linked devices are dropped. The
agent's answers to Note to Self come back there.

`*` in **Allowed senders** lets every sender through to the portal's own check
in [People](/people/), and `*` in **Allowed groups** allows every group the
number is in. Use them only for a number of the agent's own. On your own number,
`*` would let the agent answer, as you, anyone who writes to you.

Messages that get through then go through the portal's [People](/people/) as on
every channel. The sender is their Signal account id: it is the same whether
signal-cli knows their number or not, and when they change their number. It is
never their profile name, which anyone can change. In **Settings → People** they
are listed under their profile name, or their number. Roles,
approvals and the audit log work as on the other channels. Once a primary user
is named, a sender the roster does not know is turned away with a reply. Allow
them in the channel first, then give them a role under **Settings → People**.

## What it does with messages

- **Conversations.** Each direct chat is its own conversation
  (`chat:<account id>`, and `chat:<your number>` for Note to Self) and so is
  each group (`group:<group id>`), whoever writes in it.
- **Replies** go back to the chat they came from. A reply longer than Signal
  carries in one message, 2000 bytes, is split into several messages, at a line
  or a space where possible. That is 2000 letters of English, and fewer of
  umlauts, Cyrillic, Chinese or emoji. A long message you send arrives whole.
  While the agent works, Signal shows it typing.
- **Pictures** you send (PNG, JPEG, GIF or WebP, up to 5 MB, up to eight with
  a message) reach the agent with your message. Pictures and clips the agent shows
  or makes come back as attachments, with their title as the caption, and any
  other file it gives is named in the reply. Voice notes and other files are
  not taken yet. The channel says it left them out, so you are not waiting for
  an answer about them.
- **Mentions** reach the agent as `@name`.
- Reactions, edits, deleted messages, stickers, polls and calls are not passed
  on.

## Things to know

::: warning End-to-end encryption ends at the portal host
Signal encrypts messages from your phone to signal-cli. signal-cli decrypts
them, and from there they are plain text: in the portal's database, in the
agent's session files, and on their way to whichever model provider the agent
uses. A cloud model gets everything said to the agent. Treat a Signal chat with
the agent like any other chat with it.
:::

- **The keys are a secret.** signal-cli's data folder (`--config`) holds the
  account's keys. Whoever has a copy can read and send as the account. Keep it
  out of backups you would not trust with your phone, and do not copy it to
  another machine.
- **Signal's terms and limits.** signal-cli is not made by Signal, and Signal
  offers nothing official for automated accounts. Its
  [terms](https://signal.org/legal/) do not allow spam or bulk messaging, and
  its servers limit accounts that send a lot. A limited account gets a captcha
  challenge, and its messages fail until someone solves it with signal-cli
  (`submitRateLimitChallenge`). An agent that answers the people who write to it
  stays far below that. One that sends routine reports to many chats is a
  different matter. Read the terms yourself before you put a number of your own
  behind a bot.
- **Keep signal-cli up to date.** A release that is months old can stop
  receiving when Signal changes its servers.
- **Messages while the portal is away.** signal-cli goes on receiving while
  the portal is down, restarting, or reconnecting, and keeps the last 1000
  events (receipts and typing count too). The channel keeps the id of the last
  message it took in, and on its next start or connection asks signal-cli for
  what came after it. What is past those 1000, or arrived while signal-cli
  itself was restarting before the portal connected to it again, is gone:
  Signal has delivered it to signal-cli, and it is not sent again. Changing the
  daemon's address or the number starts afresh.

  Of what is replayed, a message that reached Signal's server more than a day
  ago is not answered (by the server's clock, not the sender's): an answer
  days late, or a request acted on long after it was made, is worse than none.
  The activity says how many were skipped. A channel that is switched off
  forgets where it was, so switched on again it starts from then: what was said
  while it was off is not answered at all.
- **A connection that goes quiet.** signal-cli writes a keep-alive every
  fifteen seconds. When nothing at all comes for a minute, the channel takes the
  connection for dead and opens it again. Leave `--sse-keepalive-interval` at
  its default, or under a minute.
