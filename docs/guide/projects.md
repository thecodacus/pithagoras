# Projects

Every chat works in a folder. Most chats do not need one of their own, so there
is a single **Home**, and **New** starts a chat there, unless you picked another
agent for new chats (see [Agents](/guide/agents)). Home is the first agent's own
directory: its SOUL.md, PrimaryUser.md and MEMORY.md are there, so in Home the agent
knows who it is and who it works for, and keeps its memory. A **project** is an extra
folder you make on purpose, with instructions for the agent in an AGENTS.md, for work
that should stay together. A project is a blank slate by default, so only that file
reaches its chats; you can have it work with one of your agents instead, see
[An agent for a project](#an-agent-for-a-project).

## Home and New

**New** in the sidebar starts a chat straight away, with the agent picked for new
chats (Home's agent by default, see [Agents](/guide/agents)): no dialog, no name.
The chat is called *New chat* until you send its first message, and is then named
after it (the first line, shortened). Rename it any time from the sidebar.

Home is the agent's directory, `AGENT_HOME` (`/data/agent-home` unless you set it) —
the same one the conversations on the Agents page work in, so they share the agent's
SOUL.md, PrimaryUser.md and MEMORY.md, and anything the agent keeps in Home chats is
there for the others. It lives outside the workspace root, so it is not a project:
it is not listed on the Projects tab, has no instructions of its own and cannot be
deleted. If the agent has not been set up yet, Home has none of those files and its
chats start without them.

| Chat in | The agent has |
| --- | --- |
| Home | SOUL.md, PrimaryUser.md and MEMORY.md (MEMORY.md not while [Understory](/guide/features#memory-understory) is the memory) |
| A project, blank slate | The project's AGENTS.md, and nothing of the agent's own |
| A project that works with an agent | The project's AGENTS.md, and that agent's SOUL.md, PrimaryUser.md and MEMORY.md (MEMORY.md not while Understory is the memory of the project) |

## The Projects tab

**Projects** in the sidebar lists the projects — not Home — with how many chats each
has and when one last moved.

- **Click a project** to open its latest chat, or start one if it has none.
- **New project** asks for a name and, optionally, instructions, an agent and tools, then
  creates the folder and opens a chat in it. "Cool Project" becomes the folder `cool-project`.
  A name that is taken, or `home`, is refused.
- **New chat here** (the plus on a row) starts another chat in that folder.
- **Instructions** (the document icon) edits the folder's instructions.
- **Agent** (the robot icon) picks the agent the project works with, and whether
  Understory is its memory, see [An agent for a project](#an-agent-for-a-project). A
  project with an agent carries *with* and its name on its row, and beside its folder in
  the sidebar.
- **Tools** (the blocks icon) sets which tools the project's chats start with, see
  [Tools](#tools). A project that does this carries a *tools* mark on its row.
- **Delete** removes the project: its chats and its folder, after a confirmation
  that says how many chats and files go with it. It is refused while a chat in
  the project is running; the background jobs running in its folder are stopped with it, and the
  confirmation says so. When the folder holds git repositories — it is one,
  has submodules, or has repositories cloned into its subfolders — the
  confirmation also lists what only the folder holds: uncommitted changes (a
  new folder counts once), commits no remote has, and stashes. It then asks
  again in its own words, and the server refuses the delete without that. A
  repository that cannot be read is treated the same. Commits that only a tag
  holds are taken for ones a remote has. A remote that is itself inside the
  folder is not counted as a copy, since it goes too. A project that sits inside a repository — the workspace root
  being one — counts that repository's changes under the folder. Files git
  ignores (such as `.env`) and bare repositories are not looked at, and what
  is in `node_modules`, `.venv`, `venv`, `__pycache__`, `.tox`, `.mypy_cache`
  or `.cache` is not looked through, though one that is a repository itself
  counts. With a repository's data goes what the HEAD of each of its worktrees
  holds, those elsewhere too.

## Chats inside a project

In any chat, `/new` or `/clear` starts a fresh chat in the same project. The
sidebar groups the chats by folder — Home is the agent's own directory, a
project is a folder under the workspace root. A chat's full path is not drawn
under its title, in the sidebar, on the Sessions or Projects page or beside a
terminal; the pin button in the Files panel's header shows it.

Deleting a chat never deletes a folder — only pi's conversation file for it, which is not part of any project. Folders are only made by **New project**
and only removed by deleting a project.

## Instructions

A project's instructions are the folder's `AGENTS.md`, which pi reads by itself
when a chat starts in it. The editor and the file are the same thing: edit it in
the portal or in the folder, whichever is nearer. Saving an empty text removes the
file. Home has none of its own.

The agent works in the folder and may write `AGENTS.md` too. A save made from a
copy that has changed since is not applied: the dialog says "This file changed
after you opened it" and offers **Load the new version** or **Save mine anyway**.

Chats started after a change pick it up. A chat that is already open does after
`/reload`.

## An agent for a project

An agent and a project are separate things: the agent is a character with a home, a
project is a folder of work. So a chat in a project does not know the agent's soul,
user or memory unless you say so. **New project** has an **Agent** menu with two
choices:

- **None — a blank slate**, which is the default and how every project was before: the
  chats have the project's AGENTS.md, and nothing of any agent's.
- **One of your agents.** The chats in the project then start with that agent's
  `SOUL.md`, `PrimaryUser.md` and `MEMORY.md`, read from the agent's home, next to the
  project's AGENTS.md. Its skills are the project's too, and voice mode shows its
  avatar and speaks with its voice. The agent is still the same one: a project does not
  copy anything, so a change to its `SOUL.md` reaches the project's next chat.

**Agent** on the project's row changes the choice later, in either direction, and saves
it as it is picked. Chats started after the change have it; a chat that is open has it
after `/reload`. If the agent is deleted, its projects are blank slates again.

The files are read from the agent's home and never from the project's folder, which the
agent may write to: a `SOUL.md` it leaves there is only a file. A project that works with
no agent reads none of them, from its folder or anywhere: it has only its AGENTS.md, and
no [Understory](/guide/features#memory-understory) either, since there is no agent whose
memory it would be.

**Understory as memory** is one more switch in the same place, shown where
[Understory](/guide/features#memory-understory) holds the agent's memory and the project has an
agent: a blank slate has none, and no Understory. (An extension other than Understory that holds
the agent's memory is named in its place.) While it is on, Understory is the
project's memory, as it is in Home: the agent is told how to use it and `MEMORY.md`
is left out. Off, the chats in this project do not get those instructions, and a project
with an agent has the agent's `MEMORY.md` instead. It decides what the chats are told
and handed, not what they can reach: the Understory tools stay unless you switch them
off in the project's [Tools](#tools). Home keeps Understory, and so does a project with an agent unless it is switched off.

The choice is kept in the portal's database by the project's name, not as a file in the
folder, for the reason the tool switches are (see [Tools](#tools)), and goes when the
project is deleted. Over the API, `GET` and `PUT /api/projects/:name/agent` read and
change `{ agent, memory }`, with `memoryAvailable` saying whether anything holds the agent's
memory now, and `POST /api/projects` takes the same two fields and checks them before any
folder is made.

The agent's heartbeat and its conversations on the Agents page stay in its home and are
not changed by this.

## Tools

A project can have tools of its own: **Tools** on its row lists the tools the portal has
seen registered, as a chat's tools control does ([Media](/guide/media)'s picture and video tools together in its group, `pithagoras-media`), and what you switch there is what
every chat in the project starts with. "The research project never goes online" and
"the dev project always has the shell tools" are then said once, not at the start of
every chat.

There are four layers for a chat in a project, each an exception to the one before it:

1. **Settings → Tools** is the default for every conversation.
2. **The project** switches tools on or off against that default, for every chat in it.
3. **The chat's mode** can switch tools for every chat started in it
   ([Modes](/guide/sessions#modes)): Code mode switches `codemode` on.
4. **A chat** switches tools on or off against what its mode leaves, from the blocks
   icon beside the composer.

An agent's own switches ([Agents](/guide/agents#tools)) are for the chats in its home,
which is never in a project. A routine that runs in the project has a layer of its own
between the project and its run's chat ([Routines](/guide/routines#tools)).

What a project stores is only where it disagrees with the portal-wide default, so a tool
the project never mentioned still follows Settings → Tools. A chat belongs to a project
when its folder is the project's or is inside it, judged by where the path really leads.
Chats in Home belong to none, and are as before.

A project that has not said anything changes nothing, which is every project there was.
When a project starts to, a chat that already has switches of its own **keeps them as
they are**: a tool it switched on or off is its decision, and stays so whatever the
project says. The tools it never mentioned follow the project from then on. A chat that
was running is told at once and has it from its next message. A routine that runs in a
project gets the project's tools like a chat does.

The tools can be chosen as the project is made: **New project** has the same list in a
**Tools** section under the instructions, shut until you open it and starting from the
portal-wide default, and what is switched there is stored with the project. Left alone, the project says nothing about tools. If the folder is
made and its tools cannot be stored, the page says so and stays where it is, rather than
opening the chat over the message; **Tools** on the project's row is where to choose them
again. Over the API, `POST /api/projects` takes the same `toolsOff` list as the tools
endpoint, and checks it before any folder is made.

The settings are kept in the portal's database, by the project's name, and not as a file
in the folder: the agent works in that folder and can write to it, and which tools it
has is not something it should be able to give itself back. They go when the project is
deleted. They do not travel with a copy of the folder. As with the other tool switches,
there is nothing to switch with `EXECUTOR=container`, where the portal never sees what
pi registered.

## Folders that already exist

Any folder directly under the workspace root, other than Home, is a project, whether
the portal made it or not, so folders and chats from before this existed are listed as they are.
The instructions are whatever AGENTS.md they already have.
