# Kanban

**Kanban** (`extensions/kanban`, the package `pithagoras-kanban`) is boards of
cards in columns, for you and the agents to keep track of work: what is to do,
what is going on, what is done. It has a page of its own in the sidebar,
**Boards**, the same board in a panel beside a chat, and tools for the agent,
so that an agent can keep a board up to date as it works and you can watch it
do so.

It is not installed by default. Install it from Settings → Extensions →
Discover, where the extensions that come with the portal are listed. Like any
other, it is switched off or removed there, and the page, the panel and the
agent's tools go with it. The boards stay in its folder of the data folder for
when it is back.

## Boards

**Boards** is in the sidebar's **Extensions** group, at
`/x/pithagoras-kanban/boards`. The board it shows is in its address
(`?board=b-7k2m`), so a link opens that board and **Back** goes through the
boards you looked at. Opened without one, it shows the board you last opened
in this browser, or the first.

There can be many boards. The switcher at the top chooses one; its menu
(**Board actions**) makes a new board, renames one and gives it a description,
lists the archived cards, and deletes the board, after asking, with all of its
cards (the question is one about deleting: Settings → This browser can switch
it off). A new board has the columns **To do**, **In progress** and **Done**.

A board's columns are side by side, and scroll sideways when there are more
than fit. On a phone the board is one column wide, and snaps from one column to
the next as you swipe. A column's menu renames it, moves it left or right, and
deletes it: an empty column at once, after asking; one with cards once you say
which column they go to. **Add a column** is after the last one.

A card has a title, a description (plain text, or Markdown, shown as it is
written), labels, an assignee (a person or an agent, as you write it) and a due
day. A card that is due before today is marked **Overdue**. **Add a card** at
the bottom of a column adds one there: <kbd>Enter</kbd> adds it and leaves the
field for the next, <kbd>Escape</kbd> closes it.

### Moving cards

Drag a card to another place in its column or to another column. A line shows
where it will go; let go there. With a mouse it moves as soon as you drag it;
with a finger, hold it still for a moment first, since a finger that moves at
once scrolls the board. Near an edge the board scrolls with the drag; on a
phone, where it shows one column, hold the card near the edge and it turns to
the next column.
<kbd>Escape</kbd>, or letting go outside the columns, leaves it where it was.

From the keyboard, each card's menu (the button on the card, **Actions for
card …**) has **Move up**, **Move down** and **Move to** each other column, and
the keyboard stays on the card in its new place. The menu also opens the card
and archives it.

### A card's dialog

A click on a card opens it: every field, the column it is in, **Archive** or
**Restore**, **Delete** (after asking: it is gone for good, where archiving
keeps it), and its **Activity**, newest first. The activity says who did what:
**You**, or **Agent** with the chat whose tool did it (a link to that chat),
what changed, where the card was moved from and to, and the notes written on
it. **Add note** writes one of yours. Only the latest fifty lines of a card's
activity are kept.

Archived cards are out of their column. **Archived cards** in the page's header
and in the board's menu lists them, to open or to restore: a restored card goes
to the bottom of its column.

### Changes made elsewhere

While the page is visible it asks every three seconds whether the board has
changed, and at once when you come back to it; the answer is only the board's
version until something changes. So what an agent does, or what you do in
another tab, shows up by itself. A card you are dragging is not moved under
you: what came meanwhile shows once you let go. A card's dialog stays open,
and what you typed in it stays yours until you save it; the rest of it shows
what is there now.

## Beside a chat

**Board** in a chat's header opens the board in a panel beside the
conversation, docked, floated and sized like Files and Git. It opens on the
board this chat's agent last worked on with a kanban tool, or else the one you
last opened on the Boards page, or the first. Narrow, its columns are one under
another and the panel scrolls; everything else is as on the page, the switcher,
dragging, the card menu and the dialog included.

Each kanban call of the chat that ends has the board asked for at once, so you
see the agent's work as it goes. Until you choose a board in the panel
yourself, it follows the agent to the board it works on.

In the conversation, each kanban call is a card of its own once it is done: what
it did (**Moved “Fix the flaky login test” from In progress to Review**), the
board, the card's id, **Open the board**, which opens the panel on that board,
and **Details**, the call as the portal shows any other.

## What agents can do

With the host executor (pi runs in the portal's own process) each chat's agent
has these tools, on by default and listed in Settings → Tools in the group
`pithagoras-kanban`, where they can be switched off or made lazy like any
other. With `EXECUTOR=container` the agent has none: the runner image does not
get extensions.

| | |
| --- | --- |
| `kanban_boards` | The boards, with how many cards each column holds |
| `kanban_board` | One board: its columns and their cards with ids, labels, assignee, due day, description and latest note. It can be narrowed to a column, a label or an assignee; archived cards only when asked |
| `kanban_create_board` | A new board, with columns named or the default ones |
| `kanban_add_column` | A column, at the end or at a place |
| `kanban_add_card` | A card, at the bottom of the first column or where it is told |
| `kanban_update_card` | Any of a card's fields, a note for its activity (progress), and restoring an archived card |
| `kanban_move_card` | A card to a column, at the bottom or at a place, with a note |
| `kanban_archive_card` | A card that is done with, with a note |

A board is named by its id or its exact name, a column by its id or its name,
and a card by its id. Ids are short, so that an agent can type them: `b-` for a
board, `col-` for a column and `c-` for a card, then four letters and digits.
A card's id names it on whichever board it is. What a tool answers is text an
agent can act on, with the ids it needs next; a refusal says what is there
instead (`The board "Release 0.2" has no column "Later". Its columns: To do (col-…), …`).

What an agent does is in the card's activity as its chat's. Agents **cannot
delete** a board, a column or a card: no tool does, and that is yours, on the
page. An agent archives a card instead, which you can restore.

## Where the boards are kept

In the extension's folder of the portal's data folder,
`extension-data/pithagoras-kanban/`, where no agent can reach them except
through the tools: a JSON file for each board under `boards/`, and
`index.json` with the order of the boards and the board each chat's agent last
worked on. Each file is written whole beside its place and renamed over it, so
a crash leaves the one before; every write, whether yours or an agent's, is
made one after the other. Include the data folder in backups.
