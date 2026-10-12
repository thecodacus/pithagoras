# Files

The folder icon in a chat's header opens **Files**: the folder the chat works
in, beside the conversation, where the browser and the terminal open. It is the
same folder the agent reads and writes, so what it produces can be looked at,
changed or taken away without a shell on the host.

That folder is the project the chat is in, the workspace root, or Home for a chat
that started there. Nothing outside it can be reached.

## What you can do

- **Browse.** Click a folder to go in, the path at the top to go back.
  Folders come first; `.git` is not listed. A link that leads out of the folder
  is shown greyed out and cannot be opened. A file's size is on its row, in B, KB, MB or GB.
- **See the full path.** The pin button at the top shows the folder's full path
  (and the folder you are in) on a line of its own; click it again to hide it.
  The sidebar and the chat's header do not carry the path.
- **Hide or show dotfiles.** Names that start with a dot (`.env`, `.cache`, …) are
  hidden to begin with, and a line under the list says how many. The eye icon at
  the top turns them on and off, and the choice is remembered in the browser.
  What the agent opens is shown either way.
- **Read and change.** A text file opens as text. Edit it and choose **Save**
  (or press <kbd>Ctrl</kbd>/<kbd>⌘</kbd>+<kbd>S</kbd>). A PNG, JPEG, GIF or WebP picture is
  shown as a picture (up to 25 MB). Any other file that is not text, or is over
  1 MB, is not shown; download it instead.
- **Read markdown as a page.** A `.md`, `.markdown` or `.mdx` file opens as the
  rendered page, with headings, lists, code and tables drawn. A button in its
  header swaps to the source, to edit it, and back. The page follows what you type, even
  before you save, and a picture it names from the chat's folder is shown from
  the path in the file's own folder. The choice is remembered in the browser. A new
  or empty file opens as the source anyway, so you can type into it.
- **Download** without opening: every row has a download button, for a file or,
  for a folder, as a `.tar.gz`. The button at the top downloads the folder you are
  in (without `node_modules`, `.git`, `dist`, `build` and virtual environments).
- **Make a file or a folder** with the two buttons at the top, in the folder
  you are in. A new file opens straight away, ready to write in. Neither ever
  takes the place of something already there.
- **Upload** with the arrow at the top, or by dropping files on the list: they
  go in the folder you are in. A name that is taken gets a number —
  `notes (2).md` — rather than replacing anything, and a file is only put in
  place once all of it has arrived, so an upload cut short leaves nothing
  behind. Up to 2 GB a file. Files dropped on the message box go to the chat's
  folder as well — see [Pictures and files](/guide/sessions#pictures-and-files).
- **Rename** a file or a folder with the pencil on its row. Enter keeps the new
  name, Escape leaves it. It is a new name in the same folder, and never replaces
  something that is already there.
- **Delete** a file or a folder and everything in it, after a confirmation. A
  link is removed as the link; what it points at stays. For a folder the
  confirmation first finds out whether it holds git work nothing else has —
  uncommitted changes, commits no remote has, stashes, in a repository or a
  clone inside it; a new folder in a part of the repository git tracks counts
  as one change — and if so names it and asks you to **Delete anyway**, even
  when Settings says not to ask before deleting; the server refuses without it.
  It looks and stops where [deleting a project](/guide/projects#the-projects-tab)
  does. A file goes as it is. `node_modules`, `.venv`, `venv`, `__pycache__`,
  `.tox`, `.mypy_cache` and `.cache` are not looked through, but one that is a
  repository itself, or has changes a repository around it tracks, is asked
  about.

A save is made whole: the text is written beside the file and put in place, so a
save that fails (a full disk, say) leaves the file as it was. The reason is shown
above the editor; your text and the **Save** button stay, to copy or to try again.

An edit that is not saved is kept for its chat. Switch to another chat, leave the
page or reload it, and when Files is open again the file is as you left it, still
marked as not saved. Only **Discard** gives it up. If the file changed in the
meantime, you get the same choice as at a save.

The agent writes here too, so a save is checked. If the file changed after you
opened it, the save is refused and you choose between loading the new version
and saving yours anyway.

## Watching the agent

Files follows the agent. When it reads a file, or writes or edits one, that file
is shown — the editor, live, as it changes. Opening a file or a folder yourself
takes over from that, and **Follow** hands it back; clicking **Following** again
stops following. Editing is never interrupted:
while you have unsaved changes, the agent's next file does not replace them.

In [voice mode](/guide/voice) it opens on its own the first time the agent touches
a file, in the same way as the browser and the terminal, and there is a folder
button in the top right to open it yourself. That window is its own: it follows
the agent from the start, and an edit that is not saved in the chat's Files stays
with the chat until voice mode is over.

## Panels

At most two panels are open beside the conversation. Opening a third closes the
one that has been open longest — unless Files has an edit that is not saved, in
which case another one is closed instead. Closing Files yourself, or reloading the
page, asks first while there is an edit. The browser, the terminal, Files and
[canvases](/guide/canvases) all count.

Each panel is moved by its header. Let go at the left, the right or the bottom
edge of the chat, it docks there; let go anywhere else, it floats in a window of
its own that you can move and size. Every panel remembers where you put it, so
the terminal can sit at the left while Files is at the right. Two panels docked
in the same place share it: one above the other at a side, side by side at the
bottom. At the bottom they sit under the conversation, between the panels at the
sides. Each place keeps the size you gave it, whichever panels are in it. When
panels at both sides would leave the conversation narrower than 320px, the side
you sized last keeps its width and the other gives way first; it gets its width
back as soon as there is room again. A panel you have never moved goes where
all of them went before. A panel carried to another place flies there from where
you let go of it, unless [the animations](/guide/interface#animations) are off.

Sizing needs no pointer: the edge between the conversation and the panels, the
edge between two panels and a floating window's corner are reached with `Tab`.
An arrow key moves the edge that way by a step (`Shift` makes it four), and
`Home` gives it its first size back; a window's corner takes `Enter` for that
too. A list of tabs, such as the terminal's, is one stop for `Tab`; the arrow
keys, `Home` and `End` go through it.
