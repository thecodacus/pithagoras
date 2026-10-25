# Extensions

::: tip Looking for Voice, or the agent's browser?
Voice mode listens and speaks through an extension installed here: the Voice
extension, the voice service, or Voice servers, for speech servers you run
yourself. Its other settings are in **Settings → Defaults → Voice mode**: see
[Voice control](/guide/voice), [The voice service](/guide/voice-service) and
[Voice servers](/guide/voice-servers). The agent's browser is the Browser
extension: see [The agent's browser](/guide/browser).
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

Settings → Extensions has two views. **Installed** is what you have; **Discover**
is what there is to install, in three parts: **Comes with Pithagoras**, **Find
packages** and **Install by name**.

**Comes with Pithagoras** lists the extensions shipped with the portal itself
(a pack of seven themes, the terminal, Git, Files, Canvases, [Media](/guide/media), [Documents](/guide/documents),
[Docker for extensions](/guide/docker), [Kanban](/guide/kanban), the agent's [Browser](/guide/browser), the [voice service](/guide/voice-service), [Voice servers](/guide/voice-servers), [Understory](/guide/features#memory-understory), the agent's memory, and [Creator mode](/guide/creator-mode), a chat mode in which the agent writes and installs extensions), each installed from the portal's own folder with one click.

**Find packages** searches the npm registry for packages published for pi — by
keyword, with a separate search for packages that bring a model provider — and
shows downloads last week, author and last update. **Install** asks first: a
package runs inside pi with the same rights as the agent, reading files and
running commands, so install ones you trust. The registry can be another one
(`NPM_REGISTRY_URL`); results are kept for ten minutes.

**Install by name** takes a spec, in four forms:

| Form | Example |
| --- | --- |
| npm | `npm:pi-llama-cpp` |
| git | `git:github.com/user/repo@v1` |
| url | `https://github.com/user/repo` |
| path | `/absolute/path/to/package` |

They persist across restarts, because `HOME` points at the data volume. **Update
all** upgrades the installed packages; pi itself comes with the portal's version,
so a new pi arrives with an update of the portal. The bin icon removes one.
Installing, removing or updating reloads the open chats, so each has the change
without `/reload`: an idle chat at once, and one in the middle of a run at its
next step (see [a chat that is working](#a-chat-that-is-working)). So does
saving pi's `settings.json` in Settings → **Advanced**.

An extension that needs others to run (it [requires](/guide/extension-ui#installing-what-it-requires)
them) says so first: **Install** lists each one that is not there, from the
portal's own folder or npm, or switched off, and on yes installs or switches on
those before it. One that cannot be found is listed as such; the extension can
still be installed, and waits for it, which its card under **Installed** says.
Nothing more is asked when all it needs is there. A git URL or a folder is read
only once it is installed, so nothing is installed with it.

## What a portal starts with

A fresh portal installs the extensions its own `extensions/defaults.json` names,
once: today the [terminal](/guide/terminal), [Git](/guide/git), [Files](/guide/files), [Canvases](/guide/canvases), [Media](/guide/media) and the theme pack (Forest, Ocean,
Rose, Amber, Mono, Dusk and Warm, chosen under Settings → This browser → Colours). They are ordinary packages from then on: listed under **Installed**,
switched off or removed like any other, and one you removed is not put back
when the portal starts again. To use your own in place of one of them, remove
it and install yours. `PORTAL_DEFAULT_EXTENSIONS=off` installs none of them.

## What is installed

**Installed** shows each package as a card: its name and version, what it says
about itself, a switch, **Configure** where it has settings, and the bin icon.
The chips above the cards narrow the list by what a package brings, and each
card says the same in small:

| Kind | A package that brings |
| --- | --- |
| **pi** | Something for the agent: tools, commands, skills, prompts. What its `pi` key names, or without one the `extensions`, `skills`, `prompts` and `themes` folders pi looks in |
| **Pithagoras** | Something for the portal: a browser half that draws in it, or a server half that runs beside the chats. See [Building an extension](/guide/extension-ui) |
| **Themes** | Colours for the portal, picked in Settings → This browser → Appearance |

A package can be more than one: one with tools for the agent and a panel in
the portal is both **pi** and **Pithagoras**.

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
once; ones in the middle of a run take it at their next step, and the page says
how many they were. Packages a project brings in are that project's to decide
and have no switch here.

::: warning Some packages carry others with them
`pi-mcp-adapter` is what makes MCP servers into tools. Switching it off takes
every MCP server with it. The agent's [browser](/guide/browser) is not one of them:
its tools are the Browser extension's.
:::

## A chat that is working

A chat whose agent is in the middle of a run when the open chats are reloaded
(a package installed, removed, updated or switched, a feature or the sandbox
switched, an extension asking for it) is loaded again at its next step: after
the tools of one step have run and before the model is asked again. The
model's next request has the tools as they are then, so a tool one call
installed can be called by the next, in the same run. pi tells the model which
tools came and went.

Not while a subagent works in the background, which a reload would stop, nor
while one of the chat's child chats works, nor while an extension holds the
chat (`chats.hold`): the chat is then reloaded
once neither does any more, at a later step, as its run ends, or before the
next message starts a run. A chat whose pi runs in a container of its own
(`EXECUTOR=container`) is reloaded once its run is over. A reload keeps the
conversation and the chat's tool switches; what it loads again is the
extensions, skills, prompts and pi's settings, and an MCP server the adapter
keeps connected is started again.

What a chat whose pi runs in the portal's own process could not load (an
extension that throws as it loads, a tool of a name another extension took
first) is said in the chat once, as an extension's failure is, and again only
if it comes back after it was gone.

With the [sandbox](/guide/sandbox) on, pi's own tools (`read`, `bash`, `edit`,
`write`, `grep`, `find`, `ls`) are the sandbox's, which run them as the chat's
agent. pi keeps the first tool of a name, and an installed package loads before
the portal's own extensions, so a package that registers one of these names
would have its own run in the chat as the portal. That tool is off in every
chat instead, and the chat says which package took the name.

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

A package can also bring an interface of its own to the portal (a panel beside
the conversation, its own card for its tool's calls, a page in the sidebar, under **Extensions**) and
a server half with routes of its own. See
[Building an extension](/guide/extension-ui).
[Documents](/guide/documents), which ships in the repository, is one: a page
in the sidebar for the Markdown documents in your chats' folders, which you and
the agent edit and comment on together.

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
[Media](/guide/media)'s picture tools, `show_image`, `generate_image` and `edit_image`,
and its video tools, `generate_video` and `show_video`, are together in its group, `pithagoras-media`,
whichever of them is on offer.

::: tip The browser is one of them
It used to have a switch of its own beside the composer, which was a second
answer to a question the tools list already asked — and the two could
disagree. Its tools are in the list, as the [Browser](/guide/browser)
extension's group, `pithagoras-browser`, switched one at a time or as a group,
with a default like anything else.
Having its tools is having the browser, so a conversation with them all off is
not offered them and does not reach the browser. Where it may go once it is
there is still the [allowlist](/guide/browser#where-it-may-go)'s question, not this one.
:::

It takes effect from the next message — pi is told at once and there is no need
to restart the conversation — and it is remembered per chat, including across a
restart.

### Code mode

**Code mode** is a group of its own in the list, with one tool, `codemode`. It
is pi's code mode: with it on, the model can write a short JavaScript script
that calls the chat's other tools, for example several at once, and only what
the script returns reaches the model. That saves context on large outputs and
on many small calls, and it suits capable models. The script runs in pi's
sandbox, with no file system or network of its own; it reaches the outside only
through the tools this chat has on.

It is **off** in every chat until it is switched on, in the chat's list or for
a project, an agent or every chat in **Settings → Tools**. Switched on in a
chat, it is that chat's own choice, kept with the chat like any other switch.
Each call a script makes goes through the [guard](/guide/security#marking-untrusted-output)
like the model's own, a tool switched off in the chat stays off for scripts,
and scripts cannot run models directly, so pictures and videos are only made
through the [Media](/guide/media) tools and their settings. A tool that an
extension offers to scripts only is in the list too, so that it can be
switched off like the others; one that is off is not described to the model
and a script does not find it. Neither it nor code mode itself can be made
lazy: the model is not offered the one, and the other is how it makes many
calls in one. Code mode is offered in chats that run on the host; the
container executor has no tool switches.

Code mode is also a [chat mode](/guide/sessions#modes), chosen above the
message box before a chat's first message. The mode switches `codemode` on as
a layer of its own, above the chat's agent and project, where the chat's own
switch cannot turn it off, and has pi hide the other tools' declarations (its
`only` presentation), so the model works through the code tool alone. The switch
alone, in a chat in Standard mode, keeps pi's own setting for that, which is
`on` unless pi's `settings.json` says otherwise: the code tool beside the
others.

Before a chat has started, and in Settings → Tools, the list is what the portal
has seen registered. The tools of a package that is switched off, narrowed to
none of its extensions, or uninstalled are left out of it, since nothing
registers them any more. A switched-off package's are remembered and come back
with it; an uninstalled one's are forgotten. The tools an extension's
[server half](/guide/extension-ui#tools-that-share-the-server-half-s-state) adds
to every chat are left out while its package is switched off or uninstalled, and
come back with it, with what was switched for them; while it is switched on
they are listed, even when its server half has crashed or could not start. MCP
servers' tools go with `pi-mcp-adapter` when it is off or gone, but are
remembered even when it is uninstalled, since the servers are configured apart
from it. A package is the same package at any version, so updating one keeps its
tools. One narrowed to some of its extensions keeps all its tools listed here; a
started chat shows only what is loaded. Before a chat in a project starts, a package the project
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

### Lazy tools

A tool that is switched on costs the model its schema, description and rules in **every** request,
whether or not the conversation ever uses it. For a large set such as the [browser](/guide/browser)'s
eleven tools that is more than a thousand tokens in each chat. A tool that is **lazy** costs none of that until
it is needed: it is not in the model's list, and the model finds it through a single tool, `tools`.

**Nothing is lazy by default,** but for an MCP server's tools, which are lazy by the adapter's default (see
below). The portal marks no other tool and no other set on its own, so a portal behaves as it always did until
you choose.

**Settings → Tools** has a **lazy** button on the header of each group (a package, such as
`pithagoras-media`, `pithagoras-browser`, an MCP server) and one beside each tool. Marking a group makes every tool of it lazy,
including tools that turn up in it later; marking a tool makes that one lazy. Taking the mark away offers
the tool one by one again. The button of a tool that is switched off by default is greyed out, and so is a
group's while every tool in it is off: a tool that is off is not offered to the model, lazy or not, so
a mark on it changes nothing in the chats where it stays off. The mark is the portal's and not one of an
agent's, project's, routine's or chat's, so where one of those switches the tool on, the mark still
applies. In a chat in Code mode, or in a [mode of yours](/guide/sessions#modes-you-make) that works
through the code tool, the marks do not apply: every tool that is on is in a script's reach, found with
`searchTools`, and the `tools` tool is not offered. An MCP server's tools still stay behind `mcp`, which
a script calls like any other tool (see [Modes](/guide/sessions#modes)). To set or take away such a
mark, switch the tool on by default for a moment. A mark that was set stays as it is.

Any tool can be made lazy except pi's own built-in ones (`read`, `bash`, `edit`, `write`, `grep`, `find`
and `ls`), which every conversation works with and which are always offered. They have no lazy button, and
the portal refuses a mark that names them, in whichever group they are listed: with the
[sandbox](/guide/sandbox) on they are listed under **sandbox**, and an extension that brings a tool of one
of these names does not make it lazy either. The [Canvases](/guide/canvases) tools can be lazy, `canvas_write` too: a document
written through `tools` fills the canvas while the model writes it, and what has come is kept if the turn
is cut off, as for a direct call. Text is written only for a `canvas_write` the model can call: one offered
by its own name, or a lazy one called through `tools`. A lazy or switched-off one called by its own name is
answered "not found", and writes nothing. If a call through `tools` turns out to be another tool's (a key
given twice, the last one counts), only known when the call is whole, the text that came is taken out again.

**An MCP server's tools** are lazy by the server's own setting, which is the same thing as **Register tools
directly** in [Settings → MCP](/guide/mcp), turned off: the adapter then leaves the tools to its `mcp` tool,
which the model uses to search for them, describe them and call them. So there is one switch, and the
lazy button of an MCP server in Settings → Tools is that setting (a tool of the server cannot differ from it;
a list of tools in `directTools` is shown as it is). **MCP servers are lazy unless they register their
tools directly**, as the adapter does by default; a server an extension writes with its tools registered
directly, Understory's for one, stays so. A change reaches the chats that start after it. The portal's own
`tools` tool has no part in this, and a mark that names an MCP server is refused. The [guard](/guide/security)
reads a call through `mcp` by the tool it reaches and what it is given, as it reads that tool called
directly: the rules after a result that looks like a prompt injection, and what is kept from somebody who is
not the primary user, such as the places secrets are kept. (A standing approval for a colleague is matched on
the `mcp` call itself.)

Lazy is not a switch. A lazy tool is **on** like any other, and behaves exactly like one: it is run by
the same code, held to the same [guard](/guide/security) (the [list of sites the agent's tools may
reach](/guide/browser#where-it-may-go) in Settings → Guard, the rules after untrusted content, what a
colleague may run), its arguments are checked and converted as for a direct call, and its result is
wrapped as somebody else's words where it would be. A picture it shows or makes appears in the chat and
in voice mode, and the browser's window opens for it, as for a direct call.
Tools that run one at a time, as the browser's do, still do when the model calls several in one message.
A tool that its extension keeps inactive (one that waits for its moment) is not reached through `tools`
either, and marking it lazy does not switch it on.
The one difference is that the model is not shown the tool's schema and description up front. The model
is shown one short line instead, naming the lazy sets, for example "You have pithagoras-browser tools; search for
them with the tools tool." The rules the tool's extension wrote for the prompt stay in it as long as the
tool is lazy, and so does the portal's rule that outside content, such as a [browser](/guide/browser)'s page,
is data and never instructions.

The `tools` tool has three actions:

| Action | What it does |
| --- | --- |
| `search` | `query`: words from a tool's name or from what it does. Lists the matching lazy tools, each with the first line of its description. No query lists them all |
| `describe` | `name`: the tool's full description and its parameters as a JSON schema |
| `call` | `name` and `args` (an object, or its JSON text): runs the tool and returns its result |

The model describes a tool before it first calls it, so a schema is in the conversation only for a tool
that is used. `tools` is offered only to a conversation that has at least one lazy tool that is on, so
with nothing lazy there is no extra tool, and no hint, in any prompt. A tool the portal sees for the very
first time is offered one by one in the chat that registers it only until that chat has listed its tools,
a moment after it starts.

`tools` is a name an extension may use too. If an installed extension has a tool called `tools`, pi keeps
that one, because it loads before the portal's, and the portal's is not there. The extension's tool is then
a tool like any other: the guard asks for a rule or an approval before a colleague may use it, it is not
hidden while nothing is lazy, and it can be switched off in **Settings → Tools**. With no way to reach them,
the tools marked lazy are offered one by one in a chat it is in, and the portal logs a warning. That holds when
the tool registers after the chat has started too, as an MCP server's does once it has connected.

All the switches above a tool still apply, and a tool that is switched **off** is off for good, lazy or
not. The portal-wide default, an [agent](/guide/agents#tools), a [project](/guide/projects#tools), a
[routine](/guide/routines#tools) and a single chat each switch tools as they do for any tool, and the
[guard](/guide/security) refuses `call` and `describe` for a switched-off tool; `search` does not list
it. A tool switched off at any of them is therefore unreachable there, and switched on again it is lazy
again, because the mark is the tool's and the switch is the conversation's. There is no per-chat way to
offer a lazy tool one by one: for that, take the mark away in **Settings → Tools**.

::: tip Not the same as uninstalling
The extension is still loaded, its commands still work, and other chats are
unaffected. The tool is simply not offered to the model in this one.
:::


## Subagents and background jobs

Whatever runs beside the conversation shows in a tray just above the message
box: what extensions put there (the `chat.tray` slot), jobs the agent left
running, and the status lines extensions set (the ones pi's terminal shows in
its footer).

- **Subagents.** An extension that speaks the *subagent protocol* below is
  watched in the subagent extension's panel (`extensions/subagent`, see
  [Subagents](/guide/features#watching-a-subagent)), with a chip in the tray
  while it works and *Watch* on its call. It shows the subagent like the main
  conversation, and it can be given instructions and stopped from there. Only
  the protocol makes a subagent: other tools (code mode, a web search, a
  research tool) are not listed, and show their output on their own card in
  the conversation, as always. A subagent that waits for a free slot is listed
  while it waits. The portal keeps what the protocol says and its routes for
  input and stop; drawing it is that extension's, so while it is switched off
  no subagent is drawn.
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
listening and nothing changes. The protocol is the portal's, open to any
extension; `@pithagoras/extension-api/server` types it (`SubagentProtocol`, each
channel by its name with what is sent on it: `SubagentStart`, `SubagentEvent`,
`SubagentEnd`, `SubagentInput`, `SubagentStop`, `SubagentConfig`). The names
are text on both sides, so a pi extension that imports nothing speaks it too.

| Channel | Direction | Payload |
|---|---|---|
| `subagent:v1:start` | extension → portal | `{ id, label, toolCallId?, input?: boolean, stop?: boolean, detail?, detached?: boolean, chat? }` |
| `subagent:v1:event` | extension → portal | `{ id, event }` — one of the child's pi events, as `pi --mode json` or `--mode rpc` print them |
| `subagent:v1:end` | extension → portal | `{ id, status: "done" \| "error" \| "stopped", error? }` |
| `subagent:v1:input` | portal → extension | `{ id, text }` — only if `start` said `input: true` |
| `subagent:v1:stop` | portal → extension | `{ id }` — only if `start` said `stop: true` |
| `subagent:v1:config` | extension asks, portal answers at once | `{ reply(config) }` — the portal answers `{}`: what a chat's subagents run on is the extension's own to keep, as `extensions/subagent` keeps it per chat. `config.model`, `"provider/model"` or `"auto"`, where whoever answers says one |

Passing the child's events on unchanged is the whole integration: the portal
draws them the way it draws the main conversation. A child started with
`pi --mode rpc` can take `input` as an RPC `steer` command.

A subagent that works in a chat of the portal's, a
[child chat](/guide/extension-ui#child-chats) (`portal.chats.create`), says so
with `chat`, that chat's id, on its start, and sends no `event`s: its run is the
chat's own transcript, which the panel draws from the chat itself
(`chats.useEvents`) beside a link that opens it. `input` goes into the chat as
a steer (`chats.prompt` with `steer`), and `stop` stops its run
(`chats.abort`).

A subagent is over when its tool call is, unless `start` said `detached: true`:
then it runs on after the call has returned — a subagent in the background —
until its `end`, or until the chat's pi stops. A chat with one still running is
not reloaded when a package is switched: it is reloaded later, see
[a chat that is working](#a-chat-that-is-working).

`extensions/subagent` in this repository is a complete example: a `subagent`
tool that hands a task to a child chat of the chat that calls it, which can be
steered while it works, in the foreground or the background, and kept and given
more by its id. It is a Pithagoras extension like the others
that ship with the portal, switched on in Settings → Extensions (see
[Opt-in features](/guide/features#subagents)): its server half gives every
chat's pi the tool (`portal.chats.extend`, in `src/pi.ts`, which speaks the
protocol through its types) and keeps its settings and each chat's model, and
its browser half draws its page in Settings and every protocol subagent beside a
chat: a panel (`chat.panel`, named `agents`, drawing each run with
`ui.Transcript`), a chip in the running tray (`chat.tray`), *Watch* beside the
head of the call that started one (`chat.tool.action` with `head`), and the row
in the chat's model menu (`chat.model.menu`). Only the in-process executor (`EXECUTOR=host`) shares the
event bus with the portal, and so a server half that speaks the protocol runs
in the portal's own process, not in one of its own (`isolated`), whose pi has
no `events`.
