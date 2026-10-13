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

**Graph.** The notes and their links, drawn flat (**2D**) or in space (**3D**);
the switch is in the graph's toolbar, and this browser remembers the choice.
Both show the same notes, filters and search.

- **2D** is the one to read. Every note is a small glowing dot coloured by its type, the same size
  on the screen at every zoom, as its name is;
  its links are lines with a slow current along them, and notes nothing links
  to are ringed in red. A note's name is written beside it wherever there is
  room: names never lie on each other or on another note, so in a crowded part
  some are left out, and zooming in brings them back. Point at a note (or reach
  it with Tab) and it lights up with the notes it links with, the rest steps
  back, and a card gives its whole title, type, link count and description.
  Click a note to open it. The note you opened last is ringed and centred when
  you come back to the graph; click the background to let it go. Drag to move,
  scroll or the zoom buttons to zoom. The glow and the motion stop for a
  memory of more than 300 notes and for anyone who asks their system to reduce
  motion. **Query paths** shows the routes Understory's own queries took.
- **3D** is the one to look at. Nothing is written on it: a note's name shows
  in a small card only while you point at it or reach it with Tab. Click a note
  to open it; scroll or pinch to zoom, and the target button sets the view
  back. It comes in five looks, chosen beside the switch. Each places the notes
  in its own way, moves in its own way, and hides a secret:
  - **Constellation**: the notes are stars where their links pull them, the
    links the lines of the constellations, and the sky turns slowly. A drag
    flings it and it coasts; choosing a note flies to its star.
    *Secret:* double-click the empty sky for a meteor shower.
  - **Galaxy**: a spiral galaxy seen at a slant, its bright core the chosen
    note (until you choose one, the most linked note). Every other note is a
    star out along an arm as far as it is links away, on the arm of its type,
    in clusters with the notes as far out as it; notes no link reaches are
    scattered through the halo. The disc turns slowly round the core, its arms
    glowing and crossed by dark dust lanes. Choosing another note makes it the
    core, and the galaxy swirls round to it; a drag tips the disc, which settles
    back to its slant. *Secret:* drag once right round the core, and it goes
    supernova.
  - **Brain**: the notes are neurons in the lobe their type belongs to, linked
    by curving axons, inside the faint outline of a brain. It sways from side
    to side and turns heavily under a drag, without coasting. Neurons fire now
    and then; the chosen one keeps firing into the notes it links with. The
    colour button next to the look sets the outline's colour (a neon pink to
    begin with). *Secret:* press and hold on an empty spot, and a thought
    spreads from the nearest neuron through the links.
  - **Fireflies**: each note is a firefly over a meadow at dusk, wandering near
    where its links put it and blinking to its own rhythm. A drag turns the view
    and blows a breeze through them; choosing a note calls the swarm to it, the
    notes it links with circling close. *Secret:* shake the view (drag quickly
    back and forth), and they blink as one and fly into a heart.
  - **Double helix**: the notes are beads on two strands, in the order their
    links lead through them, and the links run across. It spins by itself; a
    drag across spins it and lets it coast, a drag up or down runs along it.
    Choosing a note brings it to the front and the middle, and the helix
    loosens round it. *Secret:* flick it fast enough, and it unzips and copies
    itself.

  The look and the brain's colour are remembered in this browser too. For
  anyone who asks their system to reduce motion, the 3D looks stand still and
  keep their secrets.

The colours above the 2D graph (the filter button in 3D) are also switches: a
type switched off hides its notes in both views, and so does *orphan*. What the
search down the side finds is lit in the graph and the rest dimmed, and the 2D
graph says how many notes match. A memory of many hundreds of notes is laid out
in fewer passes, so that the page opens at once: the picture is rougher, and
still shows what is linked.

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
