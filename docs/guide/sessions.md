# Sessions

A session is one workspace directory, one conversation with pi, and its own
model and effort level. It is the normal unit of work in the portal.

## Workspaces

Every session is created against a directory under the workspace root. You can
pick an existing one or create a new one, which is the default — most tasks
start with a fresh directory.

The name you type is slugified into a folder name, and that folder name becomes
the session title. "Cool Project" produces the directory `cool-project` and a
session called `cool-project`. One name drives both, so there is nothing to keep
in sync.

Paths are validated server-side: a workspace must resolve inside the workspace
root, so a session cannot be pointed at the rest of the filesystem.

## Giving it a task

Type and send. The request returns as soon as pi accepts the message — it does
not wait for the work to finish. Close the tab if you like.

While a run is in progress you can keep typing; further messages are queued.
**Stop** aborts the current run.

## Queued channel messages and questions

Channel messages wait for the current run to finish before applying a new
speaker or role. Pending notes are included when that queued turn starts and
are removed only after pi accepts the prompt. A failed startup leaves the
notes available for the next attempt.

When an extension asks a question, submitting a response closes the dialog only
after the server accepts it. If submission fails, the dialog stays open with an
error so you can retry or dismiss it. A timeout or cancellation resolves the
original question; it does not cancel a newer question that has replaced it.

## Sidebar and the sessions page

The sidebar opens with New, Sessions and Agents, then **Pinned**, then
**Recents**. Recents is capped at twelve; anything past that is reachable from
the Sessions page, which lists everything with search over names and workspace
paths.

Pinning is stored server-side and drives the ordering (`pinned DESC,
updated_at DESC`), so the sidebar and the Sessions page never disagree.

Hovering a session gives you pin and delete. Double-clicking its name renames it.

## Model and effort

The pills under the composer show the session's live model and effort level.
Both are per-session, both persist across restarts, and both fall back to the
portal default when unset — see
[Settings](/guide/settings#where-a-model-comes-from).

The model pill lists models you have used recently, with the full catalogue
behind **More models**. Only models with working credentials appear.

Effort is a slider from `off` through `max`. pi coerces it on a model that does
not reason — ask for `high` on a non-reasoning model and it lands on `off`. What
gets stored is the level pi resolved to, not the one you asked for, so a rejected
value is not reapplied on every restart.

## Context

The rightmost pill is a donut showing how full the context window is, green
through amber to red as it fills. Clicking it opens everything context-related:

- the exact usage — tokens used, window size, tokens left
- **auto-compact**, on by default, which summarises before the window fills
- **compact now**, to do it immediately
- input and output tokens, message count, tool calls, cost

pi refuses to compact a session that is too short, and says so rather than
failing quietly.

## Persistence

Sessions survive restarts. Three things make that true, and each was a bug
before it was a feature:

- **The conversation.** pi's session file path is stored on the session row and
  reopened by path. Earlier the portal called `SessionManager.create()` on every
  boot, which started a fresh conversation each time and reset context to 0%.
- **The model and effort.** Stored per session, applied when pi relaunches.
- **The transcript.** Independent of pi — every event is in the portal's own
  log, which is what replay reads.

If the server restarts mid-run, that session is marked `interrupted` rather than
left spinning. Send a message to carry on.

## Status dots

| Colour | Meaning |
| --- | --- |
| Pulsing cyan | Running |
| Grey | Idle |
| Amber | Interrupted — the server restarted mid-run |
| Red | Error; the message is in the transcript |
