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
  An installed extension that registers a tool of one of these names, or
  `bash`, would have its own run in their place, as the portal: that tool is
  off in the chat instead, and the chat says which package took the name.
- **The environment.** Commands get a short list of variables: `PATH`, the
  language and terminal ones, and pi's own `PI_*` session variables. The portal's
  password, its secret and the provider keys are not among them, so `env` shows
  nothing worth taking. Each agent has a `HOME` and a `TMPDIR` of its own under
  `/data/sandbox-home`, so no cache or temporary file is shared between agents.
- **Subagents.** A subagent works in a chat of its own in its chat's folder
  ([Subagents](/guide/features#subagents)), whose commands run as that folder's
  user, as the chat's own do.

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
`AGENTS.md` is read as before, unless it is a link or the agent could not read
it (see [below](#paths)). A `.pi/SYSTEM.md` or `APPEND_SYSTEM.md` in it is
not, as pi leaves those out of an untrusted project too.

## Paths

Each rule gives a path an access level, which counts for everything under it.
The most specific rule decides.

| Access | The agent may | Put on the files as |
| --- | --- | --- |
| No access | nothing: not read it, list it or pass through it | group root, no permissions for group or others |
| Read-only | read it and run what is in it, not change it | readable and runnable by everyone, writable only by root |
| Read & write | everything | owned by the group `pi-sandbox`, writable by it; new files keep the group |

What you make in [Files](/guide/files) (a new file, an upload, a new folder) or
what the portal saves into a project follows the same rule: it gets the owner and
group of the folder it is made in, and is writable by that group where the folder is.
Under a read & write rule that is `pi-sandbox`, so the agent can edit it; in an
agent's own folder it is that agent's. It is not left to root, as it was.

The tools that read a file the agent names, as root, read it only where the
agent could read it itself: [Media](/guide/media)'s `show_image`, `show_video`,
`edit_image` and the frames `generate_video` starts and ends a clip with, which
read through the checks the portal gives every extension
([A chat's folder](/guide/extension-ui#a-chat-s-folder)), and a picture or a
clip a call gives that a channel sends on. A picture under a no-access rule is
refused to the agent, as `cat` would refuse it; you still see it in Files.

What the portal puts in the agent's prompt it reads the same way: the agent's
`SOUL.md`, `PrimaryUser.md`, `MEMORY.md` and `TEAM.md`, the `AGENTS.md` or
`CLAUDE.md` pi finds from the chat's folder up, and the `WATCH.md` a heartbeat
look is asked. One that is a link is left out, wherever it leads, and so is one
the agent could not read itself: a link the agent leaves in its home in place of
`MEMORY.md` does not put another agent's files, or the portal's own, in its
prompt. In a project linked to an agent, that agent's files are read as the
agent whose home they are in. The `AGENTS.md` in pi's own folder
(`/data/home/.pi/agent`) is yours, and is read as it is.

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
| `/data/backups`, `/certs` | no access | database backups, the TLS key |

What an extension keeps for itself, in `/data/extension-data`, is made for the
portal alone, closed to the agents: the [Browser](/guide/browser) extension's
local Chrome profile, with the browser's cookies and logins, is there. A policy
saved before Browser was an extension still has a `/data/browser-profile` rule,
for a folder the upgrade moved; it is said to be not there yet, does nothing,
and can be taken out.

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

- **MCP servers** that pi starts, and **an extension's own tools** that start
  programs, run as the portal's user.
- **The Terminal panel** is yours, not the agent's, and is not sandboxed.
- **What [Creator mode](/guide/creator-mode) installs** runs outside the sandbox
  by design, as the portal's user, its server half in a process of its own. The
  sandbox decides what of the agent's draft the install may read, and keeps the
  agent out of the copy that is installed.
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
