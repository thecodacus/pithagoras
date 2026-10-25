# Terminal, background jobs and subagents

Two buttons in a chat's header open the panels for what runs beside the
conversation: **Terminal** and **Subagents**. Like Files and Git they are
[panels](/guide/files#panels): at most two are open at once, and each can be docked
left, right or at the bottom, or floated, by dragging its header. In
[voice mode](/guide/voice) they are not shown.

## Terminal

The terminal is an [extension](/guide/extensions), `pithagoras-terminal`, in the
repository's `extensions/terminal`. A fresh portal installs it, once; after that
it is listed under Settings → Extensions → Installed like any other, and can be
switched off or removed there. Without it a chat has no terminal panel, no
terminal window in voice mode and no way into one from a command's card, and a
job in the running tray is listed but opens nothing. Another extension can take
its place: everything it does is open to any extension (see
[Extensions in the portal's interface](/guide/extension-ui)), and its source is
an example of each part.

The terminal panel has three tabs.

| Tab | What it is |
| --- | --- |
| **Agent** | The commands the agent runs in this chat and what they print, as a terminal. A live dot shows while the chat is running. |
| **Background** | What the agent left running in the background — see below. A live dot shows while one is. |
| **Your shell** | A real shell of your own, in this chat's workspace. |

A command in the conversation can be shown in the Agent tab from its own card, and
a background job in the running tray opens the Background tab on that job. In
voice mode the Agent tab is a window at the side, which opens each time the agent
starts a command, and from the card of one; <kbd>T</kbd> shows and hides it.

### Your shell

**Your shell** is a login shell in the chat's folder (`$SHELL`, else `bash -il`)
on a real terminal: a prompt, colours, job control, full-screen programs such as
`vim` or `htop`. It starts when you first open the tab, and shows 5,000 lines of
scrollback in the page.

Output comes to the page as a server-sent event stream and keystrokes go back as
requests, so nothing but plain HTTP is needed behind a reverse proxy. The last
200,000 characters are kept on the server. A page whose connection ends — the
network changed, a laptop went to sleep — opens a new one by itself and is given
them again, after a full reset of its screen, so that what it showed is replaced
by the replay and not repeated above it. A command that writes
faster than the page takes it waits, as at a terminal, but only for a page that
is still reading: one that has taken nothing for ten seconds — a laptop that
went to sleep, a phone that lost its network — is let go, and the page opens a
new connection as above. A page that stopped reading does not stop the shell for
another one that is watching.

The replay is for a connection that was interrupted, not for a page that was
closed. Closing the panel ends its shell at once, together with what it started.
Reloading the page, or opening the panel again, starts a new shell in the same
folder and does not come back to the old one: that is ended after five minutes
with nobody watching, with what it started.

Stopping the portal, an update or a restart, ends every open shell the same way,
and the stop waits two seconds for them. A portal that is killed or crashes
cannot: its shells and what they started are left running on the machine, with no
panel to close them and nothing that ends them later. In a container the
container's end takes them along; on a host, end them yourself (`ps` lists them
as `script -qfec …`).

If the connection to the shell is lost — it exited, or the portal restarted — the
panel says so once; close it and open it again for a new one. If the connection
comes back and the replay clears the screen, the notice goes with it, and it is
said again the next time keys go nowhere.

::: warning It is a shell in the portal's container
Anyone who can log in to the portal can open one, with the portal's own
permissions. That is nothing new — the agent has a shell in every chat — but it is
not a lesser thing than the chat box beside it. What you start there, a tmux
session or a server, is yours and is not listed as an agent job. See
[Prompt injection](/guide/security).
:::

It needs a `script` binary (util-linux), which the image has, and is Linux only.

### Background jobs

The **Background** tab lists what the agent started and left running — a dev
server, a watcher, a job an extension started. Each row shows its state and how
long it has run, or how long it ran once it is **finished**, and it can be
**paused**. Pick one to follow its output as it writes, up to the last 400,000
characters on screen; the file has the rest. **Stop** ends a running job, and
**Clear finished** forgets the ones that are done.

What an extension shows in pi's footer — its status lines and widgets — is listed
above the jobs.

Some limits:

- Jobs are followed only when pi runs **on the host** (`EXECUTOR=host`) on Linux.
  With `EXECUTOR=container` the tab says so instead.
- A read of the output that fails, because the portal is restarting or cannot be
  reached, keeps what was read, says so under it and tries again, a little less
  often each time, until it works. It stops only for a job whose output is no file
  the portal can follow.
- A job whose output does not go to a file cannot be followed from here, and says
  so. A command the chat itself shows is in the Agent tab, not listed here.
- Stopping a job that has already ended is refused with a message.

## Subagents

The **Subagents** panel is where the agents working beside this one are shown: one
tab per subagent, each drawn like the conversation itself — what it is doing, its
tool steps and output — with its state: *Working* while it runs, then *Finished*,
*Stopped* or *Failed* with the reason. **Stop** ends a running one.

Where its extension speaks the subagent protocol, the panel has a box to
**tell it something** — a message is sent to that subagent while it runs. One that
does not take messages says so. A subagent needs the chat to be running here, and
with `EXECUTOR=container` the portal cannot reach extensions to send to.

The subagent extension that comes with the portal is one of the [opt-in features](/guide/features); an
extension can announce its own agents to the panel too, and a tool that is not on
the protocol still shows its steps. With no subagents in the chat, the panel says
so.

## HTTP

The terminal is the extension's server half, under `/api/x/pithagoras-terminal`:
`POST /terminal` (optionally with the chat, to start in its folder), a stream at
`/terminal/:id/stream`, and `input`, `resize` and `DELETE` on the same id. Background jobs and subagents are under
`/api/sessions/:id/background` and `/api/sessions/:id/subagents/:agent`. See the
[HTTP API](/reference/api#terminal-background-jobs-and-subagents).
