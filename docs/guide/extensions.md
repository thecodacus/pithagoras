# Extensions

::: tip Looking for Browser or Voice?
Use **Settings → Add-ons**. See [Docker add-ons](/guide/add-ons) for setup instructions.
:::

Extensions are pi's own package system, not something the portal invented.
Anything you install is available to every session, and its slash commands
appear in the palette.

Do not confuse them with [channel packages](/channels/writing-a-channel), which
are a portal concept with a separate format and a separate install directory.

| | Extensions | Channel packages |
| --- | --- | --- |
| Owned by | pi | The portal |
| Installed with | `pi install` | The portal's installer |
| Live in | `~/.pi/agent` (`/data/home`) | `CHANNELS_DIR` (`/data/channels`) |
| Provide | Slash commands, skills, prompts, themes, model providers | Ways to reach the agent |

## Installing

Settings → Extensions has three parts: **Find packages**, **Install a package**
and the **Installed** list.

**Find packages** searches the npm registry for packages published for pi — by
keyword, with a separate search for packages that bring a model provider — and
shows downloads last week, author and last update. **Install** asks first: a
package runs inside pi with the same rights as the agent, reading files and
running commands, so install ones you trust. The registry can be another one
(`NPM_REGISTRY_URL`); results are kept for ten minutes.

**Install a package** takes a spec, in four forms:

| Form | Example |
| --- | --- |
| npm | `npm:pi-llama-cpp` |
| git | `git:github.com/user/repo@v1` |
| url | `https://github.com/user/repo` |
| path | `/absolute/path/to/package` |

They persist across restarts, because `HOME` points at the data volume. **Update
all** upgrades the installed packages; pi itself comes with the portal's version,
so a new pi arrives with an update of the portal. The bin icon removes one. Chats
started from then on have the package; open ones pick it up with `/reload`.

## Switching one off

Every installed package has a switch in Settings → Extensions. Off is not
uninstalled: the package stays where it is, with its settings and everything it
downloaded, and simply loads nothing — no commands, skills, prompts, themes or
tools — until it is switched back on. It is the difference between trying a week
without `pi-lens` and having to install it again to find out.

pi does this itself. A package in `settings.json` can be written as an object,
and an empty list for a kind of resource loads none of that kind; `pi config` in
a terminal writes the same thing from a menu. The switch writes exactly that:

```json
{ "source": "npm:pi-lens", "extensions": [], "skills": [], "prompts": [], "themes": [] }
```

and, switched on, puts the entry back. If the package was narrowed by hand — some
of its extensions off, some on — it shows as **filtered**, and that narrowing is
kept aside while it is off and given back when it is on again, rather than lost
to a plain entry.

Conversations that are open and idle are reloaded, so the change is there at
once; ones in the middle of a run keep what they had until `/reload` or their
next start, and the page says how many they were. Packages a project brings in
are that project's to decide and have no switch here.

::: warning Some packages carry others with them
`pi-mcp-adapter` is what makes MCP servers into tools. Switching it off takes
every MCP server with it. The agent's [browser](/guide/browser) is not one of them:
its tools are the portal's own.
:::

## Configuring

An extension that reads settings gets its own page in the settings navigation,
with one field per key. Values are written to pi's `settings.json`, which is
where extensions read from. Clearing a field removes the key rather than storing
an empty string, so the extension falls back to its own default.

