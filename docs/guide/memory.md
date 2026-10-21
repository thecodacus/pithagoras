# Memory and audit

Two pages in the sidebar for looking at what the agent knows and what it was
allowed to do.

## Memory

**Memory** appears in the sidebar's **Extensions** group while
[Understory](/guide/features#memory-understory) (the `pithagoras-understory`
extension) is the agent's memory. It is the web view of the agent's memory: a
bundle of markdown notes, kept in folders and linked to each other.

**Notes.** Down the side, the folders and notes with their types, and a search
(*Search the memory*). Above them, the count of notes and folders and whether the
bundle is *conformant* to Understory's format; when it is not, the issues are
listed. Choose a note to read it: its type, tags, when it last changed, its text,
and links that open other notes here.

**Log.** What changed in the memory, newest first.

**Graph.** The notes and their links, in space. Every note is a glowing point in
the colour of its type, and a link is a thin, see-through line. Nothing is
written on it: a note's name shows in a small card, with its type, link count
and description, only while you point at it or reach it with Tab, and the note
lights up with the notes it links with while the rest steps back. Click a note
to open it; the note you opened last stays lit and ringed when you come back to
the graph, until you click the empty background. On a touch screen, where there
is no pointing, the first tap on a note shows its card and lights it, and a
second tap on it opens it; a tap on the empty background lets go. Scroll or
pinch to zoom, and the target button sets the view back. A note nothing links to
is not marked in the graph: its card says "orphan (unlinked)", and the filter's
*orphan* switch hides it. The graph comes in five looks, chosen in
the toolbar. Each places the notes in its own way, moves in its own way, and
hides a secret:

- **Constellation**: the notes are stars where their links pull them, the links
  the lines of the constellations, and the sky turns slowly. A drag flings it
  and it coasts; choosing a note flies to its star. *Secret:* double-click the
  empty sky for a meteor shower.
- **Galaxy**: a spiral galaxy seen at a slant, its bright core the chosen note
  (until you choose one, the most linked note). Every other note is a star out
  along an arm as far as it is links away, on the arm of its type, in clusters
  with the notes as far out as it; notes no link reaches are scattered through
  the halo. The disc turns slowly round the core, its arms glowing and crossed
  by dark dust lanes. Choosing another note makes it the core, and the galaxy
  swirls round to it; a drag tips the disc, which settles back to its slant.
  *Secret:* drag once right round the core, and it goes supernova.
- **Brain**: the notes are neurons in the lobe their type belongs to, linked by
  curving axons, inside the faint outline of a brain. It sways from side to side
  and turns heavily under a drag, without coasting. Neurons fire now and then;
  the chosen one keeps firing into the notes it links with. The colour button
  next to the look sets the outline's colour: a swatch, or any hex code (a neon
  pink to begin with). *Secret:* press and hold on an empty spot, and a thought
  spreads from the nearest neuron through the links.
- **Fireflies**: each note is a firefly over a meadow at dusk, wandering near
  where its links put it and blinking to its own rhythm. A drag turns the view
  and blows a breeze through them; choosing a note calls the swarm to it, the
  notes it links with circling close. *Secret:* shake the view (drag quickly
  back and forth), and they blink as one and fly into a heart.
- **Double helix**: the notes are beads on two strands, in the order their links
  lead through them, and the links run across. It spins by itself; a drag across
  spins it and lets it coast, a drag up or down runs along it. Choosing a note
  brings it to the front and the middle, and the helix loosens round it.
  *Secret:* flick it fast enough, and it unzips and copies itself.

The look and the brain's colour are remembered in this browser. For anyone who
asks their system to reduce motion, the looks stand still and play no secrets.

**Query paths.** The button in the graph's toolbar (while Understory has runs on
record) lists the latest runs of Understory's own agent, one line each: what it
was asked or told, how many tokens it took, and a dot that is warm when the run
changed the memory (a step wrote, patched or deleted a note, whoever asked: a
change, or the librarian) and in the accent colour when it only read. The list
is short because the runs are shut. The arrow at the end of a line (Tab reaches
it; Enter or Space presses it) opens a run and shuts it again, and only it does:
pointing at a run, or keeping it lit, does not open it. A run you opened stays
open, with the list shut and opened again, and one you shut stays shut. Open, it
shows the path the run went, step by step, in the words Understory keeps for it
(`search "owner" (2) → read owner.md → ✓`; how it ended is the last step: a
tick, *partial* or a cross). A step that read, wrote,
patched or deleted a note gets a glowing mark in the colour of that note's type;
a search says how many notes it found and lights none, and a step that went by a
file name another note shares still lights the right note, because the portal
asks Understory for the full path of every step. Point at a run (open or shut,
with the mouse or Tab) and the notes it touched light up in the graph, with the
links between them, while the rest steps back; click it to keep it lit after you
shut the list, and click it again to let it go. A run that touched no note says
so, and one whose notes are not in the graph (they were deleted since) says that;
neither lights anything. Such a run has a hollow dot and says why in the tooltip
of its line, shut or open, and under its steps when it is open. The list is at
most half the window tall, which fits ten shut runs in a window about 720 pixels
tall or more (fewer in a shorter one), and has a scroll bar of its own when
there are more or some are open, also on a phone.

The filter button in the graph's toolbar holds the colours as switches: a type
switched off hides its notes, and so does *orphan*. What the search down the
side finds is lit in the graph and the rest dimmed. A memory of many hundreds of
notes is laid out in fewer passes, so that the page opens at once: the picture
is rougher, and still shows what is linked.

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

What is open is in the address (`/x/pithagoras-understory/memory?note=…`,
`?view=log`, `?view=graph`, `?view=chat`), so it can be linked to.

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
nightly pass — is on its page in **Settings → Extension settings → Memory**,
described in [Opt-in features](/guide/features#memory-understory).

## Audit

**Audit** is in the sidebar too: the guard's record of what it refused, let
through or turned away, with filters. It is described under
[Sessions → Audit](/guide/sessions#audit).
