# MCP servers

MCP is how the agent reaches tools it does not ship with — a filesystem server,
a GitHub server, a company's internal one. pi has MCP support of its own, and the
portal runs the servers on it: the portal owns the configuration, pi connects and
calls, and what the model is shown of the tools goes through the portal's own
[tool search](/guide/extensions#lazy-tools).

Settings → **MCP**.

A portal that ran its servers on `pi-mcp-adapter` moves them at the first start of this version. What the move did,
and what is left to look at, is the report at the top of this page; what to do is in
[Upgrading](/guide/upgrading#mcp-servers-run-on-pi-s-own-mcp-support).

## Where it is written

`<agent dir>/mcp.json` — `/data/home/.pi/agent/mcp.json` in the container. It is
pi's own file in pi's own shape (pi's `docs/mcp.md` has every key), so the `pi`
command line and a container's pi read the same one. It applies to every session
in the portal.

What is the portal's own is not in it: whether you count a server's answers as
your own (Settings → Guard), which of its tools ask before they run, and whether
its tools are lazy are kept in the portal's database by the server's name. The
file stays valid for pi alone.

The file holds the servers' keys, and the token the portal made for its own
memory, so it is readable by the account the portal runs as and no other. It is
written whole or not at all: a full disk leaves the file as it was.

An extension can write a server of its own into the file as well, when you
switch it on from the extension's page. The server is listed and switched here
like any other.

The file is not converted when you edit it. A server written in the old adapter's keys
(`directTools`, `includeTools`, `excludeTools`, `approveTools`, `lifecycle`, `idleTimeout` and the like), whether
pasted from an old README or put back from `mcp.json.adapter`, is not connected, and its row in
Settings → MCP says so. The move at the first start is the only conversion; after it, write the entry in pi's
keys: `exposure` and `toolExposure` say what a model sees, `approve` is set in the server's form, and the rest has
no key in pi.

Open chats are loaded again when the file changes, as soon as they can be: at
once where a chat is idle, and between two steps of a run where it works. A chat
keeps the servers it connected with until then.

A **project** can bring servers of its own in `.pi/mcp.json`, which pi reads only
in a project it trusts (and never while the [sandbox](/guide/sandbox) is on). An
entry in it with no `command` and no `url` changes the server of that name here, and
in the portal's chats it can only take away: `enabled: false`, `exposure: "hidden"`,
and tools set `hidden` in `toolExposure`. It cannot switch on a server you switched
off, or show a tool this file hides (pi's own command line lets it; the portal
does not). A project cannot define a server again that this file names, whether
that server connects or not, or send a credential somewhere with `auth`. An entry
pi would skip, such as `auth` on an address that is not `https`, is skipped in
the chats too. No other tool's configuration — `.mcp.json`, `.vscode/mcp.json`,
`opencode.json` — is read.

## Adding a server

Three ways, in descending order of effort:

**Paste JSON.** Every MCP project's README hands out the same snippet. The
import accepts a whole config, a bare `mcpServers` map, or a single server
object:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/data"]
    }
  }
}
```

A server in the snippet whose name you already have is not imported over it: it
is listed as skipped, and the one you have stays as it is.

**The form.** Name, transport, then the fields for that transport. A server is
`stdio` (a local process) or `http` (a URL). A name is letters, digits, `_` and
`-`; two names that differ only in `-` and `_` are one server to pi, and the
second is refused. A name that another server has is refused too, whether the
server is new or renamed: it would replace that one, with everything the form
does not show. A server that pi would skip is marked in the list, with why.
Under the transport fields the form has pi's `description` and request `timeout`,
and the two settings that are the portal's own: **Tools in the model's list** and
**Ask before these tools** (see below).

**The file.** "Edit the file directly" at the bottom of the panel, for anything
the form does not cover: OAuth blocks, `toolExposure`. It is plain JSON, as pi
reads it: comments are refused there (a file written by hand with comments is
still read by the portal, but not by pi's command line). The form preserves
fields it does not show, so an edit made there is not lost by a later edit in the
form.

## Secrets

Do not put a token in this file. For stdio servers, reference the environment:

```
GITHUB_TOKEN=${GITHUB_TOKEN}
```

`${VAR}` is expanded when the server launches, and works in `headers` as well:
`Authorization: Bearer ${DOCS_TOKEN}`. A value that **starts with `!`** is run as a
command and its output used (`"!echo Bearer $(gh auth token)"`), also for an HTTP
server. That is a command the portal's user runs, as a `command` is; the panel
says which servers have one.

A server that asks for OAuth is signed in to with `pi mcp login <name>` in a
terminal; pi stores the credentials in `mcp-auth.json` in the agent folder.
Signing in from the portal is not built yet.

## Tools, and how many of them

An MCP server is a group of tools like any other, with the same three marks
(auto, lazy, direct) and the same [threshold](/guide/extensions#the-threshold) in
Settings → Tools: a server of a few tools stays in the model's list; a large one
(a Playwright server of two dozen tools) goes behind `tool_search`, which finds
and calls its tools. The tools are named `mcp__<server>__<tool>`.

A server that is lazy is **not started** with a chat. It is started when the
model first searches for or calls one of its tools, and stopped again after ten
minutes without use, so a chat that never needs a server never runs it. What the
search finds before the server is up is what the portal kept of what it offered
when it last ran, which is what the lists in Settings → Tools show for a server
that has not run in a chat. A server nothing is known of yet counts as lazy; its
first search starts it and waits for it.

A server that is direct (marked so, or small enough) is started with the chat, and
its tools are in the model's list from the first request. An extension that
writes a server with `exposure: "direct"` starts it that way, until you set a
mark of your own.

A chat that works through the [code tool](/guide/sessions#modes) alone has every
server connected, and a script calls the tools like any other.

A server whose tools are all switched off in a chat is not started with it, unless
pi's resource tools still reach it. Switching one of its tools on starts it then,
without reloading the chat. When a chat stops, every server started for it is
stopped with it.

pi's three resource tools (`list_mcp_resources`, `list_mcp_resource_templates`,
`read_mcp_resource`) reach every server with resources, and are lazy with the lazy
servers. A lazy server that offers only resources is found that way too: once it has
run, the search lists the resource tools, and a call that names the server starts it.

## What the tool lists show

In the Tools lists (Settings → Tools, an agent's, a project's, a routine's, a
chat's) an MCP server is a group like any other: switched on or off as a whole
with the group's switch, or tool by tool. Every tool the server offered when it
last ran is listed. A tool that is switched off is not found by the search,
cannot be called through it, and is never named to the model.

What the configuration says no to is not listed: a server switched off, or a tool
the file hides (`toolExposure`). A tool marked **cached** is listed from what the
portal kept of the server when it last ran: it is not running in this chat, and
starts when the tool is first used.

## What each server's row says

Under the name of each server the list says what a chat that starts now does with
its tools and what is known of them: *direct: always in the model's list*, *lazy:
found through tool_search*, or, for a server with no mark of its own, what the
threshold made of it (*auto, lazy now: the model's list is over the limits*, *auto,
in the model's list: small enough to stay there*, or *auto, lazy until it has run
once: its size is not known yet*), then how many tools the portal remembers of it
and about how many tokens they take, or that it has never connected. The form of a
server shows the same line. It is the state every chat that starts from now on
gets: a chat that is running keeps the list it started with.

**Tools in the model's list** in the form is the mark: **Auto** (the threshold
decides), **Lazy** or **Direct**, the same mark Settings → Tools shows on the
server's group. A mark you set is said in `mcp.json` as well (`exposure`:
`deferred` for lazy), so that pi's command line and a container's pi, which have
no threshold, reach the server's tools the way you chose; **Auto** leaves the file
as it was. A server in the file with `toolExposure` entries has them kept, and the
form says how many; they are changed in the file.

## Tools that ask first

**Ask before these tools** in the form takes patterns of the server's own tool
names, one per line, with `*` for any characters: `delete_*` asks before every tool
of the server that starts with `delete_`. The person is asked in the chat before the
call runs, with all of the call's arguments, and where nobody can be asked (a routine, a heartbeat, a channel chat)
the call is refused. An extension that writes a server can name the same tools with
`approve`, and a server moved from the old adapter has its `approveTools` here. A pattern
`*` covers the resource tools (`read_mcp_resource` and the like) for that server too. The
patterns are kept by the server's name in the portal, not in the file.

A server that is not running is started by a search or a call only in the primary user's chat, or for a call that
a standing rule allows for the person who speaks: somebody else asking the agent to search its tools does not set a
server's command, its `!` values or its sign-in going.

## Disabling

The toggle on each row sets `enabled: false` — the server stays configured and
visible but is never connected. Better than deleting a server you are debugging.
(`disabled: true`, which the old adapter wrote, still means off.)
Deleting one, or renaming it, also takes its tools out of the Tools list and what
the portal kept of what it offered, and the marks you gave its tools one by one (a rename keeps the mark of the server
and the tools that ask first, and drops those), whatever took it out of the file: this panel,
switching a feature such as Understory off, or an edit made by hand. The portal
remembers which servers it last saw in the file, so an edit made by hand is
noticed the next time the tools are listed or a chat starts, and one made while
the portal was stopped when it starts again. A file that cannot be read takes
nothing out, and nor does one that is not there, as for a moment while an editor
or a script puts a new one in its place: the file there next is compared with the
servers last seen. Only this file's servers count: one a project's own
`.pi/mcp.json` brings is not judged. The first time the portal looks at the file
it has nothing to compare it with, so a tool left behind by a server taken out by
hand before then stays listed. To be rid of it, add the server again under its
name here, with any entry, and remove it.

::: tip pi has its own commands
`pi mcp list` connects to every server and prints what is wrong with it,
`pi mcp add` and `pi mcp remove` change the file, and `pi mcp login <name>` signs
in to a server that asks. They read the same `mcp.json`.
:::

## With `EXECUTOR=container`

The pi that runs in the container is pi's command line: it reads the same
`mcp.json`, and the portal's marks, threshold and `tool_search` are not there. So
every server the portal writes carries an `exposure` in the file (`deferred`
unless an extension or a mark says `direct`), and pi's own tool search finds its
tools. A mark set in Settings → Tools is said in the file as well, `lazy` as
`deferred` and `direct` as `direct`.
