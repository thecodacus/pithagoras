# Group chats

A group is **one conversation with many senders**. The channel gives the portal
a conversation key — the chat id — and a sender id per message. One session, one
transcript, one context, a different person behind each turn.

Two things follow from that, and they move separately.

| | Follows | Behaviour |
| --- | --- | --- |
| **Context** — which files load, what has been read | the conversation | Takes the **lowest** role that has ever spoken there, and never recovers |
| **Capability** — what a tool call may do | the current speaker | Checked per tool call, so it follows whoever is talking now |

## Why context ratchets down

One guest in the group and `PrimaryUser.md` and `MEMORY.md` stay out
permanently, including on your turns. The alternative is a conversation that
quietly widens what it knows partway through — and nobody would notice the
moment it did.

Because the running process has already loaded its context, a conversation being
downgraded is restarted before the next turn rather than after.

## Why capability follows the speaker

Fixed at session start it would freeze the group to whoever spoke first: the
second person to talk would inherit the first person's permissions. So the
[guard](/guide/security) asks who is speaking at each tool call, not once at the
beginning.

## What a group is weaker at

::: warning A group is a lower-trust room than a DM
Everyone in it writes into the same context. When you then ask for something,
the agent acts with **your** capability while carrying **everyone's** words.
Narrower context limits what it can leak; it does not stop somebody shaping what
you are told.
:::

Groups are solid against somebody *asking* for what they should not have. They
are weaker against somebody *influencing* what you ask for. If that matters for
a particular piece of work, do it in a DM.

A question an extension asks mid-run (`Delete branch release?`) is not asked in
a chat reached through a channel: nobody there can answer it on a screen, so it is
answered at once with no answer, and a "yes" typed in the group answers nothing.

One known gap: an approval is scoped to the conversation, so in a group anybody
in it can spend it during the fifteen-minute window. In a DM the two are the
same thing.

## Strangers in a group

Refused before a session exists, as anywhere else — they cannot talk to the
agent. They can still read its replies to everyone else, because that is what a
group chat is.
