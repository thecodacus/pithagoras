# Slash commands

Type `/` in the composer and the palette lists everything available in that
session. Commands are matched against the real list, so a message that merely
begins with a path — `/etc/hosts is wrong` — is still sent as a message.

The `/` is only how you type a command, and it can be another character: see
[The command character](#the-command-character). This page writes `/`
throughout.

The list is all of them — a lone `/` scrolls rather than stopping at the first
few — narrowing as you type, by prefix, and it is driven from the keyboard:

| Key | Does |
| --- | --- |
| `↑` `↓` | Move the highlight; it wraps |
| `Tab` | Complete the highlighted command, leaving the cursor after it for arguments |
| `Enter` | **Run** the highlighted command. `/cl` and Enter is `/clear`, not the message "/cl" |
| `Esc` | Put the list away until something else is typed |

A command typed out in full is the one highlighted, so `/skill:a` never runs
`/skill:ab` because that was listed first. A command that does nothing without
an argument — `/name` — is completed by Enter instead of run, so there is
somewhere to type the name.

A command that opens a dialog does not appear in the transcript. Its menu is the
feedback; a chat bubble saying `/models` would be noise.

## The command character

**Settings → This browser → Command character** sets what a command starts
with in the message box. It is `/` until you change it, and it can be any one
punctuation mark or symbol — `!`, `.`, `;`, `#`, `§` — but not a letter or a
digit, which would open the list for every message you write, nor `-`, `_` or
`:`, which are part of a command's own name.

With `!` chosen, typing `!` opens the same list, `Tab` completes `!skill:review`,
`Enter` runs the highlighted one, and the key that jumps to the message box from
anywhere on the page is `!` as well. That jump does not work for a dead key —
`^` on a German keyboard, for one — which the browser does not report as the
character it will type; such a character still starts a command typed in the
message box. A message that starts with `!` and is not one of the chat's
commands — `!important: the build is red` — is sent as it was written, as
`/etc/hosts is wrong` is under the slash.

pi is always sent the slash form. Whichever character you typed, `!skill:review
the diff` reaches the agent as `/skill:review the diff`, so skills, prompt
templates and every extension command keep working, and so do channels and
routines, which know nothing of this setting. That is also why the chat's own
line for a command, and the commands the agent suggests in a status line, still
show a `/`. A command typed out in full with the slash — `/compact` — still
runs as one after the character has been changed.

The choice is kept in this browser, like the theme and the keyboard shortcuts:
what is convenient to type depends on the keyboard (a German one reaches `/`
with Shift), and a phone may want another character than the laptop.

## Where they come from

| Source | Provided by |
| --- | --- |
| `builtin` | The portal |
| `extension` | An installed pi package |
| `prompt` | A prompt template |
| `skill` | A skill |

## Builtins

pi's builtin commands are implemented by whichever mode is running — the TUI
draws its own — so the portal supplies them. The names and descriptions are read
from the SDK's own `BUILTIN_SLASH_COMMANDS`, so they track pi's releases rather
than drifting from a copy.

Only the ones the portal can actually service are offered. `/quit`, `/hotkeys`,
`/trust` and the auth commands are terminal concerns; listing them would be a
menu of things that quietly do nothing.

| Command | Does |
| --- | --- |
| `/compact` | Summarise the conversation to free context |
| `/session` | Model, effort, context, tokens, cost, tool calls |
| `/export` | Write the session out — HTML, or `.jsonl` if you name one |
| `/reload` | Reload extensions, skills, prompts and settings |
| `/model` | Open the model picker |
| `/settings` | Open settings |
| `/new` | Start a new chat in this project (Home, if that is where you are) |
| `/clear` | The same as `/new` |
| `/name` | Rename the session |

The first four act on the session server-side and report through the event
stream. The rest open portal UI and never reach pi.

`/compact` is not awaited — it is a model call, and holding the HTTP request
open for it would time out. It reports when it finishes. Sent while the agent is
working, it stops that run to compact, and the agent then carries on with the
work by itself (see [Context](/guide/sessions#context)).

## Extension commands

Anything an installed package registers appears automatically. Install
`pi-llama-cpp` and `/models` shows up, opening the same menu the TUI draws:

```
/models  [extension]  Browse Llama.cpp models
```

Interactive commands work because the portal binds a UI context when it creates
the session. Without one, pi hands the extension a default immediately and a
command that asks a question appears to do nothing. Dialogs are rendered as a
modal — select, confirm, input and editor are all supported.

Dialog events are deliberately never persisted. A stored one would be replayed
to every future reader, so reloading the page reopened a menu whose extension
had long since stopped waiting.

## Adding more

Install a pi package from [Settings → Extensions](/guide/extensions). Its
commands appear the next time the palette refreshes, which happens when a run
ends — no reload needed.
