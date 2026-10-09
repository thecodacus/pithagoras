# Approvals

A colleague hitting a wall is the normal case, not a failure. What matters is
that the wall has a door in it.

## Asking

When somebody needs something their role does not cover, the agent puts it to
you with `ask_primary`, and it arrives wherever [routine reports](/guide/routines)
go:

```
Priya (telegram:100200300) is asking (via telegram):

Priya wants me to check the inbox and summarise anything urgent.

It wants to run, exactly once:

    himalaya envelope list --mailbox Inbox --page-size 3

Approving runs that and nothing else.
```

The id after the name is who the platform says is asking. A name is whatever
somebody called themselves, and one can be changed to look like somebody else's;
the id cannot.

For `edit_image` the action is the path of each picture, one to a line, in the
order of the call (a single picture is just its path), and the agent is told
exactly which when the call is refused. The prompt is not part of what is
approved. **Always allow** then writes one rule for each picture, since a rule is
matched against each picture of a call and one for all of them would match none.
A tool that names no path (a search, an MCP tool) is approved on its arguments, as
JSON, exactly; the agent is told that as well.

Nothing is put to you that an approval could not make run. The guard keeps
some things from everybody who is not you, whatever is allowed: a write to the
agent's own instructions, a place where secrets are kept, your private notes (see
[roles](/people/roles#what-a-colleague-may-do)). A read is never asked for: where
it is allowed it needs no approval, and an approval does not open the rest. And a
conversation in which a result looked like a prompt injection refuses a push, an
upload, a subagent or a schedule after an approval as before it (see
[the injection guard](/guide/security#limiting-what-happens-next)), so it is not
asked for one there, and an approval you gave earlier is not used up on a call
that is refused. A subagent, and the tools that make, change or run a routine,
are never put to you for somebody else: they would run with your rights, not
theirs (see [roles](/people/roles#what-a-colleague-may-do)). If the agent asks for
any of these, the question is refused before it reaches you, and it tells the
person it is not something it can do for them.

The agent chooses neither the recipient nor the route. A session working for
somebody else must not be able to pick who hears from it.

## Answering

Three answers. On a channel that draws buttons you get **Approve once**,
**Always allow** and **Deny**; everywhere else the same thing as text:

| Reply | Effect |
| --- | --- |
| `#abcd approve` | That exact command runs, once, within 15 minutes |
| `#abcd always` | Writes a [standing rule](/people/rules) for that person |
| `#abcd no` | Refused, and they are told |

The words are exactly `approve` and `always`, in any case, with a full stop or
an exclamation mark after them if your phone puts one there. For a question about
an action, anything else is relayed to them as an ordinary answer and
**authorises nothing**, including `yes`, `ok`, `do it`, `approved`, and an answer
that merely begins with one of those or with `approve` (`#abcd ok, but not before
Friday`, `#abcd always check with me first`). When your answer was neither, the
reply you get says so: *It was not an approval (only "approve" and "always"
are), so nothing will run.* The agent that asked is told the same, and that it
may ask again: it is not a no. Only the word `always` creates a standing
permission — something that outlives the conversation should never come from a
reply that merely sounded enthusiastic.

A question that asks for a **decision** rather than permission (no command to run:
"Fine to show her how the servers are laid out?") has nothing to approve, so there
are no words to get right. Your answer is handed to the agent as it was written,
`#abcd yes, go ahead` included, and the agent goes on as it says, within what it
may do for that person: the answer allows nothing more than before. The Audit page
shows it as *Answered*, not *Refused*.

The `#abcd` prefix is what makes it an answer rather than a remark. It is
matched only at the start of a message and only against a question still
waiting, so a message that merely begins with a hash reaches the agent normally.

An answer written without the id is just such a message: it goes to your agent
like any other and answers nothing, so the person who asked keeps waiting. Your
agent knows nothing of the question, since nothing the person wrote is put into
your conversation. A question is shown to you where it was sent (the place
[routine reports](/guide/routines) go), and nowhere else: the portal never
repeats it in another conversation, which may be a group that guests and
colleagues read. Answer it there, with its id. When that channel cannot be
written to first, the question waits and goes out with the reply to your next
message in it. A question that could not be sent to you at all is dropped, and the
one who asked is told so.

::: tip Buttons are the text
A button's payload is exactly the message it stands for. Tapping **Approve
once** sends `#abcd approve` down the same path as typing it, so nothing behaves
differently depending on how you answered.
:::

## What happens next

The conversation picks itself back up. The agent runs what was approved and
tells the person who asked what came of it — you do not go and prod it, and
neither do they.

A refusal resumes it too. Being told no is an outcome worth delivering; silence
reads as the question having been lost. An answer to a question about an action
that was neither of the words and not a no resumes it as well, and tells the agent
that it was not an approval, so that it can say so and ask again.

The resumed turn runs **as that conversation**, so a colleague's session is
still a colleague's session. The approval permits one action inside it, not a
promotion.

## What an approval is not

::: warning It authorises the command you were shown
One conversation, one use, fifteen minutes. Matching is exact — approving
`himalaya envelope list --page-size 3` does not cover `--page-size 5`, which is
the safe failure direction and does mean an approval can quietly not apply if
the agent rephrases.
:::

Saying yes to one command does not make somebody trusted for the next one. If
you find yourself approving the same thing repeatedly, that is what **Always
allow** is for.

## When the answer cannot get back

Some channels can only reply to a message already open — a webhook without a
callback URL. Asking still works: the question reaches you, and the answer is
held and delivered the next time that person writes. The notification says which
of the two you are getting.