The keys are recovered by reading the package source, not declared — see the
warning in [Settings](/guide/settings#extensions).

## What they can add

A package can contribute more than commands. `pi-llama-cpp` registers a **model
provider**, so a local llama-server appears in the model picker alongside hosted
models:

```
llama-server=http://<host>:8080 / <model>   64000 ctx
```

Those models only exist once extensions are bound, which is later than session
creation — the portal handles that, but it is worth knowing when a local model
seems not to stick.

## Built-in skills

The portal ships skills of its own, loaded from the image rather than installed,
so they are there without anyone adding them. They appear in Settings → Agent →
[Skills](/guide/skills) under "Built in and from packages", read-only — editing
one in place would be lost on the next deploy without saying so.

There is one so far. **`skill-creator`** teaches the agent to write skills: the
format, the frontmatter and the ways it silently fails, how to split detail into
supporting files, and where to write one so it loads. Ask the agent to remember
a procedure and it has somewhere to put it.

::: tip A skills directory holds directories
pi treats any `.md` file sitting directly in a skills root as a skill in its own
right. A stray README there is reported as a broken skill — keep the root to
directories only.
:::

## Interactive commands

Extensions can ask questions. `ctx.ui.select`, `confirm`, `input` and `editor`
all render as a modal in the browser, standing in for the menu the TUI would
draw. `notify`, `setStatus` and `setWidget` are one-way and do not open
anything.

A dialog waits until someone answers it, cancels it, or stops the agent: it has
no time limit of its own, and it stays open on every page that shows the chat. A
page that opens the chat later, after a reload or from another chat, is shown
the dialog again. An extension that passes its own `timeout` to the call gets a
dialog that closes when that time is up. The agent's own questions are a dialog
of this kind: see [Questions from the agent](/guide/sessions#questions-from-the-agent).

Only where a person can answer in the portal's pages: in your chats and in the
conversations you start on the Agent page. A routine's run, a heartbeat's look and a
chat reached through a channel have nobody at a screen, so a dialog there is
answered at once with no answer (`confirm` says no, the others are cancelled),
waits for nothing and is shown nowhere.

A status line or a widget an extension keeps refreshing does not count as use of
the chat, and does not cut what the agent is writing into pieces: only a dialog
does either.

## When a chat's agent is let go

A chat that nobody has used for twenty minutes has its agent let go, to free
what it holds; the next message starts it again, on the same conversation. A
routine that runs in a clean session lets its agent go when the run ends (not
while a subagent or a job it started is still going: see below), and so does
deleting a chat or stopping the portal. Extensions are told first, with
pi's `session_shutdown` event (reason `quit`), so that they can stop their timers
and the servers they started. One that has not finished after three seconds is
let go regardless.

That includes the jobs an extension started for the agent, which it ends when it
is told. So a chat whose agent left a job running in its folder
([Background jobs](#subagents-and-background-jobs), below) is not let go for
being idle until the job is over. That holds for the chat that started the job,
which is the one whose tool call was running when it began; another chat in the
same folder is let go as usual. It holds for the agent of a routine in a clean
session as well: it is kept when the run ends, and let go once the job is over
and it has been idle. Deleting the chat or stopping the portal ends such a job
all the same.

## Switching tools off for one chat

The blocks icon in the composer says which tools the agent may reach for **in
this conversation**. "Look this up for me" and "do not go online, just read the
repo" are both reasonable in the same week.

Tools are grouped by what installed them, so a package can be switched off in
one go. An MCP server is its own group rather than a share of the adapter that
attached it — three servers used to arrive as one pile of forty tools called
`pi-mcp-adapter`, and nobody thinks of them that way.
The portal's own picture tools, `show_image`, `generate_image` and `edit_image`,
are together in one **Images** group, whichever of them is on offer.

::: tip The browser is one of them
It used to have a switch of its own beside the composer, which was a second
answer to a question the tools list already asked — and the two could
disagree. Its tools are now in the list, as a group named `browser` — they are the
portal's own, not an MCP server's — switched one at a time or as a group, with a
default like anything else.
Having its tools is having the browser, so a conversation with them all off is
not offered them and does not reach the container. Where it may go once it is
there is still the [allowlist](/guide/browser#where-it-may-go)'s question, not this one.
:::

It takes effect from the next message — pi is told at once and there is no need
to restart the conversation — and it is remembered per chat, including across a
restart.

Before a chat has started, and in Settings → Tools, the list is what the portal
has seen registered. The tools of a package that is switched off, narrowed to
none of its extensions, or uninstalled are left out of it, since nothing
registers them any more. A switched-off package's are remembered and come back
with it; an uninstalled one's are forgotten. MCP servers' tools go with
`pi-mcp-adapter` when it is off or gone, but are remembered even when it is
uninstalled, since the servers are configured apart from it. A package is the
same package at any version, so updating one keeps its tools. One narrowed to
some of its extensions keeps all its tools listed here; a started chat shows
only what is loaded. Before a chat in a project starts, a package the project
lists and loads itself counts, whatever the user's entry says.

A tool remembered before the portal recorded which package it came from is
left out when its npm package is switched off, until a conversation reports it
again, and is forgotten when its package is uninstalled here — matched by the
npm name, or the folder or repository name, it is filed under. If that package
was uninstalled outside the portal, nothing says the tool was a package's, and
it stays listed until it is removed from `tools_seen` in the portal's database.

The list is what the model could be offered. pi registers `grep`, `find` and
`ls` and leaves them inactive, so they are not there to tick. A switch holds
against everything that would turn a tool back on — an extension that registers
it later, a `/reload` — because it is taken out of what pi wants active each
time pi says so, not applied once.

### Calling them something else

An npm name is an address. `@juicesharp/rpiv-ask-user-question` says exactly
where a package came from and makes a poor heading for the list of what it can
do, especially in a column narrow enough to truncate it.

So a group can be given a name: the pencil beside it in **Settings → Tools**.
The name is used wherever that package appears — the popover, the settings, the
extensions list — and the address stays underneath it, in the heading's tooltip
and under the package where you install and remove it. Clearing the field gives
the derived name back rather than leaving a blank heading.

Unnamed, a group is called what it calls itself, minus the scope:
`@forecastx/deep-research` is headed **deep-research**.

The groups start shut, in both places. A handful of extensions is sixty tools,
and sixty checkboxes is not a list anybody reads; each closed group says how
many of its tools are off, which is the only thing worth knowing from outside
it. The ones you open stay open, here and in the settings — they are the same
groups asked about at two scopes.

### And what every chat starts with

Per chat is right for "not this time" and wrong for "hardly ever" — nobody
wants to turn the same tool off at the start of every conversation. **Settings
→ Tools** has the other half: which tools a conversation starts with.

A chat may still disagree with the default in either direction, and the row
says so where it does. What a chat stores is only its disagreement, so changing
a default reaches every conversation that never said anything about that tool —
including the ones open right now.

A [project](/guide/projects#tools) can sit between the two: it switches tools
against this default for all of its chats, and a chat then disagrees with what
its project leaves, not with this default. The row in a chat says "default on"
or "default off" against that.

The list there is what the portal has seen a session register, not what is
loaded this second: pi builds its registry when a conversation starts, and
having to open a chat before you could say "off everywhere" would be the wrong
way round. It fills in as soon as any conversation has run.

A switch for a tool that is not loaded right now is kept, so reinstalling an
extension does not quietly bring back something you turned off.

::: tip Not the same as uninstalling
The extension is still loaded, its commands still work, and other chats are
unaffected. The tool is simply not offered to the model in this one.
:::


## Subagents and background jobs

Whatever runs beside the conversation shows in a tray just above the message
box: subagents, jobs the agent left running, and the status lines extensions
set (the ones pi's terminal shows in its footer). Nothing there is specific to
one extension.

- **Subagents.** Any tool that keeps reporting while it runs — a research tool,
  a delegate — gets a window (the robot button in the chat's header, or
  *Watch* on its call) showing its output and the steps it reports. An
  extension that speaks the *subagent protocol* below is shown like the main
  conversation, and can be given instructions and stopped from there.
- **Background jobs.** Processes the agent started in the chat's folder that
  are still running — a dev server, a watcher, an extension's job — are listed
  under *Background* in the terminal panel, with how long they have run. One
  whose output goes to a file can be followed live there, and any can be
  stopped; stopping one stops everything in its Unix session. The portal
  finds them itself, so it works with whichever extension started them. A
  tool call that is still running is not listed: the chat shows it. A
  process an extension starts in a session of its own and reads through a
  pipe looks like one, so while a tool call is running in the chat it is
  not listed either. Your own terminal's processes are never listed. Needs
  `EXECUTOR=host` on Linux.

### The subagent protocol

An extension that runs an agent of its own tells the portal about it on pi's
event bus (`pi.events`). No dependency on the portal: outside it, nobody is
listening and nothing changes.

| Channel | Direction | Payload |
|---|---|---|
| `subagent:v1:start` | extension → portal | `{ id, label, toolCallId?, input?: boolean, stop?: boolean, detail?, detached?: boolean }` |
| `subagent:v1:event` | extension → portal | `{ id, event }` — one of the child's pi events, as `pi --mode json` or `--mode rpc` print them |
| `subagent:v1:end` | extension → portal | `{ id, status: "done" \| "error" \| "stopped", error? }` |
| `subagent:v1:input` | portal → extension | `{ id, text }` — only if `start` said `input: true` |
| `subagent:v1:stop` | portal → extension | `{ id }` — only if `start` said `stop: true` |
| `subagent:v1:config` | extension asks, portal answers at once | `{ reply(config) }` — `config.model`: what the chat says its subagents run on, `"provider/model"` or `"auto"`; nothing said when the chat has no choice of its own |

Passing the child's events on unchanged is the whole integration: the portal
draws them the way it draws the main conversation. A child started with
`pi --mode rpc` can take `input` as an RPC `steer` command.

A subagent is over when its tool call is, unless `start` said `detached: true`:
then it runs on after the call has returned — a subagent in the background —
until its `end`, or until the chat's pi stops. Open chats with one still
running are not reloaded when a package is switched.

`extensions/subagent` in this repository is a complete example: a `subagent`
tool that hands a task to a second pi and can be steered while it works, in
the foreground or the background. It ships with the portal and is switched on
in Settings → Add-ons → Subagents (see [Opt-in features](/guide/features));
outside the portal, install it like any local package
(`pi install ./extensions/subagent`). Only the in-process executor
(`EXECUTOR=host`) shares the event bus with the portal.
