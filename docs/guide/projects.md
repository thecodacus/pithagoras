# Projects

Every chat works in a folder. Most chats do not need one of their own, so there
is a single **Home**, and **New** starts a chat there, unless you picked another
agent for new chats (see [Agents](/guide/agents)). Home is the first agent's own
directory: its SOUL.md, PrimaryUser.md and MEMORY.md are there, so in Home the agent
knows who it is and who it works for, and keeps its memory. A **project** is an extra
folder you make on purpose, with instructions for the agent in an AGENTS.md — and
only that — for work that should stay together.

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
| A project | The project's AGENTS.md, and nothing of the agent's own |

## The Projects tab

**Projects** in the sidebar lists the projects — not Home — with how many chats each
has and when one last moved.

- **Click a project** to open its latest chat, or start one if it has none.
- **New project** asks for a name and, optionally, instructions and tools, then creates
  the folder and opens a chat in it. "Cool Project" becomes the folder `cool-project`.
  A name that is taken, or `home`, is refused.
- **New chat here** (the plus on a row) starts another chat in that folder.
- **Instructions** (the document icon) edits the folder's instructions.
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

## Tools

A project can have tools of its own: **Tools** on its row lists the tools the portal has
seen registered, as a chat's tools control does (the picture tools together in one **Images** group), and what you switch there is what
every chat in the project starts with. "The research project never goes online" and
"the dev project always has the shell tools" are then said once, not at the start of
every chat.

There are three layers for a chat in a project, each an exception to the one before it:

1. **Settings → Tools** is the default for every conversation.
2. **The project** switches tools on or off against that default, for every chat in it.
3. **A chat** switches tools on or off against what its project leaves, from the blocks
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
