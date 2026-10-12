# Memory and audit

Two pages in the sidebar for looking at what the agent knows and what it was
allowed to do.

## Memory

**Memory** appears in the sidebar while the [Understory memory add-on](/guide/features#memory-understory)
is on. It is the web view of the agent's memory: a bundle of markdown notes,
kept in folders and linked to each other.

**Notes.** Down the side, the folders and notes with their types, and a search
(*Search the memory*). Above them, the count of notes and folders and whether the
bundle is *conformant* to Understory's format; when it is not, the issues are
listed. Choose a note to read it: its type, tags, when it last changed, its text,
and links that open other notes here.

**Log.** What changed in the memory, newest first.

**Graph.** Every note is a point coloured by its type, its links are lines, and
notes nothing links to are ringed in red. **Query paths** shows the routes
Understory's own queries took. Drag to move, scroll or the zoom buttons to zoom,
click a note to open it. A memory of many hundreds of notes is laid out in fewer
passes, so that the page opens at once: the picture is rougher, and still shows
what is linked.

**Librarian.** The chat button under the notes opens Understory's own agent, the
one its web UI chats with: ask it what the memory holds, or tell it what to
keep. It reads and writes the notes with the same tools the agent has, and links
in its answers open the notes here. The side and the graph read themselves again
after an answer in which it used a tool. The conversation is kept while the page
is open, also while you look at a note; **Clear chat** empties it. **Stop**
(and Clear chat, or leaving the page) stops you listening to an answer under way,
not the librarian: Understory cannot be told to break off, so it finishes the
steps it has started, notes it writes included, and the page does not show
those. A new question waits until that is over ("still working on the previous
question"); reopen the page afterwards to see the notes. It is offered in the Understory the portal runs only,
like editing; the model that answers is the one that tidies the memory (see
[Opt-in features](/guide/features#memory-understory)).

What is open is in the address (`/memory?note=…`, `?view=log`, `?view=graph`,
`?view=chat`), so it can be linked to.

### Editing

In the Understory the portal runs, a note can be edited (title, type,
description, tags, text) or deleted from the pencil and bin over it. A note with
changes in it that are not saved is not left for another note, the log, the graph
or a refresh without asking **Discard your changes?** first. The browser's Back
and Forward, and a link to another page of the portal, cannot be asked: the note
keeps what you typed for as long as the portal stays open, and shows it again
when you open the note. The agent may have written the note meanwhile, so a note
that changed after you started editing it says so, before a save goes out:
**Load the new version** gives your edit up, **Save mine anyway** puts it over
what the agent wrote. A note that was deleted meanwhile says so instead, and
**Save mine anyway** writes it again; so does one that went while you were away
from it, which shows your edit instead of "not found". After a
change a window says what Understory's checks find — a link to nothing, a note
nothing links to, an index that misses something — and offers:

- **Rebuild the index** — every folder's `index.md` written anew, empty folders
  removed. No model.
- **Repair with the model** — the model mends links to nothing and wires in
  orphans. Only offered when there is something to repair; it takes as long as
  the model needs and costs tokens.

**Clear the log** empties the record of changes and the query paths; the notes
stay. **Clear the memory** deletes every note and folder and starts as a new
memory does. Both ask first and cannot be undone. A memory run elsewhere is read
only here, and has no librarian chat.

Setting Understory up — installing it, choosing the model that tidies it, the
nightly pass — is in [Opt-in features](/guide/features#memory-understory).

## Audit

**Audit** is in the sidebar too: the guard's record of what it refused, let
through or turned away, with filters. It is described under
[Sessions → Audit](/guide/sessions#audit).
