# Sandbox

The [guard](/guide/security) reads what the agent asks for and refuses what
looks wrong: a path with `.secrets` in it, a command that pipes into a shell.
That stops the plain way to a file, not the roundabout one. A script the agent
writes and then runs, a path put together from pieces, or a symlink all ask for
something else, and each reaches the same file.

The sandbox closes those ways too. With it on, everything an agent does to the
system runs as an unprivileged user of that agent's own, and the operating
system decides each step by the files' own permissions. A script, an
interpreter or a link the agent makes runs as that user as well, and meets the
same permissions. It is off until you switch it on in **Settings → Sandbox**.

## What runs in it

- **The shell.** Every command pi's `bash` runs, and whatever that command starts.
- **pi's file tools.** `read`, `write`, `edit` and `ls` do their reading and
  writing as the agent's user. `grep` and `find` run whole as that user too.
- **The environment.** Commands get a short list of variables: `PATH`, the
  language and terminal ones, and pi's own `PI_*` session variables. The portal's
  password, its secret and the provider keys are not among them, so `env` shows
  nothing worth taking. Each agent has a `HOME` and a `TMPDIR` of its own under
  `/data/sandbox-home`, so no cache or temporary file is shared between agents.

## One user per agent

Each agent runs as `pi-agent-` followed by eight characters of a hash of its id,
shown on its page in the portal. A rename keeps it. The user and a group of the
same name are made the first time the agent needs them, with an id from 10100 up
that the portal keeps, so a container rebuilt from the image gets the same ids
back. Every agent's user is also in the group `pi-sandbox`, which owns what they
share: the projects.

An agent's home belongs to its own group, so one agent cannot read another's
memory, notes or skills, nor reach them through the other's processes or
temporary files. The folders the homes are in, `/data/agents` and
`/data/sandbox-home`, can be passed through but not listed. A chat in a project
runs as the first agent's user.

## What a chat's folder may load

pi and the MCP adapter run inside the portal, as root, and the folder a chat
works in is the agent's to write. So while the sandbox is on, nothing that would
run is taken from that folder: pi treats it as an untrusted project and leaves
out its `.pi/extensions`, its packages and its `.pi/settings.json`, and the MCP
adapter reads no `.mcp.json` or `.pi/mcp.json` there, nor what those import. MCP
servers come only from your own config (Settings → MCP), and work in a folder of
the portal's, `/data/sandbox/mcp`.

The folder's skills, in `.pi/skills` and in `.agents/skills` up to the root of
its repository, are still loaded: a skill is text the model reads, and what it
says to run, the agent runs with its own tools, inside the sandbox. The folder's
`AGENTS.md` is read as before. A `.pi/SYSTEM.md` or `APPEND_SYSTEM.md` in it is
not, as pi leaves those out of an untrusted project too.

## Paths

Each rule gives a path an access level, which counts for everything under it.
The most specific rule decides.

| Access | The agent may | Put on the files as |
| --- | --- | --- |
| No access | nothing: not read it, list it or pass through it | group root, no permissions for group or others |
| Read-only | read it and run what is in it, not change it | readable and runnable by everyone, writable only by root |
| Read & write | everything | owned by the group `pi-sandbox`, writable by it; new files keep the group |

A path no rule names keeps the permissions it has. For most of the system that
means readable and not changeable. The agents' homes and their `HOME` folders
are not rules: each belongs to its own agent, as above.

The defaults:

| Path | Access | Why |
| --- | --- | --- |
| `/workspaces` | read & write | the projects |
| `/data/bin` | read-only | commands on `PATH`: run, not changed |
| `/data/.secrets` | no access | keys for trusted commands |
| `/data/portal.db` | no access | the portal's database and settings |
| `/data/home` | no access | the portal's `HOME`: pi's `auth.json`, SSH keys, packages |
| `/data/sessions` | no access | every chat's transcript |
| `/data/browser-profile` | no access | the browser's cookies and logins |
| `/data/backups`, `/certs` | no access | database backups, the TLS key |

**Save and apply** sets owners and permissions at once. Under a read or write
rule it changes every file below it, which can take a while in a big workspace.
A read & write rule on `/workspaces` changes the group of your projects' files
to `pi-sandbox` (gid 10010), on the host as well.

## Trusted commands

Some jobs need a key the agent must not read: a script that reads a project
board or a channel's statistics with an API token. A trusted command is how:

1. The script goes in `/data/trusted`. The agent can run it and read it, not
   change it.
2. Its key goes in `/data/.secrets`.
3. In **Settings → Sandbox → Trusted commands**, add the command's name.

The script then runs as a second user, `pi-tools`, the only one that can read
`/data/.secrets`. The portal puts a small wrapper on `PATH` under the command's
name, so the agent types the name as before. The switch to `pi-tools` goes
through a `sudo` rule pinned to that one script, checked with `visudo` before it
is installed. The agent cannot run anything else as `pi-tools`, and cannot change
the script to make it do something else.

A script already in `/data/bin` under that name is moved into `/data/trusted`
when you apply.

A trusted command must not print its own key: what it prints, the agent reads.

## Not covered yet

- **Subagents** start a separate pi process, as the portal's user.
- **MCP servers** that pi starts, and **an extension's own tools** that start
  programs, run as the portal's user.
- **The Terminal panel** is yours, not the agent's, and is not sandboxed.
- **The network.** What the agent can read, it can still send. Limiting where
  it may connect is a separate step.

With the [container executor](/guide/deploying), each chat runs in a container
of its own, and this page does not apply.

## Requirements

The sandbox needs the portal to run as root on Linux, as the Docker image does:
it has to change to another user, make each agent's user and set permissions.
The image makes the user `pi-tools` (uid 10002) and the group `pi-sandbox`
(gid 10010), and installs `sudo`, `ripgrep` and `fd-find`; the agents' users are
made with `useradd` and `groupadd` as they are needed. On another install,
create the same user and group and install those packages; the page says what
is missing.
