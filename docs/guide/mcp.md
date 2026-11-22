# MCP servers

MCP is how the agent reaches tools it does not ship with — a filesystem server,
a GitHub server, a company's internal one. The portal runs pi's own MCP
support: pi reads `mcp.json`, connects the servers and registers their tools,
each named `mcp__<server>__<tool>`. The portal owns the page that edits the file,
and makes a server's tools a group in Settings → Tools like any other.

Settings → **MCP**.

## Where it is written

`<agent dir>/mcp.json` — `/data/home/.pi/agent/mcp.json` in the container. It is
the user-level file pi reads for every session in the portal. A trusted
project's own `.pi/mcp.json` is read as well, for that project's chats: it can
bring servers of its own and switch one of yours off (`enabled`), but not define
one of yours again under the same name, and not switch on one you have switched
off or hidden (it would start with your command, environment and headers). With the [sandbox](/guide/sandbox) on,
a project's file is not read at all.

The format is the one the other MCP clients share, and pi's own:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/data"]
    },
    "docs": {
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer ${DOCS_TOKEN}" },
      "description": "Search and read the product documentation"
    }
  }
}
```

A server is a local process (`command`, `args`, `env`, `cwd`) or a URL
(`url`, `headers`): exactly one of them. `timeout` is the request timeout in
seconds, `description` says in a sentence what the server offers (the search for
tools ranks its tools by it), and `enabled: false` keeps an entry that is never
connected. What pi accepts is pi's own check: an entry it does not accept is
shown in the list with the reason, and pi skips it while the others connect. A
server the move from `pi-mcp-adapter` left off because of a key pi does not read
(`includeTools`, `excludeTools`, `approveTools`, `exposeResources: false`) says so in
its row, and cannot be switched on before the key is taken out or written in pi's
words (an empty `approveTools` is no key to speak of).

The file holds the servers' keys, and the token the portal made for its own
memory, so it is readable by the account the portal runs as and no other. It is
written whole or not at all: a full disk leaves the file as it was. It is plain
JSON, as pi reads it: a comment in it makes pi skip every server, so the editor
refuses one.

An extension can write a server of its own into the file, when you switch it on
from the extension's page. The server is listed and switched here like any other.

A change made here applies when a chat starts or is loaded again: the chats
that are idle are loaded again as you save. A chat that is working keeps its
servers until its turn ends, a server you switched off or deleted included.

## Adding a server

Three ways, in descending order of effort:

**Paste JSON.** Every MCP project's README hands out the same snippet. The
import accepts a whole config, a bare `mcpServers` map, or a single server
object. A server in the snippet whose name you already have is not imported over
it: it is listed as skipped, and the one you have stays as it is. So is one pi
would not take, with pi's reason.

**The form.** Name, transport, then the fields for that transport. A name that
another server has is refused, whether the server is new or renamed: it would
replace that one, with everything the form does not show. So are two names that
differ only by a dash and an underscore (`my-notes` and `my_notes`): pi gives
their tools the same prefix and connects only one of them. The form keeps what
it does not show, an `oauth` block or a `toolExposure` set by hand. An `auth`
block (`"auth": { "provider": "…" }`, which makes pi send the portal's key for a
model provider to the server as its bearer token) is not written by the form or the
import: write it in the file yourself if that is what you mean.

**The file.** "Edit the file directly" at the bottom of the panel, for anything
the form does not cover.

## Secrets

Do not put a token in this file. Reference the environment: `${VAR}` in an
`env` or `headers` value is expanded when the server connects, and a value that
is `!command` runs the command, which must make up the whole value:
`"Authorization": "!echo Bearer $(gh auth token)"`.

A server that wants OAuth and answers 401 is not signed in from here: signing in
to a remote MCP server from the portal is a separate piece of work
([#372](https://github.com/thecodacus/pithagoras/issues/372)). Until then, give
it a token in a header.

## Tools, and how many of them

A server is a group of tools in [Settings → Tools](/guide/extensions#lazy-tools)
like any other, filed under the server's name. It has the same controls:

- **On or off**, as a whole with the group's switch, or tool by tool, as for any
  tool. Switching a server's tools off in a chat does not stop the server (that is
  the server's own switch in Settings → MCP), so the tools can be switched on again
  in the chat that has it.
- **Auto, Lazy or Direct.** *Direct* keeps the tools in the model's list, 150–300
  tokens each. *Lazy* keeps them out of it: the model finds and calls them through
  `tool_search`, and a server of sixty tools costs the prompt nothing until it is
  needed. *Auto*, the default, leaves it to the threshold, which takes the largest
  groups out of the list when it holds more than 3,000 tokens or 20 tools, as it
  does for any group of tools.

The size of a server's tools is what a chat last saw of it: the portal keeps that
(a count and a size for each server, and the tools to switch) from the chats that
registered its tools. A server no chat has seen yet counts as lazy until one has.

pi's own `exposure` in an entry (`direct`, `deferred`, `codemode`) is not what
the portal goes by: the model is given a server's tools by the mark above, and the
tools are always registered for the chat. So pi connects every server that is on
when a chat starts, and the first message waits for a slow one for up to ten
seconds; a server slower than that is found through `tool_search` once it has
connected. `exposure: "hidden"` is kept: the
server's tools are not reachable. `toolExposure` in an entry, which pi reads to
give single tools another exposure, is kept as written; a tool it calls `deferred`
is direct for pi, and behind `tool_search` where the server is lazy. pi takes
an exact tool name in `toolExposure` before a pattern, and the first pattern that
matches; where a trusted project's own `.pi/mcp.json` overrides a server of yours,
only the tools you hid are kept of your `toolExposure`, so one you hid by a
pattern and showed by its exact name is hidden there.

pi's three tools for a server's resources (`list_mcp_resources`,
`list_mcp_resource_templates`, `read_mcp_resource`) are a group of their own, "MCP
resources". They are switched on and off like any tool, and reach every connected
server by an argument. A server whose tools a chat has all switched off is off for
these tools in that chat too: a call that names it is refused, and so is a listing of
every server's resources while one server is off (the agent is told to name the server
it wants). A server with a tool still on is read as before.

A server no chat has seen a tool of (it does not start, or has none) is counted as lazy
and is named to the model as a place to search, and is not listed in Settings → Tools.

## What the tool lists show

Switching a server's tools off as a group in a list (a project's, an agent's, a
routine's) writes down the tools the portal knows of it then. A tool the server offers
later is on there, behind `tool_search` where the server is lazy, as it is for any
group. A server stays connected whatever a chat has switched off of its tools, so that
they can be switched on again: switch off the server itself in Settings → MCP where it
must not be reached at all.

In the Tools lists (Settings → Tools, an agent's, a project's, a routine's, a
chat's) an MCP server is a group like any other. Every tool a chat has seen of it
is listed. A server that is switched off here (`enabled: false`), or that is not
in the file, is not listed, though what was switched for its tools is kept, for
when it comes back. A server a project's own `.pi/mcp.json` brings is listed in
the chats that have it, and in no other list.

## Disabling

The toggle on each row sets `enabled: false` — the server stays configured and
visible but is never connected. Better than deleting a server you are debugging.
Deleting one also takes its tools out of the Tools list.

## Trust

What a server hands back is somebody else's words — an issue comment, a mail body
— and is marked and checked as a web page is, unless you count the server as your
own in [Settings → Guard](/guide/security). The guard knows a tool is a server's
by the namespace pi registered it under, never by its name.

::: tip pi's own commands
`/mcp` lists the servers and their state in a session, and `pi mcp list` checks
the file from a shell (it connects every server and prints what it found).
:::
