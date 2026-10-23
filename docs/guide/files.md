# Files

The folder icon in a chat's header opens **Files**: the folder the chat works
in, beside the conversation, where the browser and the terminal open. It is the
same folder the agent reads and writes, so what it produces can be looked at,
changed or taken away without a shell on the host.

That folder is the project the chat is in, the workspace root, or Home for a chat
that started there. Nothing outside it can be reached.

Files is an extension, `pithagoras-files` from the portal's `extensions/files`,
installed when a portal starts for the first time and listed under Settings →
Extensions → Installed like any other. Switch it off or remove it and the
button, the panel and its window in voice mode go; the folder stays the
agent's. What Files reads and changes, its server half does with the portal's
own checks on a chat's folder (`portal.files`), which every extension has: see
[A chat's folder](/guide/extension-ui#a-chat-s-folder) for what they guard
against. Uploads and pictures are the portal's own routes, which its message
box and its conversation use as well.

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

What you make here belongs to the folder it is made in. A new file, an upload
and a new folder get the folder's owner and group, and are writable by that group
where the folder is, so that the agent, which with the [sandbox](/guide/sandbox)
on is another user, can go on editing what you made. A file you save over keeps
the owner, group and permissions it had. Where the portal is not allowed to give
a file away (it is not root and the folder is someone else's), the file stays the
portal's and is group-writable only if its group is the folder's. On a system
without `/proc` (macOS) the portal gives nothing away at all.

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

**Refresh** reads the folder again and, when a file is open, that file too. A
file without unsaved changes shows its new text in place, as the page or the
source it was shown as. With unsaved changes, your text stays; if the file
changed, you get the same choice as at a save. The only change Files notices by
itself is one the agent makes with its write and edit tools. A change made any
other way — by the agent's shell commands, a terminal, another chat or another
device — shows with **Refresh**.

The Markdown files in a folder called `documents` are also the project's
[Documents](/guide/documents), with a history of their own. A change made here
is kept there as a revision, marked as an outside change, and a page that has
the document open is told of it; deleting or renaming such a file is dealt with
as [Documents](/guide/documents#a-file-that-is-deleted-or-renamed) describes.

## Watching the agent

Files follows the agent. When it reads a file, or writes or edits one, that file
is shown — the editor, live, as it changes. Opening a file or a folder yourself
takes over from that, and **Follow** hands it back; clicking **Following** again
stops following. Editing is never interrupted:
while you have unsaved changes, the agent's next file does not replace them.
When the agent writes or edits the file that is open, its new text shows there,
following or not; with unsaved changes you get the same choice as at a save
instead.

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
When a panel docks at a side, or goes from one, the conversation slides over to
stay in the middle of the room it has, rather than jumping; an edge being
dragged moves it as it goes. With reduced motion asked for by the system it is
where it goes at once.

Sizing needs no pointer: the edge between the conversation and the panels, the
edge between two panels and a floating window's corner are reached with `Tab`.
An arrow key moves the edge that way by a step (`Shift` makes it four), and
`Home` gives it its first size back; a window's corner takes `Enter` for that
too. A list of tabs, such as the terminal's, is one stop for `Tab`; the arrow
keys, `Home` and `End` go through it.

## Its routes

Files' server half answers at `/api/x/pithagoras-files/chats/:id/…`, behind the
portal's login. Every path is relative to the chat's folder; one that leads out
of it, by `..` or by a link, is refused with 400. A refusal is `{ error, code }`,
with `code` one of `invalid`, `missing`, `conflict`, `exists`, `too_large`,
`failed` and `unsaved-work`.

| | |
| --- | --- |
| `GET …/files?path=` | `{ path, entries: [{ name, type, link?, size, mtime }], truncated }`: `type` is `dir`, `file` or `link` (a link that leads out of the folder or nowhere); `link: true` marks every link, including one to a folder inside that is listed as a `dir`. Folders first; `.git` is left out; at most 2,000 entries |
| `GET …/file?path=` | `{ binary: false, size, mtime, content }`, or `{ binary: true, size, mtime }` for what is not text or is over 1 MB |
| `GET …/file?path=&download=1` | The file, as a download |
| `PUT …/file?path=` | `{ content, mtime? }` saves it. With `mtime`, the time it was read at, a file changed since is refused with 409 and `code: "conflict"`. 413 over 1 MB. With `create: true` it makes the file, and refuses with 409 if something already has the name |
| `POST …/folder?path=` | `{ name }` makes a folder in the folder at `path`, and answers `{ path }`. 409 if the name is taken |
| `PATCH …/file?path=` | `{ name }` gives a file or folder another name in the same folder, and answers `{ path }`. 400 for a name with a `/` or `\`, or `.` or `..`; 409 if the name is taken. A link is renamed as the link |
| `DELETE …/file?path=` | Removes a file, or a folder and all in it; a link as the link. The folder itself is refused. A folder holding git work that exists nowhere else is refused with 409 and `code: "unsaved-work"` unless `discard=1` |
| `GET …/unsaved?path=` | `{ unsaved }`: what deleting `path` would lose that nothing else has, `{ changed, unpushed, stashes, unknown? }`, or `null` for nothing |
| `GET …/archive?path=` | The folder, or with `path` a folder in it, as a `.tar.gz`, without `node_modules`, `.git`, `dist`, `build` and virtual environments. If `tar` cannot run the answer is a 500; if it fails part-way the download is cut off, so it does not end as if it were whole |

Uploading is the portal's `POST /api/sessions/:id/upload`, and a picture its
`GET /api/sessions/:id/picture` (see the [API](/reference/api#files)).
