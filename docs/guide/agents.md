# Agents

An agent is a character with a memory: a home folder holding its `SOUL.md`
(who it is), `PrimaryUser.md` (who it works for) and `MEMORY.md` (what it has
learned). A chat started in an agent's home talks to that agent, with those
files as its context.

The portal starts with one, the **first agent**, whose home is `AGENT_HOME`.
You can add as many more as you like, each with its own character, memory and
files.

## Making one

The **Agents** page shows a card for each agent, with its avatar and name and
how many chats it has. **New agent** asks the same two questions as the first
setup: who it is, and who it works for. Its home is made in `agents/` beside the
first agent's home, named after it (`agents/research-bot` for *Research Bot*;
accents are dropped, so *Jürgen* is `agents/jurgen`, and a name in another
alphabet is `agents/agent-` and a short code), and its files are written there.
The name is kept in the folder, in `.agent-name`. A folder that was kept when an
agent of the same name was deleted is taken up as it is: the files in it stay as
they were, and only the ones that are missing are written. When that means the
answers you gave were not written to `SOUL.md` or `PrimaryUser.md`, the agent's page
says so when it opens. A folder kept by an
agent of another name is left alone: the new one gets the next free name,
`agents/<name>-2`.

A card opens that agent (`/agents?agent=research-bot`), with **New
conversation** to start one with it and six tabs: **Conversations**,
**Activity** (what its heartbeat noticed, with the number unread),
**Heartbeat**, **Tools** (see [below](#tools)), **Skills** and **Files** to edit. The tab is kept in the link (`&tab=files`). Its avatar is at
the top beside its name; the palette on it opens the avatar customizer. Each
agent's avatar is its own, and voice mode shows the avatar of the agent the
chat is with (the first agent's for a chat in a project). Its
name, with the pencil beside it, renames it; the folder keeps its name, and
`.agent-name` in it takes the new one.
**Agents** at the top goes back to the cards.

The **Files** tab edits `SOUL.md`, `PrimaryUser.md`, `MEMORY.md` and `WATCH.md`.
The agent writes these files too, `MEMORY.md` above all, so a save made from a
copy the agent has changed since is not applied. The tab says "This file changed
after you opened it" and offers **Load the new version** or **Save mine anyway**.
A file that is a link is left alone: it is neither shown nor written through, and the tab says so instead of offering an editor. It counts as there, so an agent whose `SOUL.md` is a link that leads nowhere (by a path that only the container knows) is not asked to be set up again. When a new agent's folder already has such a link, the note on its page says the answers were not written to it and that it is left as it is.

## Its voice

With the voice add-on installed, the avatar customizer (the palette on the
agent's avatar) has a **Voice** menu under the preview: the voice the agent
speaks with in voice mode, saved with **Save avatar**. **As in the voice settings** follows the
voice chosen in Settings; a designed voice or one from the voice library is the
agent's own. **Add voice** at the end of the menu adds a voice to the library,
a clone from a recording or one designed from a description, and gives it to
the agent. A chat in a project shows the first agent's avatar and speaks with its voice.
A library voice that is deleted is no longer any agent's, and those
that had it speak as the voice settings say again.

## Its heartbeat

An agent can look around on its own. It is off until you choose how often, on
the **Heartbeat** tab: every 30 minutes up to once a day. The same tab has the
hours it keeps quiet and **Look now**.

The quiet hours are read on the portal's clock, not on your browser's, and the
tab names its time zone next to them. In the container image that is UTC until
you set `TZ`, such as `Europe/Berlin` (see [Deploying](/guide/deploying#environment)),
so hours of 22:00 to 07:00 typed in another zone would otherwise be kept in that one.

What it looks at is its `WATCH.md`, the fourth file under **Files**: what to keep
an eye on, and what counts as worth telling you. It is not context for its
chats; only a look reads it. An agent with an empty one has nothing to watch.
It is as good as an instruction to the agent, so a colleague's or guest's rule
for writing files [cannot reach it](/people/roles#what-a-colleague-may-do).

A look is held to reading. It runs as the role `heartbeat`, which may read
files and leave notes, and nothing else: no commands, no edits, no messages,
and no browser. To let it run a command, add it under **Commands it may run**,
for example `gh pr list*`. A command runs only as written there, with `*` where
it varies, and a pipe, a redirect or a second command makes it something else.
Those commands are for every agent's heartbeat, and show in **People** as
rules for every agent's heartbeat. A rule for all roles applies to it too.

What it notices lands in **Activity** as notes; the tab and the agent's card
show how many are unread. A note marked urgent also goes to the
channel routines report to, when there is one. It comes into that chat as a
routine's report does, wrapped as data, since the look read whatever `WATCH.md`
names. Most looks find nothing, and say nothing.

A look never gets in the way: it waits while any chat or routine is working,
and **Look now** is refused until they are done,
since a home lab has one model to share, and one agent looks at a time. Each
agent looks in one conversation of its own, so it remembers what it already
told you. A look that a restart cuts off shows as "Interrupted by a restart",
and one you stop with Stop in its chat as "Stopped", until the next one. Looks need the host executor; under the container executor nothing
would hold them to reading, so they do not run.

## Tools

The **Tools** tab is the same list a chat's tools control shows, grouped the same
way. What you switch there is what every chat in the agent's home starts with, and
every run it does on its own: its heartbeat, and the routines that run in its home.
It is saved as each switch is flipped. The switches are exceptions to Settings →
Tools, both ways, so a tool the agent never mentioned still follows the default: an
agent that should never run shell commands switches `bash` off here, without
touching any other agent.

A project and a routine come after the agent and can switch a tool again for their
own; a chat's own switch has the last word. Chats in a project are not in any agent's
home, and follow the project. See [Routines](/guide/routines#tools) for the order of
all the layers.

## In the sidebar

Each agent's home is a folder in the sidebar and on the Sessions page, named
after the agent. The first agent's has the house icon, the others a robot. The
**+** on a folder's line starts a chat with that agent. A conversation started on the Agents page
is listed there too; conversations that came through a channel are on the Agents
page only.

## Channels and routines

A channel talks as one agent: the first, unless you choose another under
**Talks as** in the channel's settings. Its conversations happen in that
agent's home, with its character and memory. Moved to another agent, a channel
starts new conversations there; moved back, it picks up the ones it had.

A routine can run in any agent's home: choose the agent under **Runs in**.

## Deleting one

The bin next to an agent's name deletes it. Its chats are stopped and deleted
with it, and so are the [background jobs](/guide/extensions#subagents-and-background-jobs) running in its
folder (a dev server, a watcher), whichever way its folder goes: nothing could show
or stop them afterwards. The dialog says so. It asks what to do with its folder,
and with it, its routines:

- **Keep its folder**: its files and memory stay, and so do the pictures its chats
  made, in the [Images page](/guide/images), and its routines, switched off. Make an
  agent with the name it had when it was deleted (its last one, if it was renamed)
  and it picks them all up again; a routine of its that is left on the Routines page
  meanwhile says that the agent whose home it was has been deleted.
- **Delete its folder too**: the folder and everything in it are removed, and its
  routines with it, so that an agent you make later under the same name starts clean.
  What its routines did stays in their chats, and a routine you make later under the
  same name does not continue them: it starts a conversation of its own.

The first agent cannot be deleted, only renamed. An agent a channel talks as
cannot be deleted until the channel is given another.

## Its name

The first agent is named after the heading in its `SOUL.md` when the portal
first starts with agents. Renaming any agent changes only what the portal calls
it; edit its `SOUL.md` to change what it calls itself.
