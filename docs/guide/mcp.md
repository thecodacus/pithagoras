# MCP servers

MCP is how the agent reaches tools it does not ship with — a filesystem server,
a GitHub server, a company's internal one. Support comes from the
[`pi-mcp-adapter`](https://pi.dev/packages/pi-mcp-adapter) extension; the portal
owns the configuration and the adapter does the connecting.

Settings → **MCP**. If the adapter is not installed the panel says so and
offers to install it, because until then nothing reads this configuration.

## Where it is written

`<agent dir>/mcp.json` — `/data/home/.pi/agent/mcp.json` in the container. The
adapter reads several files in precedence order; this is the pi-global one, so
it applies to every session in the portal. A project-local `.mcp.json` would
only reach one workspace, which is the wrong shape here.

The file holds the servers' keys, and the token the portal made for its own
memory, so it is readable by the account the portal runs as and no other. It is
written whole or not at all: a full disk leaves the file as it was.

Changes are read when a session starts. A session already running keeps the
servers it connected with, so restart it to pick up a new one.

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
`stdio` (a local process), `http` (a URL), or a Unix socket — exactly one of
them.
A name that another server has is refused, whether the server is new or renamed:
it would replace that one, with everything the form does not show.

**The file.** "Edit the file directly" at the bottom of the panel, for anything
the form does not cover: OAuth blocks, tracing, per-server timeouts. The form
preserves fields it does not show, so an edit made there is not lost by a later
edit in the form.

## Secrets

Do not put a token in this file. For stdio servers, reference the environment:

```
GITHUB_TOKEN=${GITHUB_TOKEN}
```

`${VAR}` is expanded when the server launches. For HTTP servers with a bearer
token, the form asks for the *name* of the environment variable
(`bearerTokenEnv`), not the token. OAuth credentials never touch the file at
all — the adapter stores them in the OS credential store.

## Tools, and how many of them

By default the adapter exposes one `mcp` proxy tool and the model asks it for
what it needs. That keeps the system prompt small no matter how many servers are
configured.

**Register tools directly** puts a server's tools in the system prompt instead,
costing roughly 150–300 tokens each. Worth it for a server with a handful of
tools the agent uses constantly; expensive for a server with sixty.

`Only these tools` / `Except these tools` take names or globs and are the way to
keep a large server from crowding the prompt.

## What the tool lists show

In the Tools lists (Settings → Tools, an agent's, a project's, a routine's, a
chat's) an MCP server is a group like any other: switched on or off as a whole
with the group's switch, or tool by tool. Every tool the server offers is listed,
whether the model gets it registered directly or reaches it through the `mcp`
tool, and a switch holds for both ways in: `mcp({ tool: "…" })` and
`mcp({ describe: "…" })` of a tool that is off are refused. With the adapter's
script mode on, `mcp_script` is refused while one of the servers' tools is switched
off, since a script says which tools it calls only as it runs.

The tools are read from the adapter's cache, so a server is listed once it has run
at least once, and only where the adapter is installed and on — for every chat,
or for a project that brings it in its own settings. Only the adapter's default
tool names (`<server>_<tool>`) are listed this way.

What the configuration says no to is not listed at all: a server switched off,
a tool left out by `Only these tools` or `Except these tools`, or one the server
no longer has. A chat that is running is told at once: one that had such a tool
loaded from before has it off from then on, through the `mcp` tool too. Nothing
is written down against it, so it comes back the way it was when the
configuration allows it again. A file that cannot be read is taken as it last
could be, so a typo neither hides a tool nor hands back one it had taken away.

A tool marked **cached** is listed from the adapter's cache: its server starts
only when one of its tools is first used (`lifecycle` lazy, the default), so the
list is what the server had when it last ran.

## Disabling

The toggle on each row sets `disabled: true` — the server stays configured and
visible but is never connected. Better than deleting a server you are debugging.
Deleting one, or renaming it, also takes its tools out of the Tools list, and a
chat still running with it has them off from then on, as with one switched off —
whatever took it out of the file, this panel or switching a feature such as
Understory off.

::: tip The adapter has its own commands
`/mcp` opens its status panel, `/mcp tools` lists what is available, and
`/mcp reconnect` refreshes a server. They work in the portal's command palette
like any other extension command.
:::
